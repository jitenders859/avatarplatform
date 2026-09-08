# Google Calendar Tour Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a widget visitor book a tour with a project owner through the AI chat, checking the owner's real Google Calendar availability and creating a confirmed calendar event.

**Architecture:** A per-project Google OAuth connection (`calendar_connections` table) plus a `projects.tour_settings` JSONB config feed two new AI function-calling tools (`check_availability`, `book_tour`) wired into the existing `/embed/:publicId/study` tool loop, gated to the `advanced` capability tier. A hand-rolled REST client (`backend/services/googleCalendar.js`, following the precedent in `backend/services/oidc.js`) talks to Google's OAuth2 + Calendar v3 endpoints — no `googleapis` dependency. A dashboard "Tours" tab lets the owner connect their calendar and configure duration/timezone/buffer/location/working-hours.

**Tech Stack:** Node/Express, Postgres (Supabase), `jsonwebtoken` (OAuth `state` signing), built-in `fetch`, Zod validation, vanilla JS frontend (`public/project.html`).

**Reference:** `docs/superpowers/specs/2026-09-08-google-calendar-tour-booking-design.md`

---

## Task 1: Database schema

**Files:**
- Create: `supabase/migrations/2026-09-08_add_tour_booking.sql`
- Modify: `supabase/schema.sql` (append evolution block at end)
- Modify: `backend/db.js:76-78` (TABLE_MAP)

- [ ] **Step 1: Write the migration file**

```sql
-- ═══════════════════════════════════════════════════════════════════
-- Migration: Google Calendar tour booking.
--
-- Adds:
--   calendar_connections — one row per project, holding the OAuth tokens
--     for the project owner's connected Google Calendar (see
--     backend/services/googleCalendar.js, backend/routes/googleCalendarAuth.js).
--   projects.tour_settings — per-project booking config (duration,
--     timezone, buffer, location, weekly working hours) consumed by
--     backend/services/tourSlots.js and the check_availability/book_tour
--     AI tools in backend/services/tools.js.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. This file is a standalone, dated record, and can
-- also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-09-08_add_tour_booking.sql
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS calendar_connections (
  id                       UUID    PRIMARY KEY,
  project_id               UUID    NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  google_email             TEXT,
  refresh_token            TEXT    NOT NULL,
  access_token             TEXT,
  access_token_expires_at  BIGINT,
  created_at               BIGINT  NOT NULL,
  updated_at               BIGINT
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS tour_settings JSONB NOT NULL DEFAULT '{
  "enabled": false,
  "durationMinutes": 30,
  "timezone": "UTC",
  "bufferMinutes": 0,
  "location": "",
  "workingHours": {"mon":[],"tue":[],"wed":[],"thu":[],"fri":[],"sat":[],"sun":[]}
}'::jsonb;
```

- [ ] **Step 2: Append the same DDL to `supabase/schema.sql`**

Add at the end of the file, after the last evolution block:

```sql

-- ═══════════════════════════════════════════════════════════════════
-- Google Calendar tour booking (see
-- supabase/migrations/2026-09-08_add_tour_booking.sql and
-- backend/services/googleCalendar.js's header comment).
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS calendar_connections (
  id                       UUID    PRIMARY KEY,
  project_id               UUID    NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  google_email             TEXT,
  refresh_token            TEXT    NOT NULL,
  access_token             TEXT,
  access_token_expires_at  BIGINT,
  created_at               BIGINT  NOT NULL,
  updated_at               BIGINT
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS tour_settings JSONB NOT NULL DEFAULT '{
  "enabled": false,
  "durationMinutes": 30,
  "timezone": "UTC",
  "bufferMinutes": 0,
  "location": "",
  "workingHours": {"mon":[],"tue":[],"wed":[],"thu":[],"fri":[],"sat":[],"sun":[]}
}'::jsonb;
```

- [ ] **Step 3: Register the new table's camelCase↔snake_case mapping in `backend/db.js`**

`calendarConnections` is a multi-word table name — like `captureFields`/`quizQuestions` above it, it needs an explicit entry (`db.js`'s `camelToSnake` only runs on column names, not table names — an unmapped table name is used as-is, which would look for a literal `"calendarConnections"` table and fail).

In `backend/db.js`, find:

```js
const TABLE_MAP = {
  captureFields: 'capture_fields',
  quizQuestions: 'quiz_questions',
  quizAttempts: 'quiz_attempts',
  flashcardReviews: 'flashcard_reviews',
  videoResources: 'video_resources',
  pageImages: 'page_images',
  projectMembers: 'project_members',
  webhookDeliveries: 'webhook_deliveries',
  projectActions: 'project_actions',
  chatbotCategories: 'chatbot_categories',
  adminSettings: 'admin_settings',
};
```

Replace with:

```js
const TABLE_MAP = {
  captureFields: 'capture_fields',
  quizQuestions: 'quiz_questions',
  quizAttempts: 'quiz_attempts',
  flashcardReviews: 'flashcard_reviews',
  videoResources: 'video_resources',
  pageImages: 'page_images',
  projectMembers: 'project_members',
  webhookDeliveries: 'webhook_deliveries',
  projectActions: 'project_actions',
  chatbotCategories: 'chatbot_categories',
  adminSettings: 'admin_settings',
  calendarConnections: 'calendar_connections',
};
```

- [ ] **Step 4: Apply the migration to your database**

Run: `psql $DATABASE_URL -f supabase/migrations/2026-09-08_add_tour_booking.sql`
Expected: `CREATE TABLE` then `ALTER TABLE` printed, no errors. (If you don't have a reachable `DATABASE_URL` in this environment, note that and move on — later tasks' tests stub `db.js` and don't need a live database.)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-09-08_add_tour_booking.sql supabase/schema.sql backend/db.js
git commit -m "$(cat <<'EOF'
Add calendar_connections table and projects.tour_settings column

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Pure slot-computation logic (`tourSlots.js`)

No DB or network access — computes candidate local tour slots from `tour_settings` as UTC instants, and filters them against a Google freebusy response. Built test-first since every branch is a pure function of its inputs.

**Files:**
- Create: `backend/services/tourSlots.js`
- Create: `backend/services/tourSlots.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// backend/services/tourSlots.test.js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test backend/services/tourSlots.test.js`
Expected: FAIL — `Cannot find module './tourSlots'`

- [ ] **Step 3: Write the implementation**

```js
// backend/services/tourSlots.js
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
 * into the target timezone and correcting for the difference — one
 * correction pass, exact except for an instant that falls inside the gap or
 * overlap of a DST transition itself, a corner case not worth the added
 * complexity for a "pick a tour time" feature (matching hours.js's own
 * documented same-day-only limitation).
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
  const offsetMinutes = tzOffsetMinutes(guess, timeZone);
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test backend/services/tourSlots.test.js`
Expected: PASS — all 9 tests green

- [ ] **Step 5: Commit**

```bash
git add backend/services/tourSlots.js backend/services/tourSlots.test.js
git commit -m "$(cat <<'EOF'
Add pure tour-slot computation service

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Google Calendar REST client (`googleCalendar.js`)

Hand-rolled OAuth2 + Calendar v3 client via built-in `fetch`, following the precedent in `backend/services/oidc.js` (no `googleapis` dependency — see design doc). Tests mock `global.fetch`.

**Files:**
- Create: `backend/services/googleCalendar.js`
- Create: `backend/services/googleCalendar.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// backend/services/googleCalendar.test.js
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'http://localhost:8080/api/google-calendar/callback';

const {
  isConfigured, buildAuthorizationUrl, exchangeCode, getValidAccessToken,
  freeBusy, insertEvent, GoogleAuthRevokedError,
} = require('./googleCalendar');

let originalFetch;
let fetchCalls;
let fetchImpl;

beforeEach(() => {
  originalFetch = global.fetch;
  fetchCalls = [];
  fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchImpl(url, opts);
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

test('isConfigured is true when all three env vars are set', () => {
  assert.equal(isConfigured(), true);
});

test('isConfigured is false when a required env var is missing', () => {
  const saved = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  assert.equal(isConfigured(), false);
  process.env.GOOGLE_CLIENT_SECRET = saved;
});

test('buildAuthorizationUrl includes the fixed redirect URI, calendar.events scope, and state', () => {
  const url = new URL(buildAuthorizationUrl('my-state-token'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8080/api/google-calendar/callback');
  assert.match(url.searchParams.get('scope'), /calendar\.events/);
  assert.equal(url.searchParams.get('state'), 'my-state-token');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
});

test('exchangeCode posts to the token endpoint and returns tokens + email from id_token', () => {
  const idToken = 'header.' + Buffer.from(JSON.stringify({ email: 'owner@example.com' })).toString('base64url') + '.sig';
  fetchImpl = async () => ({
    ok: true,
    json: async () => ({ refresh_token: 'rt-1', access_token: 'at-1', expires_in: 3600, id_token: idToken }),
  });
  return exchangeCode('auth-code-123').then((result) => {
    assert.equal(result.refreshToken, 'rt-1');
    assert.equal(result.accessToken, 'at-1');
    assert.equal(result.googleEmail, 'owner@example.com');
    assert.ok(result.expiresAt > Date.now());
    assert.equal(fetchCalls[0].url, 'https://oauth2.googleapis.com/token');
    assert.match(fetchCalls[0].opts.body.toString(), /grant_type=authorization_code/);
  });
});

test('exchangeCode throws if Google does not return a refresh_token', async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ access_token: 'at-1', expires_in: 3600 }) });
  await assert.rejects(() => exchangeCode('auth-code-123'), /refresh token/);
});

test('getValidAccessToken returns the cached token when not expired', async () => {
  const connection = { id: 'conn-1', accessToken: 'cached-token', accessTokenExpiresAt: Date.now() + 60 * 60 * 1000, refreshToken: 'rt-1' };
  let updateCalled = false;
  const token = await getValidAccessToken(connection, async () => { updateCalled = true; });
  assert.equal(token, 'cached-token');
  assert.equal(updateCalled, false);
  assert.equal(fetchCalls.length, 0);
});

test('getValidAccessToken refreshes and persists when expired', async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ access_token: 'new-token', expires_in: 3600 }) });
  const connection = { id: 'conn-1', accessToken: 'old-token', accessTokenExpiresAt: Date.now() - 1000, refreshToken: 'rt-1' };
  let updatePatch = null;
  const token = await getValidAccessToken(connection, async (id, patch) => { updatePatch = { id, patch }; });
  assert.equal(token, 'new-token');
  assert.equal(updatePatch.id, 'conn-1');
  assert.equal(updatePatch.patch.accessToken, 'new-token');
});

test('getValidAccessToken throws GoogleAuthRevokedError on invalid_grant', async () => {
  fetchImpl = async () => ({ ok: false, json: async () => ({ error: 'invalid_grant' }) });
  const connection = { id: 'conn-1', accessToken: null, accessTokenExpiresAt: 0, refreshToken: 'revoked-rt' };
  await assert.rejects(
    () => getValidAccessToken(connection, async () => {}),
    GoogleAuthRevokedError
  );
});

test('freeBusy posts the time window and returns the primary calendar busy list', async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ calendars: { primary: { busy: [{ start: 'a', end: 'b' }] } } }) });
  const busy = await freeBusy('access-token', '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z');
  assert.deepEqual(busy, [{ start: 'a', end: 'b' }]);
  assert.equal(fetchCalls[0].url, 'https://www.googleapis.com/calendar/v3/freeBusy');
  assert.equal(fetchCalls[0].opts.headers.Authorization, 'Bearer access-token');
});

test('freeBusy returns an empty array when the calendar has no busy periods', async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ calendars: { primary: {} } }) });
  const busy = await freeBusy('access-token', '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z');
  assert.deepEqual(busy, []);
});

test('insertEvent posts the event and returns its id', async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ id: 'event-123' }) });
  const id = await insertEvent('access-token', {
    summary: 'Tour: Acme — Jane', description: 'desc', location: '123 Main St',
    startISO: '2026-09-14T13:00:00.000Z', endISO: '2026-09-14T13:30:00.000Z', attendeeEmail: 'jane@example.com',
  });
  assert.equal(id, 'event-123');
  assert.match(fetchCalls[0].url, /sendUpdates=all/);
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.attendees[0].email, 'jane@example.com');
});

test('insertEvent throws with Google\'s error message on failure', async () => {
  fetchImpl = async () => ({ ok: false, json: async () => ({ error: { message: 'Invalid attendee' } }) });
  await assert.rejects(
    () => insertEvent('access-token', { summary: 's', startISO: 'a', endISO: 'b', attendeeEmail: 'x@example.com' }),
    /Invalid attendee/
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test backend/services/googleCalendar.test.js`
Expected: FAIL — `Cannot find module './googleCalendar'`

- [ ] **Step 3: Write the implementation**

```js
// backend/services/googleCalendar.js
/**
 * Google Calendar integration for tour booking (see backend/services/
 * tools.js's check_availability/book_tour tools and backend/routes/
 * googleCalendarAuth.js).
 *
 * Hand-rolled REST client against Node's built-in fetch, not the
 * `googleapis` npm package — following the precedent set by
 * backend/services/oidc.js, which hand-rolls OAuth for the same reason: no
 * such library was already a dependency, and Google's OAuth2 + Calendar v3
 * API here is a handful of fixed, well-documented endpoints (no discovery
 * step needed), so the reasoning that justified hand-rolling OIDC applies
 * even more easily here.
 *
 * Scope requested is calendar.events only — this can create/read/delete
 * events it created, not read or modify the owner's other calendar data.
 */
const jwt = require('jsonwebtoken');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events openid email';
const EXPIRY_SKEW_MS = 60 * 1000;

class GoogleAuthRevokedError extends Error {}

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALENDAR_REDIRECT_URI);
}

function buildAuthorizationUrl(state) {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.GOOGLE_CALENDAR_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

// Google's token response includes a signed id_token JWT when 'openid'
// scope is requested. We only decode its payload (no signature check) — it
// came directly from Google's token endpoint over TLS in the same request
// as the tokens themselves, not from anything the caller supplied, so
// re-verifying its signature would guard against a threat that doesn't
// apply here.
function decodeEmailFromIdToken(idToken) {
  if (!idToken) return null;
  try {
    return jwt.decode(idToken)?.email || null;
  } catch (_) {
    return null;
  }
}

async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_CALENDAR_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) {
    throw new Error(body.error_description || body.error || 'Google did not return a refresh token — try disconnecting and reconnecting');
  }
  return {
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
    googleEmail: decodeEmailFromIdToken(body.id_token),
  };
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.error === 'invalid_grant') throw new GoogleAuthRevokedError('Google Calendar access was revoked');
    throw new Error(body.error_description || body.error || `Token refresh failed: HTTP ${res.status}`);
  }
  return { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
}

/**
 * Returns a usable access token, refreshing first if the cached one has
 * expired. `updateTokens(connectionId, patch)` persists a refreshed token
 * — injected by the caller rather than importing db.js here, to keep this
 * module's dependencies to just fetch + jwt, matching oidc.js's
 * minimal-surface style.
 */
async function getValidAccessToken(connection, updateTokens) {
  if (connection.accessToken && connection.accessTokenExpiresAt > Date.now() + EXPIRY_SKEW_MS) {
    return connection.accessToken;
  }
  const { accessToken, expiresAt } = await refreshAccessToken(connection.refreshToken);
  await updateTokens(connection.id, { accessToken, accessTokenExpiresAt: expiresAt });
  return accessToken;
}

async function freeBusy(accessToken, timeMinISO, timeMaxISO) {
  const res = await fetch(FREEBUSY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id: 'primary' }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `freebusy failed: HTTP ${res.status}`);
  return body.calendars?.primary?.busy || [];
}

async function insertEvent(accessToken, { summary, description, location, startISO, endISO, attendeeEmail }) {
  const res = await fetch(`${EVENTS_URL}?sendUpdates=all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      summary,
      description,
      location: location || undefined,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees: [{ email: attendeeEmail }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `event creation failed: HTTP ${res.status}`);
  return body.id;
}

module.exports = {
  isConfigured, buildAuthorizationUrl, exchangeCode, getValidAccessToken, freeBusy, insertEvent,
  GoogleAuthRevokedError,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test backend/services/googleCalendar.test.js`
Expected: PASS — all 13 tests green

- [ ] **Step 5: Commit**

```bash
git add backend/services/googleCalendar.js backend/services/googleCalendar.test.js
git commit -m "$(cat <<'EOF'
Add hand-rolled Google Calendar OAuth2 + REST client

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `tourSettings` validation schema

**Files:**
- Modify: `backend/middleware/validate.js` (add schema near `businessHours`, add to `patchProject`)
- Modify: `backend/middleware/validate.test.js`

- [ ] **Step 1: Check the existing test file's structure**

Run: `sed -n '1,30p' backend/middleware/validate.test.js` and skim a `businessHours`-adjacent test if one exists, so the new tests match the file's existing `describe`/`test` style before writing them.

- [ ] **Step 2: Write the failing tests**

Add to `backend/middleware/validate.test.js` (adjust the `require` path/style to match what Step 1 showed):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { schemas } = require('./validate');

test('patchProject: accepts a full valid tourSettings object', () => {
  const result = schemas.patchProject.safeParse({
    tourSettings: {
      enabled: true,
      durationMinutes: 30,
      timezone: 'America/New_York',
      bufferMinutes: 15,
      location: '123 Main St',
      workingHours: { mon: [{ start: '09:00', end: '17:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    },
  });
  assert.equal(result.success, true);
});

test('patchProject: rejects tourSettings with an inverted time window', () => {
  const result = schemas.patchProject.safeParse({
    tourSettings: {
      enabled: true, durationMinutes: 30, timezone: 'UTC', bufferMinutes: 0, location: '',
      workingHours: { mon: [{ start: '17:00', end: '09:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    },
  });
  assert.equal(result.success, false);
});

test('patchProject: rejects a malformed HH:MM time', () => {
  const result = schemas.patchProject.safeParse({
    tourSettings: {
      enabled: true, durationMinutes: 30, timezone: 'UTC', bufferMinutes: 0, location: '',
      workingHours: { mon: [{ start: '9am', end: '17:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    },
  });
  assert.equal(result.success, false);
});

test('patchProject: rejects durationMinutes outside 5-240', () => {
  const result = schemas.patchProject.safeParse({
    tourSettings: {
      enabled: true, durationMinutes: 500, timezone: 'UTC', bufferMinutes: 0, location: '',
      workingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    },
  });
  assert.equal(result.success, false);
});

test('patchProject: tourSettings is optional (omitting it is valid)', () => {
  const result = schemas.patchProject.safeParse({ name: 'Renamed bot' });
  assert.equal(result.success, true);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test backend/middleware/validate.test.js`
Expected: FAIL — tourSettings tests fail because `patchProject` currently strips unknown keys silently, so the "accepts" test fails (result.data.tourSettings would be undefined) and/or the "rejects" tests unexpectedly succeed (success: true) since there's no schema constraining the field yet. Confirm the new tests fail before proceeding.

- [ ] **Step 4: Add the `tourSettings` schema to `validate.js`**

In `backend/middleware/validate.js`, find the `businessHours` definition (around line 68-76):

```js
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const businessHours = z.object({
  enabled: z.boolean(),
  timezone: z.string().trim().min(1, 'timezone is required').max(100),
  days: z.array(z.enum(WEEKDAYS)).max(7),
  openTime: z.string().regex(HHMM_RE, 'openTime must be HH:MM'),
  closeTime: z.string().regex(HHMM_RE, 'closeTime must be HH:MM'),
}).nullable().optional();
```

Add immediately after it:

```js
// Per-weekday, multiple-windows-per-day working hours for tour booking
// (see backend/services/tourSlots.js) — richer than businessHours above
// (which is a single daily window applied across a set of days), since
// tour availability may genuinely differ day-to-day or have a midday gap.
const tourWindow = z.object({
  start: z.string().regex(HHMM_RE, 'start must be HH:MM'),
  end: z.string().regex(HHMM_RE, 'end must be HH:MM'),
}).refine(w => w.start < w.end, { message: 'start must be before end' });

const tourWorkingHours = z.object(
  Object.fromEntries(WEEKDAYS.map(day => [day, z.array(tourWindow).max(4)]))
);

const tourSettings = z.object({
  enabled: z.boolean(),
  durationMinutes: z.number().int().min(5).max(240),
  timezone: z.string().trim().min(1, 'timezone is required').max(100),
  bufferMinutes: z.number().int().min(0).max(120),
  location: z.string().trim().max(300).optional(),
  workingHours: tourWorkingHours,
}).nullable().optional();
```

- [ ] **Step 5: Add `tourSettings` to the `patchProject` allowlist**

In `backend/middleware/validate.js`, find (around line 195-207):

```js
    allowedDomains,
    businessHours,
    awayMessage,
    conversationStarters,
    fallbackMessage,
```

Replace with:

```js
    allowedDomains,
    businessHours,
    awayMessage,
    conversationStarters,
    fallbackMessage,
    tourSettings,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test backend/middleware/validate.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/middleware/validate.js backend/middleware/validate.test.js
git commit -m "$(cat <<'EOF'
Add tourSettings validation to patchProject

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Google Calendar connection routes

Three project-scoped, authenticated endpoints (`status`, `connect`, disconnect) plus one fixed-path, unauthenticated callback. The callback is fixed and NOT nested under `/:projectId` — Google's OAuth `redirect_uri` must be a single, exactly-registered URI (it cannot vary per project), so the project is identified from the signed `state` parameter instead, minted in `/connect` and verified in the callback. This mirrors `backend/routes/billing.js`'s split between its authenticated `router` and its separately-mounted, fixed-path `webhookHandler`.

**Files:**
- Create: `backend/routes/googleCalendarAuth.js`
- Create: `backend/routes/googleCalendarAuth.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// backend/routes/googleCalendarAuth.test.js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-do-not-use-in-prod';
process.env.GOOGLE_CLIENT_ID = 'client-id';
process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'http://localhost:8080/api/google-calendar/callback';

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

const OWNER = { id: 'owner-1', email: 'owner@example.com', suspended: false };
const PROJECT = { id: 'proj-1', userId: 'owner-1' };
let connections;

beforeEach(() => { connections = []; });

stubFile('../db', {
  findOne: async (table, filter) => {
    if (table === 'users') return filter.id === OWNER.id ? OWNER : null;
    if (table === 'projects') return (filter.id === PROJECT.id && filter.userId === OWNER.id) ? PROJECT : null;
    if (table === 'calendarConnections') return connections.find(c => c.projectId === filter.projectId) || null;
    return null;
  },
  insert: async (table, row) => { connections.push(row); return row; },
  update: async (table, id, patch) => {
    const c = connections.find(x => x.id === id);
    Object.assign(c, patch);
    return c;
  },
  remove: async (table, filter) => {
    const before = connections.length;
    connections = connections.filter(c => c.projectId !== filter.projectId);
    return before - connections.length;
  },
});

stubFile('../services/googleCalendar', {
  isConfigured: () => true,
  buildAuthorizationUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
  exchangeCode: async (code) => {
    if (code === 'bad-code') throw new Error('invalid_grant');
    return { refreshToken: 'rt-1', accessToken: 'at-1', expiresAt: Date.now() + 3600000, googleEmail: 'owner@example.com' };
  },
});

const router = require('./googleCalendarAuth');

function request(port, method, path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function makeServer() {
  const express = require('express');
  require('express-async-errors');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', router);
  const server = app.listen(0);
  return server;
}

function ownerToken() {
  return jwt.sign({ uid: OWNER.id }, process.env.JWT_SECRET);
}

test('GET /connect returns a Google auth URL for the project owner', async () => {
  const server = makeServer();
  const { port } = server.address();
  const res = await request(port, 'GET', `/api/projects/${PROJECT.id}/calendar/connect`, ownerToken());
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.match(body.url, /^https:\/\/accounts\.google\.com/);
  server.close();
});

test('GET /connect requires auth', async () => {
  const server = makeServer();
  const { port } = server.address();
  const res = await request(port, 'GET', `/api/projects/${PROJECT.id}/calendar/connect`);
  assert.equal(res.status, 401);
  server.close();
});

test('GET /connect 404s for a project the caller does not own', async () => {
  const server = makeServer();
  const { port } = server.address();
  const res = await request(port, 'GET', `/api/projects/not-my-project/calendar/connect`, ownerToken());
  assert.equal(res.status, 404);
  server.close();
});

test('GET /status reports connected:false with no connection, then true after one exists', async () => {
  const server = makeServer();
  const { port } = server.address();
  let res = await request(port, 'GET', `/api/projects/${PROJECT.id}/calendar/status`, ownerToken());
  assert.deepEqual(JSON.parse(res.body), { connected: false, googleEmail: null });

  connections.push({ id: 'conn-1', projectId: PROJECT.id, googleEmail: 'owner@example.com' });
  res = await request(port, 'GET', `/api/projects/${PROJECT.id}/calendar/status`, ownerToken());
  assert.deepEqual(JSON.parse(res.body), { connected: true, googleEmail: 'owner@example.com' });
  server.close();
});

test('DELETE / removes the connection', async () => {
  connections.push({ id: 'conn-1', projectId: PROJECT.id, googleEmail: 'owner@example.com' });
  const server = makeServer();
  const { port } = server.address();
  const res = await request(port, 'DELETE', `/api/projects/${PROJECT.id}/calendar`, ownerToken());
  assert.equal(res.status, 200);
  assert.equal(connections.length, 0);
  server.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test backend/routes/googleCalendarAuth.test.js`
Expected: FAIL — `Cannot find module './googleCalendarAuth'`

- [ ] **Step 3: Write the route implementation**

```js
// backend/routes/googleCalendarAuth.js
/**
 * Google Calendar OAuth connection for tour booking — see
 * docs/superpowers/specs/2026-09-08-google-calendar-tour-booking-design.md
 * and backend/services/googleCalendar.js.
 *
 * Exports { router, callbackHandler } — mirroring backend/routes/billing.js's
 * split between its authenticated router and a separately-mounted webhook
 * handler. `callbackHandler` must be mounted at a FIXED path (see
 * backend/server.js) matching GOOGLE_CALENDAR_REDIRECT_URI exactly — an
 * OAuth redirect_uri cannot vary per project, so unlike every other route
 * here it takes no :projectId in its path. Google redirects the visitor's
 * browser straight to it with no Authorization header available; it's
 * authenticated instead by the signed `state` JWT minted in /connect and
 * verified here, using this app's own JWT_SECRET.
 */
const express = require('express');
const { randomUUID: uuid } = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const googleCalendar = require('../services/googleCalendar');
const logger = require('../logger').child({ module: 'google-calendar-auth' });

const JWT_SECRET = process.env.JWT_SECRET;
const STATE_PURPOSE = 'gcal_connect';

const router = express.Router();

async function ownsProject(req, res, next) {
  const p = await db.findOne('projects', { id: req.params.projectId, userId: req.user.id });
  if (!p) return res.status(404).json({ error: 'Project not found' });
  req.project = p;
  next();
}

function buildState(projectId) {
  return jwt.sign({ pid: projectId, purpose: STATE_PURPOSE }, JWT_SECRET, { expiresIn: '10m' });
}

function verifyState(state) {
  const payload = jwt.verify(state, JWT_SECRET, { algorithms: ['HS256'] });
  if (payload.purpose !== STATE_PURPOSE || !payload.pid) throw new Error('Invalid state');
  return payload.pid;
}

router.get('/:projectId/calendar/status', authRequired, ownsProject, async (req, res) => {
  const connection = await db.findOne('calendarConnections', { projectId: req.project.id });
  res.json({ connected: !!connection, googleEmail: connection?.googleEmail || null });
});

router.get('/:projectId/calendar/connect', authRequired, ownsProject, (req, res) => {
  if (!googleCalendar.isConfigured()) {
    return res.status(503).json({ error: 'Google Calendar is not configured on this server' });
  }
  res.json({ url: googleCalendar.buildAuthorizationUrl(buildState(req.project.id)) });
});

router.delete('/:projectId/calendar', authRequired, ownsProject, async (req, res) => {
  await db.remove('calendarConnections', { projectId: req.project.id });
  res.json({ ok: true });
});

// Public — see file header. Always redirects back to the dashboard rather
// than returning raw JSON, since this is where the visitor's browser lands
// after leaving Google.
async function callbackHandler(req, res) {
  const { code, state, error } = req.query;
  let projectId = null;
  try {
    if (state) projectId = verifyState(String(state));
  } catch (e) {
    logger.warn({ err: e.message }, 'invalid calendar OAuth state');
  }

  const redirectBack = (status) =>
    res.redirect(`/project.html?id=${encodeURIComponent(projectId || '')}&tab=tours&calendar=${status}`);

  if (error || !code || !projectId) return redirectBack('error');

  try {
    const { refreshToken, accessToken, expiresAt, googleEmail } = await googleCalendar.exchangeCode(String(code));
    const existing = await db.findOne('calendarConnections', { projectId });
    const fields = { projectId, googleEmail, refreshToken, accessToken, accessTokenExpiresAt: expiresAt };
    if (existing) {
      await db.update('calendarConnections', existing.id, fields);
    } else {
      await db.insert('calendarConnections', { id: uuid(), ...fields, createdAt: Date.now() });
    }
    return redirectBack('connected');
  } catch (e) {
    logger.error({ err: e.message }, 'google calendar token exchange failed');
    return redirectBack('error');
  }
}

module.exports = { router, callbackHandler };
```

- [ ] **Step 4: Update the test's `require`/mount line for the new export shape**

The tests in Step 1 use `const router = require('./googleCalendarAuth');` and `app.use('/api/projects', router)`. Since the module now exports `{ router, callbackHandler }`, update both the test file and re-run:

In `backend/routes/googleCalendarAuth.test.js`, change:

```js
const router = require('./googleCalendarAuth');
```

to:

```js
const { router } = require('./googleCalendarAuth');
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test backend/routes/googleCalendarAuth.test.js`
Expected: PASS — all 5 tests green

- [ ] **Step 6: Commit**

```bash
git add backend/routes/googleCalendarAuth.js backend/routes/googleCalendarAuth.test.js
git commit -m "$(cat <<'EOF'
Add Google Calendar connect/status/disconnect/callback routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire routes into `server.js` + document env vars

**Files:**
- Modify: `backend/server.js`
- Modify: `.env.example`

- [ ] **Step 1: Require and mount the new routes in `server.js`**

Find (around line 50-55):

```js
const captureFieldsRoutes = require('./routes/captureFields');
const quizQuestionsRoutes = require('./routes/quizQuestions');
const flashcardsRoutes = require('./routes/flashcards');
const videoResourcesRoutes = require('./routes/videoResources');
const projectActionsRoutes = require('./routes/projectActions');
```

Replace with:

```js
const captureFieldsRoutes = require('./routes/captureFields');
const quizQuestionsRoutes = require('./routes/quizQuestions');
const flashcardsRoutes = require('./routes/flashcards');
const videoResourcesRoutes = require('./routes/videoResources');
const projectActionsRoutes = require('./routes/projectActions');
const { router: googleCalendarAuthRoutes, callbackHandler: googleCalendarCallback } = require('./routes/googleCalendarAuth');
```

Find (around line 194-200):

```js
app.use('/api/projects', apiLimiter, projectsRoutes);
app.use('/api/projects', apiLimiter, captureFieldsRoutes);
app.use('/api/projects', apiLimiter, quizQuestionsRoutes);
app.use('/api/projects', apiLimiter, flashcardsRoutes);
app.use('/api/projects', apiLimiter, videoResourcesRoutes);
app.use('/api/projects', apiLimiter, projectActionsRoutes);
```

Replace with:

```js
app.use('/api/projects', apiLimiter, projectsRoutes);
app.use('/api/projects', apiLimiter, captureFieldsRoutes);
app.use('/api/projects', apiLimiter, quizQuestionsRoutes);
app.use('/api/projects', apiLimiter, flashcardsRoutes);
app.use('/api/projects', apiLimiter, videoResourcesRoutes);
app.use('/api/projects', apiLimiter, projectActionsRoutes);
app.use('/api/projects', apiLimiter, googleCalendarAuthRoutes);
// Fixed path — must exactly match GOOGLE_CALENDAR_REDIRECT_URI (see
// backend/routes/googleCalendarAuth.js's header comment for why this can't
// be nested under /:projectId like the routes above).
app.get('/api/google-calendar/callback', apiLimiter, googleCalendarCallback);
```

- [ ] **Step 2: Add the new env vars to `.env.example`**

Find the SSO/OIDC section (around line 141-148):

```
# SSO / OIDC login (3c) — SECURITY NOTE: read the header comment in
# backend/services/oidc.js before enabling this in production. All four
# must be set for the "Continue with SSO" login button to appear.
# OIDC_ISSUER=https://your-idp.example.com
# OIDC_CLIENT_ID=
# OIDC_CLIENT_SECRET=
# OIDC_REDIRECT_URI=http://localhost:8080/api/auth/sso/callback
```

Add immediately after it:

```

# ── Google Calendar (tour booking) — optional ─────────────────────────────
# Powers the check_availability/book_tour AI tools (advanced capability
# tier) — see backend/services/googleCalendar.js. Create OAuth 2.0
# credentials in Google Cloud Console (APIs & Services → Credentials →
# Create Credentials → OAuth client ID, type "Web application"), enable the
# Google Calendar API for the project, and add the exact
# GOOGLE_CALENDAR_REDIRECT_URI value below as an authorized redirect URI.
# This URI is fixed (not per-project — see googleCalendarAuth.js). Inert
# (503 on connect) unless all three are set.
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_CALENDAR_REDIRECT_URI=http://localhost:8080/api/google-calendar/callback
```

- [ ] **Step 3: Verify the server still boots**

Run: `JWT_SECRET=test-secret node -e "require('./backend/server.js')" &`
Then: `sleep 1 && curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/`
Expected: `200` (or whatever the existing static-file response code is — the point is the process doesn't crash on require). Kill the background process afterward: `kill %1` (or find/kill the node process by port).

- [ ] **Step 4: Commit**

```bash
git add backend/server.js .env.example
git commit -m "$(cat <<'EOF'
Wire Google Calendar routes into server.js

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `check_availability` / `book_tour` AI tools

**Files:**
- Modify: `backend/services/tools.js`
- Modify: `backend/services/tools.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `backend/services/tools.test.js` (this file currently has no `db`/`googleCalendar` stubbing — add it at the top, before the existing `require('./tools')`, matching the `stubFile` pattern used in `backend/routes/categories.test.js`):

```js
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
let insertEventImpl = async () => 'event-123';
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
```

Then change the existing `const { toolsForTier } = require('./tools');` line (this must come AFTER the `stubFile` calls above, so `tools.js`'s own top-level requires pick up the stubs) to also pull in `tourBookingTools`:

```js
const { toolsForTier, tourBookingTools } = require('./tools');
```

Then add the test cases:

```js
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

test('book_tour books when the slot is free', async () => {
  resetTourBookingStubs();
  freeBusyImpl = async () => [];
  insertEventImpl = async (token, evt) => { assert.equal(evt.attendeeEmail, 'jane@example.com'); return 'event-abc'; };
  const { dispatch } = await tourBookingTools(ADVANCED_PROJECT);
  const result = await dispatch.book_tour({ name: 'Jane', email: 'jane@example.com', startTime: '2026-09-14T13:00:00.000Z' });
  assert.equal(result.booked, true);
  assert.equal(result.calendarEventId, 'event-abc');
});

test('book_tour refuses to double-book a slot Google now reports as busy', async () => {
  resetTourBookingStubs();
  freeBusyImpl = async () => [{ start: '2026-09-14T13:00:00.000Z', end: '2026-09-14T13:30:00.000Z' }];
  const { dispatch } = await tourBookingTools(ADVANCED_PROJECT);
  const result = await dispatch.book_tour({ name: 'Jane', email: 'jane@example.com', startTime: '2026-09-14T13:00:00.000Z' });
  assert.ok(result.error);
  assert.match(result.error, /booked by someone else/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test backend/services/tools.test.js`
Expected: FAIL — `tourBookingTools is not a function` / `Cannot read properties of undefined`

- [ ] **Step 3: Add the tool declarations, handlers, and `tourBookingTools` export to `tools.js`**

At the top of `backend/services/tools.js`, find the existing requires:

```js
const crypto = require('crypto');
const db = require('../db');
const { meetsTier } = require('./tiers');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { embedOne } = require('./embed');
const { searchProject } = require('./vector');
const { safeFetch } = require('./safeFetch');
const settings = require('./settings');
```

Replace with:

```js
const crypto = require('crypto');
const db = require('../db');
const { meetsTier } = require('./tiers');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { embedOne } = require('./embed');
const { searchProject } = require('./vector');
const { safeFetch } = require('./safeFetch');
const settings = require('./settings');
const { computeCandidateSlots, subtractBusy } = require('./tourSlots');
const { getValidAccessToken, freeBusy, insertEvent, GoogleAuthRevokedError } = require('./googleCalendar');
```

Near the end of the file, find:

```js
module.exports = { toolsForTier, projectActionTools };
```

Replace with (this adds everything above the export line, plus the new export):

```js
const CHECK_AVAILABILITY_DECLARATION = {
  name: 'check_availability',
  description:
    'Check when the project owner is free for a tour, so you can offer the visitor real open time slots. ' +
    'Call this whenever a visitor asks about scheduling, booking, or touring, before promising any specific ' +
    "time. Returns a short list of open slots near the date they asked about (or the soonest available if " +
    "they didn't give one).",
  parameters: {
    type: 'object',
    properties: {
      preferredDate: {
        type: 'string',
        description:
          'The date the visitor is interested in, as YYYY-MM-DD. If they said something relative like ' +
          '"tomorrow" or "next Tuesday", resolve it to an actual date yourself before calling. Omit if they ' +
          'gave no date preference — this returns the soonest few days of openings.',
      },
      rangeDays: {
        type: 'integer',
        description:
          'How many days forward from preferredDate to search for openings. Defaults to 3. Use a larger ' +
          'value (up to 14) if the visitor asked for a wider window or nothing was found nearby.',
      },
    },
  },
};

const BOOK_TOUR_DECLARATION = {
  name: 'book_tour',
  description:
    "Book a confirmed tour slot on the project owner's calendar. Only call this AFTER calling " +
    'check_availability and having the visitor confirm one of the returned slots, and after collecting their ' +
    'name and email (their email is where the calendar invite goes — ask for it explicitly if they haven\'t given it).',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "The visitor's full name." },
      email: { type: 'string', description: "The visitor's email address, to send the calendar invite to." },
      startTime: {
        type: 'string',
        description:
          'The exact ISO 8601 start time of the slot the visitor picked, copied verbatim from one of the ' +
          'startTime values check_availability returned — do not compute or guess this yourself.',
      },
    },
    required: ['name', 'email', 'startTime'],
  },
};

async function withAccessToken(connection, fn) {
  let accessToken;
  try {
    accessToken = await getValidAccessToken(connection, (id, patch) => db.update('calendarConnections', id, patch));
  } catch (e) {
    if (e instanceof GoogleAuthRevokedError) {
      await db.remove('calendarConnections', { id: connection.id });
      return { error: 'Tour booking is not available right now.' };
    }
    return { error: 'Could not reach Google Calendar: ' + e.message };
  }
  return fn(accessToken);
}

async function handleCheckAvailability(args, project, tourSettings, connection) {
  const rangeDays = Math.min(Math.max(parseInt(args?.rangeDays, 10) || 3, 1), 14);
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(args?.preferredDate || '')
    ? args.preferredDate
    : new Date().toISOString().slice(0, 10);

  const candidates = computeCandidateSlots({ tourSettings, fromDate, rangeDays });
  if (!candidates.length) return { slots: [], note: 'No working hours are configured in that window.' };

  return withAccessToken(connection, async (accessToken) => {
    const busy = await freeBusy(
      accessToken,
      candidates[0].startUTC.toISOString(),
      candidates[candidates.length - 1].endUTC.toISOString()
    );
    const open = subtractBusy(candidates, busy).slice(0, 8);
    return { slots: open.map(s => ({ startTime: s.startUTC.toISOString(), label: s.label })) };
  }).catch(e => ({ error: 'Could not check calendar availability: ' + e.message }));
}

async function handleBookTour(args, project, tourSettings, connection) {
  const name = String(args?.name || '').trim();
  const email = String(args?.email || '').trim();
  if (!name) return { error: 'name is required' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'A valid email is required' };

  const startUTC = new Date(String(args?.startTime || ''));
  if (isNaN(startUTC.getTime())) return { error: 'startTime must be a valid ISO 8601 timestamp' };
  const endUTC = new Date(startUTC.getTime() + tourSettings.durationMinutes * 60000);

  return withAccessToken(connection, async (accessToken) => {
    const busy = await freeBusy(accessToken, startUTC.toISOString(), endUTC.toISOString());
    if (busy.length) return { error: 'That slot was just booked by someone else — please check availability again.' };

    const calendarEventId = await insertEvent(accessToken, {
      summary: `Tour: ${project.name} — ${name}`,
      description: `Booked via the ${project.name} chatbot.\nVisitor email: ${email}`,
      location: tourSettings.location || undefined,
      startISO: startUTC.toISOString(),
      endISO: endUTC.toISOString(),
      attendeeEmail: email,
    });
    return { booked: true, startTime: startUTC.toISOString(), calendarEventId };
  }).catch(e => ({ error: 'Could not book the tour: ' + e.message }));
}

/**
 * Returns { declarations, dispatch } for check_availability/book_tour —
 * empty unless the project is advanced tier, has tour_settings.enabled,
 * AND has a connected Google Calendar. Async and DB-backed like
 * projectActionTools above, unlike the static, tier-only toolsForTier.
 */
async function tourBookingTools(project) {
  if (!meetsTier(project.capabilityTier, 'advanced')) return { declarations: [], dispatch: {} };
  const tourSettings = project.tourSettings;
  if (!tourSettings || !tourSettings.enabled) return { declarations: [], dispatch: {} };
  const connection = await db.findOne('calendarConnections', { projectId: project.id });
  if (!connection) return { declarations: [], dispatch: {} };

  return {
    declarations: [CHECK_AVAILABILITY_DECLARATION, BOOK_TOUR_DECLARATION],
    dispatch: {
      check_availability: (args) => handleCheckAvailability(args, project, tourSettings, connection),
      book_tour: (args) => handleBookTour(args, project, tourSettings, connection),
    },
  };
}

module.exports = { toolsForTier, projectActionTools, tourBookingTools };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test backend/services/tools.test.js`
Expected: PASS — all existing `explain_visually` tests plus the new tour-booking tests green

- [ ] **Step 5: Commit**

```bash
git add backend/services/tools.js backend/services/tools.test.js
git commit -m "$(cat <<'EOF'
Add check_availability and book_tour AI tools

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire tour-booking tools into the `/study` tool loop

**Files:**
- Modify: `backend/routes/embed.js`

- [ ] **Step 1: Update the tools import**

Find (around line 20):

```js
const { toolsForTier, projectActionTools } = require('../services/tools');
```

Replace with:

```js
const { toolsForTier, projectActionTools, tourBookingTools } = require('../services/tools');
```

- [ ] **Step 2: Include booking tools in the declarations/dispatch assembly**

Find (around line 548-552):

```js
    const tierTools = toolsForTier(project.capabilityTier);
    const actionTools = await projectActionTools(project);
    const declarations = [...tierTools.declarations, ...actionTools.declarations];
    const dispatch = { ...tierTools.dispatch, ...actionTools.dispatch };
```

Replace with:

```js
    const tierTools = toolsForTier(project.capabilityTier);
    const actionTools = await projectActionTools(project);
    const bookingTools = await tourBookingTools(project);
    const declarations = [...tierTools.declarations, ...actionTools.declarations, ...bookingTools.declarations];
    const dispatch = { ...tierTools.dispatch, ...actionTools.dispatch, ...bookingTools.dispatch };
```

- [ ] **Step 3: Check for an existing `embed.test.js` case covering the tool-assembly line, and add one if the file already stubs `services/tools`**

Run: `grep -n "toolsForTier\|projectActionTools\|require('../services/tools')" backend/routes/embed.test.js`

If that file already stubs `../services/tools`, add `tourBookingTools: async () => ({ declarations: [], dispatch: {} })` to the stub's exports (matching whatever shape `toolsForTier`/`projectActionTools` are stubbed with there) so existing `/study` tests keep passing. If the file does NOT stub `../services/tools` (i.e. `/study` isn't covered by route tests, or it hits the real module), no change is needed here — Task 7's unit tests already cover `tourBookingTools` in isolation.

- [ ] **Step 4: Run the full backend test suite**

Run: `node --test 'backend/**/*.test.js'`
Expected: PASS — no regressions in `embed.test.js` or elsewhere

- [ ] **Step 5: Commit**

```bash
git add backend/routes/embed.js backend/routes/embed.test.js
git commit -m "$(cat <<'EOF'
Wire tour-booking tools into the /study function-calling loop

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

(If Step 3 found nothing to change in `embed.test.js`, `git add` it anyway is a no-op — fine to run, or drop it from the command.)

---

## Task 9: Frontend API helpers

**Files:**
- Modify: `public/js/api.js`

- [ ] **Step 1: Add Google Calendar API methods**

Find (around line 146-147):

```js
  // Team members
  listMembers:   (pid) => apiCall(`/api/projects/${pid}/members`),
```

Replace with:

```js
  // Google Calendar (tour booking)
  getCalendarStatus:     (pid) => apiCall(`/api/projects/${pid}/calendar/status`),
  connectGoogleCalendar: (pid) => apiCall(`/api/projects/${pid}/calendar/connect`),
  disconnectGoogleCalendar: (pid) => apiCall(`/api/projects/${pid}/calendar`, { method: 'DELETE' }),

  // Team members
  listMembers:   (pid) => apiCall(`/api/projects/${pid}/members`),
```

(`tourSettings` itself is saved via the existing `API.updateProject(id, patch)` — no new endpoint needed there, per Task 4's `patchProject` allowlist addition.)

- [ ] **Step 2: Manually verify**

Run: `node -e "require('/Users/uhkjjkhjh/Downloads/avatar-platform 2/public/js/api.js')" 2>&1 | head -5`
Expected: a `ReferenceError: localStorage is not defined` (this file assumes a browser environment) rather than a syntax error — confirms the file still parses. (This is just a syntax sanity check, not a real test — this file has no automated test suite, matching the rest of `public/js/`.)

- [ ] **Step 3: Commit**

```bash
git add public/js/api.js
git commit -m "$(cat <<'EOF'
Add frontend API helpers for Google Calendar connection

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Dashboard "Tours" tab

Adds a new tab following the exact pattern already used for `quiz`/`flashcards`/`videos` (tier-gated visibility) and `capture` (its own load/save flow), with a weekday working-hours editor modeled on the existing `businessHours` UI but supporting multiple windows per day.

**Files:**
- Modify: `public/project.html`

- [ ] **Step 1: Add the tab button**

Find (around line 82):

```html
      <button class="tab" data-tab="leads" id="leads-tab">Leads</button>
```

Add immediately after it:

```html
      <button class="tab" data-tab="tours" id="tours-tab">Tours</button>
```

- [ ] **Step 2: Add the tab panel HTML**

Find the end of the `panel-leads` section (search for `<section class="tab-panel" id="panel-leads"` and find its closing `</section>` — insert the new panel immediately after that closing tag). Add:

```html
    <section class="tab-panel" id="panel-tours" hidden>
      <div class="card">
        <h2 class="card-title mb-md">Google Calendar</h2>
        <div class="col gap-md">
          <div id="tours-calendar-disconnected" class="row" style="align-items:center;gap:12px">
            <span class="help">Connect a Google Calendar so the AI can check your real availability and book tours directly onto it.</span>
            <button class="btn btn-primary" id="tours-connect-btn" type="button">Connect Google Calendar</button>
          </div>
          <div id="tours-calendar-connected" class="row" style="align-items:center;gap:12px;display:none">
            <span class="help">Connected as <strong id="tours-connected-email"></strong></span>
            <button class="btn btn-ghost" id="tours-disconnect-btn" type="button">Disconnect</button>
          </div>
        </div>
      </div>

      <div class="card mt-md">
        <h2 class="card-title mb-md">Tour settings</h2>
        <div class="col gap-md">
          <div class="field">
            <label>Tour booking</label>
            <select class="select" id="f-tour-enabled">
              <option value="false">Disabled (default)</option>
              <option value="true">Enabled — the AI can offer and book tours</option>
            </select>
          </div>
          <div id="tours-settings-detail" style="display:none" class="col gap-md">
            <div class="grid grid-3">
              <div class="field">
                <label>Duration (minutes)</label>
                <input class="input" type="number" id="f-tour-duration" value="30" min="5" max="240" />
              </div>
              <div class="field">
                <label>Buffer between tours (minutes)</label>
                <input class="input" type="number" id="f-tour-buffer" value="15" min="0" max="120" />
              </div>
              <div class="field">
                <label>Timezone</label>
                <select class="select" id="f-tour-tz"></select>
              </div>
            </div>
            <div class="field">
              <label>Location</label>
              <input class="input" id="f-tour-location" placeholder="123 Main St, or a video call link" />
            </div>
            <div class="field">
              <label>Working hours</label>
              <div class="col gap-sm" id="f-tour-hours"></div>
            </div>
          </div>
          <div class="row">
            <button class="btn btn-primary" id="tours-save-btn" type="button">Save tour settings</button>
            <span id="tours-save-error" class="error-text" style="display:none"></span>
          </div>
        </div>
      </div>
    </section>
```

- [ ] **Step 3: Add tier-gating for the new tab**

Find (around line 1014-1026):

```js
  function applyTierVisibility(tier) {
    const quizTab = document.querySelector('.tab[data-tab="quiz"]');
    const flashcardsTab = document.querySelector('.tab[data-tab="flashcards"]');
    const videosTab = document.querySelector('.tab[data-tab="videos"]');
    quizTab.hidden = tier !== 'advanced';
    flashcardsTab.hidden = tier !== 'advanced';
    videosTab.hidden = tier === 'basic';

    const activeTab = document.querySelector('.tab.active');
    if (activeTab && activeTab.hidden) {
      document.querySelector('.tab[data-tab="settings"]').click();
    }
  }
```

Replace with:

```js
  function applyTierVisibility(tier) {
    const quizTab = document.querySelector('.tab[data-tab="quiz"]');
    const flashcardsTab = document.querySelector('.tab[data-tab="flashcards"]');
    const videosTab = document.querySelector('.tab[data-tab="videos"]');
    const toursTab = document.querySelector('.tab[data-tab="tours"]');
    quizTab.hidden = tier !== 'advanced';
    flashcardsTab.hidden = tier !== 'advanced';
    videosTab.hidden = tier === 'basic';
    toursTab.hidden = tier !== 'advanced';

    const activeTab = document.querySelector('.tab.active');
    if (activeTab && activeTab.hidden) {
      document.querySelector('.tab[data-tab="settings"]').click();
    }
  }
```

- [ ] **Step 4: Add `tours` to the `activateTab` lazy-load dispatch**

Find (around line 972-991):

```js
  function activateTab(t) {
    if (!t || t.hidden) return;
    allTabs.forEach(x => {
      const isActive = x === t;
      x.classList.toggle('active', isActive);
      x.setAttribute('aria-selected', isActive ? 'true' : 'false');
      x.setAttribute('tabindex', isActive ? '0' : '-1');
    });
    document.querySelectorAll('.tab-panel').forEach(p => p.hidden = true);
    document.getElementById('panel-' + t.dataset.tab).hidden = false;
    if (t.dataset.tab === 'preview') refreshPreview();
    if (t.dataset.tab === 'knowledge') loadFiles();
    if (t.dataset.tab === 'analytics') loadProjectAnalytics();
    if (t.dataset.tab === 'conversations') loadSessions();
    if (t.dataset.tab === 'capture') loadCaptureFields();
    if (t.dataset.tab === 'quiz') loadQuizQuestions();
    if (t.dataset.tab === 'flashcards') loadFlashcards();
    if (t.dataset.tab === 'videos') loadVideos();
    if (t.dataset.tab === 'leads') loadLeads();
  }
```

Replace with:

```js
  function activateTab(t) {
    if (!t || t.hidden) return;
    allTabs.forEach(x => {
      const isActive = x === t;
      x.classList.toggle('active', isActive);
      x.setAttribute('aria-selected', isActive ? 'true' : 'false');
      x.setAttribute('tabindex', isActive ? '0' : '-1');
    });
    document.querySelectorAll('.tab-panel').forEach(p => p.hidden = true);
    document.getElementById('panel-' + t.dataset.tab).hidden = false;
    if (t.dataset.tab === 'preview') refreshPreview();
    if (t.dataset.tab === 'knowledge') loadFiles();
    if (t.dataset.tab === 'analytics') loadProjectAnalytics();
    if (t.dataset.tab === 'conversations') loadSessions();
    if (t.dataset.tab === 'capture') loadCaptureFields();
    if (t.dataset.tab === 'quiz') loadQuizQuestions();
    if (t.dataset.tab === 'flashcards') loadFlashcards();
    if (t.dataset.tab === 'videos') loadVideos();
    if (t.dataset.tab === 'leads') loadLeads();
    if (t.dataset.tab === 'tours') loadTourSettings();
  }
```

- [ ] **Step 5: Add the Tours tab's JS logic**

Find the `window.switchTab` helper (around line 2490-2492):

```js
  window.switchTab = (name) => {
    document.querySelector(`.tab[data-tab="${name}"]`)?.click();
  };
```

Add immediately after it:

```js
  // ── Tours (Google Calendar booking) ─────────────────────────────
  const TOUR_WEEKDAYS = [['mon','Mon'],['tue','Tue'],['wed','Wed'],['thu','Thu'],['fri','Fri'],['sat','Sat'],['sun','Sun']];
  let tourWorkingHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };

  function populateTourTimezones(selected) {
    const sel = document.getElementById('f-tour-tz');
    let zones;
    try { zones = Intl.supportedValuesOf('timeZone'); } catch (_) { zones = null; }
    if (!zones || !zones.length) {
      zones = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
    }
    const guess = selected || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    if (!zones.includes(guess)) zones = [guess, ...zones];
    sel.innerHTML = zones.map(z => `<option value="${z}" ${z === guess ? 'selected' : ''}>${z}</option>`).join('');
  }

  function renderTourHours() {
    const wrap = document.getElementById('f-tour-hours');
    wrap.innerHTML = TOUR_WEEKDAYS.map(([code, label]) => {
      const windows = tourWorkingHours[code] || [];
      const rows = windows.map((w, i) => `
        <div class="row" style="gap:8px;align-items:center" data-day="${code}" data-idx="${i}">
          <input class="input" type="time" value="${w.start}" data-role="start" style="width:120px" />
          <span>to</span>
          <input class="input" type="time" value="${w.end}" data-role="end" style="width:120px" />
          <button class="btn btn-sm btn-ghost" type="button" data-action="remove-window" data-day="${code}" data-idx="${i}">Remove</button>
        </div>
      `).join('');
      return `
        <div class="row" style="gap:10px;align-items:flex-start">
          <div style="width:40px;padding-top:8px;font-weight:600">${label}</div>
          <div class="col gap-xs" style="flex:1">
            ${rows || '<span class="help">No hours set</span>'}
            <button class="btn btn-sm btn-ghost" type="button" data-action="add-window" data-day="${code}">+ Add hours</button>
          </div>
        </div>
      `;
    }).join('');
  }

  document.getElementById('f-tour-hours').addEventListener('click', (e) => {
    const addBtn = e.target.closest('[data-action="add-window"]');
    if (addBtn) {
      tourWorkingHours[addBtn.dataset.day].push({ start: '09:00', end: '17:00' });
      renderTourHours();
      return;
    }
    const removeBtn = e.target.closest('[data-action="remove-window"]');
    if (removeBtn) {
      tourWorkingHours[removeBtn.dataset.day].splice(Number(removeBtn.dataset.idx), 1);
      renderTourHours();
    }
  });

  document.getElementById('f-tour-hours').addEventListener('change', (e) => {
    const row = e.target.closest('[data-day]');
    if (!row || !e.target.dataset.role) return;
    tourWorkingHours[row.dataset.day][Number(row.dataset.idx)][e.target.dataset.role] = e.target.value;
  });

  document.getElementById('f-tour-enabled').addEventListener('change', (e) => {
    document.getElementById('tours-settings-detail').style.display = e.target.value === 'true' ? '' : 'none';
  });

  async function refreshCalendarStatus() {
    const status = await API.getCalendarStatus(projectId);
    document.getElementById('tours-calendar-disconnected').style.display = status.connected ? 'none' : '';
    document.getElementById('tours-calendar-connected').style.display = status.connected ? '' : 'none';
    if (status.connected) document.getElementById('tours-connected-email').textContent = status.googleEmail || '';
  }

  document.getElementById('tours-connect-btn').addEventListener('click', async () => {
    try {
      const { url } = await API.connectGoogleCalendar(projectId);
      location.href = url;
    } catch (e) {
      showToast(e.message, 'error');
    }
  });

  document.getElementById('tours-disconnect-btn').addEventListener('click', async () => {
    if (!confirm('Disconnect Google Calendar? The AI will no longer be able to check availability or book tours.')) return;
    try {
      await API.disconnectGoogleCalendar(projectId);
      await refreshCalendarStatus();
      showToast('Google Calendar disconnected');
    } catch (e) {
      showToast(e.message, 'error');
    }
  });

  async function loadTourSettings() {
    const ts = project.tourSettings || {};
    document.getElementById('f-tour-enabled').value = String(ts.enabled === true);
    document.getElementById('tours-settings-detail').style.display = ts.enabled === true ? '' : 'none';
    document.getElementById('f-tour-duration').value = ts.durationMinutes || 30;
    document.getElementById('f-tour-buffer').value = ts.bufferMinutes ?? 15;
    document.getElementById('f-tour-location').value = ts.location || '';
    populateTourTimezones(ts.timezone);
    tourWorkingHours = {
      mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
      ...(ts.workingHours || {}),
    };
    renderTourHours();
    await refreshCalendarStatus();
  }

  document.getElementById('tours-save-btn').addEventListener('click', async () => {
    const errEl = document.getElementById('tours-save-error');
    errEl.style.display = 'none';
    const tourSettings = {
      enabled: document.getElementById('f-tour-enabled').value === 'true',
      durationMinutes: Number(document.getElementById('f-tour-duration').value),
      bufferMinutes: Number(document.getElementById('f-tour-buffer').value),
      timezone: document.getElementById('f-tour-tz').value,
      location: document.getElementById('f-tour-location').value.trim(),
      workingHours: tourWorkingHours,
    };
    try {
      const { project: updated } = await API.updateProject(projectId, { tourSettings });
      project = updated;
      showToast('Tour settings saved');
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
    }
  });

  // Landed here from the Google OAuth callback redirect (see
  // backend/routes/googleCalendarAuth.js#callbackHandler) — surface the
  // result and clean the query string so a refresh doesn't re-show the toast.
  (function handleCalendarOAuthReturn() {
    const calendarResult = params.get('calendar');
    if (!calendarResult) return;
    if (params.get('tab') === 'tours') {
      // Deferred: the Tours tab (and its tier-gated visibility) isn't
      // built yet at this point in the script — applyTierVisibility runs
      // after project data loads, later below. Queue the switch for then.
      window.addEventListener('load', () => switchTab('tours'));
    }
    window.addEventListener('load', () => {
      showToast(calendarResult === 'connected' ? 'Google Calendar connected' : 'Could not connect Google Calendar', calendarResult === 'connected' ? '' : 'error');
    });
    const url = new URL(location.href);
    url.searchParams.delete('calendar');
    url.searchParams.delete('tab');
    history.replaceState(null, '', url.toString());
  })();
```

- [ ] **Step 6: Manual verification**

Run: `node -e "new Function(require('fs').readFileSync('/Users/uhkjjkhjh/Downloads/avatar-platform 2/public/project.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/g).map(s => s.replace(/<\/?script>/g,'')).join('\n'))" 2>&1 | tail -5`
Expected: no `SyntaxError` printed (a `ReferenceError` for a missing browser global like `document` is fine — this only checks the JS parses). If this one-liner is awkward in your shell, an equally valid check is opening the dashboard in a browser (`npm run dev`, log in, open a project, click the Tours tab) and confirming no console errors — do that if available.

- [ ] **Step 7: Commit**

```bash
git add public/project.html
git commit -m "$(cat <<'EOF'
Add Tours tab: Google Calendar connect + booking settings UI

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final check

- [ ] Run the full backend suite once more: `node --test 'backend/**/*.test.js'` — expect all green, no regressions.
- [ ] Confirm `.env.example` documents `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_CALENDAR_REDIRECT_URI` and that a real deployment needs Google Cloud Console credentials created manually (not something this plan can do).
- [ ] Manually walk the flow if a browser + real Google OAuth credentials are available: Tours tab → Connect Google Calendar → grant consent → redirected back with a "connected" toast → set working hours + enable → Save → open the project's embed widget → ask the AI about booking a tour → confirm it offers real slots and the booked event appears on the connected Google Calendar.
