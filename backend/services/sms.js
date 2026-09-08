/**
 * SMS service — wraps Twilio with lazy client init.
 *
 * Configure via env vars:
 *   TWILIO_ACCOUNT_SID  — Twilio account SID
 *   TWILIO_AUTH_TOKEN   — Twilio auth token
 *   TWILIO_FROM_NUMBER  — Twilio-owned sending number (E.164, e.g. +15551234567)
 *
 * When TWILIO_ACCOUNT_SID is not set the module logs a warning and all
 * sends are no-ops, mirroring services/email.js's SMTP-not-configured
 * behavior — so the server boots and functions without SMS configured.
 */
const logger = require('../logger').child({ module: 'services/sms' });

let _client = null;
let _triedInit = false;

function getClient() {
  if (_triedInit) return _client;
  _triedInit = true;
  if (!process.env.TWILIO_ACCOUNT_SID) return null;
  // Required lazily (not at module load) so a deployment without the
  // `twilio` package's native deps present still boots when SMS is unused.
  const twilio = require('twilio');
  _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return _client;
}

/**
 * @param {string} toPhone E.164 phone number
 * @param {string} body Message text
 */
async function sendSms(toPhone, body) {
  const client = getClient();
  if (!client) {
    logger.warn({ to: toPhone }, 'Twilio not configured — SMS not sent');
    return;
  }
  if (!process.env.TWILIO_FROM_NUMBER) {
    logger.warn({ to: toPhone }, 'TWILIO_FROM_NUMBER not set — SMS not sent');
    return;
  }
  try {
    await client.messages.create({ to: toPhone, from: process.env.TWILIO_FROM_NUMBER, body });
    logger.info({ to: toPhone }, 'sms sent');
  } catch (e) {
    logger.error({ err: e.message, to: toPhone }, 'sms send failed');
  }
}

module.exports = { sendSms };
