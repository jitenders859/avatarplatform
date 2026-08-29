// ── Feature Flags tab ────────────────────────────────────────
// Admin-defined boolean flags (see backend/services/featureFlags.js).
// Unlike Settings (settings.js), there's no fixed key list — flags are
// created here via the "Add flag" form, then toggled/edited below.
// Infra only (admin-panel plan 5e): no feature in the codebase is gated
// behind a flag yet, so an empty list here is correct and expected.

async function loadFeatureFlagsTab() {
  const section = document.getElementById('tab-featureFlags');
  section.innerHTML = `
    <div class="card mb-lg">
      <div class="card-header"><h2 class="card-title">Add flag</h2></div>
      <form id="flag-create-form" class="row gap-sm" style="align-items:flex-start;flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:160px">
          <label for="flag-key-input">Key</label>
          <input type="text" id="flag-key-input" class="input" placeholder="my_new_flag" autocomplete="off" required />
          <span class="help">Lowercase letters, numbers, underscores. Must start with a letter.</span>
        </div>
        <div class="field" style="flex:2;min-width:220px">
          <label for="flag-description-input">Description</label>
          <input type="text" id="flag-description-input" class="input" placeholder="What this flag controls" autocomplete="off" />
        </div>
        <button type="submit" class="btn btn-primary" style="margin-top:22px">Add flag</button>
      </form>
    </div>
    <div class="card">
      <div class="card-header"><h2 class="card-title">Flags</h2></div>
      <div id="flags-list-body"><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div></div>
    </div>
  `;

  document.getElementById('flag-create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = document.getElementById('flag-key-input').value.trim();
    const description = document.getElementById('flag-description-input').value.trim();
    if (!key) { adminToast('Enter a key', 'error'); return; }
    try {
      await AdminAPI.createFeatureFlag({ key, description: description || undefined });
      adminToast('Flag created', 'success');
      document.getElementById('flag-create-form').reset();
      await renderFlagsList();
    } catch (err) {
      adminToast(err.message, 'error');
    }
  });

  await renderFlagsList();
}

async function renderFlagsList() {
  const body = document.getElementById('flags-list-body');
  let flags;
  try {
    ({ flags } = await AdminAPI.listFeatureFlags());
  } catch (err) {
    body.innerHTML = `<div class="adm-error-state">Could not load feature flags: ${escapeHtml(err.message)}</div>`;
    return;
  }

  if (!flags.length) {
    body.innerHTML = `<p class="muted text-sm">No feature flags yet. Add one above.</p>`;
    return;
  }

  body.innerHTML = flags.map(f => `
    <div class="field mb-md" data-flag-key="${escapeHtml(f.key)}">
      <label style="display:flex;align-items:center;gap:8px;justify-content:space-between">
        <span><strong>${escapeHtml(f.key)}</strong></span>
        <span class="pill ${f.enabled ? 'pill-success' : ''}" style="font-size:11px">${f.enabled ? 'Enabled' : 'Disabled'}</span>
      </label>
      <div class="row gap-sm" style="align-items:flex-start">
        <input type="text" class="input flag-description-edit" value="${escapeHtml(f.description || '')}" placeholder="Description" style="flex:1" autocomplete="off" />
        <button type="button" class="btn btn-sm ${f.enabled ? 'btn-ghost' : 'btn-primary'} flag-toggle">${f.enabled ? 'Disable' : 'Enable'}</button>
        <button type="button" class="btn btn-ghost btn-sm flag-save">Save description</button>
      </div>
    </div>`).join('');

  body.querySelectorAll('[data-flag-key]').forEach(row => {
    const key = row.dataset.flagKey;
    const flag = flags.find(f => f.key === key);
    const descInput = row.querySelector('.flag-description-edit');
    row.querySelector('.flag-toggle').addEventListener('click', async () => {
      try {
        await AdminAPI.updateFeatureFlag(key, { enabled: !flag.enabled, description: descInput.value.trim() });
        adminToast(flag.enabled ? 'Flag disabled' : 'Flag enabled', 'success');
        await renderFlagsList();
      } catch (err) {
        adminToast(err.message, 'error');
      }
    });
    row.querySelector('.flag-save').addEventListener('click', async () => {
      try {
        await AdminAPI.updateFeatureFlag(key, { enabled: flag.enabled, description: descInput.value.trim() });
        adminToast('Description saved', 'success');
        await renderFlagsList();
      } catch (err) {
        adminToast(err.message, 'error');
      }
    });
  });
}

TABS.featureFlags = loadFeatureFlagsTab;
