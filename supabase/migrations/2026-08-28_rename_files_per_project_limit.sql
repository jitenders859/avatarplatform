-- ═══════════════════════════════════════════════════════════════════
-- Migration: Rename the `filesPerProject` plan-limit key to `maxFiles`.
--
-- The limit was always enforced as a user-wide file total across every one
-- of the owner's projects (services/usage.js sums files via a JOIN across
-- all of a user's projects, not scoped to one project), and the customer-
-- facing UI already labels it "Files (across all)" (billing.html) — only
-- the internal key name claimed a per-project semantic it never had. This
-- renames the key everywhere (backend/plans.js, admin custom tiers) rather
-- than implementing a real per-project cap, since the shipped product
-- promise was already "across all projects."
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth; this file additionally repairs the JSONB key
-- name in any custom tiers an admin already created via the admin panel
-- (backend/plans.js's built-in plans are code, not rows, so they don't
-- need a data migration — only the code rename in plans.js matters there):
--   psql $DATABASE_URL -f supabase/migrations/2026-08-28_rename_files_per_project_limit.sql
-- ═══════════════════════════════════════════════════════════════════

UPDATE plan_tiers
   SET limits = (limits - 'filesPerProject') || jsonb_build_object('maxFiles', limits->'filesPerProject')
 WHERE limits ? 'filesPerProject';
