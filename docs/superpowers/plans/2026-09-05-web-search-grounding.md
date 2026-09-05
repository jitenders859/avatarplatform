# Web Search Grounding (Phase 1: search_web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the avatar fall back to a live web search (via Serper.dev) when its knowledge base can't answer, on both chat surfaces (Gemini Live and the text-only `/ask` fallback), gated by a per-project toggle with plan-based quota.

**Architecture:** A new `backend/services/searchWeb.js` wraps the Serper.dev API behind a cache + quota + rate-limit stack reused from existing infra (`cache.js`, `rateLimitStore.js`, `usage.js`/`plans.js`). It's exposed two ways: a new `POST /embed/:publicId/search-web` route for a client-side Gemini Live tool (mirroring the existing `search_knowledge_base` tool pattern in `embed.html`/`lipsync-sdk.js`), and a direct server-side call from `answerQuestion.js` for the `/ask` text-only path (which has no tool-calling loop, so it uses a heuristic gate instead of model-driven tool choice). A new `project.webSearchEnabled` flag (default off, free-plan-blocked) controls both paths.

**Tech Stack:** Node.js/Express, `node-fetch`, Zod, `lru-cache`, `node:test`, Postgres (via the project's `db.js` camelCase/snake_case ORM shim), vanilla JS (widget).

**Full design context:** `docs/superpowers/specs/2026-09-05-web-search-grounding-design.md` — read it before starting; this plan implements it exactly. `search_youtube`, domain allow/deny lists, and billing-dashboard usage surfacing are explicitly out of scope for this plan (phase 2).

---

## File Structure

- **Create** `backend/services/searchWeb.js` — Serper.dev client, cache, quota-checked wrapper.
- **Create** `backend/services/searchWeb.test.js` — unit tests for the above.
- **Create** `supabase/migrations/2026-09-05_add_web_search.sql` — standalone dated ALTER statements for an existing DB.
- **Modify** `supabase/schema.sql` — add `web_search_enabled` to `projects`, `web_searches` to `usage` (fresh-install source of truth).
- **Modify** `backend/services/settings.js` — add `SERPER_API_KEY` to `OVERRIDABLE_KEYS`.
- **Modify** `.env.example` — document `SERPER_API_KEY`.
- **Modify** `backend/cache.js` — add `webSearchCache`.
- **Modify** `backend/services/usage.js` — add `trackWebSearch`, `webSearches` counter, `webSearch` quota case.
- **Modify** `backend/services/usage.test.js` — cover the new quota case.
- **Modify** `backend/plans.js` — add `monthlyWebSearches` per plan.
- **Modify** `backend/middleware/validate.js` — add `webSearchEnabled` to `patchProject`, add `schemas.searchWeb`.
- **Modify** `backend/routes/projects.js` — add default + PATCH-time plan gate.
- **Modify** `backend/routes/embed.js` — expose `webSearchEnabled` in `/config`, add `POST /:publicId/search-web` + its rate limiter.
- **Modify** `backend/services/answerQuestion.js` — heuristic web-search fallback for `/ask`.
- **Modify** `public/lipsync-sdk.js` — fire a new `onToolCall` event.
- **Modify** `public/embed.html` — add `searchWebTool()`, wire it into `tools:`, extend the system-prompt builder, wire `onToolCall`/`onTranscript` status text.
- **Modify** `public/project.html` — add the `f-websearch` toggle field with free-plan lock.

---

### Task 1: `SERPER_API_KEY` as an admin-overridable setting

**Files:**
- Modify: `backend/services/settings.js:18`
- Modify: `.env.example`

- [ ] **Step 1: Add the key to `OVERRIDABLE_KEYS`**

In `backend/services/settings.js`, change:
```js
const OVERRIDABLE_KEYS = ['GEMINI_API_KEY', 'PUBLIC_GEMINI_API_KEY', 'STUDY_MODEL'];
```
to:
```js
const OVERRIDABLE_KEYS = ['GEMINI_API_KEY', 'PUBLIC_GEMINI_API_KEY', 'STUDY_MODEL', 'SERPER_API_KEY'];
```
`listSettingsStatus()` and the admin settings route (`backend/routes/adminSettings.js`) already iterate this array generically — no other backend or admin-UI code change is needed for the key to appear in the admin settings panel.

- [ ] **Step 2: Document it in `.env.example`**

Add this block after the existing `QUIZ_MODEL`/`FLASHCARD_MODEL` lines (around line 50), before the next section:
```
# ── Web search grounding ──────────────────────────────────────────────────
# Serper.dev API key (https://serper.dev) — powers the search_web tool the
# avatar can call when its knowledge base doesn't have an answer. Only
# takes effect for projects with webSearchEnabled=true (see project
# settings). Settable here or via the admin settings panel (services/settings.js).
SERPER_API_KEY=
```

- [ ] **Step 3: Commit**

```bash
git add backend/services/settings.js .env.example
git commit -m "Add SERPER_API_KEY as an admin-overridable setting

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Web search result cache

**Files:**
- Modify: `backend/cache.js`

- [ ] **Step 1: Add the cache instance**

`backend/cache.js` currently reads:
```js
const { LRUCache } = require('lru-cache');

// Shared project config cache — keyed by publicId, 1 min TTL.
// Lives outside embed.js so projects.js can invalidate without a circular import.
const projectCache = new LRUCache({ max: 500, ttl: 60_000 });

function invalidateProjectCache(publicId) {
  if (publicId) projectCache.delete(publicId);
}

module.exports = { projectCache, invalidateProjectCache };
```
Change it to:
```js
const { LRUCache } = require('lru-cache');

// Shared project config cache — keyed by publicId, 1 min TTL.
// Lives outside embed.js so projects.js can invalidate without a circular import.
const projectCache = new LRUCache({ max: 500, ttl: 60_000 });

function invalidateProjectCache(publicId) {
  if (publicId) projectCache.delete(publicId);
}

// Web search results cache — keyed by "language:normalizedQuery" in
// services/searchWeb.js. Cuts provider cost on repeated questions within
// a session (or across sessions/tenants asking the same thing).
const webSearchCache = new LRUCache({ max: 1000, ttl: 10 * 60_000 });

module.exports = { projectCache, invalidateProjectCache, webSearchCache };
```

- [ ] **Step 2: Commit**

```bash
git add backend/cache.js
git commit -m "Add webSearchCache (10min TTL) for the upcoming search_web tool

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `searchWeb.js` service (TDD)

**Files:**
- Create: `backend/services/searchWeb.js`
- Create: `backend/services/searchWeb.test.js`

This is the core provider integration. Build it test-first since it's pure enough to unit test without a real network call (stub `global.fetch`... actually this codebase uses `node-fetch` as a required module, not global fetch — stub it via `require.cache`, same technique `usage.test.js` uses for `db.js`).

- [ ] **Step 1: Write the failing tests**

Create `backend/services/searchWeb.test.js`:
```js
/**
 * searchWeb() — query sanitization, empty-query short circuit, cache
 * hit/miss, and error shape on a failed provider call. Stubs node-fetch
 * and services/settings the same way usage.test.js stubs db.js: replace
 * the module's require.cache entry before requiring searchWeb fresh.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

function freshSearchWeb({ fetchImpl, apiKey = 'test-key' }) {
  delete require.cache[require.resolve('./searchWeb')];
  delete require.cache[require.resolve('node-fetch')];
  stubFile('node-fetch', fetchImpl);
  stubFile('./settings', { getSetting: async (key) => (key === 'SERPER_API_KEY' ? apiKey : '') });
  return require('./searchWeb');
}

test('searchWeb: empty/whitespace query short-circuits without calling fetch', async () => {
  let called = false;
  const { searchWeb } = freshSearchWeb({ fetchImpl: async () => { called = true; } });
  assert.deepEqual(await searchWeb('   '), []);
  assert.equal(called, false);
});

test('searchWeb: missing SERPER_API_KEY returns [] without throwing', async () => {
  const { searchWeb } = freshSearchWeb({ fetchImpl: async () => { throw new Error('should not be called'); }, apiKey: '' });
  assert.deepEqual(await searchWeb('latest node version'), []);
});

test('searchWeb: maps Serper organic results to {title,url,snippet,source}, capped at 5', async () => {
  const organic = Array.from({ length: 8 }, (_, i) => ({
    title: `Result ${i}`, link: `https://example${i}.com/page`, snippet: 'x'.repeat(300),
  }));
  const { searchWeb } = freshSearchWeb({
    fetchImpl: async () => ({ ok: true, json: async () => ({ organic }) }),
  });
  const results = await searchWeb('some query');
  assert.equal(results.length, 5);
  assert.equal(results[0].title, 'Result 0');
  assert.equal(results[0].url, 'https://example0.com/page');
  assert.equal(results[0].source, 'example0.com');
  assert.ok(results[0].snippet.length <= 220);
});

test('searchWeb: query is trimmed, newline-stripped, and length-capped before sending', async () => {
  let sentBody;
  const { searchWeb } = freshSearchWeb({
    fetchImpl: async (_url, opts) => { sentBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ organic: [] }) }; },
  });
  await searchWeb('  latest\nnode\nversion  ' + 'x'.repeat(400));
  assert.equal(sentBody.q.includes('\n'), false);
  assert.ok(sentBody.q.length <= 300);
});

test('searchWeb: non-ok provider response throws with status attached', async () => {
  const { searchWeb } = freshSearchWeb({
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
  });
  await assert.rejects(() => searchWeb('anything'), (err) => {
    assert.equal(err.status, 502);
    return true;
  });
});

test('searchWeb: identical query within TTL is served from cache (fetch called once)', async () => {
  let calls = 0;
  const { searchWeb } = freshSearchWeb({
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ organic: [{ title: 'A', link: 'https://a.com', snippet: 's' }] }) }; },
  });
  await searchWeb('same query', { language: 'en' });
  await searchWeb('Same Query', { language: 'en' }); // case-insensitive cache key
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail (module doesn't exist yet)**

Run: `node --test backend/services/searchWeb.test.js`
Expected: FAIL — `Cannot find module './searchWeb'`

- [ ] **Step 3: Write the implementation**

Create `backend/services/searchWeb.js`:
```js
/**
 * Serper.dev-backed web search — the search_web tool's backend. Serper is
 * a fixed, trusted host (not caller-supplied), so this uses plain
 * node-fetch rather than services/safeFetch.js (that wrapper's SSRF guard
 * is for owner/caller-supplied URLs like webhook actions or URL-source
 * ingestion — see services/tools.js#callProjectAction for that case).
 *
 * searchWebForProject() is the entry point both the /search-web route and
 * the /ask heuristic fallback (answerQuestion.js) call — it's the one
 * place quota is checked and tracked, so the two callers can't double up
 * or diverge.
 */
const fetch = require('node-fetch');
const settings = require('./settings');
const { webSearchCache } = require('../cache');
const { checkLimit, trackWebSearch } = require('./usage');
const logger = require('../logger').child({ module: 'search-web' });

async function searchWeb(query, { language = 'en' } = {}) {
  const q = String(query).trim().replace(/[\r\n]+/g, ' ').slice(0, 300);
  if (!q) return [];

  const cacheKey = `${language}:${q.toLowerCase()}`;
  const cached = webSearchCache.get(cacheKey);
  if (cached) return cached;

  const start = Date.now();
  const apiKey = await settings.getSetting('SERPER_API_KEY');
  if (!apiKey) {
    logger.warn('SERPER_API_KEY not configured — search_web will return no results');
    return [];
  }

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, hl: language, num: 5 }),
    timeout: 8000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Serper search failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  const results = (data.organic || []).slice(0, 5).map(r => ({
    title: r.title,
    url: r.link,
    snippet: (r.snippet || '').slice(0, 220),
    source: (() => { try { return new URL(r.link).hostname; } catch { return null; } })(),
  }));

  webSearchCache.set(cacheKey, results);
  logger.info({ query: q, resultCount: results.length, latencyMs: Date.now() - start }, 'web search');
  return results;
}

/** Quota-checked entry point shared by the /search-web route and the /ask fallback. */
async function searchWebForProject(project, query, { language } = {}) {
  const limitCheck = await checkLimit(project.userId, 'webSearch', 1);
  if (!limitCheck.ok) {
    const err = new Error(limitCheck.reason);
    err.status = 402;
    err.quotaExceeded = true;
    throw err;
  }
  const results = await searchWeb(query, { language });
  await trackWebSearch(project.userId).catch(() => {});
  return results;
}

module.exports = { searchWeb, searchWebForProject };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/services/searchWeb.test.js`
Expected: PASS (7 tests) — note `searchWebForProject` isn't unit-tested here since it needs `usage.js`'s DB-backed `checkLimit`/`trackWebSearch`, which Task 4 covers; it's exercised end-to-end in Task 9's manual verification instead.

- [ ] **Step 5: Commit**

```bash
git add backend/services/searchWeb.js backend/services/searchWeb.test.js
git commit -m "Add searchWeb service (Serper.dev client with cache)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Monthly quota — `usage.js`

**Files:**
- Modify: `backend/services/usage.js`
- Modify: `backend/services/usage.test.js`

- [ ] **Step 1: Write the failing test**

In `backend/services/usage.test.js`, find the `freshDb()` helper (it seeds `dbState.usage = { period: '2026-08', messages: 0, embeddingChars: 0 }`) and the `checkLimit` tests near it. Add `webSearches: 0` to the seeded usage object:
```js
usage: { period: '2026-08', messages: 0, embeddingChars: 0, webSearches: 0 },
```
Then add a new test near the existing `checkLimit` boundary tests, following the file's established pattern exactly: `reload()` internally creates and stubs a fresh `dbState` (a module-level variable set as a side effect of `freshDb()`, which `reload()` calls) — tests mutate that module-level `dbState` directly, they don't hold their own `db` reference. Place this next to the existing `'checkLimit: monthly message counter resets are period-scoped'` test:
```js
test('checkLimit: webSearch respects the plan\'s monthlyWebSearches limit', async () => {
  const { checkLimit } = reload();

  // Free plan's monthlyWebSearches is 0 (see plans.js) — any attempt fails.
  const atZero = await checkLimit(USER_ID, 'webSearch', 1);
  assert.equal(atZero.ok, false);

  // A plan with quota: seed a paid subscription and confirm boundary math.
  dbState.sub = { planId: 'starter' };
  const starterLimit = require('../plans').PLANS.find(p => p.id === 'starter').limits.monthlyWebSearches;
  dbState.usage.webSearches = starterLimit - 1;
  const underLimit = await checkLimit(USER_ID, 'webSearch', 1);
  assert.equal(underLimit.ok, true);

  dbState.usage.webSearches = starterLimit;
  const atLimit = await checkLimit(USER_ID, 'webSearch', 1);
  assert.equal(atLimit.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/services/usage.test.js`
Expected: FAIL — `checkLimit` has no `'webSearch'` case yet, `atZero.ok` will be `true` (switch falls through to the final `return { ok: true }`).

- [ ] **Step 3: Implement the quota case**

In `backend/services/usage.js`:

1. `trackMessage` mirror — add right after `trackMessage`:
```js
async function trackWebSearch(userId) {
  if (!userId) return;
  const period = periodKey();
  const id = `${userId}:${period}`;
  const now = Date.now();
  await db.query(
    `INSERT INTO usage (id, user_id, period, messages, embedding_chars, web_searches, created_at, updated_at)
     VALUES ($1, $2, $3, 0, 0, 1, $4, $4)
     ON CONFLICT (id) DO UPDATE SET web_searches = usage.web_searches + 1, updated_at = $4`,
    [id, userId, period, now]
  );
}
```

2. In `getUsageSnapshot`, add `webSearches` to the returned `counters`:
```js
counters: {
  projects:       Number(stats.projects)   || 0,
  files:          Number(stats.files)      || 0,
  storageMb,
  urlSources:     Number(stats.urlSources) || 0,
  messages,
  embeddingChars: usage.embeddingChars     || 0,
  webSearches:    usage.webSearches        || 0,
},
```

3. In `checkLimit`'s `switch`, add a case right after `embeddingChars`:
```js
case 'webSearch':
  if (c.webSearches + delta > l.monthlyWebSearches) return fail('monthly web search', l.monthlyWebSearches, c.webSearches);
  break;
```

4. Export `trackWebSearch` — the file currently ends with:
```js
module.exports = {
  userPlanId, getUsageSnapshot, trackMessage, trackEmbeddingChars, checkLimit,
  isAdminPlanOverrideActive, getUsageAcrossUsers,
};
```
Change to:
```js
module.exports = {
  userPlanId, getUsageSnapshot, trackMessage, trackEmbeddingChars, trackWebSearch, checkLimit,
  isAdminPlanOverrideActive, getUsageAcrossUsers,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/services/usage.test.js`
Expected: PASS — will still fail at this point because `plans.js` doesn't define `monthlyWebSearches` yet (`starterLimit` is `undefined`, so `underLimit`/`atLimit` math is `NaN`-based). Proceed to Task 5 before expecting a full pass; re-run after it.

- [ ] **Step 5: Commit**

```bash
git add backend/services/usage.js backend/services/usage.test.js
git commit -m "Add webSearch quota tracking to usage.js

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Plan limits — `plans.js`

**Files:**
- Modify: `backend/plans.js`

- [ ] **Step 1: Add `monthlyWebSearches` to each plan's `limits`**

In `backend/plans.js`, add one line to each of the four plans' `limits` objects (free/starter/pro/business), right after `urlSources`:

Free (`limits` block starting near line 22):
```js
limits: {
  projects: 3,
  maxFiles: 5,
  storageMb: 50,
  monthlyMessages: 100,
  monthlyEmbeddingChars: 100_000,
  urlSources: 3,
  monthlyWebSearches: 0,
},
```
Starter:
```js
limits: {
  projects: 3,
  maxFiles: 25,
  storageMb: 500,
  monthlyMessages: 2_000,
  monthlyEmbeddingChars: 2_000_000,
  urlSources: 25,
  monthlyWebSearches: 50,
},
```
Pro:
```js
limits: {
  projects: 10,
  maxFiles: 100,
  storageMb: 5_000,
  monthlyMessages: 10_000,
  monthlyEmbeddingChars: 10_000_000,
  urlSources: 200,
  monthlyWebSearches: 300,
},
```
Business:
```js
limits: {
  projects: 50,
  maxFiles: 500,
  storageMb: 50_000,
  monthlyMessages: 100_000,
  monthlyEmbeddingChars: 100_000_000,
  urlSources: 2_000,
  monthlyWebSearches: 1_500,
},
```

- [ ] **Step 2: Run the full usage test suite to verify Task 4's test now passes**

Run: `node --test backend/services/usage.test.js`
Expected: PASS (all tests, including the new `webSearch` quota test)

- [ ] **Step 3: Commit**

```bash
git add backend/plans.js
git commit -m "Add monthlyWebSearches limits per plan (free:0, starter:50, pro:300, business:1500)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Database schema — `web_search_enabled` + `web_searches`

**Files:**
- Modify: `supabase/schema.sql`
- Create: `supabase/migrations/2026-09-05_add_web_search.sql`

- [ ] **Step 1: Add the column to `schema.sql`'s `projects` table**

In `supabase/schema.sql`, find the `projects` table's `-- Webhook` section (right before `webhook_url`), and add the new column just above it, next to the other simple toggles:
```sql
  show_character_fullscreen BOOLEAN DEFAULT false,
  widget_offset_x          INTEGER DEFAULT 0,
  widget_offset_y          INTEGER DEFAULT 0,
  -- Web search grounding (see backend/services/searchWeb.js) — off by
  -- default, and blocked server-side on the free plan regardless of this
  -- value (see routes/projects.js PATCH and routes/embed.js /config).
  web_search_enabled       BOOLEAN DEFAULT false,
  -- Avatar placement
```
(i.e. insert the new field and its comment right after `widget_offset_y` and before the `-- Avatar placement` comment line — matches the existing grouping style.)

- [ ] **Step 2: Add the column to `schema.sql`'s `usage` table**

Find:
```sql
CREATE TABLE IF NOT EXISTS usage (
  id               TEXT   PRIMARY KEY,  -- format: userId:YYYY-MM
  user_id          UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period           TEXT   NOT NULL,     -- format: YYYY-MM
  messages         INTEGER DEFAULT 0,
  embedding_chars  BIGINT  DEFAULT 0,
  created_at       BIGINT  NOT NULL,
  updated_at       BIGINT,
  UNIQUE (user_id, period)
);
```
Change to:
```sql
CREATE TABLE IF NOT EXISTS usage (
  id               TEXT   PRIMARY KEY,  -- format: userId:YYYY-MM
  user_id          UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period           TEXT   NOT NULL,     -- format: YYYY-MM
  messages         INTEGER DEFAULT 0,
  embedding_chars  BIGINT  DEFAULT 0,
  web_searches     INTEGER DEFAULT 0,
  created_at       BIGINT  NOT NULL,
  updated_at       BIGINT,
  UNIQUE (user_id, period)
);
```

- [ ] **Step 3: Write the standalone migration file**

Create `supabase/migrations/2026-09-05_add_web_search.sql`:
```sql
-- ═══════════════════════════════════════════════════════════════════
-- Migration: Web search grounding — search_web tool support.
-- See docs/superpowers/specs/2026-09-05-web-search-grounding-design.md
-- and backend/services/searchWeb.js.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already applied to
-- schema.sql; this file is a standalone, dated record of *why* it was
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-09-05_add_web_search.sql
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE projects ADD COLUMN IF NOT EXISTS web_search_enabled BOOLEAN DEFAULT false;
ALTER TABLE usage    ADD COLUMN IF NOT EXISTS web_searches       INTEGER DEFAULT 0;
```

- [ ] **Step 4: Apply to the live database (explicit user confirmation required)**

This touches the production database — confirm with the user before running, then:
```bash
psql "$DATABASE_URL" -f supabase/migrations/2026-09-05_add_web_search.sql
```
If there's no reachable `DATABASE_URL` in this environment (e.g. local dev without prod DB access), skip this step and note it as a manual follow-up for the user — do not skip asking.

- [ ] **Step 5: Commit**

```bash
git add supabase/schema.sql supabase/migrations/2026-09-05_add_web_search.sql
git commit -m "Add web_search_enabled/web_searches columns

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Request/patch validation schemas

**Files:**
- Modify: `backend/middleware/validate.js`

- [ ] **Step 1: Add `webSearchEnabled` to `patchProject`**

In `backend/middleware/validate.js`, inside `schemas.patchProject`, add the field next to the other simple booleans (right after `showQuickReplies`):
```js
showSourceCards: z.boolean().optional(),
showQuickReplies: z.boolean().optional(),
webSearchEnabled: z.boolean().optional(),
allowDragDropUpload: z.boolean().optional(),
```

- [ ] **Step 2: Add the `searchWeb` request schema**

Add a new entry to the `schemas` object, next to `embedRetrieve`:
```js
searchWeb: z.object({
  query: z.string().trim().min(1, 'Query required').max(300, 'Query too long'),
  language: z.string().trim().max(10).optional(),
}),
```

- [ ] **Step 3: Commit**

```bash
git add backend/middleware/validate.js
git commit -m "Add webSearchEnabled and searchWeb request schemas

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: `routes/projects.js` — default + plan gate

**Files:**
- Modify: `backend/routes/projects.js`

- [ ] **Step 1: Add the default on project creation**

In the `db.insert('projects', { ... })` call, add the field next to the other widget booleans (right after `showQuickReplies`):
```js
showSourceCards: true,
showQuickReplies: false,
webSearchEnabled: false,
allowDragDropUpload: false,
```

- [ ] **Step 2: Add the server-side plan gate on PATCH**

In the `router.patch('/:id', ...)` handler, add this check right after the existing `customDomain` gate (after its closing `}` around line 268), before `const updated = await db.update('projects', project.id, patch);`:
```js
// Web search is a cost-bearing capability — hard-block on the free plan
// (not just a disabled UI control), same style as the customDomain gate
// above.
if (patch.webSearchEnabled) {
  const planId = await userPlanId(req.user.id);
  if (planId === 'free') {
    return res.status(402).json({ error: 'Live web search requires a paid plan.', code: 'PLAN_UPGRADE_REQUIRED' });
  }
}
```
(`userPlanId` is already imported in this file — confirm the import line near the top matches `const { checkLimit, userPlanId } = require('../services/usage');` or equivalent; it's already used a few lines up for the team-members plan check, so no new import should be needed.)

- [ ] **Step 3: Commit**

```bash
git add backend/routes/projects.js
git commit -m "Default webSearchEnabled=false and block enabling it on the free plan

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: `routes/embed.js` — config exposure + search-web route

**Files:**
- Modify: `backend/routes/embed.js`

- [ ] **Step 1: Expose the flag in `/config`, force-false on free plan**

In `GET /:publicId/config`'s response object, add `webSearchEnabled` next to `showSourceCards`:
```js
showSourceCards:       project.showSourceCards       !== false,
showQuickReplies:      project.showQuickReplies      === true,
webSearchEnabled:      planId === 'free' ? false : project.webSearchEnabled === true,
```
Check the surrounding code for how `planId` is already computed in this handler (it's already used for the `showBranding` line — `showBranding: planId === 'free' ? true : project.showBranding !== false` — reuse that exact same `planId` variable, don't recompute it).

- [ ] **Step 2: Add the rate limiter**

Near the top of the file, right after the existing `aiCostLimiter` definition (around line 58), add:
```js
// search_web is a real per-call cost (Serper API) on top of the monthly
// quota tracked in usage.js — this catches a runaway single session
// (e.g. a chatty loop) between quota-check intervals. 10/min per project,
// same Redis-backed store as aiCostLimiter.
const webSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip || 'unknown')}:websearch:${req.params.publicId || 'unknown'}`,
  handler: (_req, res) => res.status(429).json({ error: 'Too many searches — please slow down a little.' }),
  store: getRateLimitStore('websearch'),
});
```

- [ ] **Step 3: Import `searchWebForProject`**

Add near the other service imports at the top of the file:
```js
const { searchWebForProject } = require('../services/searchWeb');
```

- [ ] **Step 4: Add the route**

Place it right after the existing `POST /:publicId/retrieve` route:
```js
/**
 * POST /embed/:publicId/search-web
 * Client-side search_web tool backend (see public/embed.html's
 * searchWebTool()) — only reachable when the project has opted in.
 */
router.post('/:publicId/search-web', webSearchLimiter, validate(schemas.searchWeb), async (req, res) => {
  const project = await findByPublicId(req.params.publicId);
  if (!project) return res.status(404).json({ error: 'Chatbot not found' });
  if (!project.webSearchEnabled) {
    return res.status(403).json({ error: 'Web search is not enabled for this chatbot' });
  }

  try {
    const results = await searchWebForProject(project, req.body.query, { language: req.body.language });
    res.json({ results });
  } catch (e) {
    if (e.quotaExceeded) return res.status(402).json({ error: e.message, quotaExceeded: true });
    logger.error({ err: e.message }, 'search-web failed');
    res.status(e.status || 502).json({ error: 'Search service unavailable' });
  }
});
```

- [ ] **Step 5: Manually verify the route**

Run the dev server (`npm run dev`) and, against a project with `webSearchEnabled=false` in the DB, confirm:
```bash
curl -s -X POST http://localhost:3000/embed/<publicId>/search-web -H 'Content-Type: application/json' -d '{"query":"test"}'
```
Expected: `{"error":"Web search is not enabled for this chatbot"}`, HTTP 403.

Then flip `webSearchEnabled` to `true` directly in the DB for that test project (`UPDATE projects SET web_search_enabled = true WHERE public_id = '<publicId>';`) and with a valid `SERPER_API_KEY` set, repeat the curl — expect `{"results":[...]}` with up to 5 `{title,url,snippet,source}` entries.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/embed.js
git commit -m "Add POST /embed/:publicId/search-web route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: `/ask` fallback heuristic — `answerQuestion.js`

**Files:**
- Modify: `backend/services/answerQuestion.js`

- [ ] **Step 1: Import the search service and add the module-level regex**

Add near the top of `backend/services/answerQuestion.js`, alongside the other `require`s:
```js
const { searchWebForProject } = require('./searchWeb');
```
Then, right after the imports (before `async function filesForHits`), add the time-sensitivity pattern as a module-level constant — matching this codebase's convention of module-level regex constants (e.g. `embed.html`'s `RTL_REGEX`/`HEBREW_REGEX`), not recompiled on every call:
```js
// Web search fallback trigger (see docs/superpowers/specs/2026-09-05-web-search-grounding-design.md
// Part 2) — /ask has no tool-calling loop, so there's no model decision
// point the way the Live path has; this heuristic gate stands in for it.
const TIME_SENSITIVE_RE = /\b(latest|current(ly)?|today|this week|this year|right now|price|cost|version|release|schedule|news)\b/i;
```

- [ ] **Step 2: Add the heuristic + web-results folding**

In `answerQuestion()`, right after the existing block that builds `sources`/`contextParts` from `hits` (i.e. after the `for (const hit of hits) { ... }` loop, before `const systemPrompt = ...`), add:
```js
// hits.length === 0 already means "below RAG_MIN_SCORE" (vector.js
// filters those rows out server-side), so that alone is the confidence
// signal; the regex additionally catches a time-sensitive question the KB
// might technically have stale content for.
if (project.webSearchEnabled && (hits.length === 0 || TIME_SENSITIVE_RE.test(question))) {
  try {
    const webResults = await searchWebForProject(project, question, { language: 'en' });
    for (const r of webResults) {
      contextParts.push(`[Web result: ${r.title}]\n${r.snippet}`);
      sources.push({ title: r.title, url: r.url, snippet: r.snippet });
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'ask web-search fallback failed — continuing with KB-only context');
  }
}
```
A failed/quota-exceeded web search here degrades gracefully (logs and continues with whatever KB context exists) rather than failing the whole `/ask` request — a search-web hiccup shouldn't break basic Q&A.

- [ ] **Step 3: Manually verify**

With a test project that has `webSearchEnabled=true`, an empty/sparse knowledge base, and a valid `SERPER_API_KEY`:
```bash
curl -s -X POST http://localhost:3000/embed/<publicId>/ask -H 'Content-Type: application/json' -d '{"question":"what is the latest stable version of Node.js"}'
```
Expected: `data.answer` reflects real web-sourced information, and `data.sources` includes an entry with a real `url` (not the KB-only shape). Then repeat with a question the KB *does* cover well and confirm no web search happens (check server logs for the absence of a `'web search'` info-log line from `searchWeb.js`).

- [ ] **Step 4: Commit**

```bash
git add backend/services/answerQuestion.js
git commit -m "Add web-search heuristic fallback to /ask for empty/time-sensitive queries

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: `lipsync-sdk.js` — `onToolCall` event

**Files:**
- Modify: `public/lipsync-sdk.js`

- [ ] **Step 1: Fire the event in `_handleToolCall`**

Find `_handleToolCall` (around line 2198):
```js
async _handleToolCall(functionCalls) {
  const ws = this._ws;
  const responses = await Promise.all(functionCalls.map(async (call) => {
    const tool = this._toolsByName[call.name];
    let response;
    try {
      response = tool ? await tool.handler(call.args || {}) : { error: `Unknown tool: ${call.name}` };
    } catch (e) {
      response = { error: e?.message || String(e) };
    }
    return { id: call.id, name: call.name, response };
  }));
```
Change to fire `onToolCall` for each call right before dispatching its handler:
```js
async _handleToolCall(functionCalls) {
  const ws = this._ws;
  const responses = await Promise.all(functionCalls.map(async (call) => {
    const tool = this._toolsByName[call.name];
    this._fire('onToolCall', call.name);
    let response;
    try {
      response = tool ? await tool.handler(call.args || {}) : { error: `Unknown tool: ${call.name}` };
    } catch (e) {
      response = { error: e?.message || String(e) };
    }
    return { id: call.id, name: call.name, response };
  }));
```

- [ ] **Step 2: Document the new callback in the constructor's JSDoc**

Find the JSDoc block listing `@param {Function} [opts.onTranscript]` etc. (around line 1104) and add a line right after `onError`:
```js
     * @param {Function}           [opts.onError]       - (message:string)
     * @param {Function}           [opts.onToolCall]    - (name:string) - fired synchronously right before dispatching
     *   a model-requested tool call (see opts.tools). Useful for a host page to show a distinct "using a tool…"
     *   status while a handler's fetch is in flight, since a tool call can add a multi-second pause mid-turn.
```

- [ ] **Step 3: Manually verify**

No automated harness for this file (consistent with the rest of the SDK — verified via the widget in Task 12's manual check). Confirm here only that the file has no syntax errors:
```bash
node --check public/lipsync-sdk.js
```
Expected: no output (exit code 0).

- [ ] **Step 4: Commit**

```bash
git add public/lipsync-sdk.js
git commit -m "Add onToolCall callback, fired before each Live tool-call dispatch

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: `embed.html` — `search_web` tool + status wiring

**Files:**
- Modify: `public/embed.html`

- [ ] **Step 1: Add `pendingWebSources` state**

Find the existing pending-state declarations (around line 139-141):
```js
let pendingSources = null;
let pendingFigures = null;
let pendingOptions = null;
```
Add one more:
```js
let pendingSources = null;
let pendingFigures = null;
let pendingOptions = null;
let pendingWebSources = null;
```

- [ ] **Step 2: Consume it alongside the other pending state**

In `handleBotChunk`'s flush timer (around line 742-750):
```js
botFlushTimer = setTimeout(() => {
  if (pendingSources && pendingSources.length && currentBotMsgEl) {
    attachSources(currentBotMsgEl, pendingSources);
    pendingSources = null;
  }
  if (pendingFigures && pendingFigures.length) {
    for (const fig of pendingFigures) renderFigureCard(fig);
    pendingFigures = null;
  }
  if (config.project.showQuickReplies && pendingOptions && currentBotMsgEl) {
    attachOptionButtons(currentBotMsgEl, pendingOptions);
  }
  pendingOptions = null;
  if (botBuffer) { logTurn('assistant', botBuffer); attachSatisfactionPrompt(currentBotMsgEl); }
  botBuffer = '';
  currentBotMsgEl = null;
}, 1500);
```
Add a `pendingWebSources` block right after the `pendingFigures` block:
```js
botFlushTimer = setTimeout(() => {
  if (pendingSources && pendingSources.length && currentBotMsgEl) {
    attachSources(currentBotMsgEl, pendingSources);
    pendingSources = null;
  }
  if (pendingFigures && pendingFigures.length) {
    for (const fig of pendingFigures) renderFigureCard(fig);
    pendingFigures = null;
  }
  if (pendingWebSources && pendingWebSources.length && currentBotMsgEl) {
    attachSources(currentBotMsgEl, pendingWebSources);
    pendingWebSources = null;
  }
  if (config.project.showQuickReplies && pendingOptions && currentBotMsgEl) {
    attachOptionButtons(currentBotMsgEl, pendingOptions);
  }
  pendingOptions = null;
  if (botBuffer) { logTurn('assistant', botBuffer); attachSatisfactionPrompt(currentBotMsgEl); }
  botBuffer = '';
  currentBotMsgEl = null;
}, 1500);
```

- [ ] **Step 3: Add `searchWebTool()`**

Find `searchKnowledgeBaseTool()` (around line 1527) and add a new function right after it:
```js
// search_web — same client-side-tool pattern as searchKnowledgeBaseTool()
// above, calling the new backend/services/searchWeb.js-backed route
// instead. Only added to the Live session's tools when
// config.project.webSearchEnabled (see initSDK()) — a tenant who hasn't
// opted in never gets this function declared at all.
function searchWebTool() {
  return {
    name: 'search_web',
    description:
      "Search the public internet for current, factual information not covered in this " +
      "chatbot's knowledge base. Call this when search_knowledge_base returned nothing " +
      "relevant, when the user asks about current or time-sensitive information (news, " +
      "prices, versions, schedules, \"latest\", \"today\"), or when they explicitly ask for " +
      "a link or source. Give a direct spoken answer from the results — don't read URLs aloud.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A focused search query.' } },
      required: ['query'],
    },
    handler: async ({ query }) => {
      try {
        const res = await fetch(`/embed/${publicId}/search-web`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: String(query || '').slice(0, 300),
            language: (navigator.language || 'en').slice(0, 2),
          }),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error || `Search failed (HTTP ${res.status})` };
        pendingWebSources = (data.results || []).map(r => ({ fileName: r.title, url: r.url, kind: 'url' }));
        if (!data.results || !data.results.length) return { results: [], note: 'No web results found for this query.' };
        // No URLs sent to the model — nothing to read aloud, the widget
        // renders the clickable cards from pendingWebSources instead.
        return { results: data.results.map(r => ({ title: r.title, snippet: r.snippet })) };
      } catch (e) {
        return { error: e.message || 'Search failed' };
      }
    },
  };
}
```

- [ ] **Step 4: Wire it into the tools array, conditionally**

In `initSDK()`, find:
```js
characterTriggers: config.character?.triggers || [],
tools: [searchKnowledgeBaseTool()],
```
Change to:
```js
characterTriggers: config.character?.triggers || [],
tools: [
  searchKnowledgeBaseTool(),
  ...(config.project.webSearchEnabled ? [searchWebTool()] : []),
],
```

- [ ] **Step 5: Extend the system-prompt instructions**

Find `buildKnowledgeBaseToolInstructions()` (around line 1513):
```js
function buildKnowledgeBaseToolInstructions() {
  return `

You have a search_knowledge_base tool connected to this website's uploaded documents and indexed pages. Call it whenever the user asks something that might be covered there — don't guess or rely on general knowledge for anything specific to this business/product/topic. It's fine to call it more than once per turn if the first search doesn't return what you need. If it returns nothing relevant, say so honestly rather than making something up.`;
}
```
Change to accept the toggle and append the web-search paragraph when enabled:
```js
function buildKnowledgeBaseToolInstructions(webSearchEnabled) {
  let text = `

You have a search_knowledge_base tool connected to this website's uploaded documents and indexed pages. Call it whenever the user asks something that might be covered there — don't guess or rely on general knowledge for anything specific to this business/product/topic. It's fine to call it more than once per turn if the first search doesn't return what you need. If it returns nothing relevant, say so honestly rather than making something up.`;
  if (webSearchEnabled) {
    text += `

You also have a search_web tool for the public internet. Always try search_knowledge_base first. Call search_web only if search_knowledge_base found nothing relevant, the question is about current/time-sensitive information, or the user explicitly asks for a link or source. Give a concise spoken answer — never read a URL or list of links aloud.`;
  }
  return text;
}
```
Then update its one call site in `initSDK()`:
```js
const baseSystemPrompt = (config.project.systemPrompt || '')
  + buildKnowledgeBaseToolInstructions()
  + buildCaptureInstructions(captureFields)
  + buildQuickReplyInstructions(config.project.showQuickReplies);
```
to:
```js
const baseSystemPrompt = (config.project.systemPrompt || '')
  + buildKnowledgeBaseToolInstructions(config.project.webSearchEnabled)
  + buildCaptureInstructions(captureFields)
  + buildQuickReplyInstructions(config.project.showQuickReplies);
```

- [ ] **Step 6: Wire the "Searching the web…" status text**

In `initSDK()`'s `LipsyncAvatar` options, find:
```js
onError: (msg) => { console.warn('[avatar]', msg); addMessage('bot', `⚠️ ${msg}`); },
onTranscript: (role, text) => {
  if (role === 'model') handleBotChunk(text);
  else if (role === 'user') handleUserChunk(text);
},
```
Change to:
```js
onError: (msg) => { console.warn('[avatar]', msg); addMessage('bot', `⚠️ ${msg}`); },
onToolCall: (name) => {
  if (name === 'search_web') statusText.textContent = 'Searching the web…';
},
onTranscript: (role, text) => {
  if (role === 'model') { statusText.textContent = 'Online'; handleBotChunk(text); }
  else if (role === 'user') handleUserChunk(text);
},
```

- [ ] **Step 7: Extend the `/ask` fallback's source mapping (already correct — verify only)**

`sendTextOnly()` (around line 469-472) already maps `data.sources` generically:
```js
if (config.project.showSourceCards !== false && data.sources && data.sources.length) {
  attachSources(answerEl, data.sources.map(s => ({
    fileId: null, fileName: s.title, kind: s.url ? 'url' : null, url: s.url || null, previewUrl: null,
  })));
}
```
This already handles the web-result shape `answerQuestion.js` now pushes (`{title, url, snippet}` → `kind: 'url'` since `s.url` is truthy) — no change needed here. Just confirm by reading the code that this is still intact after Task 10's backend change (it doesn't touch this file).

- [ ] **Step 8: Manually verify end-to-end**

With `webSearchEnabled=true`, a `PUBLIC_GEMINI_API_KEY` configured (Live mode), and a valid `SERPER_API_KEY`:
1. Load a test embed page, open devtools → Network → WS, connect the widget, inspect the outgoing `setup` message — confirm `tools[0].functionDeclarations` includes both `search_knowledge_base` and `search_web`.
2. Ask a KB-covered question — confirm only `search_knowledge_base` is called (no request to `/search-web` in the Network tab).
3. Ask "what's today's date" or another clearly time-sensitive question — confirm a request to `/embed/<publicId>/search-web` fires, the status text briefly reads "Searching the web…", the spoken answer doesn't read out a URL, and a source-card strip with a 🔗-icon card appears and is clickable (opens in a new tab).
4. Toggle `webSearchEnabled` back to `false` in the DB, reload, reconnect — inspect the `setup` message again and confirm `search_web` is no longer declared.

- [ ] **Step 9: Commit**

```bash
git add public/embed.html
git commit -m "Wire search_web tool into the Live widget with status indicator

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: `project.html` — settings toggle

**Files:**
- Modify: `public/project.html`

- [ ] **Step 1: Add the field to the Widget tab's markup**

Find the `<select>` markup for `f-quickreplies` (search for `id="f-quickreplies"`) and add a matching field right after it, following the exact same label/select/help structure used for that field (copy its surrounding `<div class="field">...</div>` block, changing the id, label text to "Enable live web search", and help text to "Let the avatar search the web when it doesn't know the answer from your knowledge base."). Since this plan doesn't have the exact surrounding HTML block in hand, locate `id="f-quickreplies"` in the file first and mirror its containing element structure exactly — don't guess at markup, copy the sibling field's real structure.

Add a `<select id="f-websearch">` with `<option value="false">Off</option>` / `<option value="true">On</option>`, matching `f-quickreplies`'s exact option markup.

- [ ] **Step 2: Wire load**

Find:
```js
document.getElementById('f-sources').value   = String(p.showSourceCards !== false);
document.getElementById('f-quickreplies').value = String(p.showQuickReplies === true);
```
Add right after:
```js
document.getElementById('f-websearch').value = String(p.webSearchEnabled === true);
```

- [ ] **Step 3: Wire the free-plan lock**

Right after the existing `f-branding` free-plan lock block (the one reading `if (sub && sub.plan.id === 'free') { brandingField.value = 'true'; brandingField.disabled = true; ... }`), add the equivalent for web search:
```js
const webSearchField = document.getElementById('f-websearch');
if (sub && sub.plan.id === 'free') {
  webSearchField.value = 'false';
  webSearchField.disabled = true;
  if (!document.getElementById('f-websearch-lock-help')) {
    const help = document.createElement('span');
    help.id = 'f-websearch-lock-help';
    help.className = 'help';
    help.innerHTML = 'Live web search requires a paid plan. <a href="/billing">Upgrade →</a>';
    webSearchField.insertAdjacentElement('afterend', help);
  }
}
```

- [ ] **Step 4: Wire save**

Find:
```js
showSourceCards:      document.getElementById('f-sources').value === 'true',
showQuickReplies:     document.getElementById('f-quickreplies').value === 'true',
```
Add right after:
```js
webSearchEnabled:     document.getElementById('f-websearch').value === 'true',
```

- [ ] **Step 5: Manually verify**

1. Load the project settings page as a free-plan user — confirm the "Enable live web search" field is shown, disabled, forced to "Off", with an "Upgrade →" link.
2. Load it as a paid-plan user, toggle it on, save — confirm the PATCH request succeeds (200) and reloading the page shows it still "On".
3. As a free-plan user, try sending a raw PATCH with `webSearchEnabled: true` directly (e.g. via devtools/curl with the auth cookie) — confirm the server still rejects it with 402 even though the UI wouldn't normally allow it (this is the Task 8 server-side gate, being re-verified here from the client's perspective).

- [ ] **Step 6: Commit**

```bash
git add public/project.html
git commit -m "Add Enable live web search project setting

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 14: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `npm test`
Expected: PASS — all existing tests plus the new `searchWeb.test.js` and the extended `usage.test.js`, no regressions elsewhere.

- [ ] **Step 2: Regression-check a project with `webSearchEnabled: false` (the default/most-common case)**

Using an existing test project that has never touched this feature, confirm both chat surfaces behave exactly as before:
- Live: connect, ask a question the KB covers and one it doesn't — behavior identical to pre-change (no `search_web` declared, no new network calls, no status-text changes beyond the existing states).
- `/ask`: same two questions via the text-only path — identical responses/timing to pre-change, no calls into `searchWeb.js` (check server logs for the absence of any `'web search'` info line).

- [ ] **Step 3: Confirm quota enforcement end-to-end**

Temporarily set a test project's owner to the `starter` plan and lower `monthlyWebSearches` for a quick test (either via a custom `plan_tiers` row or by temporarily editing `plans.js` locally, then reverting) — trigger enough `search_web` calls to exceed it, and confirm:
- The Live path's model receives `{error: ..., quotaExceeded: true}` as the function response and says something graceful rather than the widget silently failing.
- The `/ask` path logs the quota error and still returns a KB-only answer instead of a hard failure.

- [ ] **Step 4: Final commit (if any fixes were needed during regression)**

```bash
git add -A
git commit -m "Fix regressions found during web-search-grounding verification pass

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
(Only if Steps 1-3 surfaced something to fix — skip this commit entirely if the pass was clean.)

---

## Self-Review Notes

**Spec coverage:** Every part of the design doc (Parts 1-4 plus error handling) maps to a task above — Live tool (Task 12), `/ask` heuristic (Task 10), backend service/cache/quota/rate-limit (Tasks 1-5, 9), tenant toggle + server-side gating (Tasks 6-8, 13), status indicator (Tasks 11-12). `search_youtube`, domain allow/deny, and billing-dashboard surfacing are out of scope per the spec and intentionally have no task here.

**Type/name consistency check:** `searchWebForProject(project, query, {language})` (Task 3) is called identically in Task 9's route and Task 10's `answerQuestion.js`. `pendingWebSources` is declared once (Task 12 Step 1) and consumed once (Step 2) with matching name. `webSearchEnabled` (camelCase, JS/API) vs `web_search_enabled` (snake_case, DB column) follows the existing `db.js` auto-conversion — no manual mapping needed anywhere, matching how every other project boolean flag already works. `monthlyWebSearches` (plan limit key) vs `webSearches` (usage counter key) names are distinct on purpose, matching the existing `monthlyMessages`/`messages` and `monthlyEmbeddingChars`/`embeddingChars` pairing convention.
