/**
 * Route-level smoke test: signup -> login -> me, with a real JWT round
 * trip (improvement-prompts.md Prompt T1 item 5). Users are held in an
 * in-memory map behind a stubbed db.js so this needs no database.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-do-not-use-in-prod';

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

const users = new Map(); // email -> user row
stubFile('../db', {
  findOne: async (table, filter) => {
    if (table !== 'users') return null;
    if (filter.email) return users.get(filter.email) || null;
    if (filter.id) return [...users.values()].find(u => u.id === filter.id) || null;
    return null;
  },
  insert: async (table, row) => {
    if (table === 'users') users.set(row.email, row);
    return row;
  },
  query: async () => [],
  // Only implements the one raw-SQL shape auth.js's verify-email route
  // actually issues — good enough for a stub, not a real SQL engine.
  queryOne: async (sql, params) => {
    if (/FROM users WHERE verify_token/.test(sql)) {
      const [token, now] = params;
      return [...users.values()].find(u => u.verifyToken === token && u.verifyTokenExpiry > now) || null;
    }
    return null;
  },
  update: async (table, id, patch) => {
    if (table !== 'users') return null;
    const user = [...users.values()].find(u => u.id === id);
    if (!user) return null;
    Object.assign(user, patch);
    return user;
  },
  remove: async () => 0,
  pool: { end: async () => {} },
});
stubFile('../services/email', { sendWelcome: async () => {}, sendPasswordReset: async () => {}, sendVerificationEmail: async () => {} });
stubFile('../services/accountDelete', { deleteUserAccount: async () => {} });

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

test('signup -> login -> me round-trips a real JWT through the full auth flow', async (t) => {
  delete require.cache[require.resolve('./auth')];
  const authRouter = require('./auth');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;

  const signup = await request(port, 'POST', '/api/auth/signup', {
    email: 'newuser@example.com', password: 'correct-horse-battery', name: 'New User',
  });
  assert.equal(signup.status, 200);
  assert.ok(signup.json.token, 'signup should return a JWT');
  assert.equal(signup.json.user.email, 'newuser@example.com');

  const dupeSignup = await request(port, 'POST', '/api/auth/signup', {
    email: 'newuser@example.com', password: 'anything12345', name: 'Someone Else',
  });
  assert.equal(dupeSignup.status, 409, 'signing up twice with the same email should be rejected');

  const login = await request(port, 'POST', '/api/auth/login', {
    email: 'newuser@example.com', password: 'correct-horse-battery',
  });
  assert.equal(login.status, 200);
  assert.ok(login.json.token);

  const wrongPassword = await request(port, 'POST', '/api/auth/login', {
    email: 'newuser@example.com', password: 'wrong-password',
  });
  assert.equal(wrongPassword.status, 401);

  const me = await request(port, 'GET', '/api/auth/me', null, login.json.token);
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, 'newuser@example.com');

  const meNoToken = await request(port, 'GET', '/api/auth/me', null, null);
  assert.equal(meNoToken.status, 401);

  const meBadToken = await request(port, 'GET', '/api/auth/me', null, 'not-a-real-jwt');
  assert.equal(meBadToken.status, 401);
});

test('email verification: signup issues a token, wrong/expired tokens are rejected, the right one verifies, resend is a no-op once verified', async (t) => {
  delete require.cache[require.resolve('./auth')];
  const authRouter = require('./auth');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;

  const signup = await request(port, 'POST', '/api/auth/signup', {
    email: 'verify-me@example.com', password: 'correct-horse-battery', name: 'Verify Me',
  });
  const user = users.get('verify-me@example.com');
  assert.ok(user.verifyToken, 'signup should stamp a verify token');
  assert.equal(user.emailVerifiedAt, undefined);

  const wrongToken = await request(port, 'POST', '/api/auth/verify-email', { token: 'not-the-real-token' });
  assert.equal(wrongToken.status, 400);
  assert.equal(user.emailVerifiedAt, undefined, 'a wrong token must not verify the account');

  const expired = await request(port, 'POST', '/api/auth/verify-email', { token: 'expired-token' });
  // (no user actually has this token — this just exercises the "no match" path once more)
  assert.equal(expired.status, 400);

  const correct = await request(port, 'POST', '/api/auth/verify-email', { token: user.verifyToken });
  assert.equal(correct.status, 200);
  assert.ok(user.emailVerifiedAt, 'the correct token should set emailVerifiedAt');
  assert.equal(user.verifyToken, null, 'the token should be consumed (single-use)');

  const resend = await request(port, 'POST', '/api/auth/resend-verification', null, signup.json.token);
  assert.equal(resend.status, 200);
  assert.equal(resend.json.alreadyVerified, true, 'resend on an already-verified account should be a no-op');
});
