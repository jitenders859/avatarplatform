/**
 * Durable background jobs, replacing the old fire-and-forget
 * setImmediate()-based processing (backend/services/process.js's old
 * processFileAsync) — Vercel serverless functions get frozen shortly after
 * the HTTP response is sent, so extraction/chunking/embedding needs to run
 * outside the request lifecycle entirely. Inngest calls back into this app's
 * /api/inngest route per step, so processing isn't bound by any single
 * Vercel function invocation's duration limit.
 */
const inngest = require('./client');
const db = require('../db');
const { processFile } = require('../services/process');
const { attemptDelivery } = require('../services/webhookDelivery');
const logger = require('../logger').child({ module: 'inngest' });

// The whole extract→chunk→embed→save pipeline runs as one step rather than
// split per-stage: processFile() already has its own try/catch that marks
// the file 'failed' and returns normally (never rejects), so per-stage
// Inngest step retries would just retry a pipeline that already handled its
// own failure — one step keeps Inngest's retry semantics (on top-level
// throw) meaningful instead of overlapping with that internal handling.
const processFileJob = inngest.createFunction(
  { id: 'process-file', retries: 3, triggers: { event: 'file/process' } },
  async ({ event, step }) => {
    const { fileId } = event.data;
    await step.run('process', async () => {
      const fileRecord = await db.findOne('files', { id: fileId });
      if (!fileRecord) {
        logger.warn({ fileId }, 'file record not found, skipping job');
        return { skipped: true };
      }
      await processFile(fileRecord);
      return { fileId };
    });
  }
);

// step.sleep is a durable delay — unlike setTimeout, it survives a
// serverless freeze between invocations, which is the whole reason this
// path exists (see services/webhookDelivery.js's PROCESS_MODE branch).
const webhookRetryJob = inngest.createFunction(
  { id: 'webhook-retry', triggers: { event: 'webhook/retry' } },
  async ({ event, step }) => {
    const { deliveryId, delayMs } = event.data;
    if (delayMs > 0) await step.sleep('backoff', delayMs);
    await step.run('attempt', () => attemptDelivery(deliveryId));
  }
);

module.exports = { functions: [processFileJob, webhookRetryJob] };
