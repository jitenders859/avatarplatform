/**
 * searchWeb() — query sanitization, empty-query short circuit, cache
 * hit/miss, and error shape on a failed provider call. Stubs node-fetch
 * and services/settings the same way usage.test.js stubs db.js: replace
 * the module's require.cache entry before requiring searchWeb fresh.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

function freshSearchWeb({ fetchImpl, apiKey = 'test-key' }) {
  delete require.cache[require.resolve('./searchWeb')];
  delete require.cache[require.resolve('node-fetch')];
  stubFile('node-fetch', fetchImpl);
  stubFile('./settings', { getSetting: async (key) => (key === 'SERPER_API_KEY' ? apiKey : '') });
  return require('./searchWeb');
}

test('searchWeb: empty/whitespace query short-circuits without calling fetch', async () => {
  let called = false;
  const { searchWeb } = freshSearchWeb({ fetchImpl: async () => { called = true; } });
  assert.deepEqual(await searchWeb('   '), []);
  assert.equal(called, false);
});

test('searchWeb: missing SERPER_API_KEY returns [] without throwing', async () => {
  const { searchWeb } = freshSearchWeb({ fetchImpl: async () => { throw new Error('should not be called'); }, apiKey: '' });
  assert.deepEqual(await searchWeb('latest node version'), []);
});

test('searchWeb: maps Serper organic results to {title,url,snippet,source}, capped at 5', async () => {
  const organic = Array.from({ length: 8 }, (_, i) => ({
    title: `Result ${i}`, link: `https://example${i}.com/page`, snippet: 'x'.repeat(300),
  }));
  const { searchWeb } = freshSearchWeb({
    fetchImpl: async () => ({ ok: true, json: async () => ({ organic }) }),
  });
  const results = await searchWeb('some query');
  assert.equal(results.length, 5);
  assert.equal(results[0].title, 'Result 0');
  assert.equal(results[0].url, 'https://example0.com/page');
  assert.equal(results[0].source, 'example0.com');
  assert.ok(results[0].snippet.length <= 220);
});

test('searchWeb: query is trimmed, newline-stripped, and length-capped before sending', async () => {
  let sentBody;
  const { searchWeb } = freshSearchWeb({
    fetchImpl: async (_url, opts) => { sentBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ organic: [] }) }; },
  });
  await searchWeb('  latest\nnode\nversion  ' + 'x'.repeat(400));
  assert.equal(sentBody.q.includes('\n'), false);
  assert.ok(sentBody.q.length <= 300);
});

test('searchWeb: non-ok provider response throws with status attached', async () => {
  const { searchWeb } = freshSearchWeb({
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
  });
  await assert.rejects(() => searchWeb('anything'), (err) => {
    assert.equal(err.status, 502);
    return true;
  });
});

test('searchWeb: identical query within TTL is served from cache (fetch called once)', async () => {
  let calls = 0;
  const { searchWeb } = freshSearchWeb({
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ organic: [{ title: 'A', link: 'https://a.com', snippet: 's' }] }) }; },
  });
  await searchWeb('same query', { language: 'en' });
  await searchWeb('Same Query', { language: 'en' }); // case-insensitive cache key
  assert.equal(calls, 1);
});
