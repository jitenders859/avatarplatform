-- ═══════════════════════════════════════════════════════════════════
-- Migration: Admin panel — user management, custom limit tiers,
-- suspend/delete, impersonation. See
-- docs/superpowers/specs/2026-08-08-admin-panel-design.md.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already appended to
-- schema.sql; this file is a standalone, dated record of *why* they were
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-08_add_admin_panel.sql
-- ═══════════════════════════════════════════════════════════════════

-- ── admin_users ───────────────────────────────────────────────────
-- Fully separate from the customer `users` table/auth path by design.
-- No self-serve signup; seeded via backend/scripts/create-admin.js.
CREATE TABLE IF NOT EXISTS admin_users (
  id            UUID        PRIMARY KEY,
  email         TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    BIGINT      NOT NULL
);

-- ── plan_tiers ────────────────────────────────────────────────────
-- Admin-defined limit sets, independent of the static PLANS array in
-- backend/plans.js (those stay code-defined since they're tied to real
-- Stripe price IDs). A user's `admin_plan_id` (see below) points here.
CREATE TABLE IF NOT EXISTS plan_tiers (
  id          TEXT        PRIMARY KEY,   -- slug, e.g. "custom-acme-corp-a1b2c3"
  name        TEXT        NOT NULL,
  limits      JSONB       NOT NULL,      -- { projects, filesPerProject, storageMb, monthlyMessages, monthlyEmbeddingChars, urlSources }
  created_by  UUID        REFERENCES admin_users(id),
  created_at  BIGINT      NOT NULL,
  updated_at  BIGINT
);

-- ── users: suspension + admin plan override ──────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_plan_id   TEXT REFERENCES plan_tiers(id);

-- ── admin_audit_log ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id              UUID    PRIMARY KEY,
  admin_id        UUID    NOT NULL REFERENCES admin_users(id),
  action          TEXT    NOT NULL,   -- 'suspend' | 'unsuspend' | 'assign_tier' | 'clear_tier' | 'delete_user' | 'impersonate' | 'tier_create' | 'tier_update' | 'tier_delete'
  target_user_id  UUID    REFERENCES users(id),
  meta            JSONB,
  created_at      BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log (created_at DESC);
