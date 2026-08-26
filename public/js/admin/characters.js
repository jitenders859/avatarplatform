// ── Characters tab ───────────────────────────────────────────
// Upload wizard, library grid, and per-character management (status,
// visibility, version history, tenant access). The "does this file
// conform" check and the "test it live" preview both run in-browser using
// the same rive.js runtime build production loads (see admin.html) — no
// server-side Rive parser exists, so this IS the real contract check; the
// server only sanity-checks the upload is a genuine Rive binary at all.

const RIVE_ARTBOARD = 'Character';
const RIVE_STATE_MACHINE = 'InLesson';
const RIVE_REQUIRED_INPUTS = Array.from({ length: 23 }, (_, i) => String(100 + i));
// Mirrors public/lipsync-sdk.js's RIVE_INPUT_LABEL — kept in sync manually
// since the SDK doesn't expose this as a shared, importable constant.
const RIVE_INPUT_LABEL = {
  100: 'sil / closed', 101: 'aa / wide open', 102: 'aw / tall open',
  103: 'ey / flat open', 104: 'uw / tight round', 105: 'ih / narrow teeth',
  106: 's_z / teeth', 107: 'p_b_m / closed', 108: 'ow / round open',
  109: 'f_v / lip teeth', 110: 'o / small round', 111: 'ay / diphthong',
  112: 'ao / wide round', 113: 'er', 114: 'r', 115: 'l', 116: 'sh_ch',
  117: 'th', 118: 'd_t_n', 119: 'h', 120: 'oy', 121: 'k_g_ng', 122: 'ng',
};

// ── Rive introspection engine ────────────────────────────────
function loadRiveInstance(src, canvas, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const inst = new window.rive.Rive({
      src,
      canvas,
      autoplay: opts.autoplay ?? false,
      ...(opts.artboard ? { artboard: opts.artboard } : {}),
      ...(opts.stateMachines ? { stateMachines: opts.stateMachines } : {}),
      onLoad: () => { settled = true; resolve(inst); },
      onLoadError: () => { if (!settled) { settled = true; reject(new Error('Not a valid Rive (.riv) file, or the file is corrupted')); } },
    });
  });
}

async function inspectRiveSource(src) {
  const scratch = document.createElement('canvas');
  scratch.width = 64; scratch.height = 64;
  let root;
  try {
    root = await loadRiveInstance(src, scratch);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const artboardNames = root.artboardNames || [];
  root.cleanup();

  const artboards = [];
  for (const name of artboardNames) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    let inst;
    try {
      inst = await loadRiveInstance(src, c, { artboard: name });
    } catch {
      artboards.push({ name, stateMachines: [], animations: [] });
      continue;
    }
    const stateMachines = (inst.stateMachineNames || []).map(smName => ({
      name: smName,
      inputs: (inst.stateMachineInputs(smName) || []).map(inp => ({
        name: inp.name,
        type: inp.type === window.rive.StateMachineInputType.Trigger ? 'trigger'
            : inp.type === window.rive.StateMachineInputType.Boolean ? 'boolean' : 'number',
      })),
    }));
    const animations = inst.animationNames || [];
    artboards.push({ name, stateMachines, animations });
    inst.cleanup();
  }

  return { ok: true, artboardNames, artboards, contract: checkRiveContract(artboards) };
}

function checkRiveContract(artboards) {
  const character = artboards.find(a => a.name === RIVE_ARTBOARD);
  if (!character) return { conforms: false, missing: [`artboard "${RIVE_ARTBOARD}"`], missingInputs: [] };
  const sm = character.stateMachines.find(s => s.name === RIVE_STATE_MACHINE);
  if (!sm) return { conforms: false, missing: [`state machine "${RIVE_STATE_MACHINE}"`], missingInputs: [] };
  const present = new Set(sm.inputs.filter(i => i.type === 'number').map(i => i.name));
  const missingInputs = RIVE_REQUIRED_INPUTS.filter(n => !present.has(n));
  return { conforms: missingInputs.length === 0, missing: [], missingInputs };
}

function renderContractSummary(inspection) {
  if (!inspection.ok) {
    return `<div class="adm-error-state">Could not read this file: ${escapeHtml(inspection.error)}</div>`;
  }
  const c = inspection.contract;
  const badge = c.conforms
    ? '<span class="pill pill-success">Matches the SDK contract</span>'
    : '<span class="pill pill-warn">Does not fully match the SDK contract</span>';
  const missingList = [...c.missing, ...c.missingInputs.map(n => `input "${n}" (${RIVE_INPUT_LABEL[n] || 'unmapped'})`)];
  return `
    <div class="col gap-sm">
      <div>${badge}</div>
      ${missingList.length ? `<div class="text-sm" style="color:var(--warn)">Missing: ${missingList.map(escapeHtml).join(', ')}</div>` : ''}
      <div class="text-sm"><strong>Artboards:</strong> ${inspection.artboardNames.map(escapeHtml).join(', ') || '—'}</div>
      ${inspection.artboards.map(a => `
        <div class="text-sm muted">
          <strong style="color:var(--text)">${escapeHtml(a.name)}</strong> —
          state machines: ${a.stateMachines.map(sm => escapeHtml(sm.name)).join(', ') || 'none'} ·
          timelines: ${a.animations.map(escapeHtml).join(', ') || 'none'}
        </div>
      `).join('')}
      <div class="text-sm muted">Data bindings (view models) aren't inspectable via this admin panel's Rive runtime build — this covers artboards, state machines, inputs, and timelines only.</div>
    </div>
  `;
}

// Live, interactive preview — the actual "test before releasing" surface.
// Prefers the real contract artboard/state machine (matches production
// exactly); falls back to whatever the file has so even a non-conformant
// upload shows something rather than a blank canvas. Returns the Rive
// instance so the caller can .cleanup() it when done.
async function mountLivePreview(container, src, inspection) {
  container.innerHTML = `
    <canvas width="220" height="220" style="width:220px;height:220px;background:var(--bg-3);border-radius:var(--adm-radius);display:block"></canvas>
    <div id="preview-sliders" class="col gap-sm mt-sm"></div>`;
  const canvas = container.querySelector('canvas');
  const slidersEl = container.querySelector('#preview-sliders');

  const character = inspection.artboards.find(a => a.name === RIVE_ARTBOARD) || inspection.artboards[0];
  if (!character) { slidersEl.innerHTML = '<p class="text-sm muted">No artboard to preview.</p>'; return null; }
  const sm = character.stateMachines.find(s => s.name === RIVE_STATE_MACHINE) || character.stateMachines[0];

  let inst;
  try {
    inst = await loadRiveInstance(src, canvas, { artboard: character.name, stateMachines: sm ? [sm.name] : undefined, autoplay: true });
  } catch (e) {
    slidersEl.innerHTML = `<p class="text-sm" style="color:var(--danger)">${escapeHtml(e.message)}</p>`;
    return null;
  }

  if (!sm) { slidersEl.innerHTML = '<p class="text-sm muted">No state machine on this artboard to test.</p>'; return inst; }

  const numberInputs = (inst.stateMachineInputs(sm.name) || []).filter(i => i.type === window.rive.StateMachineInputType.Number);
  if (!numberInputs.length) {
    slidersEl.innerHTML = '<p class="text-sm muted">No Number inputs on this state machine to test.</p>';
    return inst;
  }
  slidersEl.innerHTML = `<p class="text-sm muted" style="margin:4px 0">Drag a slider to watch the character respond live:</p>` + numberInputs.map(inp => `
    <div class="row gap-sm" style="align-items:center">
      <label class="text-sm" style="min-width:150px">${escapeHtml(inp.name)}${RIVE_INPUT_LABEL[inp.name] ? ` (${escapeHtml(RIVE_INPUT_LABEL[inp.name])})` : ''}</label>
      <input type="range" min="0" max="100" value="0" data-input-name="${escapeHtml(inp.name)}" style="flex:1" />
    </div>`).join('');
  slidersEl.querySelectorAll('input[type=range]').forEach(range => {
    range.addEventListener('input', () => {
      const target = numberInputs.find(i => i.name === range.dataset.inputName);
      if (target) target.value = Number(range.value);
    });
  });
  return inst;
}

// ── Library grid ─────────────────────────────────────────────
async function loadCharactersTab() {
  const section = document.getElementById('tab-characters');
  section.innerHTML = `
    <div class="row gap-sm mb-md" style="justify-content:space-between">
      <p class="text-sm muted" style="margin:0">New characters start as drafts — test them here, then set Active to make them selectable by tenants.</p>
      <button class="btn btn-primary" id="upload-character-btn">Upload character</button>
    </div>
    <div id="character-grid" class="grid grid-3"></div>
  `;
  document.getElementById('upload-character-btn').addEventListener('click', openUploadCharacterModal);
  await renderCharacterLibrary();
}

async function renderCharacterLibrary() {
  const grid = document.getElementById('character-grid');
  grid.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  let characters;
  try {
    ({ characters } = await AdminAPI.listCharacters());
  } catch (err) {
    grid.innerHTML = `<div class="adm-error-state">Could not load characters: ${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!characters.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="empty-icon">🎭</div><div class="empty-title">No characters yet</div><p class="muted">Upload your first .riv file to get started.</p></div>`;
    return;
  }
  const statusPill = { active: 'pill-success', draft: 'pill-warn', archived: 'pill-danger' };
  grid.innerHTML = characters.map(c => `
    <div class="card" data-character-id="${c.id}" style="cursor:pointer" tabindex="0" role="button">
      <div class="card-header">
        <h3 class="card-title" style="font-size:14px">${escapeHtml(c.name)}</h3>
        <span class="pill ${statusPill[c.status] || 'pill-info'}">${c.status}</span>
      </div>
      <p class="text-sm muted" style="min-height:32px">${escapeHtml(c.description || '')}</p>
      <div class="row gap-sm text-sm muted" style="justify-content:space-between">
        <span>${c.visibility === 'global' ? 'Global' : 'Restricted'}</span>
        <span>${c.usageCount} project${c.usageCount === 1 ? '' : 's'}</span>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('[data-character-id]').forEach(card => {
    const open = () => openManageCharacterModal(card.dataset.characterId);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

// ── Upload wizard ────────────────────────────────────────────
function openUploadCharacterModal() {
  let currentPreviewInst = null;
  let selectedFile = null;
  let inspection = null;
  let currentObjectUrl = null;

  openModal(`
    <div class="modal-header">
      <h3 class="modal-title">Upload character</h3>
      <button class="modal-close" id="modal-close-btn" aria-label="Close">&times;</button>
    </div>
    <div class="col gap-md">
      <div class="field">
        <label for="char-name">Name</label>
        <input type="text" id="char-name" class="input" placeholder="e.g. Nova" maxlength="80" />
      </div>
      <div class="field">
        <label for="char-description">Description (optional)</label>
        <input type="text" id="char-description" class="input" maxlength="500" />
      </div>
      <div class="field">
        <label for="char-visibility">Visibility</label>
        <select id="char-visibility" class="select">
          <option value="restricted">Restricted (choose tenants after upload)</option>
          <option value="global">Global (available to every tenant immediately)</option>
        </select>
      </div>
      <div id="char-dropzone" style="border:2px dashed var(--border);border-radius:var(--adm-radius);padding:24px;text-align:center;cursor:pointer">
        <div class="text-sm" id="char-dropzone-label">Drag &amp; drop a .riv file here, or click to choose one</div>
        <input type="file" id="char-file-input" accept=".riv" style="display:none" />
      </div>
      <div id="char-inspection" hidden></div>
      <div id="char-preview" hidden></div>
      <p class="text-sm muted" style="margin:0">This check runs in your browser and doesn't block upload — you can still upload a non-conforming file and fix it in a later version.</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="modal-cancel-btn">Cancel</button>
        <button type="button" class="btn btn-primary" id="char-upload-btn" disabled>Upload</button>
      </div>
    </div>
  `, { onClose: () => { currentPreviewInst?.cleanup(); if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl); } });

  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);

  const dropzone = document.getElementById('char-dropzone');
  const fileInput = document.getElementById('char-file-input');
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--accent)'; });
  dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = 'var(--border)'; });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--border)';
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

  async function handleFile(file) {
    if (!/\.riv$/i.test(file.name)) { adminToast('Choose a .riv file', 'error'); return; }
    selectedFile = file;
    if (!document.getElementById('char-name').value) {
      document.getElementById('char-name').value = file.name.replace(/\.riv$/i, '');
    }
    document.getElementById('char-dropzone-label').textContent = `Selected: ${file.name} (${formatNum(file.size)} bytes)`;

    const inspectionEl = document.getElementById('char-inspection');
    const previewEl = document.getElementById('char-preview');
    inspectionEl.hidden = false;
    inspectionEl.innerHTML = '<div class="adm-skeleton-row"></div>';
    previewEl.hidden = true;

    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(file);
    inspection = await inspectRiveSource(currentObjectUrl);
    inspectionEl.innerHTML = renderContractSummary(inspection);
    document.getElementById('char-upload-btn').disabled = false;

    if (inspection.ok) {
      previewEl.hidden = false;
      previewEl.innerHTML = '<h4 class="text-sm" style="margin:12px 0 6px">Live preview</h4><div id="preview-mount"></div>';
      currentPreviewInst?.cleanup();
      currentPreviewInst = await mountLivePreview(document.getElementById('preview-mount'), currentObjectUrl, inspection);
    }
  }

  document.getElementById('char-upload-btn').addEventListener('click', async () => {
    const name = document.getElementById('char-name').value.trim();
    if (!name) { adminToast('Name is required', 'error'); return; }
    if (!selectedFile) { adminToast('Choose a .riv file', 'error'); return; }
    const btn = document.getElementById('char-upload-btn');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      const description = document.getElementById('char-description').value.trim();
      const visibility = document.getElementById('char-visibility').value;
      const init = await AdminAPI.initCharacterUpload({ name, description: description || undefined, visibility });

      const supabase = await getAdminSupabaseClient();
      const { error } = await supabase.storage.from('character-assets').uploadToSignedUrl(init.storageKey, init.uploadToken, selectedFile);
      if (error) throw error;

      const inspectorMeta = inspection?.ok ? { artboardNames: inspection.artboardNames, artboards: inspection.artboards, contract: inspection.contract } : undefined;
      await AdminAPI.completeCharacterUpload(init.characterId, { inspectorMeta });

      adminToast('Character uploaded — it starts as draft until you set it Active', 'success');
      closeModal();
      renderCharacterLibrary();
    } catch (err) {
      adminToast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Upload';
    }
  });
}

// ── Manage modal: status/visibility, live preview, versions, access ──
async function openManageCharacterModal(id) {
  let detail;
  try {
    detail = await AdminAPI.getCharacter(id);
  } catch (err) {
    adminToast(err.message, 'error');
    return;
  }
  const { character, versions, access } = detail;
  // Both the main preview and the "upload new version" panel's preview
  // (nested inside this same modal) register their Rive instance here, so
  // closing the modal via the X/Esc/backdrop always cleans up whichever is
  // live — not just the one active when the modal happened to be opened.
  const liveRiveInstances = new Set();

  const statusOptions = ['draft', 'active', 'archived']
    .map(s => `<option value="${s}" ${s === character.status ? 'selected' : ''}>${s}</option>`).join('');
  const visibilityOptions = ['restricted', 'global']
    .map(v => `<option value="${v}" ${v === character.visibility ? 'selected' : ''}>${v}</option>`).join('');

  openModal(`
    <div class="modal-header">
      <h3 class="modal-title">${escapeHtml(character.name)}</h3>
      <button class="modal-close" id="modal-close-btn" aria-label="Close">&times;</button>
    </div>
    <div class="col gap-md">
      <div class="row gap-sm" style="flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:150px">
          <label for="mc-status">Status</label>
          <select id="mc-status" class="select">${statusOptions}</select>
        </div>
        <div class="field" style="flex:1;min-width:150px">
          <label for="mc-visibility">Visibility</label>
          <select id="mc-visibility" class="select">${visibilityOptions}</select>
        </div>
      </div>
      <div>
        <h4 class="text-sm" style="margin:0 0 6px">Live preview</h4>
        <div id="mc-preview"><div class="adm-skeleton-row"></div></div>
      </div>
      <div id="mc-access-wrap" ${character.visibility === 'global' ? 'hidden' : ''}></div>
      <div>
        <h4 class="text-sm" style="margin:0 0 6px">Version history</h4>
        <div class="table-scroll"><table class="table">
          <thead><tr><th>Version</th><th>Size</th><th>Uploaded</th></tr></thead>
          <tbody id="mc-versions-body">${versions.map(v => `
            <tr><td>v${v.version}${v.version === character.version ? ' (current)' : ''}</td><td>${formatNum(v.fileSize)} bytes</td><td>${new Date(v.createdAt).toLocaleString()}</td></tr>
          `).join('')}</tbody>
        </table></div>
        <button class="btn btn-ghost btn-sm mt-sm" id="mc-new-version-btn">Upload new version</button>
        <div id="mc-new-version-panel" hidden></div>
      </div>
    </div>
  `, { onClose: () => { for (const inst of liveRiveInstances) inst.cleanup(); liveRiveInstances.clear(); } });

  document.getElementById('modal-close-btn').addEventListener('click', closeModal);

  // Live preview of the character as it exists right now (its public URL).
  inspectRiveSource(character.publicUrl).then(inspection => {
    const previewEl = document.getElementById('mc-preview');
    if (!previewEl) return; // modal closed before this resolved
    if (!inspection.ok) { previewEl.innerHTML = `<div class="adm-error-state">${escapeHtml(inspection.error)}</div>`; return; }
    previewEl.innerHTML = '';
    mountLivePreview(previewEl, character.publicUrl, inspection).then(inst => { if (inst) liveRiveInstances.add(inst); });
  });

  document.getElementById('mc-status').addEventListener('change', async (e) => {
    const status = e.target.value;
    if (status === 'archived' && character.usageCount > 0) {
      if (!confirm(`${character.usageCount} project(s) currently use this character. Archiving stops it from being assigned to NEW projects, but existing ones keep working. Continue?`)) {
        e.target.value = character.status;
        return;
      }
    }
    try {
      await AdminAPI.patchCharacter(id, { status });
      character.status = status;
      adminToast('Status updated', 'success');
      renderCharacterLibrary();
    } catch (err) { adminToast(err.message, 'error'); e.target.value = character.status; }
  });

  document.getElementById('mc-visibility').addEventListener('change', async (e) => {
    const visibility = e.target.value;
    try {
      await AdminAPI.patchCharacter(id, { visibility });
      character.visibility = visibility;
      document.getElementById('mc-access-wrap').hidden = visibility === 'global';
      if (visibility !== 'global') renderAccessSection(id, access);
      adminToast('Visibility updated', 'success');
      renderCharacterLibrary();
    } catch (err) { adminToast(err.message, 'error'); e.target.value = character.visibility; }
  });

  if (character.visibility !== 'global') renderAccessSection(id, access);

  document.getElementById('mc-new-version-btn').addEventListener('click', () => {
    openNewVersionPanel(id, character, liveRiveInstances);
  });
}

function renderAccessSection(characterId, access) {
  const wrap = document.getElementById('mc-access-wrap');
  wrap.hidden = false;
  wrap.innerHTML = `
    <h4 class="text-sm" style="margin:0 0 6px">Tenant access</h4>
    <div class="row gap-sm">
      <input type="text" id="mc-access-search" class="input" placeholder="Search users by email…" style="max-width:260px" />
      <div id="mc-access-results" style="position:relative"></div>
    </div>
    <div class="table-scroll mt-sm"><table class="table">
      <thead><tr><th>Email</th><th>Granted</th><th></th></tr></thead>
      <tbody id="mc-access-body">${access.map(a => accessRow(characterId, a)).join('') || '<tr><td colspan="3" class="muted">No tenants granted yet — this character is unavailable until you grant access or make it global.</td></tr>'}</tbody>
    </table></div>
  `;

  let searchTimer = null;
  document.getElementById('mc-access-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (!q) { document.getElementById('mc-access-results').innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      const { users } = await AdminAPI.listUsers(q, 1);
      document.getElementById('mc-access-results').innerHTML = users.length ? `
        <div class="card" style="position:absolute;z-index:10;top:100%;left:0;right:0;padding:6px;max-height:200px;overflow-y:auto">
          ${users.map(u => `<div class="text-sm" data-grant-user="${u.id}" data-grant-email="${escapeHtml(u.email)}" style="padding:6px;cursor:pointer;border-radius:6px">${escapeHtml(u.email)}</div>`).join('')}
        </div>` : '';
      document.getElementById('mc-access-results').querySelectorAll('[data-grant-user]').forEach(row => {
        row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-3)');
        row.addEventListener('mouseleave', () => row.style.background = '');
        row.addEventListener('click', async () => {
          try {
            await AdminAPI.grantCharacterAccess(characterId, row.dataset.grantUser);
            document.getElementById('mc-access-body').insertAdjacentHTML('beforeend', accessRow(characterId, { userId: row.dataset.grantUser, email: row.dataset.grantEmail, createdAt: Date.now() }));
            wireRevokeButtons(characterId);
            document.getElementById('mc-access-search').value = '';
            document.getElementById('mc-access-results').innerHTML = '';
            adminToast('Access granted', 'success');
          } catch (err) { adminToast(err.message, 'error'); }
        });
      });
    }, 250);
  });

  wireRevokeButtons(characterId);
}

function accessRow(characterId, a) {
  return `<tr data-user-row="${a.userId}"><td>${escapeHtml(a.email)}</td><td>${new Date(a.createdAt).toLocaleDateString()}</td><td><button class="btn btn-ghost text-sm" data-revoke="${a.userId}" style="color:var(--danger)">Revoke</button></td></tr>`;
}

function wireRevokeButtons(characterId) {
  document.querySelectorAll('[data-revoke]').forEach(btn => {
    btn.onclick = async () => {
      try {
        await AdminAPI.revokeCharacterAccess(characterId, btn.dataset.revoke);
        document.querySelector(`[data-user-row="${btn.dataset.revoke}"]`)?.remove();
        adminToast('Access revoked', 'success');
      } catch (err) { adminToast(err.message, 'error'); }
    };
  });
}

// Inline (not a nested modal — the modal helper is single-slot) new-version
// uploader, reusing the same inspector/preview engine as the create flow.
function openNewVersionPanel(characterId, character, liveRiveInstances) {
  let previewInst = null;
  let currentObjectUrl = null;
  const panel = document.getElementById('mc-new-version-panel');
  panel.hidden = false;
  panel.innerHTML = `
    <div class="card mt-sm">
      <div id="nv-dropzone" style="border:2px dashed var(--border);border-radius:var(--adm-radius);padding:16px;text-align:center;cursor:pointer">
        <div class="text-sm" id="nv-dropzone-label">Drag &amp; drop the replacement .riv file, or click to choose one</div>
        <input type="file" id="nv-file-input" accept=".riv" style="display:none" />
      </div>
      <div id="nv-inspection" hidden class="mt-sm"></div>
      <div id="nv-preview" hidden class="mt-sm"></div>
      <div class="row gap-sm mt-sm">
        <button class="btn btn-primary" id="nv-upload-btn" disabled>Upload as v${character.version + 1}</button>
        <button class="btn btn-ghost" id="nv-cancel-btn">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById('nv-cancel-btn').addEventListener('click', () => {
    if (previewInst) { previewInst.cleanup(); liveRiveInstances.delete(previewInst); }
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    panel.hidden = true;
    panel.innerHTML = '';
  });

  const dropzone = document.getElementById('nv-dropzone');
  const fileInput = document.getElementById('nv-file-input');
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => e.preventDefault());
  dropzone.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

  let selectedFile = null, inspection = null;
  async function handleFile(file) {
    if (!/\.riv$/i.test(file.name)) { adminToast('Choose a .riv file', 'error'); return; }
    selectedFile = file;
    document.getElementById('nv-dropzone-label').textContent = `Selected: ${file.name} (${formatNum(file.size)} bytes)`;
    const inspectionEl = document.getElementById('nv-inspection');
    inspectionEl.hidden = false;
    inspectionEl.innerHTML = '<div class="adm-skeleton-row"></div>';
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(file);
    inspection = await inspectRiveSource(currentObjectUrl);
    inspectionEl.innerHTML = renderContractSummary(inspection);
    document.getElementById('nv-upload-btn').disabled = false;
    if (inspection.ok) {
      const previewEl = document.getElementById('nv-preview');
      previewEl.hidden = false;
      if (previewInst) { previewInst.cleanup(); liveRiveInstances.delete(previewInst); }
      previewInst = await mountLivePreview(previewEl, currentObjectUrl, inspection);
      if (previewInst) liveRiveInstances.add(previewInst);
    }
  }

  document.getElementById('nv-upload-btn').addEventListener('click', async () => {
    if (!selectedFile) return;
    const btn = document.getElementById('nv-upload-btn');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      const init = await AdminAPI.initCharacterVersion(characterId);
      const supabase = await getAdminSupabaseClient();
      const { error } = await supabase.storage.from('character-assets').uploadToSignedUrl(init.storageKey, init.uploadToken, selectedFile);
      if (error) throw error;
      const inspectorMeta = inspection?.ok ? { artboardNames: inspection.artboardNames, artboards: inspection.artboards, contract: inspection.contract } : undefined;
      await AdminAPI.completeCharacterVersion(characterId, init.version, { inspectorMeta });
      adminToast(`Uploaded v${init.version}`, 'success');
      closeModal();
      renderCharacterLibrary();
    } catch (err) {
      adminToast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = `Upload as v${character.version + 1}`;
    }
  });
}

TABS.characters = loadCharactersTab;
