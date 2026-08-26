-- ═══════════════════════════════════════════════════════════════════
-- Migration: Admin panel — character library, tier-override provenance
-- + expiry, coupon system.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already appended to
-- schema.sql; this file is a standalone, dated record of *why* they were
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-24_add_characters_coupons_overrides.sql
-- ═══════════════════════════════════════════════════════════════════

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
