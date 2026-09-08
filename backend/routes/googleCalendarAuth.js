/**
 * Google Calendar OAuth connection for tour booking — see
 * docs/superpowers/specs/2026-09-08-google-calendar-tour-booking-design.md
 * and backend/services/googleCalendar.js.
 *
 * Exports { router, callbackHandler } — mirroring backend/routes/billing.js's
 * split between its authenticated router and a separately-mounted webhook
 * handler. `callbackHandler` must be mounted at a FIXED path (see
 * backend/server.js) matching GOOGLE_CALENDAR_REDIRECT_URI exactly — an
 * OAuth redirect_uri cannot vary per project, so unlike every other route
 * here it takes no :projectId in its path. Google redirects the visitor's
 * browser straight to it with no Authorization header available; it's
 * authenticated instead by the signed `state` JWT minted in /connect and
 * verified here, using this app's own JWT_SECRET.
 *
 * ACCEPTED RISK: `state` is a self-contained, project-scoped claim, not a
 * session-bound or single-use nonce — this app is Bearer/localStorage-token
 * auth throughout (no cookies), so there's no session to bind it to without
 * introducing one just for this flow. Within its 10-minute expiry, a leaked
 * `state` value (e.g. via browser history or a proxy access log — plausible
 * for a GET-based redirect) could be paired with an attacker's OWN Google
 * authorization code to link the attacker's calendar to someone else's
 * project (a "login/mix-up CSRF" — the attacker still needs their own valid
 * Google consent, they can't forge `code` or `state` itself). Judged
 * low-severity (requires an out-of-band leak of a short-lived token) and
 * accepted rather than adding session-binding infrastructure for it; if
 * this flow ever handles more sensitive data than tour scheduling, revisit
 * with a single-use marker (e.g. the JWT's `jti` checked against a
 * short-lived store) to shrink the window further.
 */
const express = require('express');
const { randomUUID: uuid } = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const googleCalendar = require('../services/googleCalendar');
const logger = require('../logger').child({ module: 'google-calendar-auth' });

const JWT_SECRET = process.env.JWT_SECRET;
const STATE_PURPOSE = 'gcal_connect';

const router = express.Router();

async function ownsProject(req, res, next) {
  const p = await db.findOne('projects', { id: req.params.projectId, userId: req.user.id });
  if (!p) return res.status(404).json({ error: 'Project not found' });
  req.project = p;
  next();
}

function buildState(projectId) {
  return jwt.sign({ pid: projectId, purpose: STATE_PURPOSE }, JWT_SECRET, { expiresIn: '10m' });
}

function verifyState(state) {
  const payload = jwt.verify(state, JWT_SECRET, { algorithms: ['HS256'] });
  if (payload.purpose !== STATE_PURPOSE || !payload.pid) throw new Error('Invalid state');
  return payload.pid;
}

router.get('/:projectId/calendar/status', authRequired, ownsProject, async (req, res) => {
  const connection = await db.findOne('calendarConnections', { projectId: req.project.id });
  res.json({ connected: !!connection, googleEmail: connection?.googleEmail || null });
});

router.get('/:projectId/calendar/connect', authRequired, ownsProject, (req, res) => {
  if (!googleCalendar.isConfigured()) {
    return res.status(503).json({ error: 'Google Calendar is not configured on this server' });
  }
  res.json({ url: googleCalendar.buildAuthorizationUrl(buildState(req.project.id)) });
});

router.delete('/:projectId/calendar', authRequired, ownsProject, async (req, res) => {
  await db.remove('calendarConnections', { projectId: req.project.id });
  res.json({ ok: true });
});

// Public — see file header. Always redirects back to the dashboard rather
// than returning raw JSON, since this is where the visitor's browser lands
// after leaving Google.
async function callbackHandler(req, res) {
  const { code, state, error } = req.query;
  let projectId = null;
  try {
    if (state) projectId = verifyState(String(state));
  } catch (e) {
    logger.warn({ err: e.message }, 'invalid calendar OAuth state');
  }

  const redirectBack = (status) =>
    res.redirect(`/project.html?id=${encodeURIComponent(projectId || '')}&tab=tours&calendar=${status}`);

  if (error || !code || !projectId) return redirectBack('error');

  try {
    const { refreshToken, accessToken, expiresAt, googleEmail } = await googleCalendar.exchangeCode(String(code));
    const existing = await db.findOne('calendarConnections', { projectId });
    const fields = { projectId, googleEmail, refreshToken, accessToken, accessTokenExpiresAt: expiresAt };
    if (existing) {
      await db.update('calendarConnections', existing.id, fields);
    } else {
      await db.insert('calendarConnections', { id: uuid(), ...fields, createdAt: Date.now() });
    }
    return redirectBack('connected');
  } catch (e) {
    logger.error({ err: e.message }, 'google calendar token exchange failed');
    return redirectBack('error');
  }
}

module.exports = { router, callbackHandler };
