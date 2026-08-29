/**
 * Admin visibility into webhook deliveries across ALL tenants. Owners can
 * already see their own project's deliveries via
 * routes/projects.js's `GET /:id/webhook/deliveries` (owner-scoped, no
 * project join needed there since the project is already resolved from the
 * auth'd owner). This route mirrors that response shape but drops the
 * ownership filter and joins `projects` (+ `users`) for tenant context, per
 * docs/admin-panel-implementation-plan.md "2a. Webhook delivery admin route
 * + tab".
 *
 * Delivery/signing logic is NOT duplicated here — retry calls straight into
 * services/webhookDelivery.js's attemptDelivery(), the same function the
 * automatic backoff retries (and the owner's manual /webhook/test-adjacent
 * flow) use.
 */
const express = require('express');
const db = require('../db');
const { adminAuthRequired } = require('../middleware/auth');
const { logAdminAction } = require('../services/auditLog');
const { attemptDelivery, BACKOFF_MS, MAX_ATTEMPTS } = require('../services/webhookDelivery');

const router = express.Router();
router.use(adminAuthRequired);

// Malformed (non-UUID) :id/:projectId params otherwise reach db.query/
// db.findOne, where Postgres rejects the invalid uuid cast and the request
// 500s instead of cleanly 404ing — same guard admin.js uses for :id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Delivery not found' });
  next();
});
router.param('projectId', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Project not found' });
  next();
});

const PAGE_SIZE = 25;
const STATUSES = ['pending', 'success', 'failed'];

// Shared by GET / and GET /:projectId — same select/join, difference is
// just which WHERE clauses are active. Estimates a "next retry" timestamp
// for pending, already-attempted rows from BACKOFF_MS (display-only; the
// actual schedule is owned by services/webhookDelivery.js).
async function listDeliveries(res, { projectId, status, page }) {
  const conditions = [];
  const params = [];
  if (projectId) { params.push(projectId); conditions.push(`wd.project_id = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`wd.status = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * PAGE_SIZE;

  const rows = await db.query(
    `SELECT wd.id, wd.project_id, wd.event_type, wd.status, wd.attempt, wd.response_status,
            wd.error, wd.created_at, wd.delivered_at, wd.updated_at,
            p.id AS project_id_ref, p.name AS project_name, p.public_id AS project_public_id,
            p.webhook_url AS project_webhook_url,
            u.email AS owner_email
       FROM webhook_deliveries wd
       JOIN projects p ON p.id = wd.project_id
       LEFT JOIN users u ON u.id = p.user_id
       ${where}
       ORDER BY wd.created_at DESC
       LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    params
  );
  const [{ count }] = await db.query(
    `SELECT COUNT(*)::int AS count FROM webhook_deliveries wd ${where}`,
    params
  );

  const deliveries = rows.map(r => {
    let nextRetryAt = null;
    if (r.status === 'pending' && r.attempt > 0 && r.attempt < MAX_ATTEMPTS) {
      nextRetryAt = (r.updatedAt || r.createdAt) + BACKOFF_MS[r.attempt];
    }
    return {
      id: r.id,
      projectId: r.projectId,
      eventType: r.eventType,
      status: r.status,
      attempt: r.attempt,
      responseStatus: r.responseStatus,
      error: r.error,
      createdAt: r.createdAt,
      deliveredAt: r.deliveredAt,
      updatedAt: r.updatedAt,
      nextRetryAt,
      project: {
        id: r.projectIdRef,
        name: r.projectName,
        publicId: r.projectPublicId,
        webhookUrl: r.projectWebhookUrl,
        ownerEmail: r.ownerEmail,
      },
    };
  });

  res.json({ deliveries, page, pageSize: PAGE_SIZE, total: count });
}

// GET / — paginated list across ALL projects, newest first, optionally
// filtered by ?status=pending|success|failed. Response shape mirrors
// admin.js's GET /users (page/pageSize/total).
router.get('/', async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const page = Math.min(100000, Math.max(1, parseInt(req.query.page) || 1));
  await listDeliveries(res, { status, page });
});

// GET /:projectId — deliveries for one project, same query/shape just
// filtered. Not ownership-checked (admin route) — 404s naturally via an
// empty result set if the project doesn't exist, same as the list route.
router.get('/:projectId', async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const page = Math.min(100000, Math.max(1, parseInt(req.query.page) || 1));
  await listDeliveries(res, { projectId: req.params.projectId, status, page });
});

// POST /:id/retry — manually re-trigger a failed delivery. Resets the row
// to 'pending' and calls the existing attemptDelivery() from
// services/webhookDelivery.js (the same function automatic backoff retries
// use) — no HTTP/signing logic is reimplemented here.
router.post('/:id/retry', async (req, res) => {
  const delivery = await db.findOne('webhookDeliveries', { id: req.params.id });
  if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
  if (delivery.status !== 'failed') {
    return res.status(400).json({ error: 'Only failed deliveries can be retried' });
  }

  await db.update('webhookDeliveries', delivery.id, { status: 'pending', error: null });
  await attemptDelivery(delivery.id);
  const updated = await db.findOne('webhookDeliveries', { id: delivery.id });

  await logAdminAction({
    adminId: req.admin.id,
    action: 'webhook_retry',
    meta: { deliveryId: delivery.id, projectId: delivery.projectId },
  });

  res.json({ delivery: updated });
});

module.exports = router;
