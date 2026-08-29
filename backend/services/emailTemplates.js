/**
 * DB-backed, admin-editable email templates (Prompt 5f). Mirrors
 * backend/services/settings.js's DB-overrides-fallback pattern: a present
 * email_templates row wins for that key; a missing row, an empty DB, or an
 * unreachable DB falls back to the hardcoded string below, which is a
 * byte-for-byte copy of what backend/services/email.js used to send
 * inline, before this table existed.
 *
 * Each template's `body` is its HTML content only — see the email_templates
 * migration for why the plain-text alternative part of each email stays
 * hardcoded in email.js rather than living in this table (the table has a
 * single body column, not separate text/html columns).
 *
 * Placeholder syntax is preserved verbatim from the original template
 * literals (e.g. \${link}, \${BASE_URL()}, \${escapeHtml(name)}) as inert
 * text in both the DB row and the fallback below. email.js interpolates by
 * doing a plain string-replace of these exact tokens at send time — no
 * templating engine (Handlebars/Mustache) is introduced.
 */
const db = require('../db');
const logger = require('../logger').child({ module: 'services/emailTemplates' });

const FALLBACK_TEMPLATES = {
  "password_reset": {
    "subject": "Reset your AvatarPlatform password",
    "body": "\n      <div style=\"font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px\">\n        <h2 style=\"margin:0 0 16px;font-size:20px\">Reset your password</h2>\n        <p style=\"color:#555;line-height:1.6\">Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>\n        <a href=\"${link}\" style=\"display:inline-block;margin:24px 0;padding:12px 24px;background:#7c6af5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600\">Reset password</a>\n        <p style=\"color:#999;font-size:12px\">If you didn't request a password reset, you can safely ignore this email.</p>\n        <hr style=\"border:none;border-top:1px solid #eee;margin:24px 0\"/>\n        <p style=\"color:#bbb;font-size:11px\">AvatarPlatform · <a href=\"${BASE_URL()}\" style=\"color:#bbb\">${BASE_URL()}</a></p>\n      </div>"
  },
  "verification": {
    "subject": "Verify your AvatarPlatform email",
    "body": "\n      <div style=\"font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px\">\n        <h2 style=\"margin:0 0 16px;font-size:20px\">Verify your email</h2>\n        <p style=\"color:#555;line-height:1.6\">Click the button below to confirm your email address. This link expires in <strong>24 hours</strong>.</p>\n        <a href=\"${link}\" style=\"display:inline-block;margin:24px 0;padding:12px 24px;background:#7c6af5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600\">Verify email</a>\n        <p style=\"color:#999;font-size:12px\">If you didn't create an AvatarPlatform account, you can safely ignore this email.</p>\n        <hr style=\"border:none;border-top:1px solid #eee;margin:24px 0\"/>\n        <p style=\"color:#bbb;font-size:11px\">AvatarPlatform · <a href=\"${BASE_URL()}\" style=\"color:#bbb\">${BASE_URL()}</a></p>\n      </div>"
  },
  "team_invite": {
    "subject": "You've been added to \"${projectName}\" on AvatarPlatform",
    "body": "\n      <div style=\"font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px\">\n        <h2 style=\"margin:0 0 16px;font-size:20px\">You've been added to a chatbot</h2>\n        <p style=\"color:#555;line-height:1.6\"><strong>${escapeHtml(inviterEmail)}</strong> added you as a team member on <strong>${escapeHtml(projectName)}</strong>. You can view its conversations and analytics from your dashboard.</p>\n        <a href=\"${BASE_URL()}/dashboard\" style=\"display:inline-block;margin:24px 0;padding:12px 24px;background:#7c6af5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600\">Go to dashboard →</a>\n        <hr style=\"border:none;border-top:1px solid #eee;margin:24px 0\"/>\n        <p style=\"color:#bbb;font-size:11px\">AvatarPlatform · <a href=\"${BASE_URL()}\" style=\"color:#bbb\">${BASE_URL()}</a></p>\n      </div>"
  },
  "welcome": {
    "subject": "Welcome to AvatarPlatform",
    "body": "\n      <div style=\"font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px\">\n        <h2 style=\"margin:0 0 16px;font-size:20px\">Welcome to AvatarPlatform, ${displayName}!</h2>\n        <p style=\"color:#555;line-height:1.6\">You're all set. Create your first AI talking-character chatbot in minutes.</p>\n        <a href=\"${BASE_URL()}/dashboard\" style=\"display:inline-block;margin:24px 0;padding:12px 24px;background:#7c6af5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600\">Go to dashboard →</a>\n        <p style=\"color:#555;line-height:1.6;font-size:13px\">Questions? <a href=\"${BASE_URL()}/contact\" style=\"color:#7c6af5\">Book a setup call</a> or browse the <a href=\"${BASE_URL()}/docs\" style=\"color:#7c6af5\">docs</a>.</p>\n        <hr style=\"border:none;border-top:1px solid #eee;margin:24px 0\"/>\n        <p style=\"color:#bbb;font-size:11px\">AvatarPlatform · <a href=\"${BASE_URL()}\" style=\"color:#bbb\">${BASE_URL()}</a></p>\n      </div>"
  },
  "contact_message": {
    "subject": "Contact form: ${name}",
    "body": "\n      <div style=\"font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px\">\n        <h2 style=\"margin:0 0 16px;font-size:20px\">New contact message</h2>\n        <p style=\"color:#555\"><strong>${escapeHtml(name)}</strong> &lt;${escapeHtml(email)}&gt;</p>\n        <p style=\"color:#333;line-height:1.6;white-space:pre-wrap\">${escapeHtml(message)}</p>\n      </div>"
  }
};

const TEMPLATE_KEYS = Object.keys(FALLBACK_TEMPLATES);

const CACHE_TTL_MS = 15_000;
let cache = null;
let cachedAt = 0;

// Same reasoning as settings.js loadAll(): don't attempt pool.connect() at
// all when there's no DB configured (test runs, or a deploy that hasn't
// set DATABASE_URL yet) — a failed attempt isn't cached, so every send
// would otherwise retry the full connection timeout. Straight to the
// hardcoded fallback, no DB round-trip.
async function loadAll() {
  if (!process.env.DATABASE_URL) {
    cache = {};
    cachedAt = Date.now();
    return cache;
  }
  try {
    const rows = await db.findAll('email_templates', {});
    const map = {};
    for (const row of rows) map[row.key] = { subject: row.subject, body: row.body };
    cache = map;
    cachedAt = Date.now();
    return map;
  } catch (e) {
    logger.warn({ err: e.message }, 'email_templates lookup failed — falling back to hardcoded templates');
    cache = {};
    cachedAt = Date.now();
    return cache;
  }
}

async function currentMap() {
  if (!cache || Date.now() - cachedAt > CACHE_TTL_MS) return loadAll();
  return cache;
}

// Returns { subject, body }, DB-first with the identical hardcoded string
// as fallback if the DB is unavailable or the row is missing.
async function getTemplate(key) {
  const map = await currentMap();
  return map[key] || FALLBACK_TEMPLATES[key];
}

async function setTemplate(key, subject, body, updatedBy) {
  if (!TEMPLATE_KEYS.includes(key)) throw new Error('Unknown template key');
  await db.query(
    `INSERT INTO email_templates (key, subject, body, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key) DO UPDATE SET subject = $2, body = $3, updated_at = $4, updated_by = $5`,
    [key, subject, body, Date.now(), updatedBy]
  );
  cache = null;
}

// Admin-panel listing: every known key, DB value if present else the
// hardcoded fallback, so the panel always shows 5 editable rows even
// before any admin has touched one.
async function listTemplates() {
  const map = await currentMap();
  return TEMPLATE_KEYS.map(key => ({
    key,
    subject: (map[key] || FALLBACK_TEMPLATES[key]).subject,
    body: (map[key] || FALLBACK_TEMPLATES[key]).body,
    source: map[key] ? 'admin' : 'default',
  }));
}

module.exports = { getTemplate, setTemplate, listTemplates, TEMPLATE_KEYS, FALLBACK_TEMPLATES };
