/**
 * Usage tracking + plan-limit checks.
 *
 * All functions are async (Postgres-backed).
 * "Live" counters (projects, files, storage, urlSources) are computed
 * with a single SQL aggregate query rather than scanning all rows in memory.
 * "Cumulative" counters (messages, embeddingChars) use SQL UPSERT with
 * atomic increments to avoid race conditions.
 */
const db = require('../db');
const { getPlan } = require('../plans');

function periodKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// A tier override with an expiresAt in the past is treated as if it were
// never set — checked lazily here rather than swept by a cron job, since
// every caller of userPlanId() already re-derives the plan on each read.
function isAdminPlanOverrideActive(user) {
  return !!(user?.adminPlanId && (!user.adminPlanExpiresAt || user.adminPlanExpiresAt > Date.now()));
}

async function userPlanId(userId) {
  const [user, sub] = await Promise.all([
    db.findOne('users', { id: userId }),
    db.findOne('subscriptions', { userId, status: 'active' }),
  ]);
  return isAdminPlanOverrideActive(user) ? user.adminPlanId : (sub ? sub.planId : 'free');
}

async function trackMessage(userId) {
  if (!userId) return;
  const period = periodKey();
  const id = `${userId}:${period}`;
  const now = Date.now();
  await db.query(
    `INSERT INTO usage (id, user_id, period, messages, embedding_chars, created_at, updated_at)
     VALUES ($1, $2, $3, 1, 0, $4, $4)
     ON CONFLICT (id) DO UPDATE SET messages = usage.messages + 1, updated_at = $4`,
    [id, userId, period, now]
  );
}

async function trackEmbeddingChars(userId, count) {
  if (!userId || !count) return;
  const period = periodKey();
  const id = `${userId}:${period}`;
  const now = Date.now();
  await db.query(
    `INSERT INTO usage (id, user_id, period, messages, embedding_chars, created_at, updated_at)
     VALUES ($1, $2, $3, 0, $4, $5, $5)
     ON CONFLICT (id) DO UPDATE SET embedding_chars = usage.embedding_chars + $4, updated_at = $5`,
    [id, userId, period, count, now]
  );
}

async function getOrCreateUsage(userId) {
  const period = periodKey();
  const id = `${userId}:${period}`;
  await db.query(
    `INSERT INTO usage (id, user_id, period, messages, embedding_chars, created_at)
     VALUES ($1, $2, $3, 0, 0, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, userId, period, Date.now()]
  );
  return db.findOne('usage', { id });
}

async function getUsageSnapshot(userId) {
  const [planId, usage, stats] = await Promise.all([
    userPlanId(userId),
    getOrCreateUsage(userId),
    db.queryOne(
      `SELECT
         COUNT(DISTINCT p.id)                                      AS projects,
         COUNT(DISTINCT f.id)                                      AS files,
         COALESCE(SUM(f.size), 0)                                  AS storage_bytes,
         COUNT(DISTINCT f.id) FILTER (WHERE f.kind = 'url')        AS url_sources
       FROM projects p
       LEFT JOIN files f ON f.project_id = p.id
       WHERE p.user_id = $1`,
      [userId]
    ),
  ]);

  const plan = await getPlan(planId);
  const storageMb = +((Number(stats.storageBytes) || 0) / 1024 / 1024).toFixed(2);
  const messages = usage.messages || 0;

  return {
    plan,
    period: usage.period,
    counters: {
      projects:       Number(stats.projects)   || 0,
      files:          Number(stats.files)      || 0,
      storageMb,
      urlSources:     Number(stats.urlSources) || 0,
      messages,
      embeddingChars: usage.embeddingChars     || 0,
    },
    limits: plan.limits,
    // 3a — usage-based billing overlay (see docs/competitor-feature-implementation-plan.md
    // 3a). Informational: no real Stripe metered charge is created — see
    // plans.js's overageRate comment for why.
    usageAlert: buildUsageAlert(messages, plan),
  };
}

const WARNING_RATIO = 0.8;

function buildUsageAlert(messages, plan) {
  const cap = plan.limits.monthlyMessages;
  const ratio = cap > 0 ? messages / cap : 0;
  const overBy = Math.max(0, messages - cap);
  return {
    ratio,
    level: overBy > 0 ? 'over' : ratio >= WARNING_RATIO ? 'warning' : 'ok',
    projectedOverageCost: (overBy > 0 && plan.overageRate) ? +(overBy * plan.overageRate).toFixed(2) : 0,
  };
}

async function checkLimit(userId, kind, delta = 1) {
  const snap = await getUsageSnapshot(userId);
  const c = snap.counters;
  const l = snap.limits;
  switch (kind) {
    case 'project':
      if (c.projects + delta > l.projects) return fail('chatbot', l.projects, c.projects);
      break;
    case 'file':
      if (c.files + delta > l.maxFiles) return fail('file', l.maxFiles, c.files);
      break;
    case 'storageMb':
      if (c.storageMb + delta > l.storageMb) return fail('storage', l.storageMb + ' MB', c.storageMb + ' MB');
      break;
    case 'message':
      if (c.messages + delta > l.monthlyMessages) return fail('monthly message', l.monthlyMessages, c.messages);
      break;
    case 'embeddingChars':
      if (c.embeddingChars + delta > l.monthlyEmbeddingChars) return fail('embedding character', l.monthlyEmbeddingChars, c.embeddingChars);
      break;
    case 'urlSource':
      if (c.urlSources + delta > l.urlSources) return fail('URL source', l.urlSources, c.urlSources);
      break;
  }
  return { ok: true };
}

function fail(name, limit, current) {
  return {
    ok: false,
    reason: `Plan ${name} limit reached (${current} / ${limit}). Upgrade to add more.`,
    limit, current,
  };
}

// Metric -> { counterKey, limitKey, label } used by getUsageAcrossUsers to
// compute a per-metric usage/limit ratio and pick the one closest to its cap
// ("top metric at risk"). Keys mirror getUsageSnapshot()'s `counters`/`limits`
// shapes exactly, so a user row here is comparable to their individual
// GET /admin/users/:id usage bars.
const RATIO_METRICS = [
  { counterKey: 'projects',       limitKey: 'projects',              label: 'chatbots' },
  { counterKey: 'files',          limitKey: 'maxFiles',              label: 'files' },
  { counterKey: 'storageMb',      limitKey: 'storageMb',             label: 'storage' },
  { counterKey: 'urlSources',     limitKey: 'urlSources',            label: 'URL sources' },
  { counterKey: 'messages',       limitKey: 'monthlyMessages',       label: 'monthly messages' },
  { counterKey: 'embeddingChars', limitKey: 'monthlyEmbeddingChars', label: 'monthly embedding chars' },
];

/**
 * Aggregate, cross-user usage view for the admin "Usage & Cost" tab
 * (docs/admin-panel-implementation-plan.md "3b. Aggregate usage/cost
 * dashboard"). Computes every user's current-period counters with ONE
 * GROUP BY query (not a loop calling getUsageSnapshot() per user — that
 * function does 2-3 queries per call and would be N+1 at any real user
 * count), resolves each user's plan limits via the exact same
 * isAdminPlanOverrideActive()/getPlan() resolution getUsageSnapshot() uses,
 * and returns rows sorted by "closest to any cap" first.
 *
 * There is no per-request $ cost ledger anywhere in this codebase (Gemini
 * calls are gated by aiCostLimiter as a rate/volume guard, not billed and
 * recorded per-call) — so `messages` is surfaced as the cost proxy per the
 * plan's note, not a fabricated dollar figure.
 */
async function getUsageAcrossUsers({ page = 1, limit = 25, sortBy = 'ratio' } = {}) {
  const period = periodKey();
  const pageNum = Math.min(100000, Math.max(1, parseInt(page, 10) || 1));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));

  // Single aggregate query across ALL users — counters grouped by user_id,
  // same tables/columns getUsageSnapshot() reads for one user (projects,
  // files, storage bytes, url-kind files, plus the current-period `usage`
  // row for messages/embeddingChars), plus the raw fields needed to resolve
  // each user's plan (admin override id/expiry, active subscription plan).
  const rows = await db.query(
    `SELECT
       u.id                                                       AS user_id,
       u.email,
       u.name,
       u.admin_plan_id,
       u.admin_plan_expires_at,
       s.plan_id                                                  AS stripe_plan_id,
       COUNT(DISTINCT p.id)                                       AS projects,
       COUNT(DISTINCT f.id)                                       AS files,
       COALESCE(SUM(f.size), 0)                                   AS storage_bytes,
       COUNT(DISTINCT f.id) FILTER (WHERE f.kind = 'url')         AS url_sources,
       MAX(COALESCE(us.messages, 0))                              AS messages,
       MAX(COALESCE(us.embedding_chars, 0))                       AS embedding_chars
     FROM users u
     LEFT JOIN LATERAL (
       SELECT plan_id FROM subscriptions
        WHERE user_id = u.id AND status = 'active'
        ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1
     ) s ON true
     LEFT JOIN projects p ON p.user_id = u.id
     LEFT JOIN files f ON f.project_id = p.id
     LEFT JOIN usage us ON us.user_id = u.id AND us.period = $1
     GROUP BY u.id, u.email, u.name, u.admin_plan_id, u.admin_plan_expires_at, s.plan_id`,
    [period]
  );

  // Resolve plan limits once per DISTINCT plan id in play (typically a
  // handful: free/starter/pro/business + any admin-defined custom tiers),
  // not once per user — reuses getPlan() itself (same PLANS-array lookup +
  // plan_tiers fallback getUsageSnapshot() relies on) rather than
  // re-deriving the merge logic here.
  const planIdForRow = (r) => {
    const overrideActive = isAdminPlanOverrideActive({
      adminPlanId: r.adminPlanId,
      adminPlanExpiresAt: r.adminPlanExpiresAt,
    });
    return overrideActive ? r.adminPlanId : (r.stripePlanId || 'free');
  };

  const distinctPlanIds = [...new Set(rows.map(planIdForRow))];
  const planEntries = await Promise.all(distinctPlanIds.map(async (id) => [id, await getPlan(id)]));
  const planById = new Map(planEntries);

  const usersOut = rows.map((r) => {
    const planId = planIdForRow(r);
    const plan = planById.get(planId);
    const overrideActive = isAdminPlanOverrideActive({
      adminPlanId: r.adminPlanId,
      adminPlanExpiresAt: r.adminPlanExpiresAt,
    });

    const counters = {
      projects:       Number(r.projects)       || 0,
      files:          Number(r.files)          || 0,
      storageMb:      +((Number(r.storageBytes) || 0) / 1024 / 1024).toFixed(2),
      urlSources:     Number(r.urlSources)      || 0,
      messages:       Number(r.messages)        || 0,
      embeddingChars: Number(r.embeddingChars)  || 0,
    };

    let topMetric = null;
    let maxRatio = 0;
    for (const m of RATIO_METRICS) {
      const current = counters[m.counterKey];
      const cap = plan.limits[m.limitKey];
      const ratio = cap > 0 ? current / cap : 0;
      if (ratio > maxRatio) {
        maxRatio = ratio;
        topMetric = { key: m.counterKey, label: m.label, current, limit: cap, ratio };
      }
    }
    // Nothing used at all — still report the plan's primary cap (messages)
    // at 0% rather than leaving topMetric null.
    if (!topMetric) {
      const cap = plan.limits.monthlyMessages;
      topMetric = { key: 'messages', label: 'monthly messages', current: 0, limit: cap, ratio: 0 };
    }

    return {
      id: r.userId,
      email: r.email,
      name: r.name,
      planId,
      planSource: overrideActive ? 'admin' : (r.stripePlanId ? 'stripe' : 'free'),
      counters,
      limits: plan.limits,
      topMetric,
      maxRatio,
    };
  });

  usersOut.sort((a, b) => (
    sortBy === 'messages'
      ? b.counters.messages - a.counters.messages
      : b.maxRatio - a.maxRatio
  ));

  const total = usersOut.length;
  const offset = (pageNum - 1) * pageSize;
  const page_ = usersOut.slice(offset, offset + pageSize);

  return { users: page_, page: pageNum, pageSize, total, period };
}

module.exports = {
  userPlanId, getUsageSnapshot, trackMessage, trackEmbeddingChars, checkLimit,
  isAdminPlanOverrideActive, getUsageAcrossUsers,
};
