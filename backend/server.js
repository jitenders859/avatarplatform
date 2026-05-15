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
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const { router: projectsRoutes } = require('./routes/projects');
const filesRoutes = require('./routes/files');
const embedRoutes = require('./routes/embed');
const { router: billingRoutes, webhookHandler: stripeWebhook } = require('./routes/billing');
const analyticsRoutes = require('./routes/analytics');
const captureFieldsRoutes = require('./routes/captureFields');

const app = express();
const PORT = process.env.PORT || 8080;

// ── Health check (before all middleware + logging) ────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Middleware ────────────────────────────────────────────────
app.use(cors()); // open CORS — required for embed pages on third-party domains

// IMPORTANT: Stripe webhook needs the raw body for signature verification,
// so it must be mounted BEFORE express.json(). Everything else gets parsed
// JSON normally.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', 1);

// Lightweight access log
app.use((req, _res, next) => {
  if (!req.url.startsWith('/assets') && !req.url.startsWith('/js/') && !req.url.startsWith('/css/')) {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  }
  next();
});

// ── API routes ────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/projects', captureFieldsRoutes);
app.use('/api', filesRoutes); // files routes are project-nested
app.use('/api/billing', billingRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/embed', embedRoutes);

// ── Static frontend ───────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

const PAGES = ['login', 'signup', 'dashboard', 'project', 'embed', 'billing', 'analytics', 'pricing', 'characters', 'account', 'forgot-password', 'reset-password'];
for (const page of PAGES) {
  app.get(`/${page}`, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, `${page}.html`)));
}

// Pretty embed URL
app.get('/e/:publicId', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'embed.html'));
});

// ── Error handler ─────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large (max 100MB)' });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`\n✅  AvatarPlatform running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.log('⚠️   GEMINI_API_KEY not set — embeddings, multimodal extraction, and live chat will all fail.');
  } else {
    console.log('🔑  GEMINI_API_KEY loaded.');
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    console.log('💳  STRIPE_SECRET_KEY not set — billing endpoints will return 503.');
  } else {
    console.log('💳  Stripe configured.');
  }
  console.log('');
});

function shutdown(signal) {
  console.log(`${signal} received — shutting down`);
  server.close(() => { console.log('Server closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
