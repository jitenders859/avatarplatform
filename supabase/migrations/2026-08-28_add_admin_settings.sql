-- ═══════════════════════════════════════════════════════════════════
-- Migration: Admin-configurable model settings (Gemini API keys, study
-- model) so an operator can rotate them from the admin panel instead of
-- editing .env and redeploying. See backend/services/settings.js.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statement below is already appended to
-- schema.sql; this file is a standalone, dated record of *why* it was
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-28_add_admin_settings.sql
-- ═══════════════════════════════════════════════════════════════════

-- One row per overridable env var. A present row wins over process.env for
-- that key (see settings.js getSetting); deleting the row reverts to
-- whatever's in .env with no redeploy needed either way.
CREATE TABLE IF NOT EXISTS admin_settings (
  key         TEXT    PRIMARY KEY,
  value       TEXT    NOT NULL,
  updated_at  BIGINT  NOT NULL,
  updated_by  UUID    REFERENCES admin_users(id) ON DELETE SET NULL
);
