-- ═══════════════════════════════════════════════════════════════════
-- Migration: enable Row Level Security on every table in the public
-- schema.
--
-- Found during a pre-launch audit: Supabase's own security linter
-- (rls_disabled_in_public, ERROR/EXTERNAL) flagged 28 of 33 tables as
-- RLS-disabled-in-public — and the anon/authenticated Postgres roles
-- (used by Supabase's PostgREST API, exposed via the publishable/anon
-- key that ships to every browser per SUPABASE_PUBLISHABLE_KEY) held
-- full SELECT/INSERT/UPDATE/DELETE grants on all of them, including
-- users (bcrypt hashes), admin_settings, coupons, subscriptions, and
-- leads. With RLS disabled, those grants were directly usable — anyone
-- with the public key could read or write any row in any table via
-- Supabase's REST endpoint, completely bypassing this app's own
-- Express/JWT authorization.
--
-- This app never queries Postgres through PostgREST/anon — the backend
-- connects via `pg.Pool` using DATABASE_URL (see backend/db.js), whose
-- role has BYPASSRLS (verified: `postgres` role, rolbypassrls=true), so
-- enabling RLS with zero policies is a pure lockout of anon/authenticated
-- (default-deny) with no effect on the app itself. This mirrors the
-- existing pattern already in place for admin_audit_log/admin_users/
-- chatbot_categories/plan_tiers/project_actions (RLS enabled, no
-- policies — see supabase/schema.sql, which had never listed this
-- explicitly for any table until this migration).
--
-- This project has no migration runner — supabase/schema.sql is the
-- single idempotent source of truth; this file is a standalone, dated
-- record and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-09-12_enable_rls_all_tables.sql
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capture_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flashcards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flashcard_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupon_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbot_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_connections ENABLE ROW LEVEL SECURITY;
