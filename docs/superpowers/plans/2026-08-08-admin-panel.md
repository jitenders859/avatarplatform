# Admin Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully-isolated admin panel that lets the operator view all customer accounts, grant individual accounts higher usage limits via admin-editable custom plan tiers, suspend or delete accounts, view (read-only) a user's projects, and temporarily impersonate a user for support.

**Architecture:** New `admin_users`/`plan_tiers`/`admin_audit_log` tables plus two new columns on `users` (`suspended`, `admin_plan_id`). A separate `adminAuthRequired` middleware and JWT payload shape (`{aid, isAdmin: true}`) keep admin auth structurally disjoint from customer auth (`{uid}`). `backend/routes/admin.js` exposes the CRUD surface; `public/admin.html` + `public/js/admin.js` is a single tabbed page (Users / Tiers / Audit Log) with its own `adminToken` localStorage key, separate from the customer `apToken`.

**Tech Stack:** Express 4 + `pg` (raw SQL via `backend/db.js`'s helper layer), `jsonwebtoken`, `bcryptjs`, `zod` (via `backend/middleware/validate.js`), vanilla JS frontend (no build step), Node's built-in `node:test` for the handful of pure-logic unit tests (matching this repo's existing convention in `backend/middleware/auth.test.js`, `backend/services/pageImages.test.js`) — route/DB logic is verified manually via `curl`, matching the fact that no route in this codebase (`auth.js`, `billing.js`, etc.) has automated test coverage today.

---

## Before you start

This plan assumes a working local dev setup: `DATABASE_URL`, `JWT_SECRET`, and `PORT=8080` are already set in `.env` (confirmed present), and `npm run dev` starts the server (`node --watch backend/server.js`) at `http://localhost:8080`. Every "Verify" step below that hits a running server assumes it's up in another terminal — start it once with:

```bash
npm run dev
```

and leave it running for the rest of this plan.

---

### Task 1: Database schema — admin tables + user columns

**Files:**
- Create: `supabase/migrations/2026-08-08_add_admin_panel.sql`
- Modify: `supabase/schema.sql` (append new tables/columns to the end, matching the file's existing append-only "schema evolution" convention — see how `2026-08-08_add_storage_columns.sql`'s statements already live there)

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/2026-08-08_add_admin_panel.sql`:

```sql
-- ═══════════════════════════════════════════════════════════════════
-- Migration: Admin panel — user management, custom limit tiers,
-- suspend/delete, impersonation. See
-- docs/superpowers/specs/2026-08-08-admin-panel-design.md.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already appended to
-- schema.sql; this file is a standalone, dated record of *why* they were
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-08_add_admin_panel.sql
-- ═══════════════════════════════════════════════════════════════════

-- ── admin_users ───────────────────────────────────────────────────
-- Fully separate from the customer `users` table/auth path by design.
-- No self-serve signup; seeded via backend/scripts/create-admin.js.
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
  id          TEXT        PRIMARY KEY,   -- slug, e.g. "custom-acme-corp-a1b2c3"
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
  action          TEXT    NOT NULL,   -- 'suspend' | 'unsuspend' | 'assign_tier' | 'clear_tier' | 'delete_user' | 'impersonate' | 'tier_create' | 'tier_update' | 'tier_delete'
  target_user_id  UUID    REFERENCES users(id),
  meta            JSONB,
  created_at      BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log (created_at DESC);
```

- [ ] **Step 2: Append the same statements to `supabase/schema.sql`**

Open `supabase/schema.sql`, find the end of the file (after the `usage` table definition and any other "schema evolution" appends), and append a new section:

```sql

-- ── admin_users ───────────────────────────────────────────────────
-- Fully separate from the customer `users` table/auth path by design.
-- No self-serve signup; seeded via backend/scripts/create-admin.js.
CREATE TABLE IF NOT EXISTS admin_users (
  id            UUID        PRIMARY KEY,
  email         TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    BIGINT      NOT NULL
);

-- ── plan_tiers ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plan_tiers (
  id          TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL,
  limits      JSONB       NOT NULL,
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
  action          TEXT    NOT NULL,
  target_user_id  UUID    REFERENCES users(id),
  meta            JSONB,
  created_at      BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log (created_at DESC);
```

- [ ] **Step 3: Apply the migration to your local/dev database**

```bash
psql "$DATABASE_URL" -f supabase/migrations/2026-08-08_add_admin_panel.sql
```

Expected: no errors, each `CREATE TABLE`/`ALTER TABLE` prints `NOTICE`/`CREATE TABLE`/`ALTER TABLE` (or silently succeeds if objects already exist from a prior run — that's what `IF NOT EXISTS` is for).

- [ ] **Step 4: Verify the tables and columns exist**

```bash
psql "$DATABASE_URL" -c "\d admin_users" -c "\d plan_tiers" -c "\d admin_audit_log" -c "\d users" | grep -E "admin_users|plan_tiers|admin_audit_log|suspended|admin_plan_id"
```

Expected: all four table/column names appear in the output.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-08-08_add_admin_panel.sql supabase/schema.sql
git commit -m "Add admin_users, plan_tiers, admin_audit_log tables and users.suspended/admin_plan_id columns"
```

---

### Task 2: Plan resolution — async `getPlan` with custom-tier fallback + admin override

**Files:**
- Modify: `backend/plans.js:82-89`
- Modify: `backend/services/usage.js:17-20,60-77`
- Modify: `backend/routes/billing.js:36-38,73-74`

- [ ] **Step 1: Make `getPlan` async with a `plan_tiers` fallback**

In `backend/plans.js`, add the `db` require near the top (after existing requires, before `const PLANS = [...]`):

```js
const db = require('./db');
```

Replace the existing `getPlan` function (lines 82-84):

```js
function getPlan(id) {
  return PLANS.find(p => p.id === id) || PLANS[0];
}
```

with:

```js
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

- [ ] **Step 2: Update `usage.js`'s `userPlanId` to check the admin override first, and await `getPlan`**

In `backend/services/usage.js`, replace `userPlanId` (lines 17-20):

```js
async function userPlanId(userId) {
  const sub = await db.findOne('subscriptions', { userId, status: 'active' });
  return sub ? sub.planId : 'free';
}
```

with:

```js
async function userPlanId(userId) {
  const user = await db.findOne('users', { id: userId });
  if (user?.adminPlanId) return user.adminPlanId;
  const sub = await db.findOne('subscriptions', { userId, status: 'active' });
  return sub ? sub.planId : 'free';
}
```

In the same file, in `getUsageSnapshot`, change line 77 from:

```js
  const plan = getPlan(planId);
```

to:

```js
  const plan = await getPlan(planId);
```

- [ ] **Step 3: Await `getPlan` at both call sites in `billing.js`**

In `backend/routes/billing.js`, change line 38 from `const plan = getPlan(planId);` to `const plan = await getPlan(planId);`, and line 74 from `const plan = getPlan(planId);` to `const plan = await getPlan(planId);`.

- [ ] **Step 4: Verify the server still boots and existing billing endpoints work**

```bash
curl -s http://localhost:8080/api/billing/plans | head -c 300
```

Expected: JSON with the 4 static plans (`free`, `starter`, `pro`, `business`), no server crash in the `npm run dev` terminal.

- [ ] **Step 5: Commit**

```bash
git add backend/plans.js backend/services/usage.js backend/routes/billing.js
git commit -m "Make getPlan async with plan_tiers fallback; admin_plan_id overrides Stripe-derived plan"
```

---

### Task 3: Auth middleware — suspension check, admin JWT, impersonation-ready `signToken`

**Files:**
- Modify: `backend/middleware/auth.js`
- Modify: `backend/middleware/auth.test.js`

- [ ] **Step 1: Write the new/changed tests first**

Append to `backend/middleware/auth.test.js` (after the existing three tests, keeping the `process.env.JWT_SECRET` setup and `require('./auth')` at the top as-is — extend the destructure to pull in the new exports):

```js
const { signToken, signAdminToken, JWT_SECRET } = require('./auth');
```

Replace the existing `const { signToken, JWT_SECRET } = require('./auth');` line with the one above, then add:

```js
test('signToken accepts an expiresIn override for short-lived impersonation tokens', () => {
  const token = signToken('user-123', { expiresIn: '15m' });
  const payload = jwt.verify(token, JWT_SECRET);
  assert.equal(payload.uid, 'user-123');
  const secondsLeft = payload.exp - payload.iat;
  assert.equal(secondsLeft, 15 * 60);
});

test('signAdminToken issues a token with isAdmin:true and no uid, distinct from customer tokens', () => {
  const adminToken = signAdminToken('admin-1');
  const payload = jwt.verify(adminToken, JWT_SECRET);
  assert.equal(payload.aid, 'admin-1');
  assert.equal(payload.isAdmin, true);
  assert.equal(payload.uid, undefined);
});

test('a customer token (signToken) has no isAdmin flag, so it cannot pass as an admin token', () => {
  const customerToken = signToken('user-123');
  const payload = jwt.verify(customerToken, JWT_SECRET);
  assert.equal(payload.isAdmin, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail (new exports don't exist yet)**

```bash
node --test backend/middleware/auth.test.js
```

Expected: FAIL — `signAdminToken` is not a function / `TypeError`.

- [ ] **Step 3: Implement the middleware changes**

Replace the full contents of `backend/middleware/auth.js` with:

```js
const jwt = require('jsonwebtoken');
const db = require('../db');

// Previously fell back to a hardcoded secret ('change-me-in-production-please')
// whenever JWT_SECRET was unset, so any deployment that lost/forgot the env
// var would silently sign and verify tokens with a secret sitting in source
// control — anyone could forge a valid token for any user id. Fail fast
// instead: refuse to boot rather than run with a known, guessable secret.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required and must not be empty');
}

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

// Admin auth is structurally disjoint from customer auth: admin tokens carry
// {aid, isAdmin: true} (no uid) and are checked against the separate
// admin_users table, so a customer token can never satisfy this middleware
// and an admin token can never satisfy authRequired above (it has no uid,
// so db.findOne('users', {id: undefined}) returns null → 401).
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

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test backend/middleware/auth.test.js
```

Expected: PASS — all 6 tests green (3 original + 3 new).

- [ ] **Step 5: Verify existing login still works (manual regression check)**

With `npm run dev` running:

```bash
curl -s -X POST http://localhost:8080/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"nonexistent@example.com","password":"whatever123"}'
```

Expected: `{"error":"Invalid credentials"}` with HTTP 401 (confirms the route still loads and `authRequired`/`signToken` changes didn't break the require chain).

- [ ] **Step 6: Commit**

```bash
git add backend/middleware/auth.js backend/middleware/auth.test.js
git commit -m "Add suspension check, adminAuthRequired middleware, and signToken expiresIn override"
```

---

### Task 4: Shared account-delete helper

**Files:**
- Create: `backend/services/accountDelete.js`
- Modify: `backend/routes/auth.js:119-143`

- [ ] **Step 1: Extract the delete logic into a shared service**

Create `backend/services/accountDelete.js`:

```js
const db = require('../db');
const logger = require('../logger').child({ module: 'accountDelete' });

// Cancel any live Stripe subscription first — FK CASCADE will delete our
// local subscriptions row along with the user, but Stripe itself keeps
// billing the customer until told to stop. Without this, a deleted
// account keeps getting charged with no way to log back in and cancel.
// FK CASCADE in Postgres handles deleting all related data automatically.
// Deleting the user row cascades: projects → files, chunks, sessions,
// messages, capture_fields, leads; also subscriptions, usage.
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

- [ ] **Step 2: Update `auth.js`'s `DELETE /me` to use it**

In `backend/routes/auth.js`, add the import near the top (with the other requires):

```js
const { deleteUserAccount } = require('../services/accountDelete');
```

Replace the entire `router.delete('/me', ...)` handler (lines 119-143) with:

```js
router.delete('/me', authRequired, async (req, res) => {
  await deleteUserAccount(req.user.id);
  res.json({ ok: true });
});
```

- [ ] **Step 3: Verify no behavior change**

```bash
node -e "require('./backend/routes/auth.js'); console.log('auth.js loads OK')"
```

Expected: `auth.js loads OK` with no thrown error (confirms the new require resolves and there's no syntax error).

- [ ] **Step 4: Commit**

```bash
git add backend/services/accountDelete.js backend/routes/auth.js
git commit -m "Extract account-delete logic into services/accountDelete.js for reuse by admin routes"
```

---

### Task 5: Audit log service

**Files:**
- Create: `backend/services/auditLog.js`

- [ ] **Step 1: Write the service**

Create `backend/services/auditLog.js`:

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

- [ ] **Step 2: Verify it loads cleanly**

```bash
node -e "const { logAdminAction } = require('./backend/services/auditLog.js'); console.log(typeof logAdminAction)"
```

Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add backend/services/auditLog.js
git commit -m "Add admin audit log service"
```

---

### Task 6: Validation schemas for admin login and tier upsert

**Files:**
- Modify: `backend/middleware/validate.js`

- [ ] **Step 1: Add the two new schemas**

In `backend/middleware/validate.js`, inside the `schemas` object (alongside `signup`, `login`, `forgotPassword`, etc.), add:

```js
  adminLogin: z.object({
    email,
    password: z.string().min(1, 'Password is required'),
  }),

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

- [ ] **Step 2: Verify the module still loads and exports both schemas**

```bash
node -e "const { schemas } = require('./backend/middleware/validate.js'); console.log(!!schemas.adminLogin, !!schemas.tierUpsert)"
```

Expected: `true true`

- [ ] **Step 3: Commit**

```bash
git add backend/middleware/validate.js
git commit -m "Add adminLogin and tierUpsert validation schemas"
```

---

### Task 7: Admin routes — login/me, mounted in server.js, first admin seeded

**Files:**
- Create: `backend/routes/admin.js`
- Create: `backend/scripts/create-admin.js`
- Modify: `backend/server.js`

- [ ] **Step 1: Create the admin routes file with just auth for now**

Create `backend/routes/admin.js`:

```js
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { adminAuthRequired, signAdminToken } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');

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

module.exports = router;
```

- [ ] **Step 2: Mount it in server.js**

In `backend/server.js`, add the import near the other route requires (after `const videoResourcesRoutes = require('./routes/videoResources');`):

```js
const adminRoutes = require('./routes/admin');
```

Add the mount lines right after `app.use('/api/analytics', apiLimiter, analyticsRoutes);` (before the `app.use('/embed', ...)` line):

```js
app.use('/api/admin/login', authLimiter);
app.use('/api/admin', apiLimiter, adminRoutes);
```

Add `'admin'` to the `PAGES` array so `/admin` resolves to `admin.html` (this array currently ends `..., 'terms', 'contact'];` around line 156):

```js
const PAGES = ['login', 'signup', 'dashboard', 'project', 'embed', 'billing', 'analytics', 'pricing', 'characters', 'account', 'forgot-password', 'reset-password', 'terms', 'contact', 'admin'];
```

Update the header comment block at the top of the file (the `Layout:` list) to add:

```
 *   /api/admin/*              admin panel (separate auth, see routes/admin.js)
```

- [ ] **Step 3: Write the admin-seed script**

Create `backend/scripts/create-admin.js`:

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

- [ ] **Step 4: Restart the dev server and seed a test admin**

The `npm run dev` process (`node --watch`) auto-restarts on file changes, but run the seed script in a separate one-off invocation:

```bash
node backend/scripts/create-admin.js admin-test@example.com 'test-password-123'
```

Expected: `Admin account created for admin-test@example.com`

- [ ] **Step 5: Verify login and me endpoints work end-to-end**

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/api/admin/login -H 'Content-Type: application/json' \
  -d '{"email":"admin-test@example.com","password":"test-password-123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s http://localhost:8080/api/admin/me -H "Authorization: Bearer $TOKEN"
```

Expected: `{"admin":{"id":"...","email":"admin-test@example.com"}}`

- [ ] **Step 6: Verify a customer token is rejected by admin routes and vice versa**

```bash
# Sign up a throwaway customer and confirm their token can't hit /api/admin/me
CUST_TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"admincheck@example.com","password":"password123","name":"Admin Check"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/admin/me -H "Authorization: Bearer $CUST_TOKEN"

# And confirm the admin token can't hit a customer route
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/auth/me -H "Authorization: Bearer $TOKEN"
```

Expected: both print `401`.

- [ ] **Step 7: Commit**

```bash
git add backend/routes/admin.js backend/scripts/create-admin.js backend/server.js
git commit -m "Add admin login/me routes, mount /api/admin, seed script for first admin"
```

---

### Task 8: Admin routes — list and detail views of users

**Files:**
- Modify: `backend/routes/admin.js`

- [ ] **Step 1: Add the users list and detail endpoints**

In `backend/routes/admin.js`, add these imports at the top (alongside the existing ones):

```js
const { getUsageSnapshot } = require('../services/usage');
```

Add these two routes after the `router.get('/me', ...)` block:

```js
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
```

- [ ] **Step 2: Verify both endpoints**

```bash
curl -s "http://localhost:8080/api/admin/users?page=1" -H "Authorization: Bearer $TOKEN" | head -c 500
```

Expected: JSON with a `users` array (includes the `admincheck@example.com` account created in Task 7) and `page`/`pageSize`/`total` fields.

```bash
USER_ID=$(curl -s "http://localhost:8080/api/admin/users?search=admincheck" -H "Authorization: Bearer $TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).users[0].id')
curl -s "http://localhost:8080/api/admin/users/$USER_ID" -H "Authorization: Bearer $TOKEN" | head -c 500
```

Expected: JSON with `user`, `usage` (containing `plan`, `counters`, `limits`), `projects` (empty array — this test account has none), `subscriptions` (empty array).

- [ ] **Step 3: Commit**

```bash
git add backend/routes/admin.js
git commit -m "Add admin GET /users (list+search+paginate) and GET /users/:id (detail) endpoints"
```

---

### Task 9: Admin routes — suspend/tier-assign, delete, impersonate

**Files:**
- Modify: `backend/routes/admin.js`

- [ ] **Step 1: Add the mutating user endpoints**

In `backend/routes/admin.js`, change the existing auth-middleware import line from:

```js
const { adminAuthRequired, signAdminToken } = require('../middleware/auth');
```

to:

```js
const { adminAuthRequired, signAdminToken, signToken } = require('../middleware/auth');
```

Then add these two new imports right below it:

```js
const { deleteUserAccount } = require('../services/accountDelete');
const { logAdminAction } = require('../services/auditLog');
```

Add these three routes after `GET /users/:id`:

```js
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
```

- [ ] **Step 2: Verify suspend/unsuspend + the suspension actually blocks customer API access**

```bash
curl -s -X PATCH "http://localhost:8080/api/admin/users/$USER_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"suspended":true}'
```

Expected: `{"user":{"id":"...","suspended":true,"adminPlanId":null}}`

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/auth/me -H "Authorization: Bearer $CUST_TOKEN"
```

Expected: `403` (the suspended user's still-valid JWT now gets rejected by `authRequired`).

```bash
curl -s -X PATCH "http://localhost:8080/api/admin/users/$USER_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"suspended":false}'
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/auth/me -H "Authorization: Bearer $CUST_TOKEN"
```

Expected: second call prints `200` (unsuspended, access restored).

- [ ] **Step 3: Verify impersonation**

```bash
IMP_TOKEN=$(curl -s -X POST "http://localhost:8080/api/admin/users/$USER_ID/impersonate" -H "Authorization: Bearer $TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s http://localhost:8080/api/auth/me -H "Authorization: Bearer $IMP_TOKEN"
```

Expected: `{"user":{"id":"...","email":"admincheck@example.com",...}}` — the impersonation token works as a real customer session.

- [ ] **Step 4: Verify empty PATCH body is rejected**

```bash
curl -s -X PATCH "http://localhost:8080/api/admin/users/$USER_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
```

Expected: `{"error":"Nothing to update"}`

- [ ] **Step 5: Verify assigning a nonexistent tier is rejected**

```bash
curl -s -X PATCH "http://localhost:8080/api/admin/users/$USER_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"adminPlanId":"does-not-exist"}'
```

Expected: `{"error":"Unknown plan tier"}`

- [ ] **Step 6: Verify impersonating a suspended user is blocked**

```bash
curl -s -X PATCH "http://localhost:8080/api/admin/users/$USER_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"suspended":true}'
curl -s -X POST "http://localhost:8080/api/admin/users/$USER_ID/impersonate" -H "Authorization: Bearer $TOKEN"
curl -s -X PATCH "http://localhost:8080/api/admin/users/$USER_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"suspended":false}'
```

Expected: the impersonate call returns `{"error":"Cannot impersonate a suspended account"}`; the final unsuspend call restores access for later tasks.

- [ ] **Step 7: Commit**

```bash
git add backend/routes/admin.js
git commit -m "Add admin PATCH/DELETE /users/:id and impersonate endpoints"
```

Leave `USER_ID`, `TOKEN`, `CUST_TOKEN` set in your shell — they're reused in Task 10's verification.

---

### Task 10: Admin routes — custom plan tier CRUD

**Files:**
- Modify: `backend/routes/admin.js`

- [ ] **Step 1: Add the tier endpoints**

Add `const crypto = require('crypto');` to the top of `backend/routes/admin.js` if not already present, then add these routes after the impersonate route:

```js
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
```

- [ ] **Step 2: Verify tier creation, assignment, and its effect on limits**

```bash
TIER_ID=$(curl -s -X POST http://localhost:8080/api/admin/tiers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Test Bump","limits":{"projects":999,"filesPerProject":999,"storageMb":99999,"monthlyMessages":999999,"monthlyEmbeddingChars":999999999,"urlSources":999}}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).tier.id')
echo "Created tier: $TIER_ID"

curl -s -X PATCH "http://localhost:8080/api/admin/users/$USER_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"adminPlanId\":\"$TIER_ID\"}"

curl -s http://localhost:8080/api/billing/usage -H "Authorization: Bearer $CUST_TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).limits.projects'
```

Expected: last command prints `999` — the customer's own `/api/billing/usage` now reflects the admin-assigned tier's limit.

- [ ] **Step 3: Verify tier delete is blocked while in use, then works after clearing**

```bash
curl -s -X DELETE "http://localhost:8080/api/admin/tiers/$TIER_ID" -H "Authorization: Bearer $TOKEN"
```

Expected: `{"error":"Tier is still assigned to at least one user"}`

```bash
curl -s -X PATCH "http://localhost:8080/api/admin/users/$USER_ID" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"adminPlanId":null}'
curl -s http://localhost:8080/api/billing/usage -H "Authorization: Bearer $CUST_TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).limits.projects'
curl -s -X DELETE "http://localhost:8080/api/admin/tiers/$TIER_ID" -H "Authorization: Bearer $TOKEN"
```

Expected: usage now shows the free plan's `3` (limits reverted), and the delete now returns `{"ok":true}`.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/admin.js
git commit -m "Add admin plan tier CRUD endpoints (create/list/update/delete)"
```

---

### Task 11: Admin routes — audit log read endpoint

**Files:**
- Modify: `backend/routes/admin.js`

- [ ] **Step 1: Add the endpoint**

Add after the tier routes:

```js
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
```

- [ ] **Step 2: Verify it returns the actions logged by earlier tasks**

```bash
curl -s "http://localhost:8080/api/admin/audit-log" -H "Authorization: Bearer $TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).entries.map(e => e.action).join(", ")'
```

Expected: a comma-separated list including `tier_delete, clear_tier, tier_create, impersonate, unsuspend, suspend, assign_tier, delete_user` (order and exact set depend on which verification steps you ran, but should include entries from Tasks 9 and 10).

- [ ] **Step 3: Commit**

```bash
git add backend/routes/admin.js
git commit -m "Add admin audit log read endpoint"
```

---

### Task 12: Frontend shell — `admin.html` + `admin.js` core (auth, tabs, API client)

**Files:**
- Create: `public/admin.html`
- Create: `public/js/admin.js`

- [ ] **Step 1: Create `public/admin.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Admin — AvatarPlatform</title>
  <script>document.documentElement.dataset.theme = localStorage.getItem('apTheme') === 'dark' ? 'dark' : 'light';</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/app.css" />
</head>
<body>
  <div class="container mt-md">
    <div id="login-view" class="card" style="max-width:360px;margin:80px auto">
      <div class="card-header"><h2 class="card-title">Admin sign in</h2></div>
      <form id="login-form" class="col gap-md">
        <input type="email" id="login-email" placeholder="Email" required class="input" />
        <input type="password" id="login-password" placeholder="Password" required class="input" />
        <button type="submit" class="btn btn-primary">Sign in</button>
      </form>
    </div>

    <div id="admin-view" hidden>
      <div class="page-header">
        <div>
          <h1 class="page-title">Admin</h1>
          <p class="page-sub" id="admin-whoami"></p>
        </div>
        <button class="btn btn-ghost" id="logout-btn">Log out</button>
      </div>

      <div class="row gap-sm mb-lg" id="tab-bar">
        <button class="btn btn-ghost tab-btn active" data-tab="users">Users</button>
        <button class="btn btn-ghost tab-btn" data-tab="tiers">Tiers</button>
        <button class="btn btn-ghost tab-btn" data-tab="audit">Audit Log</button>
      </div>

      <section id="tab-users"></section>
      <section id="tab-tiers" hidden></section>
      <section id="tab-audit" hidden></section>
    </div>
  </div>

  <script src="/js/theme.js"></script>
  <script src="/js/admin.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/js/admin.js` with the auth/API core and tab switching**

```js
/**
 * Admin panel — separate auth/token from the customer app (public/js/api.js).
 */
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
  me: () => adminApiCall('/api/admin/me'),
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

function adminToast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + (type ? 'toast-' + type : '');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3000);
}

function formatNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function switchTab(name) {
  for (const btn of document.querySelectorAll('.tab-btn')) btn.classList.toggle('active', btn.dataset.tab === name);
  for (const sec of document.querySelectorAll('#admin-view section')) sec.hidden = sec.id !== `tab-${name}`;
  if (name === 'users') loadUsersTab();
  if (name === 'tiers') loadTiersTab();
  if (name === 'audit') loadAuditTab();
}

async function boot() {
  if (!AdminAuth.loggedIn()) return;
  try {
    const { admin } = await AdminAPI.me();
    document.getElementById('login-view').hidden = true;
    document.getElementById('admin-view').hidden = false;
    document.getElementById('admin-whoami').textContent = `Signed in as ${admin.email}`;
    switchTab('users');
  } catch {
    // adminApiCall already logged out on 401
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  try {
    const { token } = await AdminAPI.login(email, password);
    AdminAuth.token = token;
    boot();
  } catch (err) {
    adminToast(err.message, 'error');
  }
});

document.getElementById('logout-btn').addEventListener('click', () => AdminAuth.logout());

for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}

boot();
```

- [ ] **Step 3: Verify the shell loads and login works in a browser**

With `npm run dev` running, open `http://localhost:8080/admin` in a browser. Confirm the login form appears. Sign in with `admin-test@example.com` / `test-password-123` (seeded in Task 7). Confirm it switches to the admin view showing "Signed in as admin-test@example.com" and the three tab buttons (the tab content sections will be empty — that's expected, populated in later tasks). Confirm reloading the page keeps you logged in (token persisted in `localStorage.adminToken`), and that opening `http://localhost:8080/dashboard` in another tab and logging in as a customer there doesn't affect the admin tab's session (separate `localStorage` keys).

- [ ] **Step 4: Commit**

```bash
git add public/admin.html public/js/admin.js
git commit -m "Add admin panel shell: login form, tab switching, isolated adminToken auth"
```

---

### Task 13: Frontend — Users tab (list, search, detail panel, suspend/tier/delete)

**Files:**
- Modify: `public/js/admin.js`

- [ ] **Step 1: Add the Users tab rendering functions**

Append to `public/js/admin.js` (these reference `#tab-users`, defined in `admin.html`'s markup):

```js
let usersSearchTimer = null;

async function loadUsersTab() {
  const section = document.getElementById('tab-users');
  section.innerHTML = `
    <div class="row gap-sm mb-md">
      <input type="text" id="users-search" placeholder="Search by email or name…" class="input" style="max-width:320px" />
    </div>
    <div id="users-table"></div>
    <div id="user-detail" class="card mt-lg" hidden></div>
  `;
  document.getElementById('users-search').addEventListener('input', (e) => {
    clearTimeout(usersSearchTimer);
    usersSearchTimer = setTimeout(() => renderUsersTable(e.target.value), 300);
  });
  await renderUsersTable('');
}

async function renderUsersTable(search) {
  const { users } = await AdminAPI.listUsers(search, 1);
  const rows = users.map(u => `
    <tr class="user-row" data-id="${u.id}" style="cursor:pointer">
      <td>${u.email}</td>
      <td>${u.name || ''}</td>
      <td><span class="pill ${u.planSource === 'admin' ? 'pill-warn' : 'pill-info'}">${u.planId} (${u.planSource})</span></td>
      <td>${u.suspended ? '<span class="pill pill-danger">Suspended</span>' : ''}</td>
      <td>${new Date(u.createdAt).toLocaleDateString()}</td>
    </tr>`).join('');
  document.getElementById('users-table').innerHTML = `
    <table class="table">
      <thead><tr><th>Email</th><th>Name</th><th>Plan</th><th>Status</th><th>Joined</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No users found</td></tr>'}</tbody>
    </table>`;
  for (const row of document.querySelectorAll('.user-row')) {
    row.addEventListener('click', () => renderUserDetail(row.dataset.id));
  }
}

async function renderUserDetail(userId) {
  const { user, usage, projects } = await AdminAPI.getUser(userId);
  const { tiers } = await AdminAPI.listTiers();
  const c = usage.counters, l = usage.limits;
  const items = [
    { label: 'Chatbots', current: c.projects, limit: l.projects, unit: '' },
    { label: 'Files (across all)', current: c.files, limit: l.filesPerProject, unit: '' },
    { label: 'Storage', current: c.storageMb, limit: l.storageMb, unit: ' MB' },
    { label: 'URL sources', current: c.urlSources, limit: l.urlSources, unit: '' },
    { label: 'Messages this month', current: c.messages, limit: l.monthlyMessages, unit: '' },
    { label: 'Embedding chars', current: c.embeddingChars, limit: l.monthlyEmbeddingChars, unit: '' },
  ];
  const bars = items.map(i => {
    const pct = Math.min(100, Math.round((i.current / Math.max(1, i.limit)) * 100));
    const color = pct >= 90 ? 'background:#ef4444' : pct >= 70 ? 'background:#f59e0b' : 'background:linear-gradient(90deg,var(--accent),var(--accent-2))';
    return `<div>
      <div class="row" style="justify-content:space-between;margin-bottom:6px">
        <span class="text-sm">${i.label}</span>
        <span class="muted text-sm">${formatNum(i.current)}${i.unit} / ${formatNum(i.limit)}${i.unit}</span>
      </div>
      <div style="height:8px;background:var(--bg-3);border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${pct}%;${color};transition:width .4s"></div>
      </div>
    </div>`;
  }).join('');

  const tierOptions = [`<option value="">None (use plan)</option>`]
    .concat(tiers.map(t => `<option value="${t.id}" ${t.id === user.adminPlanId ? 'selected' : ''}>${t.name}</option>`))
    .join('');

  const projectRows = projects.map(p => `<tr><td>${p.name}</td><td>${p.characterId}</td><td>${p.fileCount}</td><td>${new Date(p.createdAt).toLocaleDateString()}</td></tr>`).join('');

  const detail = document.getElementById('user-detail');
  detail.hidden = false;
  detail.innerHTML = `
    <div class="card-header"><h2 class="card-title">${user.email}</h2></div>
    <div class="col gap-md">${bars}</div>
    <div class="row gap-sm mt-lg" style="align-items:center">
      <label class="text-sm">Custom tier:</label>
      <select id="tier-select" class="input" style="max-width:220px">${tierOptions}</select>
      <button class="btn btn-ghost" id="suspend-toggle-btn">${user.suspended ? 'Unsuspend' : 'Suspend'}</button>
      <button class="btn btn-ghost" id="impersonate-btn">View as user</button>
      <button class="btn btn-ghost" id="delete-user-btn" style="color:var(--danger)">Delete account</button>
    </div>
    <h3 style="font-size:15px;margin:20px 0 10px">Projects (read-only)</h3>
    <table class="table">
      <thead><tr><th>Name</th><th>Character</th><th>Files</th><th>Created</th></tr></thead>
      <tbody>${projectRows || '<tr><td colspan="4" class="muted">No projects</td></tr>'}</tbody>
    </table>
  `;

  document.getElementById('tier-select').addEventListener('change', async (e) => {
    try {
      await AdminAPI.patchUser(userId, { adminPlanId: e.target.value || null });
      adminToast('Tier updated', 'success');
      renderUserDetail(userId);
      renderUsersTable(document.getElementById('users-search').value);
    } catch (err) { adminToast(err.message, 'error'); }
  });

  document.getElementById('suspend-toggle-btn').addEventListener('click', async () => {
    try {
      await AdminAPI.patchUser(userId, { suspended: !user.suspended });
      adminToast(user.suspended ? 'User unsuspended' : 'User suspended', 'success');
      renderUserDetail(userId);
      renderUsersTable(document.getElementById('users-search').value);
    } catch (err) { adminToast(err.message, 'error'); }
  });

  document.getElementById('delete-user-btn').addEventListener('click', async () => {
    if (!confirm(`Permanently delete ${user.email}? This cannot be undone.`)) return;
    try {
      await AdminAPI.deleteUser(userId);
      adminToast('User deleted', 'success');
      detail.hidden = true;
      renderUsersTable(document.getElementById('users-search').value);
    } catch (err) { adminToast(err.message, 'error'); }
  });
}
```

- [ ] **Step 2: Verify in browser**

Reload `http://localhost:8080/admin`, stay on the Users tab. Confirm the table lists `admincheck@example.com` (and any other test accounts from earlier tasks). Search for "admincheck", confirm it filters. Click the row, confirm the detail panel shows usage bars, an empty projects table, and working Suspend/Unsuspend, tier-select, and Delete controls (verify Suspend and tier-assign against the same effects already checked via curl in Tasks 9-10). Do **not** delete the test user yet if you plan to reuse it in Task 14 — delete afterward instead.

- [ ] **Step 3: Commit**

```bash
git add public/js/admin.js
git commit -m "Add admin panel Users tab: search, list, detail panel with usage/tier/suspend/delete"
```

---

### Task 14: Frontend — impersonation pickup on the customer side

**Files:**
- Modify: `public/js/api.js`

- [ ] **Step 1: Add the hash-token pickup at the top of `api.js`**

In `public/js/api.js`, add this immediately before the `const Auth = {` declaration (so it runs before any page's own `Auth.requireLogin()` call, since `<script src="/js/api.js">` executes fully before the page's inline `<script>` block that follows it):

```js
// Admin "View as user" opens /dashboard#imp=<token> in a new tab — pick up
// the impersonation token into the normal session key and scrub the URL so
// it doesn't linger in history/address bar.
if (location.hash.startsWith('#imp=')) {
  localStorage.setItem('apToken', decodeURIComponent(location.hash.slice(5)));
  history.replaceState(null, '', location.pathname);
}
```

- [ ] **Step 2: Wire up the "View as user" button in `admin.js`**

In `public/js/admin.js`, inside `renderUserDetail`, add the impersonate handler alongside the other button listeners (after the `delete-user-btn` listener added in Task 13):

```js
  document.getElementById('impersonate-btn').addEventListener('click', async () => {
    try {
      const { token } = await AdminAPI.impersonate(userId);
      window.open(`/dashboard#imp=${encodeURIComponent(token)}`, '_blank');
    } catch (err) { adminToast(err.message, 'error'); }
  });
```

- [ ] **Step 3: Verify end-to-end in a browser**

On `http://localhost:8080/admin`'s Users tab, open the `admincheck@example.com` detail panel and click "View as user". Confirm a new tab opens at `/dashboard`, logged in as that user (their email visible in the top-nav user menu), and that the URL fragment is stripped after load. Confirm the admin tab's own session (`localStorage.adminToken`) is untouched by this — switch back to the admin tab and confirm it's still showing the admin view, not logged out.

- [ ] **Step 4: Commit**

```bash
git add public/js/api.js public/js/admin.js
git commit -m "Wire up admin impersonation: View as user opens dashboard with a short-lived session"
```

---

### Task 15: Frontend — Tiers tab

**Files:**
- Modify: `public/js/admin.js`

- [ ] **Step 1: Add the Tiers tab rendering**

Append to `public/js/admin.js`:

```js
async function loadTiersTab() {
  const section = document.getElementById('tab-tiers');
  section.innerHTML = `
    <div class="card mb-lg">
      <div class="card-header"><h2 class="card-title">Create tier</h2></div>
      <form id="tier-form" class="col gap-sm">
        <input type="text" id="tier-name" placeholder="Tier name (e.g. Acme Corp bump)" required class="input" />
        <div class="row gap-sm" style="flex-wrap:wrap">
          ${['projects', 'filesPerProject', 'storageMb', 'monthlyMessages', 'monthlyEmbeddingChars', 'urlSources']
            .map(f => `<input type="number" min="1" name="${f}" placeholder="${f}" required class="input" style="max-width:180px" />`).join('')}
        </div>
        <button type="submit" class="btn btn-primary" style="align-self:flex-start">Create tier</button>
      </form>
    </div>
    <div id="tiers-table"></div>
  `;
  document.getElementById('tier-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = fd.get('name') || document.getElementById('tier-name').value;
    const limits = {};
    for (const f of ['projects', 'filesPerProject', 'storageMb', 'monthlyMessages', 'monthlyEmbeddingChars', 'urlSources']) {
      limits[f] = parseInt(fd.get(f), 10);
    }
    try {
      await AdminAPI.createTier({ name: document.getElementById('tier-name').value, limits });
      adminToast('Tier created', 'success');
      e.target.reset();
      renderTiersTable();
    } catch (err) { adminToast(err.message, 'error'); }
  });
  await renderTiersTable();
}

async function renderTiersTable() {
  const { tiers } = await AdminAPI.listTiers();
  const rows = tiers.map(t => `
    <tr>
      <td>${t.name}</td>
      <td class="muted text-sm">${t.id}</td>
      <td class="text-sm">${Object.entries(t.limits).map(([k, v]) => `${k}: ${formatNum(v)}`).join(', ')}</td>
      <td><button class="btn btn-ghost text-sm" data-delete-tier="${t.id}" style="color:var(--danger)">Delete</button></td>
    </tr>`).join('');
  document.getElementById('tiers-table').innerHTML = `
    <table class="table">
      <thead><tr><th>Name</th><th>ID</th><th>Limits</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">No custom tiers yet</td></tr>'}</tbody>
    </table>`;
  for (const btn of document.querySelectorAll('[data-delete-tier]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this tier?')) return;
      try {
        await AdminAPI.deleteTier(btn.dataset.deleteTier);
        adminToast('Tier deleted', 'success');
        renderTiersTable();
      } catch (err) { adminToast(err.message, 'error'); }
    });
  }
}
```

- [ ] **Step 2: Verify in browser**

Switch to the Tiers tab on `/admin`. Create a tier with some test limits, confirm it appears in the table. Assign it to a user via the Users tab, then try deleting it from the Tiers tab — confirm the 409 error surfaces as a toast ("Tier is still assigned to at least one user"). Clear the assignment and delete again — confirm it succeeds.

- [ ] **Step 3: Commit**

```bash
git add public/js/admin.js
git commit -m "Add admin panel Tiers tab: create, list, delete custom plan tiers"
```

---

### Task 16: Frontend — Audit Log tab

**Files:**
- Modify: `public/js/admin.js`

- [ ] **Step 1: Add the Audit Log tab rendering**

Append to `public/js/admin.js`:

```js
async function loadAuditTab() {
  const section = document.getElementById('tab-audit');
  const { entries } = await AdminAPI.auditLog(1);
  const rows = entries.map(e => `
    <tr>
      <td class="text-sm">${new Date(e.createdAt).toLocaleString()}</td>
      <td class="text-sm">${e.adminEmail || e.adminId}</td>
      <td><span class="pill pill-info">${e.action}</span></td>
      <td class="text-sm">${e.targetEmail || ''}</td>
      <td class="muted text-sm">${e.meta ? JSON.stringify(e.meta) : ''}</td>
    </tr>`).join('');
  section.innerHTML = `
    <table class="table">
      <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target user</th><th>Details</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No admin actions yet</td></tr>'}</tbody>
    </table>`;
}
```

- [ ] **Step 2: Verify in browser**

Switch to the Audit Log tab. Confirm it shows entries for every suspend/unsuspend/tier-assign/delete/impersonate/tier-create/tier-delete action performed in earlier tasks' browser and curl verification steps, each with the correct admin email and target user email.

- [ ] **Step 3: Commit**

```bash
git add public/js/admin.js
git commit -m "Add admin panel Audit Log tab"
```

---

### Task 17: Full end-to-end walkthrough

**Files:** none (verification only)

- [ ] **Step 1: Run the complete flow fresh, in a browser, from a clean-ish state**

1. Sign up a brand-new test customer at `http://localhost:8080/signup` (e.g. `e2e-test@example.com`).
2. Open `http://localhost:8080/admin`, log in as `admin-test@example.com`.
3. Users tab: search for `e2e-test`, open their detail panel — confirm they show as `free` plan, not suspended, 0 projects.
4. Create a project as that user in `/dashboard` (in the other tab), come back to admin, reopen their detail panel — confirm the project now appears read-only in the Projects table with correct file count (0).
5. Tiers tab: create a tier `E2E Bump` with `projects: 50` and reasonable values for the rest.
6. Users tab: assign `E2E Bump` to the e2e-test user. Confirm their plan badge now reads `custom-e2e-bump-... (admin)`.
7. As the e2e-test customer (their own tab, logged in normally), visit `/billing` — confirm the usage bars now show `/ 50` for chatbots instead of the free plan's `/ 3`.
8. Back in admin, suspend the e2e-test user. Confirm the customer tab's next API call (e.g. reloading `/dashboard`) kicks them out (401/403 → redirected to login by `Auth.logout()`).
9. Unsuspend them; confirm they can log back in normally.
10. Click "View as user" from admin — confirm a new tab opens already logged in as them.
11. Delete the e2e-test user from admin. Confirm they disappear from the Users tab list and can no longer log in at `/login`.
12. Audit Log tab: confirm all of the above actions (assign_tier, suspend, unsuspend, impersonate, delete_user, tier_create) appear with correct timestamps and target emails, most recent first.
13. Confirm the tab bar and detail panel render correctly in both light and dark theme (toggle via the same theme mechanism as the rest of the app, `public/js/theme.js`).

- [ ] **Step 2: Clean up test data**

```bash
psql "$DATABASE_URL" -c "DELETE FROM users WHERE email IN ('admincheck@example.com');"
psql "$DATABASE_URL" -c "DELETE FROM plan_tiers WHERE name IN ('Test Bump', 'E2E Bump');"
```

(The `e2e-test@example.com` user was already deleted via the admin panel in Step 1.12; `admin-test@example.com` admin account can stay as your real seeded admin, or delete it too and reseed for production with real credentials — see Task 7's script.)

- [ ] **Step 3: Final commit (if any cleanup touched tracked files — typically none)**

No commit expected for this task; it's verification-only. If you find and fix a bug during the walkthrough, make that fix as its own properly-described commit rather than folding it in here.

---

## Post-implementation note

Before using this in a real production environment: seed the real admin account with `node backend/scripts/create-admin.js <real-email> <strong-password>` directly against the production `DATABASE_URL`, and do **not** commit or share that password. The `admin-test@example.com` account created during this plan's verification is for local dev only — delete it (`DELETE FROM admin_users WHERE email = 'admin-test@example.com';`) before deploying, or simply don't seed it in production in the first place.
