/**
 * Admin auth is structurally disjoint from customer auth (see the comment
 * above adminAuthRequired in auth.js) — a customer token must never pass
 * adminAuthRequired, and an admin token must never pass authRequired.
 * improvement-prompts.md Prompt T1 item 5 calls this out explicitly as a
 * regression worth pinning down at the route-middleware level.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-do-not-use-in-prod';

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

const CUSTOMER = { id: 'user-1', email: 'customer@example.com', suspended: false };
const ADMIN = { id: 'admin-1', email: 'admin@example.com' };

stubFile('../db', {
  findOne: async (table, filter) => {
    if (table === 'users') return filter.id === CUSTOMER.id ? CUSTOMER : null;
    if (table === 'admin_users') return filter.id === ADMIN.id ? ADMIN : null;
    return null;
  },
});

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('a customer token is rejected by adminAuthRequired', async () => {
  const { authRequired, adminAuthRequired, signToken } = require('./auth');
  const token = signToken(CUSTOMER.id);
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes();
  let nextCalled = false;
  await adminAuthRequired(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);

  // Sanity check the same token DOES pass the customer middleware, so this
  // is a real cross-boundary rejection and not just a broken token.
  const req2 = { headers: { authorization: `Bearer ${token}` } };
  const res2 = mockRes();
  let customerNextCalled = false;
  await authRequired(req2, res2, () => { customerNextCalled = true; });
  assert.equal(customerNextCalled, true);
  assert.equal(req2.user.id, CUSTOMER.id);
});

test('an admin token is rejected by authRequired', async () => {
  const { authRequired, signAdminToken } = require('./auth');
  const token = signAdminToken(ADMIN.id);
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes();
  let nextCalled = false;
  await authRequired(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('a token with neither uid nor isAdmin is rejected by both middlewares', async () => {
  const { authRequired, adminAuthRequired } = require('./auth');
  const jwt = require('jsonwebtoken');
  const bareToken = jwt.sign({ someOtherClaim: true }, process.env.JWT_SECRET);

  const res1 = mockRes();
  await authRequired({ headers: { authorization: `Bearer ${bareToken}` } }, res1, () => { throw new Error('must not call next'); });
  assert.equal(res1.statusCode, 401);

  const res2 = mockRes();
  await adminAuthRequired({ headers: { authorization: `Bearer ${bareToken}` } }, res2, () => { throw new Error('must not call next'); });
  assert.equal(res2.statusCode, 401);
});
