-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already appended to
-- schema.sql; this file is a standalone, dated record of *why* they were
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-09-09_add_lead_status.sql
--
-- Adds a staff-editable follow-up pipeline status to leads (separate from
-- the existing auto-computed `complete` boolean, which tracks whether all
-- required capture fields were filled in during chat — this tracks where
-- a human is in following up).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';
-- 'new' | 'contacted' | 'replied' | 'meeting_scheduled' | 'google_meet_scheduled'
-- | 'follow_up_later' | 'rejected' | 'enrolled'
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_date DATE;

CREATE INDEX IF NOT EXISTS idx_leads_project_status ON leads(project_id, status);
