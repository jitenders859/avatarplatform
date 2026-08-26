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
  const tableWrap = document.getElementById('users-table');
  tableWrap.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  let users;
  try {
    ({ users } = await AdminAPI.listUsers(search, 1));
  } catch (err) {
    tableWrap.innerHTML = `<div class="adm-error-state">Could not load users: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const rows = users.map(u => `
    <tr class="user-row" data-id="${u.id}" style="cursor:pointer" tabindex="0" role="button">
      <td>${escapeHtml(u.email)}</td>
      <td>${escapeHtml(u.name || '')}</td>
      <td><span class="pill ${u.planSource === 'admin' ? 'pill-warn' : 'pill-info'}">${escapeHtml(u.planId)} (${u.planSource})</span></td>
      <td>${u.suspended ? '<span class="pill pill-danger">Suspended</span>' : ''}</td>
      <td>${new Date(u.createdAt).toLocaleDateString()}</td>
    </tr>`).join('');
  tableWrap.innerHTML = `
    <div class="table-scroll">
    <table class="table">
      <thead><tr><th>Email</th><th>Name</th><th>Plan</th><th>Status</th><th>Joined</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No users found</td></tr>'}</tbody>
    </table>
    </div>`;
  for (const row of document.querySelectorAll('.user-row')) {
    const open = () => renderUserDetail(row.dataset.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
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

  const projectRows = projects.map(p => `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.characterId)}</td><td>${p.fileCount}</td><td>${new Date(p.createdAt).toLocaleDateString()}</td></tr>`).join('');

  const override = user.adminOverride;
  const tierStatusHtml = override
    ? `<span class="pill pill-warn" title="${override.note ? escapeHtml(override.note) : ''}">
         Manually overridden by ${escapeHtml(override.setByEmail || 'unknown')} on ${new Date(override.setAt).toLocaleDateString()}${override.expiresAt ? ` · reverts ${new Date(override.expiresAt).toLocaleDateString()}` : ''}
       </span>`
    : `<span class="pill pill-info">Stripe-driven (${usage.plan.id})</span>`;

  const detail = document.getElementById('user-detail');
  detail.hidden = false;
  detail.innerHTML = `
    <div class="card-header"><h2 class="card-title">${escapeHtml(user.email)}</h2></div>
    <div class="col gap-md">${bars}</div>
    <div class="row gap-sm mt-lg" style="align-items:center;flex-wrap:wrap">
      <span id="tier-status">${tierStatusHtml}</span>
      <button class="btn btn-ghost" id="set-override-btn">Set tier override</button>
      ${override ? '<button class="btn btn-ghost" id="clear-override-btn">Clear override</button>' : ''}
      <button class="btn btn-ghost" id="suspend-toggle-btn">${user.suspended ? 'Unsuspend' : 'Suspend'}</button>
      <button class="btn btn-ghost" id="impersonate-btn">View as user</button>
      <button class="btn btn-ghost" id="delete-user-btn" style="color:var(--danger)">Delete account</button>
    </div>
    <h3 style="font-size:15px;margin:20px 0 10px">Projects (read-only)</h3>
    <div class="table-scroll">
    <table class="table">
      <thead><tr><th>Name</th><th>Character</th><th>Files</th><th>Created</th></tr></thead>
      <tbody>${projectRows || '<tr><td colspan="4" class="muted">No projects</td></tr>'}</tbody>
    </table>
    </div>
  `;

  document.getElementById('set-override-btn').addEventListener('click', () => {
    openSetOverrideModal(userId, tiers, user.adminPlanId);
  });

  if (override) {
    document.getElementById('clear-override-btn').addEventListener('click', async () => {
      if (!confirm('Clear this tier override? The user reverts to their Stripe-driven plan (or free) immediately.')) return;
      try {
        await AdminAPI.patchUser(userId, { adminPlanId: null });
        adminToast('Override cleared', 'success');
        renderUserDetail(userId);
        renderUsersTable(document.getElementById('users-search').value);
      } catch (err) { adminToast(err.message, 'error'); }
    });
  }

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

function openSetOverrideModal(userId, tiers, currentAdminPlanId) {
  const tierOptions = tiers.map(t => `<option value="${t.id}" ${t.id === currentAdminPlanId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('');
  openModal(`
    <div class="modal-header">
      <h3 class="modal-title">Set tier override</h3>
      <button class="modal-close" id="modal-close-btn" aria-label="Close">&times;</button>
    </div>
    <form id="override-form" class="col gap-md">
      <div class="field">
        <label for="override-tier">Tier</label>
        <select id="override-tier" class="select" required>
          <option value="">Select a tier…</option>
          ${tierOptions}
        </select>
      </div>
      <div class="field">
        <label for="override-reason">Reason (optional)</label>
        <textarea id="override-reason" class="textarea" placeholder="e.g. Comped for beta feedback" maxlength="500"></textarea>
      </div>
      <div class="field">
        <label for="override-expiry">Expires (optional)</label>
        <input type="date" id="override-expiry" class="input" />
        <span class="help">Leave blank for no expiry. Automatically reverts to the Stripe-driven plan once past.</span>
      </div>
      <p class="text-sm muted" style="margin:0">This changes only which tier the app enforces — it does not pause or cancel Stripe billing.</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="modal-cancel-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Set override</button>
      </div>
    </form>
  `);
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('override-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const tierId = document.getElementById('override-tier').value;
    if (!tierId) { adminToast('Choose a tier', 'error'); return; }
    const reason = document.getElementById('override-reason').value.trim();
    const expiryDate = document.getElementById('override-expiry').value;
    const expiresAt = expiryDate ? new Date(expiryDate + 'T23:59:59').getTime() : null;
    try {
      await AdminAPI.patchUser(userId, { adminPlanId: tierId, reason: reason || undefined, expiresAt });
      adminToast('Tier override set', 'success');
      closeModal();
      renderUserDetail(userId);
      renderUsersTable(document.getElementById('users-search').value);
    } catch (err) { adminToast(err.message, 'error'); }
  });
}

TABS.users = loadUsersTab;
