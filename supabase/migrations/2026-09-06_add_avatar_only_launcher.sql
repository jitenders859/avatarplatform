-- ═══════════════════════════════════════════════════════════════════
-- Migration: Avatar-only launcher mode, expanded widget anchor points,
-- and a proactive greeting bubble.
-- See public/js/embed-loader.js, public/embed.html, and public/project.html
-- (Widget / Avatar placement tabs).
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already applied to
-- schema.sql; this file is a standalone, dated record of *why* it was
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-09-06_add_avatar_only_launcher.sql
--
-- Note: widget_position already accepted arbitrary TEXT (no DB-level CHECK
-- constraint) — the new anchor values ('top-left', 'top-right',
-- 'middle-left', 'middle-right') are validated at the application layer
-- (backend/middleware/validate.js) only, so no column change is needed here.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE projects ADD COLUMN IF NOT EXISTS avatar_launcher_style      TEXT    DEFAULT 'bubble';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS proactive_greeting_enabled BOOLEAN DEFAULT false;
