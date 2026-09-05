/**
 * Admin-configurable settings — lets specific keys (currently
 * GEMINI_API_KEY, PUBLIC_GEMINI_API_KEY, STUDY_MODEL) be overridden from
 * the admin panel without a redeploy. See supabase/schema.sql's
 * admin_settings table: a present row for a key overrides the env var of
 * the same name; deleting it (or setSetting-ing an empty string) reverts
 * to .env — takes effect on the very next call, deliberately uncached, so
 * an override (or clearing one) is never stale.
 */
const db = require('../db');

async function getSetting(key) {
  const row = await db.findOne('adminSettings', { key });
  return row ? row.value : (process.env[key] || '');
}

// Empty/null value clears the override. admin_settings' primary key is
// "key", not "id", so this upserts via raw SQL rather than db.update()
// (which unconditionally targets an "id" column — see db.js).
async function setSetting(key, value, adminId) {
  if (value === '' || value == null) {
    await db.remove('adminSettings', { key });
  } else {
    await db.query(
      `INSERT INTO admin_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3, updated_by = $4`,
      [key, value, Date.now(), adminId || null]
    );
  }
}

module.exports = { getSetting, setSetting };
