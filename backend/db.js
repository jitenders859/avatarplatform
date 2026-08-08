/**
 * Postgres database layer (replaces the flat-file JSON db).
 *
 * Connects via DATABASE_URL (standard Postgres connection string).
 * SSL is enabled by default with rejectUnauthorized=false for Supabase.
 * Set DATABASE_SSL=false to disable SSL (local Postgres without SSL).
 *
 * API surface is intentionally minimal and mirrors the old JSON-db exports
 * so callers need only minimal changes:
 *   findOne(table, { key: value })    → first matching row | null
 *   findAll(table, { key: value }, opts?) → array of rows
 *   insert(table, row)                → inserted row
 *   insertMany(table, rows)           → inserted rows (bulk, transactional)
 *   update(table, id, patch)          → updated row | null (auto sets updated_at)
 *   remove(table, { key: value })     → deleted count
 *   query(sql, params)                → rows (camelCase)
 *   queryOne(sql, params)             → first row | null
 */
const { Pool, types } = require('pg');
const logger = require('./logger').child({ module: 'db' });

// BIGINT (OID 20) → JS number. Postgres COUNT() and timestamps are BIGINT;
// without this they come back as strings, breaking arithmetic comparisons.
types.setTypeParser(20, val => parseInt(val, 10));

const ssl = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  // Default max is 10 — thin for a single Node process fielding embed-widget
  // traffic across every tenant's chatbot at once. Configurable since the
  // right ceiling depends on the DB plan's own pooler connection limit
  // (e.g. Supabase's pgbouncer tier limits) rather than app-side judgment.
  //
  // Sizing note (flagged during the perf audit, not changed here — this
  // depends on infra the app can't see): DATABASE_URL points at Supabase's
  // pgbouncer/Supavisor pooler (port 6543), so this Pool's `max` connections
  // are themselves multiplexed by that pooler's own connection budget, which
  // is a fixed, plan-dependent number shared across EVERY server instance
  // talking to this database — not per-instance. Running N horizontally
  // scaled instances each with max=20 opens up to 20*N connections against
  // that shared budget; for a multi-tenant SaaS expecting many concurrent
  // embed-widget visitors, `DB_POOL_MAX * (number of running instances)`
  // should be checked against the actual Supabase project's pooler pool
  // size before scaling out horizontally, not just raised blindly here.
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30_000,
  // Without this, a saturated pool makes queries hang indefinitely instead
  // of failing fast with a diagnosable error.
  connectionTimeoutMillis: 10_000,
  // Added during the perf audit: previously unset, so a slow/runaway query
  // (e.g. the analytics join-fan-out fixed alongside this) could hold one of
  // the pool's limited connections indefinitely — connectionTimeoutMillis
  // only bounds how long a *new* request waits to acquire a client, not how
  // long a client already checked out can run. A hard statement timeout
  // guarantees a stuck query gives its connection back.
  // Caveat: with Supabase's transaction-mode pgbouncer (pgbouncer=true in
  // DATABASE_URL), a physical Postgres backend can be swapped out between
  // queries on the same logical connection, so this client-level SET isn't
  // a 100%-guaranteed backstop the way it would be against a direct
  // (non-pooled) connection — pair it with a pool-level statement timeout
  // in the Supabase dashboard for a hard guarantee.
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '15000', 10),
});
pool.on('error', err => logger.error({ err: err.message }, 'pool error'));

// JS camelCase table name → Postgres snake_case table name
const TABLE_MAP = {
  captureFields: 'capture_fields',
  quizQuestions: 'quiz_questions',
  quizAttempts: 'quiz_attempts',
  flashcardReviews: 'flashcard_reviews',
  videoResources: 'video_resources',
  pageImages: 'page_images',
};
const tbl = name => TABLE_MAP[name] || name;

const camelToSnake = s => s.replace(/[A-Z]/g, l => '_' + l.toLowerCase());
const snakeToCamel = s => s.replace(/_([a-z])/g, (_, l) => l.toUpperCase());

function toCamel(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[snakeToCamel(k)] = v;
  return out;
}

// Columns that are genuine Postgres native array types (e.g. TEXT[]), not
// JSONB. These need pg's own default array-literal serialization ("{a,b}"),
// so ser() must NOT JSON.stringify them the way it does for JSONB arrays —
// keyed by snake_case column name.
const NATIVE_ARRAY_COLUMNS = new Set(['topic_tags']);

// Arrays of numbers → pgvector literal string "[x,y,z]".
// Native Postgres array columns (see NATIVE_ARRAY_COLUMNS) → pass through;
// pg's driver already serializes JS arrays as Postgres array literals.
// Everything else → JSON string, since that same pg array-literal
// serialization is NOT valid JSON, and JSONB array columns need actual
// JSON syntax. Plain objects pass through — pg already JSON.stringifies those.
function ser(v, key) {
  if (Array.isArray(v)) {
    if (v.length > 0 && typeof v[0] === 'number') return '[' + v.join(',') + ']';
    if (key && NATIVE_ARRAY_COLUMNS.has(key)) return v;
    return JSON.stringify(v);
  }
  return v;
}

function buildFilter(filter, startAt = 1) {
  const sf = {};
  for (const [k, v] of Object.entries(filter)) sf[camelToSnake(k)] = v;
  const keys = Object.keys(sf);
  if (!keys.length) return { clause: '', values: [] };
  const clause = 'WHERE ' + keys.map((k, i) => `"${k}" = $${startAt + i}`).join(' AND ');
  return { clause, values: Object.values(sf) };
}

async function query(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows.map(toCamel);
}

async function queryOne(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows.length ? toCamel(r.rows[0]) : null;
}

async function findOne(table, filter) {
  const { clause, values } = buildFilter(filter);
  return queryOne(`SELECT * FROM "${tbl(table)}" ${clause} LIMIT 1`, values);
}

async function findAll(table, filter = {}, opts = {}) {
  const { clause, values } = buildFilter(filter);
  let sql = `SELECT * FROM "${tbl(table)}" ${clause}`;
  if (opts.orderBy) {
    const col = camelToSnake(opts.orderBy);
    const dir = (opts.order || 'asc').toUpperCase();
    sql += ` ORDER BY "${col}" ${dir}`;
  }
  if (opts.limit) sql += ` LIMIT ${parseInt(opts.limit)}`;
  const r = await pool.query(sql, values);
  return r.rows.map(toCamel);
}

async function insert(table, row) {
  const sr = {};
  for (const [k, v] of Object.entries(row)) {
    const sk = camelToSnake(k);
    sr[sk] = ser(v, sk);
  }
  const keys = Object.keys(sr);
  const vals = Object.values(sr);
  const cols = keys.map(k => `"${k}"`).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const r = await pool.query(
    `INSERT INTO "${tbl(table)}" (${cols}) VALUES (${placeholders}) RETURNING *`,
    vals
  );
  return toCamel(r.rows[0]);
}

async function insertMany(table, rows) {
  if (!rows || !rows.length) return [];
  const t = tbl(table);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    // Batch in groups of 100 to stay well within the 65535 parameter limit
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      const keys = Object.keys(batch[0]).map(camelToSnake);
      const cols = keys.map(k => `"${k}"`).join(', ');
      let idx = 1;
      const valueSets = [];
      const params = [];
      for (const row of batch) {
        const sr = {};
        for (const [k, v] of Object.entries(row)) {
          const sk = camelToSnake(k);
          sr[sk] = ser(v, sk);
        }
        const set = keys.map(k => { params.push(sr[k]); return `$${idx++}`; });
        valueSets.push(`(${set.join(', ')})`);
      }
      const r = await client.query(
        `INSERT INTO "${t}" (${cols}) VALUES ${valueSets.join(', ')} RETURNING *`,
        params
      );
      results.push(...r.rows.map(toCamel));
    }
    await client.query('COMMIT');
    return results;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function update(table, id, patch) {
  const sr = {};
  for (const [k, v] of Object.entries({ ...patch, updatedAt: Date.now() })) {
    const sk = camelToSnake(k);
    sr[sk] = ser(v, sk);
  }
  const keys = Object.keys(sr);
  const vals = Object.values(sr);
  const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
  const r = await pool.query(
    `UPDATE "${tbl(table)}" SET ${set} WHERE "id" = $${keys.length + 1} RETURNING *`,
    [...vals, id]
  );
  return r.rows.length ? toCamel(r.rows[0]) : null;
}

async function remove(table, filter) {
  const { clause, values } = buildFilter(filter);
  if (!clause) throw new Error('remove() requires at least one filter condition');
  const r = await pool.query(`DELETE FROM "${tbl(table)}" ${clause}`, values);
  return r.rowCount;
}

module.exports = { pool, query, queryOne, findOne, findAll, insert, insertMany, update, remove };
