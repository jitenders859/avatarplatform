-- ═══════════════════════════════════════════════════════════════════
-- Migration: Web search grounding — search_web tool support.
-- See docs/superpowers/specs/2026-09-05-web-search-grounding-design.md
-- and backend/services/searchWeb.js.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already applied to
-- schema.sql; this file is a standalone, dated record of *why* it was
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-09-05_add_web_search.sql
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE projects ADD COLUMN IF NOT EXISTS web_search_enabled BOOLEAN DEFAULT false;
ALTER TABLE usage    ADD COLUMN IF NOT EXISTS web_searches       INTEGER DEFAULT 0;
