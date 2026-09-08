-- ═══════════════════════════════════════════════════════════════════
-- Migration: voice_engine column on projects.
--
-- This was added directly into supabase/schema.sql's base `CREATE TABLE
-- IF NOT EXISTS projects` block (for fresh installs) but never got a
-- matching `ALTER TABLE ... ADD COLUMN` in schema.sql's evolution section
-- for existing databases — so any database whose `projects` table
-- predates the multi-voice-provider feature (see backend/services/tts.js,
-- 'gemini-live' | 'fish-audio' | 'cartesia' | 'elevenlabs') is missing this
-- column entirely, and every PATCH /api/projects/:id 500s with
-- `column "voice_engine" of relation "projects" does not exist`.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. This file is a standalone, dated record, and can
-- also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-09-07_add_voice_engine.sql
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE projects ADD COLUMN IF NOT EXISTS voice_engine TEXT NOT NULL DEFAULT 'gemini-live';
