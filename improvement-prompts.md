# Improvement Prompts — avatar-platform

Generated from a full audit of the project (backend/, public/, packages/, supabase/, docs/).
Each block is self-contained — copy one into a session and work through it before moving on.
Ordered by priority: P0 security → P1 correctness → P1 performance → P2 SEO/tests → P3 missing functionality.

Note: `todays_task.md` tasks 2–4 overlap with Prompts 9, 10, and the validation section of Prompt 4 —
this file supersedes them with more specific findings.

---

# P0 — Security

## Prompt S1 — Stop leaking the server Gemini key; gate every quota-consuming path

The unauthenticated endpoint `GET /embed/:publicId/config` (backend/routes/embed.js:29,134) returns
`PUBLIC_GEMINI_API_KEY || GEMINI_API_KEY` raw to any visitor. When `PUBLIC_GEMINI_API_KEY` is unset,
the **server-side** key — the same one used for server-side embeddings (backend/services/embed.js) —
is publicly downloadable, so anyone can burn Gemini quota on your billing, and the `limitReached`
key-withholding gate is trivially bypassable.

Fix:
1. In `routes/embed.js`, never fall back to `GEMINI_API_KEY`. If `PUBLIC_GEMINI_API_KEY` is unset,
   omit the key from the config response entirely and have `embed.html` degrade to text-only mode
   (server `/ask` path) instead of showing a broken mic. Log a server-side warning at boot when the
   public key is missing.
2. Add `.env.example` (project.md references it but it doesn't exist in the repo) documenting both
   keys, with a hard warning that `GEMINI_API_KEY` must never equal `PUBLIC_GEMINI_API_KEY`.
   Recommend API-key restrictions (HTTP referrer / quota) on the public key.
3. `/embed/:publicId/log` (routes/embed.js:669-673) calls `trackMessage()` with **no**
   `checkLimit('message')` — unlike `/ask` (:251) and `/study` (:362). Anyone knowing a `publicId`
   can drain a free owner's 100 messages/month by posting to `/log`. Add the same limit gate, and
   return the existing `limitReached` shape so the widget degrades gracefully.
4. Cap `/ask` and `/study` cost per visitor: the 30/min embed limiter is shared across all projects
   per IP; add a per-(IP, project) cap for AI-cost endpoints in addition to the owner's monthly quota.

Verify: with only `GEMINI_API_KEY` set, `/embed/:id/config` must not contain any API key; with the
public key set, confirm `GEMINI_API_KEY` ≠ the returned value. Post 200 messages to `/log` for a
free-tier project and confirm it stops with `limitReached` instead of draining the counter.

---

## Prompt S2 — Replace in-memory rate limiting with a shared store; add per-project dimension

All four limiters in backend/server.js (`authLimiter`, `apiLimiter`, `embedLimiter`,
`adminLoginLimiter`, server.js:53-92) use express-rate-limit's default in-memory MemoryStore. The
app deploys to Vercel (`api/index.js` + `vercel.json` rewrite), where each invocation gets a fresh
store — the limits are effectively disabled in production, most critically `embedLimiter` which is
the only protection on the anonymous, Gemini-paying surface.

Fix:
1. Wire a shared store. Lowest-friction options for this stack: Upstash Redis (serverless-friendly,
   free tier) with `@upstash/ratelimit` or `rate-limit-redis` against `express-rate-limit`, or
   Supabase-backed counting if you want to avoid a new dependency. Read the store from env
   (`REDIS_URL` / `UPSTASH_REDIS_URL`) and fall back to MemoryStore with a loud boot-time warning
   when unset, so local dev keeps working.
2. Key `embedLimiter` by IP+publicId, not just IP — today one legitimate visitor on a shared IP
   (office NAT) throttles every other embed behind that IP, and abusers rotate nothing because the
   key is IP-only. Extract `publicId` from `req.path` in a custom `keyGenerator`.
3. Add tighter dedicated limits on the three Gemini-paying endpoints (`/ask`, `/study`, and the
   texture-heavy `/retrieve`) — e.g. 10/min per IP+project — independent of the generic 30/min.
4. Document the store requirement in the deployment section of project.md.

---

## Prompt S3 — Close the SSRF surfaces (webhooks + URL ingestion)

Three endpoints make server-side HTTP requests to URLs supplied by project owners or API callers
with no scheme/host vetting:
- `POST /api/projects/:id/webhook/test` fetching `webhookUrl` (backend/routes/projects.js:241)
- `POST /embed/:publicId/log` re-fetching `webhookUrl` on every message (backend/routes/embed.js:688)
- `POST /api/projects/:projectId/sources/url` → backend/services/url.js:20-44 (protocol check only)

An owner (or anyone with write access) can point these at `http://169.254.169.254/` (cloud
metadata), internal services, or `file://`/`gopher://` schemes.

Fix — add a shared `backend/services/safeFetch.js` (or similar) used by all three paths:
1. Allowlist schemes: `http:` and `https:` only.
2. Resolve the hostname and reject loopback, private (10/8, 172.16/12, 192.168/16), link-local
   (169.254/16), and IPv6 ULA/link-local addresses. Guard against DNS rebinding by resolving once
   and connecting to that IP with the original Host header, or use an agent that checks the
   resolved address at connect time.
3. Validate `webhookUrl` at PATCH time (`routes/projects.js` allowlist, ~28 keys, no checks on
   `webhookUrl` at all) — reject invalid URLs with 400 before saving, not only at fetch time.
4. Keep the existing 15s timeout / 5MB cap in services/url.js; add a redirect cap (e.g. follow at
   most 3 redirects and re-validate each hop).

---

## Prompt S4 — Apply Zod validation to every write endpoint; stop leaking internals in errors

backend/middleware/validate.js exists with shared schemas but only 12 endpoints use it
(auth signup/login/forgot/reset, embed ask/study/quiz-attempt/flashcard-review/log, admin
login/tiers). Everything else does ad-hoc manual checks of varying quality.

Fix:
1. Add and apply Zod schemas for the remaining write endpoints:
   - `POST /PATCH /api/projects` — a `createProject` schema already exists in validate.js but is
     **unused** (routes/projects.js:27-29 does manual checks). Wire it up, and add a `patchProject`
     schema validating types for all ~28 allowlisted keys (`systemPrompt` string bounds, `voice`
     enum, `themeColor` hex pattern, `widgetPosition`/`avatarPosition`/`avatarSize` enums,
     `webhookUrl` URL — see Prompt S3).
   - `routes/files.js` upload-init (`names`/`sizes` arrays, size upper bounds) and URL ingest.
   - `routes/captureFields.js` all 5 endpoints.
   - `routes/billing.js` `create-checkout-session` `planId`.
   - `routes/admin.js` PATCH user / delete / impersonate bodies.
   - `routes/flashcards.js`, `routes/quizQuestions.js`, `routes/videoResources.js` CRUD bodies.
   - `POST /embed/:publicId/lead` and `/retrieve` (`k` is clamped at :163 but not schema-validated).
2. Harden the global error handler (backend/server.js:200): it returns `err.message` verbatim,
   which leaks DB errors, Supabase errors, and upstream Gemini error text to clients. Return
   `err.message` only for a known-safe app-error class, otherwise log the full error via
   backend/logger.js and return a generic `{error: 'Internal server error'}` with a request id.
3. Extend backend/middleware/validate.test.js to cover the new schemas.

---

## Prompt S5 — Enforce the plan limits that are bypassable or dead

Cross-check of backend/plans.js vs enforcement found four gaps (confirmed by audit):

1. **Storage limit trusts client-reported sizes** (routes/files.js:51-53 — `Number(f.size) || 0`
   from the request body). A client sending `size: 0` passes the free-tier 50MB check while
   uploading ~100MB per signed URL. Fix: enforce size at the trusted boundary — validate actual
   object size in Supabase Storage at upload-complete time (`routes/files.js` complete handler /
   backend/services/storage.js), and re-check `storageMb` against real stored sizes there, marking
   the file failed if over limit.
2. **`monthlyEmbeddingChars` is tracked but never enforced.** `trackEmbeddingChars`
   (services/process.js:109) writes the counter and `checkLimit('embeddingChars')` exists in
   services/usage.js:115-117 with zero call sites. Add the check in `services/process.js` before
   the embedding stage (fail the file with a clear `error` status + owner-visible message like
   "monthly embedding quota reached — upgrade your plan" rather than silently stopping).
3. **`filesPerProject` is actually files-per-user.** services/usage.js:107-108 compares the
   user-wide file total against `filesPerProject`; per-project counts are never evaluated. Decide
   which semantic is intended (marketing copy says per-project), then either rename the key to
   `maxFiles` and fix the copy, or implement true per-project enforcement in routes/files.js:48.
4. **Project DELETE doesn't invalidate the embed cache** (routes/projects.js:123-129): a deleted
   project stays servable at `/embed/:publicId/*` for up to 60s via backend/cache.js. Call
   `invalidateProject(publicId)` on delete (and on PATCH, which currently leaks stale widget
   settings for up to 60s too).

---

# P1 — Correctness & wiring

## Prompt C1 — Dead code cleanup pass (backend + frontend)

Audit-confirmed dead code — remove or wire each item, then re-run `npm test` and grep to confirm
nothing references the removed names:

Backend:
1. `routes/embed.js:65` — `module.exports.invalidateProjectCache` is silently discarded because
   `module.exports = router` at :774 replaces the exports object; nothing imports it (projects.js:6
   correctly imports from `../cache`). Delete the dead export assignment.
2. `routes/projects.js:274-278` — `strip()` is a no-op that still returns `webhookSecret` and
   `systemPrompt` in every project GET. Decide intent: if the secret should stay owner-visible
   (it's needed to verify webhook signatures — then document that and delete `strip()`), else
   actually strip it.
3. `services/tiers.js` — `featuresFor()` and `FEATURES_BY_TIER` are exported but never imported;
   route gating only uses `isValidTier`/`meetsTier`. Either delete the map or make the route/tool
   gates use it (Prompt F1 in advanced-features-prompts.md already assumed route-level feature-flag
   checks — if you keep it, wire it).
4. `db.js:226` exports `pool` but nothing uses it. Use it properly: add `pool.end()` to the
   graceful-shutdown handler in server.js:225-229, then the export has a reason to exist
   (or stop exporting it).
5. `middleware/validate.js` `createProject` schema — wire it per Prompt S4, don't delete.

Frontend:
6. `public/js/amplitude-fallback.js`, `public/js/audio-clock.js`, `public/js/viseme-map.js`,
   `public/js/hybrid-lipsync-controller.js` — **none is loaded by any HTML page or by
   lipsync-sdk.js**; they are a diverged, standalone re-implementation of lip-sync machinery that
   the SDK contains inline (they've already drifted — e.g. standalone has `_triggerEmpathy` /
   `AudioClock` drift metrics the SDK lacks). Either delete all four, or finish the refactor to
   have the SDK import them (only viable if you bundle — see Prompt P1-2). Deleting is the honest
   option unless that refactor is committed to.
7. `public/js/api.js` — `API.addUrls` (:108) and `API.request` (:155) have zero callers; delete,
   or wire `addUrls` into project.html's URL ingest UI if multi-URL support is wanted.
8. `public/docs/natural-lipsync.html:57-60` documents the dead files above as the implementation
   and claims a `HybridLipSyncController` lives in lipsync-sdk.js (real class: `LipsyncAvatar` at
   :950). Rewrite that section against the actual SDK code whichever way item 6 resolves.
9. `contact.html:232` ships `CAL_USERNAME = 'YOUR_CAL_USERNAME'` — the booking embed is a
   placeholder. Configure it or replace with a real contact form (could POST to a new
   `/api/contact` route + email via services/email.js).
10. Dead/placeholder links: `index.html:388` links `/blog` (no blog page exists → 404);
    `contact.html:180,188` X + Discord are `#`; `index.html:656-661` GitHub + "Follow on X" are `#`.
    Point them at real URLs or remove.
11. Brand mark is inconsistent across pages (`AP` on index/contact/terms, `A` elsewhere) — unify.

---

## Prompt C2 — Make the documented embed snippet actually work (docs/code reconciliation)

The flagship marketing snippet is broken as documented. `index.html:422-429, 509-516` and
`docs/index.html:118-125` tell users to embed:

```html
<script src=".../lipsync-sdk.js" data-public-id="YOUR_BOT_ID" data-position data-theme data-size>
```

…but `public/lipsync-sdk.js` never reads `data-public-id` or auto-mounts anything (the real
mechanism is `embed-loader.js` with `data-bot` → iframe, as generated in project.html:817). A
customer following the marketing instructions gets a silent no-op.

Fix:
1. Make `lipsync-sdk.js` (or a thin auto-boot wrapper served alongside it) read its own
   `<script>` tag's `data-public-id` (+ `data-position`, `data-theme`, `data-size`) and delegate
   to the existing `embed-loader.js` mount logic — one canonical snippet that actually works.
   Alternatively, change every documented snippet to the loader script; either way, docs and code
   must agree. Regenerate the project.html "Embed" tab snippet from the same source of truth.
2. Two more phantom APIs documented in `public/docs/prefetching.html`: the `useAvatarPlatform`
   React hook (:127-139) and the `ap:open`/`ap:close`/`ap:hide`/`ap:show`/`ap:opened`/`ap:message`
   document events (:110-150) — neither exists in packages/react or embed-loader.js. Implement
   both (the hook is ~20 lines around mountAvatarWidget + postMessage; the event bridge belongs in
   embed-loader.js next to its existing postMessage handling at :286-328) since they're advertised
   in docs and on index.html:520-524 — or strike them from the docs.
3. Fix `prefetching.html:106` — says `/ask` uses `gemini-2.0-flash`; backend uses
   `gemini-2.5-flash` (routes/embed.js:298).
4. Regression test the snippet end-to-end: a bare test HTML page with the documented `<script>`
   tag must boot the widget against a local dev server.

---

## Prompt C3 — Inngest: configure it for production or keep a built-in fallback

backend/inngest/ is mounted (server.js) and `routes/files.js:14` sends `file/process` events, but
there is **no Inngest configuration anywhere in the repo** (no `INNGEST_EVENT_KEY` /
`INNGEST_SIGNING_KEY` references, no setup docs). In dev, inngest targets localhost:8288; on
Vercel without an Inngest account wired up, file-processing events silently never run — uploads
would sit in `uploading`/`processing` forever.

Fix:
1. Document the Inngest setup (project.md Deployment section): env vars, the serve endpoint
   (`/api/inngest`), and how to register functions in the Inngest console for the deployed URL.
2. Add a boot-time check: if file uploads are enabled and neither Inngest keys nor the dev dev
   server are reachable, log an explicit warning.
3. Safer alternative for the current single-app scale: keep Inngest but add an in-process fallback
   (`setImmediate(() => processFile(fileId))` gated by env flag `PROCESS_MODE=inngest|inline`,
   default inline) so deployments without Inngest still process files, and Inngest remains the
   opt-in path for retries/queues. Whichever you choose, make the default deploy work out of the box.

---

# P1 — Performance

## Prompt P1-1 — Caching, batching, and query review (supersedes todays_task task 3)

Items already done since todays_task.md was written: backend/cache.js **is** wired into
routes/embed.js `/config`; static asset caching and index work may be partially done — verify each
before redoing. Remaining concrete items:

1. `express.static(PUBLIC_DIR)` (server.js:112): confirm long-lived immutable Cache-Control for
   hashed/minified assets (`lipsync-sdk.min.js`, css/, js/) and short/no-cache for HTML. If not
   done, add it.
2. `lipsync-sdk.min.js` is gitignored (`.gitignore:10-11`) and `embed.html:12` loads it; fresh
   clones/deploys rely on `postinstall: npm run build` succeeding. Add a boot-time check in
   server.js (or a fallback `<script>` onerror in embed.html that retries with the unminified
   file) so a failed terser build can't take every customer widget offline. Confirm the host-page
   snippet uses `async`/`defer`.
3. Embedding batching: backend/services/embed.js `embedMany` — confirm it batches to the Gemini
   API's per-request content limit (currently check whether large files embed one-by-one in a
   loop) and parallelize with a small concurrency cap (e.g. p-limit 5) while respecting
   `trackEmbeddingChars` accounting.
4. Dashboard N+1: dashboard.html:99-101 fires one `API.listLeads(..., {limit:1})` request **per
   project** just to read `total`. Add `GET /api/projects/lead-counts` (or fold `leadCount` into
   `GET /api/projects`) returning all counts in a single grouped query, and update the page.
5. Index review: supabase/migrations/2026-08-03 added chunks trgm + users reset-token indexes.
   Verify (EXPLAIN ANALYZE) the hot paths: analytics daily charts (routes/analytics.js CTEs over
   messages by project_id+created_at), sessions listing, leads listing (project_id + created_at),
   and messages-by-session — add composite indexes for any seq scans. Sanity-check pg.Pool sizing
   in backend/db.js against Vercel's concurrent-invocation model (Supabase transaction pooler).

---

# P2 — SEO (supersedes todays_task task 2 with audited specifics)

## Prompt SEO — Full SEO pass across 9 marketing + 9 docs pages

Audit baseline: the only SEO tag in the entire frontend is one meta description on index.html:7.
0/18 pages have OG, Twitter, canonical, favicon, or JSON-LD tags. No robots.txt, sitemap.xml, or
favicon exists anywhere.

Do, page by page (marketing: index, pricing, signup, login, contact, characters, terms,
forgot-password, reset-password; docs: public/docs/*.html ×9):
1. Unique `<meta name="description">` per page (pricing, characters, terms, contact are the
   highest-value missing ones).
2. Open Graph (`og:title`, `og:description`, `og:image`, `og:url`, `og:type`) + Twitter Card
   (`twitter:card=summary_large_image` + title/description/image) and canonical `<link>` on every
   page. Centralize via a shared head-partial injected by a small build step or a server-side
   include, so tags don't drift across 18 copies.
3. Favicon: create the asset (brand mark is currently a plain text span `AP`), drop
   favicon.svg/favicon.ico in public/, add `<link rel="icon">` everywhere, and reference it in
   the sitemap/robots below.
4. `public/robots.txt`: allow marketing + docs; disallow the app shells (`/dashboard`, `/project`,
   `/billing`, `/analytics`, `/account`, `/admin`, `/embed`, `/api`, `/e/`) which are crawlable
   static HTML with no server-side page gate. Reference the sitemap.
5. `public/sitemap.xml`: all public marketing + docs URLs with lastmod; referenced from robots.txt.
6. JSON-LD on index.html (`SoftwareApplication` + `Offer`/aggregate for pricing) and
   `FAQPage`/`Product` where natural; keep structured data consistent with visible copy.
7. Heading hygiene: each page already has exactly one `<h1>` (verified) — keep that invariant and
   check no skipped levels in the docs sidebar nav.
8. While in contact/index (Prompt C1 items 9-10): fix the dead `/blog` link and `#` social URLs —
   404s and `#` hrefs hurt crawl quality.

---

# P2 — Tests

## Prompt T1 — Test coverage for the untested core

Current coverage: only plans.js, middleware/auth.js, middleware/validate.js (2 schemas),
services/figures.js (one helper), services/pageImages.js (one helper). All 11 route files and 15
of 20 services have zero tests. Framework is `node --test` (package.json:12) — keep it.

Add, in this order (pure/deterministic first):
1. `services/chunk.js` — semantic chunker + `chunkPages()`: paragraph/sentence splits, heading
   detection, overlap, size bounds, page-number tracking (known historical bug source).
2. `services/csvImport.js` — quiz/flashcard CSV parsers: valid rows, per-row errors, malformed
   input, encoding edge cases.
3. `services/usage.js` `checkLimit()` — boundary values, unlimited plans, custom admin tiers
   (plans.js getPlan fail-closed is already tested; test it through checkLimit).
4. `services/vector.js` + `services/embed.js` pgvector literal serialization from db.js
   (round-trip a vector through insert/query helpers with a mocked pool).
5. Route-level smoke tests with an in-memory HTTP harness (node's built-in `node:test` + express
   app import): auth signup→login→me with real JWT flow, `/embed/:id/config` key-gating
   (Prompt S1 regression), `/embed/:id/log` limit gating, billing webhook signature rejection on
   malformed payloads, admin auth separation (customer token must not pass `adminAuthRequired`).
   Use a disposable test database (env-flagged `DATABASE_URL_TEST`) or mock db.js at the module
   boundary — decide once and apply consistently.
6. Re-run `npm test` and wire it into CI if CI doesn't exist yet (GitHub Actions: install → schema
   check → npm test is the minimum).

---

# P3 — Missing functionality

## Prompt F1 — Wire the orphaned backend endpoints into the UI (or delete)

Three endpoints exist server-side with no frontend consumer:
1. `PATCH /api/projects/:projectId/quiz-questions/:qId` (backend/routes/quizQuestions.js:96) —
   owner-authored quiz questions can be created and deleted from project.html but never **edited**.
   Add edit support in the Quiz tab (inline edit of question/options/correct index/topic tags).
2. `GET /api/projects/:projectId/files/:fileId/blob` (backend/routes/files.js:233) — the
   download-original-source endpoint has no UI. Add a "Download original" action to each file row
   in the Knowledge tab (it redirects to a signed Supabase Storage URL).
3. `GET /embed/:publicId/capture-fields` (backend/routes/embed.js:706) — embed.html consumes
   capture fields from `/config` instead. Keep it only if an external integration uses it
   (document it), otherwise delete.

Also close the inverse of the client-side-filter nit: `API.listChunks` supports server-side
`?search=` (api.js:151) but project.html:1027-1042 filters chunks in-memory — switch to the server
param so large knowledge bases don't load every chunk into the page.

---

## Prompt F2 — Accessibility + polish pass (widget + app)

1. **Widget (embed.html):** move focus into the panel when it opens and restore it to the launcher
   on close; add `aria-expanded` on the launcher button; add a focus trap to the lightbox modal
   (:98-101, Escape already handled); the fatal-error screen (`showFatal()` :1034) is an unstyled
   warning div — style it with the project's themeColor + branding rules, since this is what a
   visitor sees when the owner hits their plan limit.
2. **RTL correctness:** embed.html:244 hard-sets `lang="ar"` for any RTL text — Hebrew and Farsi
   get mislabeled. Detect script (Hebrew/Arabic/other) or drop the lang claim to `lang=""` when
   unknown.
3. **Auth pages have no theme toggle:** login, signup, forgot-password, reset-password don't load
   theme.js while every other non-embed page does. Add theme.js + the toggle mount to all four.
4. **App pages:** project.html tabs (:27-40) are plain buttons — add `role="tablist"`/`role="tab"`
   /`aria-selected` semantics and arrow-key navigation; dashboard create-modal needs an Escape
   handler and focus restore on close; extract the duplicated toast in admin.js:42 into a shared
   micro-module instead of the copy-pasted `adminToast()`.
5. Honor `prefers-reduced-motion` for the Rive idle animations and panel transitions.

---

## Prompt F3 — SDK packages: version sync + publish

packages/{js,react,react-native,vue} are built (dist committed) but: all sit at 0.1.0 while
lipsync-sdk.js is v2.3.0; nothing publishes them; only react/react-native have docs pages
(vue/js are README-only).

1. Single-source the platform version (root package.json `version` or a shared constant) and
   stamp it into all four packages + the SDK banner at build time so docs never drift again.
2. Add a `publish` workflow: changesets or a simple versioned `npm publish` script with provenance,
   run after `npm run build:sdk`. Decide the npm scope (`@avatar-platform/*` is reserved per the
   package names — confirm ownership or rename).
3. Add the missing docs pages for @avatar-platform/js and /vue mirroring react-sdk.html, and link
   all four from index.html's SDK section (currently only React is code-shown).
4. Consider moving `public/js/embed-loader.js` into packages/js as the built artifact so the
   package and the served script can't diverge.

---

## Prompt F4 — Product gaps worth adding (optional, ordered by value)

1. **Email verification on signup.** Auth is email+bcrypt with password-reset tokens already
   working (routes/auth.js, services/email.js) — account confirmation is the natural next step:
   `users.email_verified_at`, a signed 24h verification token reusing the reset-token machinery,
   resend endpoint, and a soft gate (banner) on the dashboard until verified. Keep login allowed
   pre-verification to avoid funnel loss; gate only project creation or go time-based.
2. **Widget analytics for the owner.** Marketing/app pages have zero analytics (no Amplitude/GA/
   Plausible anywhere), and owners only see message counts. Add: conversion funnel on the project
   Analytics tab (sessions → messages → lead captured → lead completed), session duration, and a
   funnel chart; data already exists in sessions/messages/leads tables.
3. **Teams / multi-seat (Business tier differentiator).** Today a project belongs to one user;
   the admin impersonation feature exists precisely because support can't otherwise help. Add an
   optional `project_members` table (role: owner/editor/viewer), invite-by-email via
   services/email.js, and gate by plan (Business only). This is the biggest missing B2B feature
   for a $199 tier.
4. **i18n foundation for the widget.** The widget supports RTL rendering but all strings are
   hardcoded English/Arabic-detection. Extract widget copy into a `messages` dict on the project
   config (owner-editable locale strings in project.html Widget tab) — even without full i18n,
   owners can localize welcome message, input placeholder, and the limit-reached screen.
5. **Conversation export.** Owners can view sessions (routes/projects.js) but can't export them.
   Add CSV download for sessions/leads on the Conversations + Leads tabs (CSV export already
   exists for quiz/flashcard banks in project.html — reuse the pattern).
6. **Webhook reliability.** Webhooks are fire-and-forget per message (routes/embed.js:688). Add a
   `webhook_deliveries` table with retry-with-backoff (Inngest is already available per Prompt C3),
   a delivery log visible on the project settings screen, and a rotate-secret button.

---

# Not prompt-worthy (small fixes to fold into whichever session is open)

- `project.md` Directory Structure section is stale: doesn't list routes/{admin,flashcards,
  quizQuestions,videoResources}.js, services/{accountDelete,auditLog,csvImport,figures,learner,
  pageImages,storage,tiers,tools}.js, backend/inngest/, backend/scripts/, public/docs/, packages/,
  or the Vercel entry api/index.js. Update it whenever a structural prompt above lands.
- `.env.example` is referenced by project.md and README but missing (see Prompt S1 item 2).
- `files.stored_path` / `files.extracted_text` are vestigial (kept on purpose per migration notes)
  — leave alone.
- terms.html "last updated May 15, 2026" — bump whenever legal copy changes.
