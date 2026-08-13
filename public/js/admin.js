/**
 * Admin panel — separate auth/token from the customer app (public/js/api.js).
 */
const AdminAuth = {
  get token() { return localStorage.getItem('adminToken'); },
  set token(v) { v ? localStorage.setItem('adminToken', v) : localStorage.removeItem('adminToken'); },
  loggedIn() { return !!this.token; },
  logout() { this.token = null; location.reload(); },
};

async function adminApiCall(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  if (AdminAuth.token) headers['Authorization'] = `Bearer ${AdminAuth.token}`;
  const res = await fetch(path, { ...opts, headers });
  let body; try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) {
    if (res.status === 401) { AdminAuth.logout(); throw new Error('Session expired'); }
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body;
}

const AdminAPI = {
  login: (email, password) => adminApiCall('/api/admin/login', { method: 'POST', body: { email, password } }),
  me: () => adminApiCall('/api/admin/me'),
  listUsers: (search, page) => adminApiCall(`/api/admin/users?search=${encodeURIComponent(search || '')}&page=${page || 1}`),
  getUser: (id) => adminApiCall(`/api/admin/users/${id}`),
  patchUser: (id, patch) => adminApiCall(`/api/admin/users/${id}`, { method: 'PATCH', body: patch }),
  deleteUser: (id, confirmEmail) => adminApiCall(`/api/admin/users/${id}`, { method: 'DELETE', body: { confirmEmail } }),
  impersonate: (id) => adminApiCall(`/api/admin/users/${id}/impersonate`, { method: 'POST' }),
  listTiers: () => adminApiCall('/api/admin/tiers'),
  createTier: (data) => adminApiCall('/api/admin/tiers', { method: 'POST', body: data }),
  updateTier: (id, data) => adminApiCall(`/api/admin/tiers/${id}`, { method: 'PATCH', body: data }),
  deleteTier: (id) => adminApiCall(`/api/admin/tiers/${id}`, { method: 'DELETE' }),
  auditLog: (page) => adminApiCall(`/api/admin/audit-log?page=${page || 1}`),
};

function adminToast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + (type ? 'toast-' + type : '');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3000);
}

function formatNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function switchTab(name) {
  for (const btn of document.querySelectorAll('.tab-btn')) btn.classList.toggle('active', btn.dataset.tab === name);
  for (const sec of document.querySelectorAll('#admin-view section')) sec.hidden = sec.id !== `tab-${name}`;
  if (name === 'users') loadUsersTab();
  if (name === 'tiers') loadTiersTab();
  if (name === 'audit') loadAuditTab();
}

async function boot() {
  if (!AdminAuth.loggedIn()) return;
  try {
    const { admin } = await AdminAPI.me();
    document.getElementById('login-view').hidden = true;
    document.getElementById('admin-view').hidden = false;
    document.getElementById('admin-whoami').textContent = `Signed in as ${admin.email}`;
    switchTab('users');
  } catch {
    // adminApiCall already logged out on 401
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  try {
    const { token } = await AdminAPI.login(email, password);
    AdminAuth.token = token;
    boot();
  } catch (err) {
    adminToast(err.message, 'error');
  }
});

document.getElementById('logout-btn').addEventListener('click', () => AdminAuth.logout());

for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}

boot();

// ── Users tab ─────────────────────────────────────────────────
let usersSearchTimer = null;

async function loadUsersTab() {
  const section = document.getElementById('tab-users');
  section.innerHTML = `
    <div class="row gap-sm mb-md">
      <input type="text" id="users-search" placeholder="Search by email or name…" class="input" style="max-width:320px" />
    </div>
    <div id="users-table"></div>
    <div id="user-detail" class="card mt-lg" hidden></div>
  `;
  document.getElementById('users-search').addEventListener('input', (e) => {
    clearTimeout(usersSearchTimer);
    usersSearchTimer = setTimeout(() => renderUsersTable(e.target.value), 300);
  });
  await renderUsersTable('');
}

async function renderUsersTable(search) {
  const { users } = await AdminAPI.listUsers(search, 1);
  const rows = users.map(u => `
    <tr class="user-row" data-id="${u.id}" style="cursor:pointer">
      <td>${u.email}</td>
      <td>${u.name || ''}</td>
      <td><span class="pill ${u.planSource === 'admin' ? 'pill-warn' : 'pill-info'}">${u.planId} (${u.planSource})</span></td>
      <td>${u.suspended ? '<span class="pill pill-danger">Suspended</span>' : ''}</td>
      <td>${new Date(u.createdAt).toLocaleDateString()}</td>
    </tr>`).join('');
  document.getElementById('users-table').innerHTML = `
    <table class="table">
      <thead><tr><th>Email</th><th>Name</th><th>Plan</th><th>Status</th><th>Joined</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No users found</td></tr>'}</tbody>
    </table>`;
  for (const row of document.querySelectorAll('.user-row')) {
    row.addEventListener('click', () => renderUserDetail(row.dataset.id));
  }
}

async function renderUserDetail(userId) {
  const { user, usage, projects } = await AdminAPI.getUser(userId);
  const { tiers } = await AdminAPI.listTiers();
  const c = usage.counters, l = usage.limits;
  const items = [
    { label: 'Chatbots', current: c.projects, limit: l.projects, unit: '' },
    { label: 'Files (across all)', current: c.files, limit: l.filesPerProject, unit: '' },
    { label: 'Storage', current: c.storageMb, limit: l.storageMb, unit: ' MB' },
    { label: 'URL sources', current: c.urlSources, limit: l.urlSources, unit: '' },
    { label: 'Messages this month', current: c.messages, limit: l.monthlyMessages, unit: '' },
    { label: 'Embedding chars', current: c.embeddingChars, limit: l.monthlyEmbeddingChars, unit: '' },
  ];
  const bars = items.map(i => {
    const pct = Math.min(100, Math.round((i.current / Math.max(1, i.limit)) * 100));
    const color = pct >= 90 ? 'background:#ef4444' : pct >= 70 ? 'background:#f59e0b' : 'background:linear-gradient(90deg,var(--accent),var(--accent-2))';
    return `<div>
      <div class="row" style="justify-content:space-between;margin-bottom:6px">
        <span class="text-sm">${i.label}</span>
        <span class="muted text-sm">${formatNum(i.current)}${i.unit} / ${formatNum(i.limit)}${i.unit}</span>
      </div>
      <div style="height:8px;background:var(--bg-3);border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${pct}%;${color};transition:width .4s"></div>
      </div>
    </div>`;
  }).join('');

  const tierOptions = [`<option value="">None (use plan)</option>`]
    .concat(tiers.map(t => `<option value="${t.id}" ${t.id === user.adminPlanId ? 'selected' : ''}>${t.name}</option>`))
    .join('');

  const projectRows = projects.map(p => `<tr><td>${p.name}</td><td>${p.characterId}</td><td>${p.fileCount}</td><td>${new Date(p.createdAt).toLocaleDateString()}</td></tr>`).join('');

  const detail = document.getElementById('user-detail');
  detail.hidden = false;
  detail.innerHTML = `
    <div class="card-header"><h2 class="card-title">${user.email}</h2></div>
    <div class="col gap-md">${bars}</div>
    <div class="row gap-sm mt-lg" style="align-items:center">
      <label class="text-sm">Custom tier:</label>
      <select id="tier-select" class="input" style="max-width:220px">${tierOptions}</select>
      <button class="btn btn-ghost" id="suspend-toggle-btn">${user.suspended ? 'Unsuspend' : 'Suspend'}</button>
      <button class="btn btn-ghost" id="impersonate-btn">View as user</button>
      <button class="btn btn-ghost" id="delete-user-btn" style="color:var(--danger)">Delete account</button>
    </div>
    <h3 style="font-size:15px;margin:20px 0 10px">Projects (read-only)</h3>
    <table class="table">
      <thead><tr><th>Name</th><th>Character</th><th>Files</th><th>Created</th></tr></thead>
      <tbody>${projectRows || '<tr><td colspan="4" class="muted">No projects</td></tr>'}</tbody>
    </table>
  `;

  document.getElementById('tier-select').addEventListener('change', async (e) => {
    try {
      await AdminAPI.patchUser(userId, { adminPlanId: e.target.value || null });
      adminToast('Tier updated', 'success');
      renderUserDetail(userId);
      renderUsersTable(document.getElementById('users-search').value);
    } catch (err) { adminToast(err.message, 'error'); }
  });

  document.getElementById('suspend-toggle-btn').addEventListener('click', async () => {
    try {
      await AdminAPI.patchUser(userId, { suspended: !user.suspended });
      adminToast(user.suspended ? 'User unsuspended' : 'User suspended', 'success');
      renderUserDetail(userId);
      renderUsersTable(document.getElementById('users-search').value);
    } catch (err) { adminToast(err.message, 'error'); }
  });

  document.getElementById('impersonate-btn').addEventListener('click', async () => {
    try {
      const { token } = await AdminAPI.impersonate(userId);
      window.open(`/dashboard#imp=${encodeURIComponent(token)}`, '_blank');
    } catch (err) { adminToast(err.message, 'error'); }
  });

  document.getElementById('delete-user-btn').addEventListener('click', async () => {
    const typed = prompt(`This permanently deletes ${user.email} and all of their data. Type their email to confirm.`);
    if (typed === null) return;
    if (typed !== user.email) { adminToast('Email did not match — nothing deleted', 'error'); return; }
    try {
      await AdminAPI.deleteUser(userId, typed);
      adminToast('User deleted', 'success');
      detail.hidden = true;
      renderUsersTable(document.getElementById('users-search').value);
    } catch (err) { adminToast(err.message, 'error'); }
  });
}

// ── Tiers tab ─────────────────────────────────────────────────
async function loadTiersTab() {
  const section = document.getElementById('tab-tiers');
  section.innerHTML = `
    <div class="card mb-lg">
      <div class="card-header"><h2 class="card-title">Create tier</h2></div>
      <form id="tier-form" class="col gap-sm">
        <input type="text" id="tier-name" placeholder="Tier name (e.g. Acme Corp bump)" required class="input" />
        <div class="row gap-sm" style="flex-wrap:wrap">
          ${['projects', 'filesPerProject', 'storageMb', 'monthlyMessages', 'monthlyEmbeddingChars', 'urlSources']
            .map(f => `<input type="number" min="1" name="${f}" placeholder="${f}" required class="input" style="max-width:180px" />`).join('')}
        </div>
        <button type="submit" class="btn btn-primary" style="align-self:flex-start">Create tier</button>
      </form>
    </div>
    <div id="tiers-table"></div>
  `;
  document.getElementById('tier-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const limits = {};
    for (const f of ['projects', 'filesPerProject', 'storageMb', 'monthlyMessages', 'monthlyEmbeddingChars', 'urlSources']) {
      limits[f] = parseInt(fd.get(f), 10);
    }
    try {
      await AdminAPI.createTier({ name: document.getElementById('tier-name').value, limits });
      adminToast('Tier created', 'success');
      e.target.reset();
      renderTiersTable();
    } catch (err) { adminToast(err.message, 'error'); }
  });
  await renderTiersTable();
}

async function renderTiersTable() {
  const { tiers } = await AdminAPI.listTiers();
  const rows = tiers.map(t => `
    <tr>
      <td>${t.name}</td>
      <td class="muted text-sm">${t.id}</td>
      <td class="text-sm">${Object.entries(t.limits).map(([k, v]) => `${k}: ${formatNum(v)}`).join(', ')}</td>
      <td><button class="btn btn-ghost text-sm" data-delete-tier="${t.id}" style="color:var(--danger)">Delete</button></td>
    </tr>`).join('');
  document.getElementById('tiers-table').innerHTML = `
    <table class="table">
      <thead><tr><th>Name</th><th>ID</th><th>Limits</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">No custom tiers yet</td></tr>'}</tbody>
    </table>`;
  for (const btn of document.querySelectorAll('[data-delete-tier]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this tier?')) return;
      try {
        await AdminAPI.deleteTier(btn.dataset.deleteTier);
        adminToast('Tier deleted', 'success');
        renderTiersTable();
      } catch (err) { adminToast(err.message, 'error'); }
    });
  }
}

// ── Audit Log tab ────────────────────────────────────────────
async function loadAuditTab() {
  const section = document.getElementById('tab-audit');
  const { entries } = await AdminAPI.auditLog(1);
  const rows = entries.map(e => `
    <tr>
      <td class="text-sm">${new Date(e.createdAt).toLocaleString()}</td>
      <td class="text-sm">${e.adminEmail || e.adminId}</td>
      <td><span class="pill pill-info">${e.action}</span></td>
      <td class="text-sm">${e.targetEmail || ''}</td>
      <td class="muted text-sm">${e.meta ? JSON.stringify(e.meta) : ''}</td>
    </tr>`).join('');
  section.innerHTML = `
    <table class="table">
      <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target user</th><th>Details</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No admin actions yet</td></tr>'}</tbody>
    </table>`;
}
