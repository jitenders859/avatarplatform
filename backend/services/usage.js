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

async function userPlanId(userId) {
  const sub = await db.findOne('subscriptions', { userId, status: 'active' });
  return sub ? sub.planId : 'free';
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

  const plan = getPlan(planId);
  const storageMb = +((Number(stats.storageBytes) || 0) / 1024 / 1024).toFixed(2);

  return {
    plan,
    period: usage.period,
    counters: {
      projects:       Number(stats.projects)   || 0,
      files:          Number(stats.files)      || 0,
      storageMb,
      urlSources:     Number(stats.urlSources) || 0,
      messages:       usage.messages           || 0,
      embeddingChars: usage.embeddingChars     || 0,
    },
    limits: plan.limits,
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
      if (c.files + delta > l.filesPerProject) return fail('file', l.filesPerProject, c.files);
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

module.exports = { userPlanId, getUsageSnapshot, trackMessage, trackEmbeddingChars, checkLimit };
