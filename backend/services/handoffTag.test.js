const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HANDOFF_INSTRUCTION, extractHandoffTag } = require('./handoffTag');

test('extractHandoffTag strips the tag and reports it was present', () => {
  const { clean, requested } = extractHandoffTag('I\'m not sure about that.\n[[REQUEST_HUMAN]]');
  assert.equal(clean, 'I\'m not sure about that.');
  assert.equal(requested, true);
});

test('extractHandoffTag leaves normal text untouched when the tag is absent', () => {
  const { clean, requested } = extractHandoffTag('Here is the answer you asked for.');
  assert.equal(clean, 'Here is the answer you asked for.');
  assert.equal(requested, false);
});

test('extractHandoffTag handles the tag appearing mid-text, not just at the end', () => {
  const { clean, requested } = extractHandoffTag('Let me connect you. [[REQUEST_HUMAN]] One moment.');
  assert.equal(clean, 'Let me connect you. One moment.');
  assert.equal(requested, true);
});

test('HANDOFF_INSTRUCTION mentions the exact tag the extractor looks for', () => {
  assert.ok(HANDOFF_INSTRUCTION.includes('[[REQUEST_HUMAN]]'));
});
