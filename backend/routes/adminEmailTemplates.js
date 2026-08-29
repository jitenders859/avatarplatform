/**
 * Admin email templates — the 5 transactional email subject/body pairs
 * previously hardcoded in services/email.js. Lets an operator restyle them
 * without redeploying. See services/emailTemplates.js for the DB-first,
 * hardcoded-fallback resolution and cache.
 */
const express = require('express');
const { adminAuthRequired } = require('../middleware/auth');
const { logAdminAction } = require('../services/auditLog');
const { validate, schemas } = require('../middleware/validate');
const emailTemplates = require('../services/emailTemplates');

const router = express.Router();
router.use(adminAuthRequired);

router.get('/', async (_req, res) => {
  res.json({ templates: await emailTemplates.listTemplates() });
});

router.put('/:key', validate(schemas.adminEmailTemplateUpdate), async (req, res) => {
  const { key } = req.params;
  if (!emailTemplates.TEMPLATE_KEYS.includes(key)) {
    return res.status(404).json({ error: 'Unknown template key' });
  }
  await emailTemplates.setTemplate(key, req.body.subject, req.body.body, req.admin.id);
  await logAdminAction({
    adminId: req.admin.id,
    action: 'email_template_update',
    meta: { key },
  });
  const [updated] = (await emailTemplates.listTemplates()).filter(t => t.key === key);
  res.json({ template: updated });
});

module.exports = router;
