/**
 * Team members / multi-seat (improvement-prompts.md Prompt F4 item 3).
 * Deliberately narrow scope: a project_members row grants an existing
 * AvatarPlatform user read-only access to a project's sessions and
 * analytics — nothing else. This covers the Business-plan gate on
 * inviting, invite validation, the read-only reach of membership
 * (sessions/GET-:id yes, webhookSecret/leads/delete no), and removal.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-do-not-use-in-prod';

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

const OWNER = { id: 'owner-1', email: 'owner@example.com', suspended: false };
const MEMBER = { id: 'member-1', email: 'member@example.com', suspended: false };
const OUTSIDER = { id: 'outsider-1', email: 'outsider@example.com', suspended: false };
const USERS_BY_ID = { [OWNER.id]: OWNER, [MEMBER.id]: MEMBER, [OUTSIDER.id]: OUTSIDER };
const USERS_BY_EMAIL = { [OWNER.email]: OWNER, [MEMBER.email]: MEMBER, [OUTSIDER.email]: OUTSIDER };

const PROJECT = { id: 'proj-1', userId: OWNER.id, name: 'Team Bot', publicId: 'team-bot', webhookSecret: 'super-secret-value', createdAt: 1 };

let members = []; // { id, projectId, userId, invitedBy, createdAt }
let plan = 'business';
let sentInvites = [];

stubFile('../db', {
  findOne: async (table, filter) => {
    if (table === 'users') {
      if (filter.id) return USERS_BY_ID[filter.id] || null;
      if (filter.email) return USERS_BY_EMAIL[filter.email] || null;
      return null;
    }
    if (table === 'projects') {
      if (filter.id !== PROJECT.id) return null;
      if (filter.userId && filter.userId !== PROJECT.userId) return null;
      return { ...PROJECT };
    }
    if (table === 'projectMembers') {
      return members.find(m => m.projectId === filter.projectId && m.userId === filter.userId) || null;
    }
    return null;
  },
  findAll: async () => [],
  query: async (sql, params) => {
    if (/FROM project_members/.test(sql)) {
      const [projectId] = params;
      return members
        .filter(m => m.projectId === projectId)
        .map(m => ({ id: m.id, userId: m.userId, createdAt: m.createdAt, email: USERS_BY_ID[m.userId].email, name: null }));
    }
    if (/FROM sessions s/.test(sql)) return [];
    return [];
  },
  queryOne: async () => null,
  insert: async (table, row) => {
    if (table === 'projectMembers') { members.push(row); return row; }
    return row;
  },
  update: async () => null,
  remove: async (table, filter) => {
    if (table === 'projectMembers') {
      const before = members.length;
      members = members.filter(m => !(m.id === filter.id && m.projectId === filter.projectId));
      return before - members.length;
    }
    return 0;
  },
  pool: { end: async () => {} },
});
stubFile('../services/safeFetch', { safeFetch: async () => { throw new Error('not used'); }, assertSafeUrl: async () => {} });
stubFile('../services/storage', { createSignedUploadUrl: async () => ({}), characterAssets: { getPublicUrl: () => '' } });
stubFile('../services/usage', { checkLimit: async () => ({ ok: true }), userPlanId: async () => plan });
stubFile('../services/email', {
  sendTeamInviteEmail: async (to, projectName, inviterEmail) => { sentInvites.push({ to, projectName, inviterEmail }); },
});

function request(port, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(chunks || '{}') }); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function setupApp() {
  delete require.cache[require.resolve('./projects')];
  const { router } = require('./projects');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', router);
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

function token(user) {
  return jwt.sign({ uid: user.id }, process.env.JWT_SECRET, { algorithm: 'HS256' });
}

test('team members: invite, read-only reach, and removal', async (t) => {
  const app = setupApp();
  const server = app.listen(0);
  t.after(() => { server.close(); members = []; plan = 'business'; sentInvites = []; });
  const port = server.address().port;

  const ownerToken = token(OWNER);
  const memberToken = token(MEMBER);
  const outsiderToken = token(OUTSIDER);

  // Non-Business plan can't invite.
  plan = 'pro';
  const blocked = await request(port, 'POST', `/api/projects/${PROJECT.id}/members`, { email: MEMBER.email }, ownerToken);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'BUSINESS_PLAN_REQUIRED');
  plan = 'business';

  // Inviting an email with no AvatarPlatform account 404s.
  const noAccount = await request(port, 'POST', `/api/projects/${PROJECT.id}/members`, { email: 'nobody@example.com' }, ownerToken);
  assert.equal(noAccount.status, 404);

  // Inviting yourself 400s.
  const self = await request(port, 'POST', `/api/projects/${PROJECT.id}/members`, { email: OWNER.email }, ownerToken);
  assert.equal(self.status, 400);

  // Owner invites MEMBER — succeeds, fires the invite email.
  const invite = await request(port, 'POST', `/api/projects/${PROJECT.id}/members`, { email: MEMBER.email }, ownerToken);
  assert.equal(invite.status, 200);
  assert.equal(sentInvites.length, 1);
  assert.equal(sentInvites[0].to, MEMBER.email);

  // Inviting the same person twice 409s.
  const dupe = await request(port, 'POST', `/api/projects/${PROJECT.id}/members`, { email: MEMBER.email }, ownerToken);
  assert.equal(dupe.status, 409);

  // Owner sees the member in the list.
  const list = await request(port, 'GET', `/api/projects/${PROJECT.id}/members`, null, ownerToken);
  assert.equal(list.status, 200);
  assert.equal(list.json.members.length, 1);
  assert.equal(list.json.members[0].email, MEMBER.email);

  // MEMBER can read the project (read-only), but never sees the webhook secret.
  const memberGet = await request(port, 'GET', `/api/projects/${PROJECT.id}`, null, memberToken);
  assert.equal(memberGet.status, 200);
  assert.equal(memberGet.json.isOwner, false);
  assert.equal(memberGet.json.project.webhookSecret, undefined, 'members must never receive the webhook secret');

  // MEMBER can list sessions (Conversations tab).
  const memberSessions = await request(port, 'GET', `/api/projects/${PROJECT.id}/sessions`, null, memberToken);
  assert.equal(memberSessions.status, 200);

  // MEMBER cannot see leads (out of the read-only scope) or delete the project.
  const memberLeads = await request(port, 'GET', `/api/projects/${PROJECT.id}/leads`, null, memberToken);
  assert.equal(memberLeads.status, 404);
  const memberDelete = await request(port, 'DELETE', `/api/projects/${PROJECT.id}`, null, memberToken);
  assert.equal(memberDelete.status, 404);

  // A user who was never invited gets nothing.
  const outsiderGet = await request(port, 'GET', `/api/projects/${PROJECT.id}`, null, outsiderToken);
  assert.equal(outsiderGet.status, 404);

  // Owner removes the member — their access is revoked immediately.
  const memberId = list.json.members[0].id;
  const removed = await request(port, 'DELETE', `/api/projects/${PROJECT.id}/members/${memberId}`, null, ownerToken);
  assert.equal(removed.status, 200);
  const afterRemoval = await request(port, 'GET', `/api/projects/${PROJECT.id}`, null, memberToken);
  assert.equal(afterRemoval.status, 404);
});
