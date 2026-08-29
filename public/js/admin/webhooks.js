// ── Webhook Deliveries tab ───────────────────────────────────
// Cross-tenant view of backend/services/webhookDelivery.js's delivery log
// (owners already see their own project's rows on project.html; this is
// the admin-wide equivalent). Mostly read-only paginated table — same
// shape as audit.js — plus a Retry button on failed rows.
let webhooksStatusFilter = '';

async function loadWebhooksTab() {
  const section = document.getElementById('tab-webhooks');
  section.innerHTML = `
    <div class="row gap-sm mb-md">
      <select id="webhooks-status-filter" class="input" style="max-width:200px">
        <option value="">All statuses</option>
        <option value="pending">Pending</option>
        <option value="success">Success</option>
        <option value="failed">Failed</option>
      </select>
    </div>
    <div id="webhooks-table"></div>
    <div id="webhooks-pagination"></div>`;
  section.querySelector('#webhooks-status-filter').addEventListener('change', (e) => {
    webhooksStatusFilter = e.target.value;
    renderWebhooksTable(1);
  });
  await renderWebhooksTable(1);
}

function webhookStatusPill(status) {
  const cls = status === 'success' ? 'pill-success' : status === 'failed' ? 'pill-danger' : 'pill-info';
  return `<span class="pill ${cls}">${escapeHtml(status)}</span>`;
}

function truncateUrl(url, max = 48) {
  if (!url) return '<span class="muted">—</span>';
  const s = String(url);
  return escapeHtml(s.length > max ? s.slice(0, max - 1) + '…' : s);
}

async function renderWebhooksTable(page) {
  const wrap = document.getElementById('webhooks-table');
  wrap.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  document.getElementById('webhooks-pagination').innerHTML = '';
  let deliveries, total, pageSize;
  try {
    ({ deliveries, total, pageSize } = await AdminAPI.listWebhookDeliveries(page, webhooksStatusFilter));
  } catch (err) {
    wrap.innerHTML = `<div class="adm-error-state">Could not load webhook deliveries: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const rows = deliveries.map(d => `
    <tr>
      <td class="text-sm">
        <div>${escapeHtml(d.project?.name || '(unknown project)')}</div>
        <div class="muted text-sm">${escapeHtml(d.project?.ownerEmail || '')}</div>
      </td>
      <td>${webhookStatusPill(d.status)}</td>
      <td class="text-sm" title="${escapeHtml(d.project?.webhookUrl || '')}">${truncateUrl(d.project?.webhookUrl)}</td>
      <td class="text-sm">${d.attempt}</td>
      <td class="text-sm muted" style="white-space:nowrap">${d.updatedAt ? new Date(d.updatedAt).toLocaleString() : new Date(d.createdAt).toLocaleString()}</td>
      <td class="text-sm muted" style="white-space:nowrap">${d.nextRetryAt ? new Date(d.nextRetryAt).toLocaleString() : '—'}</td>
      <td>${d.status === 'failed'
          ? `<button type="button" class="btn btn-ghost btn-sm" data-retry-id="${escapeHtml(d.id)}">Retry</button>`
          : ''}</td>
    </tr>`).join('');
  wrap.innerHTML = `
    <div class="table-scroll">
    <table class="table">
      <thead><tr><th>Project</th><th>Status</th><th>Target URL</th><th>Attempts</th><th>Last attempt</th><th>Next retry</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">No webhook deliveries yet</td></tr>'}</tbody>
    </table>
    </div>`;
  wrap.querySelectorAll('[data-retry-id]').forEach(btn => {
    btn.addEventListener('click', () => retryWebhookDelivery(btn.dataset.retryId, page));
  });
  renderPagination(document.getElementById('webhooks-pagination'), { page, pageSize, total }, renderWebhooksTable);
}

async function retryWebhookDelivery(id, page) {
  try {
    await AdminAPI.retryWebhookDelivery(id);
    adminToast('Retry triggered', 'success');
    await renderWebhooksTable(page);
  } catch (err) {
    adminToast(err.message, 'error');
  }
}

TABS.webhooks = loadWebhooksTab;
