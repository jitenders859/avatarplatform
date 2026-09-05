# Web search grounding (phase 1: search_web)

**Files:** `public/lipsync-sdk.js`, `public/embed.html`, `public/project.html`, `backend/routes/embed.js`, `backend/routes/projects.js`, `backend/services/searchWeb.js` (new), `backend/services/answerQuestion.js`, `backend/services/settings.js`, `backend/services/usage.js`, `backend/cache.js`, `backend/middleware/validate.js`, `backend/plans.js`, `supabase/schema.sql`
**Status:** Approved, ready for implementation plan

## Context

The avatar currently answers strictly from each tenant's own knowledge base (RAG over uploaded documents/pages). There's no way for it to answer a time-sensitive question ("what's the latest version of X") or hand the visitor a live source link — it either hallucinates or admits it doesn't know. This spec adds an opt-in `search_web` capability so the avatar can fall back to a real web search when the knowledge base doesn't have an answer, then speak a synthesized answer while the widget shows clickable source cards.

**This is phase 1 of a two-phase plan.** `search_youtube`, a per-tenant domain allow/deny list for search results, and surfacing search spend in the billing dashboard are deliberately deferred to a follow-up spec once this ships and is validated. This phase covers `search_web` only.

**Key architectural fact driving this design:** the widget's voice/chat session (`public/lipsync-sdk.js`) opens a WebSocket directly from the browser to Gemini Live using a public API key — the backend never sees Live turns. Function calling there already works via a generic `opts.tools` mechanism (`{ name, description, parameters, handler }`), proven today by `searchKnowledgeBaseTool()` in `embed.html`, which calls `POST /embed/:publicId/retrieve` and feeds results back into the same Live session. There is no backend interception point mid-turn, and no per-turn control over which tools are declared — tools are fixed at session-connect time. `search_web` follows the exact same client-side-tool pattern; there's no separate intent classifier, because the model already decides when to call a tool this way (same as it decides today whether to call `search_knowledge_base`).

A second, separate chat surface — `POST /embed/:publicId/ask` — is a plain `generateContent` call with **no** tool-calling loop, used as a text-only fallback when no public Gemini key is configured (`voiceEnabled: false`). It can't let the model "decide" to call a tool, so it gets a small server-side heuristic gate instead (detailed in Part 2).

Out of scope for this phase: `search_youtube`; domain allow/deny lists; billing-dashboard usage surfacing (the quota mechanism is built, just not yet shown in a dashboard chart); the `/study` REST tool-calling loop (`backend/services/tools.js`) — that surface is unaffected.

---

## Part 1 — Live widget: `search_web` as a client-side tool

**`public/embed.html`** gets a new tool builder next to `searchKnowledgeBaseTool()`:

```js
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
          body: JSON.stringify({ query: String(query || '').slice(0, 300), language: conversationLanguage() }),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error || `Search failed (HTTP ${res.status})` };
        pendingWebSources = data.results || [];
        if (!data.results || !data.results.length) return { results: [], note: 'No web results found for this query.' };
        return { results: data.results.map(r => ({ title: r.title, snippet: r.snippet })) }; // no URLs sent to the model — nothing to read aloud
      } catch (e) {
        return { error: e.message || 'Search failed' };
      }
    },
  };
}
```

`conversationLanguage()` is a small new helper returning the widget's configured/detected language code (reuses the existing `detectDirection`/`detectScriptLang` heuristics already in the file where available, otherwise `navigator.language.slice(0,2)`), passed through so results come back in the visitor's language via Serper's `hl` param.

**Wiring (`initSDK()`, `embed.html:363`):**
```js
tools: [
  searchKnowledgeBaseTool(),
  ...(config.project.webSearchEnabled ? [searchWebTool()] : []),
],
```
When the toggle is off, the `search_web` function declaration is never sent in the Live session's `setup` message at all — satisfies "tools shouldn't even be declared for opted-out tenants."

**System prompt (`buildKnowledgeBaseToolInstructions()`)** gets one more paragraph, only appended when `config.project.webSearchEnabled`:
```
You also have a search_web tool for the public internet. Always try search_knowledge_base
first. Call search_web only if search_knowledge_base found nothing relevant, the question is
about current/time-sensitive information, or the user explicitly asks for a link or source.
Give a concise spoken answer — never read a URL or list of links aloud.
```

**"Searching the web…" status indicator:** `lipsync-sdk.js`'s tool-call handler (`_handleToolCall`, `lipsync-sdk.js:2198`) gets one addition: before dispatching, if the call name is `search_web`, call `this._setStatus('Searching the web…', 'searching')` (same mechanism already used for `'Connecting…'`/`'Listening…'`) so the widget's status pill and CSS state class reflect it distinctly from the normal thinking/speaking states. No new state machine — one more status string plus a `.lsa-searching` CSS class mirroring `.lsa-speaking`/`.lsa-listening`.

**Rendering results — reuses `attachSources()` (`embed.html:843`), doesn't replace it:**
On `turnComplete`, if `pendingWebSources` is non-empty, call `attachSources(currentBotMsgEl, pendingWebSources)` the same way `pendingSources`/`pendingFigures` are consumed today, with a `fromWeb: true` flag on each entry so `attachSources()` can render a small "web" badge/icon distinguishing these cards from knowledge-base citations (exact badge treatment is a small CSS/markup detail left to the implementation step, not a new component). `pendingWebSources` resets to `null` after each turn, same lifecycle as `pendingSources`.

## Part 2 — `/ask` fallback: server-side heuristic gate

`backend/services/answerQuestion.js`'s `answerQuestion()` gets a new step, only when `project.webSearchEnabled`, inserted right after the existing `searchProject()` call:

```js
const TIME_SENSITIVE_RE = /\b(latest|current(ly)?|today|this week|this year|right now|price|cost|version|release|schedule|news)\b/i;

let webResults = [];
if (project.webSearchEnabled && (hits.length === 0 || TIME_SENSITIVE_RE.test(question))) {
  webResults = await searchWebQuota(project, question).catch(() => []);
}
```

`searchWebQuota()` is a thin wrapper (in the new `services/searchWeb.js`) that does the same quota-check → cache → provider-call → log sequence as the route in Part 3, so the logic isn't duplicated between the `/ask` path and the `/embed/:publicId/search-web` route — both call into the same service function, one directly and one over HTTP for the browser-side tool.

Web results get folded into the prompt as one more context block (`[Web result: title]\nsnippet`) and appended to the `sources[]` array already returned to and rendered by the widget (`attachSources()` already handles this shape — no `/ask`-side UI change needed). Reusing the existing `RAG_MIN_SCORE` floor as the "confidence" signal means no new scoring logic — `hits.length === 0` already *is* "below confidence floor," since `searchProject()` filters those rows out server-side today.

This is intentionally a different trigger mechanism than the Live path (heuristic gate vs. model-driven tool call) because `/ask` has no function-calling loop to hook into — not an arbitrary inconsistency.

## Part 3 — Backend: search route, service, cache, rate limit, quota

**New service — `backend/services/searchWeb.js`:**
```js
const { safeFetch } = require('./safeFetch');
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
  if (!apiKey) { logger.warn('SERPER_API_KEY not configured'); return []; }

  const res = await safeFetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, hl: language, num: 5 }),
    timeout: 8000,
  });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
  const data = await res.json();
  const results = (data.organic || []).slice(0, 5).map(r => ({
    title: r.title, url: r.link, snippet: (r.snippet || '').slice(0, 220),
    source: (() => { try { return new URL(r.link).hostname; } catch { return null; } })(),
  }));

  webSearchCache.set(cacheKey, results);
  logger.info({ query: q, resultCount: results.length, latencyMs: Date.now() - start }, 'web search');
  return results;
}

/** Quota-checked entry point shared by the /search-web route and the /ask fallback. */
async function searchWebForProject(project, query, { language } = {}) {
  const limitCheck = await checkLimit(project.userId, 'webSearch', 1);
  if (!limitCheck.ok) { const e = new Error(limitCheck.reason); e.quotaExceeded = true; throw e; }
  const results = await searchWeb(query, { language });
  await trackWebSearch(project.userId).catch(() => {});
  return results;
}

module.exports = { searchWeb, searchWebForProject };
```

**Cache — `backend/cache.js`:** add a second `LRUCache`:
```js
const webSearchCache = new LRUCache({ max: 1000, ttl: 10 * 60_000 });
```
exported alongside `projectCache`. Same file, same pattern — no new module.

**API key:** `SERPER_API_KEY` added to `settings.js`'s `OVERRIDABLE_KEYS` list, so it's settable via env var or the admin settings panel like `GEMINI_API_KEY`, rotatable with no redeploy, and never sent to the client.

**New route — `backend/routes/embed.js`:**
```js
router.post('/:publicId/search-web', webSearchLimiter, validate(schemas.searchWeb), async (req, res) => {
  const project = await findByPublicId(req.params.publicId);
  if (!project) return res.status(404).json({ error: 'Chatbot not found' });
  if (!project.webSearchEnabled) return res.status(403).json({ error: 'Web search is not enabled for this chatbot' });

  try {
    const results = await searchWebForProject(project, req.body.query, { language: req.body.language });
    res.json({ results });
  } catch (e) {
    if (e.quotaExceeded) return res.status(402).json({ error: e.message, quotaExceeded: true });
    logger.error({ err: e.message }, 'search-web failed');
    res.status(502).json({ error: 'Search service unavailable' });
  }
});
```
`webSearchLimiter` is a new `express-rate-limit` instance (10 req/min, keyed by `publicId`) built the same way `aiCostLimiter` is, backed by the existing Redis `rateLimitStore.js` — catches a runaway single session, distinct from the monthly quota. `schemas.searchWeb` (new Zod schema in `middleware/validate.js`): `{ query: z.string().min(1).max(300), language: z.string().max(10).optional() }`.

**Monthly quota — extends the existing plan/usage system:**
- `supabase/schema.sql`: `usage` table gets `web_searches INTEGER DEFAULT 0`, alongside `messages`/`embedding_chars`. Migration file `supabase/migrations/2026-09-05_add_web_search_usage.sql` with the matching `ALTER TABLE usage ADD COLUMN IF NOT EXISTS web_searches INTEGER DEFAULT 0;` plus `ALTER TABLE projects ADD COLUMN IF NOT EXISTS web_search_enabled BOOLEAN DEFAULT false;` — applied to the live DB with explicit user confirmation, same precedent as the full-screen-mode migration.
- `backend/services/usage.js`: `trackWebSearch(userId)` mirrors `trackMessage` exactly (atomic upsert incrementing `web_searches`); `getUsageSnapshot`'s aggregate gets `webSearches` added to `counters`; `checkLimit` gets a `case 'webSearch': if (c.webSearches + delta > l.monthlyWebSearches) return fail(...)`.
- `backend/plans.js`: each plan's `limits` gets `monthlyWebSearches` — **free: 0** (feature unavailable regardless of the project toggle, keeping the free tier's cost fixed at zero), **starter: 50**, **pro: 300**, **business: 1,500**. These are starting defaults, easy to tune in `plans.js` without a design change.

## Part 4 — Tenant toggle (project settings)

- `webSearchEnabled` (boolean, default `false`) — same shape as `showSourceCards`/`showQuickReplies`.
- `backend/middleware/validate.js`: `webSearchEnabled: z.boolean().optional()` added to the project-update schema.
- `backend/routes/projects.js`: added to project-creation defaults (`false`) and the `PATCH /:id` allowed-fields list.
- `backend/routes/embed.js` `GET /:publicId/config`: `webSearchEnabled: project.webSearchEnabled === true` exposed alongside the other widget flags.
- `public/project.html`: new `<select id="f-websearch">` next to the existing Sources/Quick-replies fields, same load/save wiring. Since free-plan quota is 0, gate it exactly like the existing `f-branding` field (`project.html:929-940`) — `disabled = true` plus an inline `.help` note with an upgrade link when `sub.plan.id === 'free'`:
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

---

## Error handling / edge cases

- `SERPER_API_KEY` unset: `searchWeb()` logs a warning and returns `[]` rather than throwing — the model gets `{ results: [], note: 'No web results found...' }` and can tell the user honestly, same as an empty KB search today. No hard crash for a mis-configured tenant.
- Quota exceeded mid-conversation: the tool handler returns `{ error, quotaExceeded: true }` as the function result — the model sees this like any other tool error and can tell the user, rather than the fetch just failing silently or throwing inside the Live session.
- Serper request times out or errors: `safeFetch`'s timeout (8s) bounds the delay; the route catches and returns a generic 502, the client tool handler surfaces `{ error: ... }` to the model.
- Empty/whitespace query from the model: guarded early in `searchWeb()` (`if (!q) return []`), no wasted API call.
- Toggle flipped off mid-session: Live tool declarations are fixed at connect time (existing SDK behavior — same as `characterTriggers`/`knowledgeBase`), so an open session keeps whatever was declared at connect; a fresh `connect()` picks up the new value. Documented as existing, expected behavior, not a new edge case.
- `/ask` heuristic firing on a KB-covered but coincidentally time-sensitive-sounding question (e.g. "what's the current price in your pricing doc"): acceptable false-positive — it still returns the KB hit(s) plus a possibly-redundant web result; the model has both in context and can prefer the KB content. Not worth a more precise classifier for this phase.

## Testing

- `backend/services/searchWeb.test.js` (new, follows the existing `*.test.js` co-located pattern e.g. `services/tools.test.js`): mocked Serper response → correct result shape; query sanitization (control chars stripped, length-capped); empty-query short-circuit; cache hit skips the network call; missing `SERPER_API_KEY` returns `[]` without throwing.
- `backend/services/usage.test.js`: extend with a `checkLimit(userId, 'webSearch', 1)` case at/over the plan limit.
- Manual, end-to-end (no automated harness for the Live WebSocket path, consistent with other widget features):
  1. Toggle `webSearchEnabled` off → open browser devtools, inspect the Live session's outgoing `setup` message → confirm no `search_web` function declaration is sent.
  2. Toggle on, ask a KB-covered question → confirm no web search call happens (network tab), answer comes from KB only.
  3. Ask a clearly time-sensitive question ("what's today's date," "latest version of Node") → confirm `search_web` fires, the spoken answer doesn't read out a URL, and a source-card strip with a "web" badge appears.
  4. Ask something the KB has no content for at all → confirm the empty-KB-result fallback triggers `search_web` per the system prompt instruction.
  5. Exhaust the monthly quota (or temporarily lower the plan limit for the test project) → confirm the model surfaces a graceful "I've hit my search limit" style response instead of erroring.
  6. Repeat a query within 10 minutes → confirm the cache serves it (check `resultCount`/log timestamp, or temporarily instrument a cache-hit log line for the test).
  7. Text-only mode (`voiceEnabled: false`, `/ask` path): ask a time-sensitive question, confirm web results appear in the response's `sources[]` and render via the existing `attachSources()`.
  8. Regression: a project with `webSearchEnabled: false` behaves exactly as before on both the Live and `/ask` paths.
