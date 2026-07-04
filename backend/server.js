/**
 * AvatarPlatform — main HTTP entry point.
 *
 * Run:  GEMINI_API_KEY=your_key node backend/server.js
 * Open: http://localhost:8080
 *
 * Layout:
 *   /api/auth/*               auth
 *   /api/projects/*           project CRUD + character list
 *   /api/projects/:id/files   file uploads
 *   /api/projects/:id/sources/url   URL ingestion
 *   /api/billing/*            plans, checkout, portal, webhook
 *   /api/analytics/*          usage charts
 *   /embed/:publicId/*        public embed config + RAG retrieval
 *   /                         static frontend
 */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');
const { Server: SocketServer } = require('socket.io');
const pinoHttp = require('pino-http');
const logger = require('./logger');

const authRoutes = require('./routes/auth');
const { router: projectsRoutes } = require('./routes/projects');
const filesRoutes = require('./routes/files');
const embedRoutes = require('./routes/embed');
const { router: billingRoutes, webhookHandler: stripeWebhook } = require('./routes/billing');
const analyticsRoutes = require('./routes/analytics');
const captureFieldsRoutes = require('./routes/captureFields');

const app = express();
const PORT = process.env.PORT || 8080;

// ── Rate limiters ─────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  skipSuccessfulRequests: true, // only count failures — no penalty for legitimate logins
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
});

const embedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
});

// ── Health check (before all middleware + logging) ────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Middleware ────────────────────────────────────────────────
// CSP and COEP are disabled because the embed widget runs inside iframes on
// arbitrary third-party domains — enabling them would break all embeds.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(cors()); // open CORS — required for embed pages on third-party domains

// IMPORTANT: Stripe webhook needs the raw body for signature verification,
// so it must be mounted BEFORE express.json(). Everything else gets parsed
// JSON normally.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', 1);

// Structured HTTP access log — skip static assets to keep logs clean
app.use(pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) =>
      req.url.startsWith('/assets') ||
      req.url.startsWith('/js/') ||
      req.url.startsWith('/css/'),
  },
  customLogLevel: (_req, res) => res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
}));

// ── API routes ────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/projects', apiLimiter, projectsRoutes);
app.use('/api/projects', apiLimiter, captureFieldsRoutes);
app.use('/api', apiLimiter, filesRoutes); // files routes are project-nested
app.use('/api/billing', apiLimiter, billingRoutes);
app.use('/api/analytics', apiLimiter, analyticsRoutes);
app.use('/embed', embedLimiter, embedRoutes);

// ── Static frontend ───────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

const PAGES = ['login', 'signup', 'dashboard', 'project', 'embed', 'billing', 'analytics', 'pricing', 'characters', 'account', 'forgot-password', 'reset-password', 'terms', 'contact'];
for (const page of PAGES) {
  app.get(`/${page}`, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, `${page}.html`)));
}

// ── Docs ──────────────────────────────────────────────────────
app.get('/docs', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'docs', 'index.html')));
const DOCS_PAGES = ['react-sdk', 'react-native-sdk', 'elevenlabs-avatar', 'gemini-live', 'openai-realtime', 'natural-lipsync', 'prefetching', 'troubleshooting'];
for (const p of DOCS_PAGES) {
  app.get(`/docs/${p}`, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'docs', `${p}.html`)));
}

// ── SDK ───────────────────────────────────────────────────────
app.get('/sdk/:file', (req, res) => {
  const allowed = ['react.js'];
  if (!allowed.includes(req.params.file)) return res.status(404).end();
  res.sendFile(path.join(PUBLIC_DIR, 'sdk', req.params.file));
});

// Pretty embed URL
app.get('/e/:publicId', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'embed.html'));
});

// ── Error handler ─────────────────────────────────────────────
app.use((err, req, res, _next) => {
  req.log.error({ err }, 'unhandled error');
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large (max 100MB)' });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const server = app.listen(PORT, () => {
  logger.info(`AvatarPlatform running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('GEMINI_API_KEY not set — embeddings, multimodal extraction, and live chat will fail');
  } else {
    logger.info('GEMINI_API_KEY loaded');
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    logger.warn('STRIPE_SECRET_KEY not set — billing endpoints will return 503');
  } else {
    logger.info('Stripe configured');
  }
});

// ── Socket.io — real-time file processing progress ────────────
const io = new SocketServer(server, {
  cors: { origin: '*' },
  // Only use websocket transport in production; polling fallback for dev proxies
  transports: ['websocket', 'polling'],
});

io.on('connection', socket => {
  socket.on('join', userId => {
    if (userId) socket.join(`user:${userId}`);
  });
});

module.exports.io = io;

function shutdown(signal) {
  logger.info({ signal }, 'shutdown received');
  server.close(() => { logger.info('server closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = { app, server };
