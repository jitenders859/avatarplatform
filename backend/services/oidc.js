/**
 * Minimal OIDC Authorization Code + PKCE client (see
 * docs/competitor-feature-implementation-plan.md 3c and
 * backend/routes/ssoAuth.js for the login/callback routes that use this).
 *
 * ══════════════════════════════════════════════════════════════════════
 * SECURITY NOTE — READ BEFORE ENABLING IN PRODUCTION
 *
 * This is hand-written against Node's built-in crypto/fetch rather than a
 * vetted OIDC library (openid-client or similar), because no such library
 * was already a dependency and adding one whose exact API this session
 * could not verify against a live provider seemed like its own risk. This
 * implementation:
 *   - Has NOT been exercised against a real OIDC provider (no live IdP
 *     available in this environment).
 *   - Has NOT had a professional security review.
 * Authentication code is exactly the category where a subtly wrong
 * implementation (state/nonce reuse, missing signature verification,
 * accepting the wrong algorithm, audience/issuer confusion) becomes an
 * account-takeover bug, not just a broken feature. Get this reviewed by
 * someone with OIDC security experience — or swap it for a maintained
 * library — before enabling SSO_ENABLED in a real deployment.
 * ══════════════════════════════════════════════════════════════════════
 *
 * Configuration (.env): OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET,
 * OIDC_REDIRECT_URI. SSO is inert (routes 404) unless all four are set.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const verifyJwt = promisify(jwt.verify);

function isConfigured() {
  return !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET && process.env.OIDC_REDIRECT_URI);
}

let discoveryCache = null;
let discoveryCachedAt = 0;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

async function discover() {
  if (discoveryCache && Date.now() - discoveryCachedAt < DISCOVERY_TTL_MS) return discoveryCache;
  const issuer = process.env.OIDC_ISSUER.replace(/\/$/, '');
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
  const doc = await res.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('OIDC discovery document is missing required endpoints');
  }
  discoveryCache = doc;
  discoveryCachedAt = Date.now();
  return doc;
}

let jwksCache = null;
let jwksCachedAt = 0;
const JWKS_TTL_MS = 10 * 60 * 1000;

async function getJwks(jwksUri) {
  if (jwksCache && Date.now() - jwksCachedAt < JWKS_TTL_MS) return jwksCache;
  const res = await fetch(jwksUri);
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const doc = await res.json();
  jwksCache = doc.keys || [];
  jwksCachedAt = Date.now();
  return jwksCache;
}

// Short-lived state store for the redirect round trip (state -> {nonce,
// codeVerifier, createdAt}). In-memory, matching this codebase's existing
// documented fallback posture for other in-memory stores (e.g.
// rateLimitStore.js without Redis configured) — NOT safe across multiple
// server instances/a serverless deployment without moving this to Redis,
// but a login flow that only breaks "log in again" on a cold instance
// swap is a much lower-stakes failure mode than the alternatives.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function pruneStates() {
  const now = Date.now();
  for (const [key, val] of pendingStates) {
    if (now - val.createdAt > STATE_TTL_MS) pendingStates.delete(key);
  }
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Builds the authorization redirect URL and registers the PKCE/state/nonce for the callback. */
async function buildAuthorizationUrl() {
  const doc = await discover();
  pruneStates();

  const state = base64url(crypto.randomBytes(24));
  const nonce = base64url(crypto.randomBytes(24));
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());

  pendingStates.set(state, { nonce, codeVerifier, createdAt: Date.now() });

  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.OIDC_CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.OIDC_REDIRECT_URI);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Converts a JWK RSA/EC key to a Node KeyObject for signature verification. */
function jwkToKeyObject(jwk) {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * Exchanges an authorization code for tokens, verifies the ID token's
 * signature (RS256/ES256 only — no 'none' or symmetric algorithms
 * accepted), issuer, audience, nonce, and expiry, and returns its claims.
 * Throws on any verification failure — callers must not treat a thrown
 * error as "unauthenticated, fall through to another method."
 */
async function handleCallback(code, state) {
  pruneStates();
  const pending = pendingStates.get(state);
  if (!pending) throw new Error('Invalid or expired SSO state');
  pendingStates.delete(state); // one-time use

  const doc = await discover();

  const tokenRes = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.OIDC_REDIRECT_URI,
      client_id: process.env.OIDC_CLIENT_ID,
      client_secret: process.env.OIDC_CLIENT_SECRET,
      code_verifier: pending.codeVerifier,
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`OIDC token exchange failed: HTTP ${tokenRes.status} ${text.slice(0, 300)}`);
  }
  const tokens = await tokenRes.json();
  if (!tokens.id_token) throw new Error('OIDC token response did not include an id_token');

  const header = JSON.parse(Buffer.from(tokens.id_token.split('.')[0], 'base64url').toString('utf8'));
  if (!['RS256', 'ES256'].includes(header.alg)) {
    throw new Error(`Unsupported ID token algorithm: ${header.alg}`);
  }

  const keys = await getJwks(doc.jwks_uri);
  const jwk = keys.find(k => k.kid === header.kid) || keys.find(k => !header.kid && keys.length === 1);
  if (!jwk) throw new Error('No matching JWKS key for ID token');
  const keyObject = jwkToKeyObject(jwk);

  const claims = await verifyJwt(tokens.id_token, keyObject, {
    algorithms: [header.alg],
    issuer: doc.issuer || process.env.OIDC_ISSUER,
    audience: process.env.OIDC_CLIENT_ID,
  });

  if (claims.nonce !== pending.nonce) throw new Error('ID token nonce mismatch');
  if (!claims.sub) throw new Error('ID token missing sub claim');
  if (!claims.email) throw new Error('ID token missing email claim — request the email scope');
  if (claims.email_verified === false) throw new Error('IdP reports this email as unverified');

  return {
    issuer: doc.issuer || process.env.OIDC_ISSUER,
    subject: claims.sub,
    email: String(claims.email).toLowerCase().trim(),
    name: claims.name || null,
  };
}

module.exports = { isConfigured, buildAuthorizationUrl, handleCallback };
