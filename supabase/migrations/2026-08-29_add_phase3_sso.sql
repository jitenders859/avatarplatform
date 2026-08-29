-- ═══════════════════════════════════════════════════════════════════
-- Migration: Phase 3 SSO (OIDC) — see
-- docs/competitor-feature-implementation-plan.md Phase 3 (3c) and
-- backend/routes/ssoAuth.js.
--
-- SECURITY NOTE: this auth code has not had a professional security
-- review and has not been exercised against a real OIDC provider — see
-- the header comment in backend/services/oidc.js before deploying it.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already appended to
-- schema.sql; this file is a standalone, dated record of *why* they were
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-29_add_phase3_sso.sql
-- ═══════════════════════════════════════════════════════════════════

-- An SSO-created (or SSO-linked) user's identity at the configured OIDC
-- provider. Looked up by (sso_provider, sso_subject) first on every
-- callback — the OIDC "sub" claim, not email, is the stable identifier
-- (an IdP's email can change; sub does not). A user who originally signed
-- up with a password can link their account by using SSO with the same
-- verified email once — see ssoAuth.js.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_provider TEXT; -- the OIDC issuer URL
ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_subject  TEXT; -- the OIDC "sub" claim
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso ON users(sso_provider, sso_subject) WHERE sso_provider IS NOT NULL;
