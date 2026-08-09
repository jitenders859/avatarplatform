const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { adminAuthRequired, signAdminToken } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { getUsageSnapshot } = require('../services/usage');

const router = express.Router();

// ── Auth ──────────────────────────────────────────────────────
router.post('/login', validate(schemas.adminLogin), async (req, res) => {
  const { email, password } = req.body;
  const admin = await db.findOne('admin_users', { email });
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = signAdminToken(admin.id);
  res.json({ token, admin: { id: admin.id, email: admin.email } });
});

router.get('/me', adminAuthRequired, (req, res) => {
  res.json({ admin: { id: req.admin.id, email: req.admin.email } });
});

// ── Users ─────────────────────────────────────────────────────
router.get('/users', adminAuthRequired, async (req, res) => {
  const search = String(req.query.search || '').trim();
  const page = Math.min(100000, Math.max(1, parseInt(req.query.page) || 1));
  const pageSize = 25;
  const offset = (page - 1) * pageSize;

  const where = search ? `WHERE u.email ILIKE $1 OR u.name ILIKE $1` : '';
  const params = search ? [`%${search}%`] : [];

  const rows = await db.query(
    `SELECT u.id, u.email, u.name, u.created_at, u.suspended, u.admin_plan_id,
            s.plan_id AS stripe_plan_id
       FROM users u
       LEFT JOIN LATERAL (
         SELECT plan_id, updated_at, created_at FROM subscriptions
          WHERE user_id = u.id AND status = 'active'
          ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1
       ) s ON true
       ${where}
       ORDER BY u.created_at DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
    params
  );
  const [{ count }] = await db.query(`SELECT COUNT(*)::int AS count FROM users u ${where}`, params);

  res.json({
    users: rows.map(r => ({
      id: r.id, email: r.email, name: r.name, createdAt: r.createdAt, suspended: r.suspended,
      planId: r.adminPlanId || r.stripePlanId || 'free',
      planSource: r.adminPlanId ? 'admin' : (r.stripePlanId ? 'stripe' : 'free'),
    })),
    page, pageSize, total: count,
  });
});

router.get('/users/:id', adminAuthRequired, async (req, res) => {
  const user = await db.findOne('users', { id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const [snapshot, projects, subs] = await Promise.all([
    getUsageSnapshot(user.id),
    db.query(
      `SELECT p.id, p.name, p.character_id, p.created_at,
              COUNT(f.id)::int AS file_count
         FROM projects p LEFT JOIN files f ON f.project_id = p.id
        WHERE p.user_id = $1 GROUP BY p.id ORDER BY p.created_at DESC`,
      [user.id]
    ),
    db.query(`SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC`, [user.id]),
  ]);

  res.json({
    user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt, suspended: user.suspended, adminPlanId: user.adminPlanId },
    usage: snapshot,
    projects,
    subscriptions: subs,
  });
});

module.exports = router;
