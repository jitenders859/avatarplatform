// ── Coupons tab ──────────────────────────────────────────────
// Coupons are Stripe Coupon + Promotion Code pairs (services/coupons.js is
// the source of truth for the discount); this UI manages the local
// metadata layer (applicable tiers, redemption caps) and shows redemption
// history. See backend/routes/billing.js for how a coupon actually gets
// applied at checkout.

async function loadCouponsTab() {
  const section = document.getElementById('tab-coupons');
  section.innerHTML = `
    <div class="row gap-sm mb-md" style="justify-content:space-between">
      <p class="text-sm muted" style="margin:0">Discounts run through Stripe; caps and tier restrictions are enforced here before checkout.</p>
      <button class="btn btn-primary" id="create-coupon-btn">Create coupon</button>
    </div>
    <div id="coupons-table"></div>
  `;
  document.getElementById('create-coupon-btn').addEventListener('click', openCreateCouponModal);
  await renderCouponsTable();
}

async function renderCouponsTable() {
  const wrap = document.getElementById('coupons-table');
  wrap.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  let coupons;
  try {
    ({ coupons } = await AdminAPI.listCoupons());
  } catch (err) {
    wrap.innerHTML = `<div class="adm-error-state">Could not load coupons: ${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!coupons.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-icon">🏷️</div><div class="empty-title">No coupons yet</div><p class="muted">Create one to offer a discount at checkout.</p></div>`;
    return;
  }
  const rows = coupons.map(c => {
    const discount = c.discountType === 'percent' ? `${formatNum(Number(c.discountValue))}% off` : `${formatNum(Number(c.discountValue))} ${(c.currency || '').toUpperCase()} off`;
    const uses = c.maxRedemptions != null ? `${c.redemptionCount} / ${c.maxRedemptions}` : `${c.redemptionCount} (unlimited)`;
    const plans = c.applicablePlanIds?.length ? c.applicablePlanIds.join(', ') : 'All plans';
    const expiry = c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : '—';
    return `
      <tr>
        <td><code class="adm-code">${escapeHtml(c.code)}</code></td>
        <td style="font-weight:500">${escapeHtml(discount)}</td>
        <td class="text-sm muted">${escapeHtml(plans)}</td>
        <td class="text-sm">${uses}</td>
        <td class="text-sm muted">${expiry}</td>
        <td><span class="pill ${c.active ? 'pill-success' : 'pill-danger'}">${c.active ? 'Active' : 'Inactive'}</span></td>
        <td class="adm-table-actions">
          <button class="btn btn-ghost btn-sm" data-view-redemptions="${c.id}" data-code="${escapeHtml(c.code)}">Redemptions</button>
          <button class="btn ${c.active ? 'btn-ghost' : 'btn-primary'} btn-sm" data-toggle-coupon="${c.id}" data-active="${c.active}">${c.active ? 'Deactivate' : 'Activate'}</button>
        </td>
      </tr>`;
  }).join('');
  wrap.innerHTML = `
    <div class="table-scroll">
    <table class="table">
      <thead><tr><th>Code</th><th>Discount</th><th>Applies to</th><th>Uses</th><th>Expires</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;

  wrap.querySelectorAll('[data-toggle-coupon]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const active = btn.dataset.active === 'true';
      try {
        await AdminAPI.patchCoupon(btn.dataset.toggleCoupon, { active: !active });
        adminToast(active ? 'Coupon deactivated' : 'Coupon activated', 'success');
        renderCouponsTable();
      } catch (err) { adminToast(err.message, 'error'); }
    });
  });
  wrap.querySelectorAll('[data-view-redemptions]').forEach(btn => {
    btn.addEventListener('click', () => openRedemptionsModal(btn.dataset.viewRedemptions, btn.dataset.code));
  });
}

async function openCreateCouponModal() {
  let plans = [];
  try {
    const res = await fetch('/api/billing/plans');
    ({ plans } = await res.json());
  } catch { /* falls back to an empty tier list below */ }
  plans = plans.filter(p => p.id !== 'free');
  let customTiers = [];
  try {
    ({ tiers: customTiers } = await AdminAPI.listTiers());
  } catch { /* custom tiers are optional context, not required to create a coupon */ }

  const planCheckboxes = [...plans.map(p => ({ id: p.id, name: p.name })), ...customTiers.map(t => ({ id: t.id, name: t.name }))]
    .map(p => `<label class="row gap-sm text-sm" style="align-items:center"><input type="checkbox" value="${escapeHtml(p.id)}" class="coupon-plan-cb" /> ${escapeHtml(p.name)}</label>`)
    .join('');

  openModal(`
    <div class="modal-header">
      <h3 class="modal-title">Create coupon</h3>
      <button class="modal-close" id="modal-close-btn" aria-label="Close">&times;</button>
    </div>
    <form id="coupon-form" class="col gap-md">
      <div class="field">
        <label for="coupon-code">Code</label>
        <input type="text" id="coupon-code" class="input" placeholder="Leave blank to auto-generate" maxlength="40" style="text-transform:uppercase" />
      </div>
      <div class="row gap-sm">
        <div class="field" style="flex:1">
          <label for="coupon-type">Discount type</label>
          <select id="coupon-type" class="select">
            <option value="percent">Percent off</option>
            <option value="fixed">Fixed amount off</option>
          </select>
        </div>
        <div class="field" style="flex:1">
          <label for="coupon-value">Value</label>
          <input type="number" id="coupon-value" class="input" min="0" step="0.01" required />
        </div>
        <div class="field" id="coupon-currency-field" style="flex:1;display:none">
          <label for="coupon-currency">Currency</label>
          <input type="text" id="coupon-currency" class="input" placeholder="usd" maxlength="3" />
        </div>
      </div>
      <div class="field">
        <label>Applicable plans</label>
        <div class="col gap-sm" style="max-height:120px;overflow-y:auto;padding:8px;background:var(--bg-3);border-radius:var(--adm-radius-sm)">
          ${planCheckboxes || '<span class="text-sm muted">No plans found</span>'}
        </div>
        <span class="help">Leave all unchecked to allow every plan.</span>
      </div>
      <div class="row gap-sm">
        <div class="field" style="flex:1">
          <label for="coupon-max-total">Max redemptions (total)</label>
          <input type="number" id="coupon-max-total" class="input" min="1" placeholder="Unlimited" />
        </div>
        <div class="field" style="flex:1">
          <label for="coupon-max-per-user">Max redemptions (per user)</label>
          <input type="number" id="coupon-max-per-user" class="input" min="1" placeholder="Unlimited" />
        </div>
      </div>
      <div class="field">
        <label for="coupon-expiry">Expires (optional)</label>
        <input type="date" id="coupon-expiry" class="input" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="modal-cancel-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Create coupon</button>
      </div>
    </form>
  `);

  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('coupon-type').addEventListener('change', (e) => {
    document.getElementById('coupon-currency-field').style.display = e.target.value === 'fixed' ? 'block' : 'none';
  });

  document.getElementById('coupon-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const discountType = document.getElementById('coupon-type').value;
    const discountValue = Number(document.getElementById('coupon-value').value);
    const currency = document.getElementById('coupon-currency').value.trim().toLowerCase();
    const code = document.getElementById('coupon-code').value.trim();
    const maxRedemptions = document.getElementById('coupon-max-total').value ? Number(document.getElementById('coupon-max-total').value) : undefined;
    const maxRedemptionsPerUser = document.getElementById('coupon-max-per-user').value ? Number(document.getElementById('coupon-max-per-user').value) : undefined;
    const expiryDate = document.getElementById('coupon-expiry').value;
    const expiresAt = expiryDate ? new Date(expiryDate + 'T23:59:59').getTime() : undefined;
    const applicablePlanIds = Array.from(document.querySelectorAll('.coupon-plan-cb:checked')).map(cb => cb.value);

    if (discountType === 'fixed' && !currency) { adminToast('Currency is required for a fixed discount', 'error'); return; }

    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await AdminAPI.createCoupon({
        code: code || undefined,
        discountType,
        discountValue,
        currency: discountType === 'fixed' ? currency : undefined,
        applicablePlanIds,
        maxRedemptions,
        maxRedemptionsPerUser,
        expiresAt,
      });
      adminToast('Coupon created', 'success');
      closeModal();
      renderCouponsTable();
    } catch (err) {
      adminToast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

async function openRedemptionsModal(couponId, code) {
  openModal(`
    <div class="modal-header">
      <h3 class="modal-title">Redemptions — ${escapeHtml(code)}</h3>
      <button class="modal-close" id="modal-close-btn" aria-label="Close">&times;</button>
    </div>
    <div id="redemptions-body"><div class="adm-skeleton-row"></div></div>
  `);
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);

  try {
    const { redemptions } = await AdminAPI.getCouponRedemptions(couponId);
    const rows = redemptions.map(r => `
      <tr><td>${escapeHtml(r.email || r.userId)}</td><td>${escapeHtml(r.planId || '')}</td><td>${new Date(r.redeemedAt).toLocaleString()}</td></tr>
    `).join('');
    document.getElementById('redemptions-body').innerHTML = `
      <div class="table-scroll"><table class="table">
        <thead><tr><th>User</th><th>Plan</th><th>Redeemed</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" class="muted">No redemptions yet</td></tr>'}</tbody>
      </table></div>`;
  } catch (err) {
    document.getElementById('redemptions-body').innerHTML = `<div class="adm-error-state">${escapeHtml(err.message)}</div>`;
  }
}

TABS.coupons = loadCouponsTab;
