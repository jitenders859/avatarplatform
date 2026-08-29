/**
 * Webhook delivery with retry-with-backoff, replacing the old fire-and-
 * forget single-attempt POST in routes/embed.js's /log handler (see
 * improvement-prompts.md Prompt F4 item 6). Every delivery attempt is
 * logged to the webhook_deliveries table (owner-visible on project.html's
 * Settings tab) so a failing endpoint is diagnosable instead of silent.
 *
 * Retry scheduling follows the same PROCESS_MODE branch as file processing
 * (services/processMode.js): inline uses setTimeout directly (fine for a
 * long-lived process, lost on a Vercel freeze), Inngest uses step.sleep
 * inside a durable function (survives freezes, needs Inngest configured).
 */
const crypto = require('crypto');
const uuid = crypto.randomUUID;
const db = require('../db');
const { safeFetch } = require('./safeFetch');
const { resolveProcessMode } = require('./processMode');
const logger = require('../logger').child({ module: 'webhook-delivery' });

// Attempt 1 fires immediately (synchronously, from queueWebhookDelivery);
// these are the delays before attempts 2-5. Index = attempt number that
// just failed.
const BACKOFF_MS = [0, 30_000, 120_000, 600_000, 1_800_000];
const MAX_ATTEMPTS = BACKOFF_MS.length;

async function attemptDelivery(deliveryId) {
  const delivery = await db.findOne('webhookDeliveries', { id: deliveryId });
  if (!delivery || delivery.status !== 'pending') return;

  const project = await db.findOne('projects', { id: delivery.projectId });
  const attempt = delivery.attempt + 1;

  if (!project || !project.webhookUrl) {
    await db.update('webhookDeliveries', delivery.id, {
      status: 'failed', attempt, error: 'Webhook URL no longer configured', deliveredAt: null,
    });
    return;
  }

  const payloadStr = JSON.stringify(delivery.payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', project.webhookSecret || '').update(payloadStr).digest('hex');

  let response = null;
  try {
    response = await safeFetch(project.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Avatar-Signature': sig },
      body: payloadStr,
      timeout: 5000,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await db.update('webhookDeliveries', delivery.id, {
      status: 'success', attempt, responseStatus: response.status, deliveredAt: Date.now(), error: null,
    });
  } catch (e) {
    const exhausted = attempt >= MAX_ATTEMPTS;
    await db.update('webhookDeliveries', delivery.id, {
      status: exhausted ? 'failed' : 'pending',
      attempt,
      error: e.message,
      responseStatus: response ? response.status : null,
    });
    if (exhausted) {
      logger.warn({ deliveryId: delivery.id, projectId: project.id, attempt }, 'webhook delivery exhausted retries');
    } else {
      scheduleRetry(delivery.id, BACKOFF_MS[attempt]);
    }
  }
}

function scheduleRetry(deliveryId, delayMs) {
  if (resolveProcessMode() === 'inline') {
    setTimeout(() => attemptDelivery(deliveryId).catch((e) => logger.warn({ err: e.message, deliveryId }, 'webhook retry threw')), delayMs);
    return;
  }
  const inngest = require('../inngest/client');
  inngest.send({ name: 'webhook/retry', data: { deliveryId, delayMs } }).catch((e) =>
    logger.warn({ err: e.message, deliveryId }, 'failed to enqueue webhook retry')
  );
}

/**
 * Log a delivery row and fire the first attempt. Fire-and-forget from the
 * caller's perspective (matches the previous behavior) — errors are
 * recorded on the row, not thrown back to the request that triggered it.
 */
async function queueWebhookDelivery(project, eventType, payload) {
  if (!project.webhookUrl) return;
  const delivery = await db.insert('webhookDeliveries', {
    id: uuid(),
    projectId: project.id,
    eventType,
    payload,
    status: 'pending',
    attempt: 0,
    createdAt: Date.now(),
  });
  await attemptDelivery(delivery.id);
}

// Exported alongside MAX_ATTEMPTS so callers that only need to *display*
// the retry schedule (e.g. the admin webhook-deliveries tab estimating a
// "next retry" time for a pending row) can read the same backoff table
// instead of hardcoding a second copy of it. Read-only use — the actual
// scheduling decision still lives entirely in scheduleRetry() above.
module.exports = { queueWebhookDelivery, attemptDelivery, MAX_ATTEMPTS, BACKOFF_MS };
