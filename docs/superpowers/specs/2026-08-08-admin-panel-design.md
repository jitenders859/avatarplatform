# Admin panel (user management, custom limit tiers, impersonation)

**Files:** `supabase/schema.sql`, `supabase/migrations/2026-08-08_add_admin_panel.sql` (new), `backend/plans.js`, `backend/services/usage.js`, `backend/middleware/auth.js`, `backend/services/accountDelete.js` (new), `backend/services/auditLog.js` (new), `backend/routes/admin.js` (new), `backend/routes/auth.js`, `backend/server.js`, `backend/middleware/validate.js`, `backend/scripts/create-admin.js` (new), `public/admin.html` (new), `public/js/admin.js` (new)
**Status:** Approved, ready for implementation plan

## Context

The platform has no admin surface today. `backend/plans.js` defines four fixed plan tiers (free/starter/pro/business) with hardcoded limits; `backend/services/usage.js`'s `userPlanId()` resolves a user's plan purely from their Stripe-backed `subscriptions` row (`status='active'` → `planId`, else `'free'`), and `checkLimit()` enforces those limits with no per-account override anywhere. There's also no `role`/`is_admin` concept on `users` — every logged-in user shares the same `authRequired` JWT path.

Goal: let the operator (a) view all accounts and their usage, (b) grant an individual account higher limits without needing a real Stripe subscription for it, (c) suspend or delete an account, (d) view (read-only) a user's projects, and (e) temporarily "view as" a user for support, all from a dedicated, fully-isolated admin login — separate from customer auth entirely, so a compromised customer account can never reach admin routes and vice versa.

Confirmed during brainstorming:
- Admin login is a **separate credential system** (`admin_users` table, own bcrypt-hashed passwords), not a role flag on the customer `users` table and not a shared env-var password.
- Limit increases work by assigning an account to a **custom plan tier**, stored in a new DB table and editable from the panel itself (not hardcoded in `plans.js`, not a per-field override on the user row). This tier assignment **overrides** whatever the Stripe subscription says.
- Impersonation issues a real, short-lived customer JWT (15 min) rather than a read-only snapshot — opens the actual dashboard in a new tab.
- Suspension blocks both dashboard login and API access (`authRequired` itself rejects), not just login.
- Project visibility from the admin panel is **read-only** — no edit/delete of a user's projects from admin; that's what impersonation is for.
- UI is a single page (`admin.html`) with tabbed sections (Users / Tiers / Audit Log), matching the lightweight vanilla-JS style of the rest of `public/*.html`, using its own `admin_token` localStorage key so an admin session and a customer session can coexist in the same browser without clobbering each other.

Out of scope for this round: 2FA for admin accounts, self-serve admin signup, editing a user's project content from the panel, per-field limit overrides independent of tiers, email notifications on suspend/tier-change.

---

## Part 1 — Schema

`supabase/schema.sql` is the single idempotent source of truth (no migration runner — see its header); new tables get appended there, and the same statements are captured as a standalone dated file per existing convention.

**New file `supabase/migrations/2026-08-08_add_admin_panel.sql`** (also appended to `schema.sql`):

```sql
-- ── admin_users ───────────────────────────────────────────────────
-- Fully separate from the customer `users` table/auth path by design —
-- see docs/superpowers/specs/2026-08-08-admin-panel-design.md. No
-- self-serve signup; seeded via backend/scripts/create-admin.js.
CREATE TABLE IF NOT EXISTS admin_users (
  id            UUID        PRIMARY KEY,
  email         TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    BIGINT      NOT NULL
);

-- ── plan_tiers ────────────────────────────────────────────────────
-- Admin-defined limit sets, independent of the static PLANS array in
-- backend/plans.js (those stay code-defined since they're tied to real
-- Stripe price IDs). A user's `admin_plan_id` (see below) points here.
CREATE TABLE IF NOT EXISTS plan_tiers (
  id          TEXT        PRIMARY KEY,   -- slug, e.g. "custom-acme-corp"
  name        TEXT        NOT NULL,
  limits      JSONB       NOT NULL,      -- { projects, filesPerProject, storageMb, monthlyMessages, monthlyEmbeddingChars, urlSources }
  created_by  UUID        REFERENCES admin_users(id),
  created_at  BIGINT      NOT NULL,
  updated_at  BIGINT
);

-- ── users: suspension + admin plan override ──────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_plan_id   TEXT REFERENCES plan_tiers(id);

-- ── admin_audit_log ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id              UUID    PRIMARY KEY,
  admin_id        UUID    NOT NULL REFERENCES admin_users(id),
  action          TEXT    NOT NULL,   -- e.g. 'suspend', 'unsuspend', 'assign_tier', 'clear_tier', 'delete_user', 'impersonate', 'tier_create', 'tier_update', 'tier_delete'
  target_user_id  UUID    REFERENCES users(id),
  meta            JSONB,
  created_at      BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log (created_at DESC);
```

No `TABLE_MAP` entry needed in `backend/db.js` — all three new table names are already snake_case, called directly as literal strings (`db.insert('admin_users', ...)` etc.), same pattern as `users`/`subscriptions`/`usage`.

---

## Part 2 — Plan resolution changes

**`backend/plans.js`**: `getPlan` becomes async so it can fall back to `plan_tiers` for ids the static array doesn't know about:

```js
const db = require('./db');

async function getPlan(id) {
  const stat = PLANS.find(p => p.id === id);
  if (stat) return stat;
  if (id) {
    const custom = await db.findOne('plan_tiers', { id });
    if (custom) return { id: custom.id, name: custom.name, priceMonthly: 0, limits: custom.limits, features: [], custom: true };
  }
  return PLANS[0]; // free
}
```

Circular-require note: `plans.js` currently has no dependency on `db.js`; `db.js` has no dependency on `plans.js`, so this is safe to add directly.

Call sites get `await`:
- `backend/services/usage.js:77` — `const plan = await getPlan(planId);`
- `backend/routes/billing.js:38` — `const plan = await getPlan(planId);`
- `backend/routes/billing.js:74` — `const plan = await getPlan(planId);` (checkout still correctly rejects custom tiers here since they have no `stripePriceId` — unchanged behavior, just now resolves the real tier name instead of silently mis-attributing to `free`)

**`backend/services/usage.js`**: `userPlanId()` checks the admin override first:

```js
async function userPlanId(userId) {
  const user = await db.findOne('users', { id: userId });
  if (user?.adminPlanId) return user.adminPlanId;
  const sub = await db.findOne('subscriptions', { userId, status: 'active' });
  return sub ? sub.planId : 'free';
}
```

This is an intentional extra `users` lookup (previously this function only queried `subscriptions`) — acceptable given `getUsageSnapshot` already does a similar-cost query per call and this isn't a hot path (called on billing/usage page loads and limit checks, not per-chat-message). `admin_plan_id` deliberately lives outside the `subscriptions`/Stripe-webhook flow entirely (not as a synthetic `subscriptions` row) — `billing.js`'s webhook handler does `DELETE FROM subscriptions WHERE user_id = $1 AND status = 'active' AND id != $2` when a real Stripe subscription activates, which would silently wipe out a synthetic admin row if it lived in that table. Keeping it as a separate column on `users` means an admin grant survives Stripe billing changes and is only ever cleared explicitly from the admin panel.

---

## Part 3 — Auth middleware changes

**`backend/middleware/auth.js`**:

```js
async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.findOne('users', { id: payload.uid });
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.suspended) return res.status(403).json({ error: 'This account has been suspended' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function signToken(userId, opts = {}) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: opts.expiresIn || '30d' });
}

async function adminAuthRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing admin auth token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.isAdmin) return res.status(401).json({ error: 'Invalid admin token' });
    const admin = await db.findOne('admin_users', { id: payload.aid });
    if (!admin) return res.status(401).json({ error: 'Admin not found' });
    req.admin = admin;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

function signAdminToken(adminId) {
  return jwt.sign({ aid: adminId, isAdmin: true }, JWT_SECRET, { expiresIn: '12h' });
}

module.exports = { authRequired, signToken, adminAuthRequired, signAdminToken, JWT_SECRET };
```

Isolation is structural, not just a payload flag left unchecked: `authRequired` looks up `payload.uid` in `users` (an admin token has no `uid`, so `db.findOne` returns `null` → 401); `adminAuthRequired` requires `payload.isAdmin === true` and looks up `payload.aid` in `admin_users` (a customer token has neither → 401). Both use the existing `JWT_SECRET` — no new env var — the isolation comes from disjoint payload shapes and disjoint lookup tables, not a second secret.

---

## Part 4 — Shared account-delete helper

**`backend/services/accountDelete.js`** (new — extracted verbatim from `auth.js`'s current `DELETE /me`, no behavior change):

```js
const db = require('../db');
const logger = require('../logger').child({ module: 'accountDelete' });

async function deleteUserAccount(userId) {
  const user = await db.findOne('users', { id: userId });
  if (!user) return;
  if (user.stripeCustomerId) {
    try {
      const { getStripe } = require('./stripe');
      const stripe = getStripe();
      if (stripe) {
        const subs = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: 'active', limit: 10 });
        await Promise.all(subs.data.map(s => stripe.subscriptions.cancel(s.id)));
      }
    } catch (e) {
      logger.warn({ err: e.message, userId }, 'failed to cancel Stripe subscription on account delete');
    }
  }
  await db.remove('users', { id: userId });
}

module.exports = { deleteUserAccount };
```

`backend/routes/auth.js`'s `DELETE /me` becomes:
```js
router.delete('/me', authRequired, async (req, res) => {
  await deleteUserAccount(req.user.id);
  res.json({ ok: true });
});
```

---

## Part 5 — Audit log helper

**`backend/services/auditLog.js`** (new):

```js
const crypto = require('crypto');
const db = require('../db');

async function logAdminAction(adminId, action, targetUserId, meta = {}) {
  await db.insert('admin_audit_log', {
    id: crypto.randomUUID(),
    adminId,
    action,
    targetUserId: targetUserId || null,
    meta,
    createdAt: Date.now(),
  });
}

module.exports = { logAdminAction };
```

---

## Part 6 — `backend/routes/admin.js` (new)

All routes except `/login` go through `adminAuthRequired`. Validation follows the existing `validate(schema)` pattern from `backend/middleware/validate.js`; new schemas (`adminLogin`, `assignTier`, `tierUpsert`) are added there alongside the existing ones.

```js
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { adminAuthRequired, signAdminToken, signToken } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { getUsageSnapshot } = require('../services/usage');
const { deleteUserAccount } = require('../services/accountDelete');
const { logAdminAction } = require('../services/auditLog');

const router = express.Router();

// ── Auth ──────────────────────────────────────────────────────
router.post('/login', validate(schemas.adminLogin), async (req, res) => {
  const { email, password } = req.body;
  const admin = await db.findOne('admin_users', { email });
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = signAdminToken(admin.id);
  res.json({ token, admin: { id: admin.id, email: admin.email } });
});

router.get('/me', adminAuthRequired, (req, res) => {
  res.json({ admin: { id: req.admin.id, email: req.admin.email } });
});

// ── Users ─────────────────────────────────────────────────────
router.get('/users', adminAuthRequired, async (req, res) => {
  const search = (req.query.search || '').trim();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = 25;
  const offset = (page - 1) * pageSize;

  const where = search ? `WHERE u.email ILIKE $1 OR u.name ILIKE $1` : '';
  const params = search ? [`%${search}%`] : [];

  const rows = await db.query(
    `SELECT u.id, u.email, u.name, u.created_at, u.suspended, u.admin_plan_id,
            s.plan_id AS stripe_plan_id, s.status AS sub_status
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active'
       ${where}
       ORDER BY u.created_at DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
    params
  );
  const [{ count }] = await db.query(`SELECT COUNT(*)::int AS count FROM users u ${where}`, params);

  res.json({
    users: rows.map(r => ({
      id: r.id, email: r.email, name: r.name, createdAt: r.createdAt, suspended: r.suspended,
      planId: r.adminPlanId || r.stripePlanId || 'free',
      planSource: r.adminPlanId ? 'admin' : (r.stripePlanId ? 'stripe' : 'free'),
    })),
    page, pageSize, total: count,
  });
});

router.get('/users/:id', adminAuthRequired, async (req, res) => {
  const user = await db.findOne('users', { id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const [snapshot, projects, subs] = await Promise.all([
    getUsageSnapshot(user.id),
    db.query(
      `SELECT p.id, p.name, p.character_id, p.created_at,
              COUNT(f.id)::int AS file_count
         FROM projects p LEFT JOIN files f ON f.project_id = p.id
        WHERE p.user_id = $1 GROUP BY p.id ORDER BY p.created_at DESC`,
      [user.id]
    ),
    db.query(`SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC`, [user.id]),
  ]);

  res.json({
    user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt, suspended: user.suspended, adminPlanId: user.adminPlanId },
    usage: snapshot,
    projects,
    subscriptions: subs,
  });
});

router.patch('/users/:id', adminAuthRequired, async (req, res) => {
  const user = await db.findOne('users', { id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { suspended, adminPlanId } = req.body || {};
  const patch = {};

  if (suspended !== undefined) patch.suspended = !!suspended;

  if (adminPlanId !== undefined) {
    if (adminPlanId) {
      const tier = await db.findOne('plan_tiers', { id: adminPlanId });
      if (!tier) return res.status(400).json({ error: 'Unknown plan tier' });
    }
    patch.adminPlanId = adminPlanId || null;
  }

  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
  const updated = await db.update('users', user.id, patch);

  if (suspended !== undefined) await logAdminAction(req.admin.id, suspended ? 'suspend' : 'unsuspend', user.id);
  if (adminPlanId !== undefined) await logAdminAction(req.admin.id, adminPlanId ? 'assign_tier' : 'clear_tier', user.id, { adminPlanId });

  res.json({ user: { id: updated.id, suspended: updated.suspended, adminPlanId: updated.adminPlanId } });
});

router.delete('/users/:id', adminAuthRequired, async (req, res) => {
  const user = await db.findOne('users', { id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found' });
  await logAdminAction(req.admin.id, 'delete_user', user.id, { email: user.email });
  await deleteUserAccount(user.id);
  res.json({ ok: true });
});

router.post('/users/:id/impersonate', adminAuthRequired, async (req, res) => {
  const user = await db.findOne('users', { id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.suspended) return res.status(400).json({ error: 'Cannot impersonate a suspended account' });
  const token = signToken(user.id, { expiresIn: '15m' });
  await logAdminAction(req.admin.id, 'impersonate', user.id);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

// ── Plan tiers ────────────────────────────────────────────────
router.get('/tiers', adminAuthRequired, async (req, res) => {
  res.json({ tiers: await db.query('SELECT * FROM plan_tiers ORDER BY created_at DESC') });
});

router.post('/tiers', adminAuthRequired, validate(schemas.tierUpsert), async (req, res) => {
  const { name, limits } = req.body;
  const id = 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + crypto.randomBytes(3).toString('hex');
  const tier = await db.insert('plan_tiers', { id, name, limits, createdBy: req.admin.id, createdAt: Date.now() });
  await logAdminAction(req.admin.id, 'tier_create', null, { tierId: id, name });
  res.json({ tier });
});

router.patch('/tiers/:id', adminAuthRequired, validate(schemas.tierUpsert), async (req, res) => {
  const existing = await db.findOne('plan_tiers', { id: req.params.id });
  if (!existing) return res.status(404).json({ error: 'Tier not found' });
  const { name, limits } = req.body;
  const tier = await db.update('plan_tiers', existing.id, { name, limits });
  await logAdminAction(req.admin.id, 'tier_update', null, { tierId: existing.id, name });
  res.json({ tier });
});

router.delete('/tiers/:id', adminAuthRequired, async (req, res) => {
  const inUse = await db.findOne('users', { adminPlanId: req.params.id });
  if (inUse) return res.status(409).json({ error: 'Tier is still assigned to at least one user' });
  await db.remove('plan_tiers', { id: req.params.id });
  await logAdminAction(req.admin.id, 'tier_delete', null, { tierId: req.params.id });
  res.json({ ok: true });
});

// ── Audit log ─────────────────────────────────────────────────
router.get('/audit-log', adminAuthRequired, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = 50;
  const rows = await db.query(
    `SELECT l.*, a.email AS admin_email, u.email AS target_email
       FROM admin_audit_log l
       LEFT JOIN admin_users a ON a.id = l.admin_id
       LEFT JOIN users u ON u.id = l.target_user_id
      ORDER BY l.created_at DESC LIMIT $1 OFFSET $2`,
    [pageSize, (page - 1) * pageSize]
  );
  res.json({ entries: rows, page, pageSize });
});

module.exports = router;
```

`backend/middleware/validate.js` additions:
```js
adminLogin: z.object({ email, password: z.string().min(1, 'Password is required') }),

tierUpsert: z.object({
  name: z.string().min(1, 'Name is required').max(80, 'Name too long').trim(),
  limits: z.object({
    projects: z.number().int().positive(),
    filesPerProject: z.number().int().positive(),
    storageMb: z.number().int().positive(),
    monthlyMessages: z.number().int().positive(),
    monthlyEmbeddingChars: z.number().int().positive(),
    urlSources: z.number().int().positive(),
  }),
}),
```

**`backend/server.js`** mounting (grouped with the other API routes, reusing the existing `apiLimiter`; admin login additionally gets the existing `authLimiter` treatment applied the same way `/api/auth` gets it, to bound brute-force attempts):
```js
const adminRoutes = require('./routes/admin');
...
app.use('/api/admin/login', authLimiter);
app.use('/api/admin', apiLimiter, adminRoutes);
```
(the header comment block listing route groups gets a `/api/admin/*  admin panel` line added)

---

## Part 7 — Seeding the first admin

**`backend/scripts/create-admin.js`** (new, one-off CLI):
```js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');

async function main() {
  const [, , email, password] = process.argv;
  if (!email || !password) {
    console.error('Usage: node backend/scripts/create-admin.js <email> <password>');
    process.exit(1);
  }
  const existing = await db.findOne('admin_users', { email: email.toLowerCase().trim() });
  if (existing) {
    console.error('An admin with that email already exists.');
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert('admin_users', {
    id: crypto.randomUUID(),
    email: email.toLowerCase().trim(),
    passwordHash,
    createdAt: Date.now(),
  });
  console.log(`Admin account created for ${email}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
```
Run once per environment: `node backend/scripts/create-admin.js you@example.com 'a-strong-password'`.

---

## Part 8 — Frontend: `public/admin.html` + `public/js/admin.js`

`admin.html` is a standalone page (not using `renderTopNav`/`Auth`/`API` from `public/js/api.js`, since those are wired to the customer `apToken` key) with its own minimal top bar ("AvatarPlatform Admin", logout button) and three tab buttons (Users / Tiers / Audit Log) toggling three `<section>`s. It links the existing shared stylesheet(s) from `public/css/` for visual consistency (cards, buttons, tables, badges) plus `theme.js` for light/dark support, but ships its own `admin.js` script rather than `api.js`.

**`public/js/admin.js`** structure:
```js
const AdminAuth = {
  get token() { return localStorage.getItem('adminToken'); },
  set token(v) { v ? localStorage.setItem('adminToken', v) : localStorage.removeItem('adminToken'); },
  loggedIn() { return !!this.token; },
  logout() { this.token = null; location.reload(); },
};

async function adminApiCall(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  if (AdminAuth.token) headers['Authorization'] = `Bearer ${AdminAuth.token}`;
  const res = await fetch(path, { ...opts, headers });
  let body; try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) {
    if (res.status === 401) { AdminAuth.logout(); throw new Error('Session expired'); }
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body;
}

const AdminAPI = {
  login: (email, password) => adminApiCall('/api/admin/login', { method: 'POST', body: { email, password } }),
  listUsers: (search, page) => adminApiCall(`/api/admin/users?search=${encodeURIComponent(search || '')}&page=${page || 1}`),
  getUser: (id) => adminApiCall(`/api/admin/users/${id}`),
  patchUser: (id, patch) => adminApiCall(`/api/admin/users/${id}`, { method: 'PATCH', body: patch }),
  deleteUser: (id) => adminApiCall(`/api/admin/users/${id}`, { method: 'DELETE' }),
  impersonate: (id) => adminApiCall(`/api/admin/users/${id}/impersonate`, { method: 'POST' }),
  listTiers: () => adminApiCall('/api/admin/tiers'),
  createTier: (data) => adminApiCall('/api/admin/tiers', { method: 'POST', body: data }),
  updateTier: (id, data) => adminApiCall(`/api/admin/tiers/${id}`, { method: 'PATCH', body: data }),
  deleteTier: (id) => adminApiCall(`/api/admin/tiers/${id}`, { method: 'DELETE' }),
  auditLog: (page) => adminApiCall(`/api/admin/audit-log?page=${page || 1}`),
};
```

Page behavior:
- On load: if `!AdminAuth.loggedIn()`, render a plain email/password login form (`AdminAPI.login`, store token, re-render).
- **Users tab**: search box (debounced), paginated table (email, name, plan badge showing name + source `admin`/`stripe`/`free`, suspended badge, joined date). Row click opens a detail panel (in-page, not a separate route) showing: usage bars per limit (reusing the same visual pattern as `billing.html`'s usage section — value/limit progress bars), a tier `<select>` populated from `AdminAPI.listTiers()` plus a "None (use plan)" option to call `patchUser(id, { adminPlanId: null })`, a suspend/unsuspend toggle button, a read-only project list (name, character, file count, created date), an "View as user" button that calls `impersonate`, opens `${location.origin}/dashboard` in a new tab, and passes the token via a one-time `postMessage`-free approach: writes `adminToken` isn't reused — instead the new tab is opened with the token appended as a URL fragment `#imp=<token>`, and `public/js/api.js`'s bootstrap (or a tiny inline script added to `dashboard.html`) checks `location.hash` for `#imp=` once on load, calls `Auth.token = <that value>`, then strips the fragment. This is the one small addition needed on the customer side. A delete button with a native `confirm()` guard.
- **Tiers tab**: table of existing tiers (name, id, limits summary) each with Edit/Delete; a create form with the six numeric limit fields plus name.
- **Audit Log tab**: read-only paginated table (timestamp, admin email, action, target user email, meta as collapsed JSON).

**Small addition to the customer side** — `public/dashboard.html` (or a shared bootstrap point loaded by every page, e.g. top of `public/js/api.js`) gets:
```js
if (location.hash.startsWith('#imp=')) {
  Auth.token = decodeURIComponent(location.hash.slice(5));
  history.replaceState(null, '', location.pathname);
}
```
placed before `Auth.requireLogin()` runs, so an impersonation link logs the browser tab in as that user without ever touching the admin's own `apToken`.

---

## Error handling / edge cases

- Suspending a user who's currently mid-session: their existing JWT is still cryptographically valid until it expires, but the very next `authRequired`-gated request 403s (`user.suspended` checked on every call, not cached) — including embed-widget-adjacent authenticated routes, but *not* the public `/embed/:publicId/*` endpoints themselves, which have no `authRequired` and are intentionally unaffected (visitors on a suspended account's embedded chatbot keep getting answers until the operator separately decides to pull the embed down — out of scope here, matches the "block login + API access" choice which was scoped to the account owner's own dashboard/API use, not their live embeds).
- Deleting a plan tier that's still assigned to a user: blocked with 409, forcing the admin to reassign or clear those users first — prevents a user ending up with a dangling `admin_plan_id` that `getPlan()` can't resolve (which would silently fall back to `free`, unexpectedly *lowering* their limits with no visible error).
- Assigning a nonexistent `adminPlanId`: `PATCH /users/:id` 400s before writing anything.
- Impersonating a suspended user: blocked (400) — suspension should not be bypassable via the very panel that manages it.
- Admin JWT reused against customer routes or vice versa: rejected — see Part 3's isolation note.
- Two admins editing the same tier concurrently: last-write-wins (same as every other `db.update` in this codebase — no optimistic locking anywhere else either, consistent rather than a special case here).
- Empty `PATCH /users/:id` body: 400 "Nothing to update" rather than a silent no-op 200.

## Testing

No automated test suite in this repo (consistent with the rest of the codebase) — manual verification:

1. Run the new migration against a local/dev DB; confirm `admin_users`, `plan_tiers`, `admin_audit_log` exist and `users` has `suspended`/`admin_plan_id`.
2. `node backend/scripts/create-admin.js you@example.com 'password123'` — confirm row created, running it again for the same email fails cleanly.
3. Log into `/admin` with those credentials; confirm a customer `apToken` (log in separately as a normal user in another tab) is unaffected and vice versa — check `localStorage` keys `adminToken` vs `apToken` don't collide.
4. Users tab: search, paginate, open a user's detail panel, confirm usage bars match `billing.html`'s numbers for that same account when logged in as them.
5. Create a custom tier (e.g. `projects: 999`), assign it to a test user, confirm `GET /api/billing/usage` for that user (as themselves) now reflects the new limit and `GET /api/billing/subscription` shows the tier's name.
6. Clear the tier assignment; confirm the user's limits revert to their real Stripe plan (or free).
7. Suspend the test user; confirm their existing session immediately gets 403s on any authenticated API call, and a fresh login attempt is rejected. Unsuspend; confirm normal access returns.
8. Click "View as user"; confirm the new tab opens the real dashboard already logged in as that user, and that the impersonation token stops working after 15 minutes (or confirm via a decoded-JWT `exp` check if waiting isn't practical).
9. Attempt to delete a tier that's still assigned — confirm 409. Clear the assignment, delete again — confirm success.
10. Delete a test user from the admin panel; confirm cascading deletes (projects/files/etc.) match what the existing self-serve `DELETE /api/auth/me` already does, and that a live Stripe subscription (if any, test mode) gets cancelled.
11. Check the Audit Log tab shows entries for every action taken above, with correct admin/target emails.
12. Confirm `/api/admin/*` routes all reject a valid *customer* JWT with 401, and `/api/*` customer routes all reject a valid *admin* JWT with 401.
