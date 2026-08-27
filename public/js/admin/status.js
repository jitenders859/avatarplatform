// ── System status tab ────────────────────────────────────────
// Presence-only checks (see backend/routes/admin.js's /system-status) —
// this tab never shows actual secret values, only whether each optional
// integration is configured on this deployment.
async function loadStatusTab() {
  const section = document.getElementById('tab-status');
  section.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  let groups;
  try {
    ({ groups } = await AdminAPI.systemStatus());
  } catch (err) {
    section.innerHTML = `<div class="adm-error-state">Could not load system status: ${escapeHtml(err.message)}</div>`;
    return;
  }

  section.innerHTML = groups.map(g => `
    <div class="card mb-md">
      <div class="card-header"><h3 class="card-title">${escapeHtml(g.name)}</h3></div>
      <div class="col gap-sm">
        ${g.items.map(item => `
          <div class="row" style="justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
            <div>
              <span class="text-sm">${escapeHtml(item.label)}</span>
              ${item.note ? `<div class="muted text-sm">${escapeHtml(item.note)}</div>` : ''}
            </div>
            <span class="pill ${item.ok ? 'pill-success' : 'pill-warn'}">${item.ok ? '✓ Configured' : 'Not configured'}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

TABS.status = loadStatusTab;
