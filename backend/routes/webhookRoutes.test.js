/**
 * GET /:id/webhook/deliveries and POST /:id/webhook/rotate-secret
 * (improvement-prompts.md Prompt F4 item 6) — the owner-facing half of
 * webhook reliability; services/webhookDelivery.test.js covers the
 * retry-with-backoff logic itself.
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
const PROJECT = { id: 'proj-1', userId: OWNER.id, name: 'Bot', publicId: 'bot-1', webhookSecret: 'old-secret', createdAt: 1 };

const DELIVERY_ROWS = [
  { id: 'd1', eventType: 'message', status: 'success', attempt: 1, responseStatus: 200, error: null, createdAt: 2, deliveredAt: 3 },
  { id: 'd2', eventType: 'message', status: 'failed', attempt: 5, responseStatus: 500, error: 'HTTP 500', createdAt: 1, deliveredAt: null },
];

let queryCalls = [];
let updateCalls = [];

stubFile('../db', {
  findOne: async (table, filter) => {
    if (table === 'users') return [OWNER, OUTSIDER].find(u => u.id === filter.id) || null;
    if (table === 'projects') return (filter.id === PROJECT.id && (!filter.userId || filter.userId === PROJECT.userId)) ? { ...PROJECT } : null;
    return null;
  },
  findAll: async () => [],
  query: async (sql, params) => { queryCalls.push({ sql, params }); return DELIVERY_ROWS; },
  queryOne: async () => null,
  insert: async () => null,
  update: async (table, id, patch) => { updateCalls.push({ table, id, patch }); return { ...PROJECT, ...patch }; },
  remove: async () => 0,
  pool: { end: async () => {} },
});
stubFile('../services/safeFetch', { safeFetch: async () => { throw new Error('not used'); }, assertSafeUrl: async () => {} });
stubFile('../services/storage', { createSignedUploadUrl: async () => ({}), characterAssets: { getPublicUrl: () => '' } });
stubFile('../services/usage', { checkLimit: async () => ({ ok: true }), userPlanId: async () => 'free' });
stubFile('../services/email', { sendTeamInviteEmail: async () => {} });

function request(port, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } },
      (res) => {
        let chunks = ''; res.on('data', (c) => (chunks += c));
        res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(chunks || '{}') }); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('webhook deliveries list and secret rotation', async (t) => {
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
  const token = jwt.sign({ uid: OWNER.id }, process.env.JWT_SECRET, { algorithm: 'HS256' });

  const list = await request(port, 'GET', `/api/projects/${PROJECT.id}/webhook/deliveries`, null, token);
  assert.equal(list.status, 200);
  assert.equal(list.json.deliveries.length, 2);
  assert.equal(list.json.deliveries[0].status, 'success');
  assert.match(queryCalls[0].sql, /FROM webhook_deliveries/);
  assert.deepEqual(queryCalls[0].params, [PROJECT.id]);

  const rotate = await request(port, 'POST', `/api/projects/${PROJECT.id}/webhook/rotate-secret`, null, token);
  assert.equal(rotate.status, 200);
  assert.ok(rotate.json.webhookSecret, 'a new secret is returned');
  assert.notEqual(rotate.json.webhookSecret, PROJECT.webhookSecret, 'the secret actually changes');
  assert.equal(rotate.json.webhookSecret.length, 64, '32 random bytes, hex-encoded');
  assert.equal(updateCalls[0].patch.webhookSecret, rotate.json.webhookSecret);

  // A different, valid user can't see or rotate another owner's project.
  const outsiderToken = jwt.sign({ uid: OUTSIDER.id }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  const deniedList = await request(port, 'GET', `/api/projects/${PROJECT.id}/webhook/deliveries`, null, outsiderToken);
  assert.equal(deniedList.status, 404);
  const deniedRotate = await request(port, 'POST', `/api/projects/${PROJECT.id}/webhook/rotate-secret`, null, outsiderToken);
  assert.equal(deniedRotate.status, 404);
});
