/**
 * db.js's ser() value serialization — exercised indirectly through
 * insert()/query(), matching how every other test in this repo stubs at
 * the require boundary rather than reaching into unexported internals.
 * Covers the three branches (improvement-prompts.md Prompt T1 item 4):
 *   - number arrays  → pgvector literal string "[x,y,z]" (embedding columns)
 *   - NATIVE_ARRAY_COLUMNS (topic_tags, applicable_plan_ids) → passed through
 *     for pg's own Postgres array-literal serialization
 *   - everything else → JSON.stringify'd for JSONB columns
 * Also covers searchProject()'s query-side vector literal and its score
 * coercion (pg can return NUMERIC columns as strings).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

let queryCalls;
function stubPg() {
  queryCalls = [];
  class FakePool {
    query(sql, params) {
      queryCalls.push({ sql, params });
      // insert()/query() both just need rows back with something to camelCase.
      return Promise.resolve({ rows: [{ id: 'row1' }] });
    }
    on() {}
  }
  stubFile('pg', { Pool: FakePool, types: { setTypeParser: () => {} } });
}

function reloadDb() {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';
  stubPg();
  delete require.cache[require.resolve('./db')];
  return require('./db');
}

test('insert() serializes a number array as a pgvector literal string', async () => {
  const db = reloadDb();
  await db.insert('chunks', { id: 'c1', embedding: [0.1, 0.25, -0.5] });
  const call = queryCalls[0];
  const embeddingIdx = call.sql.match(/"embedding"/) ? extractParamIndex(call.sql, 'embedding') : -1;
  assert.notEqual(embeddingIdx, -1, 'expected an "embedding" column in the INSERT');
  assert.equal(call.params[embeddingIdx], '[0.1,0.25,-0.5]');
});

test('insert() JSON-stringifies a non-numeric array for a JSONB column', async () => {
  const db = reloadDb();
  await db.insert('files', { id: 'f1', tags: ['a', 'b', 'c'] });
  const call = queryCalls[0];
  const idx = extractParamIndex(call.sql, 'tags');
  assert.equal(call.params[idx], JSON.stringify(['a', 'b', 'c']));
});

test('insert() passes native Postgres array columns through untouched (not JSON-stringified)', async () => {
  const db = reloadDb();
  await db.insert('videoResources', { id: 'v1', topicTags: ['algebra', 'geometry'] });
  const call = queryCalls[0];
  const idx = extractParamIndex(call.sql, 'topic_tags');
  assert.deepEqual(call.params[idx], ['algebra', 'geometry'], 'NATIVE_ARRAY_COLUMNS should stay a real JS array, not a JSON string');
});

test('insert() maps camelCase table names to their snake_case table (e.g. videoResources -> video_resources)', async () => {
  const db = reloadDb();
  await db.insert('videoResources', { id: 'v1', topicTags: [] });
  assert.match(queryCalls[0].sql, /INSERT INTO "video_resources"/);
});

test('insert() leaves non-array values (including plain objects and empty arrays) untouched', async () => {
  const db = reloadDb();
  await db.insert('projects', { id: 'p1', name: 'Test', capabilityTier: 'basic', emptyArr: [] });
  const call = queryCalls[0];
  assert.equal(call.params[extractParamIndex(call.sql, 'name')], 'Test');
  // An empty array has no [0] to type-check as a number, so it falls through
  // to the JSON-stringify branch like any other JSONB array.
  assert.equal(call.params[extractParamIndex(call.sql, 'empty_arr')], '[]');
});

test('services/vector.js searchProject builds the pgvector literal the same way and coerces the score to a number', async () => {
  const db = reloadDb();
  stubFile('./db', {
    ...db,
    query: async (sql, params) => {
      queryCalls.push({ sql, params });
      // pg can return NUMERIC/float8 columns as strings depending on
      // driver config — searchProject must coerce this, not trust it.
      return [{ id: 'chunk1', score: '0.87654' }];
    },
  });
  delete require.cache[require.resolve('./services/vector')];
  const { searchProject } = require('./services/vector');

  const results = await searchProject('proj1', [0.1, 0.2, 0.3], 5);
  assert.equal(queryCalls[0].params[0], '[0.1,0.2,0.3]');
  assert.equal(queryCalls[0].params[1], 'proj1');
  assert.equal(queryCalls[0].params[2], 5);
  assert.equal(typeof results[0].score, 'number');
  assert.equal(results[0].score, 0.87654);
});

// Finds which $N placeholder a given column name maps to in an
// `INSERT INTO "table" ("a", "b", ...) VALUES ($1, $2, ...)` statement.
function extractParamIndex(sql, column) {
  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map(s => s.trim().replace(/"/g, ''));
  return cols.indexOf(column);
}
