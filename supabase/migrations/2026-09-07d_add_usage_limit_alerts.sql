-- ═══════════════════════════════════════════════════════════════════
-- Migration: usage-limit email/SMS alerts.
--
-- Adds the columns backend/services/usage.js#runUsageAlertSweep needs:
--   users.phone / users.sms_alerts_enabled   — opt-in SMS destination
--   usage.notified_warning_at / notified_over_at — per-period dedup, so
--     each alert threshold is only emailed/texted once per billing period
--     (a new period is a new `usage` row, so these start NULL again).
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. This file is a standalone, dated record, and can
-- also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-09-07d_add_usage_limit_alerts.sql
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone               TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_alerts_enabled  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE usage ADD COLUMN IF NOT EXISTS notified_warning_at BIGINT;
ALTER TABLE usage ADD COLUMN IF NOT EXISTS notified_over_at    BIGINT;
