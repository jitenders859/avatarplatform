/**
 * Business-hours check for the "away message" widget feature — see
 * projects.business_hours (supabase/schema.sql) and its use in
 * GET /embed/:publicId/config.
 *
 * Only same-day ranges are supported (openTime < closeTime) — an
 * overnight shift (e.g. 22:00–02:00) isn't handled, since it raises which
 * day it "belongs to" for the days[] list, which isn't worth the added UI
 * complexity for what this feature is for (a simple "we're open 9–5"
 * away-message toggle).
 */
const WEEKDAY_TO_CODE = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };

/**
 * @param {object|null} businessHours - { enabled, timezone, days, openTime, closeTime }
 * @param {Date} [now]
 * @returns {boolean} true if unconfigured/disabled (always "open"), or if `now`
 *   falls within the configured hours in the configured timezone.
 */
function isWithinBusinessHours(businessHours, now = new Date()) {
  if (!businessHours || !businessHours.enabled) return true;

  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: businessHours.timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
  } catch (_) {
    // Invalid/unknown timezone string — fail open rather than incorrectly
    // showing every visitor an "away" message because of a bad config value.
    return true;
  }

  const get = (type) => parts.find(p => p.type === type)?.value;
  const day = WEEKDAY_TO_CODE[get('weekday')];
  // Some locales/ICU builds render midnight as "24:00" instead of "00:00".
  const hour = String(get('hour')).padStart(2, '0').replace('24', '00');
  const nowTime = `${hour}:${get('minute')}`;

  if (!day || !(businessHours.days || []).includes(day)) return false;
  return nowTime >= businessHours.openTime && nowTime < businessHours.closeTime;
}

module.exports = { isWithinBusinessHours };
