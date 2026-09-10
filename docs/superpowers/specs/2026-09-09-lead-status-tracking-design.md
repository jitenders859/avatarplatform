# Lead status tracking

**Files:** `supabase/schema.sql`, `supabase/migrations/2026-09-09_add_lead_status.sql` (new), `backend/middleware/validate.js`, `backend/routes/projects.js`, `backend/routes/apiData.js`, `public/js/api.js`, `public/project.html` (inline Leads-tab JS)
**Status:** Approved, ready for implementation plan

## Context

Inbound leads (prospective students/customers the chatbot captures mid-conversation) live in the `leads` table (`supabase/schema.sql`): `id`, `project_id`, `session_id`, `data` (JSONB, keyed by the project's configured `capture_fields`), `complete` (auto-computed boolean — have all *required* capture fields been filled in), `created_at`, `updated_at`. There is no staff-editable field on a lead today — `complete` is derived, not set by a person.

`public/project.html`'s Leads tab already lists/filters/exports leads and shows a "Status" column, but that column is just the `complete` boolean rendered as a pill (`✓ Complete` / `Partial`). There is no PATCH route for leads at all — `backend/routes/projects.js` only has `GET /:id/leads` (list) and `GET /:id/leads/:leadId` (detail).

Goal: give staff a fixed-enum, staff-set field for where a lead stands in the follow-up pipeline (New → Contacted → Replied → a meeting type → Follow-Up Later / Rejected / Enrolled), editable inline from the leads table and from the detail panel, filterable, and included in CSV export.

Confirmed during brainstorming:
- **Coexists with `complete`, doesn't replace it.** `complete` stays exactly as-is (data-completeness, auto-computed, existing Complete/Incomplete filter untouched). The new pipeline status is a separate column/dropdown.
- **Fixed enum, 8 values** (free text not allowed): `new`, `contacted`, `replied`, `meeting_scheduled`, `google_meet_scheduled`, `follow_up_later`, `rejected`, `enrolled`. `enrolled` is included as a plain label even though this platform has no enrollment-tracking system behind it — just a status a lead can be set to once it converts.
- **`follow_up_date`**: a real nullable date column, not just a status label. Shown as a date picker only when status is `follow_up_later`. If staff change status away from `follow_up_later`, the server clears `follow_up_date` automatically (not just hidden client-side) so a later re-snooze doesn't inherit a stale date.
- **Editable in two places**: inline `<select>` in each leads-table row (fast triage) and in the lead detail panel (`#lead-detail-card`). Both PATCH the same field.
- **Filterable**: a new status filter alongside the existing All/Complete/Incomplete buttons, implemented server-side (query param + WHERE clause + pagination), matching how `?complete=` already works — not a client-side filter over an unpaginated fetch.
- **No audit log.** The `characters.status` precedent logs to `logAdminAction`, but that's a platform-admin action log; leads belong to individual project owners, and adding an owner-scoped audit trail is a new mechanism, out of scope here.

Out of scope for this round: enrollment tracking as a real subsystem (beyond the plain status label), reminder notifications tied to `follow_up_date` (e.g. "this follow-up is due today" alerts), bulk status-change actions, per-status color customization by project owners, history/audit trail of status changes.

---

## Part 1 — Schema

`supabase/schema.sql` is the idempotent source of truth; same statements captured as a standalone dated migration per existing convention (see `2026-08-28_add_handoff.sql` for the pattern).

**New file `supabase/migrations/2026-09-09_add_lead_status.sql`** (also appended into the `leads` table block in `schema.sql`):

```sql
-- ── leads: follow-up pipeline status ─────────────────────────────
ALTER TABLE leads ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';
-- 'new' | 'contacted' | 'replied' | 'meeting_scheduled' | 'google_meet_scheduled'
-- | 'follow_up_later' | 'rejected' | 'enrolled'
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_date DATE;

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(project_id, status);
```

Existing rows backfill to `'new'` via the column `DEFAULT`, no separate backfill script needed. No `CHECK` constraint, matching this schema's established convention of enforcing enums at the application layer only (see `characters.status`, `sessions.handoff_status` — neither uses a DB-level constraint).

---

## Part 2 — Backend validation & routes

**`backend/middleware/validate.js`** — new `schemas.leadPatch`, mirroring `characterPatch`:

```js
leadPatch: z.object({
  status: z.enum(
    ['new', 'contacted', 'replied', 'meeting_scheduled', 'google_meet_scheduled',
     'follow_up_later', 'rejected', 'enrolled'],
    { error: 'Invalid status' }
  ).optional(),
  followUpDate: z.string().date().nullable().optional(),
}).refine(d => Object.keys(d).length > 0, { message: 'Nothing to update' }),
```

**`backend/routes/projects.js`** — new route, placed next to the existing `GET /:id/leads` / `GET /:id/leads/:leadId`:

```js
router.patch('/:id/leads/:leadId', authRequired, validate(schemas.leadPatch), async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const lead = await db.findOne('leads', { id: req.params.leadId, projectId: project.id });
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const patch = { ...req.body };
  if (patch.status && patch.status !== 'follow_up_later') {
    patch.followUpDate = null; // server-side clear, not just client-side hide
  }

  const updated = await db.update('leads', lead.id, patch);
  res.json(updated);
});
```

**`GET /:id/leads`** (`backend/routes/projects.js`) and **`GET /leads`** (`backend/routes/apiData.js`, the cross-project variant) — extend the existing `complete` filter convention with a parallel `status` param:

```js
// existing: req.query.complete === 'true' | 'false' | (absent/'all')
// new:      req.query.status === one of the 8 enum values | (absent/'all')
```

applied as an additional WHERE clause alongside the existing one, before pagination — so filtering by status doesn't break page counts. Both endpoints' row-shaping already returns whichever lead columns exist; `status` and `followUpDate` just need adding to the selected/returned fields.

**`GET /:id/leads/:leadId`** — include `status`/`followUpDate` in the detail response (single extra field addition, same spot the transcript/capture data is already assembled).

**CSV export** (`exportLeadsCsv()` in `project.html`) — add a `status` column (human-readable label, e.g. "Follow-Up Later" not `follow_up_later`) and a `follow_up_date` column (blank when not set), next to the existing `complete` column.

---

## Part 3 — Frontend

**`public/js/api.js`** — new method next to `listLeads`/`getLead`:

```js
patchLead: (pid, lid, patch) => apiCall(`/api/projects/${pid}/leads/${lid}`, { method: 'PATCH', body: patch }),
```

**Leads table** (`project.html`, current row-render around line 3167-3171) — add a "Follow-up" column: a `<select>` populated from the 8 enum values (human-readable labels), current value selected. On `change`:

```js
select.addEventListener('change', async (e) => {
  const status = e.target.value;
  const prev = lead.status;
  try {
    await API.patchLead(projectId, lead.id, { status });
    lead.status = status;
    if (status !== 'follow_up_later') lead.followUpDate = null;
    renderFollowUpDateInput(lead); // show/hide the inline date picker for this row
  } catch (err) {
    toast(err.message, 'error');
    e.target.value = prev; // roll back on failure
  }
});
```

matching the rollback-on-error pattern already used by `public/js/admin/characters.js`'s status/visibility selects. When `status === 'follow_up_later'`, an inline `<input type="date">` appears in the same cell; changing it PATCHes `{ followUpDate }` the same way; choosing any other status hides the input (the value was already cleared server-side by Part 2).

**Detail panel** (`#lead-detail-card`) — same `<select>` + conditional date input, wired the same way, for reviewing one lead in depth.

**Filter bar** — a new "Follow-up status" `<select>` (All + 8 values) next to the existing All/Complete/Incomplete buttons, feeding into `loadLeads()`'s existing param-building so it composes with the `complete` filter and pagination rather than replacing them.

---

## Part 4 — Edge cases

- Enum is fully server-validated (Zod `z.enum`) — a tampered/bypassed request can't write an arbitrary string into `status`.
- `followUpDate` is optional even when `status === 'follow_up_later'` — staff can snooze a lead without picking a date yet; the UI just makes the date input available, doesn't require it.
- Legacy leads created before this change read as `'new'` via the column default — no migration backfill script required.
- Switching status away from `follow_up_later` always nulls `follow_up_date`, enforced server-side in the PATCH handler regardless of what the client sends, so a stale date can't linger through a client bug.

---

## Part 5 — Testing

- Backend: a new test file (matching this repo's existing test style, e.g. `backend/services/webhookDelivery.test.js`) covering the PATCH route — rejects an invalid enum value, rejects an empty patch body, accepts a valid status change, and confirms `follow_up_date` is nulled server-side when status moves away from `follow_up_later` even if the request body still included a date.
- Manual verification (in-browser): change status from each of the 8 values in both the table row and detail panel, confirm persistence on reload, confirm the date picker appears/disappears correctly, confirm the new status filter narrows the list correctly in combination with the existing complete/incomplete filter, confirm CSV export includes the new columns with human-readable labels.
