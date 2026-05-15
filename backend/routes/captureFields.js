const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_TYPES = ['text', 'email', 'phone', 'number', 'date', 'time', 'select'];

function ownsProject(req, res, next) {
  const p = db.findOne('projects', x => x.id === req.params.projectId && x.userId === req.user.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  req.project = p;
  next();
}

// GET /api/projects/:projectId/capture
router.get('/:projectId/capture', authRequired, ownsProject, (req, res) => {
  const fields = db.findAll('captureFields', f => f.projectId === req.project.id)
    .sort((a, b) => a.order - b.order);
  res.json({ fields });
});

// POST /api/projects/:projectId/capture/reorder  — must be before /:fieldId
router.post('/:projectId/capture/reorder', authRequired, ownsProject, async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });

  for (let i = 0; i < ids.length; i++) {
    const field = db.findOne('captureFields', f => f.id === ids[i] && f.projectId === req.project.id);
    if (field) await db.update('captureFields', field.id, { order: i });
  }
  const fields = db.findAll('captureFields', f => f.projectId === req.project.id)
    .sort((a, b) => a.order - b.order);
  res.json({ fields });
});

// POST /api/projects/:projectId/capture
router.post('/:projectId/capture', authRequired, ownsProject, async (req, res) => {
  const { label, key, type, options, required, order } = req.body || {};

  if (!label || !String(label).trim()) return res.status(400).json({ error: 'label is required' });
  if (!key) return res.status(400).json({ error: 'key is required' });
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    return res.status(400).json({ error: 'key must match /^[a-z][a-z0-9_]*$/' });
  }
  if (key.length > 40) return res.status(400).json({ error: 'key must be 40 characters or fewer' });
  if (!ALLOWED_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${ALLOWED_TYPES.join(', ')}` });
  }
  if (type === 'select' && (!Array.isArray(options) || options.length === 0)) {
    return res.status(400).json({ error: 'options array required for type=select' });
  }

  const duplicate = db.findOne('captureFields', f => f.projectId === req.project.id && f.key === key);
  if (duplicate) return res.status(409).json({ error: `key "${key}" already exists in this project` });

  const existing = db.findAll('captureFields', f => f.projectId === req.project.id);
  const field = {
    id: uuid(),
    projectId: req.project.id,
    label: String(label).trim(),
    key,
    type,
    options: type === 'select' ? options.map(String) : null,
    required: required !== false,
    order: order != null ? order : existing.length,
    createdAt: Date.now(),
  };
  await db.insert('captureFields', field);
  res.json({ field });
});

// PATCH /api/projects/:projectId/capture/:fieldId
router.patch('/:projectId/capture/:fieldId', authRequired, ownsProject, async (req, res) => {
  const field = db.findOne('captureFields', f => f.id === req.params.fieldId && f.projectId === req.project.id);
  if (!field) return res.status(404).json({ error: 'Capture field not found' });

  const { label, type, options, required, order } = req.body || {};
  const patch = {};

  if (label !== undefined) {
    const trimmed = String(label).trim();
    if (!trimmed) return res.status(400).json({ error: 'label cannot be empty' });
    patch.label = trimmed;
  }
  if (type !== undefined) {
    if (!ALLOWED_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${ALLOWED_TYPES.join(', ')}` });
    }
    patch.type = type;
  }
  const effectiveType = patch.type || field.type;
  if (effectiveType === 'select') {
    const opts = options !== undefined ? options : field.options;
    if (!Array.isArray(opts) || opts.length === 0) {
      return res.status(400).json({ error: 'options required for type=select' });
    }
    patch.options = opts.map(String);
  } else {
    patch.options = null;
  }
  if (required !== undefined) patch.required = !!required;
  if (order !== undefined) patch.order = Number(order);

  const updated = await db.update('captureFields', field.id, patch);
  res.json({ field: updated });
});

// DELETE /api/projects/:projectId/capture/:fieldId
router.delete('/:projectId/capture/:fieldId', authRequired, ownsProject, async (req, res) => {
  const field = db.findOne('captureFields', f => f.id === req.params.fieldId && f.projectId === req.project.id);
  if (!field) return res.status(404).json({ error: 'Capture field not found' });
  await db.remove('captureFields', f => f.id === field.id);
  res.json({ ok: true });
});

module.exports = router;
