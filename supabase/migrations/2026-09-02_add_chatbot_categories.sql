-- ═══════════════════════════════════════════════════════════════════
-- Migration: Chatbot categories + data-export API.
--
-- Lets a user create categories, group their chatbots (projects) into
-- them, and then pull everything they have (categories, chatbots,
-- messages, URL sources, leads) via a small read-only API mounted at
-- /api/data — see backend/routes/categories.js and backend/routes/apiData.js.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already appended to
-- schema.sql; this file is a standalone, dated record of *why* they were
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-09-02_add_chatbot_categories.sql
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chatbot_categories (
  id          UUID    PRIMARY KEY,
  user_id     UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  color       TEXT,
  description TEXT,
  created_at  BIGINT  NOT NULL,
  updated_at  BIGINT,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_chatbot_categories_user ON chatbot_categories(user_id);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES chatbot_categories(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_category_id ON projects(category_id);
