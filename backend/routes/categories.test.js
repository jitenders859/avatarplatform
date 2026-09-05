/**
 * Chatbot categories — create/list/patch/delete a category, plus bulk- and
 * single-assignment of chatbots (projects) into one. Every route is
 * tenant-scoped (userId filter/param), mirroring the ownership pattern
 * already covered for projects (see projects.test.js, projectMembers.test.js).
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
const OUTSIDER = { id: 'outsider-1', email: 'outsider@example.com', suspended: false };
const USERS_BY_ID = { [OWNER.id]: OWNER, [OUTSIDER.id]: OUTSIDER };

let categories = []; // { id, userId, name, color, description, createdAt, updatedAt }
let projects = [];   // { id, userId, categoryId, name, publicId, characterId, createdAt }
let queryCalls = [];
let updateCalls = [];

function matches(row, filter) {
  return Object.entries(filter).every(([k, v]) => row[k] === v);
}

stubFile('../db', {
  findOne: async (table, filter) => {
    if (table === 'users') return USERS_BY_ID[filter.id] || null;
    if (table === 'chatbotCategories') return categories.find(c => matches(c, filter)) || null;
    if (table === 'projects') return projects.find(p => matches(p, filter)) || null;
    return null;
  },
  findAll: async (table, filter = {}) => {
    if (table === 'projects') return projects.filter(p => matches(p, filter));
    return [];
  },
  query: async (sql, params) => {
    queryCalls.push({ sql, params });
    if (/FROM chatbot_categories cc/.test(sql)) {
      const [userId] = params;
      return categories.filter(c => c.userId === userId).map(c => ({
        id: c.id, name: c.name, color: c.color, description: c.description,
        createdAt: c.createdAt, updatedAt: c.updatedAt,
        chatbots: projects.filter(p => p.categoryId === c.id)
          .map(p => ({ id: p.id, name: p.name, publicId: p.publicId, characterId: p.characterId })),
      }));
    }
    if (/UPDATE projects SET category_id/.test(sql)) {
      const [categoryId, updatedAt, projectIds, userId] = params;
      const matched = projects.filter(p => projectIds.includes(p.id) && p.userId === userId);
      matched.forEach(p => { p.categoryId = categoryId; p.updatedAt = updatedAt; });
      return matched.map(p => ({ id: p.id }));
    }
    return [];
  },
  queryOne: async () => null,
  insert: async (table, row) => {
    if (table === 'chatbotCategories') { categories.push(row); return row; }
    return row;
  },
  update: async (table, id, patch) => {
    updateCalls.push({ table, id, patch });
    if (table === 'chatbotCategories') {
      const c = categories.find(x => x.id === id);
      Object.assign(c, patch);
      return c;
    }
    if (table === 'projects') {
      const p = projects.find(x => x.id === id);
      Object.assign(p, patch);
      return p;
    }
    return null;
  },
  remove: async (table, filter) => {
    if (table === 'chatbotCategories') {
      const before = categories.length;
      categories = categories.filter(c => !matches(c, filter));
      return before - categories.length;
    }
    return 0;
  },
  pool: { end: async () => {} },
});

function request(port, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(chunks || '{}') }); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function setupApp() {
  delete require.cache[require.resolve('./categories')];
  const router = require('./categories');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/categories', router);
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

function token(user) {
  return jwt.sign({ uid: user.id }, process.env.JWT_SECRET, { algorithm: 'HS256' });
}

test('chatbot categories: create, duplicate names, list-with-chatbots, patch, delete, assign', async (t) => {
  const app = setupApp();
  const server = app.listen(0);
  t.after(() => { server.close(); categories = []; projects = []; queryCalls = []; updateCalls = []; });
  const port = server.address().port;
  const ownerToken = token(OWNER);
  const outsiderToken = token(OUTSIDER);

  // No token → 401.
  const noAuth = await request(port, 'GET', '/api/categories', null);
  assert.equal(noAuth.status, 401);

  // Create.
  const create = await request(port, 'POST', '/api/categories', { name: 'Support', color: '#7c6af5' }, ownerToken);
  assert.equal(create.status, 200);
  assert.equal(create.json.category.name, 'Support');
  assert.deepEqual(create.json.category.chatbots, []);
  const categoryId = create.json.category.id;

  // Duplicate name for the same owner → 409.
  const dupe = await request(port, 'POST', '/api/categories', { name: 'Support' }, ownerToken);
  assert.equal(dupe.status, 409);

  // Missing name → 400 (zod validation).
  const badBody = await request(port, 'POST', '/api/categories', {}, ownerToken);
  assert.equal(badBody.status, 400);

  // Seed two chatbots owned by OWNER, one owned by OUTSIDER.
  projects.push(
    { id: 'p1', userId: OWNER.id, name: 'Bot A', publicId: 'bot-a', characterId: 'character_1', categoryId: null, createdAt: 1 },
    { id: 'p2', userId: OWNER.id, name: 'Bot B', publicId: 'bot-b', characterId: 'character_1', categoryId: null, createdAt: 2 },
    { id: 'p3', userId: OUTSIDER.id, name: 'Outsider Bot', publicId: 'bot-c', characterId: 'character_1', categoryId: null, createdAt: 3 },
  );

  // Bulk-assign p1 + p2 (owned) and p3 (not owned — silently skipped).
  const assign = await request(port, 'POST', `/api/categories/${categoryId}/chatbots`, { projectIds: ['p1', 'p2', 'p3'] }, ownerToken);
  assert.equal(assign.status, 200);
  assert.equal(assign.json.assigned, 2, 'only the caller-owned projects are assigned');
  assert.equal(projects.find(p => p.id === 'p1').categoryId, categoryId);
  assert.equal(projects.find(p => p.id === 'p2').categoryId, categoryId);
  assert.equal(projects.find(p => p.id === 'p3').categoryId, null, "another user's project must never be touched");

  // OUTSIDER can't see OWNER's category at all.
  const outsiderGet = await request(port, 'GET', `/api/categories/${categoryId}`, null, outsiderToken);
  assert.equal(outsiderGet.status, 404);

  // GET / lists the category with its chatbots nested.
  const list = await request(port, 'GET', '/api/categories', null, ownerToken);
  assert.equal(list.status, 200);
  assert.equal(list.json.categories.length, 1);
  assert.equal(list.json.categories[0].chatbots.length, 2);

  // GET /:id returns the category + full chatbot rows.
  const get = await request(port, 'GET', `/api/categories/${categoryId}`, null, ownerToken);
  assert.equal(get.status, 200);
  assert.equal(get.json.chatbots.length, 2);

  // Unassign one chatbot.
  const unassign = await request(port, 'DELETE', `/api/categories/${categoryId}/chatbots/p1`, null, ownerToken);
  assert.equal(unassign.status, 200);
  assert.equal(projects.find(p => p.id === 'p1').categoryId, null);

  // Unassigning a chatbot not in this category (or not owned) 404s.
  const unassignMissing = await request(port, 'DELETE', `/api/categories/${categoryId}/chatbots/p1`, null, ownerToken);
  assert.equal(unassignMissing.status, 404);

  // Create a second category, then try to rename it to the existing name → 409.
  const create2 = await request(port, 'POST', '/api/categories', { name: 'Sales' }, ownerToken);
  assert.equal(create2.status, 200);
  const renameConflict = await request(port, 'PATCH', `/api/categories/${create2.json.category.id}`, { name: 'Support' }, ownerToken);
  assert.equal(renameConflict.status, 409);

  // Rename to a free name succeeds.
  const rename = await request(port, 'PATCH', `/api/categories/${create2.json.category.id}`, { name: 'Marketing' }, ownerToken);
  assert.equal(rename.status, 200);
  assert.equal(rename.json.category.name, 'Marketing');

  // Delete un-categorizes rather than erroring, and the category is gone.
  const del = await request(port, 'DELETE', `/api/categories/${categoryId}`, null, ownerToken);
  assert.equal(del.status, 200);
  const afterDelete = await request(port, 'GET', `/api/categories/${categoryId}`, null, ownerToken);
  assert.equal(afterDelete.status, 404);
});
