/**
 * Feature-flag infrastructure — admin-defined boolean flags, previously
 * nonexistent (admin-panel plan 5e: infra only, nothing gated on a flag
 * yet). See services/featureFlags.js for the DB-backed cache.
 */
const express = require('express');
const { adminAuthRequired } = require('../middleware/auth');
const { logAdminAction } = require('../services/auditLog');
const { validate, schemas } = require('../middleware/validate');
const featureFlags = require('../services/featureFlags');

const router = express.Router();
router.use(adminAuthRequired);

router.get('/', async (_req, res) => {
  res.json({ flags: await featureFlags.listFlags() });
});

router.post('/', validate(schemas.featureFlagCreate), async (req, res) => {
  const { key, description } = req.body;
  try {
    await featureFlags.createFlag(key, description || null, req.admin.id);
  } catch (e) {
    return res.status(409).json({ error: e.message });
  }
  await logAdminAction({
    adminId: req.admin.id,
    action: 'feature_flag_create',
    meta: { key, description: description || null },
  });
  const [created] = (await featureFlags.listFlags()).filter(f => f.key === key);
  res.status(201).json({ flag: created });
});

router.put('/:key', validate(schemas.featureFlagUpdate), async (req, res) => {
  const { key } = req.params;
  try {
    await featureFlags.setFlag(key, req.body.enabled, req.body.description, req.admin.id);
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }
  await logAdminAction({
    adminId: req.admin.id,
    action: req.body.enabled ? 'feature_flag_enable' : 'feature_flag_disable',
    meta: { key },
  });
  const [updated] = (await featureFlags.listFlags()).filter(f => f.key === key);
  res.json({ flag: updated });
});

module.exports = router;
