/**
 * In-memory cosine similarity over chunks belonging to a project.
 *
 * For a JSON-DB SaaS this scales fine to ~100k chunks per project.
 * If a project ever exceeds that, swap this for pgvector / Pinecone /
 * Qdrant — the call site (`searchProject`) is the only thing that
 * needs to change.
 */
const db = require('../db');

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s) || 1;
}

function cosine(a, b) {
  return dot(a, b) / (norm(a) * norm(b));
}

/**
 * Find the top-K most similar chunks within a project.
 * Returns [{ chunk, score }] sorted descending.
 */
function searchProject(projectId, queryEmbedding, k = 5) {
  const chunks = db.findAll('chunks', c => c.projectId === projectId && Array.isArray(c.embedding));
  if (chunks.length === 0) return [];
  const qNorm = norm(queryEmbedding);

  const scored = chunks.map(c => {
    const cn = c._cachedNorm || norm(c.embedding);
    // Compute similarity inline to avoid the cosine helper's redundant norm calls
    let s = 0;
    const n = Math.min(c.embedding.length, queryEmbedding.length);
    for (let i = 0; i < n; i++) s += c.embedding[i] * queryEmbedding[i];
    return { chunk: c, score: s / (cn * qNorm) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

module.exports = { searchProject, cosine };
