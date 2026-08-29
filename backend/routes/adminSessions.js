/**
 * Admin read access to chat sessions/transcripts across ALL tenants, per
 * docs/admin-panel-implementation-plan.md "5a. Chat transcript viewing —
 * full searchable access".
 *
 * `sessions`/`messages` (schema.sql) carry no end-user identity of their
 * own (the embed widget is anonymous) — `sessions.project_id` is the only
 * attribution point, so "user" filtering here means the PROJECT OWNER's
 * email (sessions -> projects -> users), not an end-user account.
 *
 * Privacy: this exposes real end-user conversation content to platform
 * operators, so — unlike every other admin route, which only audit-logs
 * mutations — GET /:id/messages (and ONLY that route, not the list route)
 * writes an `admin_audit_log` entry on every read via services/auditLog.js,
 * so there's a trail of who looked at which transcript and when. This is a
 * deliberate exception to the "audit log = mutations only" convention.
 *
 * Anti-pattern guard (explicit in the plan): no full-text search across
 * message content here — id/project/user/date filtering only.
 */
const express = require('express');
const db = require('../db');
const { adminAuthRequired } = require('../middleware/auth');
const { logAdminAction } = require('../services/auditLog');

const router = express.Router();
router.use(adminAuthRequired);

// Malformed (non-UUID) :id params otherwise reach db.query, where Postgres
// rejects the invalid uuid cast and the request 500s instead of cleanly
// 404ing — same guard admin.js/adminWebhooks.js use for :id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Session not found' });
  next();
});

const PAGE_SIZE = 25;
// messages tables are per-session and small in practice (a chat session is
// a single widget conversation, not a bulk import) — a single capped page
// covers every realistic transcript. Still page-shaped (page/pageSize/total
// in the response) so this extends to true pagination without a response
// shape change if a session ever legitimately exceeds MESSAGE_PAGE_SIZE.
const MESSAGE_PAGE_SIZE = 500;

// GET / — paginated, filterable list across ALL projects/tenants, newest
// first. Filters: ?projectId=<uuid>, ?email=<owner email substring>,
// ?from=<epoch ms>, ?to=<epoch ms>. Joins projects (+users) for tenant/owner
// attribution, mirroring the join style in admin.js's GET /users/:id
// projects query. No content search — see file header.
router.get('/', async (req, res) => {
  const { projectId, email, from, to } = req.query;
  const conditions = [];
  const params = [];

  if (projectId) {
    if (!UUID_RE.test(projectId)) return res.status(400).json({ error: 'Invalid projectId' });
    params.push(projectId);
    conditions.push(`s.project_id = $${params.length}`);
  }
  if (email) {
    params.push(`%${email}%`);
    conditions.push(`u.email ILIKE $${params.length}`);
  }
  if (from) {
    params.push(parseInt(from, 10));
    conditions.push(`s.created_at >= $${params.length}`);
  }
  if (to) {
    params.push(parseInt(to, 10));
    conditions.push(`s.created_at <= $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const page = Math.min(100000, Math.max(1, parseInt(req.query.page) || 1));
  const offset = (page - 1) * PAGE_SIZE;

  const rows = await db.query(
    `SELECT s.id, s.project_id, s.ip, s.created_at,
            p.name AS project_name, p.public_id AS project_public_id,
            u.email AS owner_email,
            COUNT(m.id)::int AS message_count
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN messages m ON m.session_id = s.id
       ${where}
       GROUP BY s.id, p.name, p.public_id, u.email
       ORDER BY s.created_at DESC
       LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    params
  );
  const [{ count }] = await db.query(
    `SELECT COUNT(DISTINCT s.id)::int AS count
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       LEFT JOIN users u ON u.id = p.user_id
       ${where}`,
    params
  );

  res.json({
    sessions: rows.map(r => ({
      id: r.id,
      projectId: r.projectId,
      ip: r.ip,
      createdAt: r.createdAt,
      messageCount: r.messageCount,
      project: {
        id: r.projectId,
        name: r.projectName,
        publicId: r.projectPublicId,
        ownerEmail: r.ownerEmail,
      },
    })),
    page, pageSize: PAGE_SIZE, total: count,
  });
});

// GET /:id/messages — full transcript for one session, capped/paginated
// (see MESSAGE_PAGE_SIZE above). Writes a `session_transcript_viewed`
// audit log entry on every call — including when the session has zero
// messages, since opening the transcript still counts as a view. Fired
// right after confirming the session exists (privacy-sensitive per the
// plan; this is the one new read path that gets an audit trail).
router.get('/:id/messages', async (req, res) => {
  const session = await db.queryOne(
    `SELECT s.id, s.project_id, s.ip, s.created_at,
            p.name AS project_name, p.public_id AS project_public_id,
            p.user_id AS owner_id, u.email AS owner_email
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       LEFT JOIN users u ON u.id = p.user_id
      WHERE s.id = $1`,
    [req.params.id]
  );
  if (!session) return res.status(404).json({ error: 'Session not found' });

  await logAdminAction({
    adminId: req.admin.id,
    action: 'session_transcript_viewed',
    targetUserId: session.ownerId,
    targetEmail: session.ownerEmail,
    meta: { sessionId: session.id, projectId: session.projectId },
  });

  const page = Math.min(100000, Math.max(1, parseInt(req.query.page) || 1));
  const offset = (page - 1) * MESSAGE_PAGE_SIZE;

  const messages = await db.query(
    `SELECT id, role, text, created_at
       FROM messages
      WHERE session_id = $1
      ORDER BY created_at ASC
      LIMIT ${MESSAGE_PAGE_SIZE} OFFSET ${offset}`,
    [session.id]
  );
  const [{ count }] = await db.query(
    `SELECT COUNT(*)::int AS count FROM messages WHERE session_id = $1`,
    [session.id]
  );

  res.json({
    session: {
      id: session.id,
      projectId: session.projectId,
      ip: session.ip,
      createdAt: session.createdAt,
      project: {
        id: session.projectId,
        name: session.projectName,
        publicId: session.projectPublicId,
        ownerEmail: session.ownerEmail,
      },
    },
    messages: messages.map(m => ({
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt,
    })),
    page, pageSize: MESSAGE_PAGE_SIZE, total: count,
  });
});

module.exports = router;
