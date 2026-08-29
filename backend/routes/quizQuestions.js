/**
 * Owner-authored quiz question bank, per project.
 *
 * The generate_quiz tool (backend/services/tools.js) checks this bank
 * before generating anything via AI — an owner-written question carries
 * zero hallucination risk by definition, so it's always preferred over a
 * generated one when one exists for the requested topic.
 */
const express = require('express');
const multer = require('multer');
const { randomUUID: uuid } = require('crypto');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { parseQuizCsv } = require('../services/csvImport');
const settings = require('../services/settings');

const router = express.Router();
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const DISTRACTOR_MODEL = process.env.QUIZ_DISTRACTOR_MODEL || 'gemini-3.1-flash-lite';

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

// Re-validates a PATCH's merged (existing + incoming) fields — the schema
// only type-checks the incoming partial body; correctIndex has to be
// re-checked against options once we know what the merged options array is.
function correctIndexInBounds(body) {
  const { options, correctIndex } = body;
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
    return 'correctIndex must be a valid index into options';
  }
  return null;
}

// GET /api/projects/:projectId/quiz-questions
router.get('/:projectId/quiz-questions', authRequired, ownsProject, async (req, res) => {
  const questions = await db.findAll(
    'quizQuestions', { projectId: req.project.id }, { orderBy: 'createdAt', order: 'desc' }
  );
  res.json({ questions });
});

// POST /api/projects/:projectId/quiz-questions
router.post('/:projectId/quiz-questions', authRequired, ownsProject, validate(schemas.quizQuestionCreate), async (req, res) => {
  const { question, options, correctIndex, topicTag } = req.body;
  const created = await db.insert('quizQuestions', {
    id: uuid(),
    projectId: req.project.id,
    question,
    options,
    correctIndex,
    topicTag: topicTag || null,
    createdAt: Date.now(),
  });
  res.json({ question: created });
});

// POST /api/projects/:projectId/quiz-questions/import-csv
// Columns: question, option1, option2, option3, option4, correct_answer, topic_tag
// (option3/option4 optional; correct_answer must match one option's text exactly).
router.post('/:projectId/quiz-questions/import-csv', authRequired, ownsProject, csvUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file required' });

  const { rows, errors } = parseQuizCsv(req.file.buffer);
  // Previously ran one INSERT per CSV row (N round trips for an N-row
  // import). db.insertMany batches inserts in groups of 100 inside a single
  // transaction — same pattern process.js already uses for chunk rows.
  const now = Date.now();
  const created = await db.insertMany('quizQuestions', rows.map(row => ({
    id: uuid(),
    projectId: req.project.id,
    question: row.question,
    options: row.options,
    correctIndex: row.correctIndex,
    topicTag: row.topicTag,
    createdAt: now,
  })));
  res.json({ imported: created.length, errors });
});

// PATCH /api/projects/:projectId/quiz-questions/:qId
router.patch('/:projectId/quiz-questions/:qId', authRequired, ownsProject, validate(schemas.quizQuestionPatch), async (req, res) => {
  const existing = await db.findOne('quizQuestions', { id: req.params.qId, projectId: req.project.id });
  if (!existing) return res.status(404).json({ error: 'Question not found' });

  const merged = {
    question: req.body.question !== undefined ? req.body.question : existing.question,
    options: req.body.options !== undefined ? req.body.options : existing.options,
    correctIndex: req.body.correctIndex !== undefined ? req.body.correctIndex : existing.correctIndex,
  };
  const err = correctIndexInBounds(merged);
  if (err) return res.status(400).json({ error: err });

  const patch = { question: merged.question, options: merged.options, correctIndex: merged.correctIndex };
  if (req.body.topicTag !== undefined) patch.topicTag = req.body.topicTag || null;

  const updated = await db.update('quizQuestions', existing.id, patch);
  res.json({ question: updated });
});

// DELETE /api/projects/:projectId/quiz-questions/:qId
router.delete('/:projectId/quiz-questions/:qId', authRequired, ownsProject, async (req, res) => {
  const existing = await db.findOne('quizQuestions', { id: req.params.qId, projectId: req.project.id });
  if (!existing) return res.status(404).json({ error: 'Question not found' });
  await db.remove('quizQuestions', { id: existing.id });
  res.json({ ok: true });
});

// POST /api/projects/:projectId/quiz-questions/suggest-distractors
// Cheap helper: owner supplies a question + the correct answer, gets 3
// plausible wrong options back. Uses flash-lite since this is a much
// simpler generation task than full quiz synthesis from source material.
router.post('/:projectId/quiz-questions/suggest-distractors', authRequired, ownsProject, validate(schemas.quizSuggestDistractors), async (req, res) => {
  const { question, correctAnswer } = req.body;

  try {
    const genai = new GoogleGenerativeAI(await settings.getSetting('GEMINI_API_KEY'));
    const model = genai.getGenerativeModel({
      model: DISTRACTOR_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: { distractors: { type: 'array', items: { type: 'string' } } },
          required: ['distractors'],
        },
      },
    });
    const prompt = `Question: ${question}\nCorrect answer: ${correctAnswer}\n\n` +
      'Write exactly 3 plausible but incorrect answer options for this multiple-choice question. ' +
      'They should be believable distractors (similar in length/style to the correct answer), not obviously wrong or silly.';
    const result = await model.generateContent(prompt);
    const parsed = JSON.parse(result.response.text());
    res.json({ distractors: (parsed.distractors || []).slice(0, 3) });
  } catch (e) {
    res.status(502).json({ error: 'AI service unavailable' });
  }
});

module.exports = router;
