/**
 * Admin aggregate usage/cost dashboard — "who's near their cap or costing
 * the most", across ALL users in one screen instead of clicking into each
 * user's detail page. Per docs/admin-panel-implementation-plan.md
 * "3b. Aggregate usage/cost dashboard".
 *
 * admin.js was already 300+ lines, so per the plan's guidance this follows
 * adminWebhooks.js/adminAnalytics.js as a standalone route file rather than
 * growing admin.js further. All the actual computation (one GROUP BY query,
 * not a per-user loop) lives in services/usage.js#getUsageAcrossUsers — this
 * route is just auth + query-param parsing + the response.
 */
const express = require('express');
const { adminAuthRequired } = require('../middleware/auth');
const { getUsageAcrossUsers } = require('../services/usage');

const router = express.Router();
router.use(adminAuthRequired);

const SORTABLE = ['ratio', 'messages'];

// GET /overview — users sorted by usage-to-limit ratio descending (closest
// to a cap first) by default; ?sortBy=messages sorts by raw message count
// (the cost proxy — see services/usage.js for why there's no $ figure).
// Response shape mirrors admin.js's GET /users: { users, page, pageSize, total }.
router.get('/overview', async (req, res) => {
  const page = Math.min(100000, Math.max(1, parseInt(req.query.page, 10) || 1));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const sortBy = SORTABLE.includes(req.query.sortBy) ? req.query.sortBy : 'ratio';

  const result = await getUsageAcrossUsers({ page, limit, sortBy });
  res.json(result);
});

module.exports = router;
