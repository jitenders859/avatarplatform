const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isValidRiveBinary } = require('./riveValidation');

test('isValidRiveBinary accepts a buffer starting with the RIVE magic bytes', () => {
  assert.equal(isValidRiveBinary(Buffer.from('RIVE\x07\x00\x91\xe3', 'binary')), true);
});

test('isValidRiveBinary rejects other file types', () => {
  assert.equal(isValidRiveBinary(Buffer.from('%PDF-1.4')), false);
  assert.equal(isValidRiveBinary(Buffer.from('\x89PNG\r\n\x1a\n')), false);
});

test('isValidRiveBinary rejects empty or too-short buffers', () => {
  assert.equal(isValidRiveBinary(Buffer.alloc(0)), false);
  assert.equal(isValidRiveBinary(Buffer.from('RIV')), false);
});

test('isValidRiveBinary rejects non-buffer input', () => {
  assert.equal(isValidRiveBinary('RIVE...'), false);
  assert.equal(isValidRiveBinary(null), false);
  assert.equal(isValidRiveBinary(undefined), false);
});
