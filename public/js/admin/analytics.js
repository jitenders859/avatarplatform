// ── Analytics tab ─────────────────────────────────────────────
// Platform-wide rollup — GET /api/admin/analytics/overview and
// GET /api/admin/analytics/top-projects, see
// docs/admin-panel-implementation-plan.md "3a. Aggregate analytics route".
// No charting library exists in this codebase (confirmed by the Phase 0
// audit), so this is plain stat-card/table layout reusing the existing
// .card/.pill/.table classes rather than inventing a new visual system —
// same approach as usage.js's table, tiers.js's pill list.
let analyticsWindow = '30d';

async function loadAnalyticsTab() {
  const section = document.getElementById('tab-analytics');
  section.innerHTML = `
    <div id="analytics-overview"></div>
    <div class="card mt-lg">
      <div class="card-header row" style="justify-content:space-between;align-items:center">
        <h2 class="card-title">Top projects</h2>
        <select id="analytics-window" class="input" style="max-width:160px">
          <option value="24h">Last 24h</option>
          <option value="7d">Last 7 days</option>
          <option value="30d" selected>Last 30 days</option>
        </select>
      </div>
      <div id="analytics-top-projects"></div>
    </div>
  `;
  section.querySelector('#analytics-window').addEventListener('change', (e) => {
    analyticsWindow = e.target.value;
    renderTopProjects();
  });
  await Promise.all([renderAnalyticsOverview(), renderTopProjects()]);
}

function statCard(label, value) {
  return `<div class="card" style="padding:14px 16px">
    <div class="muted text-sm">${escapeHtml(label)}</div>
    <div style="font-size:24px;font-weight:700;margin-top:4px">${value}</div>
  </div>`;
}

function statGrid(cards) {
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">${cards.join('')}</div>`;
}

async function renderAnalyticsOverview() {
  const wrap = document.getElementById('analytics-overview');
  wrap.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  let overview;
  try {
    overview = await AdminAPI.getAnalyticsOverview();
  } catch (err) {
    wrap.innerHTML = `<div class="adm-error-state">Could not load analytics: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const { totals, windows, funnel, avgSessionDurationSec } = overview;

  const totalsCards = statGrid([
    statCard('Projects', formatNum(totals.projects)),
    statCard('Users', formatNum(totals.users)),
    statCard('Sessions (all time)', formatNum(totals.sessions)),
    statCard('Messages (all time)', formatNum(totals.messages)),
  ]);

  const windowCards = statGrid([
    statCard('Messages · 24h', formatNum(windows.messages.last24h)),
    statCard('Messages · 7d', formatNum(windows.messages.last7d)),
    statCard('Messages · 30d', formatNum(windows.messages.last30d)),
    statCard('Sessions · 24h', formatNum(windows.sessions.last24h)),
    statCard('Sessions · 7d', formatNum(windows.sessions.last7d)),
    statCard('Sessions · 30d', formatNum(windows.sessions.last30d)),
  ]);

  // Same conversion funnel shown per-project on the owner-facing analytics
  // page (backend/routes/analytics.js `GET /project/:id`), aggregated
  // across every tenant instead of one.
  const engagedPct = funnel.sessions > 0 ? Math.round((funnel.engagedSessions / funnel.sessions) * 100) : 0;
  const capturedPct = funnel.engagedSessions > 0 ? Math.round((funnel.leadsCaptured / funnel.engagedSessions) * 100) : 0;
  const completedPct = funnel.leadsCaptured > 0 ? Math.round((funnel.leadsCompleted / funnel.leadsCaptured) * 100) : 0;

  const funnelCards = statGrid([
    statCard('Sessions started', formatNum(funnel.sessions)),
    statCard('Engaged (sent a message)', `${formatNum(funnel.engagedSessions)} <span class="text-sm muted">(${engagedPct}%)</span>`),
    statCard('Leads captured', `${formatNum(funnel.leadsCaptured)} <span class="text-sm muted">(${capturedPct}%)</span>`),
    statCard('Leads completed', `${formatNum(funnel.leadsCompleted)} <span class="text-sm muted">(${completedPct}%)</span>`),
    statCard('Avg session duration', `${formatNum(avgSessionDurationSec)}s`),
  ]);

  wrap.innerHTML = `
    <h3 style="font-size:15px;margin:0 0 10px">Platform totals</h3>
    ${totalsCards}
    <h3 style="font-size:15px;margin:20px 0 10px">Activity</h3>
    ${windowCards}
    <h3 style="font-size:15px;margin:20px 0 10px">Conversion funnel</h3>
    ${funnelCards}
  `;
}

async function renderTopProjects() {
  const wrap = document.getElementById('analytics-top-projects');
  wrap.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  let projects;
  try {
    ({ projects } = await AdminAPI.getTopProjects(analyticsWindow));
  } catch (err) {
    wrap.innerHTML = `<div class="adm-error-state">Could not load top projects: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const rows = projects.map(p => `
    <tr>
      <td style="font-weight:500">${escapeHtml(p.name)}</td>
      <td class="muted text-sm">${escapeHtml(p.ownerEmail || '—')}</td>
      <td>${formatNum(p.messages)}</td>
      <td>${formatNum(p.sessions)}</td>
    </tr>`).join('');
  wrap.innerHTML = `
    <div class="table-scroll">
    <table class="table">
      <thead><tr><th>Project</th><th>Owner</th><th>Messages</th><th>Sessions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">No activity in this window</td></tr>'}</tbody>
    </table>
    </div>`;
}

TABS.analytics = loadAnalyticsTab;
