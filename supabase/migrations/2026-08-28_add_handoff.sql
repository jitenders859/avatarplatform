-- ═══════════════════════════════════════════════════════════════════
-- Migration: Human handoff (live agent takeover) — see
-- docs/superpowers/specs/2026-08-28-human-handoff-design.md.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already appended to
-- schema.sql; this file is a standalone, dated record of *why* they were
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-28_add_handoff.sql
-- ═══════════════════════════════════════════════════════════════════

-- ── sessions: handoff state ──────────────────────────────────────
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS handoff_status       TEXT NOT NULL DEFAULT 'none'; -- 'none' | 'requested' | 'active' | 'resolved'
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS claimed_by           UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS claimed_at           BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS handoff_requested_at BIGINT;
-- db.js's update() unconditionally stamps updated_at on every UPDATE
-- regardless of table (see webhook_deliveries' migration for the same
-- note) — this table is now a db.update() target (claim/resolve), so it
-- needs the column or those calls 500.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at           BIGINT;
CREATE INDEX IF NOT EXISTS idx_sessions_handoff_pending
  ON sessions(project_id, handoff_status)
  WHERE handoff_status IN ('requested', 'active');

-- ── messages: human attribution ──────────────────────────────────
-- role gains a new value 'human' alongside the existing 'user'/'assistant'.
-- sender_id is null for AI/visitor messages, set for a team member's.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_id UUID REFERENCES users(id) ON DELETE SET NULL;
