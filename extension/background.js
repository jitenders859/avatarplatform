/**
 * Background service worker — the extension's entire brain. Holds one
 * WebSocket per eligible project against the SAME /ws/dashboard/:projectId
 * protocol the web dashboard's Live Chat tab uses (see backend/ws/handoff.js
 * and public/project.html's "Live Chat tab" section) rather than a separate
 * REST fan-out API — that WS protocol already exists, is tested, and a
 * connected socket already IS the "has availability" presence signal
 * server-side, so a second parallel channel would just be more surface
 * area for no benefit.
 *
 * MV3 service workers are non-persistent and Chrome may terminate this one
 * after ~30s idle — but Chrome 116+ keeps a service worker alive while it
 * holds an open WebSocket (https://developer.chrome.com/blog/longer-esw-lifetimes),
 * and a periodic alarm (see ALARM_NAME below) re-establishes any connection
 * that got dropped by a worker restart, OS sleep, or a network blip.
 */

const ALARM_NAME = 'handoff-reconnect-sweep';
const ALARM_PERIOD_MINUTES = 5;
const MAX_RECONNECT_ATTEMPTS = 5;
const INELIGIBLE_RETRY_MS = 30 * 60 * 1000; // don't hammer a non-business-plan project

// projectId -> { ws, project, pendingIds: Set<string>, pendingCount, activeCount,
//                reconnectAttempts, lastAttemptAt, everConnected }
const connections = new Map();

function apiUrl(path) {
  return `${state.serverUrl.replace(/\/$/, '')}${path}`;
}

function wsUrl(path) {
  const proto = state.serverUrl.startsWith('https:') ? 'wss' : 'ws';
  const host = state.serverUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `${proto}://${host}${path}`;
}

// In-memory mirror of chrome.storage.local's 'auth' key — reloaded on every
// service worker cold start via init() before anything else runs.
const state = {
  serverUrl: null,
  token: null,
  user: null,
};

async function loadState() {
  const { auth } = await chrome.storage.local.get('auth');
  if (auth) {
    state.serverUrl = auth.serverUrl;
    state.token = auth.token;
    state.user = auth.user;
  }
}

async function saveState() {
  await chrome.storage.local.set({
    auth: { serverUrl: state.serverUrl, token: state.token, user: state.user },
  });
}

function isLoggedIn() {
  return !!(state.serverUrl && state.token);
}

async function login(serverUrl, email, password) {
  const base = serverUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Login failed (${res.status})`);

  state.serverUrl = base;
  state.token = data.token;
  state.user = data.user || null;
  await saveState();
  await connectAll();
  return state.user;
}

async function logout() {
  for (const projectId of connections.keys()) disconnectProject(projectId);
  state.serverUrl = null;
  state.token = null;
  state.user = null;
  await chrome.storage.local.remove(['auth', 'projects']);
  await updateBadge();
}

/** Every project this account owns or is a member of. Ineligible (non-
 * business-plan) projects are not filtered out here — the WS upgrade itself
 * is the authority on eligibility (see backend/ws/handoff.js
 * handleDashboardUpgrade), so we just attempt every project and quietly
 * stop retrying the ones that get rejected. */
async function fetchProjects() {
  const res = await fetch(apiUrl('/api/projects'), {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (res.status === 401) throw new Error('unauthorized');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Failed to load projects (${res.status})`);
  const projects = (data.projects || []).map(p => ({ id: p.id, name: p.name }));
  await chrome.storage.local.set({ projects });
  return projects;
}

function disconnectProject(projectId) {
  const entry = connections.get(projectId);
  if (!entry) return;
  if (entry.ws) {
    entry.ws.onclose = null; // don't trigger the reconnect path on a deliberate close
    try { entry.ws.close(); } catch { /* already closed */ }
  }
  connections.delete(projectId);
}

function connectProject(project) {
  if (!isLoggedIn()) return;
  const existing = connections.get(project.id);
  if (existing && existing.ws && (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)) return;

  const entry = existing || {
    ws: null, project, pendingIds: new Set(), pendingCount: 0, activeCount: 0,
    reconnectAttempts: 0, lastAttemptAt: 0, everConnected: false,
  };
  entry.project = project;
  entry.lastAttemptAt = Date.now();
  connections.set(project.id, entry);

  let gotMessage = false;
  const ws = new WebSocket(wsUrl(`/ws/dashboard/${project.id}?token=${encodeURIComponent(state.token)}`));
  entry.ws = ws;

  ws.onmessage = (ev) => {
    gotMessage = true;
    entry.everConnected = true;
    entry.reconnectAttempts = 0;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'queue_update') handleQueueUpdate(project, entry, msg);
  };

  ws.onclose = () => {
    // A close within a couple seconds with no message at all almost always
    // means the upgrade was rejected (wrong/expired token, or the project's
    // owner isn't on the business plan) rather than a transient network
    // drop — back off hard on that project instead of hot-looping reconnects
    // against a project that will never succeed.
    const rejectedImmediately = !gotMessage && !entry.everConnected;
    entry.ws = null;
    if (!connections.has(project.id)) return; // disconnectProject() already cleaned this up

    if (rejectedImmediately) {
      setTimeout(() => connectProject(project), INELIGIBLE_RETRY_MS);
      return;
    }
    if (entry.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = Math.min(1000 * 2 ** entry.reconnectAttempts, 30000);
      entry.reconnectAttempts += 1;
      setTimeout(() => connectProject(project), delay);
    }
    // Beyond MAX_RECONNECT_ATTEMPTS we give up until the next periodic sweep
    // (ALARM_NAME) or the popup is opened, either of which calls connectAll().
  };

  ws.onerror = () => { /* onclose always follows onerror for WebSocket — handled there */ };
}

function handleQueueUpdate(project, entry, msg) {
  const pending = msg.pending || [];
  const newIds = new Set(pending.map(p => p.sessionId));

  for (const p of pending) {
    if (!entry.pendingIds.has(p.sessionId)) {
      notifyNewHandoff(project, p);
    }
  }
  entry.pendingIds = newIds;
  entry.pendingCount = pending.length;
  entry.activeCount = (msg.active || []).length;
  updateBadge();
}

function notifyNewHandoff(project, pendingItem) {
  chrome.notifications.create(`handoff:${project.id}:${pendingItem.sessionId}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `${project.name}: a visitor wants a human`,
    message: pendingItem.preview ? pendingItem.preview.slice(0, 150) : 'Open Live Chat to see the conversation.',
    priority: 2,
  });
}

async function updateBadge() {
  let total = 0;
  for (const entry of connections.values()) total += entry.pendingCount;
  await chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#e0563f' });
}

async function connectAll() {
  if (!isLoggedIn()) return;
  let projects;
  try {
    projects = await fetchProjects();
  } catch (e) {
    if (e.message === 'unauthorized') await logout();
    return;
  }
  const liveIds = new Set(projects.map(p => p.id));
  for (const projectId of [...connections.keys()]) {
    if (!liveIds.has(projectId)) disconnectProject(projectId);
  }
  for (const project of projects) connectProject(project);
}

function statusSnapshot() {
  return {
    loggedIn: isLoggedIn(),
    serverUrl: state.serverUrl,
    user: state.user,
    projects: [...connections.values()].map(e => ({
      id: e.project.id,
      name: e.project.name,
      connected: !!e.ws && e.ws.readyState === WebSocket.OPEN,
      pendingCount: e.pendingCount,
      activeCount: e.activeCount,
    })),
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'login') {
        const user = await login(msg.serverUrl, msg.email, msg.password);
        sendResponse({ ok: true, user });
      } else if (msg.type === 'logout') {
        await logout();
        sendResponse({ ok: true });
      } else if (msg.type === 'getStatus') {
        if (isLoggedIn() && connections.size === 0) await connectAll();
        sendResponse({ ok: true, status: statusSnapshot() });
      } else if (msg.type === 'refresh') {
        await connectAll();
        sendResponse({ ok: true, status: statusSnapshot() });
      } else {
        sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep the message channel open for the async response above
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const [, projectId] = notificationId.split(':');
  if (!state.serverUrl || !projectId) return;
  chrome.tabs.create({ url: `${state.serverUrl}/project?id=${encodeURIComponent(projectId)}&tab=livechat` });
  chrome.notifications.clear(notificationId);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) connectAll();
});

async function init() {
  await loadState();
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  if (isLoggedIn()) await connectAll();
}

chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);
init();
