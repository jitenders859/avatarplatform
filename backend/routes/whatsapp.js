/**
 * WhatsApp channel (see docs/competitor-feature-implementation-plan.md 3b)
 * — a thin adapter mapping WhatsApp Business Cloud API webhook events onto
 * the same RAG Q&A logic /embed/:publicId/ask uses (services/answerQuestion.js),
 * so this file has no retrieval/prompt/persistence logic of its own.
 *
 * Setup (per project, in project.html's Settings tab): a WhatsApp Business
 * phone_number_id and an access token, both from the Meta developer
 * dashboard. Two app-wide values in .env: WHATSAPP_VERIFY_TOKEN (used only
 * for the one-time webhook handshake) and WHATSAPP_APP_SECRET (used to
 * verify the X-Hub-Signature-256 header Meta signs every webhook POST
 * with — same purpose as billing.js's Stripe signature check, so this
 * endpoint can't be spoofed into triggering AI calls / WhatsApp sends on a
 * project's dime).
 *
 * NOT tested against live Meta infrastructure — this follows the
 * documented WhatsApp Cloud API webhook payload shape and signature scheme
 * (stable for years), but has not been exercised against a real WhatsApp
 * Business account.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { checkLimit } = require('../services/usage');
const { answerQuestion } = require('../services/answerQuestion');
const logger = require('../logger').child({ module: 'whatsapp' });

const router = express.Router();
const GRAPH_VERSION = 'v20.0';

/** Deterministic per-(phone_number_id, wa_id) session UUID, so a returning WhatsApp sender keeps one AvatarPlatform session without a separate mapping table. */
function sessionIdFor(phoneNumberId, waId) {
  const hash = crypto.createHash('sha256').update(`${phoneNumberId}:${waId}`).digest('hex');
  return [hash.slice(0, 8), hash.slice(8, 12), '5' + hash.slice(13, 16), '8' + hash.slice(17, 20), hash.slice(20, 32)].join('-');
}

async function sendWhatsAppText(phoneNumberId, accessToken, to, body) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: body.slice(0, 4096) },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn({ status: res.status, body: text.slice(0, 300) }, 'WhatsApp send failed');
  }
}

// Meta's one-time webhook verification handshake — plain query params, no body.
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

/**
 * Inbound message webhook. Mounted in server.js with express.raw() BEFORE
 * the global express.json(), same as billing.js's Stripe webhook, because
 * signature verification needs the exact raw bytes Meta signed.
 */
async function webhookHandler(req, res) {
  // Ack immediately — Meta expects a fast 200 and retries on timeout/5xx.
  res.sendStatus(200);

  try {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) {
      logger.warn('WHATSAPP_APP_SECRET not set — rejecting webhook (cannot verify signature)');
      return;
    }
    const signature = req.get('X-Hub-Signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.body).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      logger.warn('WhatsApp webhook signature mismatch — dropping');
      return;
    }

    const payload = JSON.parse(req.body.toString('utf8'));
    const entries = payload?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        const messages = value.messages || [];
        if (!messages.length) continue; // status callbacks etc. — nothing to answer

        const project = await db.findOne('projects', { whatsappPhoneNumberId: phoneNumberId });
        if (!project || !project.whatsappAccessToken) {
          logger.warn({ phoneNumberId }, 'WhatsApp message for unmapped phone_number_id');
          continue;
        }

        const limitCheck = await checkLimit(project.userId, 'message', 1);
        if (!limitCheck.ok) {
          await sendWhatsAppText(phoneNumberId, project.whatsappAccessToken, messages[0].from,
            'This assistant has reached its usage limit for this month. Please check back later.');
          continue;
        }

        for (const msg of messages) {
          if (msg.type !== 'text' || !msg.text?.body) continue; // media/voice/etc. not handled yet
          const sid = sessionIdFor(phoneNumberId, msg.from);
          try {
            const { answer } = await answerQuestion(project, msg.text.body, sid, { ip: 'whatsapp' });
            await sendWhatsAppText(phoneNumberId, project.whatsappAccessToken, msg.from, answer);
          } catch (e) {
            logger.error({ err: e.message, projectId: project.id }, 'WhatsApp answerQuestion failed');
            await sendWhatsAppText(phoneNumberId, project.whatsappAccessToken, msg.from,
              'Sorry, something went wrong on my end — please try again in a moment.');
          }
        }
      }
    }
  } catch (e) {
    logger.error({ err: e.message }, 'WhatsApp webhook handling failed');
  }
}

module.exports = { router, webhookHandler };
