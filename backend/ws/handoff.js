/**
 * Human handoff WebSocket server — attached to the same http.Server as
 * the Express app (see server.js), not a separate service. Two upgrade
 * paths:
 *   /ws/embed/:publicId?sessionId=...   visitor side, anonymous
 *   /ws/dashboard/:projectId?token=...  team side, JWT + business-plan gate
 */
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const { projectCache } = require('../cache');
const { userPlanId } = require('../services/usage');
const logger = require('../logger').child({ module: 'ws/handoff' });
const presence = require('./presence');
const { scheduleHandoffEmail, cancelHandoffEmail } = require('./notify');

const JWT_SECRET = process.env.JWT_SECRET;

async function findProjectByPublicId(publicId) {
  if (projectCache.has(publicId)) return projectCache.get(publicId);
  const project = await db.findOne('projects', { publicId });
  if (project) projectCache.set(publicId, project);
  return project;
}

// sessionId -> ws (visitor connections, at most one per session at a time)
const visitorSockets = new Map();

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const visitorMatch = url.pathname.match(/^\/ws\/embed\/([a-zA-Z0-9_-]+)$/);
    const dashboardMatch = url.pathname.match(/^\/ws\/dashboard\/([a-zA-Z0-9_-]+)$/);

    if (visitorMatch) {
      handleVisitorUpgrade(wss, req, socket, head, visitorMatch[1], url.searchParams.get('sessionId')).catch(e => {
        logger.error({ err: e.message }, 'visitor upgrade failed');
        socket.destroy();
      });
    } else if (dashboardMatch) {
      handleDashboardUpgrade(wss, req, socket, head, dashboardMatch[1], url.searchParams.get('token')).catch(e => {
        logger.error({ err: e.message }, 'dashboard upgrade failed');
        socket.destroy();
      });
    } else {
      socket.destroy();
    }
  });

  return wss;
}

function reject(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
  socket.destroy();
}

async function handleVisitorUpgrade(wss, req, socket, head, publicId, sessionIdParam) {
  const project = await findProjectByPublicId(publicId);
  if (!project) return reject(socket, 404, 'Not Found');

  let session = sessionIdParam ? await db.findOne('sessions', { id: sessionIdParam, projectId: project.id }) : null;
  if (!session) {
    session = await db.insert('sessions', {
      id: crypto.randomUUID(),
      projectId: project.id,
      ip: req.socket.remoteAddress || 'unknown',
      createdAt: Date.now(),
    });
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    visitorSockets.set(session.id, ws);
    ws.send(JSON.stringify({ type: 'connected', sessionId: session.id }));

    ws.on('message', (raw) => {
      handleVisitorMessage(project, session.id, ws, raw).catch(e =>
        logger.error({ err: e.message, sessionId: session.id }, 'visitor message handling failed'));
    });
    ws.on('close', () => {
      if (visitorSockets.get(session.id) === ws) visitorSockets.delete(session.id);
      cancelHandoffEmail(session.id);
    });
  });
}

async function handleDashboardUpgrade(wss, req, socket, head, projectId, token) {
  if (!token) return reject(socket, 401, 'Unauthorized');

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return reject(socket, 401, 'Unauthorized');
  }
  if (!payload.uid || payload.isAdmin) return reject(socket, 401, 'Unauthorized');

  const user = await db.findOne('users', { id: payload.uid });
  if (!user || user.suspended) return reject(socket, 401, 'Unauthorized');

  let project = await db.findOne('projects', { id: projectId, userId: user.id });
  if (!project) {
    const anyProject = await db.findOne('projects', { id: projectId });
    if (!anyProject) return reject(socket, 404, 'Not Found');
    const member = await db.findOne('projectMembers', { projectId, userId: user.id });
    if (!member) return reject(socket, 403, 'Forbidden');
    project = anyProject;
  }

  const planId = await userPlanId(project.userId);
  if (planId !== 'business') return reject(socket, 403, 'Forbidden');

  wss.handleUpgrade(req, socket, head, (ws) => {
    const entry = { ws, userId: user.id, userName: user.name || user.email };
    presence.addDashboardSocket(projectId, entry);

    sendQueueSnapshot(projectId, ws).catch(e => logger.error({ err: e.message }, 'initial snapshot failed'));

    ws.on('message', (raw) => {
      handleDashboardMessage(projectId, entry, raw).catch(e =>
        logger.error({ err: e.message, projectId }, 'dashboard message handling failed'));
    });
    ws.on('close', () => presence.removeDashboardSocket(projectId, entry));
  });
}

async function handleVisitorMessage(project, sessionId, ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  if (msg.type === 'request_handoff') {
    // Only schedule the grace-window email on a GENUINE first request for
    // this session — a visitor retrying/double-clicking would otherwise
    // reset notify.js's grace timer indefinitely (scheduleHandoffEmail
    // cancels-then-reschedules on every call) and the team might never
    // get notified. Check the session's *current* status before we
    // overwrite it: only 'none' or 'resolved' (i.e. not already
    // 'requested') counts as fresh.
    const before = await db.findOne('sessions', { id: sessionId });
    const isFreshRequest = !before || !['requested', 'active'].includes(before.handoffStatus);

    await db.update('sessions', sessionId, {
      handoffStatus: 'requested', handoffRequestedAt: Date.now(), claimedBy: null, claimedAt: null,
    });
    const available = presence.hasAvailability(project.id);
    ws.send(JSON.stringify({ type: available ? 'waiting' : 'no_one_available' }));
    presence.broadcastToProject(project.id, await queueSnapshotPayload(project.id));
    if (isFreshRequest) scheduleHandoffEmail(sessionId, project);
    return;
  }

  if (msg.type === 'chat') {
    const text = String(msg.text || '').slice(0, 2000);
    if (!text) return;
    const session = await db.findOne('sessions', { id: sessionId });
    if (!session || session.handoffStatus !== 'active' || !session.claimedBy) return;
    await db.insert('messages', {
      id: crypto.randomUUID(), sessionId, projectId: project.id, role: 'user', text, createdAt: Date.now(),
    });
    presence.sendToUser(project.id, session.claimedBy, { type: 'chat', text, from: 'visitor' });
  }
}

async function handleDashboardMessage(projectId, entry, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  if (msg.type === 'claim') {
    const session = await db.findOne('sessions', { id: msg.sessionId, projectId });
    if (!session || session.handoffStatus !== 'requested') return;
    await db.update('sessions', session.id, { handoffStatus: 'active', claimedBy: entry.userId, claimedAt: Date.now() });
    cancelHandoffEmail(session.id);
    // Broadcast the refreshed queue to the dashboard side (including the
    // claimer's own socket) BEFORE notifying the visitor. The visitor and
    // dashboard sockets are independent connections with no cross-socket
    // ordering guarantee, so which send call happens first on the server
    // is the only lever we have; putting the (slower — it awaits another
    // query) broadcast first keeps it well clear of whatever the visitor
    // does immediately after receiving 'claimed' (e.g. a UI that then
    // listens for the next dashboard message for an unrelated reason).
    presence.broadcastToProject(projectId, await queueSnapshotPayload(projectId));
    const visitorWs = visitorSockets.get(session.id);
    if (visitorWs && visitorWs.readyState === visitorWs.OPEN) {
      visitorWs.send(JSON.stringify({ type: 'claimed', byName: entry.userName }));
    }
    return;
  }

  if (msg.type === 'resolve') {
    const session = await db.findOne('sessions', { id: msg.sessionId, projectId });
    if (!session || session.claimedBy !== entry.userId) return;
    await db.update('sessions', session.id, { handoffStatus: 'resolved' });
    const visitorWs = visitorSockets.get(session.id);
    if (visitorWs && visitorWs.readyState === visitorWs.OPEN) {
      visitorWs.send(JSON.stringify({ type: 'resolved' }));
    }
    presence.broadcastToProject(projectId, await queueSnapshotPayload(projectId));
    return;
  }

  if (msg.type === 'chat') {
    const text = String(msg.text || '').slice(0, 2000);
    if (!text) return;
    const session = await db.findOne('sessions', { id: msg.sessionId, projectId });
    if (!session || session.handoffStatus !== 'active' || session.claimedBy !== entry.userId) return;
    await db.insert('messages', {
      id: crypto.randomUUID(), sessionId: session.id, projectId, role: 'human', senderId: entry.userId, text, createdAt: Date.now(),
    });
    const visitorWs = visitorSockets.get(session.id);
    if (visitorWs && visitorWs.readyState === visitorWs.OPEN) {
      visitorWs.send(JSON.stringify({ type: 'chat', text, from: 'human', byName: entry.userName }));
    }
  }
}

async function queueSnapshotPayload(projectId) {
  const rows = await db.query(
    `SELECT s.id, s.handoff_status, s.claimed_by, s.handoff_requested_at, u.name AS claimed_by_name,
            (SELECT text FROM messages WHERE session_id = s.id ORDER BY created_at ASC LIMIT 1) AS preview
       FROM sessions s
       LEFT JOIN users u ON u.id = s.claimed_by
      WHERE s.project_id = $1 AND s.handoff_status IN ('requested', 'active')
      ORDER BY s.handoff_requested_at ASC`,
    [projectId]
  );
  return {
    type: 'queue_update',
    pending: rows.filter(r => r.handoffStatus === 'requested').map(r => ({ sessionId: r.id, preview: r.preview, requestedAt: r.handoffRequestedAt })),
    active: rows.filter(r => r.handoffStatus === 'active').map(r => ({ sessionId: r.id, claimedBy: r.claimedBy, claimedByName: r.claimedByName, preview: r.preview })),
  };
}

async function sendQueueSnapshot(projectId, ws) {
  const payload = await queueSnapshotPayload(projectId);
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

module.exports = { attach };
