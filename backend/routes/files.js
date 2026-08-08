const express = require('express');
const path = require('path');
const { v4: uuid } = require('uuid');
const db = require('../db');
const storage = require('../services/storage');
const inngest = require('../inngest/client');
const { authRequired } = require('../middleware/auth');
const { classify } = require('../services/extract');
const { checkLimit } = require('../services/usage');

const router = express.Router();

function queueProcessing(fileId) {
  return inngest.send({ name: 'file/process', data: { fileId } });
}

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

router.get('/projects/:projectId/files', authRequired, ownsProject, async (req, res) => {
  const files = await db.findAll('files', { projectId: req.project.id }, { orderBy: 'createdAt', order: 'desc' });
  res.json({ files: files.map(stripFile) });
});

/**
 * POST /projects/:projectId/files/init
 *
 * Step 1 of the upload flow: run the same limit/type checks the old
 * multipart upload did, create a 'pending' file row per accepted file, and
 * return a Supabase Storage signed upload URL for each. The browser then
 * uploads bytes straight to Storage (see public/js/api.js), bypassing this
 * server entirely — required because Vercel serverless functions cap
 * request bodies at 4.5MB, well under this app's 100MB upload limit.
 */
router.post('/projects/:projectId/files/init', authRequired, ownsProject, async (req, res) => {
  const requested = Array.isArray(req.body?.files) ? req.body.files : [];
  if (requested.length === 0) return res.status(400).json({ error: 'No files requested' });
  if (requested.length > 20) return res.status(400).json({ error: 'Max 20 files per request' });

  const fileCheck = await checkLimit(req.user.id, 'file', requested.length);
  if (!fileCheck.ok) return res.status(402).json({ error: fileCheck.reason });

  const totalMb = requested.reduce((s, f) => s + (Number(f.size) || 0), 0) / 1024 / 1024;
  const storageCheck = await checkLimit(req.user.id, 'storageMb', totalMb);
  if (!storageCheck.ok) return res.status(402).json({ error: storageCheck.reason });

  const created = [];
  for (const f of requested) {
    const originalName = String(f.name || '').slice(0, 255);
    const kind = classify(originalName);
    if (kind === 'unknown') {
      created.push({ originalName, status: 'rejected', error: `Unsupported type: ${path.extname(originalName)}` });
      continue;
    }
    const fileId = uuid();
    const ext = path.extname(originalName);
    const storageKey = `${req.project.id}/${fileId}${ext}`;

    const record = await db.insert('files', {
      id: fileId,
      projectId: req.project.id,
      userId: req.user.id,
      originalName,
      storageKey,
      size: Number(f.size) || 0,
      mimeType: f.mimeType || null,
      kind,
      status: 'pending',
      chunkCount: 0,
      createdAt: Date.now(),
    });
    const { signedUrl, token } = await storage.createSignedUploadUrl(storageKey);
    created.push({ ...stripFile(record), uploadUrl: signedUrl, uploadToken: token, storageKey });
  }
  res.json({ files: created });
});

/**
 * POST /projects/:projectId/files/:fileId/complete
 *
 * Step 2: called once the browser's direct-to-Storage upload finishes.
 * Confirms the object actually landed in Storage (doesn't trust the client's
 * report alone), then queues background processing.
 */
router.post('/projects/:projectId/files/:fileId/complete', authRequired, ownsProject, async (req, res) => {
  const file = await db.findOne('files', { id: req.params.fileId, projectId: req.project.id });
  if (!file) return res.status(404).json({ error: 'File not found' });

  const exists = await storage.objectExists(file.storageKey);
  if (!exists) return res.status(400).json({ error: 'Upload did not complete — object not found in storage' });

  await queueProcessing(file.id);
  res.json({ ok: true });
});

router.post('/projects/:projectId/files/:fileId/reprocess', authRequired, ownsProject, async (req, res) => {
  const file = await db.findOne('files', { id: req.params.fileId, projectId: req.project.id });
  if (!file) return res.status(404).json({ error: 'File not found' });
  await db.update('files', file.id, { status: 'pending', error: null });
  await queueProcessing(file.id);
  res.json({ ok: true });
});

router.post('/projects/:projectId/sources/url', authRequired, ownsProject, async (req, res) => {
  const single = (req.body && req.body.url) ? [req.body.url] : null;
  const list = single || (Array.isArray(req.body && req.body.urls) ? req.body.urls : []);
  const urls = list.map(s => String(s || '').trim()).filter(Boolean);
  if (urls.length === 0) return res.status(400).json({ error: 'Provide a URL (or urls: [...])' });
  if (urls.length > 20) return res.status(400).json({ error: 'Max 20 URLs per request' });

  const urlCheck = await checkLimit(req.user.id, 'urlSource', urls.length);
  if (!urlCheck.ok) return res.status(402).json({ error: urlCheck.reason });

  const created = [];
  for (const u of urls) {
    let parsed;
    try { parsed = new URL(u); } catch { created.push({ url: u, error: 'Invalid URL' }); continue; }
    if (!/^https?:$/.test(parsed.protocol)) {
      created.push({ url: u, error: 'Only http(s) URLs supported' });
      continue;
    }
    const record = await db.insert('files', {
      id: uuid(),
      projectId: req.project.id,
      userId: req.user.id,
      originalName: parsed.hostname + parsed.pathname,
      sourceUrl: parsed.toString(),
      kind: 'url',
      size: 0,
      mimeType: 'text/html',
      status: 'pending',
      chunkCount: 0,
      createdAt: Date.now(),
    });
    await queueProcessing(record.id);
    created.push(stripFile(record));
  }
  res.json({ sources: created });
});

router.delete('/projects/:projectId/files/:fileId', authRequired, ownsProject, async (req, res) => {
  const file = await db.findOne('files', { id: req.params.fileId, projectId: req.project.id });
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (file.storageKey) await storage.removeObject(file.storageKey).catch(() => {});
  // FK CASCADE removes page_images DB rows, but not their crop files in Storage.
  await storage.removePrefix(`${req.params.projectId}/pages/${file.id}`).catch(() => {});
  // FK CASCADE on chunks; explicit remove for file itself
  await db.remove('files', { id: file.id });
  res.json({ ok: true });
});

router.post('/projects/:projectId/reindex', authRequired, ownsProject, async (req, res) => {
  const files = await db.findAll('files', { projectId: req.project.id, status: 'ready' });
  if (files.length === 0) return res.json({ queued: 0 });

  await Promise.all(files.map(f => {
    db.update('files', f.id, { status: 'pending', error: null });
    return queueProcessing(f.id);
  }));
  res.json({ queued: files.length });
});

router.get('/projects/:projectId/files/:fileId/chunks', authRequired, ownsProject, async (req, res) => {
  const file = await db.findOne('files', { id: req.params.fileId, projectId: req.project.id });
  if (!file) return res.status(404).json({ error: 'File not found' });

  const search = (req.query.search || '').trim();
  let chunks;
  if (search) {
    chunks = await db.query(
      `SELECT * FROM chunks WHERE file_id = $1 AND text ILIKE $2 ORDER BY idx ASC`,
      [file.id, `%${search}%`]
    );
  } else {
    chunks = await db.findAll('chunks', { fileId: file.id }, { orderBy: 'idx', order: 'asc' });
  }

  res.json({
    chunks: chunks.map(c => ({
      id:             c.id,
      idx:            c.idx,
      text:           c.text,
      heading:        c.heading      || null,
      pageHint:       c.pageHint     || null,
      charCount:      c.charCount    || c.text.length,
      approxTokens:   c.approxTokens || Math.ceil((c.text || '').length / 4),
      embeddingModel: c.embeddingModel || null,
      embeddingDim:   c.embeddingDim   || null,
      hasEmbedding:   c.embeddingDim != null,
      createdAt:      c.createdAt,
    })),
    total: chunks.length,
  });
});

router.delete('/projects/:projectId/files/:fileId/chunks/:chunkId', authRequired, ownsProject, async (req, res) => {
  const file = await db.findOne('files', { id: req.params.fileId, projectId: req.project.id });
  if (!file) return res.status(404).json({ error: 'File not found' });

  const chunk = await db.findOne('chunks', { id: req.params.chunkId, fileId: file.id });
  if (!chunk) return res.status(404).json({ error: 'Chunk not found' });

  await db.remove('chunks', { id: chunk.id });

  const countRow = await db.queryOne('SELECT COUNT(*) AS count FROM chunks WHERE file_id = $1', [file.id]);
  const remaining = Number(countRow.count);
  await db.update('files', file.id, { chunkCount: remaining });

  res.json({ ok: true, chunkCount: remaining });
});

router.get('/projects/:projectId/files/:fileId/status', authRequired, ownsProject, async (req, res) => {
  const file = await db.findOne('files', { id: req.params.fileId, projectId: req.project.id });
  if (!file) return res.status(404).json({ error: 'File not found' });
  const countRow = await db.queryOne('SELECT COUNT(*) AS count FROM chunks WHERE file_id = $1', [file.id]);
  res.json({
    status: file.status,
    stage: file.stage || null,
    pct: file.pct ?? null,
    chunkCount: Number(countRow.count),
    error: file.error || null,
  });
});

router.get('/projects/:projectId/files/:fileId/blob', authRequired, ownsProject, async (req, res) => {
  const file = await db.findOne('files', { id: req.params.fileId, projectId: req.project.id });
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!file.storageKey) return res.status(410).json({ error: 'File blob missing' });
  const url = await storage.getSignedDownloadUrl(file.storageKey);
  res.redirect(302, url);
});

function stripFile(f) {
  if (!f) return f;
  const { storageKey, extractedText, ...rest } = f;
  return rest;
}

module.exports = router;
