const express = require('express');
const { validate, schemas } = require('../middleware/validate');
const { sendContactMessage } = require('../services/email');
const logger = require('../logger').child({ module: 'contact' });

const router = express.Router();

// Public, unauthenticated — the marketing contact page. Mounted behind
// apiLimiter in server.js like every other public write endpoint.
router.post('/', validate(schemas.contactMessage), async (req, res) => {
  try {
    await sendContactMessage(req.body);
  } catch (err) {
    // sendContactMessage/send() already logs and no-ops when SMTP isn't
    // configured — this catch is only for genuinely unexpected failures,
    // and the visitor still gets a clean response either way since there's
    // nothing actionable for them to retry.
    logger.error({ err: err.message }, 'contact message send failed');
  }
  res.json({ ok: true });
});

module.exports = router;
