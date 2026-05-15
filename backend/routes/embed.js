/**
 * Public-facing routes used by the embed iframe.
 *
 * No JWT required — these are reached by anonymous visitors on the
 * project owner's website. Rate-limited per IP+project to prevent abuse.
 *
 * SECURITY: We expose the platform's GEMINI_API_KEY to embed pages
 * because the SDK requires it client-side to open the Gemini Live
 * websocket. In production, restrict this key to the Generative
 * Language API and apply per-key quotas. A more locked-down design
 * would proxy the websocket through this server — that's a bigger
 * lift and out of scope for v1.
 */
const express = require('express');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { CHARACTERS } = require('./projects');
const { embedOne } = require('../services/embed');
const { searchProject } = require('../services/vector');

const router = express.Router();

const PUBLIC_API_KEY = process.env.PUBLIC_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';

// ── Rate limiter (in-memory, per IP+project) ──────────────────
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 30; // 30 requests / minute / IP / project
const buckets = new Map();

function rateLimit(key) {
  const now = Date.now();
  const bucket = buckets.get(key) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + RATE_WINDOW_MS; }
  bucket.count += 1;
  buckets.set(key, bucket);
  return bucket.count <= RATE_MAX;
}

// Periodically prune the rate-limit map to avoid unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.resetAt + RATE_WINDOW_MS) buckets.delete(k);
}, 5 * 60 * 1000).unref();

function findByPublicId(publicId) {
  return db.findOne('projects', p => p.publicId === publicId);
}

/**
 * GET /embed/:publicId/config
 * Returns everything the embed page needs to boot the SDK.
 */
router.get('/:publicId/config', (req, res) => {
  const project = findByPublicId(req.params.publicId);
  if (!project) return res.status(404).json({ error: 'Chatbot not found' });
  const character = CHARACTERS.find(c => c.id === project.characterId) || CHARACTERS[0];

  const captureFields = db.findAll('captureFields', f => f.projectId === project.id)
    .sort((a, b) => a.order - b.order);

  res.json({
    project: {
      id: project.id,
      publicId: project.publicId,
      name: project.name,
      voice: project.voice,
      systemPrompt: project.systemPrompt,
      welcomeMessage: project.welcomeMessage,
      // Widget settings
      widgetPosition: project.widgetPosition || 'bottom-right',
      widgetStartOpen: project.widgetStartOpen !== false ? !!project.widgetStartOpen : false,
      textDirection: project.textDirection || 'auto',
      themeColor: project.themeColor || '#7c6af5',
      showBranding: project.showBranding !== false,
      showSourceCards: project.showSourceCards !== false,
      widgetOffsetX: project.widgetOffsetX || 0,
      widgetOffsetY: project.widgetOffsetY || 0,
    },
    character: {
      id: character.id,
      name: character.name,
      rivePath: character.rivePath,
    },
    captureFields: captureFields.map(f => ({
      id: f.id,
      label: f.label,
      key: f.key,
      type: f.type,
      options: f.options,
      required: f.required,
      order: f.order,
    })),
    apiKey: PUBLIC_API_KEY, // see SECURITY note above
    model: 'gemini-3.1-flash-live-preview',
  });
});

/**
 * POST /embed/:publicId/retrieve
 * Body: { query: string, k?: number }
 * Returns top-K relevant chunks + their source files, so the embed
 * can (a) inject them into the SDK's knowledgeBase, (b) render
 * source-citation cards next to the AI answer.
 */
router.post('/:publicId/retrieve', async (req, res) => {
  const project = findByPublicId(req.params.publicId);
  if (!project) return res.status(404).json({ error: 'Chatbot not found' });

  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!rateLimit(`${ip}:${project.id}`)) {
    return res.status(429).json({ error: 'Too many requests, slow down' });
  }

  const { query, k = 5 } = req.body || {};
  if (!query || !String(query).trim()) return res.status(400).json({ error: 'Query required' });

  let queryEmbedding;
  try {
    queryEmbedding = await embedOne(String(query).slice(0, 1500), 'RETRIEVAL_QUERY');
  } catch (e) {
    console.error('[embed/retrieve] embed failed:', e.message);
    return res.status(502).json({ error: 'Embedding service unavailable' });
  }

  const hits = searchProject(project.id, queryEmbedding, Math.min(Math.max(1, k), 10));

  // Hydrate file metadata for source cards
  const fileCache = new Map();
  const sources = [];
  const chunks = [];
  for (const hit of hits) {
    let file = fileCache.get(hit.chunk.fileId);
    if (!file) {
      file = db.findOne('files', f => f.id === hit.chunk.fileId);
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
        // If the file is an image, expose a public preview URL
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
 * Serves an image (or other safe file types) for source-card previews.
 * Only image files are served; everything else returns 404 to avoid
 * making private docs publicly downloadable.
 */
router.get('/:publicId/file/:fileId', (req, res) => {
  const project = findByPublicId(req.params.publicId);
  if (!project) return res.status(404).end();
  const file = db.findOne('files', f => f.id === req.params.fileId && f.projectId === project.id);
  if (!file) return res.status(404).end();
  // Only expose images publicly. PDFs, audio, video stay private.
  if (file.kind !== 'image') return res.status(403).end();
  const fs = require('fs');
  if (!fs.existsSync(file.storedPath)) return res.status(410).end();
  res.setHeader('Content-Type', file.mimeType || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  fs.createReadStream(file.storedPath).pipe(res);
});

/**
 * POST /embed/:publicId/log
 * Body: { sessionId?, role: 'user'|'model', text: string }
 * Optional analytics hook — record transcript turns for the dashboard.
 */
router.post('/:publicId/log', async (req, res) => {
  const project = findByPublicId(req.params.publicId);
  if (!project) return res.status(404).json({ error: 'Chatbot not found' });

  const ip = req.ip || 'unknown';
  if (!rateLimit(`log:${ip}:${project.id}`)) return res.status(429).json({ error: 'Rate limit' });

  const { sessionId, role, text } = req.body || {};
  if (!role || !text) return res.status(400).json({ error: 'role and text required' });

  let sid = sessionId;
  if (!sid) {
    sid = uuid();
    await db.insert('sessions', {
      id: sid,
      projectId: project.id,
      ip,
      createdAt: Date.now(),
    });
  }
  await db.insert('messages', {
    id: uuid(),
    sessionId: sid,
    projectId: project.id,
    role,
    text: String(text).slice(0, 2000),
    createdAt: Date.now(),
  });

  // Track user-side messages against the project owner's plan quota.
  if (role === 'user') {
    try {
      const { trackMessage } = require('../services/usage');
      await trackMessage(project.userId);
    } catch (_) { /* best effort */ }

    // Fire outbound webhook (non-blocking, best effort).
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
          console.warn('[embed/webhook] delivery failed:', e.message);
        }
      });
    }
  }
  res.json({ sessionId: sid });
});

/**
 * GET /embed/:publicId/capture-fields
 * Public read of capture field definitions (label, key, type, options, required).
 * Used by the embed page to build the "your details" panel without exposing internal IDs.
 */
router.get('/:publicId/capture-fields', (req, res) => {
  const project = findByPublicId(req.params.publicId);
  if (!project) return res.status(404).json({ error: 'Chatbot not found' });

  const fields = db.findAll('captureFields', f => f.projectId === project.id)
    .sort((a, b) => a.order - b.order)
    .map(f => ({ id: f.id, label: f.label, key: f.key, type: f.type, options: f.options, required: f.required }));

  res.json({ fields });
});

/**
 * POST /embed/:publicId/lead
 * Body: { sessionId: string, data: { [key]: value }, complete?: boolean }
 * Upserts a lead record. Called by the embed page as the AI collects capture values.
 */
router.post('/:publicId/lead', async (req, res) => {
  const project = findByPublicId(req.params.publicId);
  if (!project) return res.status(404).json({ error: 'Chatbot not found' });

  const ip = req.ip || 'unknown';
  if (!rateLimit(`lead:${ip}:${project.id}`)) return res.status(429).json({ error: 'Rate limit' });

  const { sessionId, data, complete } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object required' });

  // Ensure session belongs to this project
  const session = db.findOne('sessions', s => s.id === sessionId && s.projectId === project.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const existing = db.findOne('leads', l => l.sessionId === sessionId && l.projectId === project.id);

  // Sanitize data: only allow keys that are defined capture fields
  const fields = db.findAll('captureFields', f => f.projectId === project.id);
  const allowedKeys = new Set(fields.map(f => f.key));
  const sanitized = {};
  for (const [k, v] of Object.entries(data)) {
    if (allowedKeys.has(k)) sanitized[k] = String(v).slice(0, 500);
  }

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
    lead = {
      id: uuid(),
      projectId: project.id,
      sessionId,
      data: sanitized,
      complete: isComplete,
      createdAt: Date.now(),
    };
    await db.insert('leads', lead);
  }

  res.json({ lead: { id: lead.id, complete: lead.complete } });
});

module.exports = router;
