/**
 * SSO (OIDC) login routes — see docs/competitor-feature-implementation-plan.md
 * 3c and the security note at the top of backend/services/oidc.js (read
 * that before enabling this in production).
 *
 * Inert (returns 404) unless OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET/
 * OIDC_REDIRECT_URI are all set — see services/oidc.js#isConfigured.
 */
const express = require('express');
const crypto = require('crypto');
const uuid = crypto.randomUUID;
const db = require('../db');
const { signToken } = require('../middleware/auth');
const oidc = require('../services/oidc');
const logger = require('../logger').child({ module: 'sso-auth' });

const router = express.Router();

// Not gated below — lets the login page decide whether to show an SSO
// button without guessing from env vars it can't see.
router.get('/status', (req, res) => res.json({ enabled: oidc.isConfigured() }));

router.use((req, res, next) => {
  if (!oidc.isConfigured()) return res.status(404).json({ error: 'SSO is not configured on this server' });
  next();
});

router.get('/login', async (req, res) => {
  try {
    const url = await oidc.buildAuthorizationUrl();
    res.redirect(url);
  } catch (e) {
    logger.error({ err: e.message }, 'SSO login init failed');
    res.status(502).send('Could not start SSO login. Please try again or use email/password.');
  }
});

router.get('/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  if (error) {
    logger.warn({ error, errorDescription }, 'SSO provider returned an error');
    return res.status(400).send(`SSO login failed: ${errorDescription || error}`);
  }
  if (!code || !state) return res.status(400).send('Missing code or state');

  try {
    const identity = await oidc.handleCallback(String(code), String(state));

    // Look up by (provider, subject) first — the stable identifier.
    let user = await db.queryOne(
      'SELECT * FROM users WHERE sso_provider = $1 AND sso_subject = $2 LIMIT 1',
      [identity.issuer, identity.subject]
    );

    if (!user) {
      // First SSO login for this identity — link to an existing
      // password-account with the same verified email if one exists,
      // otherwise create a new account. A random, unusable password hash
      // satisfies users.password_hash's NOT NULL constraint without
      // creating a guessable password.
      const existingByEmail = await db.findOne('users', { email: identity.email });
      if (existingByEmail) {
        user = await db.update('users', existingByEmail.id, {
          ssoProvider: identity.issuer,
          ssoSubject: identity.subject,
        });
      } else {
        const unusableHash = crypto.randomBytes(32).toString('hex');
        user = await db.insert('users', {
          id: uuid(),
          email: identity.email,
          name: identity.name || identity.email.split('@')[0],
          passwordHash: `sso:${unusableHash}`, // never matches bcrypt.compare — SSO-only account
          ssoProvider: identity.issuer,
          ssoSubject: identity.subject,
          emailVerifiedAt: Date.now(), // IdP already verified this email
          createdAt: Date.now(),
        });
      }
    }

    if (user.suspended) return res.status(403).send('This account has been suspended.');

    const token = signToken(user.id);
    // Same URL-fragment handoff public/js/api.js already implements for
    // admin "View as user" — the token never touches server logs/referrers.
    res.redirect(`/dashboard#imp=${encodeURIComponent(token)}`);
  } catch (e) {
    logger.error({ err: e.message }, 'SSO callback failed');
    res.status(401).send('SSO login failed. Please try again or use email/password.');
  }
});

module.exports = router;
