/**
 * runUsageAlertSweep() — the cron-driven job (backend/inngest/functions.js's
 * usage-alerts) that emails/texts users approaching or over a plan limit.
 * Covers: warning vs. reached threshold selection, per-period de-dup via
 * notified_warning_at/notified_over_at, and SMS only firing when both a
 * phone number and the opt-in flag are set.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

let dbRows;
let updateCalls;
let emailCalls;
let smsCalls;

function reload() {
  for (const mod of ['./usage', '../plans', './email', './sms', '../db']) {
    delete require.cache[require.resolve(mod)];
  }

  dbRows = [];
  updateCalls = [];
  emailCalls = { warning: [], reached: [] };
  smsCalls = [];

  stubFile('../db', {
    query: async (sql, params) => {
      if (sql.includes('FROM users u')) return dbRows;
      if (sql.startsWith('UPDATE usage')) {
        updateCalls.push({ sql, params });
        return [];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    findOne: async () => null,
  });
  stubFile('./email', {
    sendUsageLimitWarning: async (email, info) => { emailCalls.warning.push({ email, info }); },
    sendUsageLimitReached: async (email, info) => { emailCalls.reached.push({ email, info }); },
    // Unrelated exports other modules pull in — unused here but required
    // for anything that requires './email' with a destructure not to blow up.
    sendPasswordReset: async () => {}, sendWelcome: async () => {}, sendContactMessage: async () => {},
    sendVerificationEmail: async () => {}, sendTeamInviteEmail: async () => {},
  });
  stubFile('./sms', {
    sendSms: async (to, body) => { smsCalls.push({ to, body }); },
  });

  return require('./usage');
}

// Free plan limits (backend/plans.js): monthlyMessages: 100.
function row(overrides = {}) {
  return {
    userId: 'u1',
    email: 'u1@example.com',
    phone: null,
    smsAlertsEnabled: false,
    adminPlanId: null,
    adminPlanExpiresAt: null,
    stripePlanId: null, // free
    usageId: 'u1:2026-09',
    notifiedWarningAt: null,
    notifiedOverAt: null,
    projects: 0,
    files: 0,
    storageBytes: 0,
    urlSources: 0,
    messages: 0,
    embeddingChars: 0,
    ...overrides,
  };
}

test('runUsageAlertSweep: under the warning ratio sends nothing', async () => {
  const { runUsageAlertSweep } = reload();
  dbRows = [row({ messages: 50 })]; // 50/100 = 50%
  const result = await runUsageAlertSweep();
  assert.equal(result.warned, 0);
  assert.equal(result.reached, 0);
  assert.equal(emailCalls.warning.length, 0);
  assert.equal(emailCalls.reached.length, 0);
  assert.equal(updateCalls.length, 0);
});

test('runUsageAlertSweep: crossing 80% sends the warning email once and stamps notified_warning_at', async () => {
  const { runUsageAlertSweep } = reload();
  dbRows = [row({ messages: 80 })]; // exactly 80%
  const result = await runUsageAlertSweep();
  assert.equal(result.warned, 1);
  assert.equal(emailCalls.warning.length, 1);
  assert.equal(emailCalls.warning[0].email, 'u1@example.com');
  assert.equal(emailCalls.warning[0].info.label, 'monthly messages');
  assert.equal(updateCalls.length, 1);
  assert.match(updateCalls[0].sql, /notified_warning_at = \$1/);
  assert.equal(smsCalls.length, 0, 'no phone on file — no SMS');
});

test('runUsageAlertSweep: already-warned user at the same ratio is not re-notified', async () => {
  const { runUsageAlertSweep } = reload();
  dbRows = [row({ messages: 85, notifiedWarningAt: Date.now() - 1000 })];
  const result = await runUsageAlertSweep();
  assert.equal(result.warned, 0);
  assert.equal(emailCalls.warning.length, 0);
  assert.equal(updateCalls.length, 0);
});

test('runUsageAlertSweep: hitting 100% sends the reached email+SMS and stamps both notified_* columns', async () => {
  const { runUsageAlertSweep } = reload();
  dbRows = [row({ messages: 120, phone: '+15551234567', smsAlertsEnabled: true })]; // over 100/100
  const result = await runUsageAlertSweep();
  assert.equal(result.reached, 1);
  assert.equal(emailCalls.reached.length, 1);
  assert.equal(smsCalls.length, 1);
  assert.equal(smsCalls[0].to, '+15551234567');
  assert.equal(updateCalls.length, 1);
  assert.match(updateCalls[0].sql, /notified_over_at = \$1, notified_warning_at = COALESCE/);
});

test('runUsageAlertSweep: a phone on file without the opt-in flag gets no SMS', async () => {
  const { runUsageAlertSweep } = reload();
  dbRows = [row({ messages: 120, phone: '+15551234567', smsAlertsEnabled: false })];
  await runUsageAlertSweep();
  assert.equal(smsCalls.length, 0);
});

test('runUsageAlertSweep: an already-reached user is not re-notified next sweep', async () => {
  const { runUsageAlertSweep } = reload();
  dbRows = [row({ messages: 150, notifiedWarningAt: Date.now() - 5000, notifiedOverAt: Date.now() - 1000 })];
  const result = await runUsageAlertSweep();
  assert.equal(result.reached, 0);
  assert.equal(result.warned, 0);
  assert.equal(emailCalls.reached.length, 0);
  assert.equal(updateCalls.length, 0);
});

test('runUsageAlertSweep: a user with zero usage is skipped entirely (no metric to alert on)', async () => {
  const { runUsageAlertSweep } = reload();
  dbRows = [row()];
  const result = await runUsageAlertSweep();
  assert.equal(result.checked, 1);
  assert.equal(result.warned, 0);
  assert.equal(result.reached, 0);
});
