/**
 * Resolves the figures[] array returned to chat/retrieval callers, merging
 * two sources of relevant figures:
 *
 *   1. Direct caption match — the query embedding searched directly against
 *      figure caption embeddings (searchFigures in vector.js). This is what
 *      lets "show me the alternator" find the alternator crop specifically,
 *      even among several figures on the same page.
 *   2. Page co-location — every figure on the page of a retrieved text
 *      chunk (the pre-existing behavior, generalized to multiple figures
 *      per page instead of at most one).
 *
 * Used by both POST /embed/:publicId/retrieve and POST /embed/:publicId/study
 * so the merge logic isn't duplicated across routes.
 */
const { searchFigures } = require('./vector');
const db = require('../db');

const FIGURE_MATCH_THRESHOLD = parseFloat(process.env.FIGURE_MATCH_THRESHOLD || '0.5');
const MAX_FIGURES_PER_ANSWER = parseInt(process.env.MAX_FIGURES_PER_ANSWER || '4', 10);

/**
 * Pure merge/dedupe/rank step, split out from resolveFigures so it can be
 * unit-tested without a database.
 *
 * @param {Array<{figure: object, score: number}>} directHits - searchFigures() results
 * @param {Map<string, object[]>} pageImageCache - "fileId:pageNumber" -> figure rows
 * @param {Array<{chunk: {fileId, pageHint}, score: number}>} hits - searchProject() results
 * @param {number} threshold - minimum score for a direct hit to count
 * @param {number} cap - maximum number of figures to return
 * @returns {object[]} figure rows, direct matches first, then by score, deduped by id
 */
function mergeFigures({ directHits, pageImageCache, hits, threshold, cap }) {
  const byId = new Map();

  for (const { figure, score } of directHits) {
    if (score < threshold) continue;
    byId.set(figure.id, { figure, score, direct: true });
  }

  for (const hit of hits) {
    const key = `${hit.chunk.fileId}:${hit.chunk.pageHint}`;
    const coLocated = pageImageCache.get(key) || [];
    for (const figure of coLocated) {
      if (!byId.has(figure.id)) byId.set(figure.id, { figure, score: hit.score, direct: false });
    }
  }

  return [...byId.values()]
    .sort((a, b) => (b.direct - a.direct) || (b.score - a.score))
    .slice(0, cap)
    .map(v => v.figure);
}

/**
 * Runs the direct figure search and merges it with the caller's already-
 * computed page co-location cache, returning API-shaped figure objects.
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {number[]} args.queryEmbedding
 * @param {Array<{chunk: {fileId, pageHint}, score: number}>} args.hits - searchProject() results
 * @param {Map<string, object[]>} args.pageImageCache - from pageImagesForHits()
 * @param {string} args.publicId - project's public id, for building URLs
 * @param {Map<string, object>} args.fileCache - fileId -> file row, from filesForHits().
 *   fileCache may be missing entries for figures that only matched via direct caption
 *   search (not co-located with any hit's file) — those are fetched and added here
 *   before building the response.
 */
async function resolveFigures({ projectId, queryEmbedding, hits, pageImageCache, publicId, fileCache }) {
  const directHits = await searchFigures(projectId, queryEmbedding, MAX_FIGURES_PER_ANSWER);
  const merged = mergeFigures({ directHits, pageImageCache, hits, threshold: FIGURE_MATCH_THRESHOLD, cap: MAX_FIGURES_PER_ANSWER });

  const missingFileIds = [...new Set(merged.map(f => f.fileId).filter(id => id && !fileCache.has(id)))];
  if (missingFileIds.length) {
    const rows = await db.query('SELECT * FROM files WHERE id = ANY($1::uuid[])', [missingFileIds]);
    for (const row of rows) fileCache.set(row.id, row);
  }

  return merged.map(figure => {
    const file = fileCache.get(figure.fileId);
    return {
      pageImageUrl: `/embed/${publicId}/page-image/${figure.id}`,
      caption: figure.caption,
      fileName: file ? file.originalName : null,
      pdfUrl: file && file.kind === 'pdf' ? `/embed/${publicId}/file/${file.id}` : null,
      pdfPage: figure.pageNumber,
    };
  });
}

module.exports = { resolveFigures, mergeFigures, FIGURE_MATCH_THRESHOLD, MAX_FIGURES_PER_ANSWER };
