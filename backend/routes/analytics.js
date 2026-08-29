/**
 * Analytics — SQL-aggregate views over messages, sessions, files, and leads.
 * No in-memory row scanning; all aggregation happens in Postgres.
 */
const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { getFunnelAndDuration } = require('../services/analytics');

const router = express.Router();

// Team members (project_members) get read-only access to a project's
// analytics — see improvement-prompts.md Prompt F4 item 3 and the same
// helper in routes/projects.js.
async function findProjectForRead(id, userId) {
  const owned = await db.findOne('projects', { id, userId });
  if (owned) return owned;
  const project = await db.findOne('projects', { id });
  if (!project) return null;
  const member = await db.findOne('projectMembers', { projectId: id, userId });
  return member ? project : null;
}

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
    // Was: LEFT JOIN messages/sessions/files/leads directly onto projects in
    // one query. Four one-to-many joins chained together fan out
    // multiplicatively BEFORE the GROUP BY collapses them — a project with
    // 1,000 messages, 200 sessions, 50 files and 20 leads briefly produces
    // up to 1,000 x 200 x 50 x 20 intermediate rows. COUNT(DISTINCT …) still
    // returns the right number, but the planner has to build and discard
    // that entire cross product to get there. Fixed by pre-aggregating each
    // child table by project_id in its own CTE (each already scoped to just
    // this user's projects), so every CTE contributes at most one row per
    // project — the outer joins are then 1:1, not fan-out.
    db.query(
      `WITH my_projects AS (
         SELECT id FROM projects WHERE user_id = $1
       ),
       msg_counts AS (
         SELECT m.project_id, COUNT(*) AS messages
         FROM messages m JOIN my_projects mp ON mp.id = m.project_id
         GROUP BY m.project_id
       ),
       sess_counts AS (
         SELECT s.project_id, COUNT(*) AS sessions
         FROM sessions s JOIN my_projects mp ON mp.id = s.project_id
         GROUP BY s.project_id
       ),
       file_counts AS (
         SELECT f.project_id, COUNT(*) AS files
         FROM files f JOIN my_projects mp ON mp.id = f.project_id
         GROUP BY f.project_id
       ),
       lead_counts AS (
         SELECT l.project_id, COUNT(*) AS leads
         FROM leads l JOIN my_projects mp ON mp.id = l.project_id
         GROUP BY l.project_id
       )
       SELECT p.id, p.name,
              COALESCE(mc.messages, 0) AS messages,
              COALESCE(sc.sessions, 0) AS sessions,
              COALESCE(fc.files, 0)    AS files,
              COALESCE(lc.leads, 0)    AS leads
       FROM projects p
       LEFT JOIN msg_counts  mc ON mc.project_id = p.id
       LEFT JOIN sess_counts sc ON sc.project_id = p.id
       LEFT JOIN file_counts fc ON fc.project_id = p.id
       LEFT JOIN lead_counts lc ON lc.project_id = p.id
       WHERE p.id IN (SELECT id FROM my_projects)
       ORDER BY messages DESC`,
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
  const project = await findProjectForRead(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const [totals, avgRow, funnelAndDuration, msgDaily, sessDaily, topQ] = await Promise.all([
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
    // Conversion funnel + avg session duration — shared with the
    // platform-wide admin rollup, see services/analytics.js.
    getFunnelAndDuration(project.id),
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
    funnel: funnelAndDuration.funnel,
    avgSessionDurationSec: funnelAndDuration.avgSessionDurationSec,
    daily: buildDailyBuckets(msgDaily, sessDaily),
    topQuestions: topQ.map(r => ({ text: r.text, createdAt: r.createdAt })),
  });
});

/**
 * GET /api/analytics/project/:id/progress
 * Owner-facing aggregate across all learners: per-learner summary (only
 * for attempts/reviews with a resolved learner_key — see
 * backend/services/learner.js) plus a project-wide topic breakdown that
 * includes anonymous (session-only) activity too.
 */
router.get('/project/:id/progress', authRequired, async (req, res) => {
  const project = await findProjectForRead(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const [learnerRows, anonCounts, topicRows] = await Promise.all([
    db.query(
      `SELECT learners.learner_key,
              COALESCE(q.quiz_total, 0)    AS quiz_total,
              COALESCE(q.quiz_correct, 0)  AS quiz_correct,
              COALESCE(f.cards_total, 0)   AS cards_total,
              GREATEST(COALESCE(q.last_at, 0), COALESCE(f.last_at, 0)) AS last_active
       FROM (
         SELECT DISTINCT learner_key FROM quiz_attempts WHERE project_id = $1 AND learner_key IS NOT NULL
         UNION
         SELECT DISTINCT learner_key FROM flashcard_reviews WHERE project_id = $1 AND learner_key IS NOT NULL
       ) learners
       LEFT JOIN (
         SELECT learner_key, COUNT(*) AS quiz_total,
                SUM(CASE WHEN is_correct THEN 1 ELSE 0 END) AS quiz_correct, MAX(created_at) AS last_at
         FROM quiz_attempts WHERE project_id = $1 AND learner_key IS NOT NULL GROUP BY learner_key
       ) q ON q.learner_key = learners.learner_key
       LEFT JOIN (
         SELECT learner_key, COUNT(*) AS cards_total, MAX(created_at) AS last_at
         FROM flashcard_reviews WHERE project_id = $1 AND learner_key IS NOT NULL GROUP BY learner_key
       ) f ON f.learner_key = learners.learner_key
       ORDER BY last_active DESC`,
      [project.id]
    ),
    db.queryOne(
      `SELECT
         (SELECT COUNT(*) FROM quiz_attempts WHERE project_id = $1 AND learner_key IS NULL) AS quiz,
         (SELECT COUNT(*) FROM flashcard_reviews WHERE project_id = $1 AND learner_key IS NULL) AS cards`,
      [project.id]
    ),
    db.query(
      `SELECT topic, COUNT(*) AS quiz_total, SUM(CASE WHEN is_correct THEN 1 ELSE 0 END) AS quiz_correct
       FROM quiz_attempts WHERE project_id = $1 GROUP BY topic`,
      [project.id]
    ),
  ]);

  res.json({
    learners: learnerRows.map(r => ({
      learnerKey: r.learnerKey,
      quizTotal: Number(r.quizTotal),
      quizAccuracy: r.quizTotal > 0 ? Math.round((Number(r.quizCorrect) / Number(r.quizTotal)) * 100) : null,
      cardsReviewed: Number(r.cardsTotal),
      lastActive: Number(r.lastActive) || null,
    })),
    anonymousActivity: {
      quizAttempts: Number(anonCounts.quiz),
      cardsReviewed: Number(anonCounts.cards),
    },
    byTopic: topicRows.map(r => ({
      topic: r.topic || 'General',
      quizTotal: Number(r.quizTotal),
      quizAccuracy: Number(r.quizTotal) > 0 ? Math.round((Number(r.quizCorrect) / Number(r.quizTotal)) * 100) : null,
    })),
  });
});

module.exports = router;
