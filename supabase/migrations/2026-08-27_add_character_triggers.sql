-- ═══════════════════════════════════════════════════════════════════
-- Migration: Admin-defined character behavior triggers.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statement below is already appended to
-- schema.sql; this file is a standalone, dated record of *why* it was
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-27_add_character_triggers.sql
-- ═══════════════════════════════════════════════════════════════════

-- ── character_triggers ────────────────────────────────────────────
-- Lets an admin name a gesture ("thinking", "laughing", "joking", or
-- anything else) and map it to a specific Rive state machine input on that
-- character, instead of the fixed smile/brows/sad set that used to be the
-- only gestures CharacterBehaviorController (public/lipsync-sdk.js) knew
-- about. rive_input is a raw input name (never one of the 100-122 viseme
-- numbers — lip-sync owns those exclusively); the admin panel's live
-- inspector (public/js/admin/characters.js) already reads a character's
-- actual state machine inputs into characters.inspector_meta at upload
-- time, so the admin UI can offer a dropdown of real inputs instead of
-- free text whenever that data exists.
--
-- keywords (comma-separated, case-insensitive substring match against the
-- model's spoken transcript) is how a trigger auto-fires — the same
-- mechanism CharacterBehaviorController.reactToEmotion() already used for
-- the built-in happy/sad/surprised gestures, just generalized to an
-- admin-defined name/input/keyword set instead of three hardcoded ones.
-- NULL/empty keywords means the trigger is manual-only, fired via the
-- SDK's LipsyncAvatar#fireCharacterTrigger(name).
CREATE TABLE IF NOT EXISTS character_triggers (
  id            UUID    PRIMARY KEY,
  character_id  UUID    NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,                    -- admin-facing label, e.g. "laughing"
  rive_input    TEXT    NOT NULL,                     -- Rive state machine input name on this character
  input_type    TEXT    NOT NULL DEFAULT 'trigger',   -- 'trigger' | 'boolean' | 'number'
  active_value  NUMERIC,                              -- 'number' inputs only: value to hold while active (0-100)
  hold_ms       INTEGER NOT NULL DEFAULT 1200,        -- 'boolean'/'number' only: ms before reverting to rest
  keywords      TEXT,                                 -- comma-separated auto-fire keywords; NULL = manual-only
  created_by    UUID    REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at    BIGINT  NOT NULL,
  updated_at    BIGINT,
  UNIQUE (character_id, name)
);
CREATE INDEX IF NOT EXISTS idx_character_triggers_character_id ON character_triggers(character_id);
