/**
 * Platform-wide analytics rollup — today's analytics.js is entirely
 * `authRequired` (project-owner scoped, see routes/analytics.js), so an
 * admin has no cross-tenant view of sessions/messages/funnel conversion.
 * This route mirrors that owner-facing shape but removes the per-project
 * filter, per docs/admin-panel-implementation-plan.md "3a. Aggregate
 * analytics route".
 *
 * The funnel-stage + session-duration SQL is NOT duplicated here — both
 * this route's GET /overview and the owner-scoped
 * routes/analytics.js's GET /project/:id call the same
 * services/analytics.js#getFunnelAndDuration, parameterized by an optional
 * projectId (omitted here for a platform-wide rollup).
 */
const express = require('express');
const db = require('../db');
const { adminAuthRequired } = require('../middleware/auth');
const { getFunnelAndDuration } = require('../services/analytics');

const router = express.Router();
router.use(adminAuthRequired);

const WINDOWS_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// GET /overview — platform totals, 24h/7d/30d activity buckets, and
// aggregate funnel conversion across every project.
router.get('/overview', async (_req, res) => {
  const now = Date.now();
  const since24h = now - WINDOWS_MS['24h'];
  const since7d = now - WINDOWS_MS['7d'];
  const since30d = now - WINDOWS_MS['30d'];

  const [totals, windows, funnelAndDuration] = await Promise.all([
    db.queryOne(
      `SELECT
         (SELECT COUNT(*) FROM projects) AS projects,
         (SELECT COUNT(*) FROM users)    AS users,
         (SELECT COUNT(*) FROM sessions) AS sessions,
         (SELECT COUNT(*) FROM messages) AS messages`
    ),
    // Aliased as `_h24`/`_d7`/`_d30` (letter immediately after the
    // underscore), not `_24h` — db.js's snake_case→camelCase conversion
    // (`s.replace(/_([a-z])/g, ...)`) only fires when a lowercase letter
    // directly follows the underscore, so `messages_24h` would come back
    // unconverted as `row.messages_24h` instead of `row.messages24h`.
    db.queryOne(
      `SELECT
         (SELECT COUNT(*) FROM messages WHERE created_at > $1) AS messages_h24,
         (SELECT COUNT(*) FROM messages WHERE created_at > $2) AS messages_d7,
         (SELECT COUNT(*) FROM messages WHERE created_at > $3) AS messages_d30,
         (SELECT COUNT(*) FROM sessions WHERE created_at > $1) AS sessions_h24,
         (SELECT COUNT(*) FROM sessions WHERE created_at > $2) AS sessions_d7,
         (SELECT COUNT(*) FROM sessions WHERE created_at > $3) AS sessions_d30`,
      [since24h, since7d, since30d]
    ),
    // No projectId → platform-wide funnel + avg session duration, reusing
    // the exact same query shape the owner route uses per-project.
    getFunnelAndDuration(),
  ]);

  res.json({
    totals: {
      projects: Number(totals.projects),
      users:    Number(totals.users),
      sessions: Number(totals.sessions),
      messages: Number(totals.messages),
    },
    windows: {
      messages: {
        last24h: Number(windows.messagesH24),
        last7d:  Number(windows.messagesD7),
        last30d: Number(windows.messagesD30),
      },
      sessions: {
        last24h: Number(windows.sessionsH24),
        last7d:  Number(windows.sessionsD7),
        last30d: Number(windows.sessionsD30),
      },
    },
    funnel: funnelAndDuration.funnel,
    avgSessionDurationSec: funnelAndDuration.avgSessionDurationSec,
  });
});

// GET /top-projects?window=24h|7d|30d&limit=N — top projects by message
// volume (ties broken by session count) within the given window, for
// spotting abuse or highest-value customers. Pre-aggregates messages/
// sessions per project_id in their own CTEs before joining onto projects,
// same fan-out fix documented in routes/analytics.js's GET /overview
// (each CTE contributes at most one row per project, so the outer joins
// stay 1:1 instead of multiplying out).
router.get('/top-projects', async (req, res) => {
  const win = WINDOWS_MS[req.query.window] ? req.query.window : '30d';
  const since = Date.now() - WINDOWS_MS[win];
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  const rows = await db.query(
    `WITH msg_counts AS (
       SELECT project_id, COUNT(*) AS messages
       FROM messages WHERE created_at > $1 GROUP BY project_id
     ),
     sess_counts AS (
       SELECT project_id, COUNT(*) AS sessions
       FROM sessions WHERE created_at > $1 GROUP BY project_id
     )
     SELECT p.id, p.name, p.public_id, u.email AS owner_email,
            COALESCE(mc.messages, 0) AS messages,
            COALESCE(sc.sessions, 0) AS sessions
     FROM projects p
     LEFT JOIN users u ON u.id = p.user_id
     LEFT JOIN msg_counts  mc ON mc.project_id = p.id
     LEFT JOIN sess_counts sc ON sc.project_id = p.id
     WHERE COALESCE(mc.messages, 0) > 0 OR COALESCE(sc.sessions, 0) > 0
     ORDER BY messages DESC, sessions DESC
     LIMIT $2`,
    [since, limit]
  );

  res.json({
    window: win,
    projects: rows.map(r => ({
      id:        r.id,
      name:      r.name,
      publicId:  r.publicId,
      ownerEmail: r.ownerEmail,
      messages:  Number(r.messages),
      sessions:  Number(r.sessions),
    })),
  });
});

module.exports = router;
