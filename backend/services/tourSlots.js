/**
 * Pure slot-computation for tour booking (see backend/services/tools.js's
 * check_availability tool). No DB or network access — takes tour_settings
 * and returns candidate local time windows as UTC instants, so it can be
 * unit-tested without mocking anything.
 *
 * Timezone conversion follows the same Intl.DateTimeFormat-based approach
 * as backend/services/hours.js (no date-library dependency), run in the
 * opposite direction: hours.js reads a UTC Date's wall-clock time in a
 * timezone; this computes the UTC instant FOR a given wall-clock time in a
 * timezone. The offset is resolved by formatting a same-instant guess back
 * into the target timezone and correcting for the difference. A single
 * correction pass evaluates the offset AT the (wrong) guess instant rather
 * than near the true target — on a DST transition day that guess can land
 * on the wrong side of the transition, silently producing a UTC instant
 * off by the DST delta for wall-clock times within roughly one offset-
 * magnitude of the transition (not just the literal gap/overlap hour).
 * zonedTimeToUtc runs a second pass, re-evaluating the offset near the
 * corrected instant, which resolves that — exact except for a wall-clock
 * time that falls inside the gap/overlap hour itself (which doesn't exist,
 * or exists twice, so there's no single correct instant to return anyway).
 */
const WEEKDAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MAX_SLOTS = 40;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function tzOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value;
  const asUTC = Date.UTC(
    Number(get('year')), Number(get('month')) - 1, Number(get('day')),
    Number(get('hour')), Number(get('minute')), Number(get('second'))
  );
  return (asUTC - date.getTime()) / 60000;
}

/** Converts a "HH:MM on YYYY-MM-DD, local to `timeZone`" wall-clock time to a UTC Date. */
function zonedTimeToUtc(dateStr, hhmm, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const firstPass = new Date(guess.getTime() - tzOffsetMinutes(guess, timeZone) * 60000);
  // Re-evaluate the offset near the corrected instant (rather than trusting
  // the one computed at `guess`) — see the file header comment for why this
  // second pass matters on a DST transition day.
  const offsetMinutes = tzOffsetMinutes(firstPass, timeZone);
  return new Date(guess.getTime() - offsetMinutes * 60000);
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function weekdayCodeOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAY_CODES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function addMinutesToHHMM(hhmm, minutesToAdd) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutesToAdd;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

function formatSlotLabel(startUTC, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(startUTC);
}

/**
 * @param {object} params
 * @param {object} params.tourSettings - { durationMinutes, bufferMinutes, timezone, workingHours }
 * @param {string} params.fromDate - "YYYY-MM-DD", first day to consider
 * @param {number} params.rangeDays - how many days forward (inclusive of fromDate) to consider
 * @param {Date} [params.now] - injected for testability; defaults to real now
 * @returns {Array<{startUTC: Date, endUTC: Date, label: string}>} sorted ascending
 */
function computeCandidateSlots({ tourSettings, fromDate, rangeDays, now = new Date() }) {
  const { durationMinutes, bufferMinutes = 0, timezone, workingHours = {} } = tourSettings;
  const step = durationMinutes + bufferMinutes;
  // Zod validation upstream (backend/middleware/validate.js) keeps
  // durationMinutes >= 5 in production, but this function is also callable
  // directly (e.g. from tests) — without this guard, a non-advancing step
  // combined with every candidate slot being in the past hangs forever,
  // since `cursor` never reaches `window.end` and MAX_SLOTS is never hit.
  if (step <= 0) return [];
  const slots = [];

  for (let i = 0; i < rangeDays && slots.length < MAX_SLOTS; i++) {
    const dateStr = addDays(fromDate, i);
    const windows = workingHours[weekdayCodeOf(dateStr)] || [];

    for (const window of windows) {
      let cursor = window.start;
      while (cursor < window.end && slots.length < MAX_SLOTS) {
        const cursorEnd = addMinutesToHHMM(cursor, durationMinutes);
        if (cursorEnd > window.end) break;

        const startUTC = zonedTimeToUtc(dateStr, cursor, timezone);
        const endUTC = zonedTimeToUtc(dateStr, cursorEnd, timezone);
        if (startUTC.getTime() > now.getTime()) {
          slots.push({ startUTC, endUTC, label: formatSlotLabel(startUTC, timezone) });
        }
        cursor = addMinutesToHHMM(cursor, step);
      }
    }
  }

  return slots.sort((a, b) => a.startUTC - b.startUTC);
}

/** Drops any candidate slot that overlaps a Google freebusy `busy` interval ({start, end} ISO strings). */
function subtractBusy(slots, busy) {
  const busyRanges = busy.map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
  return slots.filter(slot => !busyRanges.some(b => slot.startUTC < b.end && slot.endUTC > b.start));
}

module.exports = { computeCandidateSlots, subtractBusy, zonedTimeToUtc, formatSlotLabel };
