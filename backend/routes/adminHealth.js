/**
 * Admin-authenticated system health snapshot — DB connectivity, which
 * rate-limit-store backend is actually active, and webhook delivery
 * failure counts. Per docs/admin-panel-implementation-plan.md
 * "Phase 4: System health tab".
 *
 * Deliberately separate from the existing PUBLIC, unauthenticated
 * `/healthz` in server.js (a bare process-liveness check for uptime
 * monitors) — this route is behind adminAuthRequired and exposes more
 * (DB latency, backend config, delivery failure counts) than should ever
 * be unauthenticated.
 *
 * No error-log sub-metric: grepped the codebase for an error_log/errorLog
 * table or service (per the plan's explicit instruction to check first,
 * not invent one) and none exists — that field is omitted entirely from
 * the response rather than faked.
 */
const express = require('express');
const db = require('../db');
const { adminAuthRequired } = require('../middleware/auth');
const { getBackendType } = require('../services/rateLimitStore');
const { MAX_ATTEMPTS } = require('../services/webhookDelivery');

const router = express.Router();
router.use(adminAuthRequired);

// GET / — DB connectivity + latency, active rate-limit-store backend, and
// webhook delivery failure/exhausted counts. Read-only, so (like
// adminUsage.js/adminAnalytics.js) no validate.js schema or audit-log
// write — nothing here mutates state.
router.get('/', async (req, res) => {
  const dbStart = Date.now();
  let dbOk = true;
  try {
    await db.queryOne('SELECT 1 AS ok');
  } catch {
    dbOk = false;
  }
  const dbLatencyMs = Date.now() - dbStart;

  // failedCount: every webhook_deliveries row currently in 'failed' state
  // (includes both retries-exhausted rows and immediate failures, e.g. a
  // project's webhookUrl was cleared mid-flight — see
  // services/webhookDelivery.js#attemptDelivery). exhaustedCount narrows
  // that to rows that actually ran through the full backoff schedule,
  // reusing the exported MAX_ATTEMPTS constant rather than hardcoding a
  // second copy of the retry-count threshold.
  const [{ failedCount, exhaustedCount }] = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
       COUNT(*) FILTER (WHERE status = 'failed' AND attempt >= $1)::int AS exhausted_count
     FROM webhook_deliveries`,
    [MAX_ATTEMPTS]
  );

  res.json({
    db: { ok: dbOk, latencyMs: dbLatencyMs },
    rateLimitStore: { backend: getBackendType() },
    webhooks: { failedCount, exhaustedCount },
  });
});

module.exports = router;
