const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const jwt = require('jsonwebtoken');

// Set before requiring the module under test — it now throws at require
// time if JWT_SECRET is missing (that's exactly what the first test below
// verifies from a clean process).
process.env.JWT_SECRET = 'test-only-secret-do-not-use-in-prod';

const { signToken, JWT_SECRET } = require('./auth');

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
