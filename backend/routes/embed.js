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
const { CHARACTERS } = require('./projects');
const { embedOne } = require('../services/embed');
const { searchProject } = require('../services/vector');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const { projectCache, invalidateProjectCache } = require('../cache');
const { validate, schemas } = require('../middleware/validate');
const logger = require('../logger').child({ module: 'embed' });
const router = express.Router();

const PUBLIC_API_KEY = process.env.PUBLIC_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';

async function findByPublicId(publicId) {
  if (projectCache.has(publicId)) return projectCache.get(publicId);
  const project = await db.findOne('projects', { publicId });
  if (project) projectCache.set(publicId, project);
  return project;
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

    res.json({
      project: {
        id: project.id,
        publicId: project.publicId,
        name: project.name,
        voice: project.voice,
        systemPrompt: project.systemPrompt,
        welcomeMessage: project.welcomeMessage,
        // Widget settings
        widgetPosition:        project.widgetPosition        || 'bottom-right',
        widgetStartOpen:       project.widgetStartOpen !== false ? !!project.widgetStartOpen : false,
        textDirection:         project.textDirection         || 'auto',
        themeColor:            project.themeColor            || '#7c6af5',
        showBranding:          project.showBranding          !== false,
        showSourceCards:       project.showSourceCards       !== false,
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
      apiKey: PUBLIC_API_KEY,
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

  const fileCache = new Map();
  const sources = [];
  const chunks = [];
  for (const hit of hits) {
    let file = fileCache.get(hit.chunk.fileId);
    if (!file) {
      file = await db.findOne('files', { id: hit.chunk.fileId });
      fileCache.set(hit.chunk.fileId, file);
    }
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

  res.json({ chunks, sources });
});

/**
 * GET /embed/:publicId/file/:fileId
 */
router.get('/:publicId/file/:fileId', async (req, res) => {
  try {
    const project = await findByPublicId(req.params.publicId);
    if (!project) return res.status(404).end();
    const file = await db.findOne('files', { id: req.params.fileId, projectId: project.id });
    if (!file) return res.status(404).end();
    if (file.kind !== 'image') return res.status(403).end();
    const fs = require('fs');
    if (!file.storedPath || !fs.existsSync(file.storedPath)) return res.status(410).end();
    res.setHeader('Content-Type', file.mimeType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(file.storedPath).pipe(res);
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

    const fileCache = new Map();
    const sources = [];
    const contextParts = [];

    for (const hit of hits) {
      let file = fileCache.get(hit.chunk.fileId);
      if (!file) {
        file = await db.findOne('files', { id: hit.chunk.fileId });
        fileCache.set(hit.chunk.fileId, file);
      }
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
      const model = genai.getGenerativeModel({ model: 'gemini-2.0-flash' });
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

  res.json({ lead: { id: lead.id, complete: lead.complete } });
});

module.exports = router;
