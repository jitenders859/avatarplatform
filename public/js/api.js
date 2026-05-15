/**
 * Frontend API helpers + auth state + shared layout.
 * Loaded by every authenticated page.
 */
const Auth = {
  get token() { return localStorage.getItem('apToken'); },
  set token(v) { v ? localStorage.setItem('apToken', v) : localStorage.removeItem('apToken'); },
  get user() {
    try { return JSON.parse(localStorage.getItem('apUser') || 'null'); } catch { return null; }
  },
  set user(u) { u ? localStorage.setItem('apUser', JSON.stringify(u)) : localStorage.removeItem('apUser'); },
  loggedIn() { return !!this.token; },
  logout() { this.token = null; this.user = null; location.href = '/login'; },
  requireLogin() { if (!this.loggedIn()) location.href = '/login'; },
};

async function apiCall(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (!(opts.body instanceof FormData) && opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  if (Auth.token) headers['Authorization'] = `Bearer ${Auth.token}`;
  const res = await fetch(path, { ...opts, headers });
  let body;
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) {
    if (res.status === 401) { Auth.logout(); throw new Error('Session expired'); }
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body;
}

const API = {
  // Auth
  signup:         (email, password) => apiCall('/api/auth/signup', { method: 'POST', body: { email, password } }),
  login:          (email, password) => apiCall('/api/auth/login',  { method: 'POST', body: { email, password } }),
  me:             () => apiCall('/api/auth/me'),
  updateMe:       (patch) => apiCall('/api/auth/me', { method: 'PATCH', body: patch }),
  deleteMe:       () => apiCall('/api/auth/me', { method: 'DELETE' }),
  forgotPassword: (email) => apiCall('/api/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword:  (token, newPassword) => apiCall('/api/auth/reset-password', { method: 'POST', body: { token, newPassword } }),

  // Projects
  characters:    () => apiCall('/api/projects/characters'),
  listProjects:  () => apiCall('/api/projects'),
  createProject: (data) => apiCall('/api/projects', { method: 'POST', body: data }),
  getProject:    (id)   => apiCall(`/api/projects/${id}`),
  updateProject: (id, patch) => apiCall(`/api/projects/${id}`, { method: 'PATCH', body: patch }),
  deleteProject: (id)   => apiCall(`/api/projects/${id}`, { method: 'DELETE' }),

  // Sources
  listFiles: (pid) => apiCall(`/api/projects/${pid}/files`),
  uploadFiles: (pid, formData) => apiCall(`/api/projects/${pid}/files`, { method: 'POST', body: formData }),
  reprocessFile: (pid, fid) => apiCall(`/api/projects/${pid}/files/${fid}/reprocess`, { method: 'POST' }),
  deleteFile:    (pid, fid) => apiCall(`/api/projects/${pid}/files/${fid}`, { method: 'DELETE' }),
  addUrl: (pid, url) => apiCall(`/api/projects/${pid}/sources/url`, { method: 'POST', body: { url } }),
  addUrls: (pid, urls) => apiCall(`/api/projects/${pid}/sources/url`, { method: 'POST', body: { urls } }),
  reindexProject:  (pid) => apiCall(`/api/projects/${pid}/reindex`, { method: 'POST' }),
  duplicateProject:(pid) => apiCall(`/api/projects/${pid}/duplicate`, { method: 'POST' }),
  testWebhook:     (pid) => apiCall(`/api/projects/${pid}/webhook/test`, { method: 'POST' }),
  fileStatus:     (pid, fid) => apiCall(`/api/projects/${pid}/files/${fid}/status`),

  // Conversations
  listSessions:  (pid) => apiCall(`/api/projects/${pid}/sessions`),
  getSession:    (pid, sid) => apiCall(`/api/projects/${pid}/sessions/${sid}`),

  // Capture fields
  listCaptureFields:   (pid) => apiCall(`/api/projects/${pid}/capture`),
  createCaptureField:  (pid, data) => apiCall(`/api/projects/${pid}/capture`, { method: 'POST', body: data }),
  updateCaptureField:  (pid, fid, patch) => apiCall(`/api/projects/${pid}/capture/${fid}`, { method: 'PATCH', body: patch }),
  deleteCaptureField:  (pid, fid) => apiCall(`/api/projects/${pid}/capture/${fid}`, { method: 'DELETE' }),
  reorderCaptureFields:(pid, ids) => apiCall(`/api/projects/${pid}/capture/reorder`, { method: 'POST', body: { ids } }),

  // Leads
  listLeads: (pid, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return apiCall(`/api/projects/${pid}/leads${q ? '?' + q : ''}`);
  },
  getLead: (pid, lid) => apiCall(`/api/projects/${pid}/leads/${lid}`),

  // Analytics
  analytics:        () => apiCall('/api/analytics/overview'),
  projectAnalytics: (id) => apiCall(`/api/analytics/project/${id}`),

  // Billing
  plans:               () => apiCall('/api/billing/plans'),
  subscription:        () => apiCall('/api/billing/subscription'),
  usage:               () => apiCall('/api/billing/usage'),
  createCheckout:      (planId) => apiCall('/api/billing/create-checkout-session', { method: 'POST', body: { planId } }),
  createPortalSession: () => apiCall('/api/billing/create-portal-session', { method: 'POST' }),

};

// ── Toast ──────────────────────────────────────────────────
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + (type ? 'toast-' + type : '');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ── Top nav (rendered on every authenticated page) ────────
function renderTopNav(active) {
  const user = Auth.user;
  const initial = user ? (user.email || '?')[0].toUpperCase() : '?';
  const links = [
    { id: 'dashboard', label: 'Chatbots', href: '/dashboard' },
    { id: 'analytics', label: 'Analytics', href: '/analytics' },
    { id: 'billing', label: 'Billing', href: '/billing' },
  ];
  const html = `
    <nav class="topnav">
      <div class="topnav-inner">
        <a class="brand" href="/dashboard">
          <span class="brand-mark">A</span>
          <span>AvatarPlatform</span>
        </a>
        <div class="nav-links">
          ${links.map(l => `<a class="nav-link${l.id === active ? ' active' : ''}" href="${l.href}">${l.label}</a>`).join('')}
        </div>
        <div class="spacer"></div>
        <div class="user-menu-wrap" style="position:relative">
          <div class="user-menu" id="user-menu" style="cursor:pointer;display:flex;align-items:center;gap:8px">
            <span class="user-avatar">${initial}</span>
            <span class="muted text-sm">${user ? user.email : ''}</span>
            <span style="color:var(--text-dim);font-size:10px">▾</span>
          </div>
          <div id="user-dropdown" style="display:none;position:absolute;right:0;top:calc(100% + 8px);background:var(--bg-2);border:1px solid var(--border);border-radius:10px;min-width:160px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.35);overflow:hidden">
            <a href="/account" style="display:block;padding:10px 16px;font-size:13px;color:var(--text);text-decoration:none;border-bottom:1px solid var(--border)">Account settings</a>
            <button id="logout-btn" style="width:100%;text-align:left;padding:10px 16px;font-size:13px;color:#fca5a5;background:none;border:none;cursor:pointer">Log out</button>
          </div>
        </div>
      </div>
    </nav>
  `;
  document.body.insertAdjacentHTML('afterbegin', html);

  const menu = document.getElementById('user-menu');
  const dropdown = document.getElementById('user-dropdown');
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', () => { dropdown.style.display = 'none'; });
  document.getElementById('logout-btn').addEventListener('click', () => Auth.logout());
}
