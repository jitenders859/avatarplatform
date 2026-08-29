/**
 * Feature-flag infrastructure — admin-defined boolean flags stored in
 * feature_flags, read with a short-TTL in-process cache. Mirrors
 * services/settings.js's structure (same cache/TTL approach), but flags
 * are admin-created ad hoc rather than a fixed OVERRIDABLE_KEYS list, so
 * this module also exposes a create path.
 *
 * Infra only (admin-panel plan 5e) — nothing in the codebase calls
 * isEnabled() yet. An empty flag list is correct and expected.
 */
const db = require('../db');
const logger = require('../logger').child({ module: 'services/featureFlags' });

const CACHE_TTL_MS = 15_000;
let cache = null;
let cachedAt = 0;

// Same reasoning as settings.js loadAll: don't attempt pool.connect() when
// there's no DB configured (test runs, pre-DATABASE_URL deploys) — a failed
// attempt isn't cached, so every isEnabled() call would otherwise retry a
// full connection timeout. Flags default to disabled when unreachable.
async function loadAll() {
  if (!process.env.DATABASE_URL) {
    cache = {};
    cachedAt = Date.now();
    return cache;
  }
  try {
    const rows = await db.findAll('feature_flags', {});
    const map = {};
    for (const row of rows) map[row.key] = row;
    cache = map;
    cachedAt = Date.now();
    return map;
  } catch (e) {
    logger.warn({ err: e.message }, 'feature_flags lookup failed — flags default to disabled');
    cache = {};
    cachedAt = Date.now();
    return cache;
  }
}

async function currentMap() {
  if (!cache || Date.now() - cachedAt > CACHE_TTL_MS) return loadAll();
  return cache;
}

async function isEnabled(key) {
  const map = await currentMap();
  return !!map[key]?.enabled;
}

async function createFlag(key, description, adminId) {
  const existing = await db.findOne('feature_flags', { key });
  if (existing) throw new Error('Flag already exists');
  await db.insert('feature_flags', {
    key,
    enabled: false,
    description: description || null,
    updatedAt: Date.now(),
    updatedBy: adminId,
  });
  cache = null;
}

// db.update() assumes an "id" primary key column, which feature_flags
// doesn't have (its PK is "key", same as admin_settings) — so this uses a
// raw query directly, same as settings.js's setSetting.
async function setFlag(key, enabled, description, adminId) {
  const existing = await db.findOne('feature_flags', { key });
  if (!existing) throw new Error('Unknown flag key');
  const nextDescription = description !== undefined ? description : existing.description;
  await db.query(
    `UPDATE feature_flags SET enabled = $2, description = $3, updated_at = $4, updated_by = $5
     WHERE key = $1`,
    [key, !!enabled, nextDescription, Date.now(), adminId]
  );
  cache = null;
}

async function listFlags() {
  const map = await currentMap();
  return Object.values(map).sort((a, b) => a.key.localeCompare(b.key));
}

module.exports = { isEnabled, setFlag, createFlag, listFlags };
