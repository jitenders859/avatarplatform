/**
 * explain_visually — the "explanation board" tool (a whiteboard-style
 * visual breakdown for complex/confusing topics, wired into the /study
 * tool-calling loop same as generate_quiz/generate_flashcards). Unlike
 * those two, its handler does no DB/embedding work — the model's own
 * function-call arguments ARE the content — so this only needs to check
 * validation/capping and tier gating, no stubbing required.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toolsForTier } = require('./tools');

function getDispatch(tier) {
  const { dispatch } = toolsForTier(tier);
  return dispatch.explain_visually;
}

test('explain_visually is gated at medium tier and up', () => {
  assert.equal(toolsForTier('basic').dispatch.explain_visually, undefined);
  assert.ok(toolsForTier('medium').dispatch.explain_visually);
  assert.ok(toolsForTier('advanced').dispatch.explain_visually);
});

test('explain_visually: flow layout infers sequential edges when none are given', async () => {
  const handle = getDispatch('medium');
  const result = await handle({
    title: 'How Photosynthesis Works',
    layout: 'flow',
    nodes: [
      { id: 'a', label: 'Sunlight hits leaf' },
      { id: 'b', label: 'Chlorophyll absorbs light', detail: 'Converts light energy to chemical energy.' },
      { id: 'c', label: 'Glucose is produced' },
    ],
  });
  assert.equal(result.board.title, 'How Photosynthesis Works');
  assert.equal(result.board.layout, 'flow');
  assert.equal(result.board.nodes.length, 3);
  assert.deepEqual(result.board.edges, [
    { from: 'a', to: 'b', label: null },
    { from: 'b', to: 'c', label: null },
  ]);
});

test('explain_visually: map layout keeps explicit edges as given', async () => {
  const handle = getDispatch('medium');
  const result = await handle({
    title: 'Cell structure',
    layout: 'map',
    nodes: [
      { id: 'center', label: 'Cell' },
      { id: 'n1', label: 'Nucleus', detail: 'Holds DNA.' },
      { id: 'n2', label: 'Mitochondria', detail: 'Produces energy.' },
    ],
    edges: [
      { from: 'center', to: 'n1', label: 'contains' },
      { from: 'center', to: 'n2' },
    ],
  });
  assert.equal(result.board.layout, 'map');
  assert.deepEqual(result.board.edges, [
    { from: 'center', to: 'n1', label: 'contains' },
    { from: 'center', to: 'n2', label: null },
  ]);
});

test('explain_visually: rejects a call with no usable nodes', async () => {
  const handle = getDispatch('medium');
  const empty = await handle({ title: 'Nothing', layout: 'flow', nodes: [] });
  assert.ok(empty.error);

  // A node missing a label is dropped, not just passed through blank.
  const noLabel = await handle({ title: 'Nothing', layout: 'flow', nodes: [{ id: 'a' }] });
  assert.ok(noLabel.error);
});

test('explain_visually: caps node count, string lengths, and drops edges to unknown ids', async () => {
  const handle = getDispatch('medium');
  const manyNodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, label: 'x'.repeat(200) }));
  const result = await handle({
    title: 'y'.repeat(500),
    layout: 'map',
    nodes: manyNodes,
    edges: [{ from: 'n0', to: 'does-not-exist' }, { from: 'n0', to: 'n1' }],
  });
  assert.equal(result.board.nodes.length, 8, 'capped at 8 nodes');
  assert.ok(result.board.title.length <= 100);
  assert.ok(result.board.nodes.every(n => n.label.length <= 60));
  assert.deepEqual(result.board.edges, [{ from: 'n0', to: 'n1', label: null }], 'edge to an unknown id is dropped');
});

test('explain_visually: duplicate node ids are de-duplicated instead of colliding', async () => {
  const handle = getDispatch('medium');
  const result = await handle({
    title: 'Dup ids',
    layout: 'flow',
    nodes: [{ id: 'a', label: 'First' }, { id: 'a', label: 'Second' }],
  });
  const ids = result.board.nodes.map(n => n.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
});
