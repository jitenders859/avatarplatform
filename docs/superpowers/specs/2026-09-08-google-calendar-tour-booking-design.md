# Google Calendar Tour Booking — Design

Date: 2026-09-08

## Overview

Widget visitors chatting with a project's embedded AI avatar can book a
tour with that project's owner, directly inside the conversation. The AI
checks the owner's real Google Calendar availability, then books the
confirmed slot as a calendar event with the visitor as an attendee.

This is a per-project feature (not a platform marketing/sales feature) —
each project owner connects their own Google Calendar, independent of
other projects. Gated to the `advanced` capability tier, same class as
`generate_quiz`/`generate_flashcards`.

## Data model

### New table `calendar_connections` (1:1 with `projects`)

```
id                        uuid, pk
project_id                uuid, fk -> projects.id, unique
google_email              text
refresh_token             text
access_token              text
access_token_expires_at   bigint (epoch ms)
created_at                bigint
updated_at                bigint
```

Tokens are stored as plaintext columns. This matches the existing
convention in this codebase — `projects.webhook_secret` is also a
plaintext column, and there is no app-level encryption-at-rest
infrastructure anywhere currently (see `backend/services/settings.js`,
which stores admin-configured API keys the same way). A Google refresh
token is a meaningfully more sensitive credential than anything currently
stored this way — it is standing access to the owner's actual Google
account/calendar (scoped to `calendar.events` only, not full `calendar`,
so it can't read or modify the owner's other events). Flagging this
explicitly, the way `backend/services/oidc.js` flags its own auth code
with a security note, rather than treating it as a solved problem.

Unlike `webhookSecret` (which the project GET endpoint returns to the
owner because they need it client-side to verify HMAC signatures), **the
raw tokens in `calendar_connections` are never returned by any API
response.** Only connection status is exposed:
`GET /api/projects/:projectId/calendar/status` → `{ connected, googleEmail }`.

### New column `projects.tour_settings` (jsonb)

Follows the existing pattern of JSONB config columns in this codebase
(e.g. `captureFields.parameters`, `projectActions.parameters`).

```js
{
  enabled: false,
  durationMinutes: 30,
  timezone: "America/New_York",   // IANA tz name
  bufferMinutes: 15,
  location: "",                   // free text: address or meeting link,
                                   // included in the calendar event
  workingHours: {
    // per-weekday, 24h "HH:MM" pairs, in `timezone` above.
    // empty array = day off.
    mon: [{ start: "09:00", end: "17:00" }],
    tue: [{ start: "09:00", end: "17:00" }],
    wed: [{ start: "09:00", end: "17:00" }],
    thu: [{ start: "09:00", end: "17:00" }],
    fri: [{ start: "09:00", end: "17:00" }],
    sat: [],
    sun: [],
  },
}
```

### Migration

New file `supabase/migrations/2026-09-08_add_tour_booking.sql`:
- `CREATE TABLE calendar_connections (...)` with FK + unique index on
  `project_id`
- `ALTER TABLE projects ADD COLUMN tour_settings jsonb NOT NULL DEFAULT '{"enabled":false,...}'::jsonb`

## OAuth connection flow

New routes in `backend/routes/googleCalendarAuth.js`, mounted at
`/api/projects/:projectId/calendar`, all behind `authRequired` +
`ownsProject` (reusing the same ownership-check pattern as
`captureFields.js`):

- `GET /connect` — redirects to Google's OAuth consent screen
  (`response_type=code`, `scope=https://www.googleapis.com/auth/calendar.events`,
  `access_type=offline`, `prompt=consent` to guarantee a refresh token,
  `state` = signed projectId to prevent CSRF/mismatched callbacks)
- `GET /callback` — exchanges the code for tokens via Google's token
  endpoint, upserts the `calendar_connections` row, redirects back to the
  dashboard's Tours settings tab
- `DELETE /` — deletes the `calendar_connections` row (disconnect)
- `GET /status` — `{ connected: boolean, googleEmail: string|null }`

Requires new env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_CALENDAR_REDIRECT_URI`. These must be provisioned manually in
Google Cloud Console (OAuth consent screen + credentials) before this
feature works in any environment — not something this implementation can
set up.

### `backend/services/googleCalendar.js`

Hand-rolled REST client built on the existing `safeFetch` service, not
the `googleapis` npm package. This follows the precedent set by
`backend/services/oidc.js`, which explicitly hand-rolls OAuth against
Node's built-in `fetch`/`crypto` rather than adding a library dependency,
reasoning that no such library was already a dependency and an unverified
library API is its own risk. Google's OAuth2 + Calendar v3 API is simpler
than generic OIDC here — fixed, well-documented endpoints, no discovery
step — so the same reasoning applies more easily.

Exports:
- `exchangeCode(code)` → `{ refreshToken, accessToken, expiresAt, googleEmail }`
- `getValidAccessToken(connection)` → refreshes via the refresh token if
  `access_token_expires_at` has passed, persists the new access token,
  returns a usable token. Throws a typed error (`invalid_grant`) if the
  refresh token itself has been revoked.
- `freeBusy(accessToken, timeMin, timeMax)` → busy intervals
- `insertEvent(accessToken, { summary, description, location, start, end, attendeeEmail })`
  → created event id, with `sendUpdates: 'all'` so Google emails the
  visitor an invite/confirmation automatically.

## AI tools

Two new entries in `backend/services/tools.js`'s `TOOL_DEFS`, both
`minTier: 'advanced'`. `toolsForTier` (or a new wrapper around it, called
from `embed.js` where the tool list is built) additionally checks that
the project has a `calendar_connections` row **and** `tour_settings.enabled`
before including these two declarations — same silent-omission behavior
tier-gating already has today, so the model is simply never offered a
capability that isn't actually configured.

### `check_availability(preferredDate, rangeDays?)`

- Computes candidate slots from `tour_settings` (`workingHours`,
  `durationMinutes`, `bufferMinutes`) for the requested date, extending
  up to `rangeDays` (default 1, max ~7) forward if the model is looking
  across a range.
- Calls `freeBusy` for that window, subtracts busy periods from the
  candidate slots.
- Returns open slots in the project's configured timezone, both as ISO
  timestamps and a human-readable label (e.g. `"Thursday Sep 10, 2:00 PM"`)
  so the model can speak them naturally without doing its own timezone
  math.
- If there's no connection or `tour_settings.enabled` is false, this tool
  isn't in the model's toolset — it can't be called.

### `book_tour(name, email, startTime)`

- Re-runs a freebusy check for the exact `[startTime, startTime + durationMinutes)`
  window immediately before booking — closes the race between
  `check_availability` and the visitor actually confirming, so two
  visitors can't both grab the same slot.
- If still free: calls `insertEvent` with the visitor as attendee,
  `summary: "Tour: {project name} — {visitor name}"`, description
  including the visitor's email, `location` from `tour_settings.location`.
  Returns `{ booked: true, startTime, calendarEventId }`.
- If the slot was taken in the interim: returns `{ error }` describing
  the conflict; the model relays this and is expected to call
  `check_availability` again (its tool description says so explicitly,
  same style as `explain_visually`'s proactive-use instructions).
- Nothing is persisted locally beyond what's needed for the API calls —
  Google Calendar is the source of truth, per explicit scope decision
  below.

Visitor name/email are collected as `book_tour` parameters, asked for
conversationally by the model as part of booking — independent of
whatever lead-capture fields (`captureFields`) the project has
configured. This keeps booking working even for projects with no capture
fields set up, at the cost of the visitor being asked twice if the
project *does* separately collect name/email via capture fields.

## Dashboard UI

New "Tours" tab in the project settings UI, alongside the existing tabs
(e.g. capture fields):

- "Connect Google Calendar" button → hits `/connect`; once connected,
  shows the linked `googleEmail` and a "Disconnect" button (→ `DELETE /`)
- Settings form bound to `tour_settings`: enable toggle, duration
  (minutes), timezone (dropdown of IANA names), buffer (minutes),
  location (text field), and a per-weekday working-hours editor
  (add/remove start–end pairs per day, matching the JSONB shape above)
- New Zod schema `schemas.tourSettings` in `backend/middleware/validate.js`,
  following the existing schema pattern in that file (e.g. bounding
  `durationMinutes`/`bufferMinutes` to sane ranges, validating `timezone`
  against `Intl.supportedValuesOf('timeZone')`, validating `HH:MM` time
  strings and `start < end` per working-hours entry)
- `PATCH /api/projects/:projectId/tour-settings` (or folded into the
  existing project PATCH endpoint — implementation detail for the plan)

## Error handling

- **Refresh token revoked/invalid**: Google returns `invalid_grant` on a
  refresh attempt (owner revoked access in their Google account, or
  disconnected elsewhere). `googleCalendar.js` surfaces this as a typed
  error; the caller deletes the stale `calendar_connections` row so the
  tools stop being offered to that project going forward. An in-flight
  `check_availability`/`book_tour` call that hits this mid-conversation
  returns `{ error: 'Tour booking is not available right now.' }`, which
  the model relays to the visitor.
- **Google API errors / rate limits**: `safeFetch` already provides
  timeout handling; any non-2xx response from a Calendar API call
  returns `{ error }` from the tool handler rather than throwing, so the
  model can apologize and suggest the visitor use the existing contact
  form instead.
- **Access token refresh**: handled transparently inside
  `getValidAccessToken` before any Calendar API call — callers never see
  an expired-token error under normal operation.

## Explicitly out of scope (v1)

- **Cancel/reschedule flow** — the visitor uses the emailed Google
  Calendar invite's own cancel/reschedule link (Google handles this
  natively via `sendUpdates: 'all'`); no custom UI or tool for it.
- **Dashboard bookings list** — no local persistence of bookings beyond
  the Calendar API calls themselves; Google Calendar is the owner's
  source of truth for what's booked.
- **Multiple calendars/owners per project** — one Google account
  connection per project; no support for a visitor choosing between
  several team members' calendars.
- **Holiday/one-off exceptions to working hours** — only the weekly
  recurring `workingHours` pattern is honored; no calendar-of-exceptions.

## Testing plan

- Unit tests for `googleCalendar.js`: token refresh logic (including the
  `invalid_grant` path), slot computation from `workingHours` +
  `durationMinutes` + `bufferMinutes` against a mocked freebusy response
  (edge cases: slot spanning a busy period, slot at the exact edge of
  working hours, day with empty `workingHours`).
- Route tests for the OAuth connect/callback/status/disconnect endpoints
  (mirroring the existing `*.test.js` pattern used across
  `backend/routes/`), including the ownership check and CSRF `state`
  validation.
- Tool-handler tests for `check_availability`/`book_tour`: tier gating,
  missing-connection omission, the re-check race-condition path in
  `book_tour` (slot taken between check and book).
