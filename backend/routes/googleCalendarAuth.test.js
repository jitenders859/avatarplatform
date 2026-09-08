const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-do-not-use-in-prod';
process.env.GOOGLE_CLIENT_ID = 'client-id';
process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'http://localhost:8080/api/google-calendar/callback';

const stubFile = (rel, exports) => {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
};

const OWNER = { id: 'owner-1', email: 'owner@example.com', suspended: false };
const PROJECT = { id: 'proj-1', userId: 'owner-1' };
let connections;

beforeEach(() => { connections = []; });

stubFile('../db', {
  findOne: async (table, filter) => {
    if (table === 'users') return filter.id === OWNER.id ? OWNER : null;
    if (table === 'projects') return (filter.id === PROJECT.id && filter.userId === OWNER.id) ? PROJECT : null;
    if (table === 'calendarConnections') return connections.find(c => c.projectId === filter.projectId) || null;
    return null;
  },
  insert: async (table, row) => { connections.push(row); return row; },
  update: async (table, id, patch) => {
    const c = connections.find(x => x.id === id);
    Object.assign(c, patch);
    return c;
  },
  remove: async (table, filter) => {
    const before = connections.length;
    connections = connections.filter(c => c.projectId !== filter.projectId);
    return before - connections.length;
  },
});

stubFile('../services/googleCalendar', {
  isConfigured: () => true,
  buildAuthorizationUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
  exchangeCode: async (code) => {
    if (code === 'bad-code') throw new Error('invalid_grant');
    return { refreshToken: 'rt-1', accessToken: 'at-1', expiresAt: Date.now() + 3600000, googleEmail: 'owner@example.com' };
  },
});

const { router } = require('./googleCalendarAuth');

function request(port, method, path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function makeServer() {
  const express = require('express');
  require('express-async-errors');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', router);
  const server = app.listen(0);
  return server;
}

function ownerToken() {
  return jwt.sign({ uid: OWNER.id }, process.env.JWT_SECRET);
}

test('GET /connect returns a Google auth URL for the project owner', async () => {
  const server = makeServer();
  const { port } = server.address();
  const res = await request(port, 'GET', `/api/projects/${PROJECT.id}/calendar/connect`, ownerToken());
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.match(body.url, /^https:\/\/accounts\.google\.com/);
  server.close();
});

test('GET /connect requires auth', async () => {
  const server = makeServer();
  const { port } = server.address();
  const res = await request(port, 'GET', `/api/projects/${PROJECT.id}/calendar/connect`);
  assert.equal(res.status, 401);
  server.close();
});

test('GET /connect 404s for a project the caller does not own', async () => {
  const server = makeServer();
  const { port } = server.address();
  const res = await request(port, 'GET', `/api/projects/not-my-project/calendar/connect`, ownerToken());
  assert.equal(res.status, 404);
  server.close();
});

test('GET /status reports connected:false with no connection, then true after one exists', async () => {
  const server = makeServer();
  const { port } = server.address();
  let res = await request(port, 'GET', `/api/projects/${PROJECT.id}/calendar/status`, ownerToken());
  assert.deepEqual(JSON.parse(res.body), { connected: false, googleEmail: null });

  connections.push({ id: 'conn-1', projectId: PROJECT.id, googleEmail: 'owner@example.com' });
  res = await request(port, 'GET', `/api/projects/${PROJECT.id}/calendar/status`, ownerToken());
  assert.deepEqual(JSON.parse(res.body), { connected: true, googleEmail: 'owner@example.com' });
  server.close();
});

test('DELETE / removes the connection', async () => {
  connections.push({ id: 'conn-1', projectId: PROJECT.id, googleEmail: 'owner@example.com' });
  const server = makeServer();
  const { port } = server.address();
  const res = await request(port, 'DELETE', `/api/projects/${PROJECT.id}/calendar`, ownerToken());
  assert.equal(res.status, 200);
  assert.equal(connections.length, 0);
  server.close();
});
