// ── Email Templates tab ─────────────────────────────────────────
// The 5 transactional emails previously hardcoded in
// backend/services/email.js, now DB-backed (see
// backend/services/emailTemplates.js). `body` is the HTML template only —
// each email's plain-text alternative stays hardcoded server-side, not
// editable here. Placeholder tokens are literal `${...}` text substituted
// by a plain string-replace at send time (no templating engine) — an edit
// must keep the exact token spelling shown below or that value will no
// longer be filled in.

const EMAIL_TEMPLATE_META = {
  password_reset: {
    label: 'Password reset',
    help: 'Sent when a user requests a password reset.',
    subjectPlaceholders: [],
    bodyPlaceholders: ['${link}', '${BASE_URL()}'],
  },
  verification: {
    label: 'Email verification',
    help: 'Sent after signup to verify the account email address.',
    subjectPlaceholders: [],
    bodyPlaceholders: ['${link}', '${BASE_URL()}'],
  },
  team_invite: {
    label: 'Team invite',
    help: 'Sent when an owner adds a read-only team member to a project.',
    subjectPlaceholders: ['${projectName}'],
    bodyPlaceholders: ['${escapeHtml(inviterEmail)}', '${escapeHtml(projectName)}', '${BASE_URL()}'],
  },
  welcome: {
    label: 'Welcome',
    help: 'Sent right after signup.',
    subjectPlaceholders: [],
    bodyPlaceholders: ['${displayName}', '${BASE_URL()}'],
  },
  contact_message: {
    label: 'Contact form relay',
    help: 'Sent to support when a visitor submits the contact form (not to the visitor).',
    subjectPlaceholders: ['${name}'],
    bodyPlaceholders: ['${escapeHtml(name)}', '${escapeHtml(email)}', '${escapeHtml(message)}'],
  },
};

async function loadEmailTemplatesTab() {
  const section = document.getElementById('tab-emailTemplates');
  section.innerHTML = `
    <div class="card">
      <div class="card-header"><h2 class="card-title">Email templates</h2></div>
      <p class="muted text-sm mb-md">Edits take effect on the next send, no redeploy needed. Each row is the HTML body of a transactional email; the plain-text alternative is not editable here.</p>
      <div id="email-templates-body"><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div></div>
    </div>
  `;
  await renderEmailTemplatesList();
}

async function renderEmailTemplatesList() {
  const body = document.getElementById('email-templates-body');
  let templates;
  try {
    ({ templates } = await AdminAPI.listEmailTemplates());
  } catch (err) {
    body.innerHTML = `<div class="adm-error-state">Could not load email templates: ${escapeHtml(err.message)}</div>`;
    return;
  }

  body.innerHTML = `
    <table class="table">
      <thead><tr><th>Template</th><th>Subject</th><th>Source</th><th></th></tr></thead>
      <tbody>
        ${templates.map(t => {
          const meta = EMAIL_TEMPLATE_META[t.key] || { label: t.key };
          const pillClass = t.source === 'admin' ? 'pill-success' : 'pill';
          return `
            <tr data-key="${escapeHtml(t.key)}">
              <td><strong>${escapeHtml(meta.label || t.key)}</strong><div class="muted text-sm">${escapeHtml(meta.help || '')}</div></td>
              <td>${escapeHtml(t.subject)}</td>
              <td><span class="pill ${pillClass}" style="font-size:11px">${t.source === 'admin' ? 'Edited' : 'Default'}</span></td>
              <td><button type="button" class="btn btn-ghost btn-sm email-template-edit">Edit</button></td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;

  body.querySelectorAll('.email-template-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.closest('tr').dataset.key;
      const template = templates.find(t => t.key === key);
      openEmailTemplateModal(template);
    });
  });
}

function openEmailTemplateModal(template) {
  const meta = EMAIL_TEMPLATE_META[template.key] || { label: template.key, subjectPlaceholders: [], bodyPlaceholders: [] };
  const subjectHelp = meta.subjectPlaceholders.length
    ? `Placeholders: ${meta.subjectPlaceholders.map(p => `<code>${escapeHtml(p)}</code>`).join(', ')}`
    : 'No placeholders in the subject.';
  const bodyHelp = meta.bodyPlaceholders.length
    ? `Placeholders: ${meta.bodyPlaceholders.map(p => `<code>${escapeHtml(p)}</code>`).join(', ')}`
    : 'No placeholders in the body.';

  openModal(`
    <div class="modal-header">
      <h3 class="modal-title">Edit: ${escapeHtml(meta.label || template.key)}</h3>
      <button type="button" class="btn btn-ghost btn-sm" id="et-modal-close">✕</button>
    </div>
    <form id="et-form" class="col gap-md">
      <div class="field">
        <label>Subject</label>
        <input type="text" id="et-subject" class="input" value="${escapeHtml(template.subject)}" required />
        <span class="help">${subjectHelp}</span>
      </div>
      <div class="field">
        <label>Body (HTML)</label>
        <textarea id="et-body" class="input" rows="14" style="font-family:monospace;font-size:12px" required>${escapeHtml(template.body)}</textarea>
        <span class="help">${bodyHelp} Keep the exact <code>\${...}</code> spelling shown above — anything else won't be filled in when the email is sent.</span>
      </div>
      <div class="row gap-sm" style="justify-content:flex-end">
        <button type="button" class="btn btn-ghost" id="et-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `);

  document.getElementById('et-modal-close').addEventListener('click', closeModal);
  document.getElementById('et-cancel').addEventListener('click', closeModal);
  document.getElementById('et-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const subject = document.getElementById('et-subject').value;
    const bodyValue = document.getElementById('et-body').value;
    try {
      await AdminAPI.updateEmailTemplate(template.key, { subject, body: bodyValue });
      adminToast('Template saved', 'success');
      closeModal();
      await renderEmailTemplatesList();
    } catch (err) {
      adminToast(err.message, 'error');
    }
  });
}

TABS.emailTemplates = loadEmailTemplatesTab;
