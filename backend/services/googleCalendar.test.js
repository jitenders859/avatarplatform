// backend/services/googleCalendar.test.js
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'http://localhost:8080/api/google-calendar/callback';

const {
  isConfigured, buildAuthorizationUrl, exchangeCode, getValidAccessToken,
  freeBusy, insertEvent, GoogleAuthRevokedError,
} = require('./googleCalendar');

let originalFetch;
let fetchCalls;
let fetchImpl;

beforeEach(() => {
  originalFetch = global.fetch;
  fetchCalls = [];
  fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchImpl(url, opts);
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

test('isConfigured is true when all three env vars are set', () => {
  assert.equal(isConfigured(), true);
});

test('isConfigured is false when a required env var is missing', () => {
  const saved = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  assert.equal(isConfigured(), false);
  process.env.GOOGLE_CLIENT_SECRET = saved;
});

test('buildAuthorizationUrl includes the fixed redirect URI, calendar.events scope, and state', () => {
  const url = new URL(buildAuthorizationUrl('my-state-token'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8080/api/google-calendar/callback');
  assert.match(url.searchParams.get('scope'), /calendar\.events/);
  assert.equal(url.searchParams.get('state'), 'my-state-token');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
});

test('exchangeCode posts to the token endpoint and returns tokens + email from id_token', () => {
  const idToken = 'header.' + Buffer.from(JSON.stringify({ email: 'owner@example.com' })).toString('base64url') + '.sig';
  fetchImpl = async () => ({
    ok: true,
    json: async () => ({ refresh_token: 'rt-1', access_token: 'at-1', expires_in: 3600, id_token: idToken }),
  });
  return exchangeCode('auth-code-123').then((result) => {
    assert.equal(result.refreshToken, 'rt-1');
    assert.equal(result.accessToken, 'at-1');
    assert.equal(result.googleEmail, 'owner@example.com');
    assert.ok(result.expiresAt > Date.now());
    assert.equal(fetchCalls[0].url, 'https://oauth2.googleapis.com/token');
    assert.match(fetchCalls[0].opts.body.toString(), /grant_type=authorization_code/);
  });
});

test('exchangeCode throws if Google does not return a refresh_token', async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ access_token: 'at-1', expires_in: 3600 }) });
  await assert.rejects(() => exchangeCode('auth-code-123'), /refresh token/);
});

test('getValidAccessToken returns the cached token when not expired', async () => {
  const connection = { id: 'conn-1', accessToken: 'cached-token', accessTokenExpiresAt: Date.now() + 60 * 60 * 1000, refreshToken: 'rt-1' };
  let updateCalled = false;
  const token = await getValidAccessToken(connection, async () => { updateCalled = true; });
  assert.equal(token, 'cached-token');
  assert.equal(updateCalled, false);
  assert.equal(fetchCalls.length, 0);
});

test('getValidAccessToken refreshes and persists when expired', async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ access_token: 'new-token', expires_in: 3600 }) });
  const connection = { id: 'conn-1', accessToken: 'old-token', accessTokenExpiresAt: Date.now() - 1000, refreshToken: 'rt-1' };
  let updatePatch = null;
  const token = await getValidAccessToken(connection, async (id, patch) => { updatePatch = { id, patch }; });
  assert.equal(token, 'new-token');
  assert.equal(updatePatch.id, 'conn-1');
  assert.equal(updatePatch.patch.accessToken, 'new-token');
});

test('getValidAccessToken throws GoogleAuthRevokedError on invalid_grant', async () => {
  fetchImpl = async () => ({ ok: false, json: async () => ({ error: 'invalid_grant' }) });
  const connection = { id: 'conn-1', accessToken: null, accessTokenExpiresAt: 0, refreshToken: 'revoked-rt' };
  await assert.rejects(
    () => getValidAccessToken(connection, async () => {}),
    GoogleAuthRevokedError
  );
});

test('GoogleAuthRevokedError has a correctly-set name, not the generic "Error"', () => {
  const err = new GoogleAuthRevokedError('revoked');
  assert.equal(err.name, 'GoogleAuthRevokedError');
  assert.equal(err.toString(), 'GoogleAuthRevokedError: revoked');
});

test('getValidAccessToken throws a plain Error (not GoogleAuthRevokedError) for a non-invalid_grant refresh failure', async () => {
  fetchImpl = async () => ({ ok: false, json: async () => ({ error: 'server_error', error_description: 'Google is having issues' }) });
  const connection = { id: 'conn-1', accessToken: null, accessTokenExpiresAt: 0, refreshToken: 'rt-1' };
  await assert.rejects(() => getValidAccessToken(connection, async () => {}), (err) => {
    assert.ok(err instanceof Error);
    assert.ok(!(err instanceof GoogleAuthRevokedError));
    assert.match(err.message, /Google is having issues/);
    return true;
  });
});

test('getValidAccessToken still returns the refreshed token when persisting it fails (fails open)', async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ access_token: 'new-token', expires_in: 3600 }) });
  const connection = { id: 'conn-1', accessToken: 'old-token', accessTokenExpiresAt: Date.now() - 1000, refreshToken: 'rt-1' };
  const token = await getValidAccessToken(connection, async () => { throw new Error('DB is down'); });
  assert.equal(token, 'new-token');
});

test('freeBusy posts the time window and returns the primary calendar busy list', async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ calendars: { primary: { busy: [{ start: 'a', end: 'b' }] } } }) });
  const busy = await freeBusy('access-token', '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z');
  assert.deepEqual(busy, [{ start: 'a', end: 'b' }]);
  assert.equal(fetchCalls[0].url, 'https://www.googleapis.com/calendar/v3/freeBusy');
  assert.equal(fetchCalls[0].opts.headers.Authorization, 'Bearer access-token');
});

test('freeBusy returns an empty array when the calendar has no busy periods', async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ calendars: { primary: {} } }) });
  const busy = await freeBusy('access-token', '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z');
  assert.deepEqual(busy, []);
});

test('freeBusy throws with Google\'s error message on a non-401 failure', async () => {
  fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'Backend error' } }) });
  await assert.rejects(
    () => freeBusy('access-token', '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z'),
    /Backend error/
  );
});

test('freeBusy throws GoogleAuthRevokedError on a 401 (access revoked mid-call)', async () => {
  fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid Credentials' } }) });
  await assert.rejects(
    () => freeBusy('access-token', '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z'),
    GoogleAuthRevokedError
  );
});

test('insertEvent posts the event and returns its id', async () => {
  fetchImpl = async () => ({ ok: true, json: async () => ({ id: 'event-123' }) });
  const id = await insertEvent('access-token', {
    summary: 'Tour: Acme — Jane', description: 'desc', location: '123 Main St',
    startISO: '2026-09-14T13:00:00.000Z', endISO: '2026-09-14T13:30:00.000Z', attendeeEmail: 'jane@example.com',
  });
  assert.equal(id, 'event-123');
  assert.match(fetchCalls[0].url, /sendUpdates=all/);
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.attendees[0].email, 'jane@example.com');
});

test('insertEvent throws with Google\'s error message on failure', async () => {
  fetchImpl = async () => ({ ok: false, json: async () => ({ error: { message: 'Invalid attendee' } }) });
  await assert.rejects(
    () => insertEvent('access-token', { summary: 's', startISO: 'a', endISO: 'b', attendeeEmail: 'x@example.com' }),
    /Invalid attendee/
  );
});

test('insertEvent throws GoogleAuthRevokedError on a 401 (access revoked mid-call)', async () => {
  fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid Credentials' } }) });
  await assert.rejects(
    () => insertEvent('access-token', { summary: 's', startISO: 'a', endISO: 'b', attendeeEmail: 'x@example.com' }),
    GoogleAuthRevokedError
  );
});

test('exchangeCode throws Google\'s error description on an actual HTTP failure (not just a missing refresh_token)', async () => {
  fetchImpl = async () => ({ ok: false, json: async () => ({ error: 'invalid_grant', error_description: 'Malformed auth code' }) });
  await assert.rejects(() => exchangeCode('bad-code'), /Malformed auth code/);
});
