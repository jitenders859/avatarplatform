// ── Settings tab ─────────────────────────────────────────────
// Model API keys/name previously .env-only (see backend/services/settings.js).
// Saving here writes to the admin_settings table, which overrides the env
// var of the same name immediately (no redeploy); clearing the field
// reverts to whatever's in .env.

const SETTINGS_META = {
  GEMINI_API_KEY: {
    label: 'Gemini API key',
    help: 'Server-side key used for embeddings, /ask, /study, and file processing. Required for the assistant to work at all.',
    type: 'password',
  },
  PUBLIC_GEMINI_API_KEY: {
    label: 'Public Gemini API key (voice)',
    help: 'Separate, quota-restricted key shipped to every visitor’s browser for the Gemini Live voice avatar. Must differ from the key above — reusing it is rejected server-side because that would leak the server key publicly. Leave blank to keep widgets in text-only mode.',
    type: 'password',
  },
  STUDY_MODEL: {
    label: 'Study model',
    help: 'Gemini model used for the tool-calling /study chat (quizzes, flashcards, etc). Defaults to gemini-2.5-flash when blank.',
    type: 'text',
  },
};

async function loadSettingsTab() {
  const section = document.getElementById('tab-settings');
  section.innerHTML = `
    <div class="card">
      <div class="card-header"><h2 class="card-title">Model settings</h2></div>
      <p class="muted text-sm mb-md">Overrides take effect immediately, no redeploy needed. Clearing a field falls back to the value in .env.</p>
      <div id="settings-form-body"><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div></div>
    </div>
  `;
  await renderSettingsForm();
}

async function renderSettingsForm() {
  const body = document.getElementById('settings-form-body');
  let settings;
  try {
    ({ settings } = await AdminAPI.listSettings());
  } catch (err) {
    body.innerHTML = `<div class="adm-error-state">Could not load settings: ${escapeHtml(err.message)}</div>`;
    return;
  }

  body.innerHTML = settings.map(s => {
    const meta = SETTINGS_META[s.key] || { label: s.key, help: '', type: 'text' };
    const sourceLabel = s.source === 'admin' ? 'Set here' : s.source === 'env' ? 'From .env' : 'Not set';
    const pillClass = s.source === 'admin' ? 'pill-success' : s.source === 'env' ? 'pill' : 'pill-danger';
    return `
      <div class="field mb-md" data-setting-key="${escapeHtml(s.key)}">
        <label style="display:flex;align-items:center;gap:8px;justify-content:space-between">
          <span>${escapeHtml(meta.label)}</span>
          <span class="pill ${pillClass}" style="font-size:11px">${sourceLabel}</span>
        </label>
        <div class="row gap-sm">
          <input type="${meta.type}" class="input setting-input" placeholder="${s.masked ? escapeHtml(s.masked) : 'Not set'}" style="flex:1" autocomplete="off" />
          <button type="button" class="btn btn-primary btn-sm setting-save">Save</button>
          ${s.source === 'admin' ? '<button type="button" class="btn btn-ghost btn-sm setting-clear">Revert to .env</button>' : ''}
        </div>
        ${meta.help ? `<span class="help">${escapeHtml(meta.help)}</span>` : ''}
      </div>`;
  }).join('');

  body.querySelectorAll('[data-setting-key]').forEach(row => {
    const key = row.dataset.settingKey;
    const input = row.querySelector('.setting-input');
    row.querySelector('.setting-save').addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value) { adminToast('Enter a value, or use "Revert to .env" to clear it', 'error'); return; }
      await saveSetting(key, value);
    });
    row.querySelector('.setting-clear')?.addEventListener('click', async () => {
      if (!confirm(`Revert ${SETTINGS_META[key]?.label || key} to the .env value?`)) return;
      await saveSetting(key, '');
    });
  });
}

async function saveSetting(key, value) {
  try {
    await AdminAPI.updateSetting(key, value);
    adminToast(value ? 'Setting saved' : 'Reverted to .env', 'success');
    await renderSettingsForm();
  } catch (err) {
    adminToast(err.message, 'error');
  }
}

TABS.settings = loadSettingsTab;
