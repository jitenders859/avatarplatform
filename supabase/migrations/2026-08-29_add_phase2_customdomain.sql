-- ═══════════════════════════════════════════════════════════════════
-- Migration: Phase 2 white-labeling — see
-- docs/competitor-feature-implementation-plan.md Phase 2 (2b).
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statement below is already appended to
-- schema.sql; this file is a standalone, dated record of *why* it was
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-29_add_phase2_customdomain.sql
-- ═══════════════════════════════════════════════════════════════════

-- 2b. White-labeling — Business-plan owners can record a custom domain for
-- their widget/embed. NOTE: this column only stores the value; there is no
-- reverse-proxy/DNS-verification/TLS-provisioning behind it yet (that's a
-- separate, larger infra project — see the plan doc). Setting it today is
-- informational only, gated server-side to the Business plan in
-- backend/routes/projects.js.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS custom_domain TEXT;
