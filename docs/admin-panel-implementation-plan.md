# Admin Panel — Gap Analysis & Implementation Plan

Generated 2026-08-28. Scope: `public/admin.html`, `public/js/admin/*`, `backend/routes/admin*.js`, `backend/services/settings.js`, plus cross-reference against `supabase/schema.sql`.

## Phase 0: Audit Findings (Documentation Discovery)

### What already works (do not rebuild)
- Auth: `adminAuthRequired` (`backend/middleware/auth.js:67-79`) — structurally separate admin JWT (`{aid, isAdmin:true}`), enforced router-wide via `router.use(adminAuthRequired)` in `adminCharacters.js`, `adminCoupons.js`, `adminSettings.js`, and per-route in `admin.js`.
- Frontend pattern: `public/js/admin/core.js` — `AdminAPI` fetch map (`core.js:39-73`), `TABS` registry + `switchTab()` (`core.js:162-169`), each tab file self-registers via `TABS.x = loadXTab` at file bottom. **New tabs never require editing `core.js`.**
- Audit logging: every mutating admin route writes to `admin_audit_log` (see `admin.js:229-282`, `adminCharacters.js` calls throughout, `adminCoupons.js`, `adminSettings.js`). New admin mutations must follow this same pattern.
- Validation: `backend/middleware/validate.js` holds one schema per admin mutation (e.g. `adminPatchUser`, `tierUpsert`, `adminSettingUpdate`). New routes must add a schema here, not inline-validate.
- Modal/table helpers: `openModal`/`closeModal`/`renderPagination` in `core.js:112-158` — reuse these rather than writing new modal/pagination code.

### Confirmed gaps (from 3-agent audit, all citations verified against source)
1. **Tier edit has no UI.** Backend `PATCH /api/admin/tiers/:tierId` exists (`admin.js:245`) and `AdminAPI.updateTier` is defined (`core.js:49`) but never called — `public/js/admin/tiers.js` only wires Create/Delete.
2. **Coupons can't be edited or deleted** beyond active/inactive toggle. No `deleteCoupon` exists in `AdminAPI` or backend.
3. **Webhook deliveries have no admin route/UI.** `webhook_deliveries` table (`schema.sql:714-735`) and `backend/services/webhookDelivery.js` are only reachable via owner-scoped routes in `projects.js`. Admin can't see cross-tenant delivery failures or retry a stuck delivery.
4. **Team members (`project_members`) have no admin visibility.** Table added in commit `cacbc02`, owner-only routes in `projects.js:154/171/203`.
5. **Widget text overrides have no admin visibility/moderation.** `projects.widget_messages` JSONB (commit `ff0beff`), owner-only via `embed.js`.
6. **No platform-wide analytics.** `backend/routes/analytics.js` is entirely `authRequired` (project-owner scoped); no admin rollup of sessions/messages/funnel/session-duration (commit `bc3a765`) across all customers.
7. **No aggregate usage/cost dashboard.** `backend/services/usage.js#getUsageSnapshot` is only called per-user inside `GET /admin/users/:id`. No "who's near their cap" or "total Gemini spend" view.
8. **No system health / error dashboard.** Only `GET /healthz` (`server.js:121`), unauthenticated, not in admin UI.
9. **No content moderation.** `messages`/`sessions` tables hold full transcripts; admin only ever sees counts via `getUsageSnapshot`, never content.
10. **No feature-flag system.** Confirmed absent by grep; nothing to build on top of, this is greenfield if pursued.
11. **No admin-user (operator account) management route** — only `backend/scripts/create-admin.js` CLI. Likely intentional (avoids privilege-escalation-by-API) — flagged, not necessarily a gap to close.
12. Stripe plan pricing (`backend/plans.js`) is intentionally code-defined, not an admin gap (per existing schema comment).

### Priority ranking (impact vs. effort, decided by scope of existing patterns to reuse)
- **Phase 1** (hours, pure CRUD completion, zero new tables): tier edit, coupon edit/delete.
- **Phase 2** (new admin routes over existing tables, no schema changes): webhook delivery visibility + retry, team-member visibility, widget-override visibility.
- **Phase 3** (new aggregate queries, no schema changes): platform analytics rollup, aggregate usage/cost dashboard.
- **Phase 4** (small new surface, mostly wiring): system health dashboard tab.
- **Phase 5** (product decisions required before building — see "Needs a decision" below): content moderation, feature flags, admin-user management, email templates.

---

## Phase 1: Complete existing CRUD (Tiers, Coupons)

### 1a. Tier edit
**Implement:** Add an "Edit" button per row in `public/js/admin/tiers.js` (`tiers.js:35-73`, next to the existing Delete button) that opens a form pre-filled with the tier's current values and calls the **already-existing** `AdminAPI.updateTier(id, body)` → `PATCH /api/admin/tiers/:id`.
**Pattern to copy:** Reuse the same 6-field form markup already in `tiers.js:5-17` (create form) — don't invent new fields. Reuse `openModal`/`closeModal` from `core.js:136-158` for the edit dialog, matching how `characters.js` and `coupons.js` open modals.
**Backend:** No change needed — `admin.js:245` (`PATCH /tiers/:tierId`) and its `validate(tierUpsert)` schema already handle this.
**Verify:** Edit a tier's `monthlyMessages` limit from the panel, confirm the change persists on reload and appears correctly in `users.js`'s override dropdown (which calls `listTiers`).
**Anti-pattern guard:** Do not add a new backend endpoint — `PATCH /api/admin/tiers/:id` already exists and is tested by its `validate(tierUpsert)` schema; only frontend work is needed here.

### 1b. Coupon edit
**Implement:** Extend the coupon row actions in `coupons.js` with an "Edit" action that reopens `openCreateCouponModal`'s form (`coupons.js:77-189`) pre-filled with the coupon's current code/discount/plans/caps/expiry, then calls `AdminAPI.patchCoupon(id, body)` (already defined, `core.js`) with the full field set instead of only `{active}`.
**Backend:** `adminCoupons.js:53` (`PATCH /:id`) already accepts arbitrary field updates via `services/coupons.js` — confirm which fields it forwards vs. only handles `active`; if the service function only supports the active-toggle path, extend `backend/services/coupons.js` to accept and persist code/discount/plan/cap/expiry updates, following the same validation shape as `createCoupon`.
**Note on Stripe sync:** Coupons are paired with real Stripe Coupon + Promotion Code objects (per the backend audit). Changing `discountType`/`discountValue` after creation is **not possible in Stripe** (coupons are immutable there) — the edit UI must only allow updating fields Stripe permits changing (e.g., plan restrictions stored locally, expiry if not already Stripe-enforced) and must disable/gray out immutable fields, or the edit action should be scoped to "deactivate + create replacement" instead of true in-place edit. **Resolve this before implementing** — see "Needs a decision" below.

### 1c. Coupon delete
**Implement:** Add `deleteCoupon` to `AdminAPI` (`core.js`) → new backend route `DELETE /api/admin/coupons/:id` in `adminCoupons.js`, following the same audit-log + confirm() pattern as tier delete (`tiers.js:65-67`) and character deletion patterns elsewhere.
**Backend:** Decide whether delete should be a hard delete or should require zero redemptions (mirror the tier-delete 409-if-in-use pattern at `admin.js:258`). Recommend: block hard delete if `coupon_redemptions` has rows for this coupon (preserve revenue/audit history), only allow delete for never-used coupons; otherwise force deactivate.
**Verify:** Deleting a used coupon returns 409; deleting an unused coupon removes it from the list and from Stripe (must also revoke the Stripe Promotion Code, mirroring how `createCoupon` created it).

---

## Phase 2: Admin visibility into existing cross-tenant data

### 2a. Webhook delivery admin route + tab
**Implement:** New `backend/routes/adminWebhooks.js` mounted at `/api/admin/webhooks`, `router.use(adminAuthRequired)`, exposing:
- `GET /` — paginated list across **all** projects, joining `webhook_deliveries` with `projects` for tenant/name context (mirror the join style in `admin.js:100-135`'s user detail query).
- `GET /:projectId` — deliveries for one project (reuse existing service logic from `backend/services/webhookDelivery.js`, don't duplicate delivery-fetching logic).
- `POST /:id/retry` — manually re-trigger a failed delivery; audit-logged as `webhook_retry`.
**Frontend:** New tab `#tab-webhooks` in `admin.html` (extend the `#tab-bar` list at `admin.html:38-43`) + `public/js/admin/webhooks.js` following the exact `TABS.x = loadXTab` self-registration pattern from `audit.js:37` (closest analog — also a mostly-read-only paginated table with one action button).
**Verify:** Simulate a failing webhook (or use test fixtures from `backend/routes/webhookRoutes.test.js` if present) and confirm it surfaces in the admin list with correct project attribution, and retry triggers a new delivery attempt.
**Anti-pattern guard:** Do not re-implement delivery/signing logic — call into `backend/services/webhookDelivery.js`'s existing exports.

### 2b. Team members (project_members) admin visibility
**Implement:** Extend `GET /api/admin/users/:id` (`admin.js:100`) to also return, for each project owned by the user, the list of `project_members` (name/email/role/invited_at) — this is a read-only addition to an existing response, not a new route.
**Frontend:** Extend `renderUserDetail` in `users.js:65-166` — add a "Team members" sub-table under the existing read-only projects table, matching that table's styling.
**Verify:** A user with an invited teammate shows that teammate under their project in the admin user-detail view.

### 2c. Widget text override visibility
**Implement:** Same pattern as 2b — include `widget_messages` (read-only) in the project rows already returned by `GET /admin/users/:id`, rendered as a collapsible/expandable JSON or key-value view per project in `users.js`.
**Decide before building:** Should admin be able to **clear/reset** an override (moderation action) or only view it? If moderation is required, add `PATCH /api/admin/projects/:id/widget-messages` with a `{clear: true}` or full-replace body, audit-logged — see "Needs a decision" below.

---

## Phase 3: Platform-wide analytics & cost dashboard

### 3a. Aggregate analytics route
**Implement:** New `backend/routes/adminAnalytics.js` at `/api/admin/analytics`, `adminAuthRequired`, exposing:
- `GET /overview` — platform totals: total projects, total sessions/messages (last 24h/7d/30d), aggregate funnel conversion (reuse the funnel query logic added in `bc3a765` inside `analytics.js:157-212`, parameterized to remove the per-project `WHERE project_id = ?` filter and add a `GROUP BY project_id` for a top-N breakdown instead).
- `GET /top-projects` — top projects by message volume/session count, for spotting abuse or highest-value customers.
**Frontend:** New "Analytics" tab following the `TABS` pattern, using stat-card/table layout (no charting library currently in the codebase — confirm before adding one; plain numeric summary tables are consistent with the rest of the panel's minimal style).
**Verify:** Numbers on the new admin overview reconcile with the sum of individual project analytics pages for a small manual sample (e.g., 3 known projects).
**Anti-pattern guard:** Do not duplicate the funnel-stage SQL from `analytics.js` — factor the shared query into `backend/services/` if it needs to be called both per-project and platform-wide, rather than copy-pasting.

### 3b. Aggregate usage/cost dashboard
**Implement:** Extend `backend/services/usage.js` with a `getUsageAcrossUsers()`/`getUsersNearingLimits(threshold)` function (aggregate query, not N+1 per-user calls), exposed via `GET /api/admin/usage/overview` in `admin.js` or a new `adminUsage.js` route.
**Frontend:** Table of users sorted by usage-to-limit ratio (highest first) so admin can spot accounts about to hit caps or that are costing the most in Gemini spend, reusing `renderPagination` from `core.js`.
**Verify:** Cross-check the top-of-list "closest to limit" user against their individual `GET /admin/users/:id` usage bars for consistency.

---

## Phase 4: System health tab

**Implement:** New `GET /api/admin/health` (admin-authenticated, unlike the public `/healthz`) returning: DB connectivity check, Redis/rate-limit-store backend status (`rateLimitStore.js` already knows which backend it's using), count of webhook deliveries currently in a failed/exhausted-retry state (reuses Phase 2a's data), and recent 5xx error count if any error-logging table/service exists (check for one before assuming — if none exists, skip this sub-metric rather than inventing a logging table in this phase).
**Frontend:** New "Health" or "System" tab — a handful of stat cards, no new interaction patterns needed.
**Verify:** Kill/restart the Redis connection locally (if used) and confirm the health tab reflects the fallback-to-in-memory state.

---

## Phase 5: Decisions resolved — build specs

Decisions made 2026-08-28:

### 5a. Chat transcript viewing — full searchable access
**Implement:** New `backend/routes/adminSessions.js` at `/api/admin/sessions`, `adminAuthRequired`:
- `GET /` — paginated, filterable (project id, user email, date range) list across all projects, joining `sessions` → `projects` → `users` for attribution (mirror the join style in `admin.js:100-135`).
- `GET /:id/messages` — full transcript for one session, paginated if long.
**Frontend:** New "Sessions" tab, `public/js/admin/sessions.js`, following the `TABS.x = loadXTab` pattern — a filterable list (reuse `renderPagination`) that drills into a transcript view (reuse `openModal` or a dedicated panel like `characters.js`'s manage-character modal).
**Note:** This exposes end-user conversation content to platform operators — no read-audit-log entry currently exists for *read* actions (only mutations are audit-logged elsewhere). Add an audit log entry (`session_transcript_viewed`) on `GET /:id/messages` specifically, since this is the one new read path sensitive enough to warrant a trail of who looked at what.
**Anti-pattern guard:** Do not add search-by-content (full-text search across message bodies) in this pass — that's a larger indexing concern; ship id/project/user/date filtering only.

### 5b. Coupon "edit" — replace flow
**Implement:** In `coupons.js`, add an "Edit" action per row that: (1) calls existing `AdminAPI.patchCoupon(id, {active:false})` to deactivate the old coupon, (2) opens the existing `openCreateCouponModal` pre-filled with the old coupon's discount/plans/caps/expiry values but an **empty code field** (Stripe promo codes must be unique; prompt the admin to enter a new code — pre-suggest `${oldCode}-2` as a default, editable).
**Backend:** No new endpoint — this is a frontend-only orchestration of two existing calls (`patchCoupon` + `createCoupon`).
**Verify:** Editing a coupon deactivates the original (confirm old code no longer redeemable, e.g. via `validateCoupon` in `backend/services/coupons.js`) and the new coupon redeems correctly with updated terms.

### 5c. Widget override — view + clear
**Implement:** Building on Phase 2c's read-only display: add `PATCH /api/admin/projects/:id/widget-messages` in a new `backend/routes/adminProjects.js` (or extend `admin.js` if a project-scoped admin route file doesn't otherwise exist yet — check before creating a new file), accepting `{clear: true}` → sets `projects.widget_messages` to `NULL`/`{}`; audit-logged as `widget_override_cleared`.
**Frontend:** "Clear override" button next to the read-only display added in Phase 2c, with a `confirm()` guard matching the pattern in `tiers.js:65` / `users.js:156-158`.

### 5d. Admin (operator) accounts — no change
Confirmed: stays CLI-only (`backend/scripts/create-admin.js`). Not in scope for this build.

### 5e. Feature flags — simple global flags (infra only)
**Implement:** New table `feature_flags (key TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT false, description TEXT, updated_at BIGINT NOT NULL, updated_by UUID REFERENCES admin_users(id))` via a new migration + append to `schema.sql`, following the exact shape of `admin_settings` (`supabase/migrations/2026-08-28_add_admin_settings.sql`) since the access pattern (admin toggles a key, app reads it with a short-TTL cache) is identical.
**Backend:** `backend/services/featureFlags.js` mirroring `backend/services/settings.js` structure exactly — `isEnabled(key)`, `setFlag(key, enabled, description)`, `listFlags()`, same in-process cache/TTL approach (`settings.js:20`). New `backend/routes/adminFeatureFlags.js` at `/api/admin/feature-flags` mirroring `adminSettings.js` route-for-route (`GET /`, `PUT /:key`).
**Frontend:** New "Feature Flags" tab, structurally a near-copy of `settings.js`'s pattern (list of toggles instead of text inputs) — but flags are **admin-defined** (no fixed `SETTINGS_META` list), so the UI needs an "Add flag" form (key + description) in addition to the toggle list.
**Scope guard:** This phase ships infrastructure only — no actual feature in the codebase should be gated behind a flag yet (no concrete driving use case exists per the decision made). Do not invent a flag to "prove it works"; an empty flag list post-build is correct and expected.

### 5f. Email templates — DB-backed and editable
**Implement:** New table `email_templates (key TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL, updated_at BIGINT NOT NULL, updated_by UUID REFERENCES admin_users(id))` via migration + `schema.sql` append. Seed migration inserts the five current hardcoded templates (`password_reset`, `verification`, `team_invite`, `welcome`, `contact_message`) with their exact current subject/body from `backend/services/email.js:57-175`, so the DB starts as a byte-for-byte mirror of today's behavior.
**Backend:** Modify `backend/services/email.js`'s five send functions to load `subject`/`body` via a new `backend/services/emailTemplates.js` (`getTemplate(key)`, DB-first with the current hardcoded string as fallback if the DB row is ever missing — same fallback philosophy as `settings.js:35-52`'s env fallback), then interpolate existing placeholder variables (check each function for what variables it currently substitutes, e.g. reset link, invite link — preserve exact placeholder syntax so seeded rows work unmodified). New `backend/routes/adminEmailTemplates.js` at `/api/admin/email-templates` (`GET /`, `PUT /:key`) mirroring `adminSettings.js`.
**Frontend:** New "Email Templates" tab — list of 5 templates, click to edit subject/body in a modal (reuse `openModal`), show available placeholder variables as help text per template.
**Verify:** After seeding, trigger each of the 5 email types (or their existing tests, e.g. check for template-related tests near `auth.test.js`) and confirm output is byte-identical to pre-migration behavior; then edit one template from the admin panel and confirm the next send reflects the change.
**Anti-pattern guard:** Do not build a generic templating engine (Handlebars/Mustache) if the current code only does simple string interpolation — match the existing substitution mechanism exactly, don't upgrade it as a side effect of this phase.

---

## Final Verification Checklist (run after each phase)

- [ ] Every new mutating route has: `adminAuthRequired`, a `validate.js` schema, and an `admin_audit_log` write.
- [ ] Every new frontend tab is registered via `TABS.x = loadXTab` and added to `admin.html`'s tab bar — no changes needed to `core.js`'s tab-switching logic itself.
- [ ] `grep -rn "TODO\|coming soon\|not implemented" public/js/admin/ backend/routes/admin*.js` returns nothing new.
- [ ] No new endpoint duplicates logic already in `backend/services/*` — grep for the service function name before writing a new SQL query inline in a route.
- [ ] Existing test files (`admin.js` has none currently — `auth.test.js`, `projects.test.js`, `embed.test.js`, `webhookRoutes.test.js`, `billingWebhook.test.js` are the existing patterns) — add a `.test.js` alongside any new route file, following the structure of the closest existing one (e.g., new webhook admin route tests should mirror `webhookRoutes.test.js`'s setup).
