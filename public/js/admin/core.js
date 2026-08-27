/**
 * Admin panel core — auth, API client, toast/modal helpers, and the tab
 * registry. Separate auth/token from the customer app (public/js/api.js).
 *
 * Each tab module (users.js, tiers.js, audit.js, ...) registers its loader
 * into TABS at the bottom of its own file, so new tabs never require
 * editing this file.
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

  listCharacters: () => adminApiCall('/api/admin/characters'),
  getCharacter: (id) => adminApiCall(`/api/admin/characters/${id}`),
  initCharacterUpload: (data) => adminApiCall('/api/admin/characters/init', { method: 'POST', body: data }),
  completeCharacterUpload: (id, data) => adminApiCall(`/api/admin/characters/${id}/complete`, { method: 'POST', body: data }),
  initCharacterVersion: (id) => adminApiCall(`/api/admin/characters/${id}/versions/init`, { method: 'POST' }),
  completeCharacterVersion: (id, version, data) => adminApiCall(`/api/admin/characters/${id}/versions/${version}/complete`, { method: 'POST', body: data }),
  patchCharacter: (id, patch) => adminApiCall(`/api/admin/characters/${id}`, { method: 'PATCH', body: patch }),
  grantCharacterAccess: (id, userId) => adminApiCall(`/api/admin/characters/${id}/access`, { method: 'POST', body: { userId } }),
  revokeCharacterAccess: (id, userId) => adminApiCall(`/api/admin/characters/${id}/access/${userId}`, { method: 'DELETE' }),
  createCharacterTrigger: (id, data) => adminApiCall(`/api/admin/characters/${id}/triggers`, { method: 'POST', body: data }),
  patchCharacterTrigger: (id, triggerId, patch) => adminApiCall(`/api/admin/characters/${id}/triggers/${triggerId}`, { method: 'PATCH', body: patch }),
  deleteCharacterTrigger: (id, triggerId) => adminApiCall(`/api/admin/characters/${id}/triggers/${triggerId}`, { method: 'DELETE' }),

  listCoupons: () => adminApiCall('/api/admin/coupons'),
  createCoupon: (data) => adminApiCall('/api/admin/coupons', { method: 'POST', body: data }),
  patchCoupon: (id, patch) => adminApiCall(`/api/admin/coupons/${id}`, { method: 'PATCH', body: patch }),
  getCouponRedemptions: (id) => adminApiCall(`/api/admin/coupons/${id}/redemptions`),
};

// Lazy-loaded once — same pattern as public/js/api.js's getSupabaseClient,
// needed for the character-upload flow's direct-to-Storage signed-URL PUT
// (bypassing this server, since Vercel serverless caps request bodies at
// 4.5MB — see backend/routes/adminCharacters.js).
let _adminSupabaseClient = null;
async function getAdminSupabaseClient() {
  if (_adminSupabaseClient) return _adminSupabaseClient;
  const res = await fetch('/api/config');
  const { supabaseUrl, supabaseAnonKey } = await res.json();
  if (!supabaseUrl || !supabaseAnonKey) throw new Error('Storage is not configured on the server');
  _adminSupabaseClient = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
  return _adminSupabaseClient;
}

function adminToast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + (type ? 'toast-' + type : '');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3000);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

// ── Modal helper ─────────────────────────────────────────────
// The .modal-backdrop/.modal CSS already existed but nothing opened one —
// existing screens used native confirm()/prompt(). New screens (character
// upload, coupon create) use this instead.
let modalCloseHandler = null;

function openModal(innerHtml, { onClose } = {}) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true">${innerHtml}</div>
    </div>`;
  root.querySelector('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });
  modalCloseHandler = onClose || null;
  document.addEventListener('keydown', modalEscHandler);
}

function modalEscHandler(e) {
  if (e.key === 'Escape') closeModal();
}

function closeModal() {
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  document.removeEventListener('keydown', modalEscHandler);
  if (modalCloseHandler) { const fn = modalCloseHandler; modalCloseHandler = null; fn(); }
}

// ── Tab registry ─────────────────────────────────────────────
// Populated by each tab module: `TABS.users = loadUsersTab;`
const TABS = {};

function switchTab(name) {
  for (const btn of document.querySelectorAll('.tab-btn')) btn.classList.toggle('active', btn.dataset.tab === name);
  for (const sec of document.querySelectorAll('#admin-view section')) sec.hidden = sec.id !== `tab-${name}`;
  const loader = TABS[name];
  if (loader) loader();
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
