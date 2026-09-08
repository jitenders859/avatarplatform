/**
 * Google Calendar integration for tour booking (see backend/services/
 * tools.js's check_availability/book_tour tools and backend/routes/
 * googleCalendarAuth.js).
 *
 * Hand-rolled REST client against Node's built-in fetch, not the
 * `googleapis` npm package — following the precedent set by
 * backend/services/oidc.js, which hand-rolls OAuth for the same reason: no
 * such library was already a dependency, and Google's OAuth2 + Calendar v3
 * API here is a handful of fixed, well-documented endpoints (no discovery
 * step needed), so the reasoning that justified hand-rolling OIDC applies
 * even more easily here.
 *
 * Scope requested is calendar.events only — this can create/read/delete
 * events it created, not read or modify the owner's other calendar data.
 *
 * Every call to Google (token exchange/refresh, freebusy, event insert) is
 * made synchronously inside the /study function-calling loop while the
 * visitor is waiting on a chat response (see backend/services/tools.js's
 * check_availability/book_tour handlers) — an unbounded fetch here would
 * let a slow or hanging Google API call hang that request indefinitely.
 * FETCH_TIMEOUT_MS bounds every call via AbortSignal.timeout, matching the
 * 8s timeout backend/services/tools.js#callProjectAction already uses for
 * synchronous external calls inside this same tool loop.
 */
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events openid email';
const EXPIRY_SKEW_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

class GoogleAuthRevokedError extends Error {}

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALENDAR_REDIRECT_URI);
}

function buildAuthorizationUrl(state) {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.GOOGLE_CALENDAR_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

// Google's token response includes a signed id_token JWT when 'openid'
// scope is requested. We only decode its payload (no signature check) — it
// came directly from Google's token endpoint over TLS in the same request
// as the tokens themselves, not from anything the caller supplied, so
// re-verifying its signature would guard against a threat that doesn't
// apply here. Decoded manually (rather than via jsonwebtoken's decode())
// because that also parses and validates the header segment as JSON,
// which is unnecessary work for a value we're not otherwise using and one
// more way for a slightly-off token shape to make this throw; the try/catch
// below covers a malformed or missing token either way.
function decodeEmailFromIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload.email === 'string' ? payload.email : null;
  } catch (_) {
    return null;
  }
}

async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_CALENDAR_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) {
    throw new Error(body.error_description || body.error || 'Google did not return a refresh token — try disconnecting and reconnecting');
  }
  return {
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
    googleEmail: decodeEmailFromIdToken(body.id_token),
  };
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.error === 'invalid_grant') throw new GoogleAuthRevokedError('Google Calendar access was revoked');
    throw new Error(body.error_description || body.error || `Token refresh failed: HTTP ${res.status}`);
  }
  return { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
}

/**
 * Returns a usable access token, refreshing first if the cached one has
 * expired. `updateTokens(connectionId, patch)` persists a refreshed token
 * — injected by the caller rather than importing db.js here, to keep this
 * module's only real dependency the built-in fetch, matching oidc.js's
 * minimal-surface style.
 */
async function getValidAccessToken(connection, updateTokens) {
  if (connection.accessToken && connection.accessTokenExpiresAt > Date.now() + EXPIRY_SKEW_MS) {
    return connection.accessToken;
  }
  const { accessToken, expiresAt } = await refreshAccessToken(connection.refreshToken);
  await updateTokens(connection.id, { accessToken, accessTokenExpiresAt: expiresAt });
  return accessToken;
}

async function freeBusy(accessToken, timeMinISO, timeMaxISO) {
  const res = await fetch(FREEBUSY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id: 'primary' }] }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `freebusy failed: HTTP ${res.status}`);
  return body.calendars?.primary?.busy || [];
}

async function insertEvent(accessToken, { summary, description, location, startISO, endISO, attendeeEmail }) {
  const res = await fetch(`${EVENTS_URL}?sendUpdates=all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      summary,
      description,
      location: location || undefined,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees: [{ email: attendeeEmail }],
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `event creation failed: HTTP ${res.status}`);
  return body.id;
}

module.exports = {
  isConfigured, buildAuthorizationUrl, exchangeCode, getValidAccessToken, freeBusy, insertEvent,
  GoogleAuthRevokedError,
};
