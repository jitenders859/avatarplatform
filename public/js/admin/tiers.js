// ── Tiers tab ─────────────────────────────────────────────────
async function loadTiersTab() {
  const section = document.getElementById('tab-tiers');
  section.innerHTML = `
    <div class="card mb-lg">
      <div class="card-header"><h2 class="card-title">Create tier</h2></div>
      <form id="tier-form" class="col gap-sm">
        <input type="text" id="tier-name" placeholder="Tier name (e.g. Acme Corp bump)" required class="input" />
        <div class="row gap-sm" style="flex-wrap:wrap">
          ${['projects', 'maxFiles', 'storageMb', 'monthlyMessages', 'monthlyEmbeddingChars', 'urlSources']
            .map(f => `<input type="number" min="1" name="${f}" placeholder="${f}" required class="input" style="max-width:180px" />`).join('')}
        </div>
        <button type="submit" class="btn btn-primary" style="align-self:flex-start">Create tier</button>
      </form>
    </div>
    <div id="tiers-table"></div>
  `;
  document.getElementById('tier-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const limits = {};
    for (const f of ['projects', 'maxFiles', 'storageMb', 'monthlyMessages', 'monthlyEmbeddingChars', 'urlSources']) {
      limits[f] = parseInt(fd.get(f), 10);
    }
    try {
      await AdminAPI.createTier({ name: document.getElementById('tier-name').value, limits });
      adminToast('Tier created', 'success');
      e.target.reset();
      renderTiersTable();
    } catch (err) { adminToast(err.message, 'error'); }
  });
  await renderTiersTable();
}

async function renderTiersTable() {
  const wrap = document.getElementById('tiers-table');
  wrap.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  let tiers;
  try {
    ({ tiers } = await AdminAPI.listTiers());
  } catch (err) {
    wrap.innerHTML = `<div class="adm-error-state">Could not load tiers: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const rows = tiers.map(t => `
    <tr>
      <td style="font-weight:500">${escapeHtml(t.name)}</td>
      <td class="muted text-sm"><code class="adm-code">${escapeHtml(t.id)}</code></td>
      <td>
        <div class="row gap-sm" style="flex-wrap:wrap">
          ${Object.entries(t.limits).map(([k, v]) => `<span class="pill" title="${escapeHtml(k)}">${escapeHtml(k)}: ${formatNum(v)}</span>`).join('')}
        </div>
      </td>
      <td class="adm-table-actions">
        <button class="btn btn-ghost btn-sm" data-edit-tier="${escapeHtml(t.id)}">Edit</button>
        <button class="btn btn-danger btn-sm" data-delete-tier="${escapeHtml(t.id)}">Delete</button>
      </td>
    </tr>`).join('');
  wrap.innerHTML = `
    <div class="table-scroll">
    <table class="table">
      <thead><tr><th>Name</th><th>ID</th><th>Limits</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">No custom tiers yet</td></tr>'}</tbody>
    </table>
    </div>`;
  for (const btn of document.querySelectorAll('[data-edit-tier]')) {
    btn.addEventListener('click', () => {
      openEditTierModal(tiers.find(t => t.id === btn.dataset.editTier));
    });
  }
  for (const btn of document.querySelectorAll('[data-delete-tier]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this tier?')) return;
      try {
        await AdminAPI.deleteTier(btn.dataset.deleteTier);
        adminToast('Tier deleted', 'success');
        renderTiersTable();
      } catch (err) { adminToast(err.message, 'error'); }
    });
  }
}

function openEditTierModal(tier) {
  openModal(`
    <div class="modal-header">
      <h3 class="modal-title">Edit tier</h3>
      <button class="modal-close" id="modal-close-btn" aria-label="Close">&times;</button>
    </div>
    <form id="edit-tier-form" class="col gap-sm">
      <input type="text" id="edit-tier-name" value="${escapeHtml(tier.name)}" required class="input" />
      <div class="row gap-sm" style="flex-wrap:wrap">
        ${['projects', 'maxFiles', 'storageMb', 'monthlyMessages', 'monthlyEmbeddingChars', 'urlSources']
          .map(f => `<input type="number" min="1" name="${f}" value="${escapeHtml(tier.limits[f])}" placeholder="${f}" required class="input" style="max-width:180px" />`).join('')}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="modal-cancel-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save changes</button>
      </div>
    </form>
  `);
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('edit-tier-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const limits = {};
    for (const f of ['projects', 'maxFiles', 'storageMb', 'monthlyMessages', 'monthlyEmbeddingChars', 'urlSources']) {
      limits[f] = parseInt(fd.get(f), 10);
    }
    try {
      await AdminAPI.updateTier(tier.id, { name: document.getElementById('edit-tier-name').value, limits });
      adminToast('Tier updated', 'success');
      closeModal();
      renderTiersTable();
    } catch (err) { adminToast(err.message, 'error'); }
  });
}

TABS.tiers = loadTiersTab;
