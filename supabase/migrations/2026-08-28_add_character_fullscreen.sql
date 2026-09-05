-- ═══════════════════════════════════════════════════════════════════
-- Migration: character-only fullscreen mode — lets a visitor click the
-- avatar (while the chat panel is open) to expand it to a chrome-free,
-- character-only fullscreen view. Opt-in per project; independent of the
-- existing full_screen_on_desktop/mobile + show_full_screen_toggle
-- fields, which control the whole *panel* going fullscreen, not the
-- character-only, chat-chrome-hidden mode this adds.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statement below is already appended to
-- schema.sql; this file is a standalone, dated record of *why* it was
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-28_add_character_fullscreen.sql
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE projects ADD COLUMN IF NOT EXISTS show_character_fullscreen BOOLEAN DEFAULT false;
