/**
 * Embedding service — wraps the Google Gemini embedding API.
 *
 * Model and dimensions are configurable via environment variables:
 *   EMBEDDING_MODEL       — default: gemini-embedding-2-preview
 *   EMBEDDING_DIMENSIONS  — default: 768 (3072 is the max)
 *
 * The platform-level GEMINI_API_KEY is used for all embedding calls.
 * Visitors do not call this service directly — the server proxies all RAG queries.
 */
const fetch = require('node-fetch');
const { LRUCache } = require('lru-cache');
const logger = require('../logger').child({ module: 'services/embed' });

const MODEL      = process.env.EMBEDDING_MODEL      || 'gemini-embedding-2-preview';
const OUTPUT_DIM = parseInt(process.env.EMBEDDING_DIMENSIONS || '768', 10);
const BASE       = 'https://generativelanguage.googleapis.com/v1beta';
const PLATFORM_KEY = process.env.GEMINI_API_KEY || '';

if (!PLATFORM_KEY) {
  logger.warn('GEMINI_API_KEY not set — embedding calls will fail until you set it');
}

// Query embedding cache — only caches RETRIEVAL_QUERY calls (the hot path).
// RETRIEVAL_DOCUMENT embeddings are skipped to avoid caching large ingestion payloads.
const embedCache = new LRUCache({ max: 2000, ttl: 5 * 60_000 });

/** Embed a single string. Returns an array of OUTPUT_DIM floats. */
async function embedOne(text, taskType = 'RETRIEVAL_DOCUMENT') {
  const cacheKey = taskType === 'RETRIEVAL_QUERY' ? `${taskType}:${text}` : null;
  if (cacheKey && embedCache.has(cacheKey)) return embedCache.get(cacheKey);

  const url = `${BASE}/models/${MODEL}:embedContent?key=${PLATFORM_KEY}`;
  const body = {
    model: `models/${MODEL}`,
    content: { parts: [{ text: String(text || '').slice(0, 8000) }] },
    taskType,
    outputDimensionality: OUTPUT_DIM,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Embedding API ${res.status} (model=${MODEL}): ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  const values = json.embedding && json.embedding.values;
  if (!Array.isArray(values)) throw new Error('Embedding response missing values');
  if (cacheKey) embedCache.set(cacheKey, values);
  return values;
}

/** Embed an array of strings. Uses batchEmbedContents in slices of 100. */
async function embedMany(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  const out = [];
  const BATCH = 100;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const url = `${BASE}/models/${MODEL}:batchEmbedContents?key=${PLATFORM_KEY}`;
    const body = {
      requests: slice.map(t => ({
        model: `models/${MODEL}`,
        content: { parts: [{ text: String(t || '').slice(0, 8000) }] },
        taskType,
        outputDimensionality: OUTPUT_DIM,
      })),
    };
    let attempt = 0;
    while (true) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const json = await res.json();
        for (const e of json.embeddings || []) out.push(e.values);
        break;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt++)));
        continue;
      }
      const txt = await res.text();
      throw new Error(`Batch embedding API ${res.status} (model=${MODEL}): ${txt.slice(0, 300)}`);
    }
  }
  return out;
}

module.exports = { embedOne, embedMany, MODEL, OUTPUT_DIM };
