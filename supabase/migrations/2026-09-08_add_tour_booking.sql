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

-- refresh_token/access_token are plaintext columns — there is no
-- app-level encryption-at-rest anywhere in this codebase yet (same
-- precedent as projects.webhook_secret), and this is a deliberate,
-- documented choice, not an oversight: see the security note in
-- docs/superpowers/specs/2026-09-08-google-calendar-tour-booking-design.md.
-- A Google refresh token is a materially more sensitive credential than
-- anything else stored this way — it is standing access to the owner's
-- real Google account, scoped to calendar.events only.
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
