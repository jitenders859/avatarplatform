/**
 * Webhook delivery-with-retry (improvement-prompts.md Prompt F4 item 6).
 * Replaces the old fire-and-forget single-attempt POST — every attempt is
 * now logged to webhook_deliveries and a failure schedules a retry instead
 * of just logging a warning and dropping the event.
 *
 * Forces PROCESS_MODE=inngest so scheduleRetry() takes the inngest.send()
 * branch (a stubbed, instantly-resolving async call) rather than the
 * inline branch's real setTimeout — a real 30s+ timer would otherwise
 * keep the test process alive waiting for it to fire.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.PROCESS_MODE = 'inngest';

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

const PROJECT = { id: 'proj-1', publicId: 'pub-1', webhookUrl: 'https://example.com/hook', webhookSecret: 'sekrit' };

let deliveries = new Map(); // id -> row
let fetchResults = []; // queue of { ok, status } or throws
let inngestSendCalls = [];

stubFile('../db', {
  findOne: async (table, filter) => {
    if (table === 'projects') return filter.id === PROJECT.id ? { ...PROJECT } : null;
    if (table === 'webhookDeliveries') return deliveries.get(filter.id) || null;
    return null;
  },
  findAll: async () => [],
  query: async () => [],
  queryOne: async () => null,
  insert: async (table, row) => { if (table === 'webhookDeliveries') deliveries.set(row.id, row); return row; },
  update: async (table, id, patch) => {
    if (table !== 'webhookDeliveries') return null;
    const row = deliveries.get(id);
    if (!row) return null;
    Object.assign(row, patch);
    return row;
  },
  remove: async () => 0,
  pool: { end: async () => {} },
});
stubFile('./safeFetch', {
  safeFetch: async () => {
    const next = fetchResults.shift();
    if (!next) throw new Error('no fetch result queued');
    if (next.throw) throw new Error(next.throw);
    return { ok: next.ok, status: next.status };
  },
});
stubFile('../inngest/client', { send: async (evt) => { inngestSendCalls.push(evt); } });

function load() {
  delete require.cache[require.resolve('./webhookDelivery')];
  return require('./webhookDelivery');
}

test('a successful first attempt is logged as success, no retry scheduled', async () => {
  deliveries = new Map();
  fetchResults = [{ ok: true, status: 200 }];
  inngestSendCalls = [];
  const { queueWebhookDelivery } = load();

  await queueWebhookDelivery(PROJECT, 'message', { text: 'hi' });

  const rows = [...deliveries.values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'success');
  assert.equal(rows[0].attempt, 1);
  assert.equal(rows[0].responseStatus, 200);
  assert.ok(rows[0].deliveredAt);
  assert.equal(inngestSendCalls.length, 0);
});

test('a failed attempt schedules a retry (via inngest.send) instead of giving up', async () => {
  deliveries = new Map();
  fetchResults = [{ ok: false, status: 500 }];
  inngestSendCalls = [];
  const { queueWebhookDelivery } = load();

  await queueWebhookDelivery(PROJECT, 'message', { text: 'hi' });

  const rows = [...deliveries.values()];
  assert.equal(rows[0].status, 'pending', 'stays pending — not failed — while retries remain');
  assert.equal(rows[0].attempt, 1);
  assert.match(rows[0].error, /HTTP 500/);
  assert.equal(inngestSendCalls.length, 1);
  assert.equal(inngestSendCalls[0].name, 'webhook/retry');
  assert.equal(inngestSendCalls[0].data.deliveryId, rows[0].id);
  assert.ok(inngestSendCalls[0].data.delayMs > 0, 'backs off rather than retrying instantly');
});

test('retries exhaust after MAX_ATTEMPTS and the row is marked failed', async () => {
  deliveries = new Map();
  inngestSendCalls = [];
  const { queueWebhookDelivery, attemptDelivery, MAX_ATTEMPTS } = load();

  fetchResults = [{ ok: false, status: 500 }];
  await queueWebhookDelivery(PROJECT, 'message', { text: 'hi' });
  const [delivery] = [...deliveries.values()];

  // Drive the remaining attempts directly (standing in for the real
  // timer/Inngest sleep firing attemptDelivery again each time).
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    fetchResults = [{ ok: false, status: 503 }];
    await attemptDelivery(delivery.id);
  }

  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.attempt, MAX_ATTEMPTS);
  assert.equal(inngestSendCalls.length, MAX_ATTEMPTS - 1, 'one retry scheduled per failure except the last');
});

test('a delivery whose project no longer has a webhook URL fails immediately without retrying', async () => {
  deliveries = new Map();
  inngestSendCalls = [];
  const { attemptDelivery } = load();

  const id = 'manual-1';
  deliveries.set(id, { id, projectId: 'no-such-project', payload: {}, status: 'pending', attempt: 0 });
  await attemptDelivery(id);

  const row = deliveries.get(id);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /no longer configured/);
  assert.equal(inngestSendCalls.length, 0);
});

test.after(() => { delete process.env.PROCESS_MODE; });
