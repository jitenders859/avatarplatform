-- ═══════════════════════════════════════════════════════════════════
-- Migration: Product gaps from improvement-prompts.md Prompt F4 — email
-- verification, teams/multi-seat, widget i18n, webhook reliability.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already appended to
-- schema.sql; this file is a standalone, dated record of *why* they were
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-28_product-gaps.sql
-- ═══════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════
-- Schema evolution: product gaps from improvement-prompts.md Prompt F4
-- (email verification, teams/multi-seat, widget i18n, webhook reliability)
-- ═══════════════════════════════════════════════════════════════════

-- Email verification — signup already worked without it; this adds a
-- soft gate (see routes/auth.js's POST /api/projects check) rather than
-- blocking login, to avoid losing signups to a broken verification email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at    BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token_expiry  BIGINT;
CREATE INDEX IF NOT EXISTS idx_users_verify_token
  ON users(verify_token)
  WHERE verify_token IS NOT NULL;

-- Widget i18n — owner-editable locale strings for the parts of the widget
-- that were hardcoded English (input placeholder, limit-reached message).
-- welcomeMessage was already a per-project column; this covers the rest
-- without a full translation-framework rewrite. Keyed by BCP-47 locale
-- code (e.g. "es", "fr"); { "es": { "placeholder": "...", "limitReached": "..." } }.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS widget_messages JSONB DEFAULT '{}';

-- Teams / multi-seat (Business-tier feature) — a project's owner
-- (projects.user_id) can invite other existing AvatarPlatform accounts by
-- email. Deliberately minimal for this pass: members are read-only
-- (Conversations + Analytics tabs only, enforced in routes/projects.js
-- and routes/analytics.js) rather than full co-editors, since granting
-- write access would mean auditing every project-scoped route's ownership
-- check for correctness, not just adding a table.
CREATE TABLE IF NOT EXISTS project_members (
  id           UUID    PRIMARY KEY,
  project_id   UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      UUID    NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  invited_by   UUID    REFERENCES users(id) ON DELETE SET NULL,
  created_at   BIGINT  NOT NULL,
  UNIQUE (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user    ON project_members(user_id);

-- Webhook reliability — each attempt to deliver a project's webhook (see
-- routes/embed.js's /log handler) is now logged here instead of being
-- fire-and-forget with only a server-side log line on failure. Retried
-- with backoff via Inngest (backend/inngest/functions.js).
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                UUID    PRIMARY KEY,
  project_id        UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type        TEXT    NOT NULL,
  payload           JSONB   NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending', -- 'pending' | 'success' | 'failed'
  attempt           INTEGER NOT NULL DEFAULT 0,
  response_status   INTEGER,
  error             TEXT,
  created_at        BIGINT  NOT NULL,
  delivered_at      BIGINT
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_project ON webhook_deliveries(project_id, created_at DESC);
