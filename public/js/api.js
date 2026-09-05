/**
 * Frontend API helpers + auth state + shared layout.
 * Loaded by every authenticated page.
 */
// Admin "View as user" opens /dashboard#imp=<token> in a new tab — pick up
// the impersonation token into the normal session key and scrub the URL so
// it doesn't linger in history/address bar.
if (location.hash.startsWith('#imp=')) {
  localStorage.setItem('apToken', decodeURIComponent(location.hash.slice(5)));
  history.replaceState(null, '', location.pathname);
}

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
  const hadToken = !!Auth.token;
  if (hadToken) headers['Authorization'] = `Bearer ${Auth.token}`;
  const res = await fetch(path, { ...opts, headers });
  let body;
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) {
    // A 401 on a request that never carried a token — most importantly a
    // failed login/signup attempt — means "invalid credentials", not "your
    // session expired". Auth.logout()'s location.href='/login' used to
    // fire either way, navigating away (on the login page itself, this
    // looked like the page silently resetting) before the real "wrong
    // password" message from the catch handler could ever be shown.
    if (res.status === 401 && hadToken) { Auth.logout(); throw new Error('Session expired'); }
    const err = new Error(body.error || `Request failed (${res.status})`);
    if (body.code) err.code = body.code;
    throw err;
  }
  return body;
}

// Uploads go straight from the browser to Supabase Storage via a signed URL
// (see /api/projects/:id/files/init) rather than through this server —
// Vercel serverless functions cap request bodies at 4.5MB. Lazily creates
// one Supabase client using publishable-safe config fetched from the server
// (public/project.html loads the Supabase JS CDN script before api.js runs).
let _supabaseClient = null;
async function getSupabaseClient() {
  if (_supabaseClient) return _supabaseClient;
  const { supabaseUrl, supabaseAnonKey } = await apiCall('/api/config');
  if (!supabaseUrl || !supabaseAnonKey) throw new Error('File storage is not configured on the server');
  _supabaseClient = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
  return _supabaseClient;
}

const API = {
  // Auth
  signup:         (name, email, password) => apiCall('/api/auth/signup', { method: 'POST', body: { name, email, password } }),
  login:          (email, password) => apiCall('/api/auth/login',  { method: 'POST', body: { email, password } }),
  me:             () => apiCall('/api/auth/me'),
  updateMe:       (patch) => apiCall('/api/auth/me', { method: 'PATCH', body: patch }),
  deleteMe:       () => apiCall('/api/auth/me', { method: 'DELETE' }),
  forgotPassword: (email) => apiCall('/api/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword:  (token, newPassword) => apiCall('/api/auth/reset-password', { method: 'POST', body: { token, newPassword } }),
  verifyEmail:        (token) => apiCall('/api/auth/verify-email', { method: 'POST', body: { token } }),
  resendVerification: () => apiCall('/api/auth/resend-verification', { method: 'POST' }),

  // Projects
  characters:    () => apiCall('/api/projects/characters'),
  listProjects:  (categoryId) => apiCall(`/api/projects${categoryId ? `?categoryId=${encodeURIComponent(categoryId)}` : ''}`),
  createProject: (data) => apiCall('/api/projects', { method: 'POST', body: data }),
  getProject:    (id)   => apiCall(`/api/projects/${id}`),
  updateProject: (id, patch) => apiCall(`/api/projects/${id}`, { method: 'PATCH', body: patch }),
  deleteProject: (id)   => apiCall(`/api/projects/${id}`, { method: 'DELETE' }),

  // Chatbot categories
  listCategories:  () => apiCall('/api/categories'),
  createCategory:  (data) => apiCall('/api/categories', { method: 'POST', body: data }),
  updateCategory:  (id, patch) => apiCall(`/api/categories/${id}`, { method: 'PATCH', body: patch }),
  deleteCategory:  (id) => apiCall(`/api/categories/${id}`, { method: 'DELETE' }),
  assignChatbotsToCategory: (id, projectIds) => apiCall(`/api/categories/${id}/chatbots`, { method: 'POST', body: { projectIds } }),
  removeChatbotFromCategory: (id, projectId) => apiCall(`/api/categories/${id}/chatbots/${projectId}`, { method: 'DELETE' }),

  // Sources
  listFiles: (pid) => apiCall(`/api/projects/${pid}/files`),
  // files: a FileList/array of File objects (not FormData) — each is
  // uploaded directly to Supabase Storage via a signed URL, not proxied
  // through this server. Returns { files: [...] } shaped like the old
  // multipart response (rejected entries included) so callers don't change.
  uploadFiles: async (pid, files) => {
    const fileArr = Array.from(files);
    if (!fileArr.length) return { files: [] };
    const { files: initFiles } = await apiCall(`/api/projects/${pid}/files/init`, {
      method: 'POST',
      body: { files: fileArr.map(f => ({ name: f.name, size: f.size, mimeType: f.type })) },
    });
    const results = [];
    for (let i = 0; i < initFiles.length; i++) {
      const meta = initFiles[i];
      if (meta.status === 'rejected') { results.push(meta); continue; }
      try {
        const supabase = await getSupabaseClient();
        const { error } = await supabase.storage.from('uploads').uploadToSignedUrl(meta.storageKey, meta.uploadToken, fileArr[i]);
        if (error) throw error;
        await apiCall(`/api/projects/${pid}/files/${meta.id}/complete`, { method: 'POST' });
        results.push(meta);
      } catch (err) {
        results.push({ ...meta, status: 'rejected', error: err.message || 'Upload failed' });
      }
    }
    return { files: results };
  },
  reprocessFile: (pid, fid) => apiCall(`/api/projects/${pid}/files/${fid}/reprocess`, { method: 'POST' }),
  deleteFile:    (pid, fid) => apiCall(`/api/projects/${pid}/files/${fid}`, { method: 'DELETE' }),
  addUrls: (pid, urls) => apiCall(`/api/projects/${pid}/sources/url`, { method: 'POST', body: { urls } }),
  reindexProject:  (pid) => apiCall(`/api/projects/${pid}/reindex`, { method: 'POST' }),
  duplicateProject:(pid) => apiCall(`/api/projects/${pid}/duplicate`, { method: 'POST' }),
  testWebhook:     (pid) => apiCall(`/api/projects/${pid}/webhook/test`, { method: 'POST' }),
  webhookDeliveries: (pid) => apiCall(`/api/projects/${pid}/webhook/deliveries`),
  rotateWebhookSecret: (pid) => apiCall(`/api/projects/${pid}/webhook/rotate-secret`, { method: 'POST' }),
  fileStatus:     (pid, fid) => apiCall(`/api/projects/${pid}/files/${fid}/status`),

  // Conversations
  listSessions:  (pid) => apiCall(`/api/projects/${pid}/sessions`),
  getSession:    (pid, sid) => apiCall(`/api/projects/${pid}/sessions/${sid}`),
  replySession:  (pid, sid, text) => apiCall(`/api/projects/${pid}/sessions/${sid}/reply`, { method: 'POST', body: { text } }),
  listActions:   (pid) => apiCall(`/api/projects/${pid}/actions`),
  createAction:  (pid, body) => apiCall(`/api/projects/${pid}/actions`, { method: 'POST', body }),
  patchAction:   (pid, aid, body) => apiCall(`/api/projects/${pid}/actions/${aid}`, { method: 'PATCH', body }),
  deleteAction:  (pid, aid) => apiCall(`/api/projects/${pid}/actions/${aid}`, { method: 'DELETE' }),
  cloneVoice:    (pid, formData) => apiCall(`/api/projects/${pid}/voice-clone`, { method: 'POST', body: formData }),

  // Team members
  listMembers:   (pid) => apiCall(`/api/projects/${pid}/members`),
  inviteMember:  (pid, email) => apiCall(`/api/projects/${pid}/members`, { method: 'POST', body: { email } }),
  removeMember:  (pid, memberId) => apiCall(`/api/projects/${pid}/members/${memberId}`, { method: 'DELETE' }),

  // Capture fields
  listCaptureFields:   (pid) => apiCall(`/api/projects/${pid}/capture`),
  createCaptureField:  (pid, data) => apiCall(`/api/projects/${pid}/capture`, { method: 'POST', body: data }),
  updateCaptureField:  (pid, fid, patch) => apiCall(`/api/projects/${pid}/capture/${fid}`, { method: 'PATCH', body: patch }),
  deleteCaptureField:  (pid, fid) => apiCall(`/api/projects/${pid}/capture/${fid}`, { method: 'DELETE' }),
  reorderCaptureFields:(pid, ids) => apiCall(`/api/projects/${pid}/capture/reorder`, { method: 'POST', body: { ids } }),

  // Quiz questions
  listQuizQuestions:  (pid) => apiCall(`/api/projects/${pid}/quiz-questions`),
  createQuizQuestion: (pid, data) => apiCall(`/api/projects/${pid}/quiz-questions`, { method: 'POST', body: data }),
  updateQuizQuestion: (pid, qid, patch) => apiCall(`/api/projects/${pid}/quiz-questions/${qid}`, { method: 'PATCH', body: patch }),
  deleteQuizQuestion: (pid, qid) => apiCall(`/api/projects/${pid}/quiz-questions/${qid}`, { method: 'DELETE' }),
  suggestDistractors: (pid, question, correctAnswer) => apiCall(`/api/projects/${pid}/quiz-questions/suggest-distractors`, { method: 'POST', body: { question, correctAnswer } }),
  importQuizCsv: (pid, file) => { const fd = new FormData(); fd.append('file', file); return apiCall(`/api/projects/${pid}/quiz-questions/import-csv`, { method: 'POST', body: fd }); },

  // Flashcards
  listFlashcards:  (pid) => apiCall(`/api/projects/${pid}/flashcards`),
  createFlashcard: (pid, data) => apiCall(`/api/projects/${pid}/flashcards`, { method: 'POST', body: data }),
  deleteFlashcard: (pid, cid) => apiCall(`/api/projects/${pid}/flashcards/${cid}`, { method: 'DELETE' }),
  importFlashcardsCsv: (pid, file) => { const fd = new FormData(); fd.append('file', file); return apiCall(`/api/projects/${pid}/flashcards/import-csv`, { method: 'POST', body: fd }); },

  // Video resources
  listVideoResources:  (pid) => apiCall(`/api/projects/${pid}/video-resources`),
  createVideoResource: (pid, data) => apiCall(`/api/projects/${pid}/video-resources`, { method: 'POST', body: data }),
  deleteVideoResource: (pid, vid) => apiCall(`/api/projects/${pid}/video-resources/${vid}`, { method: 'DELETE' }),

  // Leads
  listLeads: (pid, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return apiCall(`/api/projects/${pid}/leads${q ? '?' + q : ''}`);
  },
  getLead: (pid, lid) => apiCall(`/api/projects/${pid}/leads/${lid}`),

  // Chunks
  listChunks:  (pid, fid, search) => apiCall(`/api/projects/${pid}/files/${fid}/chunks${search ? '?search=' + encodeURIComponent(search) : ''}`),
  deleteChunk: (pid, fid, cid) => apiCall(`/api/projects/${pid}/files/${fid}/chunks/${cid}`, { method: 'DELETE' }),

  // Analytics
  analytics:        () => apiCall('/api/analytics/overview'),
  projectAnalytics: (id) => apiCall(`/api/analytics/project/${id}`),
  projectProgress:  (id) => apiCall(`/api/analytics/project/${id}/progress`),

  // Billing
  plans:               () => apiCall('/api/billing/plans'),
  subscription:        () => apiCall('/api/billing/subscription'),
  usage:               () => apiCall('/api/billing/usage'),
  createCheckout:      (planId, couponCode) => apiCall('/api/billing/create-checkout-session', { method: 'POST', body: { planId, couponCode: couponCode || undefined } }),
  createPortalSession: () => apiCall('/api/billing/create-portal-session', { method: 'POST' }),
  validateCoupon:      (code, planId) => apiCall('/api/billing/validate-coupon', { method: 'POST', body: { code, planId } }),

};

// ── Toast ──────────────────────────────────────────────────
// See public/js/toast.js — must be loaded before this file.
const toast = showToast;

// ── Top nav (rendered on every authenticated page) ────────
function renderTopNav(active) {
  const user = Auth.user;
  const initial = user ? (user.email || '?')[0].toUpperCase() : '?';
  const links = [
    { id: 'dashboard', label: 'Chatbots', href: '/dashboard' },
    { id: 'analytics', label: 'Analytics', href: '/analytics' },
    { id: 'billing', label: 'Billing', href: '/billing' },
    { id: 'docs', label: 'Docs', href: '/docs' },
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
        <div id="theme-toggle-slot"></div>
        <div class="user-menu-wrap" style="position:relative">
          <div class="user-menu" id="user-menu" style="cursor:pointer;display:flex;align-items:center;gap:8px">
            <span class="user-avatar">${initial}</span>
            <span class="muted text-sm">${user ? user.email : ''}</span>
            <span style="color:var(--text-dim);font-size:10px">▾</span>
          </div>
          <div id="user-dropdown" style="display:none;position:absolute;right:0;top:calc(100% + 8px);background:var(--bg-2);border:1px solid var(--border);border-radius:10px;min-width:160px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.35);overflow:hidden">
            <a href="/account" style="display:block;padding:10px 16px;font-size:13px;color:var(--text);text-decoration:none;border-bottom:1px solid var(--border)">Account settings</a>
            <button id="logout-btn" style="width:100%;text-align:left;padding:10px 16px;font-size:13px;color:var(--danger);background:none;border:none;cursor:pointer">Log out</button>
          </div>
        </div>
      </div>
    </nav>
  `;
  document.body.insertAdjacentHTML('afterbegin', html);

  mountThemeToggle(document.getElementById('theme-toggle-slot'));

  const menu = document.getElementById('user-menu');
  const dropdown = document.getElementById('user-dropdown');
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', () => { dropdown.style.display = 'none'; });
  document.getElementById('logout-btn').addEventListener('click', () => Auth.logout());
}

