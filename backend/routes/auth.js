const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { signToken, authRequired } = require('../middleware/auth');

const router = express.Router();

router.post('/signup', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const normalized = email.toLowerCase().trim();
  if (db.findOne('users', u => u.email === normalized)) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: uuid(),
    email: normalized,
    name: (name || normalized.split('@')[0]).trim(),
    passwordHash: hash,
    createdAt: Date.now(),
  };
  await db.insert('users', user);
  const token = signToken(user.id);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.findOne('users', u => u.email === email.toLowerCase().trim());
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
    const existing = db.findOne('users', u => u.email === normalized && u.id !== user.id);
    if (existing) return res.status(409).json({ error: 'Email already in use' });
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

router.post('/forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  // Always return ok to prevent email enumeration
  if (!email) return res.json({ ok: true });

  const user = db.findOne('users', u => u.email === email);
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.update('users', user.id, {
      resetToken: token,
      resetTokenExpiry: Date.now() + 3600000, // 1 hour
    });

    const resetLink = `${process.env.APP_URL || 'http://localhost:8080'}/reset-password?token=${token}`;

    if (process.env.SMTP_HOST) {
      try {
        const nodemailer = require('nodemailer');
        const transport = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT) || 587,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transport.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: user.email,
          subject: 'Reset your AvatarPlatform password',
          text: `Click this link to reset your password (expires in 1 hour):\n\n${resetLink}\n\nIf you didn't request this, ignore this email.`,
          html: `<p>Click this link to reset your password (expires in 1 hour):</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, ignore this email.</p>`,
        });
      } catch (e) {
        console.error('[auth] failed to send reset email:', e.message);
      }
    } else {
      console.log(`[auth] password reset link for ${email}: ${resetLink}`);
    }
  }

  res.json({ ok: true });
});

router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const user = db.findOne('users', u => u.resetToken === token && u.resetTokenExpiry > Date.now());
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
  const userId = req.user.id;

  // Cascade delete all user data
  const projects = db.findAll('projects', p => p.userId === userId);
  for (const p of projects) {
    await db.remove('files',         f => f.projectId === p.id);
    await db.remove('chunks',        c => c.projectId === p.id);
    await db.remove('sessions',      s => s.projectId === p.id);
    await db.remove('messages',      m => m.projectId === p.id);
    await db.remove('captureFields', f => f.projectId === p.id);
    await db.remove('leads',         l => l.projectId === p.id);
  }
  await db.remove('projects',      p => p.userId === userId);
  await db.remove('subscriptions', s => s.userId === userId);
  await db.remove('usage',         u => u.userId === userId);
  await db.remove('users',         u => u.id === userId);

  res.json({ ok: true });
});

module.exports = router;
