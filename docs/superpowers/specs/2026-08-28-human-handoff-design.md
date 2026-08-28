# Human handoff (live agent takeover)

**Files:** `supabase/schema.sql`, `supabase/migrations/2026-08-28_add_handoff.sql` (new), `backend/server.js`, `backend/ws/handoff.js` (new), `backend/routes/embed.js`, `backend/routes/projects.js`, `backend/services/email.js`, `backend/middleware/validate.js`, `package.json` (new `ws` dependency), `public/embed.html` (inline widget-side handoff JS — this page has no separate per-feature JS files, unlike the admin panel), `public/project.html` (inline Live Chat tab JS, same convention)
**Status:** Approved, ready for implementation plan

## Context

The embed widget currently has two conversation paths, neither of which involves a human: voice mode connects the visitor's browser directly to Gemini Live (the server never sees those messages), and text mode is a stateless `POST /embed/:publicId/ask` request/response against the server-side RAG pipeline. There is no realtime channel anywhere in the codebase — no WebSocket, no SSE, no push of any kind.

Goal: let a visitor either explicitly ask to talk to a person, or have the AI itself offer a handoff when it can't help, and — if a member of the project's team is currently watching the dashboard — connect them into a live back-and-forth chat with that visitor. If no one is around, capture the visitor's contact info and notify the team by email.

**Deployment context that shapes this design:** the app supports both Vercel serverless (`api/index.js`) and a persistent Node process (`npm start`/`node --watch backend/server.js`). Confirmed during brainstorming that **production runs as a persistent Node process**, not Vercel serverless — this unlocks a real WebSocket server attached to the same `http.Server` `server.js` already creates, with no new infrastructure and no polling fallback. If this ever moves to serverless, this feature's realtime transport would need to be revisited (out of scope here).

Confirmed during brainstorming:
- **Trigger:** both a manual "Talk to a human" affordance in the widget, and the AI itself offering one when it can't help or the visitor asks by name.
- **Who can answer:** the project owner, plus `project_members` (currently read-only Conversations/Analytics access) — this is their first *write* capability, scoped narrowly to claiming/messaging/resolving handoffs. Nothing else about member permissions changes.
- **Availability:** presence-based, and specifically *implicit* — having the dashboard's Live Chat view open (a live WebSocket connection) *is* the availability signal. No manual online/offline toggle, no DB-backed heartbeat.
- **No one available:** the request still queues (not silently dropped), and the widget asks the visitor to leave contact info, stored via the **existing `leads` table** rather than new schema.
- **Voice mode:** requesting a human while in a Gemini Live voice session ends that session and switches the widget to text chat for the handoff. No audio relay, no "human joins the live call" — out of scope, would require rebuilding the voice pipe to route through the server.
- **Plan gating:** restricted to the `business` plan, the same check pattern already used for team-member invites (`planId !== 'business'` in `routes/projects.js`).
- **Notification:** an email goes to the owner + all team members if a request sits unclaimed past a short grace window (~20s), rate-limited to at most one handoff email per project per 5 minutes so a repeatedly-re-requesting visitor can't spam inboxes.
- **Realtime transport:** WebSocket, bolted onto the existing HTTP server (no separate service, no polling) — see deployment context above.

Out of scope for this round: audio/voice handoff (human joins a live Gemini Live call), a manual presence toggle, SLA/queue-position display, chat transcripts emailed after resolution, multi-visitor routing/load-balancing across team members, mobile push notifications, Vercel-serverless compatibility for this feature specifically.

---

## Part 1 — Schema

`supabase/schema.sql` is the idempotent source of truth (see its header); the same statements are captured as a standalone dated migration file per existing convention.

**New file `supabase/migrations/2026-08-28_add_handoff.sql`** (also appended to `schema.sql`):

```sql
-- ── sessions: handoff state ──────────────────────────────────────
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS handoff_status       TEXT NOT NULL DEFAULT 'none'; -- 'none' | 'requested' | 'active' | 'resolved'
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS claimed_by           UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS claimed_at           BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS handoff_requested_at BIGINT;
CREATE INDEX IF NOT EXISTS idx_sessions_handoff_pending
  ON sessions(project_id, handoff_status)
  WHERE handoff_status IN ('requested', 'active');

-- ── messages: human attribution ──────────────────────────────────
-- role gains a new value 'human' alongside the existing 'user'/'assistant'.
-- sender_id is null for AI/visitor messages, set for a team member's.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_id UUID REFERENCES users(id) ON DELETE SET NULL;
```

No new tables. Presence is in-memory (see Part 2), and the "no one available" fallback reuses the existing `leads` table (`project_id`, `session_id`, `data JSONB`) with `data.handoffRequested = true` as a marker — no schema change needed there.

---

## Part 2 — Server: WebSocket + presence

**New file `backend/ws/handoff.js`.** Attaches a single `ws.Server` (new dependency: `ws`) to the same `http.Server` instance `server.js` creates via `app.listen()`, using two path-based upgrade handlers:

- `/ws/embed/:publicId?sessionId=...` — visitor side. On connect: validate `publicId` resolves to a real project (reuse `findByPublicId` from `routes/embed.js`) and that `sessionId` belongs to it (create the session row on first contact if it doesn't exist yet, mirroring how `/ask` lazily creates sessions today). No JWT — anonymous, like the rest of `/embed/*`.
- `/ws/dashboard/:projectId?token=...` — team side. On connect: verify the JWT (token as a query param, since the browser `WebSocket` constructor can't set an `Authorization` header), then run the same owner-or-member check `routes/projects.js`'s `findProjectForRead` already does, plus `userPlanId(project.userId) === 'business'`. Reject the upgrade (close with a policy code) if any check fails.

**In-memory registry**, scoped to the module (single persistent process, no cross-instance concerns given the confirmed deployment target):

```js
// projectId -> Set<{ ws, userId, userName }>   (dashboard/team connections)
const dashboardSockets = new Map();
// sessionId -> ws                               (visitor connections, 0 or 1 at a time)
const visitorSockets = new Map();
```

- A dashboard socket joining a project = that project becomes "has availability" (broadcast-worthy); the last one leaving removes it. Nothing else reads or writes availability — it's derived, not stored.
- Message relay: a visitor message looks up `sessions.claimed_by` (or, if `requested`/unclaimed, broadcasts the *fact* of a new message preview to all connected dashboard sockets for that project) and forwards to the matching dashboard socket if one is connected and has claimed that session; a team message looks up `visitorSockets.get(sessionId)` and forwards there. Every message is also persisted to `messages` regardless of delivery (so a visitor who reconnects mid-handoff sees history via a REST fetch, same pattern as the existing session/message read endpoints).

**Message protocol** (JSON frames, one `type` per frame):

| Direction | type | Payload | Meaning |
|---|---|---|---|
| visitor → server | `request_handoff` | — | Manual button or AI tag fired |
| server → visitor | `waiting` | — | Request queued, at least one team member notified |
| server → visitor | `no_one_available` | — | No dashboard socket connected for this project right now |
| server → visitor | `claimed` | `{ byName }` | A team member picked up the request |
| visitor/dashboard → server | `chat` | `{ text }` | A chat message from either side |
| server → visitor/dashboard | `chat` | `{ text, from: 'human'\|'visitor', byName? }` | Relayed message |
| dashboard → server | `claim` | `{ sessionId }` | Claim a pending request |
| dashboard → server | `resolve` | `{ sessionId }` | End the handoff, hand back to AI |
| server → visitor | `resolved` | — | Back to normal AI mode |
| server → dashboard (all connected for project) | `queue_update` | `{ pending: [...], active: [...] }` | Full queue/active-list snapshot after any state change |

Every state transition (`request_handoff`, `claim`, `resolve`) updates `sessions.handoff_status`/`claimed_by`/`claimed_at` via the existing `db.js` helpers, then re-broadcasts `queue_update` to every dashboard socket for that project — simplest correct approach given queue sizes here are small (a handful of concurrent handoffs per project, not thousands).

**Graceful shutdown:** `server.js`'s existing `shutdown()` (SIGTERM/SIGINT handler) additionally closes all open `ws` connections before `server.close()`, so a deploy doesn't leave half-open sockets; clients reconnect with backoff (Part 4/5).

---

## Part 3 — AI auto-escalation

Extends the existing sentinel-tag pattern (`[[CAPTURE:key=value]]`, `[[OPTIONS:...]]`) already used for lead capture and quick replies, rather than introducing Gemini function-calling — this keeps it available at every capability tier (not just Medium/Advanced, which is where tool-calling is currently gated) since it's just a prompt instruction plus a regex strip.

A new shared instruction (added wherever a system prompt is assembled — `embed.html`'s `initSDK()` for voice, and `routes/embed.js`'s `/ask` and `/study` handlers for text) when `handoffEnabled` is true for the project:

```
HUMAN HANDOFF: If you cannot help the visitor after a genuine effort, or they
explicitly ask for a person/human/representative, say so naturally and
append the exact tag [[REQUEST_HUMAN]] on its own line. Do not mention the
tag to the user — it will be stripped before display.
```

- **Voice mode:** `embed.html` already strips `CAPTURE`/`OPTIONS` tags from the SDK's transcript stream before display; `REQUEST_HUMAN` is detected the same way, and firing it ends the Gemini Live session and opens the handoff WebSocket exactly as if the visitor had clicked the button (per the "drop to text" decision).
- **`/ask` and `/study`:** these are plain request/response, no open socket yet at the point the tag would fire. The server strips the tag from `answer` before returning it and adds `offerHandoff: true` to the JSON response; the widget shows a small inline "Want me to connect you with a human?" prompt rather than opening the WebSocket immediately (avoids opening handoff sockets before the visitor has actually agreed).

---

## Part 4 — Widget UX (`public/embed.html`)

1. `/embed/:publicId/config` gains `handoffEnabled: boolean` (`userPlanId(project.userId) === 'business'`), so the widget only renders the "Talk to a human" affordance for eligible projects. A header button in the chat panel, always visible when enabled — regardless of voice/text mode.
2. Clicking it (or accepting the AI's inline offer from `/ask`/`/study`, or the voice-mode tag firing): if currently in voice mode, tear down the Gemini Live connection first, switch the panel layout to text chat, then open `wss://.../ws/embed/:publicId?sessionId=...` and send `{ type: 'request_handoff' }`.
3. UI shows "Connecting you with a team member…" On `no_one_available`, shows a compact form (name + email, reusing the project's configured capture fields where available, otherwise a fixed name/email pair) that `POST`s to a small new endpoint that writes a `leads` row tagged `handoffRequested: true` — same table, same shape as existing lead capture, just triggered explicitly instead of conversationally.
4. On `claimed`, shows "You're chatting with {byName}." Chat becomes a plain message list + input, sending `{ type: 'chat', text }` frames. While `handoff_status` is `requested` or `active` for this session, the widget does not call `/ask`/`/study` at all — the AI is fully out of the loop.
5. On `resolved`, shows "You're back with the AI assistant," reverts to the normal (text-mode) chat UI. Voice is not auto-reconnected.
6. Reconnect-with-backoff on unexpected socket close (covers server restarts during a deploy) — a few retries with increasing delay before giving up and showing "Connection lost, please refresh."

---

## Part 5 — Dashboard UX (`public/project.html`)

New "Live Chat" tab, shown only when the project's plan is `business` (same gate as the existing Team tab). Opening it opens `wss://.../ws/dashboard/:projectId?token=...` — this connection's existence is the entire presence mechanism (Part 2); navigating away or closing the tab closes it and the project silently drops out of "available."

- **Waiting** list: unclaimed `requested` sessions for the project, each with a short preview (visitor's opening message) and a "Claim" button. Updates live via `queue_update` frames.
- **My active chats**: sessions this user has claimed, each opening a simple thread pane (message list, input box, "Resolve" button) reusing the visual style of the existing (read-only) Conversations tab's message bubbles.
- **Others' active chats**: read-only list of what teammates currently have claimed, so two team members don't both jump on the same visitor.
- A badge count on the tab itself (pending + mine) so it's visible without the tab being open, updated the same way any other tab-badge in this admin-style UI would be — via the `queue_update` broadcasts while the socket is open, cleared when it isn't.

---

## Part 6 — Notifications

`backend/services/email.js` gains `sendHandoffRequestEmail({ project, session, previewText, recipients })`. When a `request_handoff` frame is handled, a `setTimeout` (~20s) is scheduled; if the session is claimed before it fires, the timer is cancelled (`clearTimeout`, keyed by session ID in a module-level map alongside the socket registries). If it fires, the email goes to the project owner's email plus every `project_members` row's user email, subject to an in-memory per-project rate limit (skip if a handoff email for this project was sent within the last 5 minutes). Same no-op-if-`SMTP_HOST`-unset behavior as every other email in this codebase — the feature still works end-to-end without SMTP configured, it just won't notify anyone who isn't watching the dashboard.

---

## Part 7 — Permissions recap

- Feature existence: `userPlanId(project.userId) === 'business'`, checked both when building `/config` (`handoffEnabled`) and on the dashboard WebSocket upgrade.
- Within an eligible project: owner always eligible to claim/message/resolve. `project_members` rows gain the same capability — the *only* write access they get; everything else (settings, knowledge base, billing, webhook config) stays exactly as owner-only as it is today.
- No new admin-panel surface — this is entirely within the existing project owner/team dashboard, not the separate `admin.html` operator panel.

---

## Part 8 — Testing

- Unit tests: the `[[REQUEST_HUMAN]]` tag-stripping regex (mirrors the existing `CAPTURE_TAG_RE`/`OPTIONS_TAG_RE` test coverage style), the in-memory presence registry's join/leave/broadcast logic, and the grace-window email scheduling/cancellation (fake timers).
- WebSocket protocol tests: spin up a real `http.Server` with `backend/ws/handoff.js` attached on an ephemeral port, connect real `ws` client sockets for both a fake visitor and a fake dashboard session, and assert on the actual frames exchanged (claim → `queue_update` → chat relay → resolve) — same "exercise the real thing over mocking" approach as this repo's existing `embed.test.js`.
- Manual verification (documented in the implementation plan, not automatable here): a two-browser-window walkthrough — one as the widget, one as the dashboard — covering claim, live message exchange, resolve, no-one-available fallback, and reconnect-after-server-restart.
