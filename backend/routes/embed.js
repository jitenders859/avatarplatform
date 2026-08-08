/**
 * Public-facing routes used by the embed iframe.
 *
 * No JWT required — reached by anonymous visitors on the project owner's
 * website. Rate-limited per IP+project to prevent abuse.
 */
const express = require('express');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const storage = require('../services/storage');
const { CHARACTERS } = require('./projects');
const { embedOne } = require('../services/embed');
const { searchProject } = require('../services/vector');
const { resolveFigures } = require('../services/figures');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const { projectCache, invalidateProjectCache } = require('../cache');
const { validate, schemas } = require('../middleware/validate');
const { toolsForTier } = require('../services/tools');
const { resolveLearnerKey, backfillLearnerKey } = require('../services/learner');
const { checkLimit, userPlanId } = require('../services/usage');
const logger = require('../logger').child({ module: 'embed' });
const router = express.Router();

const STUDY_MODEL = process.env.STUDY_MODEL || 'gemini-2.5-flash';
const MAX_TOOL_ITERATIONS = 5;

const PUBLIC_API_KEY = process.env.PUBLIC_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';

async function findByPublicId(publicId) {
  if (projectCache.has(publicId)) return projectCache.get(publicId);
  const project = await db.findOne('projects', { publicId });
  if (project) projectCache.set(publicId, project);
  return project;
}

/** Fetch files for a set of chunk hits in one round trip instead of one query per hit. */
async function filesForHits(hits) {
  const ids = [...new Set(hits.map(h => h.chunk.fileId))];
  if (!ids.length) return new Map();
  const rows = await db.query('SELECT * FROM files WHERE id = ANY($1::uuid[])', [ids]);
  return new Map(rows.map(f => [f.id, f]));
}

/**
 * Fetch page_images for a set of chunk hits in one round trip. Keyed by
 * "fileId:pageNumber" (chunks.page_hint is accurate — see chunk.js), mapped
 * to an ARRAY of figure rows since a page can now have zero, one, or
 * several distinct figures (see backend/services/pageImages.js).
 */
async function pageImagesForHits(hits) {
  const fileIds = [...new Set(hits.map(h => h.chunk.fileId).filter(Boolean))];
  if (!fileIds.length) return new Map();
  const rows = await db.query('SELECT * FROM page_images WHERE file_id = ANY($1::uuid[])', [fileIds]);
  const map = new Map();
  for (const r of rows) {
    const key = `${r.fileId}:${r.pageNumber}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

module.exports.invalidateProjectCache = invalidateProjectCache;

/**
 * GET /embed/:publicId/config
 */
router.get('/:publicId/config', async (req, res) => {
  try {
    const project = await findByPublicId(req.params.publicId);
    if (!project) return res.status(404).json({ error: 'Chatbot not found' });
    const character = CHARACTERS.find(c => c.id === project.characterId) || CHARACTERS[0];

    const captureFields = await db.findAll('captureFields', { projectId: project.id }, { orderBy: 'order', order: 'asc' });

    // Free-plan watermark: the "Powered by AvatarPlatform" badge is a paid
    // feature to remove. showBranding is a per-project owner setting, but on
    // the Free plan it must always render regardless of what's stored — this
    // is the server-side gate; the project.html toggle also disables itself
    // for Free-plan owners as a UX hint, but this is the enforcement point.
    const planId = await userPlanId(project.userId);
    const messageLimitCheck = await checkLimit(project.userId, 'message', 1);

    res.json({
      project: {
        id: project.id,
        publicId: project.publicId,
        name: project.name,
        voice: project.voice,
        systemPrompt: project.systemPrompt,
        welcomeMessage: project.welcomeMessage,
        capabilityTier: project.capabilityTier || 'basic',
        // Widget settings
        widgetPosition:        project.widgetPosition        || 'bottom-right',
        widgetStartOpen:       project.widgetStartOpen !== false ? !!project.widgetStartOpen : false,
        textDirection:         project.textDirection         || 'auto',
        themeColor:            project.themeColor            || '#7c6af5',
        widgetTheme:           project.widgetTheme            || 'light',
        showBranding:          planId === 'free' ? true : project.showBranding !== false,
        showSourceCards:       project.showSourceCards       !== false,
        showQuickReplies:      project.showQuickReplies      === true,
        allowDragDropUpload:   project.allowDragDropUpload   === true,
        fullScreenOnDesktop:   project.fullScreenOnDesktop   === true,
        fullScreenOnMobile:    project.fullScreenOnMobile    === true,
        showFullScreenToggle:  project.showFullScreenToggle  === true,
        widgetOffsetX:         project.widgetOffsetX         || 0,
        widgetOffsetY:         project.widgetOffsetY         || 0,
        // Avatar placement
        avatarPosition:        project.avatarPosition        || 'right',
        avatarSize:            project.avatarSize            || 'large',
        showAvatarInLauncher:  project.showAvatarInLauncher  !== false,
        avatarOffsetX:         project.avatarOffsetX         || 0,
        avatarOffsetY:         project.avatarOffsetY         || 0,
        avatarKeepVisible:     project.avatarKeepVisible     !== false,
        avatarCompactOnMobile: project.avatarCompactOnMobile !== false,
      },
      character: {
        id: character.id,
        name: character.name,
        rivePath: character.rivePath,
      },
      captureFields: captureFields.map(f => ({
        id: f.id, label: f.label, key: f.key,
        type: f.type, options: f.options, required: f.required, order: f.order,
      })),
      // The Live voice path connects browser → Gemini directly with this key
      // (see lipsync-sdk.js), so our backend never sees those messages to
      // gate them individually. Withholding the key once the owner's
      // monthly message quota is exhausted is the enforcement point for
      // that path; /ask and /study additionally check per-request since
      // they do proxy through us.
      apiKey: messageLimitCheck.ok ? PUBLIC_API_KEY : null,
      limitReached: !messageLimitCheck.ok,
      limitMessage: messageLimitCheck.ok ? null : messageLimitCheck.reason,
      model: 'gemini-3.1-flash-live-preview',
    });
  } catch (e) {
    logger.error({ err: e.message }, 'config error');
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /embed/:publicId/retrieve
 */
router.post('/:publicId/retrieve', async (req, res) => {
  const project = await findByPublicId(req.params.publicId);
  if (!project) return res.status(404).json({ error: 'Chatbot not found' });

  const { query, k = 5 } = req.body || {};
  if (!query || !String(query).trim()) return res.status(400).json({ error: 'Query required' });

  let queryEmbedding;
  try {
    queryEmbedding = await embedOne(String(query).slice(0, 1500), 'RETRIEVAL_QUERY');
  } catch (e) {
    logger.error({ err: e.message }, 'retrieve embed failed');
    return res.status(502).json({ error: 'Embedding service unavailable' });
  }

  const hits = await searchProject(project.id, queryEmbedding, Math.min(Math.max(1, k), 10));

  const fileCache = await filesForHits(hits);
  const showFigures = project.capabilityTier !== 'basic';
  const pageImageCache = showFigures ? await pageImagesForHits(hits) : new Map();
  const sources = [];
  const chunks = [];
  for (const hit of hits) {
    const file = fileCache.get(hit.chunk.fileId);
    chunks.push({
      text: hit.chunk.text,
      score: hit.score,
      fileId: hit.chunk.fileId,
      fileName: file ? file.originalName : null,
      kind: file ? file.kind : null,
    });
    if (file && !sources.find(s => s.fileId === file.id)) {
      sources.push({
        fileId: file.id,
        fileName: file.originalName,
        kind: file.kind,
        previewUrl: file.kind === 'image'
          ? `/embed/${project.publicId}/file/${file.id}`
          : null,
      });
    }
  }

  const figures = showFigures
    ? await resolveFigures({ projectId: project.id, queryEmbedding, hits, pageImageCache, publicId: project.publicId, fileCache })
    : [];

  res.json({ chunks, sources, figures });
});

/**
 * GET /embed/:publicId/file/:fileId
 *
 * Images: always servable (existing behavior). PDFs: only at medium/
 * advanced tier — the source document link feature from the multimodal
 * design. `#page=N` is a browser-native PDF viewer fragment, appended
 * client-side; no server-side page handling needed for it.
 */
router.get('/:publicId/file/:fileId', async (req, res) => {
  try {
    const project = await findByPublicId(req.params.publicId);
    if (!project) return res.status(404).end();
    const file = await db.findOne('files', { id: req.params.fileId, projectId: project.id });
    if (!file) return res.status(404).end();
    const allowed = file.kind === 'image' || (file.kind === 'pdf' && project.capabilityTier !== 'basic');
    if (!allowed) return res.status(403).end();
    if (!file.storageKey) return res.status(410).end();
    const url = await storage.getSignedDownloadUrl(file.storageKey);
    res.redirect(302, url);
  } catch (e) {
    res.status(500).end();
  }
});

/**
 * GET /embed/:publicId/page-image/:pageImageId
 * Serves a rasterized, figure-bearing PDF page (see backend/services/pageImages.js).
 */
router.get('/:publicId/page-image/:pageImageId', async (req, res) => {
  try {
    const project = await findByPublicId(req.params.publicId);
    if (!project) return res.status(404).end();
    if (project.capabilityTier === 'basic') return res.status(403).end();

    const pageImage = await db.findOne('pageImages', { id: req.params.pageImageId, projectId: project.id });
    if (!pageImage) return res.status(404).end();
    if (!pageImage.imagePath) return res.status(410).end();
    const url = await storage.getSignedDownloadUrl(pageImage.imagePath);
    res.redirect(302, url);
  } catch (e) {
    res.status(500).end();
  }
});

/**
 * POST /embed/:publicId/ask
 * Async Q&A — no voice, no WebSocket. Returns a text answer + sources.
 */
router.post('/:publicId/ask', validate(schemas.ask), async (req, res) => {
  try {
    const project = await findByPublicId(req.params.publicId);
    if (!project) return res.status(404).json({ error: 'Chatbot not found' });

    const limitCheck = await checkLimit(project.userId, 'message', 1);
    if (!limitCheck.ok) return res.status(402).json({ error: limitCheck.reason });

    const ip = req.ip || 'unknown';
    const { question, sessionId: incomingSessionId } = req.body;

    // 1. Embed the question
    let queryEmbedding;
    try {
      queryEmbedding = await embedOne(String(question).slice(0, 1500), 'RETRIEVAL_QUERY');
    } catch (e) {
      logger.error({ err: e.message }, 'ask embed failed');
      return res.status(502).json({ error: 'Embedding service unavailable' });
    }

    // 2. Retrieve relevant chunks
    const hits = await searchProject(project.id, queryEmbedding, 5);

    const fileCache = await filesForHits(hits);
    const sources = [];
    const contextParts = [];

    for (const hit of hits) {
      const file = fileCache.get(hit.chunk.fileId);
      contextParts.push(`[Source: ${file ? file.originalName : 'Unknown'}]\n${hit.chunk.text}`);
      if (file && !sources.find(s => s.fileId === file.id)) {
        sources.push({
          title: file.originalName || file.sourceUrl || 'Document',
          url: file.kind === 'url' ? file.sourceUrl : null,
          snippet: hit.chunk.text.slice(0, 180).trim(),
        });
      }
    }

    // 3. Build prompt
    const systemPrompt = project.systemPrompt ||
      'You are a helpful AI assistant. Answer the user\'s question using the provided knowledge base context. Be concise and accurate.';
    const contextText = contextParts.length
      ? `Knowledge base context:\n\n${contextParts.join('\n\n---\n\n')}`
      : 'No relevant context found in the knowledge base.';

    const prompt = `${systemPrompt}\n\n${contextText}\n\nUser question: ${String(question).slice(0, 1000)}\n\nAnswer:`;

    // 4. Call Gemini REST
    let answer = '';
    try {
      const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent(prompt);
      answer = result.response.text();
    } catch (e) {
      logger.error({ err: e.message }, 'ask Gemini call failed');
      return res.status(502).json({ error: 'AI service unavailable' });
    }

    // 5. Persist session + messages
    let sid = incomingSessionId;
    try {
      if (!sid) {
        sid = uuid();
        await db.insert('sessions', { id: sid, projectId: project.id, ip, createdAt: Date.now() });
      }
      await db.insert('messages', {
        id: uuid(), sessionId: sid, projectId: project.id,
        role: 'user', text: String(question).slice(0, 2000), createdAt: Date.now(),
      });
      await db.insert('messages', {
        id: uuid(), sessionId: sid, projectId: project.id,
        role: 'assistant', text: answer.slice(0, 2000), createdAt: Date.now(),
      });
      try {
        const { trackMessage } = require('../services/usage');
        await trackMessage(project.userId);
      } catch (_) { /* best effort */ }
    } catch (e) {
      logger.error({ err: e.message }, 'ask persist failed');
      // Non-fatal — still return the answer
    }

    res.json({ answer, sources, sessionId: sid });
  } catch (e) {
    logger.error({ err: e.message }, 'ask error');
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /embed/:publicId/study
 *
 * Tool-calling chat for study-tier features (quizzes, flashcards, etc. —
 * see backend/services/tools.js for the registry). Requires capabilityTier
 * !== 'basic'. Text/REST only — the Gemini Live voice path in
 * lipsync-sdk.js does not do tool-calling and is untouched by this route.
 *
 * Grounds the conversation in retrieved knowledge-base chunks the same way
 * /ask does, then runs a standard function-calling loop: send the message,
 * check for tool calls, dispatch them, feed results back, repeat until the
 * model returns a final text answer (capped at MAX_TOOL_ITERATIONS to avoid
 * a pathological tool-call loop).
 */
router.post('/:publicId/study', validate(schemas.study), async (req, res) => {
  try {
    const project = await findByPublicId(req.params.publicId);
    if (!project) return res.status(404).json({ error: 'Chatbot not found' });

    if (project.capabilityTier === 'basic') {
      return res.status(403).json({
        error: 'Study tools require the Medium or Advanced capability tier for this chatbot. Change it in project settings.',
      });
    }

    const limitCheck = await checkLimit(project.userId, 'message', 1);
    if (!limitCheck.ok) return res.status(402).json({ error: limitCheck.reason });

    const ip = req.ip || 'unknown';
    const { message, sessionId: incomingSessionId } = req.body;

    // 1. Embed the message + retrieve knowledge-base context (same pattern as /ask)
    let queryEmbedding;
    try {
      queryEmbedding = await embedOne(String(message).slice(0, 1500), 'RETRIEVAL_QUERY');
    } catch (e) {
      logger.error({ err: e.message }, 'study embed failed');
      return res.status(502).json({ error: 'Embedding service unavailable' });
    }

    const hits = await searchProject(project.id, queryEmbedding, 5);
    const fileCache = await filesForHits(hits);
    // capabilityTier !== 'basic' already enforced above to even reach this route.
    const pageImageCache = await pageImagesForHits(hits);
    const sources = [];
    const contextParts = [];

    for (const hit of hits) {
      const file = fileCache.get(hit.chunk.fileId);
      contextParts.push(`[Source: ${file ? file.originalName : 'Unknown'}]\n${hit.chunk.text}`);
      // Same shape as /retrieve's sources — embed.html's attachSources() renders both identically.
      if (file && !sources.find(s => s.fileId === file.id)) {
        sources.push({
          fileId: file.id,
          fileName: file.originalName,
          kind: file.kind,
          previewUrl: file.kind === 'image'
            ? `/embed/${project.publicId}/file/${file.id}`
            : null,
        });
      }
    }

    const figures = await resolveFigures({ projectId: project.id, queryEmbedding, hits, pageImageCache, publicId: project.publicId, fileCache });

    const basePrompt = project.systemPrompt ||
      'You are a helpful AI study assistant. Answer using the provided knowledge base context.';
    const contextText = contextParts.length
      ? `Knowledge base context:\n\n${contextParts.join('\n\n---\n\n')}`
      : 'No relevant context found in the knowledge base.';
    const systemInstruction = `${basePrompt}\n\n${contextText}`;

    // 2. Function-calling loop
    const { declarations, dispatch } = toolsForTier(project.capabilityTier);
    const toolCalls = [];
    let answer = '';
    try {
      const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genai.getGenerativeModel({
        model: STUDY_MODEL,
        systemInstruction,
        tools: declarations.length ? [{ functionDeclarations: declarations }] : undefined,
      });
      const chat = model.startChat();
      const ctx = { project };

      let result = await chat.sendMessage(String(message).slice(0, 1000));
      let calls = result.response.functionCalls();
      let iterations = 0;

      while (calls && calls.length && iterations < MAX_TOOL_ITERATIONS) {
        const responseParts = [];
        for (const call of calls) {
          const handler = dispatch[call.name];
          let output;
          try {
            output = handler ? await handler(call.args || {}, ctx) : { error: `Unknown tool: ${call.name}` };
          } catch (e) {
            output = { error: e.message };
          }
          toolCalls.push({ name: call.name, args: call.args, result: output });
          responseParts.push({ functionResponse: { name: call.name, response: output } });
        }
        result = await chat.sendMessage(responseParts);
        calls = result.response.functionCalls();
        iterations++;
      }

      answer = result.response.text();
    } catch (e) {
      logger.error({ err: e.message }, 'study Gemini call failed');
      return res.status(502).json({ error: 'AI service unavailable' });
    }

    // 3. Persist session + messages
    let sid = incomingSessionId;
    try {
      if (!sid) {
        sid = uuid();
        await db.insert('sessions', { id: sid, projectId: project.id, ip, createdAt: Date.now() });
      }
      await db.insert('messages', {
        id: uuid(), sessionId: sid, projectId: project.id,
        role: 'user', text: String(message).slice(0, 2000), createdAt: Date.now(),
      });
      await db.insert('messages', {
        id: uuid(), sessionId: sid, projectId: project.id,
        role: 'assistant', text: answer.slice(0, 2000), createdAt: Date.now(),
      });
      try {
        const { trackMessage } = require('../services/usage');
        await trackMessage(project.userId);
      } catch (_) { /* best effort */ }
    } catch (e) {
      logger.error({ err: e.message }, 'study persist failed');
      // Non-fatal — still return the answer
    }

    res.json({ answer, toolCalls, sources, figures, sessionId: sid });
  } catch (e) {
    logger.error({ err: e.message }, 'study error');
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /embed/:publicId/quiz-attempt
 *
 * Logs a single quiz question attempt for progress tracking. Grading
 * happens client-side (the client already has correctIndex from the
 * generate_quiz tool result) — this just records what happened. Trusting
 * the client-reported correctIndex is fine here: it originated from this
 * same server moments earlier via /study, and this is ungraded practice
 * content, not a proctored exam.
 */
router.post('/:publicId/quiz-attempt', validate(schemas.quizAttempt), async (req, res) => {
  try {
    const project = await findByPublicId(req.params.publicId);
    if (!project) return res.status(404).json({ error: 'Chatbot not found' });

    const { sessionId, question, topic, selectedIndex, correctIndex, sourceChunkIds } = req.body;
    const session = await db.findOne('sessions', { id: sessionId, projectId: project.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const learnerKey = await resolveLearnerKey(project.id, sessionId);
    const attempt = await db.insert('quizAttempts', {
      id: uuid(),
      projectId: project.id,
      sessionId,
      learnerKey,
      question,
      topic: topic || null,
      selectedIndex: selectedIndex ?? null,
      correctIndex,
      isCorrect: selectedIndex === correctIndex,
      sourceChunkIds: sourceChunkIds || [],
      createdAt: Date.now(),
    });
    res.json({ attempt: { id: attempt.id, isCorrect: attempt.isCorrect } });
  } catch (e) {
    logger.error({ err: e.message }, 'quiz-attempt error');
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /embed/:publicId/flashcard-review
 * Self-report review logging ("got it" / "still learning") — same
 * client-trust rationale as quiz-attempt.
 */
router.post('/:publicId/flashcard-review', validate(schemas.flashcardReview), async (req, res) => {
  try {
    const project = await findByPublicId(req.params.publicId);
    if (!project) return res.status(404).json({ error: 'Chatbot not found' });

    const { sessionId, front, back, topic, sourceChunkId, selfRating } = req.body;
    const session = await db.findOne('sessions', { id: sessionId, projectId: project.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const learnerKey = await resolveLearnerKey(project.id, sessionId);
    const review = await db.insert('flashcardReviews', {
      id: uuid(),
      projectId: project.id,
      sessionId,
      learnerKey,
      front,
      back,
      topic: topic || null,
      sourceChunkId: sourceChunkId || null,
      selfRating,
      createdAt: Date.now(),
    });
    res.json({ review: { id: review.id } });
  } catch (e) {
    logger.error({ err: e.message }, 'flashcard-review error');
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /embed/:publicId/progress?sessionId=X
 *
 * Learner-facing progress: accuracy by topic, cards reviewed, study streak.
 * Scoped to the resolved learner_key when available (aggregates across all
 * of that learner's sessions); falls back to just this session's own
 * activity when no email has been captured yet — still useful for the
 * current visit, just not durable across visits.
 */
router.get('/:publicId/progress', async (req, res) => {
  try {
    const project = await findByPublicId(req.params.publicId);
    if (!project) return res.status(404).json({ error: 'Chatbot not found' });

    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const learnerKey = await resolveLearnerKey(project.id, sessionId);
    const scopeClause = learnerKey ? 'learner_key = $2' : 'session_id = $2';
    const scopeValue = learnerKey || sessionId;

    const [quizRows, cardRows, dayRows] = await Promise.all([
      db.query(
        `SELECT topic, COUNT(*) AS total, SUM(CASE WHEN is_correct THEN 1 ELSE 0 END) AS correct
         FROM quiz_attempts WHERE project_id = $1 AND ${scopeClause} GROUP BY topic`,
        [project.id, scopeValue]
      ),
      db.query(
        `SELECT topic, COUNT(*) AS total, SUM(CASE WHEN self_rating = 'got_it' THEN 1 ELSE 0 END) AS got_it
         FROM flashcard_reviews WHERE project_id = $1 AND ${scopeClause} GROUP BY topic`,
        [project.id, scopeValue]
      ),
      db.query(
        `SELECT DISTINCT to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD') AS day FROM (
           SELECT created_at FROM quiz_attempts WHERE project_id = $1 AND ${scopeClause}
           UNION ALL
           SELECT created_at FROM flashcard_reviews WHERE project_id = $1 AND ${scopeClause}
         ) sub`,
        [project.id, scopeValue]
      ),
    ]);

    const topicMap = new Map();
    const getTopic = key => {
      if (!topicMap.has(key)) topicMap.set(key, { topic: key, quizTotal: 0, quizCorrect: 0, cardsTotal: 0, cardsGotIt: 0 });
      return topicMap.get(key);
    };
    for (const r of quizRows) {
      const t = getTopic(r.topic || 'General');
      t.quizTotal += Number(r.total); t.quizCorrect += Number(r.correct);
    }
    for (const r of cardRows) {
      const t = getTopic(r.topic || 'General');
      t.cardsTotal += Number(r.total); t.cardsGotIt += Number(r.gotIt);
    }
    const byTopic = [...topicMap.values()].map(t => ({
      topic: t.topic,
      quizTotal: t.quizTotal,
      quizAccuracy: t.quizTotal ? Math.round((t.quizCorrect / t.quizTotal) * 100) : null,
      cardsReviewed: t.cardsTotal,
      cardsMasteredPct: t.cardsTotal ? Math.round((t.cardsGotIt / t.cardsTotal) * 100) : null,
    }));

    const totalQuiz = byTopic.reduce((s, t) => s + t.quizTotal, 0);
    const totalCorrect = quizRows.reduce((s, r) => s + Number(r.correct), 0);
    const totalCards = byTopic.reduce((s, t) => s + t.cardsReviewed, 0);

    const days = new Set(dayRows.map(r => r.day));
    let streak = 0;
    const cursor = new Date();
    while (days.has(cursor.toISOString().slice(0, 10))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    res.json({
      scope: learnerKey ? 'learner' : 'session',
      totalQuizAttempts: totalQuiz,
      quizAccuracy: totalQuiz ? Math.round((totalCorrect / totalQuiz) * 100) : null,
      cardsReviewed: totalCards,
      streak,
      byTopic,
    });
  } catch (e) {
    logger.error({ err: e.message }, 'progress error');
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /embed/:publicId/log
 */
router.post('/:publicId/log', validate(schemas.log), async (req, res) => {
  const project = await findByPublicId(req.params.publicId);
  if (!project) return res.status(404).json({ error: 'Chatbot not found' });

  const ip = req.ip || 'unknown';
  const { sessionId, role, text } = req.body;

  let sid = sessionId;
  if (!sid) {
    sid = uuid();
    await db.insert('sessions', { id: sid, projectId: project.id, ip, createdAt: Date.now() });
  }
  await db.insert('messages', {
    id: uuid(),
    sessionId: sid,
    projectId: project.id,
    role,
    text: String(text).slice(0, 2000),
    createdAt: Date.now(),
  });

  if (role === 'user') {
    try {
      const { trackMessage } = require('../services/usage');
      await trackMessage(project.userId);
    } catch (_) { /* best effort */ }

    if (project.webhookUrl) {
      setImmediate(async () => {
        try {
          const payload = JSON.stringify({
            event: 'message',
            publicId: project.publicId,
            sessionId: sid,
            role,
            text: String(text).slice(0, 2000),
            timestamp: Date.now(),
          });
          const sig = 'sha256=' + crypto.createHmac('sha256', project.webhookSecret || '').update(payload).digest('hex');
          const fetch = require('node-fetch');
          await fetch(project.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Avatar-Signature': sig },
            body: payload,
            timeout: 5000,
          });
        } catch (e) {
          logger.warn({ err: e.message }, 'webhook delivery failed');
        }
      });
    }
  }
  res.json({ sessionId: sid });
});

/**
 * GET /embed/:publicId/capture-fields
 */
router.get('/:publicId/capture-fields', async (req, res) => {
  try {
    const project = await findByPublicId(req.params.publicId);
    if (!project) return res.status(404).json({ error: 'Chatbot not found' });

    const fields = await db.findAll('captureFields', { projectId: project.id }, { orderBy: 'order', order: 'asc' });
    res.json({
      fields: fields.map(f => ({ id: f.id, label: f.label, key: f.key, type: f.type, options: f.options, required: f.required })),
    });
  } catch (e) {
    logger.error({ err: e.message }, 'capture-fields error');
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /embed/:publicId/lead
 */
router.post('/:publicId/lead', async (req, res) => {
  const project = await findByPublicId(req.params.publicId);
  if (!project) return res.status(404).json({ error: 'Chatbot not found' });

  const ip = req.ip || 'unknown';

  const { sessionId, data, complete } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object required' });

  const session = await db.findOne('sessions', { id: sessionId, projectId: project.id });
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const fields = await db.findAll('captureFields', { projectId: project.id });
  const allowedKeys = new Set(fields.map(f => f.key));
  const sanitized = {};
  for (const [k, v] of Object.entries(data)) {
    if (allowedKeys.has(k)) sanitized[k] = String(v).slice(0, 500);
  }

  const existing = await db.findOne('leads', { sessionId, projectId: project.id });
  let lead;
  if (existing) {
    const merged = { ...existing.data, ...sanitized };
    const isComplete = complete !== undefined ? !!complete : (
      fields.filter(f => f.required).every(f => merged[f.key] && merged[f.key].trim())
    );
    lead = await db.update('leads', existing.id, { data: merged, complete: isComplete });
  } else {
    const isComplete = complete !== undefined ? !!complete : (
      fields.filter(f => f.required).every(f => sanitized[f.key] && sanitized[f.key].trim())
    );
    lead = await db.insert('leads', {
      id: uuid(),
      projectId: project.id,
      sessionId,
      data: sanitized,
      complete: isComplete,
      createdAt: Date.now(),
    });
  }

  // Best-effort: a captured email may unlock a durable learner_key for
  // quiz/flashcard activity already logged earlier in this same session.
  backfillLearnerKey(project.id, sessionId).catch(err =>
    logger.warn({ err: err.message }, 'learner_key backfill failed'));

  res.json({ lead: { id: lead.id, complete: lead.complete } });
});

module.exports = router;
