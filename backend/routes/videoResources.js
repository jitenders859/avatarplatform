/**
 * Owner-curated video library, per project — backs the recommend_video
 * tool (backend/services/tools.js). Deliberately owner-authored only, no
 * AI generation or live search here; see tools.js for why.
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

// GET /api/projects/:projectId/video-resources
router.get('/:projectId/video-resources', authRequired, ownsProject, async (req, res) => {
  const videos = await db.findAll('videoResources', { projectId: req.project.id }, { orderBy: 'createdAt', order: 'desc' });
  res.json({ videos });
});

// POST /api/projects/:projectId/video-resources
router.post('/:projectId/video-resources', authRequired, ownsProject, validate(schemas.videoResourceCreate), async (req, res) => {
  const { title, youtubeUrl, topicTags } = req.body;
  const created = await db.insert('videoResources', {
    id: uuid(),
    projectId: req.project.id,
    title,
    youtubeUrl,
    topicTags: topicTags.map(t => t.toLowerCase()).filter(Boolean),
    createdAt: Date.now(),
  });
  res.json({ video: created });
});

// DELETE /api/projects/:projectId/video-resources/:videoId
router.delete('/:projectId/video-resources/:videoId', authRequired, ownsProject, async (req, res) => {
  const existing = await db.findOne('videoResources', { id: req.params.videoId, projectId: req.project.id });
  if (!existing) return res.status(404).json({ error: 'Video not found' });
  await db.remove('videoResources', { id: existing.id });
  res.json({ ok: true });
});

module.exports = router;
