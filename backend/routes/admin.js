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
const { PLANS } = require('../plans');
const { getStripe } = require('../services/stripe');
const { invalidateProjectCache } = require('../cache');

const router = express.Router();

// Malformed (non-UUID) :id params otherwise reach db.findOne/db.query, where
// Postgres rejects the invalid uuid cast and the request 500s instead of
// cleanly 404ing. Validate once here for every route on this router that
// takes an :id param (users, projects), rather than repeating the check in
// each handler — the message is generic since :id spans more than users now.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });
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

// ── Overview / dashboard ──────────────────────────────────────
function dailyBuckets(rows, days = 30) {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    buckets.push({ date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, count: 0 });
  }
  const byDate = Object.fromEntries(buckets.map((b, i) => [b.date, i]));
  for (const r of rows) if (r.date in byDate) buckets[byDate[r.date]].count = Number(r.count);
  return buckets;
}

router.get('/overview', adminAuthRequired, async (req, res) => {
  const since30 = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const [totals, subsByPlan, signupsDaily, messagesDaily, topProjects] = await Promise.all([
    db.queryOne(`SELECT
        (SELECT COUNT(*)::int FROM users) AS users,
        (SELECT COUNT(*)::int FROM projects) AS projects,
        (SELECT COUNT(*)::int FROM messages) AS messages,
        (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'active') AS active_subscriptions`),
    db.query(`SELECT plan_id, COUNT(*)::int AS count FROM subscriptions WHERE status = 'active' GROUP BY plan_id`),
    db.query(
      `SELECT to_char(to_timestamp(created_at / 1000), 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
         FROM users WHERE created_at >= $1 GROUP BY date`,
      [since30]
    ),
    db.query(
      `SELECT to_char(to_timestamp(created_at / 1000), 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
         FROM messages WHERE created_at >= $1 GROUP BY date`,
      [since30]
    ),
    db.query(
      `SELECT p.id, p.name, u.email AS owner_email, COUNT(m.id)::int AS message_count
         FROM messages m
         JOIN projects p ON p.id = m.project_id
         JOIN users u ON u.id = p.user_id
        WHERE m.created_at >= $1
        GROUP BY p.id, u.email
        ORDER BY message_count DESC
        LIMIT 5`,
      [since30]
    ),
  ]);

  const priceById = Object.fromEntries(PLANS.map(p => [p.id, p.priceMonthly]));
  const mrr = subsByPlan.reduce((sum, r) => sum + (priceById[r.planId] || 0) * r.count, 0);

  res.json({
    totals: { ...totals, mrr },
    subscriptionsByPlan: subsByPlan.map(r => ({ planId: r.planId, count: r.count })),
    signupsDaily: dailyBuckets(signupsDaily),
    messagesDaily: dailyBuckets(messagesDaily),
    topProjects,
  });
});

// ── Billing & revenue ─────────────────────────────────────────
// Read-only visibility over subscriptions.priceMonthly comes from the
// static PLANS array (backend/plans.js), not a live Stripe fetch — plan
// prices are already defined there and don't need round-tripping to
// Stripe just to display them. The one write action (cancel) does call
// Stripe directly; deliberately no refund action here — that moves money
// and wasn't asked for, unlike simple revenue/subscription visibility.
router.get('/billing', adminAuthRequired, async (req, res) => {
  const page = Math.min(100000, Math.max(1, parseInt(req.query.page) || 1));
  const pageSize = 25;
  const status = String(req.query.status || '').trim();
  const where = status ? 'WHERE s.status = $1' : '';
  const params = status ? [status] : [];

  const rows = await db.query(
    `SELECT s.*, u.email AS user_email
       FROM subscriptions s JOIN users u ON u.id = s.user_id
       ${where}
       ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize]
  );
  const [{ count }] = await db.query(`SELECT COUNT(*)::int AS count FROM subscriptions s ${where}`, params);

  const priceById = Object.fromEntries(PLANS.map(p => [p.id, p.priceMonthly]));
  const nameById = Object.fromEntries(PLANS.map(p => [p.id, p.name]));
  res.json({
    subscriptions: rows.map(r => ({
      id: r.id, userId: r.userId, userEmail: r.userEmail,
      planId: r.planId, planName: nameById[r.planId] || r.planId, priceMonthly: priceById[r.planId] || 0,
      status: r.status, currentPeriodEnd: r.currentPeriodEnd, cancelAtPeriodEnd: !!r.cancelAtPeriodEnd,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    })),
    page, pageSize, total: count,
    stripeConfigured: !!getStripe(),
  });
});

router.post('/users/:id/subscription/cancel', adminAuthRequired, async (req, res) => {
  const user = await db.findOne('users', { id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const sub = await db.findOne('subscriptions', { userId: user.id, status: 'active' });
  if (!sub) return res.status(400).json({ error: 'This user has no active subscription' });

  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Billing is not configured on this server (STRIPE_SECRET_KEY missing).' });

  try {
    // Cancels at the end of the current paid period (same effect a
    // customer gets from their own billing portal) rather than an
    // immediate cancel, which would forfeit already-paid time with no
    // refund — that's a separate, deliberately-not-built action.
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
  } catch (e) {
    return res.status(502).json({ error: `Stripe error: ${e.message}` });
  }

  // No local DB write here on purpose — routes/billing.js's
  // customer.subscription.updated webhook handler is the single source of
  // truth that syncs subscriptions.cancel_at_period_end once Stripe
  // confirms the change, exactly as it does for a customer's own
  // self-serve cancellation.
  await logAdminAction({
    adminId: req.admin.id,
    action: 'subscription_cancel_at_period_end',
    targetUserId: user.id,
    targetEmail: user.email,
    meta: { subscriptionId: sub.id, planId: sub.planId },
  });
  res.json({ ok: true });
});

// ── Users ─────────────────────────────────────────────────────
const USERS_LIST_SELECT = `
  SELECT u.id, u.email, u.name, u.created_at, u.suspended, u.admin_plan_id,
         u.admin_plan_set_by, u.admin_plan_set_at, u.admin_plan_note, u.admin_plan_expires_at,
         a.email AS admin_plan_set_by_email,
         s.plan_id AS stripe_plan_id
    FROM users u
    LEFT JOIN admin_users a ON a.id = u.admin_plan_set_by
    LEFT JOIN LATERAL (
      SELECT plan_id, updated_at, created_at FROM subscriptions
       WHERE user_id = u.id AND status = 'active'
       ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1
    ) s ON true`;

function mapUserRow(r) {
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
}

router.get('/users', adminAuthRequired, async (req, res) => {
  const search = String(req.query.search || '').trim();
  const page = Math.min(100000, Math.max(1, parseInt(req.query.page) || 1));
  const pageSize = 25;
  const offset = (page - 1) * pageSize;

  const where = search ? `WHERE u.email ILIKE $1 OR u.name ILIKE $1` : '';
  const params = search ? [`%${search}%`] : [];

  const rows = await db.query(
    `${USERS_LIST_SELECT} ${where} ORDER BY u.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  const [{ count }] = await db.query(`SELECT COUNT(*)::int AS count FROM users u ${where}`, params);

  res.json({ users: rows.map(mapUserRow), page, pageSize, total: count });
});

// Same filter as the list endpoint, but unpaginated (capped) for CSV export
// — the admin panel builds the CSV client-side from this.
router.get('/users/export', adminAuthRequired, async (req, res) => {
  const search = String(req.query.search || '').trim();
  const where = search ? `WHERE u.email ILIKE $1 OR u.name ILIKE $1` : '';
  const params = search ? [`%${search}%`] : [];
  const rows = await db.query(`${USERS_LIST_SELECT} ${where} ORDER BY u.created_at DESC LIMIT 5000`, params);
  res.json({ users: rows.map(mapUserRow) });
});

router.get('/users/:id', adminAuthRequired, async (req, res) => {
  const user = await db.findOne('users', { id: req.params.id });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const [snapshot, projects, subs] = await Promise.all([
    getUsageSnapshot(user.id),
    db.query(
      `SELECT p.id, p.name, p.character_id, p.created_at, p.admin_suspended, p.admin_suspended_reason,
              COUNT(f.id)::int AS file_count
         FROM projects p LEFT JOIN files f ON f.project_id = p.id
        WHERE p.user_id = $1 GROUP BY p.id ORDER BY p.created_at DESC`,
      [user.id]
    ),
    db.query(`SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC`, [user.id]),
  ]);

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
    projects,
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

// ── Per-project suspend (kill switch short of suspending the whole account) ──
router.patch('/projects/:id', adminAuthRequired, validate(schemas.adminPatchProject), async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { adminSuspended, reason } = req.body;
  const updated = await db.update('projects', project.id, {
    adminSuspended,
    adminSuspendedReason: adminSuspended ? (reason || null) : null,
  });
  invalidateProjectCache(project.publicId);

  const owner = await db.findOne('users', { id: project.userId });
  await logAdminAction({
    adminId: req.admin.id,
    action: adminSuspended ? 'project_suspend' : 'project_unsuspend',
    targetUserId: project.userId,
    targetEmail: owner?.email || null,
    meta: { projectId: project.id, projectName: project.name, reason: adminSuspended ? (reason || null) : null },
  });
  res.json({ project: { id: updated.id, adminSuspended: updated.adminSuspended, adminSuspendedReason: updated.adminSuspendedReason } });
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

// ── System status ─────────────────────────────────────────────
// Presence-only checks (never returns actual secret values) for the
// optional integrations that have accumulated across this codebase —
// otherwise the only way to know what's configured on a given deployment
// is to read boot-time warnings in the server logs.
router.get('/system-status', adminAuthRequired, async (req, res) => {
  let dbOk = true;
  try { await db.queryOne('SELECT 1 AS ok'); } catch (_) { dbOk = false; }

  const publicGeminiKey = process.env.PUBLIC_GEMINI_API_KEY || '';
  const publicGeminiUsable = !!publicGeminiKey && publicGeminiKey !== process.env.GEMINI_API_KEY;

  res.json({
    groups: [
      {
        name: 'Core',
        items: [
          { label: 'Database connection', ok: dbOk },
          { label: 'GEMINI_API_KEY (embeddings, /ask, /study)', ok: !!process.env.GEMINI_API_KEY },
          { label: 'JWT_SECRET', ok: !!process.env.JWT_SECRET },
          { label: 'Supabase storage (SUPABASE_URL / SUPABASE_SECRET_KEY)', ok: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) },
        ],
      },
      {
        name: 'Voice engines',
        items: [
          { label: 'Gemini Live public key (PUBLIC_GEMINI_API_KEY)', ok: publicGeminiUsable, note: publicGeminiKey && !publicGeminiUsable ? 'Set, but identical to GEMINI_API_KEY — treated as unset for safety' : null },
          { label: 'Fish Audio (FISH_AUDIO_API_KEY)', ok: !!process.env.FISH_AUDIO_API_KEY },
          { label: 'Cartesia (CARTESIA_API_KEY)', ok: !!process.env.CARTESIA_API_KEY },
          { label: 'ElevenLabs (ELEVENLABS_API_KEY)', ok: !!process.env.ELEVENLABS_API_KEY },
        ],
      },
      {
        name: 'Billing',
        items: [
          { label: 'Stripe (STRIPE_SECRET_KEY)', ok: !!process.env.STRIPE_SECRET_KEY },
          { label: 'Stripe webhook (STRIPE_WEBHOOK_SECRET)', ok: !!process.env.STRIPE_WEBHOOK_SECRET },
          { label: 'Starter price (STRIPE_PRICE_STARTER)', ok: !!process.env.STRIPE_PRICE_STARTER },
          { label: 'Pro price (STRIPE_PRICE_PRO)', ok: !!process.env.STRIPE_PRICE_PRO },
          { label: 'Business price (STRIPE_PRICE_BUSINESS)', ok: !!process.env.STRIPE_PRICE_BUSINESS },
        ],
      },
      {
        name: 'Email',
        items: [
          { label: 'SMTP (password reset, notifications)', ok: !!process.env.SMTP_HOST },
        ],
      },
    ],
  });
});

// ── Audit log ─────────────────────────────────────────────────
router.get('/audit-log', adminAuthRequired, async (req, res) => {
  const page = Math.min(100000, Math.max(1, parseInt(req.query.page) || 1));
  const pageSize = 50;
  const conds = [];
  const params = [];
  const addCond = (sql, val) => { params.push(val); conds.push(sql.replace('?', `$${params.length}`)); };

  if (req.query.action)      addCond('l.action = ?', String(req.query.action));
  if (req.query.targetEmail) addCond('l.target_email ILIKE ?', `%${req.query.targetEmail}%`);
  if (req.query.adminEmail)  addCond('a.email ILIKE ?', `%${req.query.adminEmail}%`);
  if (req.query.since)       addCond('l.created_at >= ?', parseInt(req.query.since, 10));
  if (req.query.until)       addCond('l.created_at <= ?', parseInt(req.query.until, 10));
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const [entries, [{ count }], [{ actions }]] = await Promise.all([
    db.query(
      `SELECT l.*, a.email AS admin_email
         FROM admin_audit_log l
         LEFT JOIN admin_users a ON a.id = l.admin_id
        ${where}
        ORDER BY l.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    ),
    db.query(`SELECT COUNT(*)::int AS count FROM admin_audit_log l LEFT JOIN admin_users a ON a.id = l.admin_id ${where}`, params),
    // Distinct action names seen so far, for the filter dropdown — cheap
    // since admin_audit_log is admin-volume, not visitor-volume.
    db.query(`SELECT array_agg(DISTINCT action ORDER BY action) AS actions FROM admin_audit_log`),
  ]);
  res.json({ entries, page, pageSize, total: count, actions: actions || [] });
});

module.exports = router;
