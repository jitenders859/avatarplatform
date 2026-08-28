/**
 * In-memory registry of live dashboard WebSocket connections, keyed by
 * project. A project "has availability" exactly when this registry holds
 * at least one entry for it — no separate online/offline flag, no DB
 * heartbeat. Lives only as long as the process, which is fine given the
 * confirmed persistent-Node-process deployment target (see
 * docs/superpowers/specs/2026-08-28-human-handoff-design.md) — a restart
 * drops connections and the dashboard reconnects, re-registering itself.
 */

// projectId -> Set<{ ws, userId, userName }>
const byProject = new Map();

function addDashboardSocket(projectId, entry) {
  if (!byProject.has(projectId)) byProject.set(projectId, new Set());
  byProject.get(projectId).add(entry);
}

function removeDashboardSocket(projectId, entry) {
  const set = byProject.get(projectId);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) byProject.delete(projectId);
}

function hasAvailability(projectId) {
  const set = byProject.get(projectId);
  return !!set && set.size > 0;
}

// Queue/status updates — every connected team member for the project sees these.
function broadcastToProject(projectId, message) {
  const set = byProject.get(projectId);
  if (!set) return;
  const payload = JSON.stringify(message);
  for (const entry of set) {
    if (entry.ws.readyState === entry.ws.OPEN) entry.ws.send(payload);
  }
}

// Actual chat content — only the team member who claimed a session sees
// its messages, not every connected teammate (privacy: an unclaimed
// visitor's words shouldn't leak to someone not handling them).
function sendToUser(projectId, userId, message) {
  const set = byProject.get(projectId);
  if (!set) return false;
  const payload = JSON.stringify(message);
  let delivered = false;
  for (const entry of set) {
    if (entry.userId === userId && entry.ws.readyState === entry.ws.OPEN) {
      entry.ws.send(payload);
      delivered = true;
    }
  }
  return delivered;
}

// Test-only.
function _reset() { byProject.clear(); }

module.exports = { addDashboardSocket, removeDashboardSocket, hasAvailability, broadcastToProject, sendToUser, _reset };
