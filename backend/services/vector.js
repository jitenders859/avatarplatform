/**
 * Semantic search using pgvector's cosine distance operator (<=>).
 * Replaces the old in-memory cosine similarity calculation.
 */
const db = require('../db');

// Retrieval had no relevance floor at all — top-K always returned exactly K
// rows regardless of how unrelated they were to the query, so an
// off-topic question against a narrow knowledge base still dragged in
// "closest" chunks and presented them as if authoritative (fed to the model
// as context, and shown to the visitor as source citations). This is a
// conservative floor, not a strict one: Gemini's RETRIEVAL_QUERY/
// RETRIEVAL_DOCUMENT cosine scores for genuinely related content commonly
// sit well above this, so it's aimed at cutting clearly-unrelated noise
// (near-zero/negative correlation) rather than second-guessing borderline
// matches. Tune via env without a redeploy if a project's content domain
// needs it looser/stricter.
const DEFAULT_MIN_SCORE = parseFloat(process.env.RAG_MIN_SCORE ?? '0.3');

/**
 * Find the top-K most similar chunks within a project.
 * Returns [{ chunk, score }] sorted descending by cosine similarity.
 * @param {object} [opts]
 * @param {number} [opts.minScore] - Drop rows below this cosine similarity (default: DEFAULT_MIN_SCORE / RAG_MIN_SCORE). Pass 0 or -1 to disable.
 */
async function searchProject(projectId, queryEmbedding, k = 5, opts = {}) {
  const vectorStr = '[' + queryEmbedding.join(',') + ']';
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const rows = await db.query(
    `SELECT id, project_id, file_id, idx, text, heading, page_hint, char_count,
            approx_tokens, embedding_model, embedding_dim, created_at,
            1 - (embedding <=> $1::vector) AS score
     FROM chunks
     WHERE project_id = $2 AND embedding IS NOT NULL
       AND 1 - (embedding <=> $1::vector) >= $4
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorStr, projectId, k, minScore]
  );
  return rows.map(r => ({ chunk: r, score: typeof r.score === 'number' ? r.score : parseFloat(r.score) }));
}

/**
 * Find the top-K page_images whose caption embedding is closest to the
 * query embedding, within a project. Used for direct figure-level matches
 * ("show me the alternator") independent of which text chunk matched —
 * see backend/services/figures.js for how this merges with page
 * co-location. Rows without an embedding (pre-existing whole-page
 * screenshots, or figures whose caption embedding failed) are excluded via
 * the IS NOT NULL filter, same pattern as searchProject's chunks.
 */
async function searchFigures(projectId, queryEmbedding, k = 4) {
  const vectorStr = '[' + queryEmbedding.join(',') + ']';
  const rows = await db.query(
    `SELECT id, project_id, file_id, page_number, image_path, caption,
            1 - (embedding <=> $1::vector) AS score
     FROM page_images
     WHERE project_id = $2 AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorStr, projectId, k]
  );
  return rows.map(r => ({ figure: r, score: typeof r.score === 'number' ? r.score : parseFloat(r.score) }));
}

module.exports = { searchProject, searchFigures };
