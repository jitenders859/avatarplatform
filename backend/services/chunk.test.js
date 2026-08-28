const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chunkText, chunkPages } = require('./chunk');

test('empty/whitespace input produces no chunks', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
  assert.deepEqual(chunkText(null), []);
  assert.deepEqual(chunkText(undefined), []);
});

test('short text below minChunkSize is discarded', () => {
  assert.deepEqual(chunkText('too short', { minChunkSize: 100 }), []);
});

test('short text at or above minChunkSize becomes one chunk', () => {
  const text = 'x'.repeat(100);
  const chunks = chunkText(text, { minChunkSize: 100, chunkSize: 1200 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, text);
  assert.equal(chunks[0].idx, 0);
  assert.equal(chunks[0].pageHint, 1);
  assert.equal(chunks[0].charCount, 100);
  assert.equal(chunks[0].approxTokens, Math.ceil(100 / 4));
});

test('paragraphs under chunkSize are merged into one chunk', () => {
  const para = (n) => `Paragraph ${n}. `.repeat(10);
  const text = [para(1), para(2), para(3)].join('\n\n');
  const chunks = chunkText(text, { chunkSize: 1200, minChunkSize: 10 });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /Paragraph 1/);
  assert.match(chunks[0].text, /Paragraph 3/);
});

test('never cuts mid-word — every chunk boundary lands on whitespace', () => {
  // One giant paragraph with no natural sentence/comma breaks, forcing the
  // word-boundary fallback in splitOnSentences.
  const words = Array.from({ length: 500 }, (_, i) => `word${i}`);
  const text = words.join(' ');
  const chunks = chunkText(text, { chunkSize: 300, overlap: 0, minChunkSize: 1 });
  assert.ok(chunks.length > 1, 'expected the long paragraph to split into multiple chunks');
  for (const c of chunks) {
    // No chunk should contain a word fragment like "word4" glued to "5"
    // without a space/boundary between them — every token in the chunk
    // must be a complete "wordN" from the original list.
    for (const token of c.text.trim().split(/\s+/)) {
      assert.match(token, /^word\d+$/, `chunk contains a mid-word fragment: "${token}"`);
    }
  }
});

test('splits on sentence boundaries in preference to raw word boundaries', () => {
  const sentence = 'This is a complete sentence about the product. ';
  const text = sentence.repeat(30); // well over any reasonable chunkSize
  const chunks = chunkText(text, { chunkSize: 400, overlap: 0, minChunkSize: 1 });
  assert.ok(chunks.length > 1);
  // Every chunk (except possibly the last) should end at a sentence
  // boundary, not mid-sentence, since sentence splits are preferred.
  for (const c of chunks.slice(0, -1)) {
    assert.match(c.text.trim(), /\.$/, `chunk didn't end on a sentence boundary: "${c.text.slice(-40)}"`);
  }
});

test('markdown heading is attached to the following chunk, not emitted as its own chunk', () => {
  const text = '## Getting Started\n\n' + 'Body text about getting started. '.repeat(5);
  const chunks = chunkText(text, { minChunkSize: 10 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, 'Getting Started');
  assert.doesNotMatch(chunks[0].text, /^## Getting Started/);
});

test('a long ALL-CAPS line inside a large paragraph is NOT mistaken for a heading', () => {
  // Regression for the bug described in chunk.js's extractHeading comment:
  // PLAIN_HEAD_RE matching anywhere in a big paragraph used to discard the
  // whole paragraph as "heading-only". Gating on paragraph length fixes it.
  const text = 'IMPORTANT NOTICE ABOUT YOUR ACCOUNT\n' + 'Regular body content that follows. '.repeat(10);
  const chunks = chunkText(text, { minChunkSize: 10 });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /IMPORTANT NOTICE/);
  assert.match(chunks[0].text, /Regular body content/);
});

test('a short ALL-CAPS-only paragraph IS treated as a heading', () => {
  const text = 'REFUND POLICY\n\n' + 'Refunds are processed within 5 business days. '.repeat(4);
  const chunks = chunkText(text, { minChunkSize: 10 });
  assert.equal(chunks[0].heading, 'REFUND POLICY');
});

test('overlap carries the tail of the previous chunk into the next', () => {
  const para = (n) => `Section ${n} content. `.repeat(20);
  const text = [para(1), para(2)].join('\n\n');
  const noOverlap = chunkText(text, { chunkSize: 200, overlap: 0, minChunkSize: 1 });
  const withOverlap = chunkText(text, { chunkSize: 200, overlap: 50, minChunkSize: 1 });
  assert.ok(noOverlap.length > 1 && withOverlap.length > 1);
  // The second chunk with overlap should be longer than without, since it
  // now carries trailing text from chunk 1.
  assert.ok(withOverlap[1].text.length > noOverlap[1].text.length);
});

test('pageHint defaults to 1 and is stamped on every chunk from chunkText', () => {
  const text = 'Some page content. '.repeat(10);
  const chunks = chunkText(text, { minChunkSize: 10 });
  for (const c of chunks) assert.equal(c.pageHint, 1);
});

test('chunkPages stamps the real page number per page and keeps idx globally sequential', () => {
  const pages = [
    { pageNumber: 1, text: 'Page one content. '.repeat(10) },
    { pageNumber: 2, text: 'Page two content. '.repeat(10) },
    { pageNumber: 5, text: 'Page five content (pages can skip numbers). '.repeat(10) },
  ];
  const chunks = chunkPages(pages, { minChunkSize: 10, chunkSize: 1200 });
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map(c => c.pageHint), [1, 2, 5]);
  assert.deepEqual(chunks.map(c => c.idx), [0, 1, 2]);
});

test('chunkPages skips pages that produce no chunks without breaking idx sequencing', () => {
  const pages = [
    { pageNumber: 1, text: 'Real content here. '.repeat(10) },
    { pageNumber: 2, text: '' }, // empty page, e.g. a blank scanned sheet
    { pageNumber: 3, text: 'More real content. '.repeat(10) },
  ];
  const chunks = chunkPages(pages, { minChunkSize: 10 });
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map(c => c.pageHint), [1, 3]);
  assert.deepEqual(chunks.map(c => c.idx), [0, 1]);
});
