// ── Usage & Cost tab ─────────────────────────────────────────
// Cross-user aggregate view backing "who's near their cap or costing the
// most" — see backend/services/usage.js#getUsageAcrossUsers (one GROUP BY
// query, not a per-user loop) and docs/admin-panel-implementation-plan.md
// "3b. Aggregate usage/cost dashboard". Named distinctly from any platform
// "Analytics" tab (sessions/funnel) since this is per-user plan-limit
// usage, not traffic analytics — could be merged later, kept separate here
// to avoid clobbering that tab's file.
let usageSortBy = 'ratio';

async function loadUsageTab() {
  const section = document.getElementById('tab-usage');
  section.innerHTML = `
    <div class="row gap-sm mb-md">
      <select id="usage-sort" class="input" style="max-width:240px">
        <option value="ratio">Closest to limit first</option>
        <option value="messages">Most messages first</option>
      </select>
    </div>
    <div id="usage-table"></div>
    <div id="usage-pagination"></div>`;
  section.querySelector('#usage-sort').addEventListener('change', (e) => {
    usageSortBy = e.target.value;
    renderUsageTable(1);
  });
  await renderUsageTable(1);
}

function usageRatioPill(ratio) {
  const pct = Math.round(ratio * 100);
  const cls = ratio >= 1 ? 'pill-danger' : ratio >= 0.8 ? 'pill-warn' : 'pill-info';
  return `<span class="pill ${cls}">${pct}%</span>`;
}

async function renderUsageTable(page) {
  const wrap = document.getElementById('usage-table');
  wrap.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  document.getElementById('usage-pagination').innerHTML = '';
  let users, total, pageSize;
  try {
    ({ users, total, pageSize } = await AdminAPI.getUsageOverview(page, usageSortBy));
  } catch (err) {
    wrap.innerHTML = `<div class="adm-error-state">Could not load usage overview: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const rows = users.map(u => `
    <tr>
      <td class="text-sm">
        <div>${escapeHtml(u.email)}</div>
        <div class="muted text-sm">${escapeHtml(u.name || '')}</div>
      </td>
      <td><span class="pill ${u.planSource === 'admin' ? 'pill-info' : ''}">${escapeHtml(u.planId)}</span></td>
      <td class="text-sm">
        ${usageRatioPill(u.topMetric.ratio)}
        <span class="muted">${formatNum(u.topMetric.current)} / ${formatNum(u.topMetric.limit)} ${escapeHtml(u.topMetric.label)}</span>
      </td>
      <td class="text-sm">${formatNum(u.counters.messages)}</td>
    </tr>`).join('');
  wrap.innerHTML = `
    <div class="table-scroll">
    <table class="table">
      <thead><tr><th>User</th><th>Plan</th><th>Top metric at risk</th><th>Total messages</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">No users yet</td></tr>'}</tbody>
    </table>
    </div>`;
  renderPagination(document.getElementById('usage-pagination'), { page, pageSize, total }, renderUsageTable);
}

TABS.usage = loadUsageTab;
