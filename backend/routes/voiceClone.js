/**
 * Voice cloning (see docs/competitor-feature-implementation-plan.md 2c) —
 * Pro/Business-gated. Stores the resulting ElevenLabs voice ID on
 * projects.voice using the `el:<voiceId>` convention documented in
 * public/docs/elevenlabs-avatar.html. See backend/services/elevenlabsVoice.js
 * for the important caveat: this does not wire up actual playback, since
 * the TTS proxy that convention describes doesn't exist in this codebase.
 */
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { invalidateProjectCache } = require('../cache');
const { userPlanId } = require('../services/usage');
const { cloneVoice } = require('../services/elevenlabsVoice');

const router = express.Router();

const ALLOWED_MIME = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/webm', 'audio/ogg']);
const sampleUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/:projectId/voice-clone', authRequired, sampleUpload.single('sample'), async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.projectId, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const planId = await userPlanId(req.user.id);
  if (planId !== 'pro' && planId !== 'business') {
    return res.status(402).json({ error: 'Voice cloning requires the Pro or Business plan.', code: 'PLAN_UPGRADE_REQUIRED' });
  }

  if (!req.file) return res.status(400).json({ error: 'An audio sample file is required (field name: sample)' });
  if (!ALLOWED_MIME.has(req.file.mimetype)) {
    return res.status(400).json({ error: `Unsupported audio type: ${req.file.mimetype}` });
  }

  try {
    const voiceId = await cloneVoice({
      name: `${project.name} (${project.publicId})`,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      filename: req.file.originalname,
    });
    const voice = `el:${voiceId}`;
    const updated = await db.update('projects', project.id, { voice });
    invalidateProjectCache(project.publicId);
    res.json({ voice: updated.voice, voiceId });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
