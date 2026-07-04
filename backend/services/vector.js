/**
 * Semantic search using pgvector's cosine distance operator (<=>).
 * Replaces the old in-memory cosine similarity calculation.
 */
const db = require('../db');

/**
 * Find the top-K most similar chunks within a project.
 * Returns [{ chunk, score }] sorted descending by cosine similarity.
 */
async function searchProject(projectId, queryEmbedding, k = 5) {
  const vectorStr = '[' + queryEmbedding.join(',') + ']';
  const rows = await db.query(
    `SELECT id, project_id, file_id, idx, text, heading, page_hint, char_count,
            approx_tokens, embedding_model, embedding_dim, created_at,
            1 - (embedding <=> $1::vector) AS score
     FROM chunks
     WHERE project_id = $2 AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorStr, projectId, k]
  );
  return rows.map(r => ({ chunk: r, score: typeof r.score === 'number' ? r.score : parseFloat(r.score) }));
}

module.exports = { searchProject };
