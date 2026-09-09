function sendToBackground(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

const loginView = document.getElementById('login-view');
const statusView = document.getElementById('status-view');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const serverUrlInput = document.getElementById('server-url');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');

function renderStatus(status) {
  if (!status.loggedIn) {
    loginView.hidden = false;
    statusView.hidden = true;
    return;
  }
  loginView.hidden = true;
  statusView.hidden = false;
  document.getElementById('user-email').textContent = status.user?.email || '';

  const list = document.getElementById('projects-list');
  if (status.projects.length === 0) {
    list.innerHTML = '<div class="empty muted">No chatbots on this account yet.</div>';
  } else {
    list.innerHTML = status.projects.map(p => `
      <div class="row">
        <span class="dot ${p.connected ? 'on' : ''}" title="${p.connected ? 'Live' : 'Not connected — needs the business plan, or still reconnecting'}"></span>
        <span class="name">${escapeHtml(p.name)}</span>
        ${p.pendingCount > 0 ? `<span class="pill">${p.pendingCount}</span>` : ''}
      </div>
    `).join('');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refresh() {
  const res = await sendToBackground({ type: 'getStatus' });
  if (res && res.ok) renderStatus(res.status);
}

loginBtn.addEventListener('click', async () => {
  const serverUrl = serverUrlInput.value.trim();
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  loginError.textContent = '';
  if (!serverUrl || !email || !password) {
    loginError.textContent = 'All fields are required.';
    return;
  }
  loginBtn.disabled = true;
  loginBtn.textContent = 'Logging in…';
  const res = await sendToBackground({ type: 'login', serverUrl, email, password });
  loginBtn.disabled = false;
  loginBtn.textContent = 'Log in';
  if (!res || !res.ok) {
    loginError.textContent = (res && res.error) || 'Login failed.';
    return;
  }
  chrome.storage.local.set({ lastServerUrl: serverUrl });
  await refresh();
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await sendToBackground({ type: 'logout' });
  await refresh();
});

document.getElementById('refresh-btn').addEventListener('click', async () => {
  const res = await sendToBackground({ type: 'refresh' });
  if (res && res.ok) renderStatus(res.status);
});

document.getElementById('open-dashboard-btn').addEventListener('click', async () => {
  const res = await sendToBackground({ type: 'getStatus' });
  const serverUrl = res && res.status && res.status.serverUrl;
  if (serverUrl) chrome.tabs.create({ url: `${serverUrl}/dashboard` });
});

(async () => {
  const { lastServerUrl } = await chrome.storage.local.get('lastServerUrl');
  if (lastServerUrl) serverUrlInput.value = lastServerUrl;
  await refresh();
})();
