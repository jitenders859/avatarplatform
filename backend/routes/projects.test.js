/**
 * GET /api/projects — folds each project's lead count into one grouped
 * query instead of the dashboard firing one GET /:id/leads?limit=1 request
 * per project (improvement-prompts.md Prompt P1-1 item 4). Also stands in
 * as a regression test for a `strip is not defined` crash this route had
 * briefly during the C1 dead-code cleanup pass — `strip()` was deleted as
 * unused, but this call site (passed as a bare function reference,
 * `projects.map(strip)`, so it didn't show up in a `strip(` grep) was
 * missed on the first pass.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-do-not-use-in-prod';

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

const USER = { id: '11111111-1111-1111-1111-111111111111', email: 'owner@example.com', suspended: false };
const PROJECT_ROWS = [
  { id: 'p1', userId: USER.id, name: 'Bot A', publicId: 'bot-a', createdAt: 2, leadCount: 3 },
  { id: 'p2', userId: USER.id, name: 'Bot B', publicId: 'bot-b', createdAt: 1, leadCount: 0 },
];

let queryCalls = [];
stubFile('../db', {
  findOne: async (table, filter) => (table === 'users' && filter.id === USER.id ? USER : null),
  findAll: async () => [],
  query: async (sql, params) => { queryCalls.push({ sql, params }); return PROJECT_ROWS; },
  queryOne: async () => null,
  insert: async () => null,
  update: async () => null,
  remove: async () => 0,
  pool: { end: async () => {} },
});
stubFile('../services/safeFetch', { safeFetch: async () => { throw new Error('not used'); }, assertSafeUrl: async () => {} });
stubFile('../services/storage', {
  createSignedUploadUrl: async () => ({}), characterAssets: { getPublicUrl: () => '' },
});

test('GET /api/projects folds leadCount into one grouped query', async (t) => {
  delete require.cache[require.resolve('./projects')];
  const { router } = require('./projects');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', router);
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;

  const token = jwt.sign({ uid: USER.id }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/projects`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(data) }); } catch (e) { reject(e); } });
    }).on('error', reject);
  });

  assert.equal(body.status, 200);
  assert.equal(body.json.projects.length, 2);
  assert.equal(body.json.projects[0].leadCount, 3);
  assert.equal(body.json.projects[1].leadCount, 0);
  assert.equal(queryCalls.length, 1, 'expected exactly one query — no per-project N+1');
  assert.match(queryCalls[0].sql, /LEFT JOIN leads/);
  assert.deepEqual(queryCalls[0].params, [USER.id]);
});
