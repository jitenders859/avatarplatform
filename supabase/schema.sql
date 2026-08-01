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
  id          UUID    PRIMARY KEY,
  file_id     UUID    NOT NULL REFERENCES files(id)    ON DELETE CASCADE,
  project_id  UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  image_path  TEXT    NOT NULL,
  caption     TEXT,
  created_at  BIGINT  NOT NULL
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
