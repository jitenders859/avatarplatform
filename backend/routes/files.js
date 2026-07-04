const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { classify } = require('../services/extract');
const { processFileAsync, processFile: processFileSync } = require('../services/process');
const { checkLimit } = require('../services/usage');

const router = express.Router();

// Lazily get io so we don't create a circular import at module load time
function getIo() {
  try { return require('../server').io; } catch { return null; }
}

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOAD_ROOT, req.params.projectId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

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

router.post('/projects/:projectId/files',
  authRequired, ownsProject, upload.array('files', 20),
  async (req, res) => {
    const uploaded = req.files || [];
    if (uploaded.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const fileCheck = await checkLimit(req.user.id, 'file', uploaded.length);
    if (!fileCheck.ok) {
      for (const f of uploaded) fs.unlink(f.path, () => {});
      return res.status(402).json({ error: fileCheck.reason });
    }
    const totalMb = uploaded.reduce((s, f) => s + f.size, 0) / 1024 / 1024;
    const storageCheck = await checkLimit(req.user.id, 'storageMb', totalMb);
    if (!storageCheck.ok) {
      for (const f of uploaded) fs.unlink(f.path, () => {});
      return res.status(402).json({ error: storageCheck.reason });
    }

    const created = [];
    for (const f of uploaded) {
      const kind = classify(f.originalname);
      if (kind === 'unknown') {
        fs.unlink(f.path, () => {});
        created.push({ originalName: f.originalname, status: 'rejected', error: `Unsupported type: ${path.extname(f.originalname)}` });
        continue;
      }
      const record = await db.insert('files', {
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
      });
      processFileAsync(record, getIo(), req.user.id);
      created.push(stripFile(record));
    }
    res.json({ files: created });
  });

router.post('/projects/:projectId/files/:fileId/reprocess', authRequired, ownsProject, async (req, res) => {
  const file = await db.findOne('files', { id: req.params.fileId, projectId: req.project.id });
  if (!file) return res.status(404).json({ error: 'File not found' });
  await db.update('files', file.id, { status: 'pending', error: null });
  processFileAsync(file, getIo(), req.user.id);
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
    processFileAsync(record, getIo(), req.user.id);
    created.push(stripFile(record));
  }
  res.json({ sources: created });
});

router.delete('/projects/:projectId/files/:fileId', authRequired, ownsProject, async (req, res) => {
  const file = await db.findOne('files', { id: req.params.fileId, projectId: req.project.id });
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (file.storedPath) fs.unlink(file.storedPath, () => {});
  // FK CASCADE on chunks; explicit remove for file itself
  await db.remove('files', { id: file.id });
  res.json({ ok: true });
});

router.post('/projects/:projectId/reindex', authRequired, ownsProject, async (req, res) => {
  const files = await db.findAll('files', { projectId: req.project.id, status: 'ready' });
  if (files.length === 0) return res.json({ reindexed: 0, failed: 0 });

  let reindexed = 0;
  let failed = 0;
  for (const file of files) {
    try {
      await processFileSync(file, getIo(), req.user.id);
      reindexed++;
    } catch (_) {
      failed++;
    }
  }
  res.json({ reindexed, failed });
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
  res.json({ status: file.status, chunkCount: Number(countRow.count), error: file.error || null });
});

router.get('/projects/:projectId/files/:fileId/blob', authRequired, ownsProject, async (req, res) => {
  const file = await db.findOne('files', { id: req.params.fileId, projectId: req.project.id });
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!file.storedPath || !fs.existsSync(file.storedPath)) return res.status(410).json({ error: 'File blob missing' });
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
