const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boxToPixelRect } = require('./pageImages');

test('boxToPixelRect converts a normal box to pixel coordinates', () => {
  const rect = boxToPixelRect([100, 200, 300, 400], 1000, 1000);
  assert.deepEqual(rect, { x: 200, y: 100, width: 200, height: 200 });
});

test('boxToPixelRect handles non-square pages', () => {
  const rect = boxToPixelRect([0, 0, 500, 1000], 800, 400);
  // ymin=0,xmin=0,ymax=500,xmax=1000 -> half height, full width
  assert.deepEqual(rect, { x: 0, y: 0, width: 800, height: 200 });
});

test('boxToPixelRect normalizes an inverted min/max box', () => {
  const inverted = boxToPixelRect([300, 400, 100, 200], 1000, 1000);
  const normal = boxToPixelRect([100, 200, 300, 400], 1000, 1000);
  assert.deepEqual(inverted, normal);
});

test('boxToPixelRect clamps out-of-range values to the page bounds', () => {
  const rect = boxToPixelRect([-50, -50, 1200, 1200], 1000, 1000);
  assert.deepEqual(rect, { x: 0, y: 0, width: 1000, height: 1000 });
});

test('boxToPixelRect returns null for a zero-size box', () => {
  assert.equal(boxToPixelRect([100, 100, 100, 500], 1000, 1000), null); // zero height
  assert.equal(boxToPixelRect([100, 100, 500, 100], 1000, 1000), null); // zero width
});

test('boxToPixelRect returns null for malformed input', () => {
  assert.equal(boxToPixelRect(null, 1000, 1000), null);
  assert.equal(boxToPixelRect([1, 2, 3], 1000, 1000), null); // wrong length
  assert.equal(boxToPixelRect([1, 2, 3, 'x'], 1000, 1000), null); // non-numeric
  assert.equal(boxToPixelRect([1, 2, 3, NaN], 1000, 1000), null); // non-finite
});
