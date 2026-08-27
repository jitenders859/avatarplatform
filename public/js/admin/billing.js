// ── Billing & revenue tab ────────────────────────────────────
let billingPage = 1;
let billingStatus = '';

async function loadBillingTab() {
  const section = document.getElementById('tab-billing');
  section.innerHTML = `
    <div class="row gap-sm mb-md">
      <select id="billing-f-status" class="select" style="max-width:200px">
        <option value="">All statuses</option>
        <option value="active">Active</option>
        <option value="cancelled">Cancelled</option>
        <option value="past_due">Past due</option>
        <option value="incomplete">Incomplete</option>
      </select>
    </div>
    <div id="billing-table"></div>
    <div id="billing-pagination"></div>
  `;
  document.getElementById('billing-f-status').addEventListener('change', (e) => {
    billingStatus = e.target.value;
    billingPage = 1;
    renderBillingTable();
  });
  billingPage = 1;
  billingStatus = '';
  await renderBillingTable();
}

async function renderBillingTable() {
  const wrap = document.getElementById('billing-table');
  wrap.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  let subscriptions, page, pageSize, total, stripeConfigured;
  try {
    ({ subscriptions, page, pageSize, total, stripeConfigured } = await AdminAPI.listBilling(billingPage, billingStatus));
  } catch (err) {
    wrap.innerHTML = `<div class="adm-error-state">Could not load billing: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const statusPill = (s) => {
    const cls = s === 'active' ? 'pill-success' : s === 'past_due' || s === 'incomplete' ? 'pill-warn' : 'pill-danger';
    return `<span class="pill ${cls}">${escapeHtml(s)}</span>`;
  };

  const rows = subscriptions.map(s => `
    <tr>
      <td class="text-sm">${escapeHtml(s.userEmail)}</td>
      <td>${escapeHtml(s.planName)} <span class="muted text-sm">($${s.priceMonthly}/mo)</span></td>
      <td>${statusPill(s.status)}${s.cancelAtPeriodEnd ? ' <span class="pill pill-warn">ends at period end</span>' : ''}</td>
      <td class="text-sm">${s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : '—'}</td>
      <td>${s.status === 'active' && !s.cancelAtPeriodEnd ? `<button class="btn btn-ghost btn-sm" data-cancel-sub="${s.userId}" style="color:var(--danger)">Cancel</button>` : ''}</td>
    </tr>`).join('');

  wrap.innerHTML = `
    ${!stripeConfigured ? '<div class="adm-error-state" style="margin-bottom:12px">Stripe is not configured on this server — subscription rows below reflect the last known state, and the Cancel action will fail until STRIPE_SECRET_KEY is set.</div>' : ''}
    <div class="table-scroll">
    <table class="table">
      <thead><tr><th>User</th><th>Plan</th><th>Status</th><th>Renews / ends</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No subscriptions match this filter</td></tr>'}</tbody>
    </table>
    </div>`;

  for (const btn of wrap.querySelectorAll('[data-cancel-sub]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('Cancel this subscription at the end of its current billing period? The customer keeps access until then.')) return;
      try {
        await AdminAPI.cancelSubscription(btn.dataset.cancelSub);
        adminToast('Subscription set to cancel at period end', 'success');
        renderBillingTable();
      } catch (err) { adminToast(err.message, 'error'); }
    });
  }

  renderPagination(document.getElementById('billing-pagination'), {
    page, pageSize, total,
    onPage: (p) => { billingPage = p; renderBillingTable(); },
  });
}

TABS.billing = loadBillingTab;
