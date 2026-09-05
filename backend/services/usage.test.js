/**
 * checkLimit() boundary values, custom admin tier merging, and admin-plan-
 * override precedence — the enforcement point behind every plan limit
 * (Prompt T1 item 3 in improvement-prompts.md).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

const USER_ID = 'u1';
// Real free-plan limits (not hardcoded guesses) so this test stays correct
// if backend/plans.js's numbers change — PLANS itself needs no db access.
const FREE_LIMITS = require('../plans').PLANS[0].limits;

let dbState;
function freshDb() {
  dbState = {
    user: { id: USER_ID, adminPlanId: null, adminPlanExpiresAt: null },
    sub: null,
    planTiers: {},
    projectStats: { projects: 0, files: 0, storageBytes: 0, urlSources: 0 },
    usage: { period: '2026-08', messages: 0, embeddingChars: 0 },
  };
  return {
    findOne: async (table, filter) => {
      if (table === 'users') return filter.id === USER_ID ? dbState.user : null;
      if (table === 'subscriptions') return dbState.sub;
      if (table === 'plan_tiers') return dbState.planTiers[filter.id] || null;
      if (table === 'usage') return dbState.usage;
      return null;
    },
    query: async () => [],
    queryOne: async (sql) => {
      // getUsageSnapshot's project/file/storage aggregate query
      return {
        projects: dbState.projectStats.projects,
        files: dbState.projectStats.files,
        storageBytes: dbState.projectStats.storageBytes,
        urlSources: dbState.projectStats.urlSources,
      };
    },
    insert: async () => null,
  };
}

function reload() {
  delete require.cache[require.resolve('./usage')];
  delete require.cache[require.resolve('../plans')];
  stubFile('../db', freshDb());
  return require('./usage');
}

test('checkLimit: exactly at the limit fails, one under succeeds (project limit, free plan)', async () => {
  const { checkLimit } = reload();
  dbState.projectStats.projects = FREE_LIMITS.projects; // free plan cap is 1
  const atLimit = await checkLimit(USER_ID, 'project', 1);
  assert.equal(atLimit.ok, false);
  assert.equal(atLimit.limit, FREE_LIMITS.projects);

  dbState.projectStats.projects = FREE_LIMITS.projects - 1;
  const underLimit = await checkLimit(USER_ID, 'project', 1);
  assert.equal(underLimit.ok, true);
});

test('checkLimit: file count boundary uses maxFiles (renamed from filesPerProject, tracked user-wide)', async () => {
  const { checkLimit } = reload();
  dbState.projectStats.files = FREE_LIMITS.maxFiles - 1;
  assert.equal((await checkLimit(USER_ID, 'file', 1)).ok, true);
  dbState.projectStats.files = FREE_LIMITS.maxFiles;
  const result = await checkLimit(USER_ID, 'file', 1);
  assert.equal(result.ok, false);
  assert.equal(result.limit, FREE_LIMITS.maxFiles);
});

test('checkLimit: storageMb boundary is inclusive of the exact cap', async () => {
  const { checkLimit } = reload();
  dbState.projectStats.storageBytes = FREE_LIMITS.storageMb * 1024 * 1024;
  assert.equal((await checkLimit(USER_ID, 'storageMb', 0)).ok, true, 'exactly at the cap with zero delta should still pass');
  assert.equal((await checkLimit(USER_ID, 'storageMb', 1)).ok, false, 'one more MB over the cap should fail');
});

test('checkLimit: monthly message counter resets are period-scoped (delegates to getOrCreateUsage)', async () => {
  const { checkLimit } = reload();
  dbState.usage.messages = FREE_LIMITS.monthlyMessages - 1;
  assert.equal((await checkLimit(USER_ID, 'message', 1)).ok, true);
  dbState.usage.messages = FREE_LIMITS.monthlyMessages;
  assert.equal((await checkLimit(USER_ID, 'message', 1)).ok, false);
});

test('checkLimit: a custom admin tier only overrides the keys it sets, falling back to free defaults for the rest', async () => {
  const { checkLimit } = reload();
  dbState.user.adminPlanId = 'tier_custom';
  dbState.planTiers.tier_custom = { id: 'tier_custom', name: 'Custom Bump', limits: { projects: 999 } }; // only overrides projects
  dbState.projectStats.projects = 500; // way over free's 1, fine under custom's 999
  assert.equal((await checkLimit(USER_ID, 'project', 1)).ok, true);
  // maxFiles wasn't in the custom tier's limits, so it still falls back to
  // the free plan's default (5) via plans.js's { ...PLANS[0].limits, ...custom.limits }.
  dbState.projectStats.files = FREE_LIMITS.maxFiles;
  assert.equal((await checkLimit(USER_ID, 'file', 1)).ok, false);
});

test('checkLimit: an expired admin override reverts to the Stripe-driven (or free) plan', async () => {
  const { checkLimit } = reload();
  dbState.user.adminPlanId = 'tier_custom';
  dbState.user.adminPlanExpiresAt = Date.now() - 1000; // expired
  dbState.planTiers.tier_custom = { id: 'tier_custom', name: 'Custom Bump', limits: { projects: 999 } };
  dbState.projectStats.projects = FREE_LIMITS.projects; // at the free cap
  const result = await checkLimit(USER_ID, 'project', 1);
  assert.equal(result.ok, false, 'expired override must not grant the custom tier\'s higher limit');
});

test('checkLimit: an active (non-expired) admin override applies', async () => {
  const { checkLimit } = reload();
  dbState.user.adminPlanId = 'tier_custom';
  dbState.user.adminPlanExpiresAt = Date.now() + 60_000; // not yet expired
  dbState.planTiers.tier_custom = { id: 'tier_custom', name: 'Custom Bump', limits: { projects: 999 } };
  dbState.projectStats.projects = FREE_LIMITS.projects; // over free's cap, fine under custom's 999
  assert.equal((await checkLimit(USER_ID, 'project', 1)).ok, true);
});
