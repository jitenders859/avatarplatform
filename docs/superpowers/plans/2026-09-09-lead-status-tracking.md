# Lead Status Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give staff a fixed-enum, staff-editable follow-up status (New/Contacted/Replied/Meeting Scheduled/Google Meet Scheduled/Follow-Up Later/Rejected/Enrolled) on each inbound lead, plus a follow-up date for the snoozed state, editable from both the leads table and the lead detail panel, filterable, and included in CSV export.

**Architecture:** Two new columns on the existing `leads` table (`status` TEXT, `follow_up_date` DATE), validated via a new Zod schema and a new `PATCH /api/projects/:id/leads/:leadId` route (`db.update`, same pattern as `characters.status`). The existing list endpoints gain an optional `status` query-param filter alongside the existing `complete` filter. The frontend adds a `<select>` (+ conditional date input) to the leads table row and detail panel, both PATCHing on change with rollback-on-error, plus a new filter dropdown and CSV columns.

**Tech Stack:** Node.js/Express, `pg` (raw SQL, no ORM), Zod v4, Postgres via Supabase, `node:test` + `node:assert/strict` for backend tests, vanilla JS/HTML for the frontend (no framework, no frontend test runner in this repo).

**Spec:** `docs/superpowers/specs/2026-09-09-lead-status-tracking-design.md`

---

### Task 1: Schema — `status` and `follow_up_date` columns

**Files:**
- Create: `supabase/migrations/2026-09-09_add_lead_status.sql`
- Modify: `supabase/schema.sql:296` (right after the `leads` table's closing `);`) and `supabase/schema.sql:402` (the compound-index section)

- [ ] **Step 1: Create the dated migration file**

`supabase/migrations/2026-09-09_add_lead_status.sql`:

```sql
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statements below are already appended to
-- schema.sql; this file is a standalone, dated record of *why* they were
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-09-09_add_lead_status.sql
--
-- Adds a staff-editable follow-up pipeline status to leads (separate from
-- the existing auto-computed `complete` boolean, which tracks whether all
-- required capture fields were filled in during chat — this tracks where
-- a human is in following up).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';
-- 'new' | 'contacted' | 'replied' | 'meeting_scheduled' | 'google_meet_scheduled'
-- | 'follow_up_later' | 'rejected' | 'enrolled'
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_date DATE;

CREATE INDEX IF NOT EXISTS idx_leads_project_status ON leads(project_id, status);
```

- [ ] **Step 2: Append the same statements into `supabase/schema.sql`**

In `supabase/schema.sql`, immediately after the existing `leads` table block (currently lines 287-296):

```sql
CREATE TABLE IF NOT EXISTS leads (
  id         UUID    PRIMARY KEY,
  project_id UUID    NOT NULL REFERENCES projects(id)  ON DELETE CASCADE,
  session_id UUID    NOT NULL REFERENCES sessions(id)  ON DELETE CASCADE,
  data       JSONB   DEFAULT '{}',
  complete   BOOLEAN DEFAULT false,
  created_at BIGINT  NOT NULL,
  updated_at BIGINT
);

-- ── leads: follow-up pipeline status ─────────────────────────────
ALTER TABLE leads ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';
-- 'new' | 'contacted' | 'replied' | 'meeting_scheduled' | 'google_meet_scheduled'
-- | 'follow_up_later' | 'rejected' | 'enrolled'
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_date DATE;
```

Then, in the compound-index section (currently lines 396-402, right after `idx_leads_project_created`):

```sql
CREATE INDEX IF NOT EXISTS idx_leads_project_created     ON leads(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_project_status       ON leads(project_id, status);
```

- [ ] **Step 3: Commit**

```bash
git add supabase/schema.sql supabase/migrations/2026-09-09_add_lead_status.sql
git commit -m "$(cat <<'EOF'
Add leads.status and leads.follow_up_date columns

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

Note: this repo has no migration runner and no local Postgres in this sandbox, so this task cannot be verified by running SQL here — applying `supabase/migrations/2026-09-09_add_lead_status.sql` (or the full `schema.sql`) against the actual `DATABASE_URL` is a manual deploy step, same as every prior migration in `supabase/migrations/`.

---

### Task 2: `leadPatch` Zod schema

**Files:**
- Modify: `backend/middleware/validate.js` (add near `characterPatch`, currently line 530)
- Test: `backend/middleware/validate.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `backend/middleware/validate.test.js`:

```js
test('leadPatch accepts a valid status-only patch', () => {
  const result = schemas.leadPatch.safeParse({ status: 'contacted' });
  assert.equal(result.success, true);
});

test('leadPatch rejects a status outside the 8 fixed values (no free text)', () => {
  const result = schemas.leadPatch.safeParse({ status: 'interested' });
  assert.equal(result.success, false);
});

test('leadPatch rejects an empty patch', () => {
  const result = schemas.leadPatch.safeParse({});
  assert.equal(result.success, false);
});

test('leadPatch accepts a valid ISO followUpDate and rejects a malformed one', () => {
  const valid = schemas.leadPatch.safeParse({ followUpDate: '2026-10-01' });
  assert.equal(valid.success, true);

  const invalid = schemas.leadPatch.safeParse({ followUpDate: '10/01/2026' });
  assert.equal(invalid.success, false);
});

test('leadPatch allows followUpDate to be explicitly cleared with null', () => {
  const result = schemas.leadPatch.safeParse({ status: 'contacted', followUpDate: null });
  assert.equal(result.success, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test backend/middleware/validate.test.js`
Expected: FAIL — `schemas.leadPatch` is undefined (`Cannot read properties of undefined (reading 'safeParse')`).

- [ ] **Step 3: Add the schema**

In `backend/middleware/validate.js`, immediately after `characterPatch` (currently lines 530-535):

```js
  leadPatch: z.object({
    status: z.enum(
      ['new', 'contacted', 'replied', 'meeting_scheduled', 'google_meet_scheduled',
       'follow_up_later', 'rejected', 'enrolled'],
      { error: 'Invalid status' }
    ).optional(),
    followUpDate: z.string().date('Invalid followUpDate').nullable().optional(),
  }).refine(d => Object.keys(d).length > 0, { message: 'Nothing to update' }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/middleware/validate.test.js`
Expected: PASS (all `leadPatch` tests, plus every pre-existing test in the file still passing)

- [ ] **Step 5: Commit**

```bash
git add backend/middleware/validate.js backend/middleware/validate.test.js
git commit -m "$(cat <<'EOF'
Add leadPatch validation schema

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `PATCH /api/projects/:id/leads/:leadId` route

**Files:**
- Modify: `backend/routes/projects.js` (new route, placed right after `GET /:id/leads/:leadId`, currently ending at line 430)
- Test: `backend/routes/projects.test.js`

- [ ] **Step 1: Extend the test file's db stub to support a `leads` row store**

In `backend/routes/projects.test.js`, the top-level `stubFile('../db', {...})` call (currently lines 32-52) needs two changes — `findOne` gains a `leads` branch, and `update` becomes real instead of a no-op. Replace the whole `stubFile('../db', {...})` block with:

```js
stubFile('../db', {
  findOne: async (table, filter) => {
    if (table === 'users' && filter.id === USER.id) return currentUser;
    if (table === 'projects' && filter.id === PROJECT_ROWS[0].id && filter.userId === USER.id) return PROJECT_ROWS[0];
    if (table === 'leads') return leadRows.find(l => l.id === filter.id && l.projectId === filter.projectId) || null;
    return null;
  },
  findAll: async () => [], // no captureFields configured, for any project
  query: async (sql, params) => {
    queryCalls.push({ sql, params });
    if (/FROM leads l\b/.test(sql)) return leadRows;
    return PROJECT_ROWS;
  },
  queryOne: async (sql) => {
    if (/COUNT\(\*\) AS total FROM leads/.test(sql)) return { total: leadRows.length };
    return null;
  },
  insert: async () => null,
  update: async (table, id, patch) => {
    if (table !== 'leads') return null;
    const row = leadRows.find(l => l.id === id);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: Date.now() });
    return row;
  },
  remove: async () => 0,
  pool: { end: async () => {} },
});
```

(This is additive/backward-compatible: no existing test calls `db.update`, and no existing test's `findOne` calls use `table === 'leads'`, so all 3 pre-existing tests in this file keep passing unchanged.)

- [ ] **Step 2: Write the failing tests**

Append to `backend/routes/projects.test.js`:

```js
test('PATCH /api/projects/:id/leads/:leadId updates status and rejects an invalid one', async (t) => {
  delete require.cache[require.resolve('./projects')];
  const { router } = require('./projects');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', router);
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0);
  leadRows = [{
    id: 'lead1', projectId: PROJECT_ROWS[0].id, sessionId: 's1',
    data: {}, complete: false, status: 'new', followUpDate: null, createdAt: Date.now(),
  }];
  t.after(() => { server.close(); leadRows = []; });
  const port = server.address().port;
  const token = jwt.sign({ uid: USER.id }, process.env.JWT_SECRET, { algorithm: 'HS256' });

  const patch = (leadId, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: `/api/projects/${PROJECT_ROWS[0].id}/leads/${leadId}`, method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let body = ''; res.on('data', c => body += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });

  const ok = await patch('lead1', { status: 'contacted' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'contacted');

  const bad = await patch('lead1', { status: 'interested' });
  assert.equal(bad.status, 400);

  const empty = await patch('lead1', {});
  assert.equal(empty.status, 400);

  const missing = await patch('does-not-exist', { status: 'contacted' });
  assert.equal(missing.status, 404);
});

test('PATCH /api/projects/:id/leads/:leadId clears follow_up_date when status moves away from follow_up_later', async (t) => {
  delete require.cache[require.resolve('./projects')];
  const { router } = require('./projects');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', router);
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0);
  leadRows = [{
    id: 'lead2', projectId: PROJECT_ROWS[0].id, sessionId: 's1',
    data: {}, complete: false, status: 'follow_up_later', followUpDate: '2026-01-01', createdAt: Date.now(),
  }];
  t.after(() => { server.close(); leadRows = []; });
  const port = server.address().port;
  const token = jwt.sign({ uid: USER.id }, process.env.JWT_SECRET, { algorithm: 'HS256' });

  const patch = (body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: `/api/projects/${PROJECT_ROWS[0].id}/leads/lead2`, method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let body = ''; res.on('data', c => body += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });

  // Even though the client sends a followUpDate here too, moving status
  // away from follow_up_later must clear it server-side regardless.
  const res = await patch({ status: 'rejected', followUpDate: '2026-03-01' });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'rejected');
  assert.equal(res.json.followUpDate, null);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test backend/routes/projects.test.js`
Expected: FAIL — both new tests get 404 (no matching route registered) since the PATCH route doesn't exist yet.

- [ ] **Step 4: Add the route**

In `backend/routes/projects.js`, immediately after `GET /:id/leads/:leadId` (currently ending at line 430, right before `router.post('/:id/webhook/test', ...)`):

```js
router.patch('/:id/leads/:leadId', authRequired, validate(schemas.leadPatch), async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const lead = await db.findOne('leads', { id: req.params.leadId, projectId: project.id });
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const patch = { ...req.body };
  if (patch.status && patch.status !== 'follow_up_later') {
    // Enforced server-side, not just hidden client-side, so a stale date
    // can't linger through a client bug or a direct API call.
    patch.followUpDate = null;
  }

  const updated = await db.update('leads', lead.id, patch);
  res.json(updated);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test backend/routes/projects.test.js`
Expected: PASS (all 5 tests in the file — the 3 pre-existing plus the 2 new ones)

- [ ] **Step 6: Commit**

```bash
git add backend/routes/projects.js backend/routes/projects.test.js
git commit -m "$(cat <<'EOF'
Add PATCH /api/projects/:id/leads/:leadId for lead status updates

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Status filter on `GET /api/projects/:id/leads`

**Files:**
- Modify: `backend/routes/projects.js:376-411` (the `GET /:id/leads` handler)
- Test: `backend/routes/projects.test.js`

This also fixes a latent bug in the existing handler: the count query's `FROM leads` had no `l` alias, yet `completeClause` referenced `l.complete` — this would throw a real Postgres error (`invalid reference to FROM-clause entry for table "l"`) any time `?complete=true` or `?complete=false` was actually requested against a live database. Rewriting both queries to share one aliased, parameterized clause-builder (matching the pattern `backend/routes/apiData.js` already uses) fixes this as a side effect of adding the new filter.

- [ ] **Step 1: Write the failing test**

Append to `backend/routes/projects.test.js`:

```js
test('GET /api/projects/:id/leads?status= filters by status via a bound parameter', async (t) => {
  delete require.cache[require.resolve('./projects')];
  const { router } = require('./projects');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', router);
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0);
  leadRows = [];
  t.after(() => { server.close(); leadRows = []; queryCalls = []; });
  const port = server.address().port;
  const token = jwt.sign({ uid: USER.id }, process.env.JWT_SECRET, { algorithm: 'HS256' });

  const get = (path) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(data) }); } catch (e) { reject(e); } });
    }).on('error', reject);
  });

  queryCalls = [];
  const res = await get(`/api/projects/${PROJECT_ROWS[0].id}/leads?status=contacted`);
  assert.equal(res.status, 200);
  const rowQuery = queryCalls.find(c => /FROM leads l\b/.test(c.sql));
  assert.match(rowQuery.sql, /l\.status = \$2/);
  assert.deepEqual(rowQuery.params.slice(0, 2), [PROJECT_ROWS[0].id, 'contacted']);

  // An unknown status value is ignored (falls back to unfiltered), same as
  // the existing complete=all default — never passed through to SQL.
  queryCalls = [];
  await get(`/api/projects/${PROJECT_ROWS[0].id}/leads?status=bogus`);
  const unfiltered = queryCalls.find(c => /FROM leads l\b/.test(c.sql));
  assert.equal(unfiltered.params.length, 3); // [project.id, pageSize, offset] only
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/routes/projects.test.js`
Expected: FAIL — `rowQuery` assertions fail because there's no `status` filter or bound parameter yet (and the current SQL has no `l` alias in the count query, though that specific failure mode isn't reachable through this stub since the stub doesn't execute real SQL — the filter behavior itself is what's missing and asserted here).

- [ ] **Step 3: Rewrite the handler**

Replace the entire `GET /:id/leads` handler (currently lines 376-411) with:

```js
const LEAD_STATUSES = ['new', 'contacted', 'replied', 'meeting_scheduled', 'google_meet_scheduled', 'follow_up_later', 'rejected', 'enrolled'];

router.get('/:id/leads', authRequired, async (req, res) => {
  const project = await db.findOne('projects', { id: req.params.id, userId: req.user.id });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { complete = 'all', status = 'all', page = 1, limit = 50 } = req.query;
  const pageNum  = Math.max(1, parseInt(page)  || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(limit) || 50));
  const offset   = (pageNum - 1) * pageSize;

  const fields = await db.findAll('captureFields', { projectId: project.id });
  const fieldMap = { name: 'Name', email: 'Email', ...Object.fromEntries(fields.map(f => [f.key, f.label])) };

  // Build WHERE clause for complete/status filters
  const clauses = ['l.project_id = $1'];
  const params = [project.id];
  if (complete === 'true')  clauses.push('l.complete = true');
  if (complete === 'false') clauses.push('l.complete = false');
  if (LEAD_STATUSES.includes(status)) { params.push(status); clauses.push(`l.status = $${params.length}`); }
  const where = clauses.join(' AND ');

  const [totalRow, leads] = await Promise.all([
    db.queryOne(`SELECT COUNT(*) AS total FROM leads l WHERE ${where}`, params),
    db.query(
      `SELECT l.*, s.created_at AS session_created_at
       FROM leads l
       LEFT JOIN sessions s ON s.id = l.session_id
       WHERE ${where}
       ORDER BY l.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    ),
  ]);

  const enriched = leads.map(l => ({ ...l, fieldLabels: fieldMap }));
  res.json({ leads: enriched, total: Number(totalRow.total), page: pageNum, limit: pageSize });
});
```

Place the `LEAD_STATUSES` constant just above this route (it's also reused by the new PATCH route's neighbors conceptually, but each file keeps its own copy per this codebase's existing convention of duplicating small enum lists rather than sharing a constants module — see `VOICES` in `validate.js` vs `public/project.html`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test backend/routes/projects.test.js`
Expected: PASS (all tests in the file, including the pre-existing lead-list test)

- [ ] **Step 5: Commit**

```bash
git add backend/routes/projects.js backend/routes/projects.test.js
git commit -m "$(cat <<'EOF'
Add status filter to GET /api/projects/:id/leads

Also fixes the count query's missing "l" alias, which would have
thrown against a real Postgres database whenever ?complete= was set.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Status filter + column on `GET /api/data/leads`

**Files:**
- Modify: `backend/routes/apiData.js:132-163`
- Test: `backend/routes/apiData.test.js`

- [ ] **Step 1: Write the failing test**

In `backend/routes/apiData.test.js`, insert right after the existing `/leads` assertions (currently lines 130-139, before the closing `});` of the single big test):

```js
  // ?status= appends a second bound param, same shape as ?complete=.
  queryCalls = []; queryOneCalls = [];
  await request(port, '/api/data/leads?status=replied', ownerToken);
  assert.match(queryOneCalls[0].sql, /l\.status = \$2/);
  assert.deepEqual(queryOneCalls[0].params, [OWNER.id, 'replied']);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test backend/routes/apiData.test.js`
Expected: FAIL — `queryOneCalls[0].sql` has no `l.status` clause yet.

- [ ] **Step 3: Update the handler**

In `backend/routes/apiData.js`, replace the `GET /leads` handler (currently lines 134-163) with:

```js
// GET /api/data/leads — every lead across every chatbot. ?complete=true|false
// and ?status=new|contacted|... filter the same way GET /api/projects/:id/leads does.
const LEAD_STATUSES = ['new', 'contacted', 'replied', 'meeting_scheduled', 'google_meet_scheduled', 'follow_up_later', 'rejected', 'enrolled'];

router.get('/leads', authRequired, async (req, res) => {
  const { projectId, categoryId, complete, status } = req.query;
  const { page, limit, offset } = pagination(req);
  const clauses = ['p.user_id = $1'];
  const params = [req.user.id];
  if (projectId) { params.push(projectId); clauses.push(`l.project_id = $${params.length}`); }
  if (categoryId) { params.push(categoryId); clauses.push(`p.category_id = $${params.length}`); }
  if (complete === 'true') clauses.push('l.complete = true');
  if (complete === 'false') clauses.push('l.complete = false');
  if (LEAD_STATUSES.includes(status)) { params.push(status); clauses.push(`l.status = $${params.length}`); }
  const where = clauses.join(' AND ');

  const [totalRow, leads] = await Promise.all([
    db.queryOne(
      `SELECT COUNT(*) AS total FROM leads l JOIN projects p ON p.id = l.project_id WHERE ${where}`,
      params
    ),
    db.query(
      `SELECT l.id, l.project_id, p.name AS chatbot_name, p.category_id, cc.name AS category_name,
              l.session_id, l.data, l.complete, l.status, l.follow_up_date, l.created_at, l.updated_at
         FROM leads l
         JOIN projects p ON p.id = l.project_id
         LEFT JOIN chatbot_categories cc ON cc.id = p.category_id
        WHERE ${where}
        ORDER BY l.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
  ]);
  res.json({ leads, total: Number(totalRow.total), page, limit });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test backend/routes/apiData.test.js`
Expected: PASS (the full existing test plus the new assertions, since it's all one `test(...)` block)

- [ ] **Step 5: Commit**

```bash
git add backend/routes/apiData.js backend/routes/apiData.test.js
git commit -m "$(cat <<'EOF'
Add status filter and column to GET /api/data/leads

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Frontend API client — `patchLead`

**Files:**
- Modify: `public/js/api.js:178-183`

- [ ] **Step 1: Add the method**

In `public/js/api.js`, right after `getLead` (currently line 183):

```js
  patchLead: (pid, lid, patch) => apiCall(`/api/projects/${pid}/leads/${lid}`, { method: 'PATCH', body: patch }),
```

- [ ] **Step 2: Commit**

```bash
git add public/js/api.js
git commit -m "$(cat <<'EOF'
Add API.patchLead client method

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

(No automated test — this repo has no frontend test runner; `npm test` only runs `backend/**/*.test.js`. Covered by the manual verification in Task 9.)

---

### Task 7: Leads table — status dropdown + follow-up date

**Files:**
- Modify: `public/project.html` (leads-tab JS, currently lines 3114-3186; leads-tab HTML, currently lines 932-959)

- [ ] **Step 1: Add the shared `LEAD_STATUSES` constant**

In `public/project.html`, right before `let leadsFilter = 'all';` (currently line 3115):

```js
  const LEAD_STATUSES = [
    { value: 'new', label: 'New' },
    { value: 'contacted', label: 'Contacted' },
    { value: 'replied', label: 'Replied' },
    { value: 'meeting_scheduled', label: 'Meeting Scheduled' },
    { value: 'google_meet_scheduled', label: 'Google Meet Scheduled' },
    { value: 'follow_up_later', label: 'Follow-Up Later' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'enrolled', label: 'Enrolled' },
  ];
  const LEAD_STATUS_LABELS = Object.fromEntries(LEAD_STATUSES.map(s => [s.value, s.label]));

  function leadStatusOptionsHtml(current) {
    return LEAD_STATUSES.map(s => `<option value="${s.value}" ${s.value === (current || 'new') ? 'selected' : ''}>${s.label}</option>`).join('');
  }
```

- [ ] **Step 2: Add the change handlers**

Right after `window.openLeadDetail = ...` closing `};` (currently line 3224, before `window.exportLeadsCsv`):

```js
  window.handleLeadStatusChange = async (leadId, selectEl, source) => {
    const status = selectEl.value;
    const row = allLeadsData.find(l => l.id === leadId);
    const prev = row ? row.status : 'new';
    try {
      await API.patchLead(projectId, leadId, { status });
      if (row) { row.status = status; if (status !== 'follow_up_later') row.followUpDate = null; }
      const dateInput = document.getElementById(`lead-followup-date-${source}-${leadId}`);
      if (dateInput) {
        dateInput.hidden = status !== 'follow_up_later';
        if (status !== 'follow_up_later') dateInput.value = '';
      }
      toast('Status updated', 'success');
    } catch (e) {
      selectEl.value = prev;
      toast(e.message, 'error');
    }
  };

  window.handleLeadFollowUpDateChange = async (leadId, inputEl) => {
    const followUpDate = inputEl.value || null;
    const row = allLeadsData.find(l => l.id === leadId);
    const prev = row ? row.followUpDate : null;
    try {
      await API.patchLead(projectId, leadId, { followUpDate });
      if (row) row.followUpDate = followUpDate;
      toast('Follow-up date updated', 'success');
    } catch (e) {
      inputEl.value = prev || '';
      toast(e.message, 'error');
    }
  };
```

`source` distinguishes the table-row instance of a lead's controls from the detail-panel instance (Task 8), so both can coexist in the DOM at once with unique element ids.

- [ ] **Step 3: Add the table column**

In the `loadLeads()` table header (currently line 3162), add a new header cell right after the existing "Status" header:

```html
              <th style="text-align:left;padding:8px 6px;font-weight:600;color:var(--text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em">Status</th>
              <th style="text-align:left;padding:8px 6px;font-weight:600;color:var(--text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em">Follow-up</th>
```

And in the row template (currently line 3167-3171), add a cell right after the existing complete/incomplete pill cell — the row's own `onclick="openLeadDetail(...)"` must not fire when interacting with the new controls, so the new `<td>` stops propagation:

```html
            ${leads.map(l => `
              <tr onclick="openLeadDetail('${l.id}')" style="cursor:pointer;border-bottom:1px solid var(--border)" onmouseover="this.style.background='var(--bg-3)'" onmouseout="this.style.background=''">
                <td style="padding:9px 6px;color:var(--text-dim)">${new Date(l.createdAt).toLocaleDateString()}</td>
                ${keys.map(k => `<td style="padding:9px 6px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape(l.data?.[k] || '—')}</td>`).join('')}
                <td style="padding:9px 6px"><span class="pill ${l.complete ? 'pill-success' : 'pill-warn'}">${l.complete ? '✓ Complete' : 'Partial'}</span></td>
                <td style="padding:9px 6px" onclick="event.stopPropagation()">
                  <select class="select" style="font-size:12px;padding:4px 6px;min-width:150px" onchange="handleLeadStatusChange('${l.id}', this, 'row')">${leadStatusOptionsHtml(l.status)}</select>
                  <input type="date" class="input" id="lead-followup-date-row-${l.id}" style="font-size:12px;padding:3px 6px;margin-top:4px;min-width:150px" value="${l.followUpDate || ''}" ${l.status === 'follow_up_later' ? '' : 'hidden'} onchange="handleLeadFollowUpDateChange('${l.id}', this)" onclick="event.stopPropagation()" />
                </td>
              </tr>`).join('')}
```

- [ ] **Step 4: Manual verification**

Run: `npm run dev` (or `npm start`), open a project's Leads tab in the browser, with at least one existing lead.
Expected:
- A "Follow-up" column appears with a dropdown defaulted to "New" (or whatever the lead's stored status is).
- Selecting "Follow-Up Later" reveals a date input in the same cell; selecting any other value hides it.
- Changing the dropdown persists after a page reload.
- Clicking the dropdown or date input does not open the lead detail panel; clicking elsewhere in the row still does.

- [ ] **Step 5: Commit**

```bash
git add public/project.html
git commit -m "$(cat <<'EOF'
Add follow-up status dropdown to the leads table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Lead detail panel — status dropdown + follow-up date

**Files:**
- Modify: `public/project.html` (`openLeadDetail`, currently lines 3191-3224)

- [ ] **Step 1: Add the controls to the detail card**

Replace the header block inside `openLeadDetail` (currently lines 3199-3203):

```html
      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <h3 style="font-size:15px;font-weight:600;margin:0">${new Date(lead.createdAt).toLocaleString()}</h3>
          <span class="pill ${lead.complete ? 'pill-success' : 'pill-warn'}">${lead.complete ? '✓ Complete' : 'Partial'}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
          <label class="muted text-sm" style="flex:0 0 auto">Follow-up status:</label>
          <select class="select" style="font-size:13px;padding:6px 8px;flex:1" onchange="handleLeadStatusChange('${lead.id}', this, 'detail')">${leadStatusOptionsHtml(lead.status)}</select>
          <input type="date" class="input" id="lead-followup-date-detail-${lead.id}" style="font-size:13px;padding:5px 8px;flex:1" value="${lead.followUpDate || ''}" ${lead.status === 'follow_up_later' ? '' : 'hidden'} onchange="handleLeadFollowUpDateChange('${lead.id}', this)" />
        </div>
```

(leave the rest of the function — the captured-data list and the conversation transcript — unchanged; only this header block changes, and the closing backtick/template stays where it already is)

Since `allLeadsData` (used by `handleLeadStatusChange` to find the row) is populated by `loadLeads()` for the currently-loaded page, and `openLeadDetail` fetches its own `lead` object separately via `API.getLead`, add the opened lead into `allLeadsData` if `loadLeads()` hasn't already put it there (it always will have, since detail is only ever opened by clicking a row already in the table) — no extra code needed here.

- [ ] **Step 2: Manual verification**

In the same browser session as Task 7's verification, click a lead row to open its detail panel.
Expected:
- The detail panel shows the same follow-up status dropdown (and conditional date input), pre-filled with the lead's current value.
- Changing it there updates the value; reopening the same lead (or reloading the table) shows the change reflected in the table row's dropdown too.

- [ ] **Step 3: Commit**

```bash
git add public/project.html
git commit -m "$(cat <<'EOF'
Add follow-up status dropdown to the lead detail panel

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Status filter dropdown + wiring

**Files:**
- Modify: `public/project.html` (filter bar HTML, currently lines 934-944; `loadLeads()`, currently lines 3131-3136)

- [ ] **Step 1: Add the filter dropdown to the HTML**

In the filter bar (currently lines 936-939), add a status filter select right after the existing All/Complete/Incomplete buttons:

```html
          <span class="muted text-sm" style="margin-right:4px">Filter:</span>
          <button class="btn btn-sm btn-primary" id="leads-filter-all" onclick="setLeadsFilter('all')">All</button>
          <button class="btn btn-sm btn-ghost" id="leads-filter-complete" onclick="setLeadsFilter('complete')">Complete</button>
          <button class="btn btn-sm btn-ghost" id="leads-filter-incomplete" onclick="setLeadsFilter('incomplete')">Incomplete</button>
          <select class="select" id="leads-status-filter" style="width:auto;font-size:13px;padding:6px 8px;margin-left:8px" onchange="setLeadsStatusFilter(this.value)">
            <option value="all">Any follow-up status</option>
          </select>
```

- [ ] **Step 2: Populate the status filter's options and wire it up**

In the leads-tab JS, right after the `LEAD_STATUSES`/`leadStatusOptionsHtml` block added in Task 7 Step 1, add:

```js
  document.getElementById('leads-status-filter').insertAdjacentHTML('beforeend', LEAD_STATUSES.map(s => `<option value="${s.value}">${s.label}</option>`).join(''));

  let leadsStatusFilter = 'all';
  function setLeadsStatusFilter(v) {
    leadsStatusFilter = v;
    leadsPage = 1;
    loadLeads();
  }
  window.setLeadsStatusFilter = setLeadsStatusFilter;
```

- [ ] **Step 3: Pass the filter into `API.listLeads`**

In `loadLeads()` (currently line 3136), change:

```js
      const { leads, total } = await API.listLeads(projectId, { complete, page: leadsPage, limit: LEADS_PAGE_SIZE });
```

to:

```js
      const { leads, total } = await API.listLeads(projectId, { complete, status: leadsStatusFilter, page: leadsPage, limit: LEADS_PAGE_SIZE });
```

- [ ] **Step 4: Manual verification**

In the browser, with a mix of leads at different statuses (set a few via Task 7's dropdown first):
Expected:
- The new "Any follow-up status" dropdown lists all 8 statuses.
- Picking one narrows the table to only leads with that status.
- It composes correctly with the existing Complete/Incomplete buttons (e.g. Complete + Contacted shows only leads matching both).
- Pagination still works correctly while a status filter is active.

- [ ] **Step 5: Commit**

```bash
git add public/project.html
git commit -m "$(cat <<'EOF'
Add follow-up status filter to the leads table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: CSV export columns

**Files:**
- Modify: `public/project.html` (`exportLeadsCsv`, currently lines 3226-3243)

- [ ] **Step 1: Add the columns**

Replace `exportLeadsCsv` with:

```js
  window.exportLeadsCsv = async () => {
    if (allLeadsData.length === 0) return toast('No leads to export', 'error');
    const fieldLabels = allLeadsData[0]?.fieldLabels || {};
    const keys = Object.keys(fieldLabels);
    const headers = ['id', 'date', ...keys.map(k => fieldLabels[k]), 'complete', 'status', 'follow_up_date'];
    const rows = [headers, ...allLeadsData.map(l => [
      l.id,
      new Date(l.createdAt).toISOString(),
      ...keys.map(k => l.data?.[k] || ''),
      l.complete ? 'yes' : 'no',
      LEAD_STATUS_LABELS[l.status] || l.status || 'New',
      l.followUpDate || '',
    ])];
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `leads-${projectId}.csv`;
    a.click();
  };
```

- [ ] **Step 2: Manual verification**

Click "Export CSV" in the browser with a few leads present (some with a non-default status, at least one with `follow_up_later` + a date set).
Expected: the downloaded CSV has `status` and `follow_up_date` columns, with human-readable status labels (e.g. "Follow-Up Later", not `follow_up_later`), and a populated date only for the snoozed lead.

- [ ] **Step 3: Commit**

```bash
git add public/project.html
git commit -m "$(cat <<'EOF'
Include follow-up status and date in leads CSV export

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Full backend test suite + end-to-end manual pass

- [ ] **Step 1: Run the full backend test suite**

Run: `npm test`
Expected: PASS — every test in `backend/**/*.test.js`, including all tests added in Tasks 2-5, with no regressions elsewhere.

- [ ] **Step 2: End-to-end manual walkthrough**

With the app running (`npm run dev`) and a project that has at least 2-3 leads:
1. Change a lead's status through each of the 8 values from the table row; confirm each persists across a page reload.
2. Set "Follow-Up Later" with a date, then change to "Rejected"; reload and confirm the date is gone (not just hidden) by switching back to "Follow-Up Later" and seeing an empty date field.
3. Open the detail panel for a lead and change its status there; confirm the table row reflects it after the next `loadLeads()` (switching filters or reloading the tab).
4. Use the new status filter dropdown, alone and combined with Complete/Incomplete, and confirm the result set and pagination are correct.
5. Export CSV and confirm the two new columns are present and correctly labeled.

- [ ] **Step 3: Report results**

If every check in Steps 1-2 passes, the feature is complete. If anything fails, note the exact failure and stop rather than proceeding — do not mark this task done with a failing check.
