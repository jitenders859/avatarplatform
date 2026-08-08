-- ═══════════════════════════════════════════════════════════════════
-- Migration: add indexes for columns identified as unindexed but
-- frequently filtered, found while fixing the N+1/query-pattern findings
-- from the backend performance audit.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes (see the header of that file). The two statements
-- below are already appended to schema.sql's "Schema evolution" section;
-- this file exists as a standalone, dated record of *why* they were added,
-- and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-03_add_missing_indexes.sql
-- ═══════════════════════════════════════════════════════════════════

-- users.reset_token
--
-- Query: SELECT * FROM users WHERE reset_token = $1 AND reset_token_expiry > $2
-- (backend/routes/auth.js, POST /api/auth/reset-password)
--
-- reset_token had no index at all, so every password-reset submission —
-- an unauthenticated, publicly reachable endpoint — did a full sequential
-- scan of the users table. A partial index is used instead of a plain one
-- because reset_token is NULL for the overwhelming majority of rows (it's
-- only set for the duration of an active forgot-password flow); indexing
-- just the non-null rows keeps the index tiny regardless of total user count.
CREATE INDEX IF NOT EXISTS idx_users_reset_token
  ON users(reset_token)
  WHERE reset_token IS NOT NULL;

-- chunks.text (trigram)
--
-- Query: SELECT * FROM chunks WHERE file_id = $1 AND text ILIKE $2
-- (backend/routes/files.js, GET /api/projects/:projectId/files/:fileId/chunks?search=)
--
-- A '%pattern%' ILIKE can't use a plain btree index, so this was a
-- sequential scan over every chunk belonging to the file. Low impact today
-- (chunk search is scoped to one file, which the existing idx_chunks_file_id
-- index already narrows first), but flagged because it's the kind of thing
-- that degrades quietly as documents grow larger or the search is widened
-- to a whole project. pg_trgm's GIN index lets Postgres use an index for
-- ILIKE with leading wildcards; Postgres can then bitmap-AND it with
-- idx_chunks_file_id instead of falling back to a full scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_chunks_text_trgm
  ON chunks USING gin (text gin_trgm_ops);
