const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { signToken, authRequired } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { sendPasswordReset, sendWelcome } = require('../services/email');
const logger = require('../logger').child({ module: 'auth' });

const router = express.Router();

router.post('/signup', validate(schemas.signup), async (req, res) => {
  const { email, password, name } = req.body;

  const normalized = email.toLowerCase().trim();
  const existing = await db.findOne('users', { email: normalized });
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = await bcrypt.hash(password, 10);
  const user = await db.insert('users', {
    id: uuid(),
    email: normalized,
    name: (name || normalized.split('@')[0]).trim(),
    passwordHash: hash,
    createdAt: Date.now(),
  });
  const token = signToken(user.id);
  setImmediate(() => sendWelcome(user.email, user.name));
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

router.post('/login', validate(schemas.login), async (req, res) => {
  const { email, password } = req.body;
  const user = await db.findOne('users', { email });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = signToken(user.id);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

router.get('/me', authRequired, (req, res) => {
  const { id, email, name, createdAt } = req.user;
  res.json({ user: { id, email, name, createdAt } });
});

router.patch('/me', authRequired, async (req, res) => {
  const { name, email, currentPassword, newPassword } = req.body || {};
  const user = req.user;
  const patch = {};

  if (name !== undefined) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'Name cannot be empty' });
    patch.name = trimmed;
  }

  if (email !== undefined) {
    const normalized = String(email || '').toLowerCase().trim();
    if (!normalized) return res.status(400).json({ error: 'Email cannot be empty' });
    // Check uniqueness excluding the current user
    const conflict = await db.queryOne(
      'SELECT id FROM users WHERE email = $1 AND id != $2 LIMIT 1',
      [normalized, user.id]
    );
    if (conflict) return res.status(409).json({ error: 'Email already in use' });
    patch.email = normalized;
  }

  if (newPassword !== undefined) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    patch.passwordHash = await bcrypt.hash(newPassword, 10);
  }

  const updated = await db.update('users', user.id, patch);
  res.json({ user: { id: updated.id, email: updated.email, name: updated.name } });
});

router.post('/forgot-password', validate(schemas.forgotPassword), async (req, res) => {
  const { email } = req.body;
  const user = await db.findOne('users', { email });
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.update('users', user.id, {
      resetToken: token,
      resetTokenExpiry: Date.now() + 3600000,
    });

    await sendPasswordReset(user.email, token);
  }

  res.json({ ok: true });
});

router.post('/reset-password', validate(schemas.resetPassword), async (req, res) => {
  const { token, newPassword } = req.body;

  // Check token validity and expiry in one query
  const user = await db.queryOne(
    'SELECT * FROM users WHERE reset_token = $1 AND reset_token_expiry > $2 LIMIT 1',
    [token, Date.now()]
  );
  if (!user) return res.status(400).json({ error: 'Reset link is invalid or has expired' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.update('users', user.id, {
    passwordHash,
    resetToken: null,
    resetTokenExpiry: null,
  });

  res.json({ ok: true });
});

router.delete('/me', authRequired, async (req, res) => {
  // Cancel any live Stripe subscription first — FK CASCADE will delete our
  // local subscriptions row along with the user, but Stripe itself keeps
  // billing the customer until told to stop. Without this, a deleted
  // account keeps getting charged with no way to log back in and cancel.
  const user = await db.findOne('users', { id: req.user.id });
  if (user?.stripeCustomerId) {
    try {
      const { getStripe } = require('../services/stripe');
      const stripe = getStripe();
      if (stripe) {
        const subs = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: 'active', limit: 10 });
        await Promise.all(subs.data.map(s => stripe.subscriptions.cancel(s.id)));
      }
    } catch (e) {
      logger.warn({ err: e.message, userId: user.id }, 'failed to cancel Stripe subscription on account delete');
    }
  }

  // FK CASCADE in Postgres handles deleting all related data automatically.
  // Deleting the user row cascades: projects → files, chunks, sessions,
  // messages, capture_fields, leads; also subscriptions, usage.
  await db.remove('users', { id: req.user.id });
  res.json({ ok: true });
});

module.exports = router;
