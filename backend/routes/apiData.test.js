/**
 * Read-only "export" API (GET /api/data/*) — lets an owner pull every
 * category, chatbot, message, URL source, and lead across their whole
 * account. The critical property to test is tenant scoping (every query
 * is filtered to the caller's own user_id) plus that ?projectId=/
 * ?categoryId= filters and pagination are actually wired into the SQL,
 * mirroring the SQL-assertion style already used in projects.test.js.
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

const OWNER = { id: 'owner-1', email: 'owner@example.com', suspended: false };

let queryCalls = [];
let queryOneCalls = [];

stubFile('../db', {
  findOne: async (table, filter) => (table === 'users' && filter.id === OWNER.id ? OWNER : null),
  findAll: async () => [],
  query: async (sql, params) => { queryCalls.push({ sql, params }); return []; },
  queryOne: async (sql, params) => { queryOneCalls.push({ sql, params }); return { total: 0 }; },
  insert: async () => null,
  update: async () => null,
  remove: async () => 0,
  pool: { end: async () => {} },
});

function request(port, path, token) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(data) }); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function setupApp() {
  delete require.cache[require.resolve('./apiData')];
  const router = require('./apiData');
  const express = require('express');
  const app = express();
  app.use('/api/data', router);
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

function token(user) {
  return jwt.sign({ uid: user.id }, process.env.JWT_SECRET, { algorithm: 'HS256' });
}

test('export API: every resource is scoped to the caller and returns the documented envelope', async (t) => {
  const app = setupApp();
  const server = app.listen(0);
  t.after(() => { server.close(); queryCalls = []; queryOneCalls = []; });
  const port = server.address().port;
  const ownerToken = token(OWNER);

  // No token → 401, for every resource.
  for (const path of ['/api/data/categories', '/api/data/chatbots', '/api/data/messages', '/api/data/urls', '/api/data/leads']) {
    const res = await request(port, path, null);
    assert.equal(res.status, 401, `${path} must require auth`);
  }

  // /categories — one query, scoped to the caller's own userId, no
  // pagination envelope (categories aren't paginated).
  queryCalls = [];
  const categories = await request(port, '/api/data/categories', ownerToken);
  assert.equal(categories.status, 200);
  assert.deepEqual(categories.json.categories, []);
  assert.equal(queryCalls.length, 1);
  assert.match(queryCalls[0].sql, /FROM chatbot_categories cc/);
  assert.deepEqual(queryCalls[0].params, [OWNER.id]);

  // /chatbots — scoped by userId; ?categoryId= appends a second param.
  queryCalls = [];
  await request(port, '/api/data/chatbots', ownerToken);
  assert.equal(queryCalls[0].params.length, 1);
  assert.equal(queryCalls[0].params[0], OWNER.id);

  queryCalls = [];
  await request(port, '/api/data/chatbots?categoryId=cat-1', ownerToken);
  assert.deepEqual(queryCalls[0].params, [OWNER.id, 'cat-1']);
  assert.match(queryCalls[0].sql, /p\.category_id = \$2/);

  // /messages — default pagination (page 1, limit 50), scoped by
  // p.user_id, and the count query's params match the row query's
  // params minus [limit, offset].
  queryCalls = []; queryOneCalls = [];
  const messages = await request(port, '/api/data/messages', ownerToken);
  assert.equal(messages.status, 200);
  assert.deepEqual(messages.json, { messages: [], total: 0, page: 1, limit: 50 });
  assert.equal(queryOneCalls.length, 1);
  assert.match(queryOneCalls[0].sql, /p\.user_id = \$1/);
  assert.deepEqual(queryOneCalls[0].params, [OWNER.id]);
  assert.deepEqual(queryCalls[0].params, [OWNER.id, 50, 0]);

  // ?projectId=&categoryId= both narrow the WHERE clause with extra params,
  // and pagination overrides flow through to LIMIT/OFFSET and the envelope.
  queryCalls = []; queryOneCalls = [];
  const filtered = await request(port, '/api/data/messages?projectId=p1&categoryId=cat-1&page=2&limit=10', ownerToken);
  assert.deepEqual(filtered.json, { messages: [], total: 0, page: 2, limit: 10 });
  assert.deepEqual(queryOneCalls[0].params, [OWNER.id, 'p1', 'cat-1']);
  assert.deepEqual(queryCalls[0].params, [OWNER.id, 'p1', 'cat-1', 10, 10]);
  assert.match(queryCalls[0].sql, /m\.project_id = \$2/);
  assert.match(queryCalls[0].sql, /p\.category_id = \$3/);

  // limit is capped at 200.
  queryCalls = []; queryOneCalls = [];
  const capped = await request(port, '/api/data/messages?limit=9999', ownerToken);
  assert.equal(capped.json.limit, 200);

  // /urls — scoped by f.user_id AND f.kind = 'url'.
  queryCalls = []; queryOneCalls = [];
  const urls = await request(port, '/api/data/urls', ownerToken);
  assert.equal(urls.status, 200);
  assert.deepEqual(urls.json, { urls: [], total: 0, page: 1, limit: 50 });
  assert.match(queryOneCalls[0].sql, /f\.user_id = \$1/);
  assert.match(queryOneCalls[0].sql, /f\.kind = 'url'/);

  // /leads — scoped by p.user_id; ?complete=true|false appends a literal
  // clause (no extra bound param, matching GET /api/projects/:id/leads).
  queryCalls = []; queryOneCalls = [];
  await request(port, '/api/data/leads?complete=true', ownerToken);
  assert.match(queryOneCalls[0].sql, /l\.complete = true/);
  assert.deepEqual(queryOneCalls[0].params, [OWNER.id]);

  queryCalls = []; queryOneCalls = [];
  const leadsDefault = await request(port, '/api/data/leads', ownerToken);
  assert.deepEqual(leadsDefault.json, { leads: [], total: 0, page: 1, limit: 50 });
});
