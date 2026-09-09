# Calendly Meeting Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Calendly booking path alongside the existing Google Calendar tour booking, and give Google Calendar bookings a real auto-generated Google Meet link.

**Architecture:** Extend the existing `tourSettings` jsonb config with an independent `calendly` sub-object (no migration). Add one new AI tool, `open_calendly_scheduler`, gated and merged alongside the existing `check_availability`/`book_tour` tools in `backend/services/tools.js`. The widget renders whichever tool's result comes back — an embedded Calendly scheduler for the new tool, same pattern as the existing `explain_visually` whiteboard card.

**Tech Stack:** Node.js/Express backend, Zod validation, vanilla-JS frontend (`public/project.html` dashboard, `public/embed.html` chat widget), Calendly's inline-widget JS embed, Google Calendar REST API.

**Spec:** `docs/superpowers/specs/2026-09-08-calendly-meeting-booking-design.md`

---

## Note on pre-existing uncommitted changes

`backend/middleware/validate.js` and `public/css/embed.css` already have unrelated uncommitted edits in the working tree (a `systemPrompt` max-length bump, and an avatar-canvas transparency fix) — unrelated to this feature. When committing Tasks 3 and 6 (which touch these files), **stage only this feature's hunks**, e.g. `git add -p backend/middleware/validate.js` and select only the new hunks, rather than `git add backend/middleware/validate.js`. Verify with `git diff --cached` before committing that no unrelated hunk snuck in.

---

### Task 1: Google Meet link on `insertEvent`

**Files:**
- Modify: `backend/services/googleCalendar.js:170-191` (the `insertEvent` function) and its `require` line at the top
- Test: `backend/services/googleCalendar.test.js:156-166` (modify existing test) and append two new tests

- [ ] **Step 1: Write the failing tests**

Replace the existing `insertEvent` test block (lines 156-166) and add two new tests immediately after it, in `backend/services/googleCalendar.test.js`:

```js
test('insertEvent requests a Google Meet conference link and returns id + meetLink', async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ id: 'event-123', hangoutLink: 'https://meet.google.com/abc-defg-hij' }) });
  const result = await insertEvent('access-token', {
    summary: 'Tour: Acme — Jane', description: 'desc', location: '123 Main St',
    startISO: '2026-09-14T13:00:00.000Z', endISO: '2026-09-14T13:30:00.000Z', attendeeEmail: 'jane@example.com',
  });
  assert.equal(result.id, 'event-123');
  assert.equal(result.meetLink, 'https://meet.google.com/abc-defg-hij');
  assert.match(fetchCalls[0].url, /sendUpdates=all/);
  assert.match(fetchCalls[0].url, /conferenceDataVersion=1/);
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.attendees[0].email, 'jane@example.com');
  assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.ok(body.conferenceData.createRequest.requestId, 'requestId must be set');
});

test('insertEvent returns meetLink: null when Google does not include a hangoutLink', async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ id: 'event-999' }) });
  const result = await insertEvent('access-token', {
    summary: 's', startISO: 'a', endISO: 'b', attendeeEmail: 'x@example.com',
  });
  assert.equal(result.id, 'event-999');
  assert.equal(result.meetLink, null);
});

test('insertEvent throws with Google\'s error message on failure', async () => {
  fetchImpl = async () => ({ ok: false, json: async () => ({ error: { message: 'Invalid attendee' } }) });
  await assert.rejects(
    () => insertEvent('access-token', { summary: 's', startISO: 'a', endISO: 'b', attendeeEmail: 'x@example.com' }),
    /Invalid attendee/
  );
});

test('insertEvent throws GoogleAuthRevokedError on a 401 (access revoked mid-call)', async () => {
  fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid Credentials' } }) });
  await assert.rejects(
    () => insertEvent('access-token', { summary: 's', startISO: 'a', endISO: 'b', attendeeEmail: 'x@example.com' }),
    GoogleAuthRevokedError
  );
});
```

This replaces the old `'insertEvent posts the event and returns its id'` test (which asserted a bare string return) and keeps the two failure-path tests as-is (they don't touch the return shape). The file's other tests (isConfigured, buildAuthorizationUrl, exchangeCode, getValidAccessToken, freeBusy) are untouched.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test backend/services/googleCalendar.test.js`
Expected: FAIL — `result.meetLink` is `undefined` (current `insertEvent` returns a bare string `body.id`), and the URL assertion for `conferenceDataVersion=1` fails.

- [ ] **Step 3: Implement**

In `backend/services/googleCalendar.js`, add `crypto` to the top-level requires (there are no other requires in this file today — add a new line right after the file's opening doc comment, before `const AUTH_URL = ...`):

```js
const crypto = require('crypto');
```

Replace the `insertEvent` function (lines 170-191):

```js
async function insertEvent(accessToken, { summary, description, location, startISO, endISO, attendeeEmail }) {
  const res = await fetch(`${EVENTS_URL}?sendUpdates=all&conferenceDataVersion=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      summary,
      description,
      location: location || undefined,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees: [{ email: attendeeEmail }],
      conferenceData: {
        createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
      },
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // See freeBusy's matching comment above.
    if (res.status === 401) throw new GoogleAuthRevokedError('Google Calendar access was revoked');
    throw new Error(body.error?.message || `event creation failed: HTTP ${res.status}`);
  }
  return { id: body.id, meetLink: body.hangoutLink || null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/services/googleCalendar.test.js`
Expected: PASS (all tests in the file, including the untouched ones)

- [ ] **Step 5: Commit**

```bash
git add backend/services/googleCalendar.js backend/services/googleCalendar.test.js
git commit -m "$(cat <<'EOF'
Auto-generate a Google Meet link on every tour booking

insertEvent now requests conferenceData on create and returns
{ id, meetLink } instead of a bare event id.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire `meetLink` through `handleBookTour`

**Files:**
- Modify: `backend/services/tools.js:469-489` (`BOOK_TOUR_DECLARATION`) and `:543-573` (`handleBookTour`)
- Test: `backend/services/tools.test.js:41` (default stub) and `:225-233` (existing test) — modify; append one new test

- [ ] **Step 1: Write the failing tests**

In `backend/services/tools.test.js`, change line 41 from:

```js
let insertEventImpl = async () => 'event-123';
```

to:

```js
let insertEventImpl = async () => ({ id: 'event-123', meetLink: null });
```

Replace the existing `'book_tour books when the slot is free'` test (lines 225-233) with:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test backend/services/tools.test.js`
Expected: FAIL — `handleBookTour` destructures `insertEvent`'s old bare-string return as an object, so `calendarEventId` comes back `undefined` and `result.meetLink` is `undefined`.

- [ ] **Step 3: Implement**

In `backend/services/tools.js`, update `BOOK_TOUR_DECLARATION`'s description (append one sentence). Replace:

```js
const BOOK_TOUR_DECLARATION = {
  name: 'book_tour',
  description:
    "Book a confirmed tour slot on the project owner's calendar. Only call this AFTER calling " +
    'check_availability and having the visitor confirm one of the returned slots, and after collecting their ' +
    'name and email (their email is where the calendar invite goes — ask for it explicitly if they haven\'t given it).',
```

with:

```js
const BOOK_TOUR_DECLARATION = {
  name: 'book_tour',
  description:
    "Book a confirmed tour slot on the project owner's calendar. Only call this AFTER calling " +
    'check_availability and having the visitor confirm one of the returned slots, and after collecting their ' +
    'name and email (their email is where the calendar invite goes — ask for it explicitly if they haven\'t given it). ' +
    "If the result includes a meetLink, read it back to the visitor as their video call link.",
```

Replace `handleBookTour` (lines 543-573):

```js
async function handleBookTour(args, project, tourSettings, connection) {
  const name = String(args?.name || '').trim();
  const email = String(args?.email || '').trim();
  if (!name) return { error: 'name is required' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'A valid email is required' };

  const startUTC = new Date(String(args?.startTime || ''));
  if (isNaN(startUTC.getTime())) return { error: 'startTime must be a valid ISO 8601 timestamp' };
  const endUTC = new Date(startUTC.getTime() + tourSettings.durationMinutes * 60000);

  return withAccessToken(connection, async (accessToken) => {
    // Re-checking here narrows but doesn't eliminate the race: a second
    // visitor's book_tour could still slip in between this freeBusy call
    // and insertEvent below. Google Calendar has no conditional-create
    // primitive to close that fully; acceptable residual risk for two
    // visitors independently booking the exact same slot within
    // milliseconds of each other on a tour-booking chatbot.
    const busy = await freeBusy(accessToken, startUTC.toISOString(), endUTC.toISOString());
    if (busy.length) return { error: 'That slot was just booked by someone else — please check availability again.' };

    const { id: calendarEventId, meetLink } = await insertEvent(accessToken, {
      summary: `Tour: ${project.name} — ${name}`,
      description: `Booked via the ${project.name} chatbot.\nVisitor email: ${email}`,
      location: tourSettings.location || undefined,
      startISO: startUTC.toISOString(),
      endISO: endUTC.toISOString(),
      attendeeEmail: email,
    });
    return { booked: true, startTime: startUTC.toISOString(), calendarEventId, meetLink };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/services/tools.test.js`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit**

```bash
git add backend/services/tools.js backend/services/tools.test.js
git commit -m "$(cat <<'EOF'
Return the Google Meet link from book_tour

Passes insertEvent's new { id, meetLink } shape through to the model so
it can read the video call link back to the visitor.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `tourSettings.calendly` validation schema

**Files:**
- Modify: `backend/middleware/validate.js:101-108` (`tourSettings`) and `:125-128` (`RESERVED_ACTION_NAMES`)
- Test: `backend/middleware/validate.test.js` (append near the existing `tourSettings` tests, ~line 270, and near the reserved-name tests, ~line 554)

- [ ] **Step 1: Write the failing tests**

Append to `backend/middleware/validate.test.js`, right after the existing `'patchProject: accepts a tourSettings.timezone that is a real IANA name'` test (around line 270):

```js
test('patchProject: accepts tourSettings with a valid calendly config', () => {
  const result = schemas.patchProject.safeParse({
    tourSettings: {
      enabled: false, durationMinutes: 30, timezone: 'UTC', bufferMinutes: 0, location: '',
      workingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
      calendly: {
        enabled: true,
        eventTypes: [
          { label: '15 min intro', url: 'https://calendly.com/acme/intro' },
          { label: 'Demo', url: 'https://calendly.com/acme/demo' },
        ],
      },
    },
  });
  assert.equal(result.success, true);
});

test('patchProject: tourSettings.calendly is optional (omitting it is still valid)', () => {
  const result = schemas.patchProject.safeParse({
    tourSettings: {
      enabled: false, durationMinutes: 30, timezone: 'UTC', bufferMinutes: 0, location: '',
      workingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    },
  });
  assert.equal(result.success, true);
});

test('patchProject: rejects a calendly event type url that is not calendly.com', () => {
  const result = schemas.patchProject.safeParse({
    tourSettings: {
      enabled: false, durationMinutes: 30, timezone: 'UTC', bufferMinutes: 0, location: '',
      workingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
      calendly: { enabled: true, eventTypes: [{ label: 'Demo', url: 'https://evil.example.com/demo' }] },
    },
  });
  assert.equal(result.success, false);
});

test('patchProject: rejects a calendly event type with an empty label', () => {
  const result = schemas.patchProject.safeParse({
    tourSettings: {
      enabled: false, durationMinutes: 30, timezone: 'UTC', bufferMinutes: 0, location: '',
      workingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
      calendly: { enabled: true, eventTypes: [{ label: '', url: 'https://calendly.com/acme/demo' }] },
    },
  });
  assert.equal(result.success, false);
});

test('patchProject: rejects more than 10 calendly event types', () => {
  const eventTypes = Array.from({ length: 11 }, (_, i) => ({ label: `Type ${i}`, url: 'https://calendly.com/acme/x' }));
  const result = schemas.patchProject.safeParse({
    tourSettings: {
      enabled: false, durationMinutes: 30, timezone: 'UTC', bufferMinutes: 0, location: '',
      workingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
      calendly: { enabled: true, eventTypes },
    },
  });
  assert.equal(result.success, false);
});
```

Append to `backend/middleware/validate.test.js`, right after `'projectActionCreate accepts a non-colliding snake_case name'` (around line 548):

```js
test('projectActionCreate rejects a name that collides with a built-in tool (open_calendly_scheduler)', () => {
  const result = schemas.projectActionCreate.safeParse({
    name: 'open_calendly_scheduler', description: 'desc', webhookUrl: 'https://example.com/hook',
  });
  assert.equal(result.success, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test backend/middleware/validate.test.js`
Expected: FAIL — `calendly` isn't a recognized key on the `tourSettings` schema yet (Zod strips unknown keys silently rather than erroring, so the "accepts" test actually passes vacuously today; the two "rejects" tests and the reserved-name test are the ones that fail, since nothing rejects them yet). Confirm this distinction by reading the actual failure output rather than assuming which tests fail.

- [ ] **Step 3: Implement**

In `backend/middleware/validate.js`, add a new `calendlyEventType`/`calendlySettings` schema right before the existing `tourSettings` const (before line 101), and add the `calendly` key to `tourSettings`:

```js
const calendlyEventType = z.object({
  label: z.string().trim().min(1, 'label is required').max(60, 'label too long'),
  url: z.string().trim().url('url must be a valid URL')
    .refine(v => {
      try { return new URL(v).hostname === 'calendly.com'; } catch { return false; }
    }, { message: 'url must be a calendly.com scheduling link' }),
});

const calendlySettings = z.object({
  enabled: z.boolean(),
  eventTypes: z.array(calendlyEventType).max(10, 'Up to 10 event types'),
}).optional();

const tourSettings = z.object({
  enabled: z.boolean(),
  durationMinutes: z.number().int().min(5).max(240),
  timezone: ianaTimezone,
  bufferMinutes: z.number().int().min(0).max(120),
  location: z.string().trim().max(300).optional(),
  workingHours: tourWorkingHours,
  calendly: calendlySettings,
}).nullable().optional();
```

(This replaces the old `tourSettings` const definition — `calendlyEventType`/`calendlySettings` are new consts placed immediately above it.)

Update `RESERVED_ACTION_NAMES` (lines 125-128) from:

```js
const RESERVED_ACTION_NAMES = new Set([
  'get_project_topics', 'generate_quiz', 'generate_flashcards', 'recommend_video', 'explain_visually',
  'check_availability', 'book_tour',
]);
```

to:

```js
const RESERVED_ACTION_NAMES = new Set([
  'get_project_topics', 'generate_quiz', 'generate_flashcards', 'recommend_video', 'explain_visually',
  'check_availability', 'book_tour', 'open_calendly_scheduler',
]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/middleware/validate.test.js`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit (feature hunks only — see the note at the top of this plan)**

```bash
git add -p backend/middleware/validate.js
# Select only the calendlyEventType/calendlySettings/tourSettings.calendly and
# RESERVED_ACTION_NAMES hunks — leave the pre-existing systemPrompt max-length
# hunk unstaged.
git diff --cached  # confirm only the intended hunks are staged
git add backend/middleware/validate.test.js
git commit -m "$(cat <<'EOF'
Validate tourSettings.calendly and reserve open_calendly_scheduler

Owner-configured Calendly event types must be calendly.com links, capped
at 10; open_calendly_scheduler joins the built-in tool names an owner
action can't collide with.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `open_calendly_scheduler` tool + decoupled `tourBookingTools`

**Files:**
- Modify: `backend/services/tools.js:469-489` (add new declaration after `BOOK_TOUR_DECLARATION`), `:575-595` (`tourBookingTools`)
- Test: `backend/services/tools.test.js` (append after the existing tour-booking tests, ~line 284)

- [ ] **Step 1: Write the failing tests**

Append to `backend/services/tools.test.js`, after the last existing test (`'check_availability clamps an out-of-range rangeDays to the 1-14 window'`, ends around line 284):

```js
const CALENDLY_EVENT_TYPES = [
  { label: '15 min intro', url: 'https://calendly.com/acme/intro' },
  { label: 'Demo', url: 'https://calendly.com/acme/demo' },
];

const CALENDLY_PROJECT = {
  id: 'proj-2', name: 'Acme Meetings', capabilityTier: 'advanced',
  tourSettings: {
    enabled: false, durationMinutes: 30, bufferMinutes: 0, timezone: 'UTC', location: '',
    workingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    calendly: { enabled: true, eventTypes: CALENDLY_EVENT_TYPES },
  },
};

test('tourBookingTools returns only open_calendly_scheduler when Calendly is enabled and Google tour booking is off', async () => {
  resetTourBookingStubs();
  const { declarations, dispatch } = await tourBookingTools(CALENDLY_PROJECT);
  assert.deepEqual(declarations.map(d => d.name), ['open_calendly_scheduler']);
  assert.ok(dispatch.open_calendly_scheduler);
  assert.equal(dispatch.check_availability, undefined);
});

test('tourBookingTools returns no tools when Calendly is enabled but has no event types configured', async () => {
  resetTourBookingStubs();
  const emptyCalendly = {
    ...CALENDLY_PROJECT,
    tourSettings: { ...CALENDLY_PROJECT.tourSettings, calendly: { enabled: true, eventTypes: [] } },
  };
  const { declarations } = await tourBookingTools(emptyCalendly);
  assert.deepEqual(declarations, []);
});

test('tourBookingTools merges both providers and adds an ask-preference note to each description when both are active', async () => {
  resetTourBookingStubs();
  const bothProject = {
    ...ADVANCED_PROJECT,
    tourSettings: { ...ADVANCED_PROJECT.tourSettings, calendly: { enabled: true, eventTypes: CALENDLY_EVENT_TYPES } },
  };
  const { declarations, dispatch } = await tourBookingTools(bothProject);
  assert.deepEqual(declarations.map(d => d.name).sort(), ['book_tour', 'check_availability', 'open_calendly_scheduler']);
  assert.ok(dispatch.book_tour && dispatch.check_availability && dispatch.open_calendly_scheduler);
  for (const d of declarations) {
    assert.match(d.description, /ask the visitor which they'd prefer/);
  }
});

test('tourBookingTools does not mutate the shared declaration consts when adding the both-providers note', async () => {
  resetTourBookingStubs();
  const bothProject = {
    ...ADVANCED_PROJECT,
    tourSettings: { ...ADVANCED_PROJECT.tourSettings, calendly: { enabled: true, eventTypes: CALENDLY_EVENT_TYPES } },
  };
  await tourBookingTools(bothProject);
  const { declarations: googleOnly } = await tourBookingTools(ADVANCED_PROJECT);
  const bookTour = googleOnly.find(d => d.name === 'book_tour');
  assert.doesNotMatch(bookTour.description, /ask the visitor which they'd prefer/);
});

test('open_calendly_scheduler rejects a missing name or invalid email', async () => {
  resetTourBookingStubs();
  const { dispatch } = await tourBookingTools(CALENDLY_PROJECT);
  const noName = await dispatch.open_calendly_scheduler({ name: '', email: 'a@b.com' });
  assert.ok(noName.error);
  const badEmail = await dispatch.open_calendly_scheduler({ name: 'Jane', email: 'not-an-email' });
  assert.ok(badEmail.error);
});

test('open_calendly_scheduler returns the default (first) event type when none is requested', async () => {
  resetTourBookingStubs();
  const { dispatch } = await tourBookingTools(CALENDLY_PROJECT);
  const result = await dispatch.open_calendly_scheduler({ name: 'Jane', email: 'jane@example.com' });
  assert.equal(result.url, 'https://calendly.com/acme/intro');
  assert.equal(result.label, '15 min intro');
  assert.equal(result.name, 'Jane');
  assert.equal(result.email, 'jane@example.com');
});

test('open_calendly_scheduler matches event_type by a case-insensitive substring of the label', async () => {
  resetTourBookingStubs();
  const { dispatch } = await tourBookingTools(CALENDLY_PROJECT);
  const result = await dispatch.open_calendly_scheduler({ name: 'Jane', email: 'jane@example.com', event_type: 'DEMO' });
  assert.equal(result.url, 'https://calendly.com/acme/demo');
  assert.equal(result.label, 'Demo');
});

test('open_calendly_scheduler falls back to the default event type when event_type matches nothing configured', async () => {
  resetTourBookingStubs();
  const { dispatch } = await tourBookingTools(CALENDLY_PROJECT);
  const result = await dispatch.open_calendly_scheduler({ name: 'Jane', email: 'jane@example.com', event_type: 'nonexistent' });
  assert.equal(result.label, '15 min intro');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test backend/services/tools.test.js`
Expected: FAIL — `open_calendly_scheduler` doesn't exist yet (`dispatch.open_calendly_scheduler` is `undefined`), so every new test throws or fails its assertion.

- [ ] **Step 3: Implement**

In `backend/services/tools.js`, add the new declaration and handler right after `BOOK_TOUR_DECLARATION`'s closing `};` (after line 489), before `async function withAccessToken`:

```js
const OPEN_CALENDLY_SCHEDULER_DECLARATION = {
  name: 'open_calendly_scheduler',
  description:
    'Open an embedded Calendly scheduler so the visitor can pick a meeting time themselves. ' +
    "Call this only after you have the visitor's name and email — ask for both in one natural " +
    "message first if you don't have them yet. Never guess at availability or claim a specific " +
    'time is open; the scheduler is the source of truth.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "The visitor's full name." },
      email: { type: 'string', description: "The visitor's email address, to prefill the scheduler." },
      event_type: {
        type: 'string',
        description:
          'Which configured meeting type to open, matched by label (e.g. "demo"). Omit to use ' +
          "the tenant's default.",
      },
    },
    required: ['name', 'email'],
  },
};

function handleOpenCalendlyScheduler(args, calendly) {
  const name = String(args?.name || '').trim();
  const email = String(args?.email || '').trim();
  if (!name) return { error: 'name is required' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'A valid email is required' };

  const eventTypes = calendly?.eventTypes || [];
  if (!eventTypes.length) return { error: 'Scheduling is not available right now.' };

  const requested = String(args?.event_type || '').trim().toLowerCase();
  const match = (requested && eventTypes.find(e => e.label.toLowerCase().includes(requested))) || eventTypes[0];

  return { url: match.url, label: match.label, name, email };
}
```

Replace `tourBookingTools` and its doc comment (lines 575-595):

```js
const BOTH_PROVIDERS_NOTE =
  " This project also offers another booking method — ask the visitor which they'd prefer before calling either tool.";

/**
 * Returns { declarations, dispatch } for this project's active booking
 * tools. Google Calendar (check_availability/book_tour) and Calendly
 * (open_calendly_scheduler) are independent — a project can have either,
 * both, or neither. Both still require the advanced tier. When both are
 * active, each declaration gets one extra sentence appended to its
 * description steering the model to ask the visitor's preference; that's
 * done on COPIES of the shared declaration consts (never in-place
 * mutation), since those consts are shared across every project's calls
 * into this function.
 */
async function tourBookingTools(project) {
  if (!meetsTier(project.capabilityTier, 'advanced')) return { declarations: [], dispatch: {} };
  const tourSettings = project.tourSettings || {};
  const parts = [];

  if (tourSettings.enabled) {
    const connection = await db.findOne('calendarConnections', { projectId: project.id });
    if (connection) {
      parts.push({
        declarations: [CHECK_AVAILABILITY_DECLARATION, BOOK_TOUR_DECLARATION],
        dispatch: {
          check_availability: (args) => handleCheckAvailability(args, project, tourSettings, connection),
          book_tour: (args) => handleBookTour(args, project, tourSettings, connection),
        },
      });
    }
  }

  const calendly = tourSettings.calendly;
  if (calendly?.enabled && calendly.eventTypes?.length) {
    parts.push({
      declarations: [OPEN_CALENDLY_SCHEDULER_DECLARATION],
      dispatch: { open_calendly_scheduler: (args) => handleOpenCalendlyScheduler(args, calendly) },
    });
  }

  let declarations = parts.flatMap(p => p.declarations);
  if (parts.length === 2) {
    declarations = declarations.map(d => ({ ...d, description: d.description + BOTH_PROVIDERS_NOTE }));
  }

  return {
    declarations,
    dispatch: Object.assign({}, ...parts.map(p => p.dispatch)),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/services/tools.test.js`
Expected: PASS (all tests in the file, including the pre-existing Google-only tour-booking tests, which must keep passing unchanged)

- [ ] **Step 5: Commit**

```bash
git add backend/services/tools.js backend/services/tools.test.js
git commit -m "$(cat <<'EOF'
Add open_calendly_scheduler as an independent booking tool

Google Calendar and Calendly booking are now decoupled in
tourBookingTools -- a project can run either, both, or neither. When
both are active, the model is nudged to ask the visitor's preference.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Dashboard UI — Calendly settings in the Tours tab

**Files:**
- Modify: `public/project.html:952-953` (insert new HTML card), `:2650-2685` (`loadTourSettings`/save handler), and the Tours JS section starting at `:2555` (new state/render/listeners)

There's no existing test harness for `project.html`'s vanilla JS (the pre-existing Tours tab has none either), so this task is verified manually in Step 3 instead of via an automated test.

- [ ] **Step 1: Add the Calendly settings card HTML**

In `public/project.html`, insert a new card between the existing "Google Calendar" card (which closes at line 952) and the "Tour settings" card (which starts at line 954):

```html
      <div class="card mt-md">
        <h2 class="card-title mb-md">Calendly</h2>
        <div class="col gap-md">
          <div class="field">
            <label>Calendly scheduling</label>
            <select class="select" id="f-calendly-enabled">
              <option value="false">Disabled (default)</option>
              <option value="true">Enabled — the AI can open a Calendly scheduler for the visitor</option>
            </select>
          </div>
          <div id="calendly-settings-detail" style="display:none" class="col gap-md">
            <div class="field">
              <label>Event types</label>
              <span class="help">The first one is the default; the AI uses a later one when the visitor names it (e.g. "demo").</span>
              <div class="col gap-sm" id="f-calendly-types"></div>
              <button class="btn btn-sm btn-ghost" type="button" id="calendly-add-type-btn">+ Add event type</button>
            </div>
          </div>
        </div>
      </div>
```

- [ ] **Step 2: Add the Calendly JS — state, render, listeners, load/save wiring**

In `public/project.html`, right after the `let tourWorkingHours = ...` declaration (line 2557), add:

```js
let calendlyEventTypes = [];

function renderCalendlyTypes() {
  const wrap = document.getElementById('f-calendly-types');
  wrap.innerHTML = calendlyEventTypes.map((et, i) => `
    <div class="row" style="gap:8px;align-items:center" data-idx="${i}">
      <input class="input" data-role="label" placeholder="Label, e.g. Demo" style="width:160px" value="${(et.label || '').replace(/"/g, '&quot;')}" />
      <input class="input" data-role="url" placeholder="https://calendly.com/you/event" style="flex:1" value="${(et.url || '').replace(/"/g, '&quot;')}" />
      <button class="btn btn-sm btn-ghost" type="button" data-action="remove-calendly-type" data-idx="${i}">Remove</button>
    </div>
  `).join('') || '<span class="help">No event types added</span>';
}

document.getElementById('calendly-add-type-btn').addEventListener('click', () => {
  if (calendlyEventTypes.length >= 10) return;
  calendlyEventTypes.push({ label: '', url: '' });
  renderCalendlyTypes();
});

document.getElementById('f-calendly-types').addEventListener('click', (e) => {
  const removeBtn = e.target.closest('[data-action="remove-calendly-type"]');
  if (!removeBtn) return;
  calendlyEventTypes.splice(Number(removeBtn.dataset.idx), 1);
  renderCalendlyTypes();
});

document.getElementById('f-calendly-types').addEventListener('change', (e) => {
  const row = e.target.closest('[data-idx]');
  if (!row || !e.target.dataset.role) return;
  calendlyEventTypes[Number(row.dataset.idx)][e.target.dataset.role] = e.target.value.trim();
});

document.getElementById('f-calendly-enabled').addEventListener('change', (e) => {
  document.getElementById('calendly-settings-detail').style.display = e.target.value === 'true' ? '' : 'none';
});
```

Replace `loadTourSettings` (lines 2650-2664):

```js
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

  const calendly = ts.calendly || {};
  document.getElementById('f-calendly-enabled').value = String(calendly.enabled === true);
  document.getElementById('calendly-settings-detail').style.display = calendly.enabled === true ? '' : 'none';
  calendlyEventTypes = (calendly.eventTypes || []).map(et => ({ label: et.label, url: et.url }));
  renderCalendlyTypes();

  await refreshCalendarStatus();
}
```

Replace the `tours-save-btn` click handler (lines 2666-2685):

```js
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
    calendly: {
      enabled: document.getElementById('f-calendly-enabled').value === 'true',
      eventTypes: calendlyEventTypes.filter(et => et.label.trim() && et.url.trim()),
    },
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
```

- [ ] **Step 3: Manually verify**

Run: `npm start` (or however the dev server is normally started — check for a running instance first)

1. Open a project on the `advanced` tier, go to the Tours tab.
2. Confirm the new "Calendly" card renders between "Google Calendar" and "Tour settings", toggle is "Disabled" by default, and the detail section is hidden.
3. Set it to "Enabled", click "+ Add event type" twice, fill in two label/URL pairs (one with a `calendly.com` URL), click "Remove" on one row and confirm it disappears, click "Save tour settings".
4. Reload the page, reopen the Tours tab — confirm the enabled state and the remaining event type row(s) persist with the values you entered.
5. Try saving with a non-`calendly.com` URL in a row — confirm the server rejects it and `tours-save-error` shows the Zod message.

- [ ] **Step 4: Commit**

```bash
git add public/project.html
git commit -m "$(cat <<'EOF'
Add Calendly settings to the Tours tab

Owner can independently enable Calendly and configure named event
types, saved alongside the existing tour-booking settings.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Widget rendering — embedded Calendly scheduler card

**Files:**
- Modify: `public/embed.html:1290-1303` (the `toolCalls` loop) and add a new render function near `renderWhiteboardCard` (after line 1375)
- Modify: `public/css/embed.css` (append new rules near the board-card CSS, after line 555)

No automated test harness exists for `embed.html` either (same as the pre-existing whiteboard rendering) — verified manually in Step 4.

- [ ] **Step 1: Add the tool-call branch and render function**

In `public/embed.html`, inside the `for (const call of data.toolCalls || [])` loop (lines 1292-1303), add a new branch after the `explain_visually` one:

```js
      for (const call of data.toolCalls || []) {
        const topic = call.args && call.args.topic;
        if (call.name === 'generate_quiz' && call.result && call.result.questions) {
          for (const q of call.result.questions) renderQuizCard(q, topic, data.sources || []);
        }
        if (call.name === 'generate_flashcards' && call.result && call.result.cards) {
          for (const c of call.result.cards) renderFlashcard(c, topic, data.sources || []);
        }
        if (call.name === 'explain_visually' && call.result && call.result.board) {
          renderWhiteboardCard(call.result.board);
        }
        if (call.name === 'open_calendly_scheduler' && call.result && call.result.url) {
          renderCalendlySchedulerCard(call.result);
        }
      }
```

Right after `renderWhiteboardCard`'s closing `}` (after line 1375), add the loader and render function:

```js
  // Lazy-loads Calendly's inline-widget script/stylesheet once per widget
  // session (not unconditionally in <head> — only a visitor who actually
  // triggers open_calendly_scheduler ever fetches these). The cached
  // promise means a second scheduler card in the same conversation reuses
  // the same load instead of re-fetching or double-injecting the script.
  let calendlyLoadPromise = null;
  function loadCalendlyAssets() {
    if (calendlyLoadPromise) return calendlyLoadPromise;
    calendlyLoadPromise = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://assets.calendly.com/assets/external/widget.css';
      document.head.appendChild(link);

      const script = document.createElement('script');
      script.src = 'https://assets.calendly.com/assets/external/widget.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Calendly'));
      document.head.appendChild(script);
    });
    return calendlyLoadPromise;
  }

  // Renders an embedded Calendly scheduler for the open_calendly_scheduler
  // tool result. Follows renderWhiteboardCard's card structure, but the
  // body is an empty container Calendly's own widget draws into, rather
  // than content built from the model's response.
  async function renderCalendlySchedulerCard({ url, label, name, email }) {
    const card = document.createElement('div');
    card.className = 'quiz-card calendly-card';

    const tag = document.createElement('div');
    tag.className = 'quiz-origin';
    tag.textContent = '📅 Scheduler';
    card.appendChild(tag);

    const title = document.createElement('div');
    title.className = 'quiz-question';
    title.textContent = label ? `Scheduler: ${label}` : 'Scheduler';
    card.appendChild(title);

    const container = document.createElement('div');
    container.className = 'calendly-inline-container';
    card.appendChild(container);

    messagesEl.appendChild(card);
    requestAnimationFrame(() => card.classList.add('visible'));
    scrollToBottom();

    try {
      await loadCalendlyAssets();
      window.Calendly.initInlineWidget({ url, parentElement: container, prefill: { name, email } });
    } catch (e) {
      container.textContent = 'Could not load the scheduler — please try again in a moment.';
    }
  }
```

- [ ] **Step 2: Add CSS for the Calendly card**

In `public/css/embed.css`, append after the existing "Explanation board" section (after line 555, before "Quick-reply buttons"):

```css
/* ── Calendly scheduler card (the open_calendly_scheduler tool) ──── */
.calendly-card { width: 100%; max-width: 100%; }
.calendly-inline-container { width: 100%; min-width: 280px; height: 630px; margin-top: 4px; }
```

- [ ] **Step 3: Check for pre-existing unrelated diff before committing**

`public/css/embed.css` already has an unrelated uncommitted diff (an avatar-canvas transparency fix). Run `git diff public/css/embed.css` and confirm the only new lines are the `.calendly-card`/`.calendly-inline-container` rules just added — the pre-existing `.avatar-stage` hunk should still be present but untouched.

- [ ] **Step 4: Manually verify**

Run: `npm start` (or use whatever is already running), then open the embed widget for a project with `tourSettings.calendly.enabled: true` and at least one event type saved from Task 5.

1. Ask the widget's chatbot to "book a meeting" — confirm it asks for your name and email if it doesn't have them.
2. After providing name/email, confirm a card titled "Scheduler: {label}" appears with the Calendly scheduler loaded inline inside it (check the Network tab for `widget.js`/`widget.css` requests — they should fire once, only after this point, not at initial page load).
3. Trigger a second scheduler card in the same conversation (e.g. ask again) — confirm no duplicate `<script>`/`<link>` tags are added (inspect `document.head`) and the second card still renders correctly.
4. If a Google Calendar connection is also enabled for the same project, ask to book a meeting and confirm the assistant asks which method you'd prefer.

- [ ] **Step 5: Commit (feature hunks only in embed.css — see the note at the top of this plan)**

```bash
git add public/embed.html
git add -p public/css/embed.css
# Select only the new .calendly-card / .calendly-inline-container hunk —
# leave the pre-existing .avatar-stage transparency hunk unstaged.
git diff --cached  # confirm only the intended hunk is staged
git commit -m "$(cat <<'EOF'
Render an embedded Calendly scheduler card in the chat widget

open_calendly_scheduler results open an inline Calendly widget, lazy-
loading Calendly's script/stylesheet only when a visitor actually
triggers it.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Post-implementation check

After all six tasks are committed, run the full backend test suite once to confirm nothing else regressed:

```bash
npm test
```

Expected: all tests pass, including every file touched above plus everything untouched.
