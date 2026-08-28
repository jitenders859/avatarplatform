const { test } = require('node:test');
const assert = require('node:assert/strict');

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

test('scheduleHandoffEmail sends after the grace window if not cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  stubFile('../services/email', { sendHandoffRequestEmail: async (opts) => { sent.push(opts); } });
  stubFile('../db', {
    findOne: async (table, filter) => {
      if (table === 'sessions') return { id: filter.id, handoffStatus: 'requested' };
      if (table === 'users') return { id: filter.id, email: 'owner@example.com' };
      return null;
    },
    query: async () => [],
    queryOne: async () => ({ text: 'Hello, is anyone there?' }),
  });
  delete require.cache[require.resolve('./notify')];
  const notify = require('./notify');
  notify._reset();

  notify.scheduleHandoffEmail('sess-1', { id: 'proj-1', userId: 'user-1', name: 'Test Bot' });
  t.mock.timers.tick(notify.GRACE_MS);
  await new Promise(r => setImmediate(r));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipients.includes('owner@example.com'), true);
  assert.equal(sent[0].previewText, 'Hello, is anyone there?');
});

test('cancelHandoffEmail prevents the email from sending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  stubFile('../services/email', { sendHandoffRequestEmail: async (opts) => { sent.push(opts); } });
  stubFile('../db', { findOne: async () => ({ handoffStatus: 'requested' }), query: async () => [], queryOne: async () => null });
  delete require.cache[require.resolve('./notify')];
  const notify = require('./notify');
  notify._reset();

  notify.scheduleHandoffEmail('sess-2', { id: 'proj-2', userId: 'user-2', name: 'Test Bot 2' });
  notify.cancelHandoffEmail('sess-2');
  t.mock.timers.tick(notify.GRACE_MS);
  await new Promise(r => setImmediate(r));

  assert.equal(sent.length, 0);
});

test('a session already claimed before the timer fires does not send', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  stubFile('../services/email', { sendHandoffRequestEmail: async (opts) => { sent.push(opts); } });
  stubFile('../db', { findOne: async () => ({ handoffStatus: 'active' }), query: async () => [], queryOne: async () => null });
  delete require.cache[require.resolve('./notify')];
  const notify = require('./notify');
  notify._reset();

  notify.scheduleHandoffEmail('sess-3', { id: 'proj-3', userId: 'user-3', name: 'Test Bot 3' });
  t.mock.timers.tick(notify.GRACE_MS);
  await new Promise(r => setImmediate(r));

  assert.equal(sent.length, 0);
});

test('rate limit skips a second email for the same project within 5 minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  stubFile('../services/email', { sendHandoffRequestEmail: async (opts) => { sent.push(opts); } });
  stubFile('../db', { findOne: async () => ({ handoffStatus: 'requested' }), query: async () => [], queryOne: async () => null });
  delete require.cache[require.resolve('./notify')];
  const notify = require('./notify');
  notify._reset();

  notify.scheduleHandoffEmail('sess-4', { id: 'proj-4', userId: 'user-4', name: 'Test Bot 4' });
  t.mock.timers.tick(notify.GRACE_MS);
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1);

  notify.scheduleHandoffEmail('sess-5', { id: 'proj-4', userId: 'user-4', name: 'Test Bot 4' });
  t.mock.timers.tick(notify.GRACE_MS);
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1, 'second email for the same project should be rate-limited');
});
