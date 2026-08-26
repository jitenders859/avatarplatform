// ── Audit Log tab ────────────────────────────────────────────
async function loadAuditTab() {
  const section = document.getElementById('tab-audit');
  section.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  let entries;
  try {
    ({ entries } = await AdminAPI.auditLog(1));
  } catch (err) {
    section.innerHTML = `<div class="adm-error-state">Could not load the audit log: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const rows = entries.map(e => `
    <tr>
      <td class="text-sm">${new Date(e.createdAt).toLocaleString()}</td>
      <td class="text-sm">${escapeHtml(e.adminEmail || e.adminId)}</td>
      <td><span class="pill pill-info">${escapeHtml(e.action)}</span></td>
      <td class="text-sm">${escapeHtml(e.targetEmail || '')}</td>
      <td class="muted text-sm">${e.meta ? escapeHtml(JSON.stringify(e.meta)) : ''}</td>
    </tr>`).join('');
  section.innerHTML = `
    <div class="table-scroll">
    <table class="table">
      <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target user</th><th>Details</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No admin actions yet</td></tr>'}</tbody>
    </table>
    </div>`;
}

TABS.audit = loadAuditTab;
