const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeFigures } = require('./figures');

function fig(id, overrides = {}) {
  return { id, fileId: 'file-1', pageNumber: 1, imagePath: `/x/${id}.png`, caption: `caption ${id}`, ...overrides };
}

test('mergeFigures ranks direct matches above co-located ones', () => {
  const direct = [{ figure: fig('a'), score: 0.9 }];
  const pageImageCache = new Map([['file-1:2', [fig('b')]]]);
  const hits = [{ chunk: { fileId: 'file-1', pageHint: 2 }, score: 0.99 }];

  const result = mergeFigures({ directHits: direct, pageImageCache, hits, threshold: 0.5, cap: 10 });
  assert.deepEqual(result.map(f => f.id), ['a', 'b']);
});

test('mergeFigures drops direct matches below the threshold', () => {
  const direct = [{ figure: fig('a'), score: 0.2 }];
  const result = mergeFigures({ directHits: direct, pageImageCache: new Map(), hits: [], threshold: 0.5, cap: 10 });
  assert.deepEqual(result, []);
});

test('mergeFigures dedupes a figure that is both a direct match and co-located', () => {
  const direct = [{ figure: fig('a'), score: 0.9 }];
  const pageImageCache = new Map([['file-1:1', [fig('a')]]]);
  const hits = [{ chunk: { fileId: 'file-1', pageHint: 1 }, score: 0.99 }];

  const result = mergeFigures({ directHits: direct, pageImageCache, hits, threshold: 0.5, cap: 10 });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'a');
});

test('mergeFigures includes all co-located figures for a matched page, not just one', () => {
  const pageImageCache = new Map([['file-1:1', [fig('a'), fig('b'), fig('c')]]]);
  const hits = [{ chunk: { fileId: 'file-1', pageHint: 1 }, score: 0.8 }];

  const result = mergeFigures({ directHits: [], pageImageCache, hits, threshold: 0.5, cap: 10 });
  assert.deepEqual(new Set(result.map(f => f.id)), new Set(['a', 'b', 'c']));
});

test('mergeFigures caps the total number of results', () => {
  const pageImageCache = new Map([['file-1:1', [fig('a'), fig('b'), fig('c')]]]);
  const hits = [{ chunk: { fileId: 'file-1', pageHint: 1 }, score: 0.8 }];

  const result = mergeFigures({ directHits: [], pageImageCache, hits, threshold: 0.5, cap: 2 });
  assert.equal(result.length, 2);
});

test('mergeFigures returns an empty array when nothing matches', () => {
  const result = mergeFigures({ directHits: [], pageImageCache: new Map(), hits: [], threshold: 0.5, cap: 10 });
  assert.deepEqual(result, []);
});
