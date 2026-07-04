/**
 * Analytics — SQL-aggregate views over messages, sessions, files, and leads.
 * No in-memory row scanning; all aggregation happens in Postgres.
 */
const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

function buildDailyBuckets(msgRows, sessRows) {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const buckets = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    buckets.push({ date: key, messages: 0, sessions: 0 });
  }
  const byDate = Object.fromEntries(buckets.map((b, i) => [b.date, i]));
  for (const r of msgRows)  if (r.date in byDate) buckets[byDate[r.date]].messages = Number(r.count);
  for (const r of sessRows) if (r.date in byDate) buckets[byDate[r.date]].sessions = Number(r.count);
  return buckets;
}

router.get('/overview', authRequired, async (req, res) => {
  const userId = req.user.id;
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const [totals, byProject, msgDaily, sessDaily] = await Promise.all([
    db.queryOne(
      `SELECT
         (SELECT COUNT(*) FROM projects WHERE user_id = $1)                                         AS projects,
         (SELECT COUNT(*) FROM files f JOIN projects p ON p.id = f.project_id WHERE p.user_id = $1) AS files,
         (SELECT COUNT(*) FROM messages m JOIN projects p ON p.id = m.project_id WHERE p.user_id = $1) AS messages,
         (SELECT COUNT(*) FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.user_id = $1) AS sessions,
         (SELECT COUNT(*) FROM leads l JOIN projects p ON p.id = l.project_id WHERE p.user_id = $1)    AS leads`,
      [userId]
    ),
    db.query(
      `SELECT p.id, p.name,
              COUNT(DISTINCT m.id) AS messages,
              COUNT(DISTINCT s.id) AS sessions,
              COUNT(DISTINCT f.id) AS files,
              COUNT(DISTINCT l.id) AS leads
       FROM projects p
       LEFT JOIN messages m ON m.project_id = p.id
       LEFT JOIN sessions s ON s.project_id = p.id
       LEFT JOIN files    f ON f.project_id = p.id
       LEFT JOIN leads    l ON l.project_id = p.id
       WHERE p.user_id = $1
       GROUP BY p.id, p.name
       ORDER BY COUNT(DISTINCT m.id) DESC`,
      [userId]
    ),
    db.query(
      `SELECT to_char(to_timestamp(m.created_at / 1000.0), 'YYYY-MM-DD') AS date, COUNT(*) AS count
       FROM messages m JOIN projects p ON p.id = m.project_id
       WHERE p.user_id = $1 AND m.created_at > $2
       GROUP BY date`,
      [userId, since]
    ),
    db.query(
      `SELECT to_char(to_timestamp(s.created_at / 1000.0), 'YYYY-MM-DD') AS date, COUNT(*) AS count
       FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE p.user_id = $1 AND s.created_at > $2
       GROUP BY date`,
      [userId, since]
    ),
  ]);

  res.json({
    totals: {
      projects: Number(totals.projects),
      files:    Number(totals.files),
      messages: Number(totals.messages),
      sessions: Number(totals.sessions),
      leads:    Number(totals.leads),
    },
    daily: buildDailyBuckets(msgDaily, sessDaily),
    byProject: byProject.map(r => ({
      id:       r.id,
      name:     r.name,
      messages: Number(r.messages),
      sessions: Number(r.sessions),
      files:    Number(r.files),
      leads:    Number(r.leads),
    })),
  });
});

router.get('/project/:id', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const [totals, avgRow, msgDaily, sessDaily, topQ] = await Promise.all([
    db.queryOne(
      `SELECT
         (SELECT COUNT(*) FROM sessions WHERE project_id = $1)                   AS sessions,
         (SELECT COUNT(*) FROM messages WHERE project_id = $1)                   AS messages,
         (SELECT COUNT(*) FROM files    WHERE project_id = $1)                   AS files,
         (SELECT COUNT(*) FROM leads    WHERE project_id = $1)                   AS leads,
         (SELECT COUNT(*) FROM leads    WHERE project_id = $1 AND complete=true) AS leads_complete`,
      [project.id]
    ),
    db.queryOne(
      `SELECT COALESCE(AVG(msg_count), 0) AS avg
       FROM (SELECT session_id, COUNT(*) AS msg_count FROM messages WHERE project_id = $1 GROUP BY session_id) sub`,
      [project.id]
    ),
    db.query(
      `SELECT to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD') AS date, COUNT(*) AS count
       FROM messages WHERE project_id = $1 AND created_at > $2 GROUP BY date`,
      [project.id, since]
    ),
    db.query(
      `SELECT to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD') AS date, COUNT(*) AS count
       FROM sessions WHERE project_id = $1 AND created_at > $2 GROUP BY date`,
      [project.id, since]
    ),
    db.query(
      `SELECT text, created_at FROM (
         SELECT DISTINCT ON (lower(trim(text))) text, created_at
         FROM messages
         WHERE project_id = $1 AND role = 'user' AND text IS NOT NULL
         ORDER BY lower(trim(text)), created_at DESC
       ) sub
       ORDER BY created_at DESC LIMIT 10`,
      [project.id]
    ),
  ]);

  res.json({
    totals: {
      sessions:      Number(totals.sessions),
      messages:      Number(totals.messages),
      files:         Number(totals.files),
      avgSessionLength: Math.round(Number(avgRow.avg) || 0),
      leads:         Number(totals.leads),
      leadsComplete: Number(totals.leadsComplete),
    },
    daily: buildDailyBuckets(msgDaily, sessDaily),
    topQuestions: topQ.map(r => ({ text: r.text, createdAt: r.createdAt })),
  });
});

module.exports = router;
