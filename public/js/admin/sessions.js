// ── Sessions tab ─────────────────────────────────────────────
// Cross-tenant read access to chat sessions/transcripts, see
// docs/admin-panel-implementation-plan.md "5a. Chat transcript viewing —
// full searchable access". Filterable paginated list (project id, owner
// email, date range — no message-content search, per the plan's explicit
// anti-pattern guard) that opens a transcript in a modal on row click,
// same openModal/closeModal precedent characters.js uses for its
// upload/manage-character dialogs. Opening a transcript
// (GET /:id/messages) is audit-logged server-side on every view — this tab
// has no client-side opt-out for that.
let sessionsFilters = { projectId: '', email: '', from: '', to: '' };
let sessionsFilterTimer = null;

async function loadSessionsTab() {
  const section = document.getElementById('tab-sessions');
  section.innerHTML = `
    <div class="row gap-sm mb-md" style="flex-wrap:wrap">
      <input type="text" id="sessions-filter-project" placeholder="Project ID…" class="input" style="max-width:280px" />
      <input type="text" id="sessions-filter-email" placeholder="Owner email…" class="input" style="max-width:220px" />
      <input type="date" id="sessions-filter-from" class="input" style="max-width:170px" title="From date" />
      <input type="date" id="sessions-filter-to" class="input" style="max-width:170px" title="To date" />
    </div>
    <div id="sessions-table"></div>
    <div id="sessions-pagination"></div>`;

  const onFilterChange = () => {
    clearTimeout(sessionsFilterTimer);
    sessionsFilterTimer = setTimeout(() => {
      sessionsFilters = {
        projectId: document.getElementById('sessions-filter-project').value.trim(),
        email: document.getElementById('sessions-filter-email').value.trim(),
        from: dateInputToMs(document.getElementById('sessions-filter-from').value, false),
        to: dateInputToMs(document.getElementById('sessions-filter-to').value, true),
      };
      renderSessionsTable(1);
    }, 300);
  };
  document.getElementById('sessions-filter-project').addEventListener('input', onFilterChange);
  document.getElementById('sessions-filter-email').addEventListener('input', onFilterChange);
  document.getElementById('sessions-filter-from').addEventListener('change', onFilterChange);
  document.getElementById('sessions-filter-to').addEventListener('change', onFilterChange);

  await renderSessionsTable(1);
}

// <input type="date"> gives "YYYY-MM-DD" in local time with no time
// component — end-of-range dates need to reach through 23:59:59.999 so a
// same-day session isn't excluded by the ">= / <=" epoch-ms comparison
// the backend does against sessions.created_at.
function dateInputToMs(value, endOfDay) {
  if (!value) return '';
  const d = new Date(value + (endOfDay ? 'T23:59:59.999' : 'T00:00:00.000'));
  return String(d.getTime());
}

async function renderSessionsTable(page) {
  const wrap = document.getElementById('sessions-table');
  wrap.innerHTML = '<div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>';
  document.getElementById('sessions-pagination').innerHTML = '';
  let sessions, total, pageSize;
  try {
    ({ sessions, total, pageSize } = await AdminAPI.listSessions(page, sessionsFilters));
  } catch (err) {
    wrap.innerHTML = `<div class="adm-error-state">Could not load sessions: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const rows = sessions.map(s => `
    <tr class="user-row" data-id="${escapeHtml(s.id)}" tabindex="0" role="button">
      <td class="text-sm mono">${escapeHtml(s.id)}</td>
      <td class="text-sm">
        <div>${escapeHtml(s.project?.name || '(unknown project)')}</div>
        <div class="muted text-sm">${escapeHtml(s.project?.ownerEmail || '')}</div>
      </td>
      <td class="text-sm">${formatNum(s.messageCount)}</td>
      <td class="text-sm muted">${escapeHtml(s.ip || '—')}</td>
      <td class="text-sm muted" style="white-space:nowrap">${new Date(s.createdAt).toLocaleString()}</td>
      <td class="adm-table-actions"><span class="adm-row-chevron" aria-hidden="true">›</span></td>
    </tr>`).join('');
  wrap.innerHTML = `
    <div class="table-scroll">
    <table class="table">
      <thead><tr><th>Session</th><th>Project</th><th>Messages</th><th>IP</th><th>Started</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">No sessions found</td></tr>'}</tbody>
    </table>
    </div>`;
  for (const row of wrap.querySelectorAll('.user-row')) {
    const open = () => openTranscriptModal(row.dataset.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }
  renderPagination(document.getElementById('sessions-pagination'), { page, pageSize, total }, renderSessionsTable);
}

// Opening this modal is what fires the session_transcript_viewed audit log
// entry server-side (GET /api/admin/sessions/:id/messages) — every call,
// including a zero-message session, so no early-return before the fetch.
async function openTranscriptModal(sessionId) {
  openModal(`
    <div class="modal-header">
      <h3 class="modal-title">Transcript</h3>
      <button class="modal-close" id="modal-close-btn" aria-label="Close">&times;</button>
    </div>
    <div id="transcript-body" style="max-height:60vh;overflow-y:auto">
      <div class="adm-skeleton-row"></div><div class="adm-skeleton-row"></div>
    </div>
  `);
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);

  const body = document.getElementById('transcript-body');
  let session, messages, total;
  try {
    ({ session, messages, total } = await AdminAPI.getSessionMessages(sessionId));
  } catch (err) {
    body.innerHTML = `<div class="adm-error-state">Could not load transcript: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const header = `<div class="text-sm muted mb-md">
      ${escapeHtml(session.project?.name || '(unknown project)')}
      ${session.project?.ownerEmail ? ` · ${escapeHtml(session.project.ownerEmail)}` : ''}
      · ${new Date(session.createdAt).toLocaleString()}
      · ${formatNum(total)} message${total === 1 ? '' : 's'}
    </div>`;

  const bubbles = messages.map(m => `
    <div class="col" style="margin-bottom:10px;align-items:${m.role === 'user' ? 'flex-end' : 'flex-start'}">
      <div class="text-sm muted" style="margin-bottom:2px">${escapeHtml(m.role)} · ${new Date(m.createdAt).toLocaleTimeString()}</div>
      <div style="max-width:80%;padding:8px 12px;border-radius:12px;background:${m.role === 'user' ? 'var(--accent)' : 'var(--bg-3)'};color:${m.role === 'user' ? '#fff' : 'inherit'};white-space:pre-wrap;word-break:break-word">${escapeHtml(m.text || '')}</div>
    </div>`).join('');

  body.innerHTML = header + (bubbles || '<div class="muted">No messages in this session.</div>');
}

TABS.sessions = loadSessionsTab;
