/**
 * embedMany() batches to 100 texts/request and, as of the P1-1 perf pass
 * in improvement-prompts.md, runs up to 5 batches concurrently instead of
 * one at a time. The concurrency change makes ordering easy to get wrong
 * (results must land back in input order even though batches resolve out
 * of order) — these tests pin that down with a stubbed node-fetch, plus
 * confirm the batch size and the existing 429 retry/backoff still work.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

test('embedMany preserves input order across concurrent batches resolving out of order', async () => {
  const calls = [];
  stubFile('node-fetch', async (url, opts) => {
    const body = JSON.parse(opts.body);
    const batchIndex = calls.length;
    calls.push(body.requests.map(r => r.content.parts[0].text));
    // Later-dispatched batches resolve first, to prove ordering doesn't
    // depend on completion order.
    const delayMs = (5 - batchIndex) * 5;
    await new Promise(r => setTimeout(r, delayMs));
    return {
      ok: true,
      json: async () => ({ embeddings: body.requests.map((_, i) => ({ values: [batchIndex, i] })) }),
    };
  });
  delete require.cache[require.resolve('./embed')];
  const { embedMany } = require('./embed');

  // 5 batches of 100 = 500 texts, all distinct so we can verify placement.
  const texts = Array.from({ length: 500 }, (_, i) => `text-${i}`);
  const result = await embedMany(texts);

  assert.equal(result.length, 500);
  assert.equal(calls.length, 5, 'expected 5 batches of 100 for 500 texts');
  for (const c of calls) assert.equal(c.length, 100);
  // result[i] came from batch floor(i/100), position i%100 — order intact.
  assert.deepEqual(result[0], [0, 0]);
  assert.deepEqual(result[250], [2, 50]);
  assert.deepEqual(result[499], [4, 99]);
});

test('embedMany retries a batch on 429 with backoff before succeeding', async () => {
  let attempts = 0;
  stubFile('node-fetch', async () => {
    attempts += 1;
    if (attempts < 3) return { ok: false, status: 429, text: async () => 'rate limited' };
    return { ok: true, json: async () => ({ embeddings: [{ values: [1, 2, 3] }] }) };
  });
  delete require.cache[require.resolve('./embed')];
  const { embedMany } = require('./embed');

  // Real backoff delays (500ms, 1000ms) — short enough to just let run.
  const result = await embedMany(['only one text']);

  assert.equal(attempts, 3);
  assert.deepEqual(result, [[1, 2, 3]]);
});

test('embedMany surfaces a non-retryable error', async () => {
  stubFile('node-fetch', async () => ({ ok: false, status: 400, text: async () => 'bad request' }));
  delete require.cache[require.resolve('./embed')];
  const { embedMany } = require('./embed');

  await assert.rejects(() => embedMany(['x']), /Batch embedding API 400/);
});
