/**
 * Read-only "export" API — lets an owner pull everything they have on
 * this platform (categories, chatbots, messages, URL knowledge sources,
 * leads) across ALL of their chatbots, in one call per resource, so they
 * can sync it into their own platform. Uses the same Bearer-token auth as
 * the rest of /api/* — every query is scoped to req.user.id exactly like
 * the dashboard's own project-scoped routes, so no separate API-key
 * system is needed.
 *
 * Every list here accepts ?categoryId= (and the per-chatbot ones also
 * ?projectId=) to narrow the result to one category/chatbot instead of
 * the whole account. The higher-volume resources (messages, urls, leads)
 * are paginated with ?page=&limit= (default 50, max 200), same shape as
 * GET /api/projects/:id/leads.
 */
const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

function pagination(req) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

// GET /api/data/categories — every category the user owns, each with its
// chatbots nested (id/name/publicId/characterId).
router.get('/categories', authRequired, async (req, res) => {
  const categories = await db.query(
    `SELECT cc.id, cc.name, cc.color, cc.description, cc.created_at, cc.updated_at,
            COALESCE(json_agg(json_build_object(
              'id', p.id, 'name', p.name, 'publicId', p.public_id, 'characterId', p.character_id
            ) ORDER BY p.created_at) FILTER (WHERE p.id IS NOT NULL), '[]') AS chatbots
       FROM chatbot_categories cc
       LEFT JOIN projects p ON p.category_id = cc.id
      WHERE cc.user_id = $1
      GROUP BY cc.id
      ORDER BY cc.created_at DESC`,
    [req.user.id]
  );
  res.json({ categories });
});

// GET /api/data/chatbots — every chatbot (project) the user owns.
router.get('/chatbots', authRequired, async (req, res) => {
  const { categoryId } = req.query;
  const params = [req.user.id];
  let clause = '';
  if (categoryId) {
    params.push(categoryId);
    clause = `AND p.category_id = $${params.length}`;
  }
  const chatbots = await db.query(
    `SELECT p.id, p.public_id, p.name, p.character_id, p.category_id, cc.name AS category_name,
            p.widget_position, p.created_at, p.updated_at,
            COUNT(DISTINCT l.id)::int AS lead_count
       FROM projects p
       LEFT JOIN chatbot_categories cc ON cc.id = p.category_id
       LEFT JOIN leads l ON l.project_id = p.id
      WHERE p.user_id = $1 ${clause}
      GROUP BY p.id, cc.name
      ORDER BY p.created_at DESC`,
    params
  );
  res.json({ chatbots });
});

// GET /api/data/messages — every chat message across every chatbot.
router.get('/messages', authRequired, async (req, res) => {
  const { projectId, categoryId } = req.query;
  const { page, limit, offset } = pagination(req);
  const clauses = ['p.user_id = $1'];
  const params = [req.user.id];
  if (projectId) { params.push(projectId); clauses.push(`m.project_id = $${params.length}`); }
  if (categoryId) { params.push(categoryId); clauses.push(`p.category_id = $${params.length}`); }
  const where = clauses.join(' AND ');

  const [totalRow, messages] = await Promise.all([
    db.queryOne(
      `SELECT COUNT(*) AS total FROM messages m JOIN projects p ON p.id = m.project_id WHERE ${where}`,
      params
    ),
    db.query(
      `SELECT m.id, m.role, m.text, m.created_at, m.session_id, m.project_id,
              p.name AS chatbot_name, p.category_id, cc.name AS category_name
         FROM messages m
         JOIN projects p ON p.id = m.project_id
         LEFT JOIN chatbot_categories cc ON cc.id = p.category_id
        WHERE ${where}
        ORDER BY m.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
  ]);
  res.json({ messages, total: Number(totalRow.total), page, limit });
});

// GET /api/data/urls — every URL knowledge source across every chatbot
// (files.kind = 'url', ingested via POST /api/projects/:id/sources/url).
router.get('/urls', authRequired, async (req, res) => {
  const { projectId, categoryId } = req.query;
  const { page, limit, offset } = pagination(req);
  const clauses = [`f.user_id = $1`, `f.kind = 'url'`];
  const params = [req.user.id];
  if (projectId) { params.push(projectId); clauses.push(`f.project_id = $${params.length}`); }
  if (categoryId) { params.push(categoryId); clauses.push(`p.category_id = $${params.length}`); }
  const where = clauses.join(' AND ');

  const [totalRow, urls] = await Promise.all([
    db.queryOne(
      `SELECT COUNT(*) AS total FROM files f JOIN projects p ON p.id = f.project_id WHERE ${where}`,
      params
    ),
    db.query(
      `SELECT f.id, f.project_id, p.name AS chatbot_name, p.category_id, cc.name AS category_name,
              f.source_url, f.final_url, f.title, f.favicon_url, f.status, f.chunk_count,
              f.fetched_at, f.processed_at, f.error, f.created_at
         FROM files f
         JOIN projects p ON p.id = f.project_id
         LEFT JOIN chatbot_categories cc ON cc.id = p.category_id
        WHERE ${where}
        ORDER BY f.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
  ]);
  res.json({ urls, total: Number(totalRow.total), page, limit });
});

// GET /api/data/leads — every lead across every chatbot. ?complete=true|false
// filters the same way GET /api/projects/:id/leads does.
router.get('/leads', authRequired, async (req, res) => {
  const { projectId, categoryId, complete } = req.query;
  const { page, limit, offset } = pagination(req);
  const clauses = ['p.user_id = $1'];
  const params = [req.user.id];
  if (projectId) { params.push(projectId); clauses.push(`l.project_id = $${params.length}`); }
  if (categoryId) { params.push(categoryId); clauses.push(`p.category_id = $${params.length}`); }
  if (complete === 'true') clauses.push('l.complete = true');
  if (complete === 'false') clauses.push('l.complete = false');
  const where = clauses.join(' AND ');

  const [totalRow, leads] = await Promise.all([
    db.queryOne(
      `SELECT COUNT(*) AS total FROM leads l JOIN projects p ON p.id = l.project_id WHERE ${where}`,
      params
    ),
    db.query(
      `SELECT l.id, l.project_id, p.name AS chatbot_name, p.category_id, cc.name AS category_name,
              l.session_id, l.data, l.complete, l.created_at, l.updated_at
         FROM leads l
         JOIN projects p ON p.id = l.project_id
         LEFT JOIN chatbot_categories cc ON cc.id = p.category_id
        WHERE ${where}
        ORDER BY l.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
  ]);
  res.json({ leads, total: Number(totalRow.total), page, limit });
});

module.exports = router;
