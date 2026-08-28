-- ═══════════════════════════════════════════════════════════════════
-- AvatarPlatform — Supabase / PostgreSQL schema
--
-- Run this once in the Supabase SQL editor (or via psql) to create all
-- tables, indexes, and the pgvector extension.
--
-- How to run:
--   1. Go to your Supabase project → SQL Editor → New query
--   2. Paste this entire file and click Run
--   OR
--   psql $DATABASE_URL -f supabase/schema.sql
--
-- Embedding dimension:
--   Default is 768 (gemini-embedding-exp-03-07 with outputDimensionality=768).
--   If you use EMBEDDING_DIMENSIONS=3072, change vector(768) → vector(3072)
--   before running this script, OR run:
--     ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(3072);
-- ═══════════════════════════════════════════════════════════════════

-- pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- ── users ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                    UUID        PRIMARY KEY,
  email                 TEXT        UNIQUE NOT NULL,
  name                  TEXT,
  password_hash         TEXT        NOT NULL,
  stripe_customer_id    TEXT,
  reset_token           TEXT,
  reset_token_expiry    BIGINT,
  created_at            BIGINT      NOT NULL,
  updated_at            BIGINT
);

-- ── projects ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id                       UUID    PRIMARY KEY,
  user_id                  UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_id                TEXT    UNIQUE NOT NULL,
  name                     TEXT    NOT NULL,
  character_id             TEXT    NOT NULL DEFAULT 'character_1',
  system_prompt            TEXT,
  voice                    TEXT    DEFAULT 'Puck',
  welcome_message          TEXT,
  -- Capability tier: 'basic' | 'medium' | 'advanced' — gates study-tool
  -- features (quizzes, flashcards, etc.), independent of the billing plan
  -- in backend/plans.js. See backend/services/tiers.js.
  capability_tier          TEXT    NOT NULL DEFAULT 'basic',
  -- Widget
  widget_position          TEXT    DEFAULT 'bottom-right',
  widget_start_open        BOOLEAN DEFAULT false,
  text_direction           TEXT    DEFAULT 'auto',
  theme_color              TEXT    DEFAULT '#7c6af5',
  widget_theme             TEXT    DEFAULT 'light',
  show_branding            BOOLEAN DEFAULT true,
  show_source_cards        BOOLEAN DEFAULT true,
  show_quick_replies       BOOLEAN DEFAULT false,
  allow_drag_drop_upload   BOOLEAN DEFAULT false,
  full_screen_on_desktop   BOOLEAN DEFAULT false,
  full_screen_on_mobile    BOOLEAN DEFAULT false,
  show_full_screen_toggle  BOOLEAN DEFAULT false,
  widget_offset_x          INTEGER DEFAULT 0,
  widget_offset_y          INTEGER DEFAULT 0,
  -- Avatar placement
  avatar_position          TEXT    DEFAULT 'right',
  avatar_size              TEXT    DEFAULT 'large',
  show_avatar_in_launcher  BOOLEAN DEFAULT true,
  avatar_offset_x          INTEGER DEFAULT 0,
  avatar_offset_y          INTEGER DEFAULT 0,
  avatar_keep_visible      BOOLEAN DEFAULT true,
  avatar_compact_on_mobile BOOLEAN DEFAULT true,
  -- Webhook
  webhook_url              TEXT,
  webhook_secret           TEXT,
  -- Timestamps
  created_at               BIGINT  NOT NULL,
  updated_at               BIGINT
);

-- ── files ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id             UUID   PRIMARY KEY,
  project_id     UUID   NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id        UUID   NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  original_name  TEXT   NOT NULL,
  stored_path    TEXT,
  source_url     TEXT,
  kind           TEXT   NOT NULL,
  size           BIGINT DEFAULT 0,
  mime_type      TEXT,
  status         TEXT   DEFAULT 'pending',
  chunk_count    INTEGER DEFAULT 0,
  extracted_text TEXT,
  title          TEXT,
  final_url      TEXT,
  favicon_url    TEXT,
  fetched_at     BIGINT,
  processed_at   BIGINT,
  error          TEXT,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT
);

-- ── chunks ────────────────────────────────────────────────────────
-- embedding column uses pgvector type for native cosine similarity search.
-- The HNSW index below makes nearest-neighbor queries fast at scale.
CREATE TABLE IF NOT EXISTS chunks (
  id              UUID    PRIMARY KEY,
  project_id      UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id         UUID    NOT NULL REFERENCES files(id)    ON DELETE CASCADE,
  idx             INTEGER NOT NULL,
  text            TEXT    NOT NULL,
  heading         TEXT,
  page_hint       INTEGER,
  char_count      INTEGER,
  approx_tokens   INTEGER,
  embedding_model TEXT,
  embedding_dim   INTEGER,
  embedding       vector(768),
  created_at      BIGINT  NOT NULL
);

-- ── page_images ───────────────────────────────────────────────────
-- Rasterized PDF pages that Gemini vision classified as containing a
-- meaningful figure (diagram/chart/table) — not every page, just ones
-- worth showing inline. Linked to chunks by (file_id, page_number) —
-- since chunks.page_hint is now accurate (see backend/services/chunk.js),
-- no separate FK column on chunks is needed; retrieval joins on it
-- directly (see backend/services/vector.js).
CREATE TABLE IF NOT EXISTS page_images (
  id              UUID    PRIMARY KEY,
  file_id         UUID    NOT NULL REFERENCES files(id)    ON DELETE CASCADE,
  project_id      UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_number     INTEGER NOT NULL,
  image_path      TEXT    NOT NULL,
  caption         TEXT,
  -- Normalized (0-1) crop region within the full rendered page. NULL means
  -- this row is a whole-page screenshot from before per-figure cropping
  -- existed (or the model didn't return a usable box) — it's still served
  -- and displayed exactly as before, just not reachable via direct figure
  -- search (embedding is NULL too in that case).
  bbox_x          REAL,
  bbox_y          REAL,
  bbox_w          REAL,
  bbox_h          REAL,
  embedding_model TEXT,
  embedding_dim   INTEGER,
  embedding       vector(768),
  created_at      BIGINT  NOT NULL
);

-- ── sessions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id         UUID   PRIMARY KEY,
  project_id UUID   NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ip         TEXT,
  created_at BIGINT NOT NULL
);

-- ── messages ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id         UUID   PRIMARY KEY,
  session_id UUID   NOT NULL REFERENCES sessions(id)  ON DELETE CASCADE,
  project_id UUID   NOT NULL REFERENCES projects(id)  ON DELETE CASCADE,
  role       TEXT   NOT NULL,
  text       TEXT,
  created_at BIGINT NOT NULL
);

-- ── subscriptions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                     TEXT    PRIMARY KEY,  -- Stripe subscription ID
  user_id                UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id                TEXT    NOT NULL,
  status                 TEXT    NOT NULL,
  stripe_customer_id     TEXT,
  stripe_price_id        TEXT,
  current_period_end     BIGINT,
  cancel_at_period_end   BOOLEAN DEFAULT false,
  created_at             BIGINT  NOT NULL,
  updated_at             BIGINT
);

-- ── usage ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage (
  id               TEXT   PRIMARY KEY,  -- format: userId:YYYY-MM
  user_id          UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period           TEXT   NOT NULL,     -- format: YYYY-MM
  messages         INTEGER DEFAULT 0,
  embedding_chars  BIGINT  DEFAULT 0,
  created_at       BIGINT  NOT NULL,
  updated_at       BIGINT,
  UNIQUE (user_id, period)
);

-- ── capture_fields ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS capture_fields (
  id         UUID    PRIMARY KEY,
  project_id UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label      TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  options    JSONB,
  required   BOOLEAN DEFAULT true,
  "order"    INTEGER DEFAULT 0,
  created_at BIGINT  NOT NULL,
  updated_at BIGINT
);

-- ── leads ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id         UUID    PRIMARY KEY,
  project_id UUID    NOT NULL REFERENCES projects(id)  ON DELETE CASCADE,
  session_id UUID    NOT NULL REFERENCES sessions(id)  ON DELETE CASCADE,
  data       JSONB   DEFAULT '{}',
  complete   BOOLEAN DEFAULT false,
  created_at BIGINT  NOT NULL,
  updated_at BIGINT
);

-- ── quiz_questions ────────────────────────────────────────────────
-- Owner-authored question bank. The generate_quiz tool (backend/services/
-- tools.js) checks here before generating anything via AI — an owner
-- question is zero-hallucination-risk by definition.
CREATE TABLE IF NOT EXISTS quiz_questions (
  id            UUID    PRIMARY KEY,
  project_id    UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  question      TEXT    NOT NULL,
  options       JSONB   NOT NULL,
  correct_index INTEGER NOT NULL,
  topic_tag     TEXT,
  created_at    BIGINT  NOT NULL,
  updated_at    BIGINT
);

-- ── quiz_attempts ─────────────────────────────────────────────────
-- Self-contained per attempt (question/options text, not a FK to
-- quiz_questions) since AI-generated questions aren't persisted anywhere
-- else — the client round-trips what it was shown. Feeds progress tracking.
-- learner_key resolves to the project's email capture field value when
-- available (see backend/services/learner.js); null until then, meaning
-- the attempt is only attributable to its own session, not a durable
-- learner. topic is the topic the question was generated/selected for,
-- client-supplied from the generate_quiz tool call args — avoids joining
-- through chunks just to group progress by topic.
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id               UUID    PRIMARY KEY,
  project_id       UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id       UUID    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  learner_key      TEXT,
  question         TEXT    NOT NULL,
  topic            TEXT,
  selected_index   INTEGER,
  correct_index    INTEGER NOT NULL,
  is_correct       BOOLEAN NOT NULL,
  source_chunk_ids JSONB,
  created_at       BIGINT  NOT NULL
);

-- ── flashcards ────────────────────────────────────────────────────
-- Owner-authored flashcard bank — same role as quiz_questions.
CREATE TABLE IF NOT EXISTS flashcards (
  id         UUID   PRIMARY KEY,
  project_id UUID   NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  front      TEXT   NOT NULL,
  back       TEXT   NOT NULL,
  topic_tag  TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT
);

-- ── flashcard_reviews ─────────────────────────────────────────────
-- self_rating: 'got_it' | 'still_learning' — self-report, not full
-- spaced-repetition scheduling (v1 scope).
CREATE TABLE IF NOT EXISTS flashcard_reviews (
  id              UUID   PRIMARY KEY,
  project_id      UUID   NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id      UUID   NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  learner_key     TEXT,
  front           TEXT   NOT NULL,
  back            TEXT   NOT NULL,
  topic           TEXT,
  source_chunk_id UUID,
  self_rating     TEXT   NOT NULL,
  created_at      BIGINT NOT NULL
);

-- ── video_resources ───────────────────────────────────────────────
-- Owner-curated video library for the recommend_video tool. Deliberately
-- not AI-generated links or live YouTube search — a model inventing a
-- YouTube URL is a broken link, and even a real search API can surface
-- an unrelated or low-quality video for a niche topic.
CREATE TABLE IF NOT EXISTS video_resources (
  id          UUID     PRIMARY KEY,
  project_id  UUID     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  topic_tags  TEXT[]   NOT NULL DEFAULT '{}',
  title       TEXT     NOT NULL,
  youtube_url TEXT     NOT NULL,
  created_at  BIGINT   NOT NULL,
  updated_at  BIGINT
);

-- ══════════════════════════════════════════════════════════════════
-- Indexes
-- ══════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_projects_user_id    ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_public_id  ON projects(public_id);
CREATE INDEX IF NOT EXISTS idx_files_project_id    ON files(project_id);
CREATE INDEX IF NOT EXISTS idx_files_user_id       ON files(user_id);
CREATE INDEX IF NOT EXISTS idx_chunks_project_id   ON chunks(project_id);
CREATE INDEX IF NOT EXISTS idx_chunks_file_id      ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_subs_user_id        ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_user_period   ON usage(user_id, period);
CREATE INDEX IF NOT EXISTS idx_capture_project     ON capture_fields(project_id);
CREATE INDEX IF NOT EXISTS idx_leads_session       ON leads(session_id);

-- Compound (project_id, created_at) indexes — these serve plain project_id
-- lookups via the leftmost-prefix rule (replacing the old single-column
-- indexes) while also covering the WHERE project_id = $1 AND created_at > $2
-- pattern used throughout analytics.js and the paginated/sorted leads list.
CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_project_created ON sessions(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_project_created     ON leads(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quiz_questions_project    ON quiz_questions(project_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_project     ON quiz_attempts(project_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_session     ON quiz_attempts(session_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_learner     ON quiz_attempts(project_id, learner_key);
CREATE INDEX IF NOT EXISTS idx_flashcards_project        ON flashcards(project_id);
CREATE INDEX IF NOT EXISTS idx_flashcard_reviews_project ON flashcard_reviews(project_id);
CREATE INDEX IF NOT EXISTS idx_flashcard_reviews_session ON flashcard_reviews(session_id);
CREATE INDEX IF NOT EXISTS idx_flashcard_reviews_learner ON flashcard_reviews(project_id, learner_key);
CREATE INDEX IF NOT EXISTS idx_video_resources_project   ON video_resources(project_id);
CREATE INDEX IF NOT EXISTS idx_video_resources_tags      ON video_resources USING gin(topic_tags);
CREATE INDEX IF NOT EXISTS idx_page_images_file_page     ON page_images(file_id, page_number);

-- pgvector HNSW index for fast cosine similarity search.
-- HNSW builds the index on all existing rows and supports incremental inserts.
-- m=16, ef_construction=64 are good defaults for 768-dim vectors.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── Schema evolution ──────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS above won't add columns to an already-deployed
-- table. This file stays idempotent (safe to re-run) via ADD COLUMN IF NOT
-- EXISTS for changes made after the table already existed in production.
--
-- widget_theme: per-project embed widget light/dark theme (mascot.bot-style
-- light theme rollout). Defaults every project — existing and new — to
-- 'light', matching the new default look.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS widget_theme TEXT DEFAULT 'light';

-- multi-figure PDF retrieval: page_images gains a per-figure bounding box
-- (nullable — pre-existing rows are whole-page screenshots with no crop)
-- and a caption embedding for direct figure-level semantic search (see
-- backend/services/vector.js's searchFigures and backend/services/
-- figures.js's resolveFigures). New uploads only — existing rows are not
-- backfilled.
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS bbox_x          REAL;
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS bbox_y          REAL;
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS bbox_w          REAL;
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS bbox_h          REAL;
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS embedding_dim   INTEGER;
ALTER TABLE page_images ADD COLUMN IF NOT EXISTS embedding       vector(768);

-- Placed after the ALTER above (not in the main index block up top) because
-- on an already-deployed database the CREATE TABLE IF NOT EXISTS for
-- page_images is a no-op and `embedding` doesn't exist until that ALTER
-- runs — creating this index any earlier in the file fails with
-- "column \"embedding\" does not exist" against such a database.
CREATE INDEX IF NOT EXISTS idx_page_images_embedding
  ON page_images USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── Performance audit follow-up (see supabase/migrations/2026-08-03_add_missing_indexes.sql) ──
--
-- users.reset_token: `SELECT * FROM users WHERE reset_token = $1 AND
-- reset_token_expiry > $2` (backend/routes/auth.js, POST /reset-password)
-- had no index on reset_token — every reset-password submission was a full
-- table scan of users. Partial index (most rows have reset_token = NULL,
-- since it's only set during an active forgot-password flow) keeps the
-- index small and covers exactly the rows this query can ever match.
CREATE INDEX IF NOT EXISTS idx_users_reset_token
  ON users(reset_token)
  WHERE reset_token IS NOT NULL;

-- chunks.text: `SELECT * FROM chunks WHERE file_id = $1 AND text ILIKE $2`
-- (backend/routes/files.js, GET /files/:fileId/chunks?search=) can't use a
-- plain btree index for a '%...%' pattern — it was falling back to
-- sequentially scanning every chunk row for the file. pg_trgm's GIN index
-- supports ILIKE with leading wildcards; combined with the existing
-- file_id index (idx_chunks_file_id), Postgres can bitmap-AND the two
-- instead.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_chunks_text_trgm
  ON chunks USING gin (text gin_trgm_ops);

-- ── Vercel serverless migration (see supabase/migrations/2026-08-08_add_storage_columns.sql) ──
--
-- files.storage_key: Supabase Storage object key, replacing stored_path's
-- role now that uploads no longer live on local disk (Vercel's filesystem
-- is ephemeral). stored_path stays in place, unused, rather than dropped.
--
-- files.stage / files.pct: fine-grained processing progress, previously
-- pushed via Socket.io (serverless functions can't hold persistent
-- connections) — now persisted here and polled via GET .../status instead.
ALTER TABLE files ADD COLUMN IF NOT EXISTS storage_key TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS stage       TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS pct         INTEGER;

-- ── Admin panel (see supabase/migrations/2026-08-08_add_admin_panel.sql) ──

-- ── admin_users ───────────────────────────────────────────────────
-- Fully separate from the customer `users` table/auth path by design.
-- No self-serve signup; seeded via backend/scripts/create-admin.js.
CREATE TABLE IF NOT EXISTS admin_users (
  id            UUID        PRIMARY KEY,
  email         TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    BIGINT      NOT NULL
);

-- ── plan_tiers ────────────────────────────────────────────────────
-- Admin-defined limit sets, independent of the static PLANS array in
-- backend/plans.js (those stay code-defined since they're tied to real
-- Stripe price IDs). A user's `admin_plan_id` (see below) points here.
CREATE TABLE IF NOT EXISTS plan_tiers (
  id          TEXT        PRIMARY KEY,   -- slug, e.g. "custom-acme-corp-a1b2c3"
  name        TEXT        NOT NULL,
  limits      JSONB       NOT NULL,      -- { projects, maxFiles, storageMb, monthlyMessages, monthlyEmbeddingChars, urlSources }
  created_by  UUID        REFERENCES admin_users(id),
  created_at  BIGINT      NOT NULL,
  updated_at  BIGINT
);

-- ── users: suspension + admin plan override ──────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_plan_id   TEXT REFERENCES plan_tiers(id);

-- ── admin_audit_log ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id              UUID    PRIMARY KEY,
  admin_id        UUID    NOT NULL REFERENCES admin_users(id),
  action          TEXT    NOT NULL,   -- 'suspend' | 'unsuspend' | 'assign_tier' | 'clear_tier' | 'delete_user' | 'impersonate' | 'tier_create' | 'tier_update' | 'tier_delete'
  target_user_id  UUID    REFERENCES users(id),
  meta            JSONB,
  created_at      BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log (created_at DESC);

-- ── Schema evolution: post-review fixes ──────────────────────────
-- CREATE TABLE IF NOT EXISTS above won't change columns/constraints on a
-- database that already ran the (pre-fix) statements above, so these
-- ALTERs converge such a database; they're no-ops against a fresh one
-- created straight from the corrected statements below.
--
-- admin_audit_log.target_user_id had no ON DELETE action (defaulted to
-- NO ACTION), which blocks deleting a user who has any audit-log row
-- referencing them — including the admin delete-user flow itself (it
-- logs a 'delete_user' row for the user, then tries to delete that same
-- user) and the already-shipped self-serve DELETE /api/auth/me for any
-- user who was ever suspended/tier-assigned/impersonated. ON DELETE
-- SET NULL keeps the audit trail (the row survives) without blocking
-- the delete.
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_target_user_id_fkey;
ALTER TABLE admin_audit_log
  ADD CONSTRAINT admin_audit_log_target_user_id_fkey
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- target_email: denormalized so an audit row stays self-describing (who
-- was acted on) even after target_user_id goes NULL because the target
-- user was deleted — the join alone can no longer answer that. Populated
-- by the audit-log service (later task); nullable here since older/
-- pre-existing rows won't be backfilled.
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS target_email TEXT;

-- plan_tiers.created_by / admin_audit_log.admin_id both referenced
-- admin_users(id) with no ON DELETE action either, meaning an admin
-- account could never be removed once it created a tier or logged any
-- action — including the plan's own documented step of deleting the
-- test admin account after verification. ON DELETE SET NULL frees the
-- admin account for deletion while leaving the tier/audit row intact.
-- admin_id must be made nullable first — a nullable FK target needs a
-- nullable column.
ALTER TABLE plan_tiers DROP CONSTRAINT IF EXISTS plan_tiers_created_by_fkey;
ALTER TABLE plan_tiers
  ADD CONSTRAINT plan_tiers_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE admin_audit_log ALTER COLUMN admin_id DROP NOT NULL;
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_admin_id_fkey;
ALTER TABLE admin_audit_log
  ADD CONSTRAINT admin_audit_log_admin_id_fkey
  FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE SET NULL;

-- admin_users.updated_at: this repo's db.update() helper unconditionally
-- injects updated_at into every UPDATE; every other mutable table already
-- has this column. Without it, any future admin-account-update code
-- hard-fails with a missing-column error.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS updated_at BIGINT;

-- Tier-delete "is this tier still in use" lookup (SELECT 1 FROM users
-- WHERE admin_plan_id = $1 LIMIT 1) — partial index since most users
-- have admin_plan_id NULL (no admin override).
CREATE INDEX IF NOT EXISTS idx_users_admin_plan_id ON users(admin_plan_id) WHERE admin_plan_id IS NOT NULL;

-- ── Admin panel: character library, tier overrides, coupons (see supabase/migrations/2026-08-24_add_characters_coupons_overrides.sql) ──

-- ── characters ────────────────────────────────────────────────────
-- Admin-uploaded Rive character files, replacing the hardcoded
-- CHARACTERS array in backend/routes/projects.js. Current-version
-- fields (storage_key/version/file_size/inspector_meta) are
-- denormalized here for fast reads; full history lives in
-- character_versions below. Files live in a *public* Supabase Storage
-- bucket ('character-assets'), not the private 'uploads' bucket
-- files.js uses — the embed widget is loaded by anonymous visitors on
-- third-party sites and needs to fetch these with no auth.
CREATE TABLE IF NOT EXISTS characters (
  id                     UUID    PRIMARY KEY,
  slug                   TEXT    UNIQUE NOT NULL,            -- stable id used by projects.character_id, e.g. "character_1"
  name                   TEXT    NOT NULL,
  description            TEXT,
  storage_key            TEXT    NOT NULL,                   -- 'character-assets' bucket path, current version
  thumbnail_storage_key  TEXT,
  version                INTEGER NOT NULL DEFAULT 1,
  file_size              BIGINT  NOT NULL,
  status                 TEXT    NOT NULL DEFAULT 'draft',       -- 'draft' | 'active' | 'archived'
  visibility              TEXT    NOT NULL DEFAULT 'restricted', -- 'global' | 'restricted'
  inspector_meta          JSONB,                                 -- admin-reported snapshot from the browser rive.js inspector (advisory only, not a security boundary)
  uploaded_by              UUID    REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at               BIGINT  NOT NULL,
  updated_at               BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_characters_slug ON characters(slug);
CREATE INDEX IF NOT EXISTS idx_characters_status ON characters(status);

-- ── character_versions ───────────────────────────────────────────
-- Full re-upload history so replacing a character's file never
-- destroys the previous version (rollback / audit).
-- updated_at: this repo's db.update() helper unconditionally injects
-- updated_at into every UPDATE (see the admin_users precedent above) — the
-- /complete step of the upload flow updates this row's file_size/
-- inspector_meta once the async upload finishes, so it needs the column
-- despite otherwise being an append-only history table.
CREATE TABLE IF NOT EXISTS character_versions (
  id              UUID    PRIMARY KEY,
  character_id    UUID    NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  storage_key     TEXT    NOT NULL,
  file_size       BIGINT  NOT NULL,
  inspector_meta  JSONB,
  uploaded_by     UUID    REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at      BIGINT  NOT NULL,
  updated_at      BIGINT,
  UNIQUE (character_id, version)
);
-- CREATE TABLE IF NOT EXISTS above won't add updated_at to a database that
-- already ran an earlier version of this statement without it (same class
-- of bug documented for admin_users above) — this ALTER converges such a
-- database; a no-op against one created straight from the corrected
-- statement above.
ALTER TABLE character_versions ADD COLUMN IF NOT EXISTS updated_at BIGINT;

-- ── character_access ─────────────────────────────────────────────
-- Explicit per-tenant grants, consulted only when the character's
-- visibility = 'restricted' (ignored/irrelevant when 'global').
CREATE TABLE IF NOT EXISTS character_access (
  character_id  UUID   NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  user_id       UUID   NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  granted_by    UUID   REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at    BIGINT NOT NULL,
  PRIMARY KEY (character_id, user_id)
);

-- Character-library usage-count ("how many tenants use this character")
-- and the embed/project character lookup both filter projects by
-- character_id — this table has no index on that column today.
CREATE INDEX IF NOT EXISTS idx_projects_character_id ON projects(character_id);

-- ── character_triggers ────────────────────────────────────────────
-- Admin-named gestures ("thinking", "laughing", "joking", ...) mapped to a
-- specific Rive state machine input on that character. rive_input is a raw
-- input name (not one of the 100-122 viseme numbers, which lip-sync alone
-- owns) — the admin panel's live inspector (public/js/admin/characters.js)
-- reads the character's actual state machine inputs from inspector_meta so
-- this can be a dropdown, not free text, when that data exists.
-- keywords (comma-separated, case-insensitive substring match) is how the
-- SDK auto-fires a trigger: CharacterBehaviorController.reactToEmotion()
-- scans the model's spoken transcript for a match, same mechanism the
-- built-in happy/sad/surprised gestures already use. NULL/empty keywords
-- means the trigger is manual-only, fired via LipsyncAvatar#fireCharacterTrigger.
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

-- ── users: tier-override provenance + expiry ─────────────────────
-- admin_plan_id already exists and already takes precedence over
-- Stripe in backend/services/usage.js's userPlanId(). These columns
-- add the "who/when/why/until when" the admin UI's override badge
-- needs; expiry is enforced lazily by userPlanId() (no cron sweep).
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_plan_set_by     UUID REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_plan_set_at     BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_plan_note       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_plan_expires_at BIGINT;  -- NULL = no expiry

-- ── coupons ───────────────────────────────────────────────────────
-- Local cache/management layer over a Stripe Coupon + Promotion Code
-- pair (Stripe is the source of truth for the discount itself).
-- applicable_plan_ids is enforced by us pre-checkout, not via Stripe's
-- applies_to.products — this app's plans are keyed by Price ID, not
-- Product ID (see backend/plans.js), and per-user redemption caps
-- already require our own pre-checkout validation regardless of that
-- choice, so there's no native-Stripe-only path available anyway.
CREATE TABLE IF NOT EXISTS coupons (
  id                        UUID    PRIMARY KEY,
  code                      TEXT    UNIQUE NOT NULL,
  stripe_coupon_id          TEXT    NOT NULL,
  stripe_promotion_code_id  TEXT    NOT NULL UNIQUE,
  discount_type             TEXT    NOT NULL,             -- 'percent' | 'fixed'
  discount_value            NUMERIC NOT NULL,             -- percent (0-100) or fixed amount in the currency's smallest unit
  currency                  TEXT,                         -- required when discount_type = 'fixed'
  applicable_plan_ids       TEXT[]  NOT NULL DEFAULT '{}', -- empty = all plans
  max_redemptions           INTEGER,                      -- NULL = unlimited total
  max_redemptions_per_user  INTEGER,                      -- NULL = unlimited per user
  expires_at                BIGINT,
  active                    BOOLEAN NOT NULL DEFAULT true,
  created_by                UUID    REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at                BIGINT  NOT NULL,
  updated_at                BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);

-- ── coupon_redemptions ───────────────────────────────────────────
-- Written from the Stripe webhook on confirmed payment only (see
-- backend/routes/billing.js's syncSubscriptionFromEvent) — never on
-- checkout-session creation — so an abandoned checkout never burns a
-- user's per-user redemption quota. Pre-checkout validation counts
-- rows here against coupons.max_redemptions / max_redemptions_per_user.
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id                           UUID   PRIMARY KEY,
  coupon_id                    UUID   REFERENCES coupons(id) ON DELETE SET NULL,
  user_id                      UUID   REFERENCES users(id)   ON DELETE SET NULL,
  stripe_checkout_session_id   TEXT,
  plan_id                      TEXT,
  redeemed_at                  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_id ON coupon_redemptions(coupon_id);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user_id   ON coupon_redemptions(user_id);
