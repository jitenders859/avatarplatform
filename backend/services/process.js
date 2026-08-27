/**
 * Background processing pipeline for knowledge sources (files and URLs).
 *
 * Files:  extract → chunk → embed → persist
 * URLs:   fetch    → chunk → embed → persist
 *
 * Chunks are bulk-inserted with db.insertMany() (single transaction).
 * Each chunk stores heading, pageHint, charCount, approxTokens,
 * embeddingModel, and embeddingDim in addition to the vector.
 *
 * Progress is persisted to files.stage/files.pct (polled by the client via
 * GET .../status) rather than pushed over Socket.io — serverless functions
 * can't hold a persistent connection to push through.
 */
const { randomUUID: uuid } = require('crypto');
const db = require('../db');
const storage = require('./storage');
const { extractFile } = require('./extract');
const { fetchUrl } = require('./url');
const { chunkText, chunkPages } = require('./chunk');
const { embedMany, MODEL: EMBED_MODEL, OUTPUT_DIM: EMBED_DIM } = require('./embed');
const { processPdfPageImages } = require('./pageImages');
const { checkLimit, trackEmbeddingChars } = require('./usage');
const logger = require('../logger').child({ module: 'services/process' });

function setStage(fileId, stage, pct) {
  return db.update('files', fileId, { stage, pct }).catch(e =>
    logger.warn({ fileId, stage, err: e.message }, 'failed to persist progress'));
}

async function processFile(fileRecord) {
  const fileId = fileRecord.id;
  logger.info({ fileId, kind: fileRecord.kind, name: fileRecord.originalName }, 'processing start');
  await setStage(fileId, 'extracting', 10);

  try {
    await db.update('files', fileId, { status: 'processing', error: null });

    // 1. Extract or fetch content
    let extractedText;
    let pdfPages = null; // per-page text, PDFs only — enables accurate pageHint
    let metadata = {};
    let fileBuffer = null; // reused below for page-image extraction, avoids a second Storage download

    if (fileRecord.kind === 'url') {
      const result = await fetchUrl(fileRecord.sourceUrl);
      extractedText = result.text;
      metadata = {
        title: result.title,
        finalUrl: result.finalUrl,
        faviconUrl: result.faviconUrl,
        fetchedAt: result.fetchedAt,
      };
    } else {
      fileBuffer = await storage.downloadBuffer(fileRecord.storageKey);
      const { text, pages } = await extractFile(fileBuffer, fileRecord.originalName);
      extractedText = text;
      pdfPages = pages || null;
    }

    const cleaned = (extractedText || '').trim();
    if (!cleaned) throw new Error('Extraction returned empty text');

    const charCheck = await checkLimit(fileRecord.userId, 'embeddingChars', cleaned.length);
    if (!charCheck.ok) throw new Error(charCheck.reason);

    await db.update('files', fileId, {
      extractedText: cleaned.slice(0, 50000),
      ...metadata,
    });

    await setStage(fileId, 'chunking', 40);

    // 2. Chunk — per-page for PDFs (accurate pageHint), flat otherwise
    const chunkObjs = pdfPages && pdfPages.length
      ? chunkPages(pdfPages, { chunkSize: 1200, overlap: 150 })
      : chunkText(cleaned, { chunkSize: 1200, overlap: 150 });
    if (chunkObjs.length === 0) throw new Error('Chunking produced no segments');

    await setStage(fileId, 'embedding', 60);

    // 3. Embed
    const chunkTexts = chunkObjs.map(c => c.text);
    const embeddings = await embedMany(chunkTexts, 'RETRIEVAL_DOCUMENT');
    if (embeddings.length !== chunkObjs.length) {
      throw new Error(`Embedding count mismatch: ${embeddings.length} vs ${chunkObjs.length}`);
    }

    await setStage(fileId, 'saving', 85);

    // 4. Persist — replace prior chunks, bulk-insert new ones
    await db.remove('chunks', { fileId });
    const chunkRows = chunkObjs.map((c, i) => ({
      id:             uuid(),
      projectId:      fileRecord.projectId,
      fileId,
      idx:            c.idx,
      text:           c.text,
      heading:        c.heading  || null,
      pageHint:       c.pageHint || null,
      charCount:      c.charCount,
      approxTokens:   c.approxTokens,
      embeddingModel: EMBED_MODEL,
      embeddingDim:   EMBED_DIM,
      embedding:      embeddings[i],  // array of numbers → pgvector string in db.js
      createdAt:      Date.now(),
    }));
    await db.insertMany('chunks', chunkRows);

    // Track usage
    try {
      await trackEmbeddingChars(fileRecord.userId, cleaned.length);
    } catch (_) { /* best effort */ }

    await db.update('files', fileId, {
      status: 'ready',
      chunkCount: chunkObjs.length,
      processedAt: Date.now(),
    });

    await setStage(fileId, 'done', 100);
    logger.info({ fileId, chunks: chunkObjs.length, model: EMBED_MODEL }, 'processing done');

    // 5. Page images (diagrams/figures) — enhancement, not core RAG, so it
    // runs after the file is already marked 'ready' and never fails the
    // whole file if it errors. Medium/advanced tier only, PDFs only.
    if (pdfPages && pdfPages.length) {
      try {
        const project = await db.findOne('projects', { id: fileRecord.projectId });
        if (project && project.capabilityTier !== 'basic') {
          const created = await processPdfPageImages(fileBuffer, fileId, fileRecord.projectId, pdfPages.length);
          logger.info({ fileId, pageImages: created.size }, 'page image processing done');
        }
      } catch (e) {
        logger.warn({ fileId, err: e.message }, 'page image processing failed, file remains ready without it');
      }
    }
  } catch (err) {
    logger.error({ fileId, err: err.message }, 'processing failed');
    await setStage(fileId, 'failed', 0);
    await db.update('files', fileId, {
      status: 'failed',
      error: err.message || String(err),
    });
  }
}

module.exports = { processFile };
