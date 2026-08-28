// ── Audit Log tab ────────────────────────────────────────────
async function loadAuditTab() {
  const section = document.getElementById('tab-audit');
  section.innerHTML = `<div id="audit-table"></div><div id="audit-pagination"></div>`;
  await renderAuditTable(1);
}

async function renderAuditTable(page) {
  const wrap = document.getElementById('audit-table');
  wrap.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  document.getElementById('audit-pagination').innerHTML = '';
  let entries, total, pageSize;
  try {
    ({ entries, total, pageSize } = await AdminAPI.auditLog(page));
  } catch (err) {
    wrap.innerHTML = `<div class="adm-error-state">Could not load the audit log: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const rows = entries.map(e => `
    <tr>
      <td class="text-sm muted" style="white-space:nowrap">${new Date(e.createdAt).toLocaleString()}</td>
      <td class="text-sm">${escapeHtml(e.adminEmail || e.adminId)}</td>
      <td><span class="pill pill-info">${escapeHtml(e.action)}</span></td>
      <td class="text-sm">${escapeHtml(e.targetEmail || '')}</td>
      <td class="muted text-sm">${e.meta ? `<code class="adm-code">${escapeHtml(JSON.stringify(e.meta))}</code>` : ''}</td>
    </tr>`).join('');
  wrap.innerHTML = `
    <div class="table-scroll">
    <table class="table">
      <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target user</th><th>Details</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No admin actions yet</td></tr>'}</tbody>
    </table>
    </div>`;
  renderPagination(document.getElementById('audit-pagination'), { page, pageSize, total }, renderAuditTable);
}

TABS.audit = loadAuditTab;
