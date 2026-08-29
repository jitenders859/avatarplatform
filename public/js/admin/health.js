// ── Health tab ───────────────────────────────────────────────
// System health snapshot — GET /api/admin/health, see
// docs/admin-panel-implementation-plan.md "Phase 4: System health tab".
// Reuses statCard()/statGrid() defined in analytics.js (plain globals,
// same as every other admin/*.js file — no module system here) instead of
// redefining the same .card markup a third time; admin.html loads
// analytics.js before this file.
async function loadHealthTab() {
  const section = document.getElementById('tab-health');
  section.innerHTML = '<div id="health-cards"><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div></div>';
  await renderHealthCards();
}

async function renderHealthCards() {
  const wrap = document.getElementById('health-cards');
  let health;
  try {
    health = await AdminAPI.getHealth();
  } catch (err) {
    wrap.innerHTML = `<div class="adm-error-state">Could not load health status: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const { db, rateLimitStore, webhooks } = health;

  const dbCard = `<div class="card" style="padding:14px 16px">
    <div class="muted text-sm">Database</div>
    <div style="font-size:24px;font-weight:700;margin-top:4px">
      <span class="pill ${db.ok ? 'pill-success' : 'pill-danger'}">${db.ok ? 'Connected' : 'Unreachable'}</span>
    </div>
    <div class="muted text-sm mt-sm">${formatNum(db.latencyMs)}ms latency</div>
  </div>`;

  const rateLimitCard = `<div class="card" style="padding:14px 16px">
    <div class="muted text-sm">Rate-limit store</div>
    <div style="font-size:24px;font-weight:700;margin-top:4px">
      <span class="pill ${rateLimitStore.backend === 'redis' ? 'pill-success' : 'pill-warn'}">${rateLimitStore.backend === 'redis' ? 'Redis' : 'In-memory'}</span>
    </div>
    <div class="muted text-sm mt-sm">${rateLimitStore.backend === 'redis' ? 'Shared across instances' : 'Per-instance fallback — limits may be effectively disabled on multi-instance/serverless deploys'}</div>
  </div>`;

  const webhookCards = statGrid([
    statCard('Failed deliveries', formatNum(webhooks.failedCount)),
    statCard('Retries exhausted', formatNum(webhooks.exhaustedCount)),
  ]);

  wrap.innerHTML = `
    <h3 style="font-size:15px;margin:0 0 10px">Infrastructure</h3>
    ${statGrid([dbCard, rateLimitCard])}
    <h3 style="font-size:15px;margin:20px 0 10px">Webhook deliveries</h3>
    ${webhookCards}
  `;
}

TABS.health = loadHealthTab;
