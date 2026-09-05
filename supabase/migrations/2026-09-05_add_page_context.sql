-- ═══════════════════════════════════════════════════════════════════
-- Migration: Page-content awareness — the embed widget can optionally
-- read the host page's visible content and answer questions about it.
-- See public/js/embed-loader.js, public/embed.html, and
-- backend/services/answerQuestion.js.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already applied to
-- schema.sql; this file is a standalone, dated record of *why* it was
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-09-05_add_page_context.sql
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE projects ADD COLUMN IF NOT EXISTS page_context_enabled BOOLEAN DEFAULT false;
