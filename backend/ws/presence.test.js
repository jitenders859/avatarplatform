const { test } = require('node:test');
const assert = require('node:assert/strict');
const presence = require('./presence');

test('hasAvailability is false with no connections', () => {
  presence._reset();
  assert.equal(presence.hasAvailability('proj-1'), false);
});

test('adding a dashboard socket makes the project available', () => {
  presence._reset();
  const entry = { ws: { readyState: 1, OPEN: 1, send: () => {} }, userId: 'u1', userName: 'Sarah' };
  presence.addDashboardSocket('proj-1', entry);
  assert.equal(presence.hasAvailability('proj-1'), true);
});

test('removing the last socket makes the project unavailable again', () => {
  presence._reset();
  const entry = { ws: { readyState: 1, OPEN: 1, send: () => {} }, userId: 'u1', userName: 'Sarah' };
  presence.addDashboardSocket('proj-1', entry);
  presence.removeDashboardSocket('proj-1', entry);
  assert.equal(presence.hasAvailability('proj-1'), false);
});

test('removing one of two sockets keeps the project available', () => {
  presence._reset();
  const a = { ws: { readyState: 1, OPEN: 1, send: () => {} }, userId: 'u1', userName: 'Sarah' };
  const b = { ws: { readyState: 1, OPEN: 1, send: () => {} }, userId: 'u2', userName: 'Tom' };
  presence.addDashboardSocket('proj-1', a);
  presence.addDashboardSocket('proj-1', b);
  presence.removeDashboardSocket('proj-1', a);
  assert.equal(presence.hasAvailability('proj-1'), true);
});

test('broadcastToProject sends to every open socket for that project, not other projects', () => {
  presence._reset();
  const sent = [];
  const makeSocket = (id) => ({ readyState: 1, OPEN: 1, send: (msg) => sent.push({ id, msg }) });
  presence.addDashboardSocket('proj-1', { ws: makeSocket('a'), userId: 'u1', userName: 'Sarah' });
  presence.addDashboardSocket('proj-1', { ws: makeSocket('b'), userId: 'u2', userName: 'Tom' });
  presence.addDashboardSocket('proj-2', { ws: makeSocket('c'), userId: 'u3', userName: 'Ana' });
  presence.broadcastToProject('proj-1', { type: 'queue_update', pending: [] });
  assert.equal(sent.length, 2);
  assert.ok(sent.every(s => JSON.parse(s.msg).type === 'queue_update'));
});

test('broadcastToProject skips a socket that is not OPEN', () => {
  presence._reset();
  const sent = [];
  const openSocket = { readyState: 1, OPEN: 1, send: (msg) => sent.push(msg) };
  const closedSocket = { readyState: 3, OPEN: 1, send: (msg) => sent.push(msg) };
  presence.addDashboardSocket('proj-1', { ws: openSocket, userId: 'u1', userName: 'Sarah' });
  presence.addDashboardSocket('proj-1', { ws: closedSocket, userId: 'u2', userName: 'Tom' });
  presence.broadcastToProject('proj-1', { type: 'x' });
  assert.equal(sent.length, 1);
});

test('sendToUser delivers only to the matching userId within a project', () => {
  presence._reset();
  const sent = [];
  const makeSocket = (id) => ({ readyState: 1, OPEN: 1, send: (msg) => sent.push({ id, msg }) });
  presence.addDashboardSocket('proj-1', { ws: makeSocket('a'), userId: 'u1', userName: 'Sarah' });
  presence.addDashboardSocket('proj-1', { ws: makeSocket('b'), userId: 'u2', userName: 'Tom' });
  const delivered = presence.sendToUser('proj-1', 'u2', { type: 'chat', text: 'hi' });
  assert.equal(delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'b');
});

test('sendToUser returns false when that user has no connected socket', () => {
  presence._reset();
  const delivered = presence.sendToUser('proj-1', 'nobody', { type: 'chat', text: 'hi' });
  assert.equal(delivered, false);
});

test('broadcastToProject keeps delivering to other sockets when one throws synchronously', () => {
  presence._reset();
  const sent = [];
  const throwingSocket = { readyState: 1, OPEN: 1, send: () => { throw new Error('write failed'); } };
  const okSocket = { readyState: 1, OPEN: 1, send: (msg) => sent.push(msg) };
  presence.addDashboardSocket('proj-1', { ws: throwingSocket, userId: 'u1', userName: 'Sarah' });
  presence.addDashboardSocket('proj-1', { ws: okSocket, userId: 'u2', userName: 'Tom' });
  assert.doesNotThrow(() => presence.broadcastToProject('proj-1', { type: 'queue_update' }));
  assert.equal(sent.length, 1);
});

test('removeDashboardSocket on a never-registered project/entry is a safe no-op', () => {
  presence._reset();
  const entry = { ws: { readyState: 1, OPEN: 1, send: () => {} }, userId: 'u1', userName: 'Sarah' };
  assert.doesNotThrow(() => presence.removeDashboardSocket('proj-never-seen', entry));
  assert.equal(presence.hasAvailability('proj-never-seen'), false);
});

test('sendToUser delivers to every entry matching userId, not just the first (multi-tab)', () => {
  presence._reset();
  const sent = [];
  const makeSocket = (id) => ({ readyState: 1, OPEN: 1, send: (msg) => sent.push({ id, msg }) });
  presence.addDashboardSocket('proj-1', { ws: makeSocket('tab-a'), userId: 'u1', userName: 'Sarah' });
  presence.addDashboardSocket('proj-1', { ws: makeSocket('tab-b'), userId: 'u1', userName: 'Sarah' });
  const delivered = presence.sendToUser('proj-1', 'u1', { type: 'chat', text: 'hi' });
  assert.equal(delivered, true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(s => s.id).sort(), ['tab-a', 'tab-b']);
});
