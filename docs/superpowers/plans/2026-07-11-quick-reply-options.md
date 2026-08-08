# Quick-Reply Option Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users tap a button instead of typing when the avatar chat offers a set of choices, gated behind a new opt-in per-project setting.

**Architecture:** Reuse the existing `[[CAPTURE:key=value]]` tag convention (already proven to work silently in this exact audio-only Gemini Live session) with a new `[[OPTIONS:a|b|c]]` tag: the system prompt instructs the model to append it, the client strips it via regex and renders tappable pill buttons after the bot's message, and clicking one calls the existing `sendMessage()` exactly as if the user had typed it.

**Tech Stack:** Plain HTML/CSS/JS (`public/embed.html`, `public/css/embed.css`, `public/project.html`), Express routes (`backend/routes/projects.js`, `backend/routes/embed.js`), Postgres/Supabase (`supabase/schema.sql`). No test framework exists in this repo — verification is via `node -e` smoke checks, `curl`, and manual browser QA, matching the project's existing (test-framework-free) conventions.

**Spec:** `docs/superpowers/specs/2026-07-11-quick-reply-options-design.md`

---

### Task 1: Add `show_quick_replies` column to the database

**Files:**
- Modify: `supabase/schema.sql:56` (reference schema, for fresh installs)
- Run: a one-off Node script against the **live** Supabase database (connection comes from `.env`'s `DATABASE_URL` — never paste that value into any file)

⚠️ This is a real production database. The change itself is additive and safe (a nullable boolean column with a default, added via `IF NOT EXISTS`), but confirm with the user before running the live-DB step if you're executing this plan autonomously.

- [ ] **Step 1: Update the reference schema**

In `supabase/schema.sql`, find line 56:
```sql
  show_source_cards        BOOLEAN DEFAULT true,
```
Add a new line directly after it:
```sql
  show_source_cards        BOOLEAN DEFAULT true,
  show_quick_replies       BOOLEAN DEFAULT false,
```

- [ ] **Step 2: Apply the column to the live database**

Run from the project root (reads `DATABASE_URL` from `.env` via `dotenv`, already a dependency):
```bash
node -e "
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS show_quick_replies BOOLEAN DEFAULT false')
  .then(() => { console.log('column added (or already existed)'); return pool.end(); })
  .catch(e => { console.error(e); process.exit(1); });
"
```
Expected output: `column added (or already existed)`

- [ ] **Step 3: Verify the column exists**

```bash
node -e "
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query(\"SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name='projects' AND column_name='show_quick_replies'\")
  .then(r => { console.log(r.rows); return pool.end(); })
  .catch(e => { console.error(e); process.exit(1); });
"
```
Expected output: one row showing `show_quick_replies`, `boolean`, default `false`.

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql
git commit -m "$(cat <<'EOF'
Add show_quick_replies column to projects table

Backing column for the opt-in quick-reply option-buttons feature.
Applied to the live database directly; this commit just keeps
schema.sql current for fresh installs.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire the setting through the projects API

**Files:**
- Modify: `backend/routes/projects.js:52` (creation defaults), `backend/routes/projects.js:84` (PATCH allowlist)

- [ ] **Step 1: Add the default on project creation**

Find (line 52):
```js
    showSourceCards: true,
```
Change to:
```js
    showSourceCards: true,
    showQuickReplies: false,
```

- [ ] **Step 2: Allow it in PATCH**

Find (line 84):
```js
    'showBranding', 'showSourceCards', 'widgetOffsetX', 'widgetOffsetY',
```
Change to:
```js
    'showBranding', 'showSourceCards', 'showQuickReplies', 'widgetOffsetX', 'widgetOffsetY',
```

- [ ] **Step 3: Verify by creating a project via the running app**

Start the server if not already running:
```bash
npm run dev
```
In another terminal, sign in through the existing UI (or reuse an existing session token) and check a project record includes the new field:
```bash
curl -s http://localhost:8080/api/projects/<a-real-project-id> \
  -H "Authorization: Bearer <your-jwt>" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).project.showQuickReplies))"
```
Expected output: `false` (no error, and the key is present — confirms Task 1's column landed correctly and `insert()`/`findOne()` round-trip the new field without a "column does not exist" error).

- [ ] **Step 4: Commit**

```bash
git add backend/routes/projects.js
git commit -m "$(cat <<'EOF'
Add showQuickReplies to project defaults and PATCH allowlist

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Expose the setting to the embed widget config

**Files:**
- Modify: `backend/routes/embed.js:83`

- [ ] **Step 1: Add the field to the config response**

Find (line 83):
```js
        showSourceCards:       project.showSourceCards       !== false,
```
Add directly after it:
```js
        showSourceCards:       project.showSourceCards       !== false,
        showQuickReplies:      project.showQuickReplies      === true,
```

- [ ] **Step 2: Verify via curl**

With the dev server running and a known `publicId` for a test project:
```bash
curl -s http://localhost:8080/embed/<publicId>/config | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).project.showQuickReplies))"
```
Expected output: `false` (default, until Task 6's UI is used to flip it on).

- [ ] **Step 3: Commit**

```bash
git add backend/routes/embed.js
git commit -m "$(cat <<'EOF'
Expose showQuickReplies in the embed config endpoint

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Quick-reply button styling

**Files:**
- Modify: `public/css/embed.css:317` (insert new block after the existing quiz-card RTL rule, before the Flashcard section)

- [ ] **Step 1: Add the CSS**

Find:
```css
[dir="rtl"] .quiz-card { align-self: flex-end; }
[dir="rtl"] .quiz-option { text-align: right; }

/* ── Flashcard ─────────────────────────────────────────────── */
```
Replace with:
```css
[dir="rtl"] .quiz-card { align-self: flex-end; }
[dir="rtl"] .quiz-option { text-align: right; }

/* ── Quick-reply buttons ───────────────────────────────────── */
.quick-replies {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-self: flex-start;
  max-width: 90%;
  margin-top: -2px;
}
[dir="rtl"] .quick-replies { align-self: flex-end; }
.quick-reply {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease;
}
.quick-reply:hover:not(:disabled) { border-color: var(--accent); }
.quick-reply:disabled { cursor: default; opacity: .6; }
.quick-reply.selected { background: rgba(124,106,245,.18); border-color: var(--accent); opacity: 1; }

/* ── Flashcard ─────────────────────────────────────────────── */
```

- [ ] **Step 2: Verify the file is still valid CSS**

```bash
node -e "
const css = require('fs').readFileSync('public/css/embed.css', 'utf8');
const open = (css.match(/\{/g) || []).length;
const close = (css.match(/\}/g) || []).length;
console.log('braces balanced:', open === close, open, close);
"
```
Expected output: `braces balanced: true <N> <N>` (same number twice).

- [ ] **Step 3: Commit**

```bash
git add public/css/embed.css
git commit -m "$(cat <<'EOF'
Add quick-reply button styling

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `[[OPTIONS:...]]` tag — system prompt instruction and extraction

**Files:**
- Modify: `public/embed.html:114-115` (new state var), `public/embed.html:216-217` (system prompt assembly), `public/embed.html:916-942` (new sibling functions next to the capture-tag helpers)

- [ ] **Step 1: Add the `pendingOptions` state variable**

Find (lines 114-115):
```js
  let pendingSources = null;
  let pendingFigures = null;
```
Change to:
```js
  let pendingSources = null;
  let pendingFigures = null;
  let pendingOptions = null;
```

- [ ] **Step 2: Write `buildQuickReplyInstructions` and `extractOptionsTag`**

Find (lines 916-930, ending right before `const CAPTURE_TAG_RE`):
```js
  // ── Capture helpers ─────────────────────────────────────────
  function buildCaptureInstructions(fields) {
    if (!fields || fields.length === 0) return '';
    const fieldLines = fields.map(f =>
      `  - ${f.label} (key: ${f.key}, type: ${f.type}${f.required ? ', required' : ', optional'}${f.options ? ', options: ' + f.options.join('/') : ''})`
    ).join('\n');
    return `

LEAD CAPTURE INSTRUCTIONS: During this conversation, naturally collect the following details from the visitor. Weave the questions into the conversation — don't ask all at once. When you receive a value, output a tag on a new line in this exact format: [[CAPTURE:key=value]]
Do not mention the tag to the user — it will be stripped before display.

Fields to collect:
${fieldLines}

Always tag a value as soon as you receive it. If the visitor provides multiple values at once, emit one tag per line.`;
  }

  const CAPTURE_TAG_RE = /\[\[CAPTURE:([a-z][a-z0-9_]*)=([^\]]*)\]\]/g;

  function extractCaptureTags(text) {
    const tags = [];
    let clean = text.replace(CAPTURE_TAG_RE, (_, key, value) => {
      tags.push({ key, value: value.trim() });
      return '';
    });
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();
    return { clean, tags };
  }
```
Add directly after the closing brace of `extractCaptureTags`:
```js

  // ── Quick-reply helpers ──────────────────────────────────────
  function buildQuickReplyInstructions(enabled) {
    if (!enabled) return '';
    return `

QUICK REPLY INSTRUCTIONS: When you offer the user a small, closed set of choices to pick from (a menu of next steps, an either/or decision, a short list of topics) — and only then — append a line in this exact format after your response: [[OPTIONS:Choice one|Choice two|Choice three]]
Use 2 to 5 short options. Do not mention the tag to the user — it will be stripped before display and shown as tappable buttons. Do not use this for open-ended questions or when collecting free-text information.`;
  }

  const OPTIONS_TAG_RE = /\[\[OPTIONS:([^\]]+)\]\]/g;

  function extractOptionsTag(text) {
    let options = null;
    let clean = text.replace(OPTIONS_TAG_RE, (_, list) => {
      options = list.split('|').map(s => s.trim()).filter(Boolean).slice(0, 5);
      return '';
    });
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();
    return { clean, options };
  }
```

- [ ] **Step 3: Verify the regex logic in isolation**

```bash
node -e "
const OPTIONS_TAG_RE = /\[\[OPTIONS:([^\]]+)\]\]/g;
function extractOptionsTag(text) {
  let options = null;
  let clean = text.replace(OPTIONS_TAG_RE, (_, list) => {
    options = list.split('|').map(s => s.trim()).filter(Boolean).slice(0, 5);
    return '';
  });
  clean = clean.replace(/\n{3,}/g, '\n\n').trim();
  return { clean, options };
}
console.log(JSON.stringify(extractOptionsTag('Sure, want A or B?\n[[OPTIONS:Option A|Option B]]')));
console.log(JSON.stringify(extractOptionsTag('Just a normal reply with no tag.')));
console.log(JSON.stringify(extractOptionsTag('Too many: [[OPTIONS:1|2|3|4|5|6|7]]')));
"
```
Expected output (three lines):
```
{"clean":"Sure, want A or B?","options":["Option A","Option B"]}
{"clean":"Just a normal reply with no tag.","options":null}
{"clean":"Too many:","options":["1","2","3","4","5"]}
```

- [ ] **Step 4: Wire the instruction into the system prompt**

Find (lines 216-217):
```js
    captureFields = config.captureFields || [];
    const baseSystemPrompt = (config.project.systemPrompt || '') + buildCaptureInstructions(captureFields);
```
Change to:
```js
    captureFields = config.captureFields || [];
    const baseSystemPrompt = (config.project.systemPrompt || '')
      + buildCaptureInstructions(captureFields)
      + buildQuickReplyInstructions(config.project.showQuickReplies);
```

- [ ] **Step 5: Commit**

```bash
git add public/embed.html
git commit -m "$(cat <<'EOF'
Add [[OPTIONS:...]] tag convention for quick replies

Mirrors the existing [[CAPTURE:...]] mechanism: system prompt asks
the model to append the tag when offering a closed set of choices,
client extracts and strips it. Rendering wired up in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Render quick-reply buttons and wire click-to-send

**Files:**
- Modify: `public/embed.html:374-402` (`handleBotChunk`), `public/embed.html:486-510` (add `attachOptionButtons` after `attachSources`)

- [ ] **Step 1: Add `attachOptionButtons` next to `attachSources`**

Find (lines 486-510):
```js
  function attachSources(afterEl, sources) {
    if (!sources.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'sources';
    for (const s of sources) {
      const card = document.createElement('div');
      card.className = 'source-card';
      if (s.previewUrl) {
        const img = document.createElement('img');
        img.className = 'src-thumb'; img.src = s.previewUrl; img.alt = s.fileName || '';
        card.appendChild(img);
      } else {
        const ic = document.createElement('div');
        ic.className = 'src-icon';
        ic.textContent = ({ pdf:'📄', docx:'📝', text:'📃', audio:'🔊', video:'🎬', image:'🖼️', url:'🔗' })[s.kind] || '📎';
        card.appendChild(ic);
      }
      const lbl = document.createElement('div');
      lbl.className = 'src-label';
      lbl.textContent = s.fileName || '';
      card.appendChild(lbl);
      wrap.appendChild(card);
    }
    afterEl.parentNode.insertBefore(wrap, afterEl.nextSibling);
  }
```
Add directly after the closing brace:
```js

  function attachOptionButtons(afterEl, options) {
    if (!options || options.length < 2) return;
    const wrap = document.createElement('div');
    wrap.className = 'quick-replies';
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quick-reply';
      btn.textContent = opt;
      btn.addEventListener('click', () => {
        for (const b of wrap.querySelectorAll('.quick-reply')) b.disabled = true;
        btn.classList.add('selected');
        sendMessage(opt);
      });
      wrap.appendChild(btn);
    }
    afterEl.parentNode.insertBefore(wrap, afterEl.nextSibling);
  }
```

- [ ] **Step 2: Extract the options tag in `handleBotChunk` and render at flush time**

Find (lines 374-402):
```js
  function handleBotChunk(text) {
    const { clean, tags } = extractCaptureTags(text);
    if (tags.length) {
      for (const { key, value } of tags) sessionCapture[key] = value;
      scheduleSaveLead();
      updateCapturePanel();
    }

    if (!currentBotMsgEl) currentBotMsgEl = addMessage('bot', '');
    setMessageText(currentBotMsgEl, clean);
    botBuffer = clean;
    scrollToBottom();
    if (!panelOpen) bumpUnread();

    clearTimeout(botFlushTimer);
    botFlushTimer = setTimeout(() => {
      if (pendingSources && pendingSources.length && currentBotMsgEl) {
        attachSources(currentBotMsgEl, pendingSources);
        pendingSources = null;
      }
      if (pendingFigures && pendingFigures.length) {
        for (const fig of pendingFigures) renderFigureCard(fig);
        pendingFigures = null;
      }
      if (botBuffer) logTurn('assistant', botBuffer);
      botBuffer = '';
      currentBotMsgEl = null;
    }, 1500);
  }
```
Replace with:
```js
  function handleBotChunk(text) {
    const { clean: cleanCapture, tags } = extractCaptureTags(text);
    const { clean, options } = extractOptionsTag(cleanCapture);
    if (tags.length) {
      for (const { key, value } of tags) sessionCapture[key] = value;
      scheduleSaveLead();
      updateCapturePanel();
    }
    pendingOptions = options;

    if (!currentBotMsgEl) currentBotMsgEl = addMessage('bot', '');
    setMessageText(currentBotMsgEl, clean);
    botBuffer = clean;
    scrollToBottom();
    if (!panelOpen) bumpUnread();

    clearTimeout(botFlushTimer);
    botFlushTimer = setTimeout(() => {
      if (pendingSources && pendingSources.length && currentBotMsgEl) {
        attachSources(currentBotMsgEl, pendingSources);
        pendingSources = null;
      }
      if (pendingFigures && pendingFigures.length) {
        for (const fig of pendingFigures) renderFigureCard(fig);
        pendingFigures = null;
      }
      if (config.project.showQuickReplies && pendingOptions && currentBotMsgEl) {
        attachOptionButtons(currentBotMsgEl, pendingOptions);
      }
      pendingOptions = null;
      if (botBuffer) logTurn('assistant', botBuffer);
      botBuffer = '';
      currentBotMsgEl = null;
    }, 1500);
  }
```

- [ ] **Step 3: Verify no stray references and the file parses**

```bash
node --check public/embed.html 2>&1 | head -5 || true
node -e "
const html = require('fs').readFileSync('public/embed.html', 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
new Function(script);
console.log('script parses OK');
"
```
Expected output: `script parses OK` (a syntax error would throw before that line).

- [ ] **Step 4: Commit**

```bash
git add public/embed.html
git commit -m "$(cat <<'EOF'
Render quick-reply buttons and wire click-to-send

attachOptionButtons follows the attachSources pattern: inserted
after the bot bubble once it finalizes. Clicking a button disables
the group, marks the choice, and calls the existing sendMessage()
so it flows through retrieval + avatar reconnect like a typed turn.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Owner-facing settings toggle

**Files:**
- Modify: `public/project.html:193-199` (field markup), `public/project.html:689` (load), `public/project.html:787` (save)

- [ ] **Step 1: Add the settings field markup**

Find (lines 193-199):
```html
          <div class="field">
            <label>Show source cards</label>
            <select class="select" id="f-sources">
              <option value="true">Yes — cite the docs / URLs used</option>
              <option value="false">No</option>
            </select>
          </div>
```
Add directly after it:
```html
          <div class="field">
            <label>Show source cards</label>
            <select class="select" id="f-sources">
              <option value="true">Yes — cite the docs / URLs used</option>
              <option value="false">No</option>
            </select>
          </div>
          <div class="field">
            <label>Show quick-reply buttons</label>
            <select class="select" id="f-quickreplies">
              <option value="false">No</option>
              <option value="true">Yes — let visitors tap a choice instead of typing</option>
            </select>
            <span class="help">When the assistant offers a short menu of choices, show them as tappable buttons.</span>
          </div>
```

- [ ] **Step 2: Load the current value**

Find (line 689):
```js
      document.getElementById('f-sources').value   = String(p.showSourceCards !== false);
```
Add directly after it:
```js
      document.getElementById('f-sources').value   = String(p.showSourceCards !== false);
      document.getElementById('f-quickreplies').value = String(p.showQuickReplies === true);
```

- [ ] **Step 3: Save the value**

Find (line 787):
```js
        showSourceCards:      document.getElementById('f-sources').value === 'true',
```
Add directly after it:
```js
        showSourceCards:      document.getElementById('f-sources').value === 'true',
        showQuickReplies:     document.getElementById('f-quickreplies').value === 'true',
```

- [ ] **Step 4: Verify the file parses**

```bash
node -e "
const html = require('fs').readFileSync('public/project.html', 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
new Function(script);
console.log('script parses OK');
"
```
Expected output: `script parses OK`

- [ ] **Step 5: Commit**

```bash
git add public/project.html
git commit -m "$(cat <<'EOF'
Add owner-facing toggle for quick-reply buttons

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start the app**

```bash
npm run dev
```

- [ ] **Step 2: Enable the setting on a test project**

In the browser, open `/project.html?id=<a-test-project-id>` (or navigate via the dashboard), go to the Widget tab, set "Show quick-reply buttons" to Yes, click Save widget. Confirm the toast says "Widget & avatar settings saved".

- [ ] **Step 3: Drive a conversation that should trigger options**

Open the Preview tab (or `/e/<publicId>`), and type: `Should I reset my password or talk to support?` Confirm:
- The bot's reply never shows literal `[[OPTIONS:...]]` text.
- A row of pill buttons appears below the bot's message shortly after it finishes.
- The buttons show the actual choice text, not tag syntax.

- [ ] **Step 4: Click a button**

Click one of the buttons. Confirm:
- All buttons in that row become disabled.
- The clicked button is visually marked as selected.
- The chosen text appears as a new user message in the transcript.
- The bot responds to it normally (same as if it had been typed).

- [ ] **Step 5: Confirm the tag is never spoken aloud**

Listen through 2–3 turns that produce option tags. Confirm the avatar's voice never reads out "bracket bracket options" or similar — consistent with the existing `[[CAPTURE:...]]` behavior already confirmed in production.

- [ ] **Step 6: Confirm the opt-out path**

Toggle "Show quick-reply buttons" back to No, save, reload the preview, and ask the same question again. Confirm no buttons ever render, even if the reply happens to contain a numbered or lettered list.

- [ ] **Step 7: Confirm capture + options compose**

On a project that also has lead-capture fields configured, drive a conversation that both captures a field value and offers a choice in the same turn. Confirm both the capture panel updates and the option buttons render, with neither tag visible in the displayed text.
