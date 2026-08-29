/**
 * Owner-defined AI actions (see docs/competitor-feature-implementation-plan.md
 * 1d) — CRUD for the project_actions table. Actions are merged into the
 * Gemini tool-calling loop at POST /embed/:publicId/study (see
 * backend/services/tools.js#projectActionTools) — this file only manages
 * the definitions, not the runtime dispatch.
 */
const express = require('express');
const { randomUUID: uuid } = require('crypto');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');

const router = express.Router();

async function ownsProject(req, res, next) {
  try {
    const p = await db.findOne('projects', { id: req.params.projectId, userId: req.user.id });
    if (!p) return res.status(404).json({ error: 'Project not found' });
    req.project = p;
    next();
  } catch (e) {
    next(e);
  }
}

// GET /api/projects/:projectId/actions
router.get('/:projectId/actions', authRequired, ownsProject, async (req, res) => {
  const actions = await db.findAll('projectActions', { projectId: req.project.id }, { orderBy: 'createdAt', order: 'asc' });
  res.json({ actions });
});

// POST /api/projects/:projectId/actions
router.post('/:projectId/actions', authRequired, ownsProject, validate(schemas.projectActionCreate), async (req, res) => {
  const { name, description, parameters, webhookUrl, active } = req.body;

  const duplicate = await db.findOne('projectActions', { projectId: req.project.id, name });
  if (duplicate) return res.status(409).json({ error: `An action named "${name}" already exists in this project` });

  const action = await db.insert('projectActions', {
    id: uuid(),
    projectId: req.project.id,
    name,
    description,
    parameters: parameters || {},
    webhookUrl,
    active: active !== false,
    createdAt: Date.now(),
  });
  res.json({ action });
});

// PATCH /api/projects/:projectId/actions/:actionId
router.patch('/:projectId/actions/:actionId', authRequired, ownsProject, validate(schemas.projectActionPatch), async (req, res) => {
  const action = await db.findOne('projectActions', { id: req.params.actionId, projectId: req.project.id });
  if (!action) return res.status(404).json({ error: 'Action not found' });

  const { name, description, parameters, webhookUrl, active } = req.body;
  if (name !== undefined && name !== action.name) {
    const duplicate = await db.findOne('projectActions', { projectId: req.project.id, name });
    if (duplicate) return res.status(409).json({ error: `An action named "${name}" already exists in this project` });
  }
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (description !== undefined) patch.description = description;
  if (parameters !== undefined) patch.parameters = parameters;
  if (webhookUrl !== undefined) patch.webhookUrl = webhookUrl;
  if (active !== undefined) patch.active = active;

  const updated = await db.update('projectActions', action.id, patch);
  res.json({ action: updated });
});

// DELETE /api/projects/:projectId/actions/:actionId
router.delete('/:projectId/actions/:actionId', authRequired, ownsProject, async (req, res) => {
  const action = await db.findOne('projectActions', { id: req.params.actionId, projectId: req.project.id });
  if (!action) return res.status(404).json({ error: 'Action not found' });
  await db.remove('projectActions', { id: action.id });
  res.json({ ok: true });
});

module.exports = router;
