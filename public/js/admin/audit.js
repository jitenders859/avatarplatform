// ── Audit Log tab ────────────────────────────────────────────
let auditPage = 1;
let auditFilters = {};

async function loadAuditTab() {
  const section = document.getElementById('tab-audit');
  section.innerHTML = `
    <div class="row gap-sm mb-md" style="flex-wrap:wrap">
      <input type="text" id="audit-f-admin" placeholder="Admin email…" class="input" style="max-width:200px" />
      <input type="text" id="audit-f-target" placeholder="Target user email…" class="input" style="max-width:200px" />
      <select id="audit-f-action" class="select" style="max-width:220px"><option value="">All actions</option></select>
      <input type="date" id="audit-f-since" class="input" style="max-width:160px" title="From date" />
      <input type="date" id="audit-f-until" class="input" style="max-width:160px" title="To date" />
      <button class="btn btn-ghost btn-sm" id="audit-f-clear">Clear filters</button>
    </div>
    <div id="audit-table"></div>
    <div id="audit-pagination"></div>
  `;

  for (const id of ['audit-f-admin', 'audit-f-target']) {
    let t = null;
    document.getElementById(id).addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(() => { applyAuditFilters(); }, 300);
    });
  }
  document.getElementById('audit-f-action').addEventListener('change', applyAuditFilters);
  document.getElementById('audit-f-since').addEventListener('change', applyAuditFilters);
  document.getElementById('audit-f-until').addEventListener('change', applyAuditFilters);
  document.getElementById('audit-f-clear').addEventListener('click', () => {
    document.getElementById('audit-f-admin').value = '';
    document.getElementById('audit-f-target').value = '';
    document.getElementById('audit-f-action').value = '';
    document.getElementById('audit-f-since').value = '';
    document.getElementById('audit-f-until').value = '';
    applyAuditFilters();
  });

  auditPage = 1;
  await renderAuditTable();
}

function applyAuditFilters() {
  auditFilters = {
    adminEmail: document.getElementById('audit-f-admin').value.trim(),
    targetEmail: document.getElementById('audit-f-target').value.trim(),
    action: document.getElementById('audit-f-action').value,
    since: dateInputToMs(document.getElementById('audit-f-since').value, false),
    until: dateInputToMs(document.getElementById('audit-f-until').value, true),
  };
  auditPage = 1;
  renderAuditTable();
}

function dateInputToMs(value, endOfDay) {
  if (!value) return '';
  return new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`).getTime();
}

async function renderAuditTable() {
  const tableWrap = document.getElementById('audit-table');
  tableWrap.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  let entries, page, pageSize, total, actions;
  try {
    ({ entries, page, pageSize, total, actions } = await AdminAPI.auditLog(auditPage, auditFilters));
  } catch (err) {
    tableWrap.innerHTML = `<div class="adm-error-state">Could not load the audit log: ${escapeHtml(err.message)}</div>`;
    return;
  }

  // Populate the action filter dropdown once (values don't change per page).
  const actionSel = document.getElementById('audit-f-action');
  if (actionSel && actionSel.options.length <= 1 && actions?.length) {
    actionSel.innerHTML = '<option value="">All actions</option>' +
      actions.map(a => `<option value="${escapeHtml(a)}" ${a === auditFilters.action ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('');
  }

  const rows = entries.map(e => `
    <tr>
      <td class="text-sm">${new Date(e.createdAt).toLocaleString()}</td>
      <td class="text-sm">${escapeHtml(e.adminEmail || e.adminId)}</td>
      <td><span class="pill pill-info">${escapeHtml(e.action)}</span></td>
      <td class="text-sm">${escapeHtml(e.targetEmail || '')}</td>
      <td class="muted text-sm">${e.meta ? escapeHtml(JSON.stringify(e.meta)) : ''}</td>
    </tr>`).join('');
  tableWrap.innerHTML = `
    <div class="table-scroll">
    <table class="table">
      <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target user</th><th>Details</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No admin actions match these filters</td></tr>'}</tbody>
    </table>
    </div>`;

  renderPagination(document.getElementById('audit-pagination'), {
    page, pageSize, total,
    onPage: (p) => { auditPage = p; renderAuditTable(); },
  });
}

TABS.audit = loadAuditTab;
