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
 * Optional io + userId params enable real-time progress events via Socket.io.
 */
const { v4: uuid } = require('uuid');
const db = require('../db');
const { extractFile } = require('./extract');
const { fetchUrl } = require('./url');
const { chunkText } = require('./chunk');
const { embedMany, MODEL: EMBED_MODEL, OUTPUT_DIM: EMBED_DIM } = require('./embed');
const logger = require('../logger').child({ module: 'services/process' });

function emit(io, userId, fileId, stage, pct) {
  if (io && userId) {
    io.to(`user:${userId}`).emit('file:progress', { fileId, stage, pct });
  }
}

async function processFile(fileRecord, io, userId) {
  const fileId = fileRecord.id;
  logger.info({ fileId, kind: fileRecord.kind, name: fileRecord.originalName }, 'processing start');
  emit(io, userId, fileId, 'extracting', 10);

  try {
    await db.update('files', fileId, { status: 'processing', error: null });

    // 1. Extract or fetch content
    let extractedText;
    let metadata = {};

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
      const { text } = await extractFile(fileRecord.storedPath, fileRecord.originalName);
      extractedText = text;
    }

    const cleaned = (extractedText || '').trim();
    if (!cleaned) throw new Error('Extraction returned empty text');

    await db.update('files', fileId, {
      extractedText: cleaned.slice(0, 50000),
      ...metadata,
    });

    emit(io, userId, fileId, 'chunking', 40);

    // 2. Chunk
    const chunkObjs = chunkText(cleaned, { chunkSize: 1200, overlap: 150 });
    if (chunkObjs.length === 0) throw new Error('Chunking produced no segments');

    emit(io, userId, fileId, 'embedding', 60);

    // 3. Embed
    const chunkTexts = chunkObjs.map(c => c.text);
    const embeddings = await embedMany(chunkTexts, 'RETRIEVAL_DOCUMENT');
    if (embeddings.length !== chunkObjs.length) {
      throw new Error(`Embedding count mismatch: ${embeddings.length} vs ${chunkObjs.length}`);
    }

    emit(io, userId, fileId, 'saving', 85);

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
      const { trackEmbeddingChars } = require('./usage');
      await trackEmbeddingChars(fileRecord.userId, cleaned.length);
    } catch (_) { /* best effort */ }

    await db.update('files', fileId, {
      status: 'ready',
      chunkCount: chunkObjs.length,
      processedAt: Date.now(),
    });

    emit(io, userId, fileId, 'done', 100);
    logger.info({ fileId, chunks: chunkObjs.length, model: EMBED_MODEL }, 'processing done');
  } catch (err) {
    logger.error({ fileId, err: err.message }, 'processing failed');
    emit(io, userId, fileId, 'failed', 0);
    await db.update('files', fileId, {
      status: 'failed',
      error: err.message || String(err),
    });
  }
}

function processFileAsync(fileRecord, io, userId) {
  setImmediate(() => { processFile(fileRecord, io, userId).catch(() => {}); });
}

module.exports = { processFile, processFileAsync };
