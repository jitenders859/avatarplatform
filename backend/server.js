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
 *   /api/admin/*              admin panel (separate auth, see routes/admin.js)
 *   /embed/:publicId/*        public embed config + RAG retrieval
 *   /                         static frontend
 */
require('dotenv').config();

const fs = require('fs');
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
const { serve: serveInngest } = require('inngest/express');
const pinoHttp = require('pino-http');
const logger = require('./logger');
const { AppError } = require('./errors');
const { pool } = require('./db');
const { getRateLimitStore, embedKeyGenerator } = require('./services/rateLimitStore');

const authRoutes = require('./routes/auth');
const { router: projectsRoutes } = require('./routes/projects');
const filesRoutes = require('./routes/files');
const embedRoutes = require('./routes/embed');
const { router: billingRoutes, webhookHandler: stripeWebhook } = require('./routes/billing');
const analyticsRoutes = require('./routes/analytics');
const contactRoutes = require('./routes/contact');
const captureFieldsRoutes = require('./routes/captureFields');
const quizQuestionsRoutes = require('./routes/quizQuestions');
const flashcardsRoutes = require('./routes/flashcards');
const videoResourcesRoutes = require('./routes/videoResources');
const adminRoutes = require('./routes/admin');
const adminCharactersRoutes = require('./routes/adminCharacters');
const adminCouponsRoutes = require('./routes/adminCoupons');
const adminSettingsRoutes = require('./routes/adminSettings');
const adminWebhooksRoutes = require('./routes/adminWebhooks');
const adminAnalyticsRoutes = require('./routes/adminAnalytics');
const adminUsageRoutes = require('./routes/adminUsage');
const adminHealthRoutes = require('./routes/adminHealth');
const adminSessionsRoutes = require('./routes/adminSessions');
const adminFeatureFlagsRoutes = require('./routes/adminFeatureFlags');
const adminEmailTemplatesRoutes = require('./routes/adminEmailTemplates');
const inngestClient = require('./inngest/client');
const { functions: inngestFunctions } = require('./inngest/functions');
const { checkProcessModeConfigured } = require('./services/processMode');

// Runs on every boot, Vercel included (unlike the app.listen() block below,
// which is skipped there) — this is precisely the deployment target where
// an unconfigured Inngest default silently strands file uploads.
checkProcessModeConfigured(logger);

const app = express();
const PORT = process.env.PORT || 8080;

// ── Rate limiters ─────────────────────────────────────────────
// All limiters share a Redis-backed store when one is configured
// (UPSTASH_REDIS_REST_URL/+TOKEN or REDIS_URL — see services/rateLimitStore.js)
// so limits survive Vercel's per-invocation process state and apply across
// horizontally-scaled instances. Without a store they silently fall back to
// per-process MemoryStore and rateLimitStore logs a loud boot warning.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  skipSuccessfulRequests: true, // only count failures — no penalty for legitimate logins
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
  store: getRateLimitStore('auth'),
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
  store: getRateLimitStore('api'),
});

// Keyed by IP+publicId rather than IP alone: an IP-only key meant one
// legitimate visitor behind office NAT ate the 30/min budget of every other
// embed served to that IP, while abusers needed to rotate nothing.
const embedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: embedKeyGenerator,
  message: { error: 'Too many requests, slow down' },
  store: getRateLimitStore('embed'),
});

// Separate from authLimiter: even with a shared store each limiter gets its
// own key prefix (see rateLimitStore.getRateLimitStore), so sharing
// authLimiter here would let customer login failures from an IP eat into the
// admin login budget for that same IP (and vice versa), and would prevent
// admin login from ever being stricter than customer login even though a
// compromised admin credential is far higher blast-radius.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
  store: getRateLimitStore('admin'),
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

// Publishable-safe config for the frontend: uploads go straight from the
// browser to Supabase Storage (see routes/files.js's init/complete flow),
// which needs the Supabase project URL + anon key client-side. Neither
// value grants write access on its own — the actual upload authorization is
// the per-file signed URL token issued by POST .../files/init. Static HTML
// has no build-time env injection, so the frontend fetches this at runtime.
app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_PUBLISHABLE_KEY || null,
  });
});

// Inngest webhook — durable background jobs (file processing) call back
// into this route per step. Mounted on the same Express app/Vercel function
// rather than a separate one; simplest given there's no benefit here to
// splitting it out.
app.use('/api/inngest', serveInngest({ client: inngestClient, functions: inngestFunctions }));

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
app.use('/api/contact', apiLimiter, contactRoutes);
app.use('/api/admin/login', adminLoginLimiter);
app.use('/api/admin', apiLimiter, adminRoutes);
app.use('/api/admin/characters', apiLimiter, adminCharactersRoutes);
app.use('/api/admin/coupons', apiLimiter, adminCouponsRoutes);
app.use('/api/admin/settings', apiLimiter, adminSettingsRoutes);
app.use('/api/admin/webhooks', apiLimiter, adminWebhooksRoutes);
app.use('/api/admin/analytics', apiLimiter, adminAnalyticsRoutes);
app.use('/api/admin/usage', apiLimiter, adminUsageRoutes);
app.use('/api/admin/health', apiLimiter, adminHealthRoutes);
app.use('/api/admin/sessions', apiLimiter, adminSessionsRoutes);
app.use('/api/admin/feature-flags', apiLimiter, adminFeatureFlagsRoutes);
app.use('/api/admin/email-templates', apiLimiter, adminEmailTemplatesRoutes);
app.use('/embed', embedLimiter, embedRoutes);

// ── Static frontend ───────────────────────────────────────────
// No hashed/versioned filenames exist for these assets, so we deliberately
// avoid `immutable` — a 1-year immutable cache would mean visitors (including
// third-party sites embedding lipsync-sdk.js) keep serving a stale copy after
// every deploy with no way to force a refresh. A short maxAge still avoids
// re-fetching on every page load, and the browser cheaply revalidates via
// ETag/304 once it expires, so fixes propagate within the hour.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// lipsync-sdk.min.js is gitignored and only exists once `npm run build`
// (postinstall) has run terser successfully — a fresh clone/deploy where
// that silently failed would otherwise 404 for every customer widget with
// no signal anywhere. embed.html falls back to the unminified source on a
// load error, but that's a browser-side patch for something that should
// never have shipped broken — this boot check is the operator-facing signal.
if (!fs.existsSync(path.join(PUBLIC_DIR, 'lipsync-sdk.min.js'))) {
  logger.warn('public/lipsync-sdk.min.js is missing — did `npm run build` (terser) fail? embed.html will fall back to the unminified lipsync-sdk.js, but this should be fixed before deploying.');
}

app.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

const PAGES = ['login', 'signup', 'dashboard', 'project', 'embed', 'billing', 'analytics', 'pricing', 'characters', 'account', 'forgot-password', 'reset-password', 'verify-email', 'terms', 'contact', 'admin'];
for (const page of PAGES) {
  app.get(`/${page}`, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, `${page}.html`)));
}

// ── Docs ──────────────────────────────────────────────────────
app.get('/docs', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'docs', 'index.html')));
const DOCS_PAGES = ['js-sdk', 'react-sdk', 'vue-sdk', 'react-native-sdk', 'elevenlabs-avatar', 'gemini-live', 'openai-realtime', 'natural-lipsync', 'prefetching', 'troubleshooting'];
for (const p of DOCS_PAGES) {
  app.get(`/docs/${p}`, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'docs', `${p}.html`)));
}

// Pretty embed URL
// helmet's frameguard (X-Frame-Options: SAMEORIGIN) is on by default and
// isn't touched by the contentSecurityPolicy/crossOriginEmbedderPolicy
// overrides above — left as-is, it makes every browser refuse to render
// this exact document inside an iframe on a customer's site, which is the
// widget's entire purpose. Must be stripped only here, not app-wide: the
// dashboard/admin pages still want clickjacking protection.
app.get('/e/:publicId', (_req, res) => {
  res.removeHeader('X-Frame-Options');
  res.sendFile(path.join(PUBLIC_DIR, 'embed.html'));
});

// ── Error handler ─────────────────────────────────────────────
// err.message is only ever returned verbatim for AppError — a deliberate,
// user-facing rejection raised by application code. Anything else reaching
// here (DB errors, Supabase errors, upstream Gemini/Stripe error text, ...)
// is logged in full server-side and replaced with a generic message, so
// internals never leak to the client. req.id (assigned by pino-http) is
// returned alongside so a report of "Internal server error" can be matched
// back to the corresponding server-side log line.
app.use((err, req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large (max 100MB)' });
  }
  if (err instanceof AppError) {
    req.log.warn({ err }, 'app error');
    return res.status(err.status || 400).json({ error: err.message });
  }
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error', requestId: req.id });
});

// Vercel provides its own listener and process lifecycle around the
// exported `app` (see api/index.js) — calling app.listen() there would just
// bind a port nothing connects to, and process.exit() inside a serverless
// invocation would kill the container out from under unrelated concurrent
// invocations sharing the same warm instance. Vercel sets VERCEL=1 on every
// function invocation, so local `npm run dev`/`npm start` (VERCEL unset)
// behaves exactly as before.
if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => {
    logger.info(`AvatarPlatform running at http://localhost:${PORT}`);
    if (!process.env.GEMINI_API_KEY) {
      logger.warn('GEMINI_API_KEY not set — embeddings, multimodal extraction, and live chat will fail');
    } else {
      logger.info('GEMINI_API_KEY loaded');
    }
    // PUBLIC_GEMINI_API_KEY is shipped to every visitor's browser via
    // /embed/:id/config — it must be a separate, restricted key. When it's
    // missing we omit it from the config (never fall back to GEMINI_API_KEY,
    // which would publicly leak the server key) and widgets run text-only.
    if (!process.env.PUBLIC_GEMINI_API_KEY) {
      logger.warn('PUBLIC_GEMINI_API_KEY not set — live voice disabled; embed widgets will run in text-only mode via /ask');
    } else if (process.env.PUBLIC_GEMINI_API_KEY === process.env.GEMINI_API_KEY) {
      logger.warn('PUBLIC_GEMINI_API_KEY equals GEMINI_API_KEY — the server key would be publicly downloadable via /embed/:id/config. Create a separate, quota-restricted key.');
    } else {
      logger.info('PUBLIC_GEMINI_API_KEY loaded');
    }
    if (!process.env.STRIPE_SECRET_KEY) {
      logger.warn('STRIPE_SECRET_KEY not set — billing endpoints will return 503');
    } else {
      logger.info('Stripe configured');
    }
  });

  function shutdown(signal) {
    logger.info({ signal }, 'shutdown received');
    server.close(() => {
      logger.info('server closed');
      pool.end().catch((err) => logger.warn({ err }, 'error closing pg pool')).finally(() => process.exit(0));
    });
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
}

module.exports = { app };
