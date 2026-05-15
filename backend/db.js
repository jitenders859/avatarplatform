/**
 * Tiny JSON-file database.
 *
 * Each "table" is a single .json file under data/. Writes are atomic
 * (write to .tmp, then rename) and serialized through a per-table
 * promise chain so concurrent route handlers can't clobber each other.
 *
 * This is enough for a self-hosted SaaS at small/medium scale. Swap
 * for Postgres later by reimplementing the same exported surface.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TABLES = {
  users:         path.join(DATA_DIR, 'users.json'),
  projects:      path.join(DATA_DIR, 'projects.json'),
  files:         path.join(DATA_DIR, 'files.json'),
  chunks:        path.join(DATA_DIR, 'chunks.json'),   // also stores embeddings
  sessions:      path.join(DATA_DIR, 'sessions.json'),
  messages:      path.join(DATA_DIR, 'messages.json'),
  subscriptions: path.join(DATA_DIR, 'subscriptions.json'),
  usage:         path.join(DATA_DIR, 'usage.json'),
  captureFields: path.join(DATA_DIR, 'captureFields.json'),
  leads:         path.join(DATA_DIR, 'leads.json'),
};

// Initialize empty tables on first boot
for (const file of Object.values(TABLES)) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf8');
}

// Per-table write lock (each is a promise chain)
const locks = Object.fromEntries(Object.keys(TABLES).map(k => [k, Promise.resolve()]));

function readTable(name) {
  const file = TABLES[name];
  if (!file) throw new Error('Unknown table: ' + name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[db] Failed to read ${name}:`, e.message);
    return [];
  }
}

function writeTable(name, rows) {
  const file = TABLES[name];
  if (!file) throw new Error('Unknown table: ' + name);
  // Chain onto the existing lock so writes never overlap
  locks[name] = locks[name].then(() => new Promise((resolve, reject) => {
    const tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8', err => {
      if (err) return reject(err);
      fs.rename(tmp, file, err2 => err2 ? reject(err2) : resolve());
    });
  })).catch(err => {
    console.error(`[db] Write failed for ${name}:`, err);
    throw err;
  });
  return locks[name];
}

// ── CRUD helpers ──────────────────────────────────────────────

async function insert(name, row) {
  const rows = readTable(name);
  rows.push(row);
  await writeTable(name, rows);
  return row;
}

async function update(name, id, patch) {
  const rows = readTable(name);
  const idx = rows.findIndex(r => r.id === id);
  if (idx === -1) return null;
  rows[idx] = { ...rows[idx], ...patch, updatedAt: Date.now() };
  await writeTable(name, rows);
  return rows[idx];
}

async function remove(name, predicate) {
  const rows = readTable(name);
  const kept = rows.filter(r => !predicate(r));
  const removedCount = rows.length - kept.length;
  if (removedCount > 0) await writeTable(name, kept);
  return removedCount;
}

function findOne(name, predicate) {
  return readTable(name).find(predicate) || null;
}

function findAll(name, predicate) {
  const rows = readTable(name);
  return predicate ? rows.filter(predicate) : rows;
}

module.exports = {
  readTable, writeTable,
  insert, update, remove,
  findOne, findAll,
};
