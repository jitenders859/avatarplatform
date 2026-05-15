/**
 * Stripe wrapper with lazy initialization.
 *
 * The module loads cleanly even when STRIPE_SECRET_KEY is missing,
 * so the server can boot without billing configured. Calls fall back
 * to a clear "Stripe not configured" error at runtime.
 */
let _stripe = null;
let _initFailed = false;

function getStripe() {
  if (_initFailed) return null;
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    const Stripe = require('stripe');
    _stripe = new Stripe(key, { apiVersion: '2024-06-20' });
    return _stripe;
  } catch (e) {
    console.error('[stripe] init failed:', e.message);
    _initFailed = true;
    return null;
  }
}

function isConfigured() {
  return Boolean(getStripe());
}

module.exports = { getStripe, isConfigured };
