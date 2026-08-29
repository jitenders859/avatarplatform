-- ═══════════════════════════════════════════════════════════════════
-- Migration: Phase 3 WhatsApp channel — see
-- docs/competitor-feature-implementation-plan.md Phase 3 (3b) and
-- backend/routes/whatsapp.js.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already appended to
-- schema.sql; this file is a standalone, dated record of *why* they were
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-29_add_phase3_whatsapp.sql
-- ═══════════════════════════════════════════════════════════════════

-- One WhatsApp Business phone number maps to at most one project. The
-- access token is stored plaintext, matching this project's existing
-- posture for other per-project secrets (e.g. webhook_secret) — there is
-- no secrets-encryption-at-rest layer anywhere in this schema today.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS whatsapp_access_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_whatsapp_phone ON projects(whatsapp_phone_number_id) WHERE whatsapp_phone_number_id IS NOT NULL;
