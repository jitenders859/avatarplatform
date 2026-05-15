const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { classify } = require('../services/extract');
const { processFileAsync } = require('../services/process');
const { checkLimit } = require('../services/usage');

const router = express.Router();

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    // Per-project folder; created on the fly.
    const projectId = req.params.projectId;
    const dir = path.join(UPLOAD_ROOT, projectId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    // Preserve extension; uuid prefix prevents collisions.
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

/** Verify project ownership; attaches req.project. */
function ownsProject(req, res, next) {
  const p = db.findOne('projects', x => x.id === req.params.projectId && x.userId === req.user.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  req.project = p;
  next();
}

router.get('/projects/:projectId/files', authRequired, ownsProject, (req, res) => {
  const files = db.findAll('files', f => f.projectId === req.project.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(stripFile);
  res.json({ files });
});

router.post('/projects/:projectId/files',
  authRequired, ownsProject, upload.array('files', 20),
  async (req, res) => {
    const uploaded = req.files || [];
    if (uploaded.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    // Plan-limit checks
    const fileCheck = checkLimit(req.user.id, 'file', uploaded.length);
    if (!fileCheck.ok) {
      // Cleanup the upload bytes since we're rejecting
      for (const f of uploaded) fs.unlink(f.path, () => {});
      return res.status(402).json({ error: fileCheck.reason });
    }
    const totalMb = uploaded.reduce((s, f) => s + f.size, 0) / 1024 / 1024;
    const storageCheck = checkLimit(req.user.id, 'storageMb', totalMb);
    if (!storageCheck.ok) {
      for (const f of uploaded) fs.unlink(f.path, () => {});
      return res.status(402).json({ error: storageCheck.reason });
    }

    const created = [];
    for (const f of uploaded) {
      const kind = classify(f.originalname);
      if (kind === 'unknown') {
        // Reject silently — note in response so UI can show it.
        fs.unlink(f.path, () => {});
        created.push({ originalName: f.originalname, status: 'rejected', error: `Unsupported type: ${path.extname(f.originalname)}` });
        continue;
      }
      const record = {
        id: uuid(),
        projectId: req.project.id,
        userId: req.user.id,
        originalName: f.originalname,
        storedPath: f.path,
        size: f.size,
        mimeType: f.mimetype,
        kind,
        status: 'pending',
        chunkCount: 0,
        createdAt: Date.now(),
      };
      await db.insert('files', record);
      processFileAsync(record);
      created.push(stripFile(record));
    }
    res.json({ files: created });
  });

router.post('/projects/:projectId/files/:fileId/reprocess', authRequired, ownsProject, async (req, res) => {
  const file = db.findOne('files', f => f.id === req.params.fileId && f.projectId === req.project.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  await db.update('files', file.id, { status: 'pending', error: null });
  processFileAsync(file);
  res.json({ ok: true });
});

/**
 * POST /api/projects/:projectId/sources/url
 * Body: { url } or { urls: [...] }
 * Ingest one or more website URLs as knowledge sources.
 */
router.post('/projects/:projectId/sources/url', authRequired, ownsProject, async (req, res) => {
  const single = (req.body && req.body.url) ? [req.body.url] : null;
  const list = single || (Array.isArray(req.body && req.body.urls) ? req.body.urls : []);
  const urls = list.map(s => String(s || '').trim()).filter(Boolean);
  if (urls.length === 0) return res.status(400).json({ error: 'Provide a URL (or urls: [...])' });
  if (urls.length > 20) return res.status(400).json({ error: 'Max 20 URLs per request' });

  const urlCheck = checkLimit(req.user.id, 'urlSource', urls.length);
  if (!urlCheck.ok) return res.status(402).json({ error: urlCheck.reason });

  const created = [];
  for (const u of urls) {
    let parsed;
    try { parsed = new URL(u); } catch { created.push({ url: u, error: 'Invalid URL' }); continue; }
    if (!/^https?:$/.test(parsed.protocol)) {
      created.push({ url: u, error: 'Only http(s) URLs supported' });
      continue;
    }
    const record = {
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
    };
    await db.insert('files', record);
    processFileAsync(record);
    created.push(stripFile(record));
  }
  res.json({ sources: created });
});

router.delete('/projects/:projectId/files/:fileId', authRequired, ownsProject, async (req, res) => {
  const file = db.findOne('files', f => f.id === req.params.fileId && f.projectId === req.project.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  // Best-effort blob removal (only for actual file uploads, not URL sources)
  if (file.storedPath) fs.unlink(file.storedPath, () => {});
  await db.remove('files',  f => f.id === file.id);
  await db.remove('chunks', c => c.fileId === file.id);
  res.json({ ok: true });
});

/**
 * POST /api/projects/:projectId/reindex
 * Re-embed all chunks for every ready file in the project using the current
 * embedding model. Processes files sequentially (100 chunks per batch) to
 * avoid rate-limit bursts.
 */
router.post('/projects/:projectId/reindex', authRequired, ownsProject, async (req, res) => {
  const { processFile } = require('../services/process');
  const files = db.findAll('files', f => f.projectId === req.project.id && f.status === 'ready');
  if (files.length === 0) return res.json({ reindexed: 0, failed: 0 });

  let reindexed = 0;
  let failed = 0;

  for (const file of files) {
    try {
      await processFile(file);
      reindexed++;
    } catch (_) {
      failed++;
    }
  }

  res.json({ reindexed, failed });
});

/** Status check — lets the frontend poll without a full file-list reload. */
router.get('/projects/:projectId/files/:fileId/status', authRequired, ownsProject, (req, res) => {
  const file = db.findOne('files', f => f.id === req.params.fileId && f.projectId === req.project.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const chunkCount = db.findAll('chunks', c => c.fileId === file.id).length;
  res.json({ status: file.status, chunkCount, error: file.error || null });
});

/** Serve a file blob to the project owner (for previews in the dashboard). */
router.get('/projects/:projectId/files/:fileId/blob', authRequired, ownsProject, (req, res) => {
  const file = db.findOne('files', f => f.id === req.params.fileId && f.projectId === req.project.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!fs.existsSync(file.storedPath)) return res.status(410).json({ error: 'File blob missing' });
  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName)}"`);
  fs.createReadStream(file.storedPath).pipe(res);
});

function stripFile(f) {
  if (!f) return f;
  const { storedPath, extractedText, ...rest } = f;
  return rest;
}

module.exports = router;
