/**
 * Google gemini-embedding-001 (3072-dim default, supports output_dimensionality).
 * text-embedding-004 was deprecated — this is the stable replacement.
 * We request 768 dims to match the stored vector width; cosine search in
 * vector.js already normalises both sides so no extra L2-norm is needed here.
 *
 * Endpoint:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=KEY
 *   POST .../models/gemini-embedding-001:batchEmbedContents?key=KEY
 *
 * The platform-level GEMINI_API_KEY is used here — visitor traffic does
 * not hit Google directly, so we don't expose any per-tenant key.
 */
const fetch = require('node-fetch');

const MODEL = 'gemini-embedding-001';
const OUTPUT_DIM = 768;
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PLATFORM_KEY = process.env.GEMINI_API_KEY || '';

if (!PLATFORM_KEY) {
  console.warn('[embed] GEMINI_API_KEY not set — embedding calls will fail until you set it.');
}

/** Embed a single string. Returns an array of OUTPUT_DIM floats. */
async function embedOne(text, taskType = 'RETRIEVAL_DOCUMENT') {
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
    throw new Error(`Embedding API ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  const values = json.embedding && json.embedding.values;
  if (!Array.isArray(values)) throw new Error('Embedding response missing values');
  return values;
}

/** Embed an array of strings. Uses batchEmbedContents in chunks of 100. */
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
      // Retry on 429/5xx with exponential backoff
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const wait = 500 * Math.pow(2, attempt++);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      const txt = await res.text();
      throw new Error(`Batch embedding API ${res.status}: ${txt.slice(0, 300)}`);
    }
  }
  return out;
}

module.exports = { embedOne, embedMany, MODEL };
