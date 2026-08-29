const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const db = require('../db');
const { adminAuthRequired, signAdminToken, signToken } = require('../middleware/auth');
const { deleteUserAccount } = require('../services/accountDelete');
const { logAdminAction } = require('../services/auditLog');
const { validate, schemas } = require('../middleware/validate');
const { getUsageSnapshot, isAdminPlanOverrideActive } = require('../services/usage');

const router = express.Router();

// Malformed (non-UUID) :id params otherwise reach db.findOne/db.query, where
// Postgres rejects the invalid uuid cast and the request 500s instead of
// cleanly 404ing. Validate once here for every route on this router that
// takes an :id param, rather than repeating the check in each handler.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'User not found' });
  next();
});

// Stricter than the general apiLimiter (200/min) already applied to
// /api/admin at the server level — this route is irreversible and cascades
// across all of a user's data, so a stolen admin token shouldn't be able to
// mass-delete accounts. Scoped to this route only (see route-level use below).
const adminDeleteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
});

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
            u.admin_plan_set_by, u.admin_plan_set_at, u.admin_plan_note, u.admin_plan_expires_at,
            a.email AS admin_plan_set_by_email,
            s.plan_id AS stripe_plan_id
       FROM users u
       LEFT JOIN admin_users a ON a.id = u.admin_plan_set_by
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
    users: rows.map(r => {
      const overrideActive = isAdminPlanOverrideActive(r);
      return {
        id: r.id, email: r.email, name: r.name, createdAt: r.createdAt, suspended: r.suspended,
        planId: overrideActive ? r.adminPlanId : (r.stripePlanId || 'free'),
        planSource: overrideActive ? 'admin' : (r.stripePlanId ? 'stripe' : 'free'),
        adminOverride: overrideActive ? {
          tierId: r.adminPlanId,
          setByEmail: r.adminPlanSetByEmail,
          setAt: r.adminPlanSetAt,
          note: r.adminPlanNote,
          expiresAt: r.adminPlanExpiresAt,
        } : null,
      };
    }),
    page, pageSize, total: count,
  });
});

router.get('/users/:id', adminAuthRequired, async (req, res) => {
  const user = await db.findOne('users', { id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const [snapshot, projects, subs] = await Promise.all([
    getUsageSnapshot(user.id),
    db.query(
      `SELECT p.id, p.name, p.character_id, p.created_at, p.widget_messages,
              COUNT(f.id)::int AS file_count
         FROM projects p LEFT JOIN files f ON f.project_id = p.id
        WHERE p.user_id = $1 GROUP BY p.id ORDER BY p.created_at DESC`,
      [user.id]
    ),
    db.query(`SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC`, [user.id]),
  ]);

  // Batch-fetch project_members for every project owned by this user in one
  // query (not one query per project) — same reasoning as the file_count
  // join above, just kept separate since it's a one-to-many fan-out that
  // would otherwise blow up the GROUP BY.
  const projectIds = projects.map(p => p.id);
  const members = projectIds.length
    ? await db.query(
        `SELECT pm.id, pm.project_id, pm.user_id, pm.created_at, u.email, u.name
           FROM project_members pm JOIN users u ON u.id = pm.user_id
          WHERE pm.project_id = ANY($1::uuid[])
          ORDER BY pm.created_at ASC`,
        [projectIds]
      )
    : [];
  const membersByProject = new Map();
  for (const m of members) {
    if (!membersByProject.has(m.projectId)) membersByProject.set(m.projectId, []);
    membersByProject.get(m.projectId).push(m);
  }

  const overrideActive = isAdminPlanOverrideActive(user);
  const setter = user.adminPlanSetBy ? await db.findOne('admin_users', { id: user.adminPlanSetBy }) : null;

  res.json({
    user: {
      id: user.id, email: user.email, name: user.name, createdAt: user.createdAt, suspended: user.suspended,
      adminPlanId: user.adminPlanId,
      adminOverride: overrideActive ? {
        tierId: user.adminPlanId,
        setByEmail: setter?.email || null,
        setAt: user.adminPlanSetAt,
        note: user.adminPlanNote,
        expiresAt: user.adminPlanExpiresAt,
      } : null,
    },
    usage: snapshot,
    projects: projects.map(p => ({
      id: p.id, name: p.name, characterId: p.characterId, createdAt: p.createdAt, fileCount: p.fileCount,
      widgetMessages: p.widgetMessages || {},
      members: membersByProject.get(p.id) || [],
    })),
    subscriptions: subs,
  });
});

router.patch('/users/:id', adminAuthRequired, validate(schemas.adminPatchUser), async (req, res) => {
  const user = await db.findOne('users', { id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { suspended, adminPlanId, reason, expiresAt } = req.body;
  const patch = {};

  if (suspended !== undefined) patch.suspended = suspended;

  if (adminPlanId !== undefined) {
    if (adminPlanId) {
      const tier = await db.findOne('plan_tiers', { id: adminPlanId });
      if (!tier) return res.status(400).json({ error: 'Unknown plan tier' });
      patch.adminPlanId = adminPlanId;
      patch.adminPlanSetBy = req.admin.id;
      patch.adminPlanSetAt = Date.now();
      patch.adminPlanNote = reason || null;
      patch.adminPlanExpiresAt = expiresAt || null;
    } else {
      // Clearing the override resets its metadata too, so no stale
      // "overridden by X" badge lingers once there's no active override.
      patch.adminPlanId = null;
      patch.adminPlanSetBy = null;
      patch.adminPlanSetAt = null;
      patch.adminPlanNote = null;
      patch.adminPlanExpiresAt = null;
    }
  }

  const updated = await db.update('users', user.id, patch);
  if (!updated) return res.status(404).json({ error: 'User not found' });

  if (suspended !== undefined) {
    await logAdminAction({
      adminId: req.admin.id,
      action: suspended ? 'suspend' : 'unsuspend',
      targetUserId: user.id,
      targetEmail: user.email,
    });
  }
  if (adminPlanId !== undefined) {
    await logAdminAction({
      adminId: req.admin.id,
      action: adminPlanId ? 'assign_tier' : 'clear_tier',
      targetUserId: user.id,
      targetEmail: user.email,
      meta: {
        fromTier: user.adminPlanId || null,
        toTier: adminPlanId || null,
        reason: adminPlanId ? (reason || null) : null,
        expiresAt: adminPlanId ? (expiresAt || null) : null,
      },
    });
  }

  res.json({
    user: {
      id: updated.id, suspended: updated.suspended, adminPlanId: updated.adminPlanId,
      adminPlanSetAt: updated.adminPlanSetAt, adminPlanNote: updated.adminPlanNote, adminPlanExpiresAt: updated.adminPlanExpiresAt,
    },
  });
});

router.delete('/users/:id', adminDeleteLimiter, adminAuthRequired, validate(schemas.adminDeleteUser), async (req, res) => {
  const user = await db.findOne('users', { id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { confirmEmail } = req.body;
  if (confirmEmail !== user.email) return res.status(400).json({ error: 'Email confirmation does not match' });
  await logAdminAction({
    adminId: req.admin.id,
    action: 'delete_user',
    targetUserId: user.id,
    targetEmail: user.email,
  });
  await deleteUserAccount(user.id);
  res.json({ ok: true });
});

router.post('/users/:id/impersonate', adminAuthRequired, async (req, res) => {
  const user = await db.findOne('users', { id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.suspended) return res.status(400).json({ error: 'Cannot impersonate a suspended account' });
  const token = signToken(user.id, { expiresIn: '15m', imp: true });
  await logAdminAction({
    adminId: req.admin.id,
    action: 'impersonate',
    targetUserId: user.id,
    targetEmail: user.email,
  });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

// ── Projects (project-scoped admin actions) ─────────────────────
// No dedicated adminProjects.js exists yet (only owner-scoped routes in
// routes/projects.js) — kept here per the plan's guidance to extend admin.js
// rather than stand up a new route file for a single moderation action.
router.patch('/projects/:id/widget-messages', adminAuthRequired, validate(schemas.adminClearWidgetMessages), async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Only supported operation today is clearing — {} matches the column's
  // own DEFAULT '{}' and is what embed.js's read path (project.widgetMessages
  // && project.widgetMessages.xxx) already treats as "no override" for
  // every key, same as NULL would.
  const updated = await db.update('projects', project.id, { widgetMessages: {} });

  const owner = await db.findOne('users', { id: project.userId });
  await logAdminAction({
    adminId: req.admin.id,
    action: 'widget_override_cleared',
    targetUserId: project.userId,
    targetEmail: owner?.email || null,
    meta: { projectId: project.id, projectName: project.name },
  });

  res.json({ project: { id: updated.id, widgetMessages: updated.widgetMessages } });
});

// ── Plan tiers ────────────────────────────────────────────────
router.get('/tiers', adminAuthRequired, async (req, res) => {
  res.json({ tiers: await db.query('SELECT * FROM plan_tiers ORDER BY created_at DESC') });
});

router.post('/tiers', adminAuthRequired, validate(schemas.tierUpsert), async (req, res) => {
  const { name, limits } = req.body;
  const id = 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + crypto.randomBytes(3).toString('hex');
  const tier = await db.insert('plan_tiers', { id, name, limits, createdBy: req.admin.id, createdAt: Date.now() });
  await logAdminAction({
    adminId: req.admin.id,
    action: 'tier_create',
    meta: { tierId: id, name },
  });
  res.json({ tier });
});

router.patch('/tiers/:tierId', adminAuthRequired, validate(schemas.tierUpsert), async (req, res) => {
  const existing = await db.findOne('plan_tiers', { id: req.params.tierId });
  if (!existing) return res.status(404).json({ error: 'Tier not found' });
  const { name, limits } = req.body;
  const tier = await db.update('plan_tiers', existing.id, { name, limits });
  await logAdminAction({
    adminId: req.admin.id,
    action: 'tier_update',
    meta: { tierId: existing.id, name },
  });
  res.json({ tier });
});

router.delete('/tiers/:tierId', adminAuthRequired, async (req, res) => {
  const inUse = await db.findOne('users', { adminPlanId: req.params.tierId });
  if (inUse) return res.status(409).json({ error: 'Tier is still assigned to at least one user' });
  await db.remove('plan_tiers', { id: req.params.tierId });
  await logAdminAction({
    adminId: req.admin.id,
    action: 'tier_delete',
    meta: { tierId: req.params.tierId },
  });
  res.json({ ok: true });
});

// ── Audit log ─────────────────────────────────────────────────
router.get('/audit-log', adminAuthRequired, async (req, res) => {
  const page = Math.min(100000, Math.max(1, parseInt(req.query.page) || 1));
  const pageSize = 50;
  const entries = await db.query(
    `SELECT l.*, a.email AS admin_email
       FROM admin_audit_log l
       LEFT JOIN admin_users a ON a.id = l.admin_id
      ORDER BY l.created_at DESC LIMIT $1 OFFSET $2`,
    [pageSize, (page - 1) * pageSize]
  );
  const [{ count }] = await db.query(`SELECT COUNT(*)::int AS count FROM admin_audit_log`);
  res.json({ entries, page, pageSize, total: count });
});

module.exports = router;
