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
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
pool.on('error', err => logger.error({ err: err.message }, 'pool error'));

// JS camelCase table name → Postgres snake_case table name
const TABLE_MAP = { captureFields: 'capture_fields' };
const tbl = name => TABLE_MAP[name] || name;

const camelToSnake = s => s.replace(/[A-Z]/g, l => '_' + l.toLowerCase());
const snakeToCamel = s => s.replace(/_([a-z])/g, (_, l) => l.toUpperCase());

function toCamel(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[snakeToCamel(k)] = v;
  return out;
}

// Arrays of numbers → pgvector literal string "[x,y,z]".
// Other arrays → JSON string; pg's default array serialization produces
// Postgres array-literal syntax ("{a,b}"), which is not valid JSON, so JSONB
// array columns need an explicit JSON.stringify. Plain objects pass through —
// pg's driver already JSON.stringifies those.
function ser(v) {
  if (Array.isArray(v)) {
    if (v.length > 0 && typeof v[0] === 'number') return '[' + v.join(',') + ']';
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
  for (const [k, v] of Object.entries(row)) sr[camelToSnake(k)] = ser(v);
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
        for (const [k, v] of Object.entries(row)) sr[camelToSnake(k)] = ser(v);
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
    sr[camelToSnake(k)] = ser(v);
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
