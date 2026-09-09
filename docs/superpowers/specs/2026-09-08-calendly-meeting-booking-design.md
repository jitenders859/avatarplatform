# Calendly Meeting Booking — Design

Date: 2026-09-08

## Overview

Extends the existing Google Calendar tour-booking feature
([2026-09-08-google-calendar-tour-booking-design.md](2026-09-08-google-calendar-tour-booking-design.md))
with a second, independent booking method: Calendly. An owner can enable
either method, both, or neither, on the same Tours tab. When a visitor
wants to book and both are enabled, the AI asks which they'd prefer;
Google Calendar bookings get a real, auto-generated Google Meet link.

Calendly requires no OAuth and no API calls — the owner pastes public
Calendly scheduling link(s), and the AI opens an embedded Calendly widget
in the chat when the visitor wants to book. Calendly's own page is the
source of truth for availability and the booking itself; this app never
queries or stores anything about the booking.

## 1. Google Meet link on existing bookings

`backend/services/googleCalendar.js`'s `insertEvent` (line 170) adds a
conference-creation request to the event body and asks the Calendar API
to fulfil it:

```js
async function insertEvent(accessToken, { summary, description, location, startISO, endISO, attendeeEmail }) {
  const res = await fetch(`${EVENTS_URL}?sendUpdates=all&conferenceDataVersion=1`, {
    ...
    body: JSON.stringify({
      summary, description,
      location: location || undefined,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees: [{ email: attendeeEmail }],
      conferenceData: {
        createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
      },
    }),
    ...
  });
  ...
  return { id: body.id, meetLink: body.hangoutLink || null };
}
```

`insertEvent`'s return value changes from a bare id string to
`{ id, meetLink }` — its one caller, `handleBookTour` (tools.js line 543),
updates accordingly and adds `meetLink` to its return value:
`{ booked: true, startTime, calendarEventId, meetLink }`. `BOOK_TOUR_DECLARATION`'s
description gains a line telling the model to read the Meet link back to
the visitor when present. `meetLink` can come back `null` on Calendar API
edge cases (Google-side conferencing outage, or a Workspace admin policy
that disables Meet creation) — the model still confirms the booking, it
just has no link to relay; not a new error path, `location` remains
whatever the owner configured as an additional/fallback point of
contact.

## 2. Data model — extend `tourSettings`, no migration

`tourSettings.calendly` is a new optional key inside the existing jsonb
column (`projects.tour_settings`), independent of `tourSettings.enabled`
(which continues to mean "Google Calendar booking is on"):

```js
tourSettings.calendly = {
  enabled: false,
  eventTypes: [
    { label: "15 min intro", url: "https://calendly.com/acme/intro" },
    { label: "Demo",         url: "https://calendly.com/acme/demo" },
  ],
}
```

No new column and no new migration — jsonb is schemaless, and both
`handleCheckAvailability`/`handleBookTour` and the new Calendly handler
already tolerate an absent/partial `tourSettings`. The first entry in
`eventTypes` is the default; there's no separate `isDefault` flag.

`backend/middleware/validate.js`'s `tourSettings` schema (line 101) gains:

```js
const calendlyEventType = z.object({
  label: z.string().trim().min(1).max(60),
  url: z.string().trim().url()
    .refine(v => {
      try { return new URL(v).hostname === 'calendly.com'; } catch { return false; }
    }, { message: 'url must be a calendly.com scheduling link' }),
});

// inside the tourSettings object:
calendly: z.object({
  enabled: z.boolean(),
  eventTypes: z.array(calendlyEventType).max(10),
}).optional(),
```

The hostname check is the security boundary: it stops an owner (or a
compromised owner session) from turning the booking widget into an
arbitrary-content iframe served to every visitor of the embed.

## 3. New tool: `open_calendly_scheduler`

Added to `backend/services/tools.js` alongside `CHECK_AVAILABILITY_DECLARATION`/
`BOOK_TOUR_DECLARATION`:

```js
const OPEN_CALENDLY_SCHEDULER_DECLARATION = {
  name: 'open_calendly_scheduler',
  description:
    "Open an embedded Calendly scheduler so the visitor can pick a meeting time themselves. " +
    "Call this only after you have the visitor's name and email — ask for both in one natural " +
    "message first if you don't have them yet. Never guess at availability or claim a specific " +
    "time is open; the scheduler is the source of truth.",
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "The visitor's full name." },
      email: { type: 'string', description: "The visitor's email address, to prefill the scheduler." },
      event_type: {
        type: 'string',
        description:
          "Which configured meeting type to open, matched by label (e.g. \"demo\"). Omit to use " +
          "the tenant's default.",
      },
    },
    required: ['name', 'email'],
  },
};
```

Handler does no network call — it resolves `event_type` against
`tourSettings.calendly.eventTypes` (case-insensitive substring match on
`label`, falling back to `eventTypes[0]`), validates `name`/`email` the
same way `handleBookTour` does, and returns the raw, unmodified event
URL plus the resolved name/email/label for the frontend to render:

```js
{ url: match.url, label: match.label, name, email }
```

Prefilling is done frontend-side via Calendly's documented JS embed API
(`Calendly.initInlineWidget({ url, prefill: { name, email } })`), not by
hand-building query-string parameters — Calendly's own docs describe
`prefill` as a field passed to that JS call, not a documented raw URL
query-string contract, so guessing at param names here would be building
on an unstable/undocumented surface. See Section 4.

### Gating: decoupling Google and Calendly in `tourBookingTools`

Today, `tourBookingTools` (tools.js line 581) returns empty for
*everything* unless `tourSettings.enabled` and a Google connection both
exist. That's wrong once Calendly is independent — an owner should be
able to run Calendly-only with Google Calendar never connected. It's
restructured to build each provider's contribution separately and merge:

```js
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

  // When both providers are active, append one line to each declaration's
  // description steering the model to ask the visitor's preference first,
  // rather than picking silently.
  if (parts.length === 2) { /* append the note to both descriptions here */ }

  return {
    declarations: parts.flatMap(p => p.declarations),
    dispatch: Object.assign({}, ...parts.map(p => p.dispatch)),
  };
}
```

`open_calendly_scheduler` is added to `validate.js`'s `RESERVED_ACTION_NAMES`
(line 125) alongside `check_availability`/`book_tour`, for the same
collision reason already documented there.

## 4. Widget rendering

`public/embed.html`'s function-call result handling (around line 1300,
next to the `explain_visually`/`renderWhiteboardCard` branch) gets a
matching branch:

```js
if (call.name === 'open_calendly_scheduler' && call.result && call.result.url) {
  renderCalendlySchedulerCard(call.result);
}
```

`renderCalendlySchedulerCard({ url, label, name, email })` follows
`renderWhiteboardCard`'s existing card structure (`.quiz-card`, a
tag/title header) but its body is an empty container div instead of a
node list, sized similarly to the whiteboard card, with a "Scheduler:
{label}" title. Once that container is in the DOM, it calls Calendly's
inline-widget API against it:

```js
Calendly.initInlineWidget({
  url,
  parentElement: container,
  prefill: { name, email },
});
```

This requires Calendly's widget script/stylesheet
(`https://assets.calendly.com/assets/external/widget.js` + `widget.css`).
Rather than adding a new field to `/embed/:publicId/config` just to gate a
`<head>`-level `<script>` tag (`tourSettings` isn't exposed there today,
and nothing else about this feature needs it to be), `renderCalendlySchedulerCard`
lazy-loads both files itself the first time it's ever called in a given
widget session, caching the loading promise so a second `open_calendly_scheduler`
call in the same conversation reuses it instead of re-fetching. Simpler
than a config round-trip, and it only ever fetches Calendly's assets for a
visitor who actually triggers the tool.

## 5. Dashboard UI

`public/project.html`'s Tours tab (from line 939) gains a new block below
the existing Google Calendar connect section and above "Tour settings",
titled "Calendly" — independent enable toggle (`f-calendly-enabled`) and
a repeatable label/URL row list (`f-calendly-types`, add/remove buttons),
mirroring the existing per-weekday working-hours row pattern
(`renderTourHours`, line 2571) rather than introducing a new UI pattern.

Folded into the existing "Save tour settings" button/payload
(`tours-save-btn`, line 2666) — the `tourSettings` object it PATCHes
gains the `calendly` key alongside the existing fields. No new endpoint.

## Error handling

- **Bad/missing Calendly config at call time**: if `calendly.eventTypes`
  is empty when the tool is dispatched (settings changed mid-conversation
  in another tab — same class of race the original spec already accepts
  for Google), the handler returns `{ error: 'Scheduling is not available right now.' }`.
- **`event_type` doesn't match any configured label**: falls back to the
  default (`eventTypes[0]`) silently — better UX than erroring on a model
  guessing a slightly-off label.
- **Google Meet link creation fails Calendar-side**: `meetLink` comes
  back `null`; the booking itself still succeeds (see Section 1) — this
  is not treated as a booking failure.

## Explicitly out of scope (this feature)

- **Calendly API/webhook integration** — no OAuth, no fetching real
  Calendly availability into our own UI, no receiving booking-confirmed
  webhooks from Calendly. The embed is Calendly's own page; this app
  never learns whether the visitor actually booked.
- **Custom-domain Calendly links** (e.g. a Calendly Enterprise account on
  a branded subdomain) — only `calendly.com` links are accepted, per the
  hostname validation in Section 2.
- Everything already out of scope in the original tour-booking spec
  (cancel/reschedule UI, dashboard bookings list, multiple owners/calendars,
  holiday exceptions) remains out of scope here too.

## Testing plan

- `googleCalendar.test.js`: `insertEvent` sends `conferenceDataVersion=1`
  and the right `conferenceData` body; returns `{ id, meetLink }` parsed
  from a mocked response both with and without `hangoutLink` present.
- `tools.js` handler tests: `handleOpenCalendlyScheduler` — label
  matching (exact, substring, no-match-falls-back-to-default), empty
  `eventTypes` error path, returned `{ url, label, name, email }` shape.
- `tourBookingTools` tests: Google-only enabled, Calendly-only enabled,
  both enabled (asserting the merged declarations/dispatch and the
  both-active description note), neither enabled.
- `validate.js` schema tests: rejects a non-`calendly.com` URL, rejects
  more than 10 event types, accepts a valid config.
