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
let currentUser = USER;
let leadRows = [];
stubFile('../db', {
  findOne: async (table, filter) => {
    if (table === 'users' && filter.id === USER.id) return currentUser;
    if (table === 'projects' && filter.id === PROJECT_ROWS[0].id && filter.userId === USER.id) return PROJECT_ROWS[0];
    return null;
  },
  findAll: async () => [], // no captureFields configured, for any project
  query: async (sql, params) => {
    queryCalls.push({ sql, params });
    if (/FROM leads l\b/.test(sql)) return leadRows;
    return PROJECT_ROWS;
  },
  queryOne: async (sql) => {
    if (/COUNT\(\*\) AS total FROM leads/.test(sql)) return { total: leadRows.length };
    return null;
  },
  insert: async () => null,
  update: async () => null,
  remove: async () => 0,
  pool: { end: async () => {} },
});
stubFile('../services/safeFetch', { safeFetch: async () => { throw new Error('not used'); }, assertSafeUrl: async () => {} });
stubFile('../services/storage', {
  createSignedUploadUrl: async () => ({}), characterAssets: { getPublicUrl: () => '' },
});
// Deliberately fails for a DIFFERENT reason than the verification gate, so
// a request that gets past the gate is distinguishable (402, not 403/
// EMAIL_NOT_VERIFIED) from one the gate itself blocked.
stubFile('../services/usage', { checkLimit: async () => ({ ok: false, reason: 'stubbed limit' }) });

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

test('POST /api/projects: email-verification gate is time-based, not an outright block', async (t) => {
  delete require.cache[require.resolve('./projects')];
  const { router } = require('./projects');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', router);
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0);
  t.after(() => { server.close(); currentUser = USER; });
  const port = server.address().port;
  const token = jwt.sign({ uid: USER.id }, process.env.JWT_SECRET, { algorithm: 'HS256' });

  const post = () => new Promise((resolve, reject) => {
    const data = JSON.stringify({ name: 'Test Bot', characterId: 'character_1' });
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/projects', method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let body = ''; res.on('data', c => body += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });

  // Unverified, but freshly signed up (within the 72h grace window) — must NOT be blocked by the gate.
  currentUser = { ...USER, emailVerifiedAt: null, createdAt: Date.now() };
  const withinGrace = await post();
  assert.notEqual(withinGrace.status, 403, 'a brand-new unverified account should still be able to create its first project');

  // Unverified, well past the grace window — the gate should block with 403/EMAIL_NOT_VERIFIED.
  currentUser = { ...USER, emailVerifiedAt: null, createdAt: Date.now() - 100 * 3600000 };
  const pastGrace = await post();
  assert.equal(pastGrace.status, 403);
  assert.equal(pastGrace.json.code, 'EMAIL_NOT_VERIFIED');

  // Verified, regardless of account age — never blocked by this gate.
  currentUser = { ...USER, emailVerifiedAt: Date.now() - 1000, createdAt: Date.now() - 100 * 3600000 };
  const verified = await post();
  assert.notEqual(verified.status, 403);
});

test('GET /api/projects/:id/leads: fieldLabels always includes name/email, even with no captureFields configured', async (t) => {
  delete require.cache[require.resolve('./projects')];
  const { router } = require('./projects');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', router);
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0);
  leadRows = [{
    id: 'lead1', projectId: PROJECT_ROWS[0].id, sessionId: 's1',
    // A lead captured via the "no one available" fallback form only has
    // name/email — no configured captureFields for this project.
    data: { name: 'Jane Doe', email: 'jane@example.com' },
    complete: true, createdAt: Date.now(),
  }];
  t.after(() => { server.close(); leadRows = []; });
  const port = server.address().port;

  const token = jwt.sign({ uid: USER.id }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/projects/${PROJECT_ROWS[0].id}/leads`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(data) }); } catch (e) { reject(e); } });
    }).on('error', reject);
  });

  assert.equal(body.status, 200);
  assert.equal(body.json.leads.length, 1);
  assert.deepEqual(body.json.leads[0].fieldLabels, { name: 'Name', email: 'Email' });
});
