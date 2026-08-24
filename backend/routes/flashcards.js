/**
 * Owner-authored flashcard bank, per project — same role as quizQuestions.js.
 * The generate_flashcards tool (backend/services/tools.js) checks this bank
 * before generating anything via AI.
 */
const express = require('express');
const multer = require('multer');
const { randomUUID: uuid } = require('crypto');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { parseFlashcardCsv } = require('../services/csvImport');

const router = express.Router();
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

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

// GET /api/projects/:projectId/flashcards
router.get('/:projectId/flashcards', authRequired, ownsProject, async (req, res) => {
  const cards = await db.findAll('flashcards', { projectId: req.project.id }, { orderBy: 'createdAt', order: 'desc' });
  res.json({ cards });
});

// POST /api/projects/:projectId/flashcards
router.post('/:projectId/flashcards', authRequired, ownsProject, validate(schemas.flashcardCreate), async (req, res) => {
  const { front, back, topicTag } = req.body;
  const created = await db.insert('flashcards', {
    id: uuid(),
    projectId: req.project.id,
    front,
    back,
    topicTag: topicTag || null,
    createdAt: Date.now(),
  });
  res.json({ card: created });
});

// POST /api/projects/:projectId/flashcards/import-csv
// Columns: front, back, topic_tag
router.post('/:projectId/flashcards/import-csv', authRequired, ownsProject, csvUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file required' });

  const { rows, errors } = parseFlashcardCsv(req.file.buffer);
  // Previously ran one INSERT per CSV row (N round trips for an N-row
  // import). db.insertMany batches inserts in groups of 100 inside a single
  // transaction — same pattern process.js already uses for chunk rows.
  const now = Date.now();
  const created = await db.insertMany('flashcards', rows.map(row => ({
    id: uuid(),
    projectId: req.project.id,
    front: row.front,
    back: row.back,
    topicTag: row.topicTag,
    createdAt: now,
  })));
  res.json({ imported: created.length, errors });
});

// DELETE /api/projects/:projectId/flashcards/:cardId
router.delete('/:projectId/flashcards/:cardId', authRequired, ownsProject, async (req, res) => {
  const existing = await db.findOne('flashcards', { id: req.params.cardId, projectId: req.project.id });
  if (!existing) return res.status(404).json({ error: 'Card not found' });
  await db.remove('flashcards', { id: existing.id });
  res.json({ ok: true });
});

module.exports = router;
