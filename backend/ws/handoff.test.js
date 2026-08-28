const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-do-not-use-in-prod';

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

const PROJECT = { id: '11111111-1111-1111-1111-111111111111', userId: 'owner-1', publicId: 'pub-1', name: 'Test Bot' };
const OWNER = { id: 'owner-1', email: 'owner@example.com', name: 'Owner', suspended: false };

function makeDb() {
  const sessions = new Map();
  const messages = [];
  return {
    _sessions: sessions,
    _messages: messages,
    findOne: async (table, filter) => {
      if (table === 'projects') {
        if (filter.publicId) return filter.publicId === PROJECT.publicId ? { ...PROJECT } : null;
        if (filter.id && filter.userId) return (filter.id === PROJECT.id && filter.userId === PROJECT.userId) ? { ...PROJECT } : null;
        if (filter.id) return filter.id === PROJECT.id ? { ...PROJECT } : null;
        return null;
      }
      if (table === 'users') return filter.id === OWNER.id ? { ...OWNER } : null;
      if (table === 'sessions') return sessions.get(filter.id) || null;
      if (table === 'projectMembers') return null;
      return null;
    },
    insert: async (table, row) => {
      if (table === 'sessions') sessions.set(row.id, { ...row, handoffStatus: 'none', claimedBy: null });
      if (table === 'messages') messages.push(row);
      return row;
    },
    update: async (table, id, patch) => {
      if (table === 'sessions') {
        const existing = sessions.get(id) || { id };
        const updated = { ...existing, ...patch };
        sessions.set(id, updated);
        return updated;
      }
      return null;
    },
    query: async (sql, params = []) => {
      if (/^\s*UPDATE sessions SET/i.test(sql)) {
        const [claimedBy, claimedAt, updatedAt, sessionId, projectId] = params;
        const existing = sessions.get(sessionId);
        if (!existing || existing.projectId !== projectId || existing.handoffStatus !== 'requested') return [];
        sessions.set(sessionId, { ...existing, handoffStatus: 'active', claimedBy, claimedAt, updatedAt });
        return [{ id: sessionId }];
      }
      if (/FROM sessions s/.test(sql)) {
        return [...sessions.values()]
          .filter(s => s.projectId === PROJECT.id && ['requested', 'active'].includes(s.handoffStatus))
          .map(s => ({ id: s.id, handoffStatus: s.handoffStatus, claimedBy: s.claimedBy, handoffRequestedAt: s.handoffRequestedAt, claimedByName: s.claimedBy ? OWNER.name : null, preview: messages.find(m => m.sessionId === s.id)?.text || null }));
      }
      return [];
    },
    queryOne: async () => null,
  };
}

async function startServer(db, opts = {}) {
  stubFile('../db', db);
  stubFile('../cache', { projectCache: { has: () => false, get: () => undefined, set: () => {} } });
  // startServer always (re-)stubs services/usage last, after any caller-side
  // stubFile('../services/usage', ...) call, so a caller wanting a
  // non-default plan must go through opts.planId here rather than stubbing
  // it separately beforehand — otherwise this call silently clobbers it.
  stubFile('../services/usage', { userPlanId: async () => opts.planId || 'business' });
  stubFile('./notify', { scheduleHandoffEmail: () => {}, cancelHandoffEmail: () => {} });
  delete require.cache[require.resolve('./handoff')];
  const { attach } = require('./handoff');
  const server = http.createServer();
  attach(server);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  return { server, port };
}

function waitForMessage(ws) {
  return new Promise(resolve => ws.once('message', (data) => resolve(JSON.parse(data.toString()))));
}

test('visitor connects without a sessionId and the server creates one', async () => {
  const db = makeDb();
  const { server, port } = await startServer(db);
  try {
    const visitorWs = new WebSocket(`ws://localhost:${port}/ws/embed/${PROJECT.publicId}`);
    const first = await waitForMessage(visitorWs);
    assert.equal(first.type, 'connected');
    assert.ok(first.sessionId);
    visitorWs.close();
  } finally {
    server.close();
  }
});

test('full flow: request -> queue_update to dashboard -> claim -> chat both ways -> resolve', async () => {
  const db = makeDb();
  const { server, port } = await startServer(db);
  try {
    const token = jwt.sign({ uid: OWNER.id }, process.env.JWT_SECRET);
    const dashWs = new WebSocket(`ws://localhost:${port}/ws/dashboard/${PROJECT.id}?token=${token}`);
    const initialSnapshot = await waitForMessage(dashWs); // sent immediately on connect
    assert.equal(initialSnapshot.type, 'queue_update');
    assert.equal(initialSnapshot.pending.length, 0);

    const visitorWs = new WebSocket(`ws://localhost:${port}/ws/embed/${PROJECT.publicId}`);
    const connected = await waitForMessage(visitorWs);
    const sessionId = connected.sessionId;

    const dashUpdatePromise = waitForMessage(dashWs);
    visitorWs.send(JSON.stringify({ type: 'request_handoff' }));
    const waitingReply = await waitForMessage(visitorWs);
    assert.equal(waitingReply.type, 'waiting'); // dashboard is connected -> available

    const queueUpdate = await dashUpdatePromise;
    assert.equal(queueUpdate.type, 'queue_update');
    assert.equal(queueUpdate.pending.length, 1);
    assert.equal(queueUpdate.pending[0].sessionId, sessionId);

    const claimedPromise = waitForMessage(visitorWs);
    dashWs.send(JSON.stringify({ type: 'claim', sessionId }));
    const claimed = await claimedPromise;
    assert.equal(claimed.type, 'claimed');
    assert.equal(claimed.byName, OWNER.name);

    const humanChatPromise = waitForMessage(dashWs);
    visitorWs.send(JSON.stringify({ type: 'chat', text: 'Hi, I need help' }));
    const relayedToHuman = await humanChatPromise;
    assert.equal(relayedToHuman.type, 'chat');
    assert.equal(relayedToHuman.from, 'visitor');
    assert.equal(relayedToHuman.text, 'Hi, I need help');
    assert.equal(relayedToHuman.sessionId, sessionId);

    const visitorChatPromise = waitForMessage(visitorWs);
    dashWs.send(JSON.stringify({ type: 'chat', sessionId, text: 'Sure, happy to help!' }));
    const relayedToVisitor = await visitorChatPromise;
    assert.equal(relayedToVisitor.type, 'chat');
    assert.equal(relayedToVisitor.from, 'human');
    assert.equal(relayedToVisitor.text, 'Sure, happy to help!');

    assert.equal(db._messages.filter(m => m.sessionId === sessionId).length, 2);

    const resolvedPromise = waitForMessage(visitorWs);
    dashWs.send(JSON.stringify({ type: 'resolve', sessionId }));
    const resolved = await resolvedPromise;
    assert.equal(resolved.type, 'resolved');
    assert.equal(db._sessions.get(sessionId).handoffStatus, 'resolved');

    dashWs.close(); visitorWs.close();
  } finally {
    server.close();
  }
});

test('claim is race-safe: two dashboard sockets claiming the same session, only one wins', async () => {
  const db = makeDb();
  const { server, port } = await startServer(db);
  try {
    const token = jwt.sign({ uid: OWNER.id }, process.env.JWT_SECRET);
    const dashWsA = new WebSocket(`ws://localhost:${port}/ws/dashboard/${PROJECT.id}?token=${token}`);
    await waitForMessage(dashWsA); // initial snapshot
    const dashWsB = new WebSocket(`ws://localhost:${port}/ws/dashboard/${PROJECT.id}?token=${token}`);
    await waitForMessage(dashWsB); // initial snapshot

    const visitorWs = new WebSocket(`ws://localhost:${port}/ws/embed/${PROJECT.publicId}`);
    const connected = await waitForMessage(visitorWs);
    const sessionId = connected.sessionId;

    const aUpdate = waitForMessage(dashWsA);
    const bUpdate = waitForMessage(dashWsB);
    visitorWs.send(JSON.stringify({ type: 'request_handoff' }));
    await waitForMessage(visitorWs); // 'waiting'
    await aUpdate; await bUpdate; // both dashboards see the pending request

    // Both sockets race to claim the same session. Only one 'claimed'
    // message should ever reach the visitor — the loser's claim is a
    // silent no-op, gated by the conditional UPDATE ... WHERE
    // handoff_status = 'requested' rather than a separate read-then-write.
    let claimedCount = 0;
    visitorWs.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'claimed') claimedCount++;
    });
    dashWsA.send(JSON.stringify({ type: 'claim', sessionId }));
    dashWsB.send(JSON.stringify({ type: 'claim', sessionId }));

    // Give both handlers time to run (there's no second success message to
    // await on the loser's side, so wait on the wall clock briefly instead).
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(claimedCount, 1);
    assert.equal(db._sessions.get(sessionId).handoffStatus, 'active');
    assert.ok(db._sessions.get(sessionId).claimedBy === 'owner-1'); // only OWNER is connected in this test

    dashWsA.close(); dashWsB.close(); visitorWs.close();
  } finally {
    server.close();
  }
});

test('no one available: visitor gets no_one_available when no dashboard socket is connected', async () => {
  const db = makeDb();
  const { server, port } = await startServer(db);
  try {
    const visitorWs = new WebSocket(`ws://localhost:${port}/ws/embed/${PROJECT.publicId}`);
    await waitForMessage(visitorWs); // connected
    const replyPromise = waitForMessage(visitorWs);
    visitorWs.send(JSON.stringify({ type: 'request_handoff' }));
    const reply = await replyPromise;
    assert.equal(reply.type, 'no_one_available');
    visitorWs.close();
  } finally {
    server.close();
  }
});

test('dashboard upgrade is rejected for a non-business plan', async () => {
  const db = makeDb();
  const { server, port } = await startServer(db, { planId: 'pro' });
  try {
    const token = jwt.sign({ uid: OWNER.id }, process.env.JWT_SECRET);
    const dashWs = new WebSocket(`ws://localhost:${port}/ws/dashboard/${PROJECT.id}?token=${token}`);
    const result = await new Promise(resolve => {
      dashWs.on('open', () => resolve('open'));
      dashWs.on('unexpected-response', (req, res) => resolve(res.statusCode));
      dashWs.on('error', () => resolve('error'));
    });
    assert.equal(result, 403);
  } finally {
    server.close();
  }
});

test('dashboard upgrade is rejected with an invalid token', async () => {
  const db = makeDb();
  const { server, port } = await startServer(db);
  try {
    const dashWs = new WebSocket(`ws://localhost:${port}/ws/dashboard/${PROJECT.id}?token=not-a-real-token`);
    const result = await new Promise(resolve => {
      dashWs.on('open', () => resolve('open'));
      dashWs.on('unexpected-response', (req, res) => resolve(res.statusCode));
      dashWs.on('error', () => resolve('error'));
    });
    assert.equal(result, 401);
  } finally {
    server.close();
  }
});
