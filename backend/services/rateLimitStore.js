/**
 * Shared rate-limit store for express-rate-limit.
 *
 * WHY THIS EXISTS
 * ---------------
 * All limiters in this app used to run on express-rate-limit's in-memory
 * MemoryStore. That's per-process state, which breaks in two places:
 *   1. Vercel serverless: every function invocation gets a fresh store
 *      (and warm containers are randomly shared), so limits reset
 *      constantly — the limiters were effectively disabled in production,
 *      most critically on the anonymous, Gemini-paying /embed surface.
 *   2. Multi-instance: N horizontally-scaled Node instances each enforce
 *      their own copy, multiplying every limit by N.
 *
 * This module returns a Redis-backed store when one is configured and lets
 * express-rate-limit fall back to MemoryStore otherwise, with a loud
 * boot-time warning so nobody ships the disabled state unknowingly.
 *
 * CONFIGURATION (first match wins)
 * --------------------------------
 *   1. Upstash via REST (recommended for Vercel — pure HTTP, no TCP state
 *      to lose between serverless invocations):
 *        UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *      (UPSTASH_REDIS_URL / UPSTASH_REDIS_TOKEN are accepted as aliases.)
 *   2. Any Redis Redis over TCP via node-redis:
 *        REDIS_URL=redis://host:port   (rediss:// for TLS, e.g. Upstash TCP)
 *   3. Neither set → null is returned, the limiters keep the default
 *      MemoryStore, and a warning is logged once per process.
 *
 * FAIL-OPEN
 * ---------
 * Redis errors are thrown from the store; express-rate-limit's default
 * `passOnStoreError: true` then lets the request through un-limited and
 * logs the error. Rate limiting degrades to "off" instead of every request
 * 500-ing when Redis is down.
 */
const logger = require('../logger').child({ module: 'rate-limit-store' });
const { ipKeyGenerator } = require('express-rate-limit');

let sharedClient = undefined; // undefined = not yet resolved, null = unconfigured
let fallbackWarned = false;

function createUpstashClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_TOKEN;
  if (!url || !token) return null;
  // Lazy require so a deployment without the package still boots (it logs
  // the fallback warning instead of crashing at require time).
  const { Redis } = require('@upstash/redis');
  const client = new Redis({ url, token });
  // Normalize to one small command surface (Upstash uses snake_case methods).
  return {
    kind: 'upstash-rest',
    incr: k => client.incr(k),
    decr: k => client.decr(k),
    del: k => client.del(k),
    pexpire: (k, ms) => client.pexpire(k, ms),
  };
}

function createNodeRedisClient() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  // Lazy require — same rationale as above.
  const { createClient } = require('redis');
  const client = createClient({
    url,
    socket: {
      connectTimeout: 5000,
      // Node-redis's default retry backs off forever; on Vercel a container
      // can outlive its TCP connection, so retry promptly and indefinitely —
      // a failed command just throws and express-rate-limit fails open.
      reconnectStrategy: retries => Math.min(retries * 100, 3000),
    },
    // Commands fail fast instead of queueing while disconnected —
    // a burst of queued commands would hammer Redis on reconnect.
    disableOfflineQueue: true,
  });
  client.on('error', err => logger.warn({ err: err.message }, 'rate-limit redis client error'));

  let connecting = null;
  async function ensureConnected() {
    if (client.isReady) return;
    if (!connecting) {
      connecting = client.connect().finally(() => { connecting = null; });
    }
    await connecting;
  }
  return {
    kind: 'redis-tcp',
    incr: async k => { await ensureConnected(); return client.incr(k); },
    decr: async k => { await ensureConnected(); return client.decr(k); },
    del: async k => { await ensureConnected(); return client.del(k); },
    pexpire: async (k, ms) => { await ensureConnected(); return client.pExpire(k, ms); },
  };
}

function getSharedClient() {
  if (sharedClient !== undefined) return sharedClient;
  try {
    sharedClient = createUpstashClient() || createNodeRedisClient() || null;
  } catch (e) {
    logger.error({ err: e.message }, 'rate-limit store configured but failed to initialize — using in-memory fallback');
    sharedClient = null;
  }
  if (sharedClient) {
    logger.info({ kind: sharedClient.kind }, 'shared rate-limit store ready');
  } else if (!fallbackWarned) {
    fallbackWarned = true;
    logger.warn(
      'NO SHARED RATE-LIMIT STORE — limiters run in-memory only. On Vercel/multi-instance deploys the rate limits are effectively DISABLED (each invocation/instance gets a fresh store). Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (recommended) or REDIS_URL to enable shared limiting.'
    );
  }
  return sharedClient;
}

/**
 * express-rate-limit v7+ Store implementation over a normalized client.
 * Sliding-window-ish by design: INCR on hit, PEXPIRE on first hit. A
 * blocked client re-hitting does refresh the TTL, so an abuser stays
 * blocked for a full quiet window after they stop — acceptable here.
 */
class RedisRateLimitStore {
  constructor(client, prefix) {
    this.client = client;
    this.prefix = prefix;
    this.windowMs = 60_000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  key(key) {
    return `ratelimit:${this.prefix}:${key}`;
  }

  async increment(key) {
    const k = this.key(key);
    const hits = await this.client.incr(k);
    if (hits === 1) await this.client.pexpire(k, this.windowMs);
    return { totalHits: hits, resetTime: new Date(Date.now() + this.windowMs) };
  }

  async decrement(key) {
    await this.client.decr(this.key(key));
  }

  async resetKey(key) {
    await this.client.del(this.key(key));
  }

  // Keys expire on their own; scanning the keyspace to purge everything
  // would be a DoS on Redis and isn't needed for correctness.
  resetAll() {}
}

/**
 * Get a Store for one limiter instance. All limiters share one Redis client
 * but get distinct key prefixes so their counters never collide.
 * Returns null when no store is configured — the caller passes
 * `store: null` which express-rate-limit treats as "use the default
 * MemoryStore".
 */
function getRateLimitStore(prefix) {
  const client = getSharedClient();
  if (!client) return null;
  return new RedisRateLimitStore(client, prefix);
}

/**
 * Read-only accessor for the admin health tab (Phase 4 —
 * docs/admin-panel-implementation-plan.md "Phase 4: System health tab").
 * Resolves the shared client the same way every limiter does (so it
 * reports exactly what's actually backing rate limiting, not just whether
 * env vars look present) and collapses it to 'redis' | 'memory'. Does not
 * create a new client or open a new connection — reuses getSharedClient()'s
 * module-level singleton.
 */
function getBackendType() {
  return getSharedClient() ? 'redis' : 'memory';
}

/**
 * keyGenerator for limiters mounted at /embed (mount-level middleware —
 * req.params isn't populated yet, so publicId comes out of the path).
 * Inside app.use('/embed', limiter, ...) req.path is mount-relative:
 * "/:publicId/..." — split('/')[1] is the publicId. Falls back to a
 * placeholder segment for path shapes without one (bare /embed).
 * ipKeyGenerator normalizes IPv6 clients to a /56 prefix so they can't
 * rotate low-order bits to sidestep the limit.
 */
function embedKeyGenerator(req) {
  const ip = ipKeyGenerator(req.ip || 'unknown');
  const path = (req.path || req.url || '').split('?')[0];
  const publicId = path.split('/')[1] || '_';
  return `${ip}:embed:${publicId}`;
}

// Test hook — resets module-level singletons between test cases.
function _resetForTests() {
  sharedClient = undefined;
  fallbackWarned = false;
}

module.exports = { getRateLimitStore, getSharedClient, getBackendType, embedKeyGenerator, RedisRateLimitStore, _resetForTests };
