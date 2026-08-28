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
  limits      JSONB       NOT NULL,      -- { projects, maxFiles, storageMb, monthlyMessages, monthlyEmbeddingChars, urlSources }
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

-- ── Schema evolution: post-review fixes ──────────────────────────
-- CREATE TABLE IF NOT EXISTS above won't change columns/constraints on a
-- database that already ran the (pre-fix) statements above, so these
-- ALTERs converge such a database; they're no-ops against a fresh one
-- created straight from the corrected statements below.
--
-- admin_audit_log.target_user_id had no ON DELETE action (defaulted to
-- NO ACTION), which blocks deleting a user who has any audit-log row
-- referencing them — including the admin delete-user flow itself (it
-- logs a 'delete_user' row for the user, then tries to delete that same
-- user) and the already-shipped self-serve DELETE /api/auth/me for any
-- user who was ever suspended/tier-assigned/impersonated. ON DELETE
-- SET NULL keeps the audit trail (the row survives) without blocking
-- the delete.
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_target_user_id_fkey;
ALTER TABLE admin_audit_log
  ADD CONSTRAINT admin_audit_log_target_user_id_fkey
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- target_email: denormalized so an audit row stays self-describing (who
-- was acted on) even after target_user_id goes NULL because the target
-- user was deleted — the join alone can no longer answer that. Populated
-- by the audit-log service (later task); nullable here since older/
-- pre-existing rows won't be backfilled.
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS target_email TEXT;

-- plan_tiers.created_by / admin_audit_log.admin_id both referenced
-- admin_users(id) with no ON DELETE action either, meaning an admin
-- account could never be removed once it created a tier or logged any
-- action — including the plan's own documented step of deleting the
-- test admin account after verification. ON DELETE SET NULL frees the
-- admin account for deletion while leaving the tier/audit row intact.
-- admin_id must be made nullable first — a nullable FK target needs a
-- nullable column.
ALTER TABLE plan_tiers DROP CONSTRAINT IF EXISTS plan_tiers_created_by_fkey;
ALTER TABLE plan_tiers
  ADD CONSTRAINT plan_tiers_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE admin_audit_log ALTER COLUMN admin_id DROP NOT NULL;
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_admin_id_fkey;
ALTER TABLE admin_audit_log
  ADD CONSTRAINT admin_audit_log_admin_id_fkey
  FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE SET NULL;

-- admin_users.updated_at: this repo's db.update() helper unconditionally
-- injects updated_at into every UPDATE; every other mutable table already
-- has this column. Without it, any future admin-account-update code
-- hard-fails with a missing-column error.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS updated_at BIGINT;

-- Tier-delete "is this tier still in use" lookup (SELECT 1 FROM users
-- WHERE admin_plan_id = $1 LIMIT 1) — partial index since most users
-- have admin_plan_id NULL (no admin override).
CREATE INDEX IF NOT EXISTS idx_users_admin_plan_id ON users(admin_plan_id) WHERE admin_plan_id IS NOT NULL;
