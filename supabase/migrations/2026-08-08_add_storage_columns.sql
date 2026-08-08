-- ═══════════════════════════════════════════════════════════════════
-- Migration: Vercel serverless migration — uploads move from local disk
-- to Supabase Storage, and file-processing progress moves from Socket.io
-- push events to DB-backed polling (serverless functions can't hold
-- persistent connections or survive past the HTTP response).
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes (see the header of that file). The statements below
-- are already appended to schema.sql's "Schema evolution" section; this
-- file exists as a standalone, dated record of *why* they were added, and
-- can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-08_add_storage_columns.sql
-- ═══════════════════════════════════════════════════════════════════

-- files.storage_key: Supabase Storage object key (e.g. "<projectId>/<fileId>.pdf"),
-- replacing stored_path's role now that uploads no longer live on local disk.
-- stored_path is left in place (nullable, unused going forward) rather than
-- dropped — cheaper and safer than a destructive column removal for
-- something nothing else reads anymore.
ALTER TABLE files ADD COLUMN IF NOT EXISTS storage_key TEXT;

-- files.stage / files.pct: fine-grained processing progress, previously
-- pushed to the client only via Socket.io ('extracting'/10 → 'chunking'/40
-- → 'embedding'/60 → 'saving'/85 → 'done'/100, see backend/services/
-- process.js). The frontend now polls GET /files/:fileId/status instead, so
-- this needs to be persisted rather than just emitted.
ALTER TABLE files ADD COLUMN IF NOT EXISTS stage TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS pct   INTEGER;
