/**
 * explain_visually — the "explanation board" tool (a whiteboard-style
 * visual breakdown for complex/confusing topics, wired into the /study
 * tool-calling loop same as generate_quiz/generate_flashcards). Unlike
 * those two, its handler does no DB/embedding work — the model's own
 * function-call arguments ARE the content — so this only needs to check
 * validation/capping and tier gating, no stubbing required.
 *
 * check_availability / book_tour — the tour-booking tools (Task 7 of the
 * Google Calendar tour booking plan) — DO need db/googleCalendar stubbed,
 * since tourBookingTools is async and DB-backed (mirrors projectActionTools
 * below, not the static toolsForTier).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

let calendarConnections;
let removedConnectionIds;

function resetTourBookingStubs() {
  calendarConnections = [{ id: 'conn-1', projectId: 'proj-1', accessToken: 'at-1', accessTokenExpiresAt: Date.now() + 3600000, refreshToken: 'rt-1' }];
  removedConnectionIds = [];
}
resetTourBookingStubs();

stubFile('../db', {
  findOne: async (table, filter) => {
    if (table === 'calendarConnections') return calendarConnections.find(c => c.projectId === filter.projectId) || null;
    return null;
  },
  update: async () => {},
  remove: async (table, filter) => { removedConnectionIds.push(filter.id); },
});

let freeBusyImpl = async () => [];
let insertEventImpl = async () => ({ id: 'event-123', meetLink: null });
class StubGoogleAuthRevokedError extends Error {}
stubFile('../services/googleCalendar', {
  getValidAccessToken: async (connection) => {
    if (connection.refreshToken === 'revoked-rt') throw new StubGoogleAuthRevokedError('revoked');
    return connection.accessToken;
  },
  freeBusy: (...args) => freeBusyImpl(...args),
  insertEvent: (...args) => insertEventImpl(...args),
  GoogleAuthRevokedError: StubGoogleAuthRevokedError,
});

const { toolsForTier, tourBookingTools } = require('./tools');

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

const ADVANCED_PROJECT = {
  id: 'proj-1', name: 'Acme Tours', capabilityTier: 'advanced',
  tourSettings: {
    enabled: true, durationMinutes: 30, bufferMinutes: 0, timezone: 'America/New_York', location: '123 Main St',
    workingHours: { mon: [{ start: '09:00', end: '10:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
  },
};

test('tourBookingTools returns no tools below advanced tier', async () => {
  resetTourBookingStubs();
  const basicProject = { ...ADVANCED_PROJECT, capabilityTier: 'medium' };
  const { declarations, dispatch } = await tourBookingTools(basicProject);
  assert.deepEqual(declarations, []);
  assert.deepEqual(dispatch, {});
});

test('tourBookingTools returns no tools when tourSettings.enabled is false', async () => {
  resetTourBookingStubs();
  const disabledProject = { ...ADVANCED_PROJECT, tourSettings: { ...ADVANCED_PROJECT.tourSettings, enabled: false } };
  const { declarations } = await tourBookingTools(disabledProject);
  assert.deepEqual(declarations, []);
});

test('tourBookingTools returns no tools when no calendar is connected', async () => {
  resetTourBookingStubs();
  calendarConnections = [];
  const { declarations } = await tourBookingTools(ADVANCED_PROJECT);
  assert.deepEqual(declarations, []);
});

test('tourBookingTools returns both tools when tier + settings + connection all check out', async () => {
  resetTourBookingStubs();
  const { declarations, dispatch } = await tourBookingTools(ADVANCED_PROJECT);
  assert.deepEqual(declarations.map(d => d.name).sort(), ['book_tour', 'check_availability']);
  assert.ok(dispatch.check_availability);
  assert.ok(dispatch.book_tour);
});

test('check_availability returns open slots minus busy periods', async () => {
  resetTourBookingStubs();
  freeBusyImpl = async () => [];
  const { dispatch } = await tourBookingTools(ADVANCED_PROJECT);
  const result = await dispatch.check_availability({ preferredDate: '2026-09-14', rangeDays: 1 }); // Monday
  assert.equal(result.slots.length, 2);
  assert.ok(result.slots[0].startTime);
  assert.ok(result.slots[0].label);
});

test('check_availability drops a slot Google reports as busy', async () => {
  resetTourBookingStubs();
  freeBusyImpl = async () => [{ start: '2026-09-14T13:00:00.000Z', end: '2026-09-14T13:30:00.000Z' }];
  const { dispatch } = await tourBookingTools(ADVANCED_PROJECT);
  const result = await dispatch.check_availability({ preferredDate: '2026-09-14', rangeDays: 1 });
  assert.equal(result.slots.length, 1);
});

test('check_availability clears the stale connection and returns an error when Google access was revoked', async () => {
  resetTourBookingStubs();
  calendarConnections[0].refreshToken = 'revoked-rt';
  const { dispatch } = await tourBookingTools(ADVANCED_PROJECT);
  const result = await dispatch.check_availability({ preferredDate: '2026-09-14' });
  assert.ok(result.error);
  assert.deepEqual(removedConnectionIds, ['conn-1']);
});

test('book_tour rejects a missing name or invalid email', async () => {
  resetTourBookingStubs();
  const { dispatch } = await tourBookingTools(ADVANCED_PROJECT);
  const noName = await dispatch.book_tour({ name: '', email: 'a@b.com', startTime: '2026-09-14T13:00:00.000Z' });
  assert.ok(noName.error);
  const badEmail = await dispatch.book_tour({ name: 'Jane', email: 'not-an-email', startTime: '2026-09-14T13:00:00.000Z' });
  assert.ok(badEmail.error);
});

test('book_tour rejects an unparseable startTime', async () => {
  resetTourBookingStubs();
  const { dispatch } = await tourBookingTools(ADVANCED_PROJECT);
  const result = await dispatch.book_tour({ name: 'Jane', email: 'jane@example.com', startTime: 'not-a-date' });
  assert.ok(result.error);
});

test('book_tour books when the slot is free and returns the Google Meet link', async () => {
  resetTourBookingStubs();
  freeBusyImpl = async () => [];
  insertEventImpl = async (token, evt) => {
    assert.equal(evt.attendeeEmail, 'jane@example.com');
    return { id: 'event-abc', meetLink: 'https://meet.google.com/abc-defg-hij' };
  };
  const { dispatch } = await tourBookingTools(ADVANCED_PROJECT);
  const result = await dispatch.book_tour({ name: 'Jane', email: 'jane@example.com', startTime: '2026-09-14T13:00:00.000Z' });
  assert.equal(result.booked, true);
  assert.equal(result.calendarEventId, 'event-abc');
  assert.equal(result.meetLink, 'https://meet.google.com/abc-defg-hij');
});

test('book_tour still succeeds with meetLink: null when Google does not return a conference link', async () => {
  resetTourBookingStubs();
  freeBusyImpl = async () => [];
  insertEventImpl = async () => ({ id: 'event-def', meetLink: null });
  const { dispatch } = await tourBookingTools(ADVANCED_PROJECT);
  const result = await dispatch.book_tour({ name: 'Jane', email: 'jane@example.com', startTime: '2026-09-14T13:00:00.000Z' });
  assert.equal(result.booked, true);
  assert.equal(result.meetLink, null);
});

test('book_tour refuses to double-book a slot Google now reports as busy', async () => {
  resetTourBookingStubs();
  freeBusyImpl = async () => [{ start: '2026-09-14T13:00:00.000Z', end: '2026-09-14T13:30:00.000Z' }];
  const { dispatch } = await tourBookingTools(ADVANCED_PROJECT);
  const result = await dispatch.book_tour({ name: 'Jane', email: 'jane@example.com', startTime: '2026-09-14T13:00:00.000Z' });
  assert.ok(result.error);
  assert.match(result.error, /booked by someone else/);
});

test('check_availability clears the stale connection when GoogleAuthRevokedError is thrown by freeBusy itself, not just by token refresh', async () => {
  resetTourBookingStubs();
  freeBusyImpl = async () => { throw new StubGoogleAuthRevokedError('revoked mid-call'); };
  const { dispatch } = await tourBookingTools(ADVANCED_PROJECT);
  const result = await dispatch.check_availability({ preferredDate: '2026-09-14' });
  assert.ok(result.error);
  assert.deepEqual(removedConnectionIds, ['conn-1']);
});

test('book_tour clears the stale connection when GoogleAuthRevokedError is thrown by insertEvent itself', async () => {
  resetTourBookingStubs();
  freeBusyImpl = async () => [];
  insertEventImpl = async () => { throw new StubGoogleAuthRevokedError('revoked mid-call'); };
  const { dispatch } = await tourBookingTools(ADVANCED_PROJECT);
  const result = await dispatch.book_tour({ name: 'Jane', email: 'jane@example.com', startTime: '2026-09-14T13:00:00.000Z' });
  assert.ok(result.error);
  assert.deepEqual(removedConnectionIds, ['conn-1']);
});

test('check_availability treats a calendar-invalid date (fails the round-trip check) the same as giving no date at all', async () => {
  resetTourBookingStubs();
  const { dispatch: withInvalidDate } = await tourBookingTools(ADVANCED_PROJECT);
  resetTourBookingStubs();
  const { dispatch: withNoDate } = await tourBookingTools(ADVANCED_PROJECT);
  // "2026-13-45" matches the YYYY-MM-DD shape but isn't a real calendar
  // date — Date.UTC would otherwise silently roll it into an unrelated
  // real date instead of being treated as "no preference given".
  const invalidResult = await withInvalidDate.check_availability({ preferredDate: '2026-13-45', rangeDays: 1 });
  const noDateResult = await withNoDate.check_availability({ rangeDays: 1 });
  assert.deepEqual(invalidResult, noDateResult);
});

test('check_availability clamps an out-of-range rangeDays to the 1-14 window', async () => {
  resetTourBookingStubs();
  const { dispatch: withHugeRange } = await tourBookingTools(ADVANCED_PROJECT);
  resetTourBookingStubs();
  const { dispatch: withClampedRange } = await tourBookingTools(ADVANCED_PROJECT);
  const hugeResult = await withHugeRange.check_availability({ preferredDate: '2026-09-14', rangeDays: 999 });
  const clampedResult = await withClampedRange.check_availability({ preferredDate: '2026-09-14', rangeDays: 14 });
  assert.deepEqual(hugeResult, clampedResult);
});
