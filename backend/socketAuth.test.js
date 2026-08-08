const { test } = require('node:test');
const assert = require('node:assert/strict');

// Set before requiring anything that pulls in middleware/auth.js, which now
// throws at require-time if JWT_SECRET is unset (see auth.test.js for that
// behavior specifically).
process.env.JWT_SECRET = 'test-only-secret-for-socket-auth-tests';

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./middleware/auth');
const { resolveUserRoom } = require('./socketAuth');

test('resolveUserRoom joins the room matching the token\'s own uid', () => {
  const token = jwt.sign({ uid: 'user-A' }, JWT_SECRET, { expiresIn: '1h' });
  assert.equal(resolveUserRoom(token), 'user:user-A');
});

test('a client authenticated as tenant A can never resolve tenant B\'s room', () => {
  // Regression test for the original bug: the server used to do
  // `socket.on('join', userId => socket.join('user:' + userId))`, so any
  // connected client could pass ANY user's id directly and receive that
  // user's private file:progress events. resolveUserRoom takes only a JWT —
  // there is no argument through which a caller can name a room that
  // doesn't match their own verified identity.
  const tokenForUserA = jwt.sign({ uid: 'user-A' }, JWT_SECRET, { expiresIn: '1h' });
  const room = resolveUserRoom(tokenForUserA);
  assert.equal(room, 'user:user-A');
  assert.notEqual(room, 'user:user-B');
});

test('resolveUserRoom rejects a token signed with the wrong secret (forged token)', () => {
  const forged = jwt.sign({ uid: 'victim-user' }, 'attacker-guessed-secret', { expiresIn: '1h' });
  assert.equal(resolveUserRoom(forged), null);
});

test('resolveUserRoom rejects an expired token', () => {
  const expired = jwt.sign({ uid: 'user-A' }, JWT_SECRET, { expiresIn: -10 });
  assert.equal(resolveUserRoom(expired), null);
});

test('resolveUserRoom rejects missing, empty, or non-string input', () => {
  assert.equal(resolveUserRoom(), null);
  assert.equal(resolveUserRoom(''), null);
  assert.equal(resolveUserRoom(null), null);
  assert.equal(resolveUserRoom(12345), null);
});

test('resolveUserRoom rejects a validly-signed token with no uid claim', () => {
  const noUid = jwt.sign({ foo: 'bar' }, JWT_SECRET, { expiresIn: '1h' });
  assert.equal(resolveUserRoom(noUid), null);
});
