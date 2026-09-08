const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeCandidateSlots, subtractBusy, zonedTimeToUtc, formatSlotLabel } = require('./tourSlots');

const BASE_SETTINGS = {
  durationMinutes: 30,
  bufferMinutes: 0,
  timezone: 'America/New_York',
  workingHours: {
    mon: [{ start: '09:00', end: '10:00' }],
    tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
  },
};

test('zonedTimeToUtc converts a local wall-clock time to the correct UTC instant (EDT, UTC-4)', () => {
  // 2026-09-14 is a Monday; America/New_York is on daylight time (EDT, UTC-4) in September.
  const utc = zonedTimeToUtc('2026-09-14', '09:00', 'America/New_York');
  assert.equal(utc.toISOString(), '2026-09-14T13:00:00.000Z');
});

test('zonedTimeToUtc converts correctly for a winter date (EST, UTC-5)', () => {
  const utc = zonedTimeToUtc('2026-01-12', '09:00', 'America/New_York');
  assert.equal(utc.toISOString(), '2026-01-12T14:00:00.000Z');
});

test('computeCandidateSlots generates one 30-minute slot for a 1-hour Monday window', () => {
  // 2026-09-14 is a Monday.
  const slots = computeCandidateSlots({
    tourSettings: BASE_SETTINGS,
    fromDate: '2026-09-14',
    rangeDays: 1,
    now: new Date('2026-09-01T00:00:00Z'),
  });
  assert.equal(slots.length, 2, 'a 60-minute window fits two consecutive 30-minute slots');
  assert.equal(slots[0].startUTC.toISOString(), '2026-09-14T13:00:00.000Z');
  assert.equal(slots[0].endUTC.toISOString(), '2026-09-14T13:30:00.000Z');
  assert.equal(slots[1].startUTC.toISOString(), '2026-09-14T13:30:00.000Z');
});

test('computeCandidateSlots honors bufferMinutes between slots', () => {
  const settings = { ...BASE_SETTINGS, bufferMinutes: 15 };
  const slots = computeCandidateSlots({
    tourSettings: settings,
    fromDate: '2026-09-14',
    rangeDays: 1,
    now: new Date('2026-09-01T00:00:00Z'),
  });
  // 09:00-09:30 fits; next start would be 09:45, ending 10:15 which is past
  // the 10:00 window close, so only one slot fits.
  assert.equal(slots.length, 1);
});

test('computeCandidateSlots skips days with no working-hours windows', () => {
  const slots = computeCandidateSlots({
    tourSettings: BASE_SETTINGS,
    fromDate: '2026-09-15', // Tuesday — empty windows in BASE_SETTINGS
    rangeDays: 1,
    now: new Date('2026-09-01T00:00:00Z'),
  });
  assert.equal(slots.length, 0);
});

test('computeCandidateSlots excludes slots that have already passed', () => {
  const slots = computeCandidateSlots({
    tourSettings: BASE_SETTINGS,
    fromDate: '2026-09-14',
    rangeDays: 1,
    now: new Date('2026-09-14T13:15:00Z'), // 9:15am ET — mid-way through the window
  });
  assert.equal(slots.length, 1, 'only the 9:30 slot is still in the future');
  assert.equal(slots[0].startUTC.toISOString(), '2026-09-14T13:30:00.000Z');
});

test('computeCandidateSlots searches forward across multiple days', () => {
  const settings = {
    ...BASE_SETTINGS,
    workingHours: { ...BASE_SETTINGS.workingHours, wed: [{ start: '09:00', end: '09:30' }] },
  };
  const slots = computeCandidateSlots({
    tourSettings: settings,
    fromDate: '2026-09-14', // Monday
    rangeDays: 3,           // through Wednesday
    now: new Date('2026-09-01T00:00:00Z'),
  });
  assert.equal(slots.length, 3, '2 Monday slots + 1 Wednesday slot');
});

test('subtractBusy drops slots that overlap a busy interval and keeps the rest', () => {
  const slots = computeCandidateSlots({
    tourSettings: BASE_SETTINGS,
    fromDate: '2026-09-14',
    rangeDays: 1,
    now: new Date('2026-09-01T00:00:00Z'),
  });
  const busy = [{ start: '2026-09-14T13:00:00.000Z', end: '2026-09-14T13:30:00.000Z' }];
  const open = subtractBusy(slots, busy);
  assert.equal(open.length, 1);
  assert.equal(open[0].startUTC.toISOString(), '2026-09-14T13:30:00.000Z');
});

test('formatSlotLabel renders a human-readable label in the target timezone', () => {
  const label = formatSlotLabel(new Date('2026-09-14T13:00:00.000Z'), 'America/New_York');
  assert.match(label, /Monday, Sep 14, 9:00\s*AM/);
});
