/**
 * Tests for backend/services/rateLimitStore.js — the shared Redis-backed
 * store wired into every express-rate-limit instance (server.js + the
 * AI-cost limiters in routes/embed.js).
 *
 * No live Redis needed: store selection is driven by env, and the store
 * itself is exercised against a fake client exposing the same four-command
 * surface (incr/decr/del/pexpire) the module normalizes both @upstash/redis
 * and node-redis to.
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  getRateLimitStore,
  getSharedClient,
  embedKeyGenerator,
  RedisRateLimitStore,
  _resetForTests,
} = require('./rateLimitStore');

const ENV_KEYS = [
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'UPSTASH_REDIS_URL', 'UPSTASH_REDIS_TOKEN',
  'REDIS_URL',
];
const savedEnv = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  _resetForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _resetForTests();
});

// ── Store selection by env ──────────────────────────────────────────────
test('returns null (MemoryStore fallback) when no store is configured', () => {
  assert.equal(getRateLimitStore('api'), null);
  assert.equal(getSharedClient(), null);
});

test('prefers Upstash REST when UPSTASH_REDIS_REST_URL/+TOKEN are set', () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://unit-test.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const client = getSharedClient();
  assert.equal(client.kind, 'upstash-rest');
  assert.ok(getRateLimitStore('api') instanceof RedisRateLimitStore);
});

test('accepts the UPSTASH_REDIS_URL/+TOKEN alias names', () => {
  process.env.UPSTASH_REDIS_URL = 'https://unit-test.upstash.io';
  process.env.UPSTASH_REDIS_TOKEN = 'test-token';
  assert.equal(getSharedClient().kind, 'upstash-rest');
});

test('falls back to TCP node-redis when only REDIS_URL is set', () => {
  process.env.REDIS_URL = 'redis://localhost:6379';
  const client = getSharedClient();
  assert.equal(client.kind, 'redis-tcp');
});

test('the same client instance is shared across limiters', () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://unit-test.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const a = getRateLimitStore('auth');
  const b = getRateLimitStore('embed');
  assert.notEqual(a, b, 'distinct store wrappers');
  assert.equal(a.client, b.client, 'one shared redis client');
  assert.notEqual(a.prefix, b.prefix, 'distinct key namespaces');
});

// ── Store behavior against a fake client ────────────────────────────────
function makeFake() {
  const calls = { incr: [], decr: [], del: [], pexpire: [] };
  const counters = new Map();
  return {
    calls,
    incr: async k => { calls.incr.push(k); const n = (counters.get(k) || 0) + 1; counters.set(k, n); return n; },
    decr: async k => { calls.decr.push(k); counters.set(k, (counters.get(k) || 0) - 1); },
    del: async k => { calls.del.push(k); counters.delete(k); },
    pexpire: async (k, ms) => { calls.pexpire.push([k, ms]); return 1; },
  };
}

test('increment counts hits and sets expiry only on the first hit', async () => {
  const fake = makeFake();
  const store = new RedisRateLimitStore(fake, 'embed');
  store.init({ windowMs: 60_000 });

  const first = await store.increment('1.2.3.4:embed:pub1');
  assert.equal(first.totalHits, 1);
  assert.ok(first.resetTime instanceof Date);
  assert.ok(first.resetTime.getTime() > Date.now());

  const second = await store.increment('1.2.3.4:embed:pub1');
  assert.equal(second.totalHits, 2);

  assert.deepEqual(fake.calls.incr, ['ratelimit:embed:1.2.3.4:embed:pub1', 'ratelimit:embed:1.2.3.4:embed:pub1']);
  assert.equal(fake.calls.pexpire.length, 1, 'PEXPIRE set once, on the first hit');
  assert.deepEqual(fake.calls.pexpire[0], ['ratelimit:embed:1.2.3.4:embed:pub1', 60_000]);
});

test('prefixed keys keep limiter namespaces apart', async () => {
  const fake = makeFake();
  const auth = new RedisRateLimitStore(fake, 'auth');
  const api = new RedisRateLimitStore(fake, 'api');
  auth.init({ windowMs: 1 }); api.init({ windowMs: 1 });

  await auth.increment('1.2.3.4');
  await api.increment('1.2.3.4');

  assert.equal((await auth.increment('1.2.3.4')).totalHits, 2, 'auth counter unaffected by api hits');
});

test('decrement and resetKey delegate with the prefixed key', async () => {
  const fake = makeFake();
  const store = new RedisRateLimitStore(fake, 'admin');
  await store.decrement('k1');
  await store.resetKey('k2');
  assert.deepEqual(fake.calls.decr, ['ratelimit:admin:k1']);
  assert.deepEqual(fake.calls.del, ['ratelimit:admin:k2']);
});

test('store errors propagate so express-rate-limit can fail open', async () => {
  const failing = { incr: async () => { throw new Error('redis down'); }, decr: async () => {}, del: async () => {}, pexpire: async () => {} };
  const store = new RedisRateLimitStore(failing, 'api');
  store.init({ windowMs: 1000 });
  await assert.rejects(() => store.increment('1.2.3.4'), /redis down/);
});

// ── embedKeyGenerator (IP + publicId from the path) ─────────────────────
test('embedKeyGenerator keys by IP + publicId extracted from the mount-relative path', () => {
  const key = embedKeyGenerator({ ip: '1.2.3.4', path: '/pub123/config' });
  assert.equal(key, '1.2.3.4:embed:pub123');
});

test('embedKeyGenerator strips query strings and falls back to req.url', () => {
  assert.equal(embedKeyGenerator({ ip: '1.2.3.4', path: '/pub123/ask?x=1' }), '1.2.3.4:embed:pub123');
  assert.equal(embedKeyGenerator({ ip: '1.2.3.4', url: '/pub9/log' }), '1.2.3.4:embed:pub9');
  assert.equal(embedKeyGenerator({ ip: '1.2.3.4', path: '/' }), '1.2.3.4:embed:_');
  assert.equal(embedKeyGenerator({}), 'unknown:embed:_');
});

test('embedKeyGenerator normalizes IPv6 clients to a /56 prefix', () => {
  const a = embedKeyGenerator({ ip: '2001:db8:85a3::8a2e:370:7334', path: '/p1/config' });
  const b = embedKeyGenerator({ ip: '2001:db8:85a3:0:ffff:ffff:ffff:ffff', path: '/p1/config' });
  assert.equal(a, b, 'rotating low-order IPv6 bits must not evade the limiter');
  assert.match(a, /\/56:embed:p1$/);
});

// ── Wired end-to-end: a limiter backed by the fake store actually blocks ─
test('an express-rate-limit instance using this store blocks after max hits', async () => {
  const express = require('express');
  const supertest = require('supertest');
  const { rateLimit } = require('express-rate-limit');

  const fake = makeFake();
  const store = new RedisRateLimitStore(fake, 'e2e');

  const app = express();
  app.use(rateLimit({ windowMs: 60_000, max: 3, standardHeaders: true, legacyHeaders: false, store }));
  app.get('/x', (_req, res) => res.json({ ok: true }));

  const agent = supertest(app);
  for (let i = 0; i < 3; i++) {
    assert.equal((await agent.get('/x')).status, 200, `hit #${i + 1} allowed`);
  }
  const blocked = await agent.get('/x');
  assert.equal(blocked.status, 429);
  assert.equal((await agent.get('/x')).status, 429, 'still blocked afterwards');
});
