/**
 * Admin-configurable runtime settings — model API keys/names that used to
 * be .env-only. A row in admin_settings overrides the env var of the same
 * key; deleting the row reverts to process.env, no redeploy either way.
 *
 * Cached in-process: PUBLIC_API_KEY (embed.js) and GEMINI_API_KEY are read
 * on every embed-widget request, so a DB round-trip per read would be
 * wasteful for a value that only changes via a rare admin action.
 */
const db = require('../db');
const logger = require('../logger').child({ module: 'services/settings' });

// Everything else (EMBEDDING_MODEL, JWT_SECRET, Stripe keys, ...) stays
// .env-only: EMBEDDING_MODEL changing the vector space mid-flight would
// silently corrupt existing RAG search (see .env.example), and secrets
// like JWT_SECRET/Stripe keys are boot-time wiring, not "which model" —
// out of scope for a model-settings panel.
const OVERRIDABLE_KEYS = ['GEMINI_API_KEY', 'PUBLIC_GEMINI_API_KEY', 'STUDY_MODEL'];

const CACHE_TTL_MS = 15_000;
let cache = null;
let cachedAt = 0;

// embedOne/embedBatch (the hottest callers — every RAG query and every
// ingested chunk) read a setting on their critical path. A DB blip here
// must not take down embeddings/chat, so a failed lookup falls back to
// env-only (short-cached, so a real outage doesn't retry-storm the pool)
// rather than throwing.
async function loadAll() {
  // No DB configured at all (test runs, or a deploy that hasn't set
  // DATABASE_URL yet) — don't even attempt pool.connect(); pg would hang
  // for the full connectionTimeoutMillis on every embedding/chat call that
  // reads a setting, since a failed attempt isn't cached and the next
  // query just retries it. Straight to env-only, no DB round-trip.
  if (!process.env.DATABASE_URL) {
    cache = {};
    cachedAt = Date.now();
    return cache;
  }
  try {
    const rows = await db.findAll('admin_settings', {});
    const map = {};
    for (const row of rows) map[row.key] = row.value;
    cache = map;
    cachedAt = Date.now();
    return map;
  } catch (e) {
    logger.warn({ err: e.message }, 'admin_settings lookup failed — falling back to env vars');
    cache = {};
    cachedAt = Date.now();
    return cache;
  }
}

async function currentMap() {
  if (!cache || Date.now() - cachedAt > CACHE_TTL_MS) return loadAll();
  return cache;
}

async function getSetting(key) {
  const map = await currentMap();
  return map[key] || process.env[key] || '';
}

async function setSetting(key, value, adminId) {
  if (!OVERRIDABLE_KEYS.includes(key)) throw new Error('Unknown setting key');
  if (value) {
    await db.query(
      `INSERT INTO admin_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3, updated_by = $4`,
      [key, value, Date.now(), adminId]
    );
  } else {
    await db.remove('admin_settings', { key }).catch(() => {});
  }
  cache = null;
}

function maskValue(v) {
  if (!v) return null;
  if (v.length <= 8) return '••••••••';
  return v.slice(0, 4) + '••••' + v.slice(-4);
}

// Status for the admin UI: which of the 3 keys are set, from where (an
// explicit admin override vs. the .env fallback), and a masked preview —
// never the raw value, this is rendered straight into the page.
async function listSettingsStatus() {
  const map = await currentMap();
  return OVERRIDABLE_KEYS.map(key => {
    const dbValue = map[key];
    const envValue = process.env[key] || '';
    const effective = dbValue || envValue;
    return {
      key,
      source: dbValue ? 'admin' : (envValue ? 'env' : 'unset'),
      masked: maskValue(effective),
    };
  });
}

module.exports = { getSetting, setSetting, listSettingsStatus, OVERRIDABLE_KEYS };
