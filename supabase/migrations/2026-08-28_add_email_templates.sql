-- ═══════════════════════════════════════════════════════════════════
-- Migration: DB-backed, admin-editable email templates (Prompt 5f). Moves
-- the 5 hardcoded email subject/body strings out of
-- backend/services/email.js and into a table an operator can edit from the
-- admin panel, without a redeploy. See backend/services/emailTemplates.js
-- for the DB-first-with-hardcoded-fallback resolution (same pattern as
-- backend/services/settings.js).
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The CREATE TABLE below is already appended to
-- schema.sql; this file is a standalone, dated record of *why* it was
-- added (plus the one-time seed data, which does NOT belong in
-- schema.sql), and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-28_add_email_templates.sql
-- ═══════════════════════════════════════════════════════════════════

-- One row per template. A present row is used verbatim for that key
-- (see emailTemplates.js getTemplate); if the DB is unreachable or a row is
-- missing, email.js falls back to the identical hardcoded string baked
-- into emailTemplates.js — same fallback philosophy as settings.js's env
-- fallback. `body` holds the HTML template (the part an admin actually
-- wants to restyle); the plain-text alternative part of each email stays
-- hardcoded in email.js and is not admin-editable, since the table (per
-- spec) has a single body column, not separate text/html columns.
CREATE TABLE IF NOT EXISTS email_templates (
  key         TEXT    PRIMARY KEY,
  subject     TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  updated_at  BIGINT  NOT NULL,
  updated_by  UUID    REFERENCES admin_users(id) ON DELETE SET NULL
);

-- Seed rows: byte-for-byte copies of the subject/html strings hardcoded in
-- backend/services/email.js at the time of this migration, so existing
-- emails do not change until an admin edits one from the panel. Placeholder
-- syntax (literal ${...} tokens) is preserved verbatim as inert text —
-- email.js does a plain string-replace of these exact tokens at send time
-- (see emailTemplates.js), no templating engine.
-- ON CONFLICT DO NOTHING: this is one-time seed data — re-running this
-- migration (e.g. via schema.sql) must never clobber an admin's edit.
INSERT INTO email_templates (key, subject, body, updated_at, updated_by) VALUES (
  'password_reset',
  $$Reset your AvatarPlatform password$$,
  $$
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin:0 0 16px;font-size:20px">Reset your password</h2>
        <p style="color:#555;line-height:1.6">Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
        <a href="${link}" style="display:inline-block;margin:24px 0;padding:12px 24px;background:#7c6af5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Reset password</a>
        <p style="color:#999;font-size:12px">If you didn't request a password reset, you can safely ignore this email.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="color:#bbb;font-size:11px">AvatarPlatform · <a href="${BASE_URL()}" style="color:#bbb">${BASE_URL()}</a></p>
      </div>$$,
  (extract(epoch from now()) * 1000)::bigint,
  NULL
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO email_templates (key, subject, body, updated_at, updated_by) VALUES (
  'verification',
  $$Verify your AvatarPlatform email$$,
  $$
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin:0 0 16px;font-size:20px">Verify your email</h2>
        <p style="color:#555;line-height:1.6">Click the button below to confirm your email address. This link expires in <strong>24 hours</strong>.</p>
        <a href="${link}" style="display:inline-block;margin:24px 0;padding:12px 24px;background:#7c6af5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Verify email</a>
        <p style="color:#999;font-size:12px">If you didn't create an AvatarPlatform account, you can safely ignore this email.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="color:#bbb;font-size:11px">AvatarPlatform · <a href="${BASE_URL()}" style="color:#bbb">${BASE_URL()}</a></p>
      </div>$$,
  (extract(epoch from now()) * 1000)::bigint,
  NULL
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO email_templates (key, subject, body, updated_at, updated_by) VALUES (
  'team_invite',
  $$You've been added to "${projectName}" on AvatarPlatform$$,
  $$
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin:0 0 16px;font-size:20px">You've been added to a chatbot</h2>
        <p style="color:#555;line-height:1.6"><strong>${escapeHtml(inviterEmail)}</strong> added you as a team member on <strong>${escapeHtml(projectName)}</strong>. You can view its conversations and analytics from your dashboard.</p>
        <a href="${BASE_URL()}/dashboard" style="display:inline-block;margin:24px 0;padding:12px 24px;background:#7c6af5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Go to dashboard →</a>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="color:#bbb;font-size:11px">AvatarPlatform · <a href="${BASE_URL()}" style="color:#bbb">${BASE_URL()}</a></p>
      </div>$$,
  (extract(epoch from now()) * 1000)::bigint,
  NULL
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO email_templates (key, subject, body, updated_at, updated_by) VALUES (
  'welcome',
  $$Welcome to AvatarPlatform$$,
  $$
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin:0 0 16px;font-size:20px">Welcome to AvatarPlatform, ${displayName}!</h2>
        <p style="color:#555;line-height:1.6">You're all set. Create your first AI talking-character chatbot in minutes.</p>
        <a href="${BASE_URL()}/dashboard" style="display:inline-block;margin:24px 0;padding:12px 24px;background:#7c6af5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Go to dashboard →</a>
        <p style="color:#555;line-height:1.6;font-size:13px">Questions? <a href="${BASE_URL()}/contact" style="color:#7c6af5">Book a setup call</a> or browse the <a href="${BASE_URL()}/docs" style="color:#7c6af5">docs</a>.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="color:#bbb;font-size:11px">AvatarPlatform · <a href="${BASE_URL()}" style="color:#bbb">${BASE_URL()}</a></p>
      </div>$$,
  (extract(epoch from now()) * 1000)::bigint,
  NULL
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO email_templates (key, subject, body, updated_at, updated_by) VALUES (
  'contact_message',
  $$Contact form: ${name}$$,
  $$
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin:0 0 16px;font-size:20px">New contact message</h2>
        <p style="color:#555"><strong>${escapeHtml(name)}</strong> &lt;${escapeHtml(email)}&gt;</p>
        <p style="color:#333;line-height:1.6;white-space:pre-wrap">${escapeHtml(message)}</p>
      </div>$$,
  (extract(epoch from now()) * 1000)::bigint,
  NULL
)
ON CONFLICT (key) DO NOTHING;
