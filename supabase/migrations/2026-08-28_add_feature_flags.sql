-- ═══════════════════════════════════════════════════════════════════
-- Migration: Feature-flag infrastructure (infra only — see
-- docs/admin-panel-implementation-plan.md section 5e). No feature in the
-- codebase is gated behind a flag yet; an empty flag list is expected.
-- See backend/services/featureFlags.js.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statement below is already appended to
-- schema.sql; this file is a standalone, dated record of *why* it was
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-28_add_feature_flags.sql
-- ═══════════════════════════════════════════════════════════════════

-- One row per admin-defined flag. Unlike admin_settings (fixed env-var
-- keys), flags are created ad hoc from the admin panel — see
-- featureFlags.js createFlag. App code reads via isEnabled(key) with the
-- same short-TTL in-process cache pattern as settings.js.
CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT    PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  updated_at  BIGINT  NOT NULL,
  updated_by  UUID    REFERENCES admin_users(id) ON DELETE SET NULL
);
