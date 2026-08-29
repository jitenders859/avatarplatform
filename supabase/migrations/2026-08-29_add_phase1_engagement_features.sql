-- ═══════════════════════════════════════════════════════════════════
-- Migration: Phase 1 engagement features — see
-- docs/competitor-feature-implementation-plan.md Phase 1 (1a-1d).
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already appended to
-- schema.sql; this file is a standalone, dated record of *why* they were
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-29_add_phase1_engagement_features.sql
-- ═══════════════════════════════════════════════════════════════════

-- 1a. Live agent handoff — a session starts 'bot', moves to
-- 'handoff_requested' when the visitor asks for a human (POST
-- /embed/:publicId/handoff), and 'human' once the owner sends a reply
-- (POST /api/projects/:id/sessions/:sessionId/reply). updated_at is
-- required because db.js's update() unconditionally stamps it on every
-- UPDATE, and sessions is now a mutable table (it previously was
-- insert-only).
-- 1c. sentiment — set by a periodic Inngest job (backend/inngest/functions.js
-- sentimentTagJob), not per-message, to avoid adding latency to live turns.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'bot'; -- 'bot' | 'handoff_requested' | 'human'
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS satisfaction TEXT; -- 'up' | 'down', set by widget thumbs prompt
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sentiment TEXT;   -- 'positive' | 'neutral' | 'negative'
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(project_id, status) WHERE status <> 'bot';

-- 1b. Drop-off analytics — flags a bot reply given when RAG retrieval
-- found nothing above RAG_MIN_SCORE, so analytics can chart the
-- "no answer found" rate per project (backend/services/vector.js already
-- computes this per-call; this just persists it).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS no_answer_found BOOLEAN NOT NULL DEFAULT false;

-- 1d. AI actions — owner-defined custom tools the model can call beyond
-- RAG Q&A (e.g. "check_order_status"), dispatched as a signed outbound
-- webhook using the same HMAC pattern as backend/services/webhookDelivery.js.
-- Scoped to the REST /ask and /study endpoints (backend/services/tools.js),
-- not the Gemini Live WebSocket session — the Live session's tool-calling
-- is separate client-side infrastructure (public/lipsync-sdk.js) not fed
-- from any per-project backend tool registry today; wiring custom actions
-- into it is a larger, separate change.
CREATE TABLE IF NOT EXISTS project_actions (
  id                UUID    PRIMARY KEY,
  project_id        UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name              TEXT    NOT NULL, -- Gemini function-declaration name (snake_case)
  description       TEXT    NOT NULL, -- tells the model when to call this action
  parameters        JSONB   NOT NULL DEFAULT '{}', -- JSON-schema-like, same shape as tools.js declarations
  webhook_url       TEXT    NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        BIGINT  NOT NULL,
  updated_at        BIGINT
);
CREATE INDEX IF NOT EXISTS idx_project_actions_project ON project_actions(project_id);
