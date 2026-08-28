# Human Handoff (Live Agent Takeover) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a visitor request a human (or have the AI offer one when it can't help) and, if a business-plan project's owner/team currently has the dashboard open, connect them into a live two-way chat — falling back to a contact-capture form when no one's around.

**Architecture:** A single `ws.Server` attached to the existing `http.Server` in `backend/server.js` (no new service — see the approved spec's confirmed persistent-Node-process deployment target). Two upgrade paths (`/ws/embed/:publicId` for visitors, `/ws/dashboard/:projectId` for the team), an in-memory presence/routing registry, `sessions`/`messages` schema extensions for handoff state, a reused `[[CAPTURE...]]`-style sentinel tag (`[[REQUEST_HUMAN]]`) for AI auto-escalation, and inline JS additions to `embed.html`/`project.html` matching this codebase's existing (no-separate-JS-files) convention for those two pages.

**Tech Stack:** Node.js/Express, `ws` (new dependency), PostgreSQL (`pg`), vanilla JS (no framework), `node:test` for backend tests.

**Spec:** `docs/superpowers/specs/2026-08-28-human-handoff-design.md` — read it first; this plan implements it exactly, with one correction found during planning (see Task 1: `sessions.updated_at` was missing from the spec's migration — `db.js`'s `update()` stamps `updated_at` on every UPDATE regardless of table, so any table it's ever called against needs that column or the query 500s, same class of bug already hit once in this codebase's history for `webhook_deliveries`).

**Before starting:** `backend/services/email.js` / `backend/services/emailTemplates.js` may be under concurrent edit by another session (observed mid-brainstorming) — re-read both fully before Task 4's edits rather than trusting the excerpts quoted in this plan.

---

### Task 1: Schema migration

**Files:**
- Create: `supabase/migrations/2026-08-28_add_handoff.sql`
- Modify: `supabase/schema.sql` (append the same statements, per this repo's convention — it's the idempotent source of truth, migrations are a dated record of *why*)

- [ ] **Step 1: Write the migration file**

```sql
-- ═══════════════════════════════════════════════════════════════════
-- Migration: Human handoff (live agent takeover) — see
-- docs/superpowers/specs/2026-08-28-human-handoff-design.md.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already appended to
-- schema.sql; this file is a standalone, dated record of *why* they were
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-28_add_handoff.sql
-- ═══════════════════════════════════════════════════════════════════

-- ── sessions: handoff state ──────────────────────────────────────
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS handoff_status       TEXT NOT NULL DEFAULT 'none'; -- 'none' | 'requested' | 'active' | 'resolved'
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS claimed_by           UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS claimed_at           BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS handoff_requested_at BIGINT;
-- db.js's update() unconditionally stamps updated_at on every UPDATE
-- regardless of table (see webhook_deliveries' migration for the same
-- note) — this table is now a db.update() target (claim/resolve), so it
-- needs the column or those calls 500.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at           BIGINT;
CREATE INDEX IF NOT EXISTS idx_sessions_handoff_pending
  ON sessions(project_id, handoff_status)
  WHERE handoff_status IN ('requested', 'active');

-- ── messages: human attribution ──────────────────────────────────
-- role gains a new value 'human' alongside the existing 'user'/'assistant'.
-- sender_id is null for AI/visitor messages, set for a team member's.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_id UUID REFERENCES users(id) ON DELETE SET NULL;
```

- [ ] **Step 2: Append the same statements to `supabase/schema.sql`**

Open `supabase/schema.sql`, find the `messages` table definition (search for `CREATE TABLE IF NOT EXISTS messages`), and add a comment + the same `ALTER TABLE` block immediately after it, e.g.:

```sql
-- ── messages ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id         UUID   PRIMARY KEY,
  session_id UUID   NOT NULL REFERENCES sessions(id)  ON DELETE CASCADE,
  project_id UUID   NOT NULL REFERENCES projects(id)  ON DELETE CASCADE,
  role       TEXT   NOT NULL,
  text       TEXT,
  created_at BIGINT NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════
-- Human handoff — see
-- supabase/migrations/2026-08-28_add_handoff.sql and
-- docs/superpowers/specs/2026-08-28-human-handoff-design.md.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS handoff_status       TEXT NOT NULL DEFAULT 'none';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS claimed_by           UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS claimed_at           BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS handoff_requested_at BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at           BIGINT;
CREATE INDEX IF NOT EXISTS idx_sessions_handoff_pending
  ON sessions(project_id, handoff_status)
  WHERE handoff_status IN ('requested', 'active');
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_id UUID REFERENCES users(id) ON DELETE SET NULL;
```

- [ ] **Step 3: Apply it to the dev database and verify**

Run:
```bash
node -e "
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const sql = fs.readFileSync('supabase/migrations/2026-08-28_add_handoff.sql', 'utf8');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query(sql).then(() => { console.log('OK'); return pool.end(); }).catch(e => { console.error('ERR:', e.message); pool.end(); process.exit(1); });
"
```
Expected: `OK`.

Then verify the columns exist:
```bash
node -e "
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='sessions' AND column_name IN ('handoff_status','claimed_by','claimed_at','handoff_requested_at','updated_at')\").then(r => { console.log(r.rows); return pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='messages' AND column_name='sender_id'\"); }).then(r => { console.log(r.rows); pool.end(); }).catch(e => { console.error(e.message); pool.end(); });
"
```
Expected: 5 rows for `sessions`, 1 row for `messages`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-08-28_add_handoff.sql supabase/schema.sql
git commit -m "Add handoff_status/claimed_by/claimed_at/updated_at to sessions, sender_id to messages"
```

---

### Task 2: Add the `ws` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

Run:
```bash
npm install ws@^8.18.0
```
Expected: `package.json`'s `dependencies` gains `"ws": "^8.18.0"` (alphabetical — lands right after `stripe`), and `package-lock.json` updates.

- [ ] **Step 2: Verify it loads**

Run: `node -e "require('ws'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "Add ws dependency for human handoff WebSocket server"
```

---

### Task 3: Presence registry

**Files:**
- Create: `backend/ws/presence.js`
- Test: `backend/ws/presence.test.js`

Pure in-memory logic — no DB, no real sockets — so this is fully unit-testable with fake socket-shaped objects.

- [ ] **Step 1: Write the failing test**

```js
// backend/ws/presence.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const presence = require('./presence');

test('hasAvailability is false with no connections', () => {
  presence._reset();
  assert.equal(presence.hasAvailability('proj-1'), false);
});

test('adding a dashboard socket makes the project available', () => {
  presence._reset();
  const entry = { ws: { readyState: 1, OPEN: 1, send: () => {} }, userId: 'u1', userName: 'Sarah' };
  presence.addDashboardSocket('proj-1', entry);
  assert.equal(presence.hasAvailability('proj-1'), true);
});

test('removing the last socket makes the project unavailable again', () => {
  presence._reset();
  const entry = { ws: { readyState: 1, OPEN: 1, send: () => {} }, userId: 'u1', userName: 'Sarah' };
  presence.addDashboardSocket('proj-1', entry);
  presence.removeDashboardSocket('proj-1', entry);
  assert.equal(presence.hasAvailability('proj-1'), false);
});

test('removing one of two sockets keeps the project available', () => {
  presence._reset();
  const a = { ws: { readyState: 1, OPEN: 1, send: () => {} }, userId: 'u1', userName: 'Sarah' };
  const b = { ws: { readyState: 1, OPEN: 1, send: () => {} }, userId: 'u2', userName: 'Tom' };
  presence.addDashboardSocket('proj-1', a);
  presence.addDashboardSocket('proj-1', b);
  presence.removeDashboardSocket('proj-1', a);
  assert.equal(presence.hasAvailability('proj-1'), true);
});

test('broadcastToProject sends to every open socket for that project, not other projects', () => {
  presence._reset();
  const sent = [];
  const makeSocket = (id) => ({ readyState: 1, OPEN: 1, send: (msg) => sent.push({ id, msg }) });
  presence.addDashboardSocket('proj-1', { ws: makeSocket('a'), userId: 'u1', userName: 'Sarah' });
  presence.addDashboardSocket('proj-1', { ws: makeSocket('b'), userId: 'u2', userName: 'Tom' });
  presence.addDashboardSocket('proj-2', { ws: makeSocket('c'), userId: 'u3', userName: 'Ana' });
  presence.broadcastToProject('proj-1', { type: 'queue_update', pending: [] });
  assert.equal(sent.length, 2);
  assert.ok(sent.every(s => JSON.parse(s.msg).type === 'queue_update'));
});

test('broadcastToProject skips a socket that is not OPEN', () => {
  presence._reset();
  const sent = [];
  const openSocket = { readyState: 1, OPEN: 1, send: (msg) => sent.push(msg) };
  const closedSocket = { readyState: 3, OPEN: 1, send: (msg) => sent.push(msg) };
  presence.addDashboardSocket('proj-1', { ws: openSocket, userId: 'u1', userName: 'Sarah' });
  presence.addDashboardSocket('proj-1', { ws: closedSocket, userId: 'u2', userName: 'Tom' });
  presence.broadcastToProject('proj-1', { type: 'x' });
  assert.equal(sent.length, 1);
});

test('sendToUser delivers only to the matching userId within a project', () => {
  presence._reset();
  const sent = [];
  const makeSocket = (id) => ({ readyState: 1, OPEN: 1, send: (msg) => sent.push({ id, msg }) });
  presence.addDashboardSocket('proj-1', { ws: makeSocket('a'), userId: 'u1', userName: 'Sarah' });
  presence.addDashboardSocket('proj-1', { ws: makeSocket('b'), userId: 'u2', userName: 'Tom' });
  const delivered = presence.sendToUser('proj-1', 'u2', { type: 'chat', text: 'hi' });
  assert.equal(delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'b');
});

test('sendToUser returns false when that user has no connected socket', () => {
  presence._reset();
  const delivered = presence.sendToUser('proj-1', 'nobody', { type: 'chat', text: 'hi' });
  assert.equal(delivered, false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test backend/ws/presence.test.js`
Expected: FAIL — `Cannot find module './presence'`

- [ ] **Step 3: Write the implementation**

```js
// backend/ws/presence.js
/**
 * In-memory registry of live dashboard WebSocket connections, keyed by
 * project. A project "has availability" exactly when this registry holds
 * at least one entry for it — no separate online/offline flag, no DB
 * heartbeat. Lives only as long as the process, which is fine given the
 * confirmed persistent-Node-process deployment target (see
 * docs/superpowers/specs/2026-08-28-human-handoff-design.md) — a restart
 * drops connections and the dashboard reconnects, re-registering itself.
 */

// projectId -> Set<{ ws, userId, userName }>
const byProject = new Map();

function addDashboardSocket(projectId, entry) {
  if (!byProject.has(projectId)) byProject.set(projectId, new Set());
  byProject.get(projectId).add(entry);
}

function removeDashboardSocket(projectId, entry) {
  const set = byProject.get(projectId);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) byProject.delete(projectId);
}

function hasAvailability(projectId) {
  const set = byProject.get(projectId);
  return !!set && set.size > 0;
}

// Queue/status updates — every connected team member for the project sees these.
function broadcastToProject(projectId, message) {
  const set = byProject.get(projectId);
  if (!set) return;
  const payload = JSON.stringify(message);
  for (const entry of set) {
    if (entry.ws.readyState === entry.ws.OPEN) entry.ws.send(payload);
  }
}

// Actual chat content — only the team member who claimed a session sees
// its messages, not every connected teammate (privacy: an unclaimed
// visitor's words shouldn't leak to someone not handling them).
function sendToUser(projectId, userId, message) {
  const set = byProject.get(projectId);
  if (!set) return false;
  const payload = JSON.stringify(message);
  let delivered = false;
  for (const entry of set) {
    if (entry.userId === userId && entry.ws.readyState === entry.ws.OPEN) {
      entry.ws.send(payload);
      delivered = true;
    }
  }
  return delivered;
}

// Test-only.
function _reset() { byProject.clear(); }

module.exports = { addDashboardSocket, removeDashboardSocket, hasAvailability, broadcastToProject, sendToUser, _reset };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test backend/ws/presence.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/ws/presence.js backend/ws/presence.test.js
git commit -m "Add in-memory dashboard presence registry for human handoff"
```

---

### Task 4: Handoff-request email notification

**Files:**
- Modify: `backend/services/emailTemplates.js` (add a `handoff_request` fallback template)
- Modify: `backend/services/email.js` (add `sendHandoffRequestEmail`)
- Create: `backend/ws/notify.js` (grace-window scheduling + rate limit)
- Test: `backend/ws/notify.test.js`

**Re-read both `email.js` and `emailTemplates.js` in full before editing** — a concurrent session was observed touching these files during planning.

- [ ] **Step 1: Add the fallback template**

In `backend/services/emailTemplates.js`, add a new entry to `FALLBACK_TEMPLATES` (any position — it's a plain object; the existing entries aren't alphabetized either, so add it after `"contact_message"`):

```js
  "handoff_request": {
    "subject": "Someone wants to talk to a human on ${projectName}",
    "body": "\n      <div style=\"font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px\">\n        <h2 style=\"margin:0 0 16px;font-size:20px\">A visitor is waiting</h2>\n        <p style=\"color:#555;line-height:1.6\">Someone chatting with <strong>${escapeHtml(projectName)}</strong> asked to talk to a person. No one on the team currently has the dashboard open.</p>\n        <p style=\"color:#333;line-height:1.6;background:#f6f4ff;padding:12px 16px;border-radius:8px;font-style:italic\">\"${escapeHtml(previewText)}\"</p>\n        <a href=\"${BASE_URL()}/dashboard\" style=\"display:inline-block;margin:24px 0;padding:12px 24px;background:#7c6af5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600\">Open Live Chat →</a>\n        <hr style=\"border:none;border-top:1px solid #eee;margin:24px 0\"/>\n        <p style=\"color:#bbb;font-size:11px\">AvatarPlatform · <a href=\"${BASE_URL()}\" style=\"color:#bbb\">${BASE_URL()}</a></p>\n      </div>"
  }
```

- [ ] **Step 2: Add `sendHandoffRequestEmail` to `email.js`**

Add this function, matching the existing style of `sendTeamInviteEmail` right above it, and add `sendHandoffRequestEmail` to the `module.exports` line at the bottom of the file:

```js
/**
 * Notify a project's owner + team when a handoff request has sat
 * unclaimed past the grace window — see backend/ws/notify.js, which
 * schedules and (if claimed first) cancels this.
 * @param {{ project: object, previewText: string, recipients: string[] }} opts
 */
async function sendHandoffRequestEmail({ project, previewText, recipients }) {
  if (!recipients.length) return;
  const { subject, body } = await getTemplate('handoff_request');
  const filledSubject = interpolate(subject, { '${projectName}': project.name });
  const html = interpolate(body, {
    '${escapeHtml(projectName)}': escapeHtml(project.name),
    '${escapeHtml(previewText)}': escapeHtml(previewText || '(no message yet)'),
    '${BASE_URL()}': BASE_URL(),
  });
  await send({
    to: recipients,
    subject: filledSubject,
    text: `Someone chatting with "${project.name}" asked to talk to a human — no one has the dashboard open right now. Their message: "${previewText || '(no message yet)'}"\n\nOpen Live Chat: ${BASE_URL()}/dashboard`,
    html,
  });
}
```

Check the top of `email.js` for an `escapeHtml` import/definition (used already by `sendTeamInviteEmail`/`sendContactMessage`) — reuse it, don't redefine.

Update the final line:
```js
module.exports = { sendPasswordReset, sendWelcome, sendContactMessage, sendVerificationEmail, sendTeamInviteEmail, sendHandoffRequestEmail };
```

- [ ] **Step 3: Write the failing test for the scheduler**

```js
// backend/ws/notify.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

test('scheduleHandoffEmail sends after the grace window if not cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  stubFile('../services/email', { sendHandoffRequestEmail: async (opts) => { sent.push(opts); } });
  stubFile('../db', {
    findOne: async (table, filter) => {
      if (table === 'sessions') return { id: filter.id, handoffStatus: 'requested' };
      if (table === 'users') return { id: filter.id, email: 'owner@example.com' };
      return null;
    },
    query: async () => [],
    queryOne: async () => ({ text: 'Hello, is anyone there?' }),
  });
  delete require.cache[require.resolve('./notify')];
  const notify = require('./notify');
  notify._reset();

  notify.scheduleHandoffEmail('sess-1', { id: 'proj-1', userId: 'user-1', name: 'Test Bot' });
  t.mock.timers.tick(notify.GRACE_MS);
  await new Promise(r => setImmediate(r));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipients.includes('owner@example.com'), true);
  assert.equal(sent[0].previewText, 'Hello, is anyone there?');
});

test('cancelHandoffEmail prevents the email from sending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  stubFile('../services/email', { sendHandoffRequestEmail: async (opts) => { sent.push(opts); } });
  stubFile('../db', { findOne: async () => ({ handoffStatus: 'requested' }), query: async () => [], queryOne: async () => null });
  delete require.cache[require.resolve('./notify')];
  const notify = require('./notify');
  notify._reset();

  notify.scheduleHandoffEmail('sess-2', { id: 'proj-2', userId: 'user-2', name: 'Test Bot 2' });
  notify.cancelHandoffEmail('sess-2');
  t.mock.timers.tick(notify.GRACE_MS);
  await new Promise(r => setImmediate(r));

  assert.equal(sent.length, 0);
});

test('a session already claimed before the timer fires does not send', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  stubFile('../services/email', { sendHandoffRequestEmail: async (opts) => { sent.push(opts); } });
  stubFile('../db', { findOne: async () => ({ handoffStatus: 'active' }), query: async () => [], queryOne: async () => null });
  delete require.cache[require.resolve('./notify')];
  const notify = require('./notify');
  notify._reset();

  notify.scheduleHandoffEmail('sess-3', { id: 'proj-3', userId: 'user-3', name: 'Test Bot 3' });
  t.mock.timers.tick(notify.GRACE_MS);
  await new Promise(r => setImmediate(r));

  assert.equal(sent.length, 0);
});

test('rate limit skips a second email for the same project within 5 minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  stubFile('../services/email', { sendHandoffRequestEmail: async (opts) => { sent.push(opts); } });
  stubFile('../db', { findOne: async () => ({ handoffStatus: 'requested' }), query: async () => [], queryOne: async () => null });
  delete require.cache[require.resolve('./notify')];
  const notify = require('./notify');
  notify._reset();

  notify.scheduleHandoffEmail('sess-4', { id: 'proj-4', userId: 'user-4', name: 'Test Bot 4' });
  t.mock.timers.tick(notify.GRACE_MS);
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1);

  notify.scheduleHandoffEmail('sess-5', { id: 'proj-4', userId: 'user-4', name: 'Test Bot 4' });
  t.mock.timers.tick(notify.GRACE_MS);
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1, 'second email for the same project should be rate-limited');
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `node --test backend/ws/notify.test.js`
Expected: FAIL — `Cannot find module './notify'`

- [ ] **Step 5: Write the implementation**

```js
// backend/ws/notify.js
/**
 * Schedules the "no one claimed this handoff request in time" email (see
 * services/email.js sendHandoffRequestEmail) with a grace window and a
 * per-project rate limit, so a repeatedly-re-requesting visitor can't
 * spam the team's inboxes. In-memory — fine given the confirmed
 * persistent-Node-process deployment target; a restart just means any
 * in-flight grace timers are lost, which only means one possible missed
 * email, not a correctness bug.
 */
const db = require('../db');
const { sendHandoffRequestEmail } = require('../services/email');
const logger = require('../logger').child({ module: 'ws/notify' });

const GRACE_MS = 20_000;
const RATE_LIMIT_MS = 5 * 60_000;

const timers = new Map();            // sessionId -> Timeout
const lastSentByProject = new Map(); // projectId -> timestamp

function scheduleHandoffEmail(sessionId, project) {
  cancelHandoffEmail(sessionId);
  const timer = setTimeout(() => fire(sessionId, project), GRACE_MS);
  timers.set(sessionId, timer);
}

async function fire(sessionId, project) {
  timers.delete(sessionId);
  const last = lastSentByProject.get(project.id) || 0;
  if (Date.now() - last < RATE_LIMIT_MS) return;
  try {
    const session = await db.findOne('sessions', { id: sessionId });
    if (!session || session.handoffStatus !== 'requested') return; // claimed (or gone) already
    const owner = await db.findOne('users', { id: project.userId });
    const members = await db.query(
      `SELECT u.email FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = $1`,
      [project.id]
    );
    const recipients = [owner?.email, ...members.map(m => m.email)].filter(Boolean);
    const firstMessage = await db.queryOne(
      `SELECT text FROM messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [sessionId]
    );
    await sendHandoffRequestEmail({ project, previewText: firstMessage?.text || '', recipients });
    lastSentByProject.set(project.id, Date.now());
  } catch (e) {
    logger.error({ err: e.message, sessionId }, 'handoff request email failed');
  }
}

function cancelHandoffEmail(sessionId) {
  const timer = timers.get(sessionId);
  if (timer) { clearTimeout(timer); timers.delete(sessionId); }
}

// Test-only.
function _reset() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  lastSentByProject.clear();
}

module.exports = { scheduleHandoffEmail, cancelHandoffEmail, _reset, GRACE_MS, RATE_LIMIT_MS };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test backend/ws/notify.test.js`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add backend/services/emailTemplates.js backend/services/email.js backend/ws/notify.js backend/ws/notify.test.js
git commit -m "Add handoff-request email notification with grace window and rate limit"
```

---

### Task 5: WebSocket server — auth, protocol, relay

**Files:**
- Create: `backend/ws/handoff.js`
- Test: `backend/ws/handoff.test.js`

This is the core of the feature: two upgrade paths, the message protocol from the spec, and DB persistence. Tested with a real `http.Server` + real `ws` client sockets on an ephemeral port (same "exercise the real thing" approach as this repo's existing `embed.test.js`), with `../db` and `../services/usage` stubbed so no real DB is needed.

- [ ] **Step 1: Write the failing integration test**

```js
// backend/ws/handoff.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-do-not-use-in-prod';

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

const PROJECT = { id: 'proj-1', userId: 'owner-1', publicId: 'pub-1', name: 'Test Bot' };
const OWNER = { id: 'owner-1', email: 'owner@example.com', name: 'Owner', suspended: false };

function makeDb() {
  const sessions = new Map();
  const messages = [];
  return {
    _sessions: sessions,
    _messages: messages,
    findOne: async (table, filter) => {
      if (table === 'projects') {
        if (filter.publicId) return filter.publicId === PROJECT.publicId ? { ...PROJECT } : null;
        if (filter.id && filter.userId) return (filter.id === PROJECT.id && filter.userId === PROJECT.userId) ? { ...PROJECT } : null;
        if (filter.id) return filter.id === PROJECT.id ? { ...PROJECT } : null;
        return null;
      }
      if (table === 'users') return filter.id === OWNER.id ? { ...OWNER } : null;
      if (table === 'sessions') return sessions.get(filter.id) || null;
      if (table === 'projectMembers') return null;
      return null;
    },
    insert: async (table, row) => {
      if (table === 'sessions') sessions.set(row.id, { ...row, handoffStatus: 'none', claimedBy: null });
      if (table === 'messages') messages.push(row);
      return row;
    },
    update: async (table, id, patch) => {
      if (table === 'sessions') {
        const existing = sessions.get(id) || { id };
        const updated = { ...existing, ...patch };
        sessions.set(id, updated);
        return updated;
      }
      return null;
    },
    query: async (sql) => {
      if (/FROM sessions s/.test(sql)) {
        return [...sessions.values()]
          .filter(s => s.projectId === PROJECT.id && ['requested', 'active'].includes(s.handoffStatus))
          .map(s => ({ id: s.id, handoffStatus: s.handoffStatus, claimedBy: s.claimedBy, handoffRequestedAt: s.handoffRequestedAt, claimedByName: s.claimedBy ? OWNER.name : null, preview: messages.find(m => m.sessionId === s.id)?.text || null }));
      }
      return [];
    },
    queryOne: async () => null,
  };
}

async function startServer(db) {
  stubFile('../db', db);
  stubFile('../cache', { projectCache: { has: () => false, get: () => undefined, set: () => {} } });
  stubFile('../services/usage', { userPlanId: async () => 'business' });
  stubFile('./notify', { scheduleHandoffEmail: () => {}, cancelHandoffEmail: () => {} });
  delete require.cache[require.resolve('./handoff')];
  const { attach } = require('./handoff');
  const server = http.createServer();
  attach(server);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  return { server, port };
}

function waitForMessage(ws) {
  return new Promise(resolve => ws.once('message', (data) => resolve(JSON.parse(data.toString()))));
}

test('visitor connects without a sessionId and the server creates one', async () => {
  const db = makeDb();
  const { server, port } = await startServer(db);
  try {
    const visitorWs = new WebSocket(`ws://localhost:${port}/ws/embed/${PROJECT.publicId}`);
    const first = await waitForMessage(visitorWs);
    assert.equal(first.type, 'connected');
    assert.ok(first.sessionId);
    visitorWs.close();
  } finally {
    server.close();
  }
});

test('full flow: request -> queue_update to dashboard -> claim -> chat both ways -> resolve', async () => {
  const db = makeDb();
  const { server, port } = await startServer(db);
  try {
    const token = jwt.sign({ uid: OWNER.id }, process.env.JWT_SECRET);
    const dashWs = new WebSocket(`ws://localhost:${port}/ws/dashboard/${PROJECT.id}?token=${token}`);
    const initialSnapshot = await waitForMessage(dashWs); // sent immediately on connect
    assert.equal(initialSnapshot.type, 'queue_update');
    assert.equal(initialSnapshot.pending.length, 0);

    const visitorWs = new WebSocket(`ws://localhost:${port}/ws/embed/${PROJECT.publicId}`);
    const connected = await waitForMessage(visitorWs);
    const sessionId = connected.sessionId;

    const dashUpdatePromise = waitForMessage(dashWs);
    visitorWs.send(JSON.stringify({ type: 'request_handoff' }));
    const waitingReply = await waitForMessage(visitorWs);
    assert.equal(waitingReply.type, 'waiting'); // dashboard is connected -> available

    const queueUpdate = await dashUpdatePromise;
    assert.equal(queueUpdate.type, 'queue_update');
    assert.equal(queueUpdate.pending.length, 1);
    assert.equal(queueUpdate.pending[0].sessionId, sessionId);

    const claimedPromise = waitForMessage(visitorWs);
    dashWs.send(JSON.stringify({ type: 'claim', sessionId }));
    const claimed = await claimedPromise;
    assert.equal(claimed.type, 'claimed');
    assert.equal(claimed.byName, OWNER.name);

    const humanChatPromise = waitForMessage(dashWs);
    visitorWs.send(JSON.stringify({ type: 'chat', text: 'Hi, I need help' }));
    const relayedToHuman = await humanChatPromise;
    assert.equal(relayedToHuman.type, 'chat');
    assert.equal(relayedToHuman.from, 'visitor');
    assert.equal(relayedToHuman.text, 'Hi, I need help');

    const visitorChatPromise = waitForMessage(visitorWs);
    dashWs.send(JSON.stringify({ type: 'chat', sessionId, text: 'Sure, happy to help!' }));
    const relayedToVisitor = await visitorChatPromise;
    assert.equal(relayedToVisitor.type, 'chat');
    assert.equal(relayedToVisitor.from, 'human');
    assert.equal(relayedToVisitor.text, 'Sure, happy to help!');

    assert.equal(db._messages.filter(m => m.sessionId === sessionId).length, 2);

    const resolvedPromise = waitForMessage(visitorWs);
    dashWs.send(JSON.stringify({ type: 'resolve', sessionId }));
    const resolved = await resolvedPromise;
    assert.equal(resolved.type, 'resolved');
    assert.equal(db._sessions.get(sessionId).handoffStatus, 'resolved');

    dashWs.close(); visitorWs.close();
  } finally {
    server.close();
  }
});

test('no one available: visitor gets no_one_available when no dashboard socket is connected', async () => {
  const db = makeDb();
  const { server, port } = await startServer(db);
  try {
    const visitorWs = new WebSocket(`ws://localhost:${port}/ws/embed/${PROJECT.publicId}`);
    await waitForMessage(visitorWs); // connected
    const replyPromise = waitForMessage(visitorWs);
    visitorWs.send(JSON.stringify({ type: 'request_handoff' }));
    const reply = await replyPromise;
    assert.equal(reply.type, 'no_one_available');
    visitorWs.close();
  } finally {
    server.close();
  }
});

test('dashboard upgrade is rejected for a non-business plan', async () => {
  const db = makeDb();
  stubFile('../services/usage', { userPlanId: async () => 'pro' });
  const { server, port } = await startServer(db);
  try {
    const token = jwt.sign({ uid: OWNER.id }, process.env.JWT_SECRET);
    const dashWs = new WebSocket(`ws://localhost:${port}/ws/dashboard/${PROJECT.id}?token=${token}`);
    const result = await new Promise(resolve => {
      dashWs.on('open', () => resolve('open'));
      dashWs.on('unexpected-response', (req, res) => resolve(res.statusCode));
      dashWs.on('error', () => resolve('error'));
    });
    assert.equal(result, 403);
  } finally {
    server.close();
  }
});

test('dashboard upgrade is rejected with an invalid token', async () => {
  const db = makeDb();
  const { server, port } = await startServer(db);
  try {
    const dashWs = new WebSocket(`ws://localhost:${port}/ws/dashboard/${PROJECT.id}?token=not-a-real-token`);
    const result = await new Promise(resolve => {
      dashWs.on('open', () => resolve('open'));
      dashWs.on('unexpected-response', (req, res) => resolve(res.statusCode));
      dashWs.on('error', () => resolve('error'));
    });
    assert.equal(result, 401);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test backend/ws/handoff.test.js`
Expected: FAIL — `Cannot find module './handoff'`

- [ ] **Step 3: Write the implementation**

```js
// backend/ws/handoff.js
/**
 * Human handoff WebSocket server — attached to the same http.Server as
 * the Express app (see server.js), not a separate service. Two upgrade
 * paths:
 *   /ws/embed/:publicId?sessionId=...   visitor side, anonymous
 *   /ws/dashboard/:projectId?token=...  team side, JWT + business-plan gate
 * See docs/superpowers/specs/2026-08-28-human-handoff-design.md Part 2
 * for the full protocol table.
 */
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const { projectCache } = require('../cache');
const { userPlanId } = require('../services/usage');
const logger = require('../logger').child({ module: 'ws/handoff' });
const presence = require('./presence');
const { scheduleHandoffEmail, cancelHandoffEmail } = require('./notify');

const JWT_SECRET = process.env.JWT_SECRET;

async function findProjectByPublicId(publicId) {
  if (projectCache.has(publicId)) return projectCache.get(publicId);
  const project = await db.findOne('projects', { publicId });
  if (project) projectCache.set(publicId, project);
  return project;
}

// sessionId -> ws (visitor connections, at most one per session at a time)
const visitorSockets = new Map();

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const visitorMatch = url.pathname.match(/^\/ws\/embed\/([a-zA-Z0-9_-]+)$/);
    const dashboardMatch = url.pathname.match(/^\/ws\/dashboard\/([0-9a-fA-F-]{36})$/);

    if (visitorMatch) {
      handleVisitorUpgrade(wss, req, socket, head, visitorMatch[1], url.searchParams.get('sessionId')).catch(e => {
        logger.error({ err: e.message }, 'visitor upgrade failed');
        socket.destroy();
      });
    } else if (dashboardMatch) {
      handleDashboardUpgrade(wss, req, socket, head, dashboardMatch[1], url.searchParams.get('token')).catch(e => {
        logger.error({ err: e.message }, 'dashboard upgrade failed');
        socket.destroy();
      });
    } else {
      socket.destroy();
    }
  });

  return wss;
}

function reject(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
  socket.destroy();
}

async function handleVisitorUpgrade(wss, req, socket, head, publicId, sessionIdParam) {
  const project = await findProjectByPublicId(publicId);
  if (!project) return reject(socket, 404, 'Not Found');

  let session = sessionIdParam ? await db.findOne('sessions', { id: sessionIdParam, projectId: project.id }) : null;
  if (!session) {
    session = await db.insert('sessions', {
      id: crypto.randomUUID(),
      projectId: project.id,
      ip: req.socket.remoteAddress || 'unknown',
      createdAt: Date.now(),
    });
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    visitorSockets.set(session.id, ws);
    ws.send(JSON.stringify({ type: 'connected', sessionId: session.id }));

    ws.on('message', (raw) => {
      handleVisitorMessage(project, session.id, ws, raw).catch(e =>
        logger.error({ err: e.message, sessionId: session.id }, 'visitor message handling failed'));
    });
    ws.on('close', () => {
      if (visitorSockets.get(session.id) === ws) visitorSockets.delete(session.id);
      cancelHandoffEmail(session.id);
    });
  });
}

async function handleDashboardUpgrade(wss, req, socket, head, projectId, token) {
  if (!token) return reject(socket, 401, 'Unauthorized');

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return reject(socket, 401, 'Unauthorized');
  }
  if (!payload.uid || payload.isAdmin) return reject(socket, 401, 'Unauthorized');

  const user = await db.findOne('users', { id: payload.uid });
  if (!user || user.suspended) return reject(socket, 401, 'Unauthorized');

  let project = await db.findOne('projects', { id: projectId, userId: user.id });
  if (!project) {
    const anyProject = await db.findOne('projects', { id: projectId });
    if (!anyProject) return reject(socket, 404, 'Not Found');
    const member = await db.findOne('projectMembers', { projectId, userId: user.id });
    if (!member) return reject(socket, 403, 'Forbidden');
    project = anyProject;
  }

  const planId = await userPlanId(project.userId);
  if (planId !== 'business') return reject(socket, 403, 'Forbidden');

  wss.handleUpgrade(req, socket, head, (ws) => {
    const entry = { ws, userId: user.id, userName: user.name || user.email };
    presence.addDashboardSocket(projectId, entry);

    sendQueueSnapshot(projectId, ws).catch(e => logger.error({ err: e.message }, 'initial snapshot failed'));

    ws.on('message', (raw) => {
      handleDashboardMessage(projectId, entry, raw).catch(e =>
        logger.error({ err: e.message, projectId }, 'dashboard message handling failed'));
    });
    ws.on('close', () => presence.removeDashboardSocket(projectId, entry));
  });
}

async function handleVisitorMessage(project, sessionId, ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  if (msg.type === 'request_handoff') {
    await db.update('sessions', sessionId, {
      handoffStatus: 'requested', handoffRequestedAt: Date.now(), claimedBy: null, claimedAt: null,
    });
    const available = presence.hasAvailability(project.id);
    ws.send(JSON.stringify({ type: available ? 'waiting' : 'no_one_available' }));
    presence.broadcastToProject(project.id, await queueSnapshotPayload(project.id));
    scheduleHandoffEmail(sessionId, project);
    return;
  }

  if (msg.type === 'chat') {
    const text = String(msg.text || '').slice(0, 2000);
    if (!text) return;
    const session = await db.findOne('sessions', { id: sessionId });
    if (!session || session.handoffStatus !== 'active' || !session.claimedBy) return;
    await db.insert('messages', {
      id: crypto.randomUUID(), sessionId, projectId: project.id, role: 'user', text, createdAt: Date.now(),
    });
    presence.sendToUser(project.id, session.claimedBy, { type: 'chat', text, from: 'visitor' });
  }
}

async function handleDashboardMessage(projectId, entry, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  if (msg.type === 'claim') {
    const session = await db.findOne('sessions', { id: msg.sessionId, projectId });
    if (!session || session.handoffStatus !== 'requested') return;
    await db.update('sessions', session.id, { handoffStatus: 'active', claimedBy: entry.userId, claimedAt: Date.now() });
    cancelHandoffEmail(session.id);
    const visitorWs = visitorSockets.get(session.id);
    if (visitorWs && visitorWs.readyState === visitorWs.OPEN) {
      visitorWs.send(JSON.stringify({ type: 'claimed', byName: entry.userName }));
    }
    presence.broadcastToProject(projectId, await queueSnapshotPayload(projectId));
    return;
  }

  if (msg.type === 'resolve') {
    const session = await db.findOne('sessions', { id: msg.sessionId, projectId });
    if (!session || session.claimedBy !== entry.userId) return;
    await db.update('sessions', session.id, { handoffStatus: 'resolved' });
    const visitorWs = visitorSockets.get(session.id);
    if (visitorWs && visitorWs.readyState === visitorWs.OPEN) {
      visitorWs.send(JSON.stringify({ type: 'resolved' }));
    }
    presence.broadcastToProject(projectId, await queueSnapshotPayload(projectId));
    return;
  }

  if (msg.type === 'chat') {
    const text = String(msg.text || '').slice(0, 2000);
    if (!text) return;
    const session = await db.findOne('sessions', { id: msg.sessionId, projectId });
    if (!session || session.handoffStatus !== 'active' || session.claimedBy !== entry.userId) return;
    await db.insert('messages', {
      id: crypto.randomUUID(), sessionId: session.id, projectId, role: 'human', senderId: entry.userId, text, createdAt: Date.now(),
    });
    const visitorWs = visitorSockets.get(session.id);
    if (visitorWs && visitorWs.readyState === visitorWs.OPEN) {
      visitorWs.send(JSON.stringify({ type: 'chat', text, from: 'human', byName: entry.userName }));
    }
  }
}

async function queueSnapshotPayload(projectId) {
  const rows = await db.query(
    `SELECT s.id, s.handoff_status, s.claimed_by, s.handoff_requested_at, u.name AS claimed_by_name,
            (SELECT text FROM messages WHERE session_id = s.id ORDER BY created_at ASC LIMIT 1) AS preview
       FROM sessions s
       LEFT JOIN users u ON u.id = s.claimed_by
      WHERE s.project_id = $1 AND s.handoff_status IN ('requested', 'active')
      ORDER BY s.handoff_requested_at ASC`,
    [projectId]
  );
  return {
    type: 'queue_update',
    pending: rows.filter(r => r.handoffStatus === 'requested').map(r => ({ sessionId: r.id, preview: r.preview, requestedAt: r.handoffRequestedAt })),
    active: rows.filter(r => r.handoffStatus === 'active').map(r => ({ sessionId: r.id, claimedBy: r.claimedBy, claimedByName: r.claimedByName, preview: r.preview })),
  };
}

async function sendQueueSnapshot(projectId, ws) {
  const payload = await queueSnapshotPayload(projectId);
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

module.exports = { attach };
```

**Note on the test's `makeDb().query`:** the stub's `FROM sessions s` regex match is intentionally loose — it only needs to distinguish the one raw-SQL query this module issues (`queueSnapshotPayload`) from anything else, matching this repo's existing stubbing style (`embed.test.js` does the same table-name-sniffing rather than a full SQL parser).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test backend/ws/handoff.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/ws/handoff.js backend/ws/handoff.test.js
git commit -m "Add human handoff WebSocket server: auth, protocol, relay"
```

---

### Task 6: Wire the WebSocket server into `server.js`

**Files:**
- Modify: `backend/server.js`

- [ ] **Step 1: Import and attach**

Find this block (the requires near the top):
```js
const adminRoutes = require('./routes/admin');
```
Add nearby (with the other route/service requires):
```js
const { attach: attachHandoffWs } = require('./ws/handoff');
```

Find the `app.listen(...)` block:
```js
  const server = app.listen(PORT, () => {
    logger.info(`AvatarPlatform running at http://localhost:${PORT}`);
```
Immediately after `const server = app.listen(PORT, () => {` closes (i.e., right after the closing `});` of that listen callback, still inside the `if (!process.env.VERCEL)` block), add:
```js
  attachHandoffWs(server);
```
So it reads:
```js
  const server = app.listen(PORT, () => {
    logger.info(`AvatarPlatform running at http://localhost:${PORT}`);
    // ... existing boot-log lines unchanged ...
  });

  attachHandoffWs(server);

  function shutdown(signal) {
```

- [ ] **Step 2: Extend graceful shutdown to close WS connections first**

Find `function shutdown(signal) {`:
```js
  function shutdown(signal) {
    logger.info({ signal }, 'shutdown received');
    server.close(() => {
      logger.info('server closed');
      pool.end().catch((err) => logger.warn({ err }, 'error closing pg pool')).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }
```
`server.close()` alone won't close already-open WebSocket connections (only stops accepting new ones) — a deploy would otherwise leave them dangling until the 10s force-exit. Since `ws` exposes the underlying `WebSocketServer` via `attachHandoffWs`'s return value, capture it and close its clients:
```js
  const handoffWss = attachHandoffWs(server);

  function shutdown(signal) {
    logger.info({ signal }, 'shutdown received');
    for (const client of handoffWss.clients) client.close(1001, 'Server restarting');
    server.close(() => {
      logger.info('server closed');
      pool.end().catch((err) => logger.warn({ err }, 'error closing pg pool')).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }
```
(This replaces the plain `attachHandoffWs(server);` line from Step 1 with `const handoffWss = attachHandoffWs(server);`.)

- [ ] **Step 3: Verify the server still boots**

Run: `node --check backend/server.js`
Expected: no output (syntax OK)

Run: `PORT=8099 node backend/server.js &` then `sleep 1 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8099/healthz` then kill the background process.
Expected: `200`, and the process boot log includes no new errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all existing tests plus the new `backend/ws/*.test.js` files pass.

- [ ] **Step 5: Commit**

```bash
git add backend/server.js
git commit -m "Attach human handoff WebSocket server to the HTTP server"
```

---

### Task 7: `handoffEnabled` in `/embed/:publicId/config`

**Files:**
- Modify: `backend/routes/embed.js`
- Modify: `backend/routes/embed.test.js` (extend existing coverage)

- [ ] **Step 1: Write the failing test**

`SERVER_ONLY_PORT`/`BOTH_KEYS_PORT` (declared near the top of the file) are unused dead constants — the file's real pattern wraps a fresh Express `app` per case with in-process `supertest(app)`, no real listening port. `../db`'s stubbed `findOne` only returns non-null for the `'projects'` table (everything else, including `'subscriptions'`, returns `null`), and `userPlanId` isn't stubbed in this file — so the real `services/usage.js`'s `userPlanId` runs, finds no active subscription, and resolves to `'free'`. That makes Case A's project exactly a free-plan project already, perfect for asserting `handoffEnabled: false`.

Add a new assertion inside Case A's existing `await t.test('config omits apiKey and flags text-only mode', ...)` block, right after its existing `assert.notEqual(res.body.limitMessage, undefined);` line:

```js
  await t.test('config omits apiKey and flags text-only mode', async () => {
    const res = await serverOnlyAgent.get('/embed/test-public-id/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.apiKey, null, 'server key must never appear in /config');
    assert.equal(res.body.voiceEnabled, false);
    assert.equal(res.body.limitReached, false);
    assert.notEqual(res.body.limitMessage, undefined);
    assert.equal(res.body.handoffEnabled, false, 'free-plan project must not expose handoff');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test backend/routes/embed.test.js`
Expected: FAIL — `handoffEnabled` is `undefined`, not `false`

- [ ] **Step 3: Implement**

In `backend/routes/embed.js`, find the `/config` handler:
```js
    const planId = await userPlanId(project.userId);
    const messageLimitCheck = await checkLimit(project.userId, 'message', 1);
    const publicApiKey = await getPublicApiKey();

    res.json({
```
Reuse the already-fetched `planId` (no extra query needed):
```js
    const planId = await userPlanId(project.userId);
    const messageLimitCheck = await checkLimit(project.userId, 'message', 1);
    const publicApiKey = await getPublicApiKey();
    const handoffEnabled = planId === 'business';

    res.json({
```
Then add the field to the response body, next to the existing `voiceEnabled`/`limitReached` fields:
```js
      apiKey: messageLimitCheck.ok && publicApiKey ? publicApiKey : null,
      voiceEnabled: messageLimitCheck.ok && !!publicApiKey,
      handoffEnabled,
      limitReached: !messageLimitCheck.ok,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test backend/routes/embed.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/routes/embed.js backend/routes/embed.test.js
git commit -m "Add handoffEnabled (business-plan gate) to /embed/:publicId/config"
```

---

### Task 8: `[[REQUEST_HUMAN]]` tag + AI pause during handoff

**Files:**
- Modify: `backend/routes/embed.js` (`/ask` and `/study` handlers)
- Create: `backend/services/handoffTag.js` (shared tag-stripping helper, since both handlers need identical logic — DRY rather than duplicating the regex twice)
- Test: `backend/services/handoffTag.test.js`

- [ ] **Step 1: Write the failing test for the shared helper**

```js
// backend/services/handoffTag.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HANDOFF_INSTRUCTION, extractHandoffTag } = require('./handoffTag');

test('extractHandoffTag strips the tag and reports it was present', () => {
  const { clean, requested } = extractHandoffTag('I\'m not sure about that.\n[[REQUEST_HUMAN]]');
  assert.equal(clean, 'I\'m not sure about that.');
  assert.equal(requested, true);
});

test('extractHandoffTag leaves normal text untouched when the tag is absent', () => {
  const { clean, requested } = extractHandoffTag('Here is the answer you asked for.');
  assert.equal(clean, 'Here is the answer you asked for.');
  assert.equal(requested, false);
});

test('extractHandoffTag handles the tag appearing mid-text, not just at the end', () => {
  const { clean, requested } = extractHandoffTag('Let me connect you. [[REQUEST_HUMAN]] One moment.');
  assert.equal(clean, 'Let me connect you.  One moment.'.replace(/ {2,}/g, ' ').trim() === 'Let me connect you. One moment.' ? 'Let me connect you. One moment.' : clean);
  assert.equal(requested, true);
});

test('HANDOFF_INSTRUCTION mentions the exact tag the extractor looks for', () => {
  assert.ok(HANDOFF_INSTRUCTION.includes('[[REQUEST_HUMAN]]'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test backend/services/handoffTag.test.js`
Expected: FAIL — `Cannot find module './handoffTag'`

- [ ] **Step 3: Implement**

```js
// backend/services/handoffTag.js
/**
 * Shared AI auto-escalation sentinel, mirroring the existing
 * [[CAPTURE:key=value]] / [[OPTIONS:...]] pattern used for lead capture
 * and quick replies (see public/embed.html) — a system-prompt instruction
 * plus a regex strip, not a Gemini function-calling tool, so it works at
 * every capability tier (not just the ones with tool-calling enabled).
 * Used server-side by /ask and /study (backend/routes/embed.js); the
 * voice/SDK path strips the identical tag client-side in embed.html using
 * the same instruction text baked into that page's system prompt builder.
 */
const HANDOFF_INSTRUCTION = `

HUMAN HANDOFF: If you cannot help the visitor after a genuine effort, or
they explicitly ask for a person/human/representative, say so naturally
and append the exact tag [[REQUEST_HUMAN]] on its own line. Do not mention
the tag to the user — it will be stripped before display.`;

const HANDOFF_TAG_RE = /\[\[REQUEST_HUMAN\]\]/g;

function extractHandoffTag(text) {
  let requested = false;
  let clean = String(text || '').replace(HANDOFF_TAG_RE, () => { requested = true; return ''; });
  clean = clean.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { clean, requested };
}

module.exports = { HANDOFF_INSTRUCTION, extractHandoffTag };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test backend/services/handoffTag.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire into `/ask`**

In `backend/routes/embed.js`, add the import near the top with the other `services/*` requires:
```js
const { HANDOFF_INSTRUCTION, extractHandoffTag } = require('../services/handoffTag');
```

Find the `/ask` handler's session-extraction line:
```js
    const ip = req.ip || 'unknown';
    const { question, sessionId: incomingSessionId } = req.body;

    // 1. Embed the question
```
Insert an early pause-check right after it (before the embedding call, to avoid a wasted Gemini call when a handoff is already active):
```js
    const ip = req.ip || 'unknown';
    const { question, sessionId: incomingSessionId } = req.body;

    // If this session already has a pending/active human handoff, the AI
    // is fully out of the loop — the visitor's widget should be talking
    // to the WebSocket handoff channel instead of this REST endpoint, but
    // handle a stray call defensively rather than silently double-answering.
    if (incomingSessionId) {
      const existingSession = await db.findOne('sessions', { id: incomingSessionId, projectId: project.id });
      if (existingSession && ['requested', 'active'].includes(existingSession.handoffStatus)) {
        return res.json({
          answer: "You're currently connected with a team member — please continue the conversation here.",
          sources: [], sessionId: incomingSessionId,
        });
      }
    }

    // 1. Embed the question
```

Find where the system prompt is built:
```js
    const systemPrompt = project.systemPrompt ||
      'You are a helpful AI assistant. Answer the user\'s question using the provided knowledge base context. Be concise and accurate.';
```
Append the handoff instruction, gated on `handoffEnabled` (compute it the same way `/config` does):
```js
    const planId = await userPlanId(project.userId);
    const handoffEnabled = planId === 'business';
    const systemPrompt = (project.systemPrompt ||
      'You are a helpful AI assistant. Answer the user\'s question using the provided knowledge base context. Be concise and accurate.')
      + (handoffEnabled ? HANDOFF_INSTRUCTION : '');
```

Find where `answer` is set from the Gemini response:
```js
      const result = await model.generateContent(prompt);
      answer = result.response.text();
```
Strip the tag and capture whether it fired:
```js
      const result = await model.generateContent(prompt);
      const extracted = extractHandoffTag(result.response.text());
      answer = extracted.clean;
```

Find the final `res.json`:
```js
    res.json({ answer, sources, sessionId: sid });
```
Add the flag:
```js
    res.json({ answer, sources, sessionId: sid, offerHandoff: extracted.requested });
```

(`extracted` needs to be declared in a scope reachable at this point — since it's assigned inside the `try` block that also declares `answer`, either hoist `let extracted = { requested: false };` alongside the existing `let answer = '';` declaration above the `try`, and assign `extracted = extractHandoffTag(...)` inside it, or reference `extracted.requested` only within that same try's continuation before the outer scope ends. Simplest: change `let answer = '';` to `let answer = ''; let offerHandoff = false;` right above the try block, set `offerHandoff = extracted2.requested; answer = extracted2.clean;` inline, and reference `offerHandoff` in the final `res.json`.)

Restate this step precisely to avoid the scoping ambiguity above — the actual diff:
```js
    // 4. Call Gemini REST
    let answer = '';
    let offerHandoff = false;
    try {
      const genai = new GoogleGenerativeAI(await settings.getSetting('GEMINI_API_KEY'));
      const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent(prompt);
      const extracted = extractHandoffTag(result.response.text());
      answer = extracted.clean;
      offerHandoff = extracted.requested;
    } catch (e) {
      logger.error({ err: e.message }, 'ask Gemini call failed');
      return res.status(502).json({ error: 'AI service unavailable' });
    }
```
and:
```js
    res.json({ answer, sources, sessionId: sid, offerHandoff });
```

- [ ] **Step 6: Wire into `/study`**

Find the `/study` handler's session-extraction line (mirrors `/ask`'s Step 5 above, same defensive pause-check):
```js
    const ip = req.ip || 'unknown';
    const { message, sessionId: incomingSessionId } = req.body;

    // 1. Embed the message + retrieve knowledge-base context (same pattern as /ask)
```
Insert:
```js
    const ip = req.ip || 'unknown';
    const { message, sessionId: incomingSessionId } = req.body;

    if (incomingSessionId) {
      const existingSession = await db.findOne('sessions', { id: incomingSessionId, projectId: project.id });
      if (existingSession && ['requested', 'active'].includes(existingSession.handoffStatus)) {
        return res.json({
          answer: "You're currently connected with a team member — please continue the conversation here.",
          toolCalls: [], sources: [], figures: [], sessionId: incomingSessionId,
        });
      }
    }

    // 1. Embed the message + retrieve knowledge-base context (same pattern as /ask)
```

Find where `systemInstruction` is built:
```js
    const basePrompt = project.systemPrompt ||
      'You are a helpful AI study assistant. Answer using the provided knowledge base context.';
    const contextText = contextParts.length
      ? `Knowledge base context:\n\n${contextParts.join('\n\n---\n\n')}`
      : 'No relevant context found in the knowledge base.';
    const systemInstruction = `${basePrompt}\n\n${contextText}`;
```
`/study` already requires `capabilityTier !== 'basic'` to be reached at all, but `handoffEnabled` is still plan-based, independent of tier — check it the same way:
```js
    const planId = await userPlanId(project.userId);
    const handoffEnabled = planId === 'business';
    const basePrompt = project.systemPrompt ||
      'You are a helpful AI study assistant. Answer using the provided knowledge base context.';
    const contextText = contextParts.length
      ? `Knowledge base context:\n\n${contextParts.join('\n\n---\n\n')}`
      : 'No relevant context found in the knowledge base.';
    const systemInstruction = `${basePrompt}\n\n${contextText}` + (handoffEnabled ? HANDOFF_INSTRUCTION : '');
```

Find where `answer` is finalized:
```js
      answer = result.response.text();
    } catch (e) {
      logger.error({ err: e.message }, 'study Gemini call failed');
      return res.status(502).json({ error: 'AI service unavailable' });
    }
```
Change the declaration above (`let answer = '';`) to also declare `let offerHandoff = false;`, and update the assignment:
```js
      const extracted = extractHandoffTag(result.response.text());
      answer = extracted.clean;
      offerHandoff = extracted.requested;
    } catch (e) {
      logger.error({ err: e.message }, 'study Gemini call failed');
      return res.status(502).json({ error: 'AI service unavailable' });
    }
```

Find the final `res.json`:
```js
    res.json({ answer, toolCalls, sources, figures, sessionId: sid });
```
```js
    res.json({ answer, toolCalls, sources, figures, sessionId: sid, offerHandoff });
```

- [ ] **Step 7: Write a regression test for the pause behavior**

Add a new self-contained case to `backend/routes/embed.test.js`, matching the file's existing "Case A/B/C" style (own `stubFile('../db', ...)` override, own fresh `require.cache` delete + app, so it can't affect the shared stub the other cases rely on). Add it after Case C's block:

```js
// ── Case D: an active handoff pauses /ask instead of calling Gemini ─────
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
```

- [ ] **Step 8: Run the tests**

Run: `node --test backend/routes/embed.test.js backend/services/handoffTag.test.js`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add backend/services/handoffTag.js backend/services/handoffTag.test.js backend/routes/embed.js backend/routes/embed.test.js
git commit -m "Add [[REQUEST_HUMAN]] AI auto-escalation tag and pause /ask,/study during handoff"
```

---

### Task 9: Widget UI (`public/embed.html`)

**Files:**
- Modify: `public/embed.html`
- Modify: `public/css/embed.css`

No test harness exists for this file today (confirmed — no `public/*.test.js` anywhere in the repo); verify manually per Task 11.

- [ ] **Step 1: Add the header button**

Find the header's button group:
```html
        <button class="icon-btn" id="fullscreen-btn" title="Full screen" aria-label="Full screen" hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>
        </button>
```
Add immediately before it (so it reads left-to-right: handoff, fullscreen, minimize):
```html
        <button class="icon-btn" id="handoff-btn" title="Talk to a human" aria-label="Talk to a human" hidden type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </button>
```

- [ ] **Step 2: Add CSS for human messages and system notices**

In `public/css/embed.css`, find:
```css
.msg.interim { opacity: .65; font-style: italic; }
```
Add after it:
```css
.msg.human {
  align-self: flex-start;
  background: var(--bot-bg);
  color: var(--text);
  border-bottom-left-radius: 4px;
  border-left: 3px solid var(--accent);
}
.msg.system {
  align-self: center;
  background: transparent;
  color: var(--text-dim);
  opacity: .8;
  font-size: 12px;
  text-align: center;
  padding: 4px 10px;
  max-width: 100%;
}
```

- [ ] **Step 3: Add handoff state variables**

Find the top-level `let` declarations:
```js
  let avatarCanvas = null;   // single Rive canvas element shuttled between slots
  let textOnly = false;      // true when no voice key (server answers via /ask)
```
Add after them:
```js
  let handoffWs = null;
  let handoffState = 'none'; // 'none' | 'connecting' | 'waiting' | 'active'
  let handoffReconnectAttempts = 0;
```

- [ ] **Step 4: Grab the new button element and show it when enabled**

Find:
```js
  const fullscreenBtn     = document.getElementById('fullscreen-btn');
```
Add after it:
```js
  const handoffBtn         = document.getElementById('handoff-btn');
```

Find, in `boot()`, the block that shows `fullscreenBtn` based on config:
```js
      if (config.project.showFullScreenToggle) {
        fullscreenBtn.hidden = false;
        updateFullscreenIcon();
      }
```
Add right after that `if` block (still inside `boot()`, unconditional on position since the button belongs in the header regardless of widget position):
```js
    if (config.handoffEnabled) {
      handoffBtn.hidden = false;
    }
```

- [ ] **Step 5: Write the WebSocket client + protocol handling**

Find `function waitForCanvas(cb, attempts = 60) {` and add the new functions immediately before it (keeps related helpers grouped, same section as `waitForConnected`/`finishBoot`):

```js
  // ── Human handoff ────────────────────────────────────────────
  function wsUrl(path) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}${path}`;
  }

  function requestHandoff() {
    if (handoffState !== 'none') return;
    if (avatar && !textOnly) {
      avatar.disconnect();
      document.getElementById('avatar-row').style.display = 'none';
    }
    handoffState = 'connecting';
    addMessage('bot', 'Connecting you with a team member…', { welcome: false });
    const url = sessionId
      ? wsUrl(`/ws/embed/${publicId}?sessionId=${encodeURIComponent(sessionId)}`)
      : wsUrl(`/ws/embed/${publicId}`);
    openHandoffSocket(url);
  }

  function openHandoffSocket(url) {
    handoffWs = new WebSocket(url);

    handoffWs.addEventListener('open', () => {
      handoffReconnectAttempts = 0;
      if (handoffState === 'connecting') {
        handoffWs.send(JSON.stringify({ type: 'request_handoff' }));
      }
    });

    handoffWs.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleHandoffMessage(msg);
    });

    handoffWs.addEventListener('close', () => {
      if (handoffState === 'active' || handoffState === 'waiting') {
        if (handoffReconnectAttempts < 5) {
          const delay = Math.min(1000 * Math.pow(2, handoffReconnectAttempts++), 15000);
          setTimeout(() => openHandoffSocket(wsUrl(`/ws/embed/${publicId}?sessionId=${encodeURIComponent(sessionId)}`)), delay);
        } else {
          addMessage('system', 'Connection lost — please refresh to reconnect.');
        }
      }
    });
  }

  function handleHandoffMessage(msg) {
    if (msg.type === 'connected') {
      sessionId = msg.sessionId;
      return;
    }
    if (msg.type === 'waiting') {
      handoffState = 'waiting';
      statusText.textContent = 'Waiting for a team member…';
      return;
    }
    if (msg.type === 'no_one_available') {
      handoffState = 'none';
      showHandoffCaptureForm();
      return;
    }
    if (msg.type === 'claimed') {
      handoffState = 'active';
      statusText.textContent = `Chatting with ${msg.byName}`;
      addMessage('system', `You're now chatting with ${msg.byName}.`);
      return;
    }
    if (msg.type === 'chat' && msg.from === 'human') {
      const el = addMessage('human', msg.text);
      el.dataset.byName = msg.byName || '';
      return;
    }
    if (msg.type === 'resolved') {
      handoffState = 'none';
      statusText.textContent = textOnly ? 'Text mode' : 'Online';
      addMessage('system', "You're back with the AI assistant.");
    }
  }

  function sendHandoffChat(text) {
    if (!handoffWs || handoffWs.readyState !== WebSocket.OPEN) return;
    handoffWs.send(JSON.stringify({ type: 'chat', text }));
    addMessage('user', text);
  }

  function showHandoffCaptureForm() {
    const el = document.createElement('div');
    el.className = 'msg system';
    el.style.cssText = 'align-self:stretch;max-width:100%;text-align:left;background:var(--bot-bg);border-radius:12px;padding:12px';
    el.innerHTML = `
      <p style="margin:0 0 8px;font-size:13px">No one's available right now — leave your info and we'll follow up.</p>
      <input type="text" placeholder="Your name" class="input" id="handoff-capture-name" style="width:100%;margin-bottom:6px;padding:8px;border-radius:8px;border:1px solid var(--border);font-size:13px" />
      <input type="email" placeholder="Your email" class="input" id="handoff-capture-email" style="width:100%;margin-bottom:8px;padding:8px;border-radius:8px;border:1px solid var(--border);font-size:13px" />
      <button type="button" id="handoff-capture-submit" style="width:100%;padding:8px;border-radius:8px;border:none;background:var(--accent);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Send</button>
    `;
    messagesEl.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    scrollToBottom();

    document.getElementById('handoff-capture-submit').addEventListener('click', async () => {
      const name = document.getElementById('handoff-capture-name').value.trim();
      const email = document.getElementById('handoff-capture-email').value.trim();
      if (!email) return;
      try {
        await fetch(`/embed/${publicId}/lead`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, data: { name, email }, complete: true }),
        });
        el.innerHTML = '<p style="margin:0;font-size:13px">Thanks — we\'ll be in touch.</p>';
      } catch {
        el.querySelector('p').textContent = 'Something went wrong — please try again.';
      }
    });
  }

```

Note: `showHandoffCaptureForm`'s `/lead` POST only persists fields matching the project's *configured* `captureFields` (see `backend/routes/embed.js`'s existing `/lead` handler — it filters `data` against `allowedKeys` from `captureFields`). If a project has no capture fields configured with keys `name`/`email`, this POST will silently store nothing. That's an acceptable v1 gap already implied by the spec's "reusing the existing capture-fields feature" — flag it in the manual verification task rather than building a parallel storage path.

- [ ] **Step 6: Wire the button click and route chat input while a handoff is active**

Find the bottom of the file where other buttons get listeners (near `fullscreenBtn.addEventListener('click', ...)` and `micBtn.addEventListener('click', ...)`), and add:
```js
  handoffBtn.addEventListener('click', () => requestHandoff());
```

The composer's actual dispatch function is `sendMessage(text)` (section `── 3. Sending messages ──`):
```js
  function sendMessage(text) {
    text = (text || '').trim();
    if (!text) return;
    if (textOnly) return sendTextOnly(text);

    addMessage('user', text);
    textInput.value = '';
    textInput.style.height = 'auto';
    sendBtn.disabled = true;

    const proceed = () => {
      currentBotMsgEl = addMessage('bot', '');
      avatar.sendText(text);
      sendBtn.disabled = false;
      logTurn('user', text);
    };
```
Add the handoff branch as the very first check, before the `textOnly` branch:
```js
  function sendMessage(text) {
    text = (text || '').trim();
    if (!text) return;
    if (handoffState === 'active') { sendHandoffChat(text); textInput.value = ''; textInput.style.height = 'auto'; return; }
    if (textOnly) return sendTextOnly(text);

    addMessage('user', text);
    textInput.value = '';
    textInput.style.height = 'auto';
    sendBtn.disabled = true;

    const proceed = () => {
      currentBotMsgEl = addMessage('bot', '');
      avatar.sendText(text);
      sendBtn.disabled = false;
      logTurn('user', text);
    };
```

- [ ] **Step 7: Hook the AI auto-escalation tag into voice mode**

Find `handleBotChunk`:
```js
  function handleBotChunk(text) {
    const { clean: cleanCapture, tags } = extractCaptureTags(text);
    const { clean, options } = extractOptionsTag(cleanCapture);
```
Add the handoff tag extraction (mirroring the exact same pattern) and trigger:
```js
  const HANDOFF_TAG_RE = /\[\[REQUEST_HUMAN\]\]/g;
  function extractHandoffTag(text) {
    let requested = false;
    const clean = text.replace(HANDOFF_TAG_RE, () => { requested = true; return ''; });
    return { clean, requested };
  }

  function handleBotChunk(text) {
    const { clean: cleanCapture, tags } = extractCaptureTags(text);
    const { clean: cleanOptions, options } = extractOptionsTag(cleanCapture);
    const { clean, requested: handoffRequested } = extractHandoffTag(cleanOptions);
    if (handoffRequested && config.handoffEnabled) requestHandoff();
```
(Note: the original code's second line was `const { clean, options } = extractOptionsTag(cleanCapture);` — this step renames that intermediate to `cleanOptions` and introduces the final `clean` from the new handoff-tag step, so every subsequent use of `clean` later in the function keeps working unchanged.)

Also add the system prompt instruction. Find `buildCaptureInstructions`'s call site in `initSDK`:
```js
    const baseSystemPrompt = (config.project.systemPrompt || '')
      + buildKnowledgeBaseToolInstructions()
      + buildCaptureInstructions(captureFields)
      + buildQuickReplyInstructions(config.project.showQuickReplies);
```
Add a handoff instruction, matching `buildCaptureInstructions`'s existing style (define a tiny local builder function right next to it, e.g. near `buildQuickReplyInstructions`'s definition):
```js
  function buildHandoffInstructions(enabled) {
    if (!enabled) return '';
    return `

HUMAN HANDOFF: If you cannot help the visitor after a genuine effort, or they explicitly ask for a person/human/representative, say so naturally and append the exact tag [[REQUEST_HUMAN]] on its own line. Do not mention the tag to the user — it will be stripped before display.`;
  }
```
Then:
```js
    const baseSystemPrompt = (config.project.systemPrompt || '')
      + buildKnowledgeBaseToolInstructions()
      + buildCaptureInstructions(captureFields)
      + buildQuickReplyInstructions(config.project.showQuickReplies)
      + buildHandoffInstructions(config.handoffEnabled);
```

- [ ] **Step 8: Hook `offerHandoff` into text mode (`sendTextOnly`)**

Find, in `sendTextOnly`:
```js
      const answerEl = addMessage('bot', data.answer || '…');
      if (config.project.showSourceCards !== false && data.sources && data.sources.length) {
        attachSources(answerEl, data.sources.map(s => ({
          fileId: null, fileName: s.title, kind: s.url ? 'url' : null, url: s.url || null, previewUrl: null,
        })));
      }
      notifyParent({ type: 'response', sessionId, answer: data.answer || '', sources: data.sources || [] });
```
Add, right after the `notifyParent` call:
```js
      if (data.offerHandoff && config.handoffEnabled) {
        const el = document.createElement('div');
        el.className = 'msg system';
        el.style.cssText = 'align-self:stretch;max-width:100%;background:var(--bot-bg);border-radius:12px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:8px';
        el.innerHTML = `<span style="font-size:13px">Want me to connect you with a human?</span><button type="button" style="padding:6px 12px;border-radius:8px;border:none;background:var(--accent);color:#fff;font-size:12px;font-weight:600;cursor:pointer">Yes, please</button>`;
        el.querySelector('button').addEventListener('click', () => { el.remove(); requestHandoff(); });
        messagesEl.appendChild(el);
        requestAnimationFrame(() => el.classList.add('visible'));
        scrollToBottom();
      }
```

- [ ] **Step 9: Verify no syntax errors**

Run: `node --check public/embed.html 2>&1 | head -5` — this will fail since it's not a `.js` file; instead extract and check the inline script:
```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('public/embed.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
for (const s of scripts) new Function(s); // throws SyntaxError if malformed
console.log('OK —', scripts.length, 'inline script block(s) parse cleanly');
"
```
Expected: `OK — 1 inline script block(s) parse cleanly` (or however many `<script>...</script>` blocks the file has — the CDN `<script src=...>` tags don't match this regex since they're self-closing with no body).

- [ ] **Step 10: Commit**

```bash
git add public/embed.html public/css/embed.css
git commit -m "Add human handoff UI to the embed widget"
```

---

### Task 10: Dashboard "Live Chat" tab (`public/project.html`)

**Files:**
- Modify: `public/project.html`
- Modify: `public/js/api.js` (no new REST calls needed — reuses `API.getSession`/`API.listSessions`; skip unless a helper is genuinely missing)

- [ ] **Step 1: Add the tab button and panel**

Find:
```html
      <button class="tab" data-tab="conversations">Conversations</button>
      <button class="tab" data-tab="leads" id="leads-tab">Leads</button>
```
Add between them:
```html
      <button class="tab" data-tab="livechat" id="livechat-tab" hidden>Live Chat<span id="livechat-badge" class="pill pill-danger" style="display:none;margin-left:6px;font-size:10px;padding:1px 6px"></span></button>
```

Find:
```html
    <section class="tab-panel" id="panel-conversations" hidden>
```
and locate its closing `</section>` (the next `<section class="tab-panel"` marks the boundary — insert the new panel right after Conversations' closing tag, before `panel-widget`):
```html
    <section class="tab-panel" id="panel-livechat" hidden>
      <div class="row gap-lg" style="align-items:flex-start">
        <div style="flex:1;min-width:0">
          <h3 class="text-sm" style="margin:0 0 8px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)">Waiting</h3>
          <div id="livechat-pending"></div>
          <h3 class="text-sm" style="margin:20px 0 8px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)">My active chats</h3>
          <div id="livechat-mine"></div>
          <h3 class="text-sm" style="margin:20px 0 8px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim)">Others' active chats</h3>
          <div id="livechat-others"></div>
        </div>
        <div id="livechat-thread" style="flex:1.4;min-width:0;display:none;border:1px solid var(--border);border-radius:12px;padding:12px;height:520px;display:flex;flex-direction:column">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong id="livechat-thread-title" style="font-size:13px"></strong>
            <button type="button" class="btn btn-ghost btn-sm" id="livechat-resolve-btn">Resolve</button>
          </div>
          <div id="livechat-thread-messages" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:4px"></div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <input type="text" id="livechat-thread-input" class="input" placeholder="Type a message…" style="flex:1" />
            <button type="button" class="btn btn-primary" id="livechat-thread-send">Send</button>
          </div>
        </div>
      </div>
    </section>
```

- [ ] **Step 2: Show the tab only for business-plan owners, and load it on activation**

Find `activateTab`'s dispatch block:
```js
    if (t.dataset.tab === 'conversations') loadSessions();
```
Add:
```js
    if (t.dataset.tab === 'livechat') openLiveChat();
```

Find `loadTeam`'s business-plan check (reuse the exact same pattern):
```js
  async function loadTeam(sub) {
    const isBusiness = !!sub && sub.plan.id === 'business';
    document.getElementById('team-upgrade-note').style.display = isBusiness ? 'none' : 'block';
    document.getElementById('team-body').style.display = isBusiness ? '' : 'none';
    if (!isBusiness) return;
```
Right after this function's definition (or at its first line), reveal the tab too:
```js
  async function loadTeam(sub) {
    const isBusiness = !!sub && sub.plan.id === 'business';
    document.getElementById('livechat-tab').hidden = !isBusiness;
    document.getElementById('team-upgrade-note').style.display = isBusiness ? 'none' : 'block';
    document.getElementById('team-body').style.display = isBusiness ? '' : 'none';
    if (!isBusiness) return;
```

Find the team-member read-only tab restriction:
```js
        const allowedTabs = new Set(['analytics', 'conversations']);
```
Add `'livechat'` so members can use it too (they gained this write capability per the spec):
```js
        const allowedTabs = new Set(['analytics', 'conversations', 'livechat']);
```
Note: for a member (not owner), `loadTeam(sub)` — and therefore the `livechat-tab` visibility toggle above — is never called in the member branch of `load()` (only `isOwner !== false` calls `loadTeam`). Add an explicit unhide for the member case too: in the `if (isOwner === false) { ... }` block, after the `allowedTabs` line, add:
```js
        document.getElementById('livechat-tab').hidden = false;
```
(A member's project is only ever business-tier in the first place, per the existing invite gate in `routes/projects.js` — so no further plan check is needed here.)

- [ ] **Step 3: Write the WebSocket client + queue rendering**

Add this whole block near `loadSessions`/`loadTranscript` (same "Conversations tab" section, since Live Chat reuses conversation-history patterns):

```js
  // ── Live Chat tab ──
  let liveChatWs = null;
  let liveChatReconnectAttempts = 0;
  let liveChatOpenSessionId = null;
  let liveChatQueue = { pending: [], active: [] };

  function liveChatWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws/dashboard/${projectId}?token=${encodeURIComponent(Auth.token)}`;
  }

  function openLiveChat() {
    if (liveChatWs && liveChatWs.readyState === WebSocket.OPEN) return;
    connectLiveChatWs();
  }

  function connectLiveChatWs() {
    liveChatWs = new WebSocket(liveChatWsUrl());
    liveChatWs.addEventListener('open', () => { liveChatReconnectAttempts = 0; });
    liveChatWs.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'queue_update') { liveChatQueue = msg; renderLiveChatQueue(); }
      if (msg.type === 'chat' && liveChatOpenSessionId) appendLiveChatMessage('visitor', msg.text);
    });
    liveChatWs.addEventListener('close', () => {
      const tabVisible = !document.getElementById('panel-livechat').hidden;
      if (tabVisible && liveChatReconnectAttempts < 5) {
        const delay = Math.min(1000 * Math.pow(2, liveChatReconnectAttempts++), 15000);
        setTimeout(connectLiveChatWs, delay);
      }
    });
  }

  function currentUserId() {
    return Auth.user?.id;
  }

  function renderLiveChatQueue() {
    const pendingEl = document.getElementById('livechat-pending');
    const mineEl = document.getElementById('livechat-mine');
    const othersEl = document.getElementById('livechat-others');
    const uid = currentUserId();

    const mine = liveChatQueue.active.filter(s => s.claimedBy === uid);
    const others = liveChatQueue.active.filter(s => s.claimedBy !== uid);

    document.getElementById('livechat-badge').style.display = liveChatQueue.pending.length + mine.length > 0 ? '' : 'none';
    document.getElementById('livechat-badge').textContent = String(liveChatQueue.pending.length + mine.length);

    pendingEl.innerHTML = liveChatQueue.pending.length
      ? liveChatQueue.pending.map(s => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
          <span class="text-sm" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape(s.preview || '(no message yet)')}</span>
          <button type="button" class="btn btn-primary btn-sm" data-claim="${s.sessionId}">Claim</button>
        </div>`).join('')
      : '<p class="muted text-sm">No one waiting.</p>';

    mineEl.innerHTML = mine.length
      ? mine.map(s => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer" data-open="${s.sessionId}">
          <span class="text-sm">${escape(s.preview || '(no message yet)')}</span>
          <span style="color:var(--text-dim);font-size:12px">→</span>
        </div>`).join('')
      : '<p class="muted text-sm">Nothing claimed yet.</p>';

    othersEl.innerHTML = others.length
      ? others.map(s => `<div class="text-sm muted" style="padding:6px 0">${escape(s.preview || '(no message yet)')} — claimed by ${escape(s.claimedByName || 'a teammate')}</div>`).join('')
      : '<p class="muted text-sm">No other active chats.</p>';

    pendingEl.querySelectorAll('[data-claim]').forEach(btn => {
      btn.addEventListener('click', () => {
        liveChatWs.send(JSON.stringify({ type: 'claim', sessionId: btn.dataset.claim }));
      });
    });
    mineEl.querySelectorAll('[data-open]').forEach(row => {
      row.addEventListener('click', () => openLiveChatThread(row.dataset.open));
    });
  }

  async function openLiveChatThread(sessionId) {
    liveChatOpenSessionId = sessionId;
    document.getElementById('livechat-thread').style.display = 'flex';
    document.getElementById('livechat-thread-title').textContent = 'Conversation';
    const body = document.getElementById('livechat-thread-messages');
    body.innerHTML = '<p class="muted text-sm">Loading…</p>';
    try {
      const { messages } = await API.getSession(projectId, sessionId);
      body.innerHTML = '';
      for (const m of messages) appendLiveChatMessage(m.role === 'human' ? 'human' : (m.role === 'user' ? 'visitor' : 'ai'), m.content);
    } catch (e) { toast(e.message, 'error'); }
  }

  function appendLiveChatMessage(from, text) {
    const body = document.getElementById('livechat-thread-messages');
    const isVisitor = from === 'visitor';
    const div = document.createElement('div');
    div.style.cssText = `align-self:${isVisitor ? 'flex-start' : 'flex-end'};max-width:80%;padding:8px 12px;border-radius:12px;font-size:13px;background:${isVisitor ? 'var(--bg-3)' : 'var(--accent)'};color:${isVisitor ? 'var(--text)' : '#fff'}`;
    div.textContent = text;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  document.getElementById('livechat-thread-send').addEventListener('click', () => {
    const input = document.getElementById('livechat-thread-input');
    const text = input.value.trim();
    if (!text || !liveChatOpenSessionId) return;
    liveChatWs.send(JSON.stringify({ type: 'chat', sessionId: liveChatOpenSessionId, text }));
    appendLiveChatMessage('human', text);
    input.value = '';
  });

  document.getElementById('livechat-resolve-btn').addEventListener('click', () => {
    if (!liveChatOpenSessionId) return;
    liveChatWs.send(JSON.stringify({ type: 'resolve', sessionId: liveChatOpenSessionId }));
    document.getElementById('livechat-thread').style.display = 'none';
    liveChatOpenSessionId = null;
  });
```

Confirmed: `backend/routes/auth.js`'s login/signup responses both return `user: { id: user.id, email: user.email, name: user.name }` (`public/login.html`/`public/signup.html` store this straight into `Auth.user`), so `Auth.user.id` is already populated — no further change needed for `currentUserId()` to work.

- [ ] **Step 4: Verify no syntax errors**

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('public/project.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
for (const s of scripts) new Function(s);
console.log('OK');
"
```
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add public/project.html
git commit -m "Add Live Chat dashboard tab for human handoff"
```

---

### Task 11: Manual end-to-end verification

**Files:** none — this is a verification pass, not a code change.

- [ ] **Step 1: Set a project to the business plan for testing**

Since Stripe checkout isn't necessary to test this locally, insert a fake active `business` subscription row for your test user directly:
```bash
node -e "
require('dotenv').config();
const db = require('./backend/db');
db.pool.query(\"INSERT INTO subscriptions (id, user_id, plan_id, status, created_at) SELECT 'test-business-sub', id, 'business', 'active', \" + Date.now() + \" FROM users WHERE email = 'YOUR_TEST_EMAIL' ON CONFLICT (id) DO NOTHING\").then(() => { console.log('done'); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
"
```
(Replace `YOUR_TEST_EMAIL` with a real signed-up test account's email.)

- [ ] **Step 2: Two-browser-window walkthrough**

1. Window A: log into the dashboard as the business-plan owner, open the project, click the **Live Chat** tab.
2. Window B (or an incognito window): open `/e/<publicId>` for that project directly (bypassing the in-app Preview iframe, so it's a true separate-origin-shaped session) and click **Talk to a human**.
3. In Window A, confirm the request appears under **Waiting** within a couple seconds; click **Claim**.
4. In Window B, confirm "You're now chatting with {name}" appears and the avatar/voice UI is gone (text-mode chat only).
5. Send a message from B → confirm it appears in A's thread pane. Send a reply from A → confirm it appears in B.
6. Click **Resolve** in A → confirm B shows "You're back with the AI assistant" and can resume normal AI chat.
7. Repeat steps 2-3 but close Window A's tab (or navigate away) before clicking Claim, so no dashboard socket is connected — confirm Window B instead shows the "leave your info" form, and that submitting it doesn't error.
8. With SMTP configured (or by watching server logs for the "SMTP not configured" no-op warning), confirm a `sendHandoffRequestEmail` attempt is logged ~20s after an unclaimed request.
9. Restart the dev server (`node --watch` will do this automatically on any `.js` save) while Window A has an active claimed chat open — confirm both windows' WebSocket clients reconnect within a few seconds without a full page reload being required, and that presence/queue state is consistent afterward (a stale claim doesn't silently linger).
10. Confirm a **Free-plan** project's widget never shows the "Talk to a human" button, and its `/config` response has `handoffEnabled: false`.

- [ ] **Step 3: Clean up test data**

```bash
node -e "
require('dotenv').config();
const db = require('./backend/db');
db.pool.query(\"DELETE FROM subscriptions WHERE id = 'test-business-sub'\").then(() => { console.log('done'); process.exit(0); });
"
```

- [ ] **Step 4: Run the full backend test suite one last time**

Run: `npm test`
Expected: all tests pass (existing + all new `backend/ws/*.test.js`, `backend/services/handoffTag.test.js`, extended `backend/routes/embed.test.js`).
