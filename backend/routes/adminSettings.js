/**
 * Admin model settings — Gemini API keys and the study model, previously
 * .env-only. Lets an operator rotate them without redeploying. See
 * services/settings.js for the DB-overrides-env resolution and cache.
 */
const express = require('express');
const { adminAuthRequired } = require('../middleware/auth');
const { logAdminAction } = require('../services/auditLog');
const { validate, schemas } = require('../middleware/validate');
const settings = require('../services/settings');

const router = express.Router();
router.use(adminAuthRequired);

router.get('/', async (_req, res) => {
  res.json({ settings: await settings.listSettingsStatus() });
});

router.put('/:key', validate(schemas.adminSettingUpdate), async (req, res) => {
  const { key } = req.params;
  if (!settings.OVERRIDABLE_KEYS.includes(key)) {
    return res.status(404).json({ error: 'Unknown setting key' });
  }
  await settings.setSetting(key, req.body.value || '', req.admin.id);
  await logAdminAction({
    adminId: req.admin.id,
    action: req.body.value ? 'setting_update' : 'setting_clear',
    meta: { key },
  });
  const [updated] = (await settings.listSettingsStatus()).filter(s => s.key === key);
  res.json({ setting: updated });
});

module.exports = router;
