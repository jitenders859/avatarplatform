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
// Patches Express to forward rejected promises from async route handlers to
// the error middleware below. Without this (Express 4 doesn't do it natively),
// any rejected DB/API call in a route becomes an unhandled rejection, which
// crashes the whole process on Node >=15's default unhandledRejection mode.
require('express-async-errors');
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
const quizQuestionsRoutes = require('./routes/quizQuestions');
const flashcardsRoutes = require('./routes/flashcards');
const videoResourcesRoutes = require('./routes/videoResources');

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
app.use('/api/projects', apiLimiter, quizQuestionsRoutes);
app.use('/api/projects', apiLimiter, flashcardsRoutes);
app.use('/api/projects', apiLimiter, videoResourcesRoutes);
app.use('/api', apiLimiter, filesRoutes); // files routes are project-nested
app.use('/api/billing', apiLimiter, billingRoutes);
app.use('/api/analytics', apiLimiter, analyticsRoutes);
app.use('/embed', embedLimiter, embedRoutes);

// ── Static frontend ───────────────────────────────────────────
// No hashed/versioned filenames exist for these assets, so we deliberately
// avoid `immutable` — a 1-year immutable cache would mean visitors (including
// third-party sites embedding lipsync-sdk.js) keep serving a stale copy after
// every deploy with no way to force a refresh. A short maxAge still avoids
// re-fetching on every page load, and the browser cheaply revalidates via
// ETag/304 once it expires, so fixes propagate within the hour.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

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

// Previously trusted a client-supplied userId directly (`socket.on('join',
// userId => socket.join('user:' + userId))`), letting any connected client
// join ANY user's room and receive their private file-processing events.
// The room is now derived from a verified JWT (see socketAuth.js) instead
// of a value the client can simply choose.
const { resolveUserRoom } = require('./socketAuth');
io.on('connection', socket => {
  socket.on('join', token => {
    const room = resolveUserRoom(token);
    if (room) socket.join(room);
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

// Last-resort nets for errors outside the request/response cycle (e.g. the
// fire-and-forget setImmediate(() => sendWelcome(...)) in routes/auth.js) —
// express-async-errors only covers rejections thrown inside route handlers.
// Logged and swallowed rather than crashing, so one bad background call
// (or a transient DB blip) doesn't take down every tenant's chatbot.
process.on('unhandledRejection', err => {
  logger.error({ err }, 'unhandled rejection');
});
// An uncaught exception means something threw outside any promise/async
// context — state may be inconsistent, so exit and let the process manager
// restart rather than keep serving from a possibly-corrupted process.
process.on('uncaughtException', err => {
  logger.error({ err }, 'uncaught exception — exiting');
  process.exit(1);
});

module.exports = { app, server };
