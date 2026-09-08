-- ═══════════════════════════════════════════════════════════════════
-- Migration: remaining columns missing from an existing `projects` table.
--
-- Follow-up to 2026-09-07_add_voice_engine.sql: after fixing that one
-- column, a full audit (diffing `information_schema.columns` for a live
-- database against every column declared in schema.sql's `CREATE TABLE
-- IF NOT EXISTS projects` block) turned up six more columns with the same
-- gap — declared only in that base CREATE TABLE, never given a matching
-- `ALTER TABLE ... ADD COLUMN` for a database whose `projects` table
-- predates them. Any database in this state 500s on the corresponding
-- feature with `column "<name>" of relation "projects" does not exist`:
--   allowed_domains, business_hours, away_message, conversation_starters,
--   fallback_message, admin_suspended, admin_suspended_reason.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. This file is a standalone, dated record, and can
-- also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-09-07b_add_missing_projects_columns.sql
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE projects ADD COLUMN IF NOT EXISTS allowed_domains        TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS business_hours         JSONB;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS away_message           TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS conversation_starters  JSONB   DEFAULT '[]';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS fallback_message       TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS admin_suspended        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS admin_suspended_reason TEXT;
