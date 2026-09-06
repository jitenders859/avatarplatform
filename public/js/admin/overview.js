// ── Overview / Dashboard tab ─────────────────────────────────
function renderBarChart(daily, key) {
  const max = Math.max(1, ...daily.map(d => d[key]));
  return daily.map(d => {
    const pct = Math.max(2, Math.round((d[key] / max) * 100));
    return `<div title="${d.date}: ${formatNum(d[key])}" style="flex:1;height:${pct}%;min-width:2px;background:linear-gradient(180deg,var(--accent),var(--accent-2));border-radius:2px 2px 0 0"></div>`;
  }).join('');
}

async function loadOverviewTab() {
  const section = document.getElementById('tab-overview');
  section.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  let data;
  try {
    data = await AdminAPI.overview();
  } catch (err) {
    section.innerHTML = `<div class="adm-error-state">Could not load the dashboard: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const { totals, subscriptionsByPlan, signupsDaily, messagesDaily, topProjects } = data;

  const planPills = subscriptionsByPlan.length
    ? subscriptionsByPlan.map(p => `<span class="pill pill-info">${escapeHtml(p.planId)}: ${formatNum(p.count)}</span>`).join(' ')
    : '<span class="muted text-sm">No active paid subscriptions</span>';

  const topRows = topProjects.map(p => `
    <tr>
      <td>${escapeHtml(p.name)}</td>
      <td class="muted text-sm">${escapeHtml(p.ownerEmail)}</td>
      <td>${formatNum(p.messageCount)}</td>
    </tr>`).join('');

  const statTile = (icon, value, label) => `
    <div class="card">
      <div class="stat-tile">
        <div class="stat-tile-icon">${icon}</div>
        <div class="stat-tile-body">
          <div class="stat-tile-value">${value}</div>
          <div class="stat-tile-label">${label}</div>
        </div>
      </div>
    </div>`;

  section.innerHTML = `
    <div class="grid grid-4 mb-lg">
      ${statTile('👥', formatNum(totals.users), 'Total users')}
      ${statTile('🤖', formatNum(totals.projects), 'Total chatbots')}
      ${statTile('💳', formatNum(totals.activeSubscriptions), 'Active subscriptions')}
      ${statTile('💰', '$' + formatNum(totals.mrr), 'MRR')}
    </div>

    <div class="grid grid-2 mb-lg">
      <div class="card">
        <div class="card-header"><h3 class="card-title">New users — last 30 days</h3></div>
        <div style="display:flex;align-items:flex-end;gap:3px;height:120px;padding:8px 0">${renderBarChart(signupsDaily, 'count')}</div>
      </div>
      <div class="card">
        <div class="card-header"><h3 class="card-title">Messages — last 30 days</h3></div>
        <div style="display:flex;align-items:flex-end;gap:3px;height:120px;padding:8px 0">${renderBarChart(messagesDaily, 'count')}</div>
      </div>
    </div>

    <div class="card mb-lg">
      <div class="card-header"><h3 class="card-title">Active subscriptions by plan</h3></div>
      <div class="row gap-sm" style="flex-wrap:wrap">${planPills}</div>
    </div>

    <div class="card">
      <div class="card-header"><h3 class="card-title">Busiest chatbots — last 30 days</h3></div>
      <div class="table-scroll">
      <table class="table">
        <thead><tr><th>Chatbot</th><th>Owner</th><th>Messages</th></tr></thead>
        <tbody>${topRows || '<tr><td colspan="3" class="muted">No messages in the last 30 days</td></tr>'}</tbody>
      </table>
      </div>
    </div>
  `;
}

TABS.overview = loadOverviewTab;
