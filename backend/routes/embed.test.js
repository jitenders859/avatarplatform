/**
 * Regression tests for the S1 security fixes (see improvement-prompts.md):
 *
 *   1. /embed/:publicId/config never returns the server-side GEMINI_API_KEY
 *      — with only the server key set the response is text-only (apiKey null,
 *      voiceEnabled false); with a distinct PUBLIC_GEMINI_API_KEY the config
 *      returns exactly that key.
 *   2. POST /embed/:publicId/log refuses user turns (402 + limitReached,
 *      nothing persisted) once the owner's monthly message quota is full,
 *      instead of blindly draining it.
 *
 * The router boots lazily and no DB connections are made during these tests:
 * `db`, `usage`, the embed/vector services, and storage are all stubbed
 * through the require cache before routes/embed.js is first required (same
 * pattern as plans.test.js — no test-framework dependency, no DATABASE_URL).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

// auth.js (via routes/projects.js) throws at require time without JWT_SECRET.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-do-not-use-in-prod';

const SERVER_KEY = 'server-secret-key-ai123';
const PUBLIC_KEY = 'public-browser-key-ai456';
const SERVER_ONLY_PORT = 4080;
const BOTH_KEYS_PORT = 4081;

const PROJECT = Object.freeze({
  id: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  publicId: 'test-public-id',
  name: 'Test Bot',
  characterId: 'character_1',
  systemPrompt: 'You are a test bot.',
  voice: 'Puck',
  welcomeMessage: 'Hello!',
  capabilityTier: 'basic',
  webhookUrl: null,
  webhookSecret: null,
});

// ── Route-module dependency stubs ───────────────────────────────────────
let dbInsertCalls = [];
let checkLimitCalls = [];
let checkLimitResult = { ok: true };

// Captured supertest agents — bound up here so case A's `limit-below` test
// can POST against the server-only instance even after case B's env changed.
let serverOnlyAgent = null;

const stubFile = (rel, exports) => {
  // require.resolve handles both relative specs (relative to this file) and
  // bare package specs (node_modules lookup) without any path joining.
  const resolved = require.resolve(rel);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
};

// routes/embed.js destructures { checkLimit, userPlanId } at require time, so
// a forwarding wrapper keeps runtime mutation of checkLimitResult visible.
stubFile('../services/usage', {
  userPlanId: async () => 'free',
  getUsageSnapshot: async () => ({ counters: {}, limits: {} }),
  checkLimit: async (...args) => { checkLimitCalls.push(args); return checkLimitResult; },
  trackMessage: async () => {},
  trackEmbeddingChars: async () => {},
});
stubFile('../db', {
  findOne: async (table) => (table === 'projects' ? { ...PROJECT } : null),
  findAll: async () => [],
  insert: async (table, row) => { dbInsertCalls.push({ table, row }); return row; },
  insertMany: async () => [],
  update: async () => null,
  remove: async () => 0,
  query: async () => [],
  queryOne: async () => null,
  pool: { end: async () => {} },
});
stubFile('../services/storage', {
  createSignedUploadUrl: async () => ({ signedUrl: '' }),
  objectExists: async () => false,
  uploadBuffer: async () => '',
  downloadBuffer: async () => Buffer.from(''),
  getSignedDownloadUrl: async () => 'https://storage.example/signed',
  removeObject: async () => {},
  removePrefix: async () => {},
});
stubFile('../services/embed', { embedOne: async () => [], embedMany: async () => [] });
stubFile('../services/vector', { searchProject: async () => [], searchFigures: async () => [] });
stubFile('../services/figures', { resolveFigures: async () => [] });
// The two AI libraries are only constructed inside request handlers the
// tests never reach — empty stubs avoid loading them at require time.
stubFile('@google/generative-ai', { GoogleGenerativeAI: class {} });
stubFile('@supabase/supabase-js', { createClient: () => ({}) });

// ── Case A: server-only deployment (PUBLIC_GEMINI_API_KEY unset) ────────
test('server-key-only config never leaks GEMINI_API_KEY', async (t) => {
  process.env.GEMINI_API_KEY = SERVER_KEY;
  delete process.env.PUBLIC_GEMINI_API_KEY;
  delete require.cache[require.resolve('./embed')];

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/embed', require('./embed'));

  const supertest = require('supertest');
  serverOnlyAgent = supertest(app);

  await t.test('config omits apiKey and flags text-only mode', async () => {
    const res = await serverOnlyAgent.get('/embed/test-public-id/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.apiKey, null, 'server key must never appear in /config');
    assert.equal(res.body.voiceEnabled, false);
    assert.equal(res.body.limitReached, false);
    assert.notEqual(res.body.limitMessage, undefined);
    assert.equal(res.body.handoffEnabled, false, 'free-plan project must not expose handoff');
  });

  await t.test('log below the quota records the turn and bumps usage', async () => {
    dbInsertCalls = [];
    checkLimitCalls = [];
    checkLimitResult = { ok: true };

    const res = await serverOnlyAgent
      .post('/embed/test-public-id/log')
      .send({ role: 'user', text: 'hello there' });

    assert.equal(res.status, 200);
    assert.ok(res.body.sessionId, 'new session id created');
    assert.deepEqual(checkLimitCalls.map(c => c[1]), ['message'], 'quota checked for user turns');
    assert.ok(dbInsertCalls.some(c => c.table === 'sessions'));
    assert.ok(dbInsertCalls.some(c => c.table === 'messages' && c.row.role === 'user'));
  });

  await t.test('200 posts to /log for a quota-full owner stop with limitReached, nothing persisted', async () => {
    checkLimitResult = { ok: false, reason: 'Plan monthly message limit reached (100 / 100). Upgrade to add more.' };

    let statuses = [];
    for (let i = 0; i < 200; i++) {
      dbInsertCalls = [];
      checkLimitCalls = [];
      const res = await serverOnlyAgent
        .post('/embed/test-public-id/log')
        .send({ role: 'user', text: `spam ${i}` });

      statuses.push(res.status);
      assert.equal(res.status, 402, `post #${i} must be refused`);
      assert.equal(res.body.limitReached, true);
      assert.match(res.body.limitMessage, /limit reached/i);
      assert.equal(dbInsertCalls.length, 0, `post #${i} must persist nothing`);
    }
    assert.equal(statuses.filter(s => s === 402).length, 200, 'all 200 posts refused');
    assert.equal(checkLimitCalls.length, 1, 'quota checked exactly once per refused post');
  });

  await t.test('assistant-role logs are not quota-gated', async () => {
    dbInsertCalls = [];
    checkLimitCalls = [];
    const res = await serverOnlyAgent
      .post('/embed/test-public-id/log')
      .send({ role: 'assistant', text: 'bot reply' });
    assert.equal(res.status, 200);
    assert.equal(checkLimitCalls.length, 0);
    assert.ok(dbInsertCalls.some(c => c.table === 'messages' && c.row.role === 'assistant'));
  });
});

// ── Case B: PUBLIC_GEMINI_API_KEY set (distinct from the server key) ────
test('distinct public key is returned verbatim', async (t) => {
  checkLimitResult = { ok: true };
  process.env.GEMINI_API_KEY = SERVER_KEY;
  process.env.PUBLIC_GEMINI_API_KEY = PUBLIC_KEY;
  delete require.cache[require.resolve('./embed')];

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/embed', require('./embed'));

  const supertest = require('supertest');
  const agent = supertest(app);

  await t.test('config returns the public key and enables voice', async () => {
    const res = await agent.get('/embed/test-public-id/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.apiKey, PUBLIC_KEY, 'public key returned');
    assert.equal(res.body.voiceEnabled, true);
    assert.notEqual(res.body.apiKey, SERVER_KEY, 'server key never returned');
  });

  await t.test('config above quota withholds even the public key', async () => {
    checkLimitResult = { ok: false, reason: 'Plan monthly message limit reached (100 / 100). Upgrade to add more.' };
    const res = await agent.get('/embed/test-public-id/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.apiKey, null);
    assert.equal(res.body.voiceEnabled, false);
    assert.equal(res.body.limitReached, true);
    checkLimitResult = { ok: true };
  });
});

// ── Case C: PUBLIC_GEMINI_API_KEY === GEMINI_API_KEY (misconfiguration) ─
test('public key equal to the server key is treated as unset', async (t) => {
  checkLimitResult = { ok: true };
  process.env.GEMINI_API_KEY = SERVER_KEY;
  process.env.PUBLIC_GEMINI_API_KEY = SERVER_KEY;
  delete require.cache[require.resolve('./embed')];

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/embed', require('./embed'));

  const res = await require('supertest')(app).get('/embed/test-public-id/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.apiKey, null, 'equal keys must not ship the server key to browsers');
  assert.equal(res.body.voiceEnabled, false);
});

// ── Case D: owner-customized widgetMessages (Prompt F4 item 4) ──────────
test('widgetMessages overrides the default limit-reached copy and exposes an input placeholder', async (t) => {
  checkLimitResult = { ok: true };
  process.env.GEMINI_API_KEY = SERVER_KEY;
  delete process.env.PUBLIC_GEMINI_API_KEY;
  delete require.cache[require.resolve('./embed')];

  // A distinct publicId, not just a distinct db stub — routes/embed.js
  // caches project lookups in the shared, module-level projectCache (see
  // cache.js) for 60s, so reusing 'test-public-id' here would silently
  // serve the stale PROJECT object cached by the earlier cases above.
  const CUSTOM_PROJECT = {
    ...PROJECT,
    publicId: 'test-public-id-custom-msgs',
    widgetMessages: { inputPlaceholder: 'Ask away…', limitReachedMessage: "We're out of chat credits this month — email us!" },
  };
  const resolved = require.resolve('../db');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, children: [], paths: [],
    exports: {
      findOne: async (table) => (table === 'projects' ? { ...CUSTOM_PROJECT } : null),
      findAll: async () => [], insert: async (t, r) => r, insertMany: async () => [],
      update: async () => null, remove: async () => 0, query: async () => [], queryOne: async () => null,
      pool: { end: async () => {} },
    },
  };

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/embed', require('./embed'));
  const agent = require('supertest')(app);

  await t.test('config exposes the custom input placeholder', async () => {
    const res = await agent.get('/embed/test-public-id-custom-msgs/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.widgetMessages.inputPlaceholder, 'Ask away…');
  });

  await t.test('config uses the custom message once over quota', async () => {
    checkLimitResult = { ok: false, reason: 'Plan monthly message limit reached (100 / 100). Upgrade to add more.' };
    const res = await agent.get('/embed/test-public-id-custom-msgs/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.limitMessage, "We're out of chat credits this month — email us!");
  });

  await t.test('/log uses the same custom message', async () => {
    const res = await agent.post('/embed/test-public-id-custom-msgs/log').send({ role: 'user', text: 'hi' });
    assert.equal(res.status, 402);
    assert.equal(res.body.limitMessage, "We're out of chat credits this month — email us!");
    checkLimitResult = { ok: true };
  });
});

// ── Case E: an active handoff pauses /ask instead of calling Gemini ─────
test('/ask short-circuits without calling Gemini when the session has an active handoff', async () => {
  process.env.GEMINI_API_KEY = SERVER_KEY;
  delete process.env.PUBLIC_GEMINI_API_KEY;
  delete require.cache[require.resolve('./embed')];

  let geminiConstructed = false;
  stubFile('@google/generative-ai', {
    GoogleGenerativeAI: class { constructor() { geminiConstructed = true; } },
  });
  stubFile('../db', {
    findOne: async (table, filter) => {
      if (table === 'projects') return { ...PROJECT };
      if (table === 'sessions' && filter.id === 'handed-off-session') return { id: 'handed-off-session', handoffStatus: 'active' };
      return null;
    },
    findAll: async () => [],
    insert: async (table, row) => row,
    insertMany: async () => [],
    update: async () => null,
    remove: async () => 0,
    query: async () => [],
    queryOne: async () => null,
    pool: { end: async () => {} },
  });

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/embed', require('./embed'));

  const res = await require('supertest')(app)
    .post('/embed/test-public-id/ask')
    .send({ question: 'are you there?', sessionId: 'handed-off-session' });

  assert.equal(res.status, 200);
  assert.equal(res.body.answer, "You're currently connected with a team member — please continue the conversation here.");
  assert.equal(res.body.sessionId, 'handed-off-session');
  assert.equal(geminiConstructed, false, 'Gemini must not be called once a session is handed off');
});

// ── Case F: an active handoff pauses /study instead of calling Gemini ───
test('/study short-circuits without calling Gemini when the session has an active handoff', async () => {
  process.env.GEMINI_API_KEY = SERVER_KEY;
  delete process.env.PUBLIC_GEMINI_API_KEY;
  delete require.cache[require.resolve('./embed')];

  // Distinct publicId (not just a distinct db stub) — routes/embed.js caches
  // project lookups in the shared, module-level projectCache (see cache.js)
  // for 60s, so reusing 'test-public-id' here would silently serve the stale
  // PROJECT object cached by the earlier cases above. Also needs a non-basic
  // capabilityTier since /study 403s 'basic' projects before reaching the
  // handoff check.
  const STUDY_PROJECT = { ...PROJECT, publicId: 'test-public-id-study', capabilityTier: 'medium' };

  let geminiConstructed = false;
  stubFile('@google/generative-ai', {
    GoogleGenerativeAI: class { constructor() { geminiConstructed = true; } },
  });
  stubFile('../db', {
    findOne: async (table, filter) => {
      if (table === 'projects') return { ...STUDY_PROJECT };
      if (table === 'sessions' && filter.id === 'handed-off-session-study') return { id: 'handed-off-session-study', handoffStatus: 'active' };
      return null;
    },
    findAll: async () => [],
    insert: async (table, row) => row,
    insertMany: async () => [],
    update: async () => null,
    remove: async () => 0,
    query: async () => [],
    queryOne: async () => null,
    pool: { end: async () => {} },
  });

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/embed', require('./embed'));

  const res = await require('supertest')(app)
    .post('/embed/test-public-id-study/study')
    .send({ message: 'are you there?', sessionId: 'handed-off-session-study' });

  assert.equal(res.status, 200);
  assert.equal(res.body.answer, "You're currently connected with a team member — please continue the conversation here.");
  assert.equal(res.body.sessionId, 'handed-off-session-study');
  assert.deepEqual(res.body.toolCalls, []);
  assert.deepEqual(res.body.sources, []);
  assert.deepEqual(res.body.figures, []);
  assert.equal(geminiConstructed, false, 'Gemini must not be called once a session is handed off');
});

test.after(() => {
  delete process.env.PUBLIC_GEMINI_API_KEY;
});
