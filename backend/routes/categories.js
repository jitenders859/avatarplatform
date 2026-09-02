/**
 * Chatbot categories — user-defined groupings for chatbots (projects).
 * Create a category, then assign chatbots to it either here (bulk) or via
 * PATCH /api/projects/:id { categoryId } (one at a time, from the project
 * settings page). See backend/routes/apiData.js for the read-only export
 * API that lets an owner pull categories + their chatbots elsewhere.
 */
const express = require('express');
const { randomUUID: uuid } = require('crypto');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');

const router = express.Router();

async function ownsCategory(req, res, next) {
  const category = await db.findOne('chatbotCategories', { id: req.params.id, userId: req.user.id });
  if (!category) return res.status(404).json({ error: 'Category not found' });
  req.category = category;
  next();
}

async function duplicateName(userId, name, excludeId) {
  const existing = await db.findOne('chatbotCategories', { userId, name });
  return existing && existing.id !== excludeId ? existing : null;
}

// GET /api/categories — every category, each with its chatbots nested via
// json_agg so the dashboard (and the export API) can render the tree in
// one round trip instead of N+1 queries.
router.get('/', authRequired, async (req, res) => {
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

router.post('/', authRequired, validate(schemas.categoryCreate), async (req, res) => {
  const { name, color, description } = req.body;
  if (await duplicateName(req.user.id, name)) {
    return res.status(409).json({ error: `A category named "${name}" already exists` });
  }
  const category = await db.insert('chatbotCategories', {
    id: uuid(),
    userId: req.user.id,
    name,
    color: color || null,
    description: description || null,
    createdAt: Date.now(),
  });
  res.json({ category: { ...category, chatbots: [] } });
});

router.get('/:id', authRequired, ownsCategory, async (req, res) => {
  const chatbots = await db.findAll(
    'projects',
    { categoryId: req.category.id, userId: req.user.id },
    { orderBy: 'createdAt', order: 'desc' }
  );
  res.json({ category: req.category, chatbots });
});

router.patch('/:id', authRequired, ownsCategory, validate(schemas.categoryPatch), async (req, res) => {
  const patch = req.body;
  if (patch.name && await duplicateName(req.user.id, patch.name, req.category.id)) {
    return res.status(409).json({ error: `A category named "${patch.name}" already exists` });
  }
  const updated = await db.update('chatbotCategories', req.category.id, patch);
  res.json({ category: updated });
});

// FK is ON DELETE SET NULL — this un-categorizes the category's chatbots,
// it never deletes them.
router.delete('/:id', authRequired, ownsCategory, async (req, res) => {
  await db.remove('chatbotCategories', { id: req.category.id });
  res.json({ ok: true });
});

// POST /api/categories/:id/chatbots — bulk-assign chatbots to this category.
// `WHERE ... AND user_id = $4` keeps this tenant-scoped: a projectId from
// another account just doesn't match any row and is silently skipped.
router.post('/:id/chatbots', authRequired, ownsCategory, validate(schemas.categoryAssignChatbots), async (req, res) => {
  const { projectIds } = req.body;
  const updated = await db.query(
    `UPDATE projects SET category_id = $1, updated_at = $2
      WHERE id = ANY($3::uuid[]) AND user_id = $4
      RETURNING id`,
    [req.category.id, Date.now(), projectIds, req.user.id]
  );
  res.json({ assigned: updated.length });
});

// DELETE /api/categories/:id/chatbots/:projectId — unassign one chatbot.
router.delete('/:id/chatbots/:projectId', authRequired, ownsCategory, async (req, res) => {
  const project = await db.findOne('projects', {
    id: req.params.projectId,
    userId: req.user.id,
    categoryId: req.category.id,
  });
  if (!project) return res.status(404).json({ error: 'Chatbot not found in this category' });
  await db.update('projects', project.id, { categoryId: null });
  res.json({ ok: true });
});

module.exports = router;
