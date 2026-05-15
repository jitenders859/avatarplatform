/**
 * Background processing pipeline for knowledge sources (files and URLs).
 *
 * Files:  extract → chunk → embed → persist
 * URLs:   fetch    → chunk → embed → persist
 *
 * Both code paths write to the same `files` table and produce `chunks`
 * with embeddings — at retrieval time they're indistinguishable. The
 * file record's `kind` field carries the type ('pdf', 'url', 'image' …).
 */
const { v4: uuid } = require('uuid');
const db = require('../db');
const { extractFile } = require('./extract');
const { fetchUrl } = require('./url');
const { chunkText } = require('./chunk');
const { embedMany } = require('./embed');

async function processFile(fileRecord) {
  const fileId = fileRecord.id;
  console.log(`[process] start ${fileId} (${fileRecord.kind} — ${fileRecord.originalName})`);

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
      extractedText: cleaned.slice(0, 50000), // preview only; full text lives in chunks
      ...metadata,
    });

    // 2. Chunk
    const chunks = chunkText(cleaned, { chunkSize: 1200, overlap: 200 });
    if (chunks.length === 0) throw new Error('Chunking produced no segments');

    // 3. Embed
    const embeddings = await embedMany(chunks, 'RETRIEVAL_DOCUMENT');
    if (embeddings.length !== chunks.length) {
      throw new Error(`Embedding count mismatch: ${embeddings.length} vs ${chunks.length}`);
    }

    // 4. Persist chunks. Replace any prior chunks for this file (re-processing).
    await db.remove('chunks', c => c.fileId === fileId);
    const chunkRows = chunks.map((c, i) => ({
      id: uuid(),
      projectId: fileRecord.projectId,
      fileId,
      idx: i,
      text: c,
      embedding: embeddings[i],
      createdAt: Date.now(),
    }));
    const all = db.readTable('chunks');
    all.push(...chunkRows);
    await db.writeTable('chunks', all);

    // Track usage (embedding chars consumed this run)
    try {
      const { trackEmbeddingChars } = require('./usage');
      await trackEmbeddingChars(fileRecord.userId, cleaned.length);
    } catch (_) { /* usage tracking is best-effort */ }

    await db.update('files', fileId, {
      status: 'ready',
      chunkCount: chunks.length,
      processedAt: Date.now(),
    });
    console.log(`[process] done ${fileId}: ${chunks.length} chunks`);
  } catch (err) {
    console.error(`[process] failed ${fileId}:`, err.message);
    await db.update('files', fileId, {
      status: 'failed',
      error: err.message || String(err),
    });
  }
}

/** Fire-and-forget wrapper. Errors are swallowed and stored on the file record. */
function processFileAsync(fileRecord) {
  setImmediate(() => { processFile(fileRecord).catch(() => {}); });
}

module.exports = { processFile, processFileAsync };
