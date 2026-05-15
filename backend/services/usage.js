/**
 * Usage tracking + plan-limit checks.
 *
 * Granularity: one usage row per user per calendar month.
 * Counters: messages, embeddingChars, projects (live), files (live), storageMb (live).
 *
 * "Live" counters are computed from current state (project/file rows) rather
 * than incremented — keeps things consistent if data is deleted.
 *
 * "Cumulative" counters (messages, embeddingChars) are incremented on use
 * and reset at the start of each month via getCurrentUsage() lazily checking
 * the period.
 */
const db = require('../db');
const { getPlan } = require('../plans');

function periodKey(d = new Date()) {
  // YYYY-MM key, e.g. "2026-05"
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getOrCreateUsage(userId) {
  const period = periodKey();
  let row = db.findOne('usage', u => u.userId === userId && u.period === period);
  if (row) return row;
  row = {
    id: `${userId}:${period}`,
    userId,
    period,
    messages: 0,
    embeddingChars: 0,
    createdAt: Date.now(),
  };
  // sync write so the row exists for subsequent updates
  const all = db.readTable('usage');
  all.push(row);
  db.writeTable('usage', all);
  return row;
}

function userPlanId(userId) {
  const sub = db.findOne('subscriptions', s => s.userId === userId && s.status === 'active');
  return sub ? sub.planId : 'free';
}

function getUsageSnapshot(userId) {
  const planId = userPlanId(userId);
  const plan = getPlan(planId);
  const usage = getOrCreateUsage(userId);

  const projects = db.findAll('projects', p => p.userId === userId).length;
  const files = db.findAll('files', f => f.userId === userId).length;
  const storageBytes = db.findAll('files', f => f.userId === userId)
    .reduce((sum, f) => sum + (f.size || 0), 0);
  const storageMb = +(storageBytes / 1024 / 1024).toFixed(2);

  const urlSources = db.findAll('files', f => f.userId === userId && f.kind === 'url').length;

  return {
    plan,
    period: usage.period,
    counters: {
      projects,
      files,
      storageMb,
      urlSources,
      messages: usage.messages,
      embeddingChars: usage.embeddingChars,
    },
    limits: plan.limits,
  };
}

async function trackMessage(userId) {
  if (!userId) return;
  const usage = getOrCreateUsage(userId);
  await db.update('usage', usage.id, { messages: (usage.messages || 0) + 1 });
}

async function trackEmbeddingChars(userId, count) {
  if (!userId || !count) return;
  const usage = getOrCreateUsage(userId);
  await db.update('usage', usage.id, { embeddingChars: (usage.embeddingChars || 0) + count });
}

/**
 * Check if `userId` can perform action `kind` with given `delta`.
 * Returns { ok: true } or { ok: false, reason, limit, current }.
 */
function checkLimit(userId, kind, delta = 1) {
  const snap = getUsageSnapshot(userId);
  const c = snap.counters;
  const l = snap.limits;
  switch (kind) {
    case 'project':
      if (c.projects + delta > l.projects) return fail('chatbot', l.projects, c.projects);
      break;
    case 'file':
      if (c.files + delta > l.filesPerProject) return fail('file', l.filesPerProject, c.files);
      // (note: limit field is "filesPerProject" but we use it here as a global cap;
      // a stricter version would check files per individual project. Good enough for v1.)
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

module.exports = {
  userPlanId,
  getUsageSnapshot,
  trackMessage,
  trackEmbeddingChars,
  checkLimit,
};
