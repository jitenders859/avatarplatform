-- ═══════════════════════════════════════════════════════════════════
-- Migration: remove the Phase 1 async/polling live-agent handoff
-- (sessions.status — see 2026-08-29_add_phase1_engagement_features.sql),
-- superseded by the real-time WebSocket handoff system (sessions.handoff_status/
-- claimed_by/claimed_at — see 2026-08-28_add_handoff.sql). The two can't
-- coexist driving the same sessions row, and the WS system fully replaces
-- this one: POST /embed/:publicId/handoff, GET /embed/:publicId/messages,
-- and POST /api/projects/:id/sessions/:sessionId/reply are all removed.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth; this file is a standalone, dated record and
-- can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-09-08b_remove_async_handoff.sql
-- ═══════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_sessions_status;
ALTER TABLE sessions DROP COLUMN IF EXISTS status;
