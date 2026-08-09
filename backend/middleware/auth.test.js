const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const jwt = require('jsonwebtoken');

// Set before requiring the module under test — it now throws at require
// time if JWT_SECRET is missing (that's exactly what the first test below
// verifies from a clean process).
process.env.JWT_SECRET = 'test-only-secret-do-not-use-in-prod';

// `auth.js` does `const db = require('../db')` and calls `db.findOne(...)`.
// Node caches modules by resolved path, so requiring '../db' here first and
// monkey-patching its `findOne` gives us the exact same singleton object
// `auth.js` holds a reference to — no live DATABASE_URL needed (pg's Pool
// doesn't connect eagerly on require). Same technique as plans.test.js.
const db = require('../db');

let findOneCalls;
let findOneImpl;
db.findOne = (...args) => {
  findOneCalls.push(args);
  return findOneImpl(...args);
};

const { signToken, signAdminToken, authRequired, adminAuthRequired, JWT_SECRET } = require('./auth');

function makeRes() {
  const res = {
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

function makeNext() {
  const calls = [];
  const next = (...args) => calls.push(args);
  next.calls = calls;
  return next;
}

test.beforeEach(() => {
  findOneCalls = [];
  findOneImpl = () => { throw new Error('db.findOne should not have been called for this case'); };
});

test('module throws at load time when JWT_SECRET is unset (no hardcoded fallback secret)', () => {
  // Regression test: this module used to do
  // `process.env.JWT_SECRET || 'change-me-in-production-please'`, so a
  // deployment with a missing env var would silently sign/verify tokens
  // with a secret sitting in source control instead of failing to boot.
  const authPath = path.join(__dirname, 'auth.js');
  const env = { ...process.env };
  delete env.JWT_SECRET;

  assert.throws(() => {
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(authPath)})`], {
      env,
      stdio: 'pipe',
    });
  });
});

test('signToken issues a token verifiable only with the real configured secret', () => {
  const token = signToken('user-123');
  const payload = jwt.verify(token, JWT_SECRET);
  assert.equal(payload.uid, 'user-123');
});

test('a token forged with the old hardcoded default secret is rejected once a real JWT_SECRET is configured', () => {
  const forged = jwt.sign({ uid: 'victim-user' }, 'change-me-in-production-please', { expiresIn: '30d' });
  assert.throws(() => jwt.verify(forged, JWT_SECRET));
});

test('signToken accepts an expiresIn override for short-lived impersonation tokens', () => {
  const token = signToken('user-123', { expiresIn: '15m' });
  const payload = jwt.verify(token, JWT_SECRET);
  assert.equal(payload.uid, 'user-123');
  const secondsLeft = payload.exp - payload.iat;
  assert.equal(secondsLeft, 15 * 60);
});

test('signAdminToken issues a token with isAdmin:true and no uid, distinct from customer tokens', () => {
  const adminToken = signAdminToken('admin-1');
  const payload = jwt.verify(adminToken, JWT_SECRET);
  assert.equal(payload.aid, 'admin-1');
  assert.equal(payload.isAdmin, true);
  assert.equal(payload.uid, undefined);
});

test('a customer token (signToken) has no isAdmin flag, so it cannot pass as an admin token', () => {
  const customerToken = signToken('user-123');
  const payload = jwt.verify(customerToken, JWT_SECRET);
  assert.equal(payload.isAdmin, undefined);
});

test('adminAuthRequired rejects a customer token (401, next not called, no DB lookup)', async () => {
  const customerToken = signToken('user-123');
  const req = { headers: { authorization: 'Bearer ' + customerToken } };
  const res = makeRes();
  const next = makeNext();

  await adminAuthRequired(req, res, next);

  assert.equal(res.code, 401);
  assert.equal(next.calls.length, 0);
  assert.equal(findOneCalls.length, 0);
});

test('authRequired rejects a token missing uid (e.g. an admin token) with 401, next not called, no DB lookup', async () => {
  const adminToken = signAdminToken('admin-1');
  const req = { headers: { authorization: 'Bearer ' + adminToken } };
  const res = makeRes();
  const next = makeNext();

  await authRequired(req, res, next);

  assert.equal(res.code, 401);
  assert.equal(next.calls.length, 0);
  assert.equal(findOneCalls.length, 0);
});

test('authRequired rejects a suspended user with 403 and does not call next', async () => {
  findOneImpl = (table, where) => {
    assert.equal(table, 'users');
    assert.equal(where.id, 'user-123');
    return { id: 'user-123', email: 'user@example.com', suspended: true };
  };
  const token = signToken('user-123');
  const req = { headers: { authorization: 'Bearer ' + token } };
  const res = makeRes();
  const next = makeNext();

  await authRequired(req, res, next);

  assert.equal(res.code, 403);
  assert.deepEqual(res.body, { error: 'This account has been suspended' });
  assert.equal(next.calls.length, 0);
});
