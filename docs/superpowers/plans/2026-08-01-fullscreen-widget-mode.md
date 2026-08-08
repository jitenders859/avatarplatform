# Full-Screen Widget Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner configure the floating widget to open full-screen by default (separately for desktop and mobile), and optionally give visitors a header button to toggle full-screen themselves at runtime.

**Architecture:** Three new opt-in boolean project settings. `embed.html` decides the default at boot using pointer type (`matchMedia('(pointer: coarse)')`, the same signal already used to gate drag-to-reposition) and reflects state via a `data-fullscreen` attribute for in-iframe CSS. Because the widget is normally delivered as a small `<iframe>` that `embed-loader.js` sizes on the host page, real full-screen requires that loader script to resize the *outer* iframe too — driven by a `postMessage` from inside `embed.html`, with the loader snapshotting pre-fullscreen inline styles so restoring is exact (including after a drag reposition).

**Tech Stack:** Plain HTML/CSS/JS (`public/embed.html`, `public/css/embed.css`, `public/js/embed-loader.js`, `public/project.html`), Express routes (`backend/routes/projects.js`, `backend/routes/embed.js`), Postgres/Supabase (`supabase/schema.sql`). No test framework exists in this repo — verification is via `node -e` smoke checks, `curl`, and manual browser QA, matching the project's existing conventions.

**Spec:** `docs/superpowers/specs/2026-08-01-fullscreen-widget-mode-design.md`

---

### Task 1: Add full-screen columns to the database

**Files:**
- Modify: `supabase/schema.sql:57` (reference schema, for fresh installs)
- Run: a one-off Node script against the **live** Supabase database (connection comes from `.env`'s `DATABASE_URL` — never paste that value into any file)

⚠️ This is a real production database. The change itself is additive and safe (three nullable booleans with defaults, added via `IF NOT EXISTS`), but confirm with the user before running the live-DB step if you're executing this plan autonomously.

- [ ] **Step 1: Update the reference schema**

In `supabase/schema.sql`, find line 57:
```sql
  show_quick_replies       BOOLEAN DEFAULT false,
```
Add new lines directly after it:
```sql
  show_quick_replies       BOOLEAN DEFAULT false,
  full_screen_on_desktop   BOOLEAN DEFAULT false,
  full_screen_on_mobile    BOOLEAN DEFAULT false,
  show_full_screen_toggle  BOOLEAN DEFAULT false,
```

- [ ] **Step 2: Apply the columns to the live database**

Run from the project root (reads `DATABASE_URL` from `.env` via `dotenv`, already a dependency):
```bash
node -e "
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
Promise.all([
  pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS full_screen_on_desktop BOOLEAN DEFAULT false'),
  pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS full_screen_on_mobile BOOLEAN DEFAULT false'),
  pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS show_full_screen_toggle BOOLEAN DEFAULT false'),
])
  .then(() => { console.log('columns added (or already existed)'); return pool.end(); })
  .catch(e => { console.error(e); process.exit(1); });
"
```
Expected output: `columns added (or already existed)`

- [ ] **Step 3: Verify the columns exist**

```bash
node -e "
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query(\"SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name='projects' AND column_name LIKE '%full_screen%' ORDER BY column_name\")
  .then(r => { console.log(r.rows); return pool.end(); })
  .catch(e => { console.error(e); process.exit(1); });
"
```
Expected output: three rows (`full_screen_on_desktop`, `full_screen_on_mobile`, `show_full_screen_toggle`), each `boolean`, default `false`.

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql
git commit -m "$(cat <<'EOF'
Add full-screen widget mode columns to projects table

Backing columns for the opt-in full-screen mode feature. Applied to
the live database directly; this commit keeps schema.sql current
for fresh installs.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire the settings through the projects API

**Files:**
- Modify: `backend/routes/projects.js:53` (creation defaults), `backend/routes/projects.js:85` (PATCH allowlist)

- [ ] **Step 1: Add the defaults on project creation**

Find (line 52-54):
```js
    showSourceCards: true,
    showQuickReplies: false,
    widgetOffsetX: 0,
```
Change to:
```js
    showSourceCards: true,
    showQuickReplies: false,
    fullScreenOnDesktop: false,
    fullScreenOnMobile: false,
    showFullScreenToggle: false,
    widgetOffsetX: 0,
```

- [ ] **Step 2: Allow the fields in PATCH**

Find (line 85, now shifted by the Step 1 insertion — search for the text, not the line number):
```js
    'showBranding', 'showSourceCards', 'showQuickReplies', 'widgetOffsetX', 'widgetOffsetY',
```
Change to:
```js
    'showBranding', 'showSourceCards', 'showQuickReplies', 'widgetOffsetX', 'widgetOffsetY',
    'fullScreenOnDesktop', 'fullScreenOnMobile', 'showFullScreenToggle',
```

- [ ] **Step 3: Verify by fetching a project via the running app**

Start the server if not already running:
```bash
npm run dev
```
In another terminal, sign in through the existing UI (or reuse an existing session token) and check a project record includes the new fields:
```bash
curl -s http://localhost:8080/api/projects/<a-real-project-id> \
  -H "Authorization: Bearer <your-jwt>" | node -e "
process.stdin.on('data', d => {
  const p = JSON.parse(d).project;
  console.log(p.fullScreenOnDesktop, p.fullScreenOnMobile, p.showFullScreenToggle);
});"
```
Expected output: `false false false` (no error — confirms Task 1's columns landed and `insert()`/`findOne()` round-trip the new fields without a "column does not exist" error).

- [ ] **Step 4: Commit**

```bash
git add backend/routes/projects.js
git commit -m "$(cat <<'EOF'
Add full-screen mode settings to project defaults and PATCH allowlist

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Expose the settings to the embed widget config

**Files:**
- Modify: `backend/routes/embed.js:84`

- [ ] **Step 1: Add the fields to the config response**

Find (line 83-84):
```js
        showSourceCards:       project.showSourceCards       !== false,
        showQuickReplies:      project.showQuickReplies      === true,
```
Add directly after it:
```js
        showSourceCards:       project.showSourceCards       !== false,
        showQuickReplies:      project.showQuickReplies      === true,
        fullScreenOnDesktop:   project.fullScreenOnDesktop   === true,
        fullScreenOnMobile:    project.fullScreenOnMobile    === true,
        showFullScreenToggle:  project.showFullScreenToggle  === true,
```

- [ ] **Step 2: Verify via curl**

With the dev server running and a known `publicId` for a test project:
```bash
curl -s http://localhost:8080/embed/<publicId>/config | node -e "
process.stdin.on('data', d => {
  const p = JSON.parse(d).project;
  console.log(p.fullScreenOnDesktop, p.fullScreenOnMobile, p.showFullScreenToggle);
});"
```
Expected output: `false false false` (defaults, until Task 8's UI is used to flip them on).

- [ ] **Step 3: Commit**

```bash
git add backend/routes/embed.js
git commit -m "$(cat <<'EOF'
Expose full-screen mode settings in the embed config endpoint

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Full-screen panel styling

**Files:**
- Modify: `public/css/embed.css:157-162` (insert new block after `panelIn` keyframes, before the Header section)

- [ ] **Step 1: Add the CSS**

Find:
```css
.widget-root[data-position="bottom-left"] .panel { transform-origin: bottom left; }
@keyframes panelIn {
  from { opacity: 0; transform: scale(.95) translateY(10px); }
  to   { opacity: 1; transform: scale(1)   translateY(0); }
}

/* ── Header ────────────────────────────────────────────────── */
```
Replace with:
```css
.widget-root[data-position="bottom-left"] .panel { transform-origin: bottom left; }
@keyframes panelIn {
  from { opacity: 0; transform: scale(.95) translateY(10px); }
  to   { opacity: 1; transform: scale(1)   translateY(0); }
}

/* ── Full-screen mode ─────────────────────────────────────────
   Higher specificity than the [data-position] and mobile-media-query
   .panel rules (three selector terms vs one/two), so this wins
   regardless of source order — works whether or not the outer iframe
   actually resized (public/js/embed-loader.js), so a widget embedded
   via the raw <iframe> snippet or the project.html Preview tab still
   degrades to "fill whatever box it's given" rather than doing nothing. */
.widget-root[data-fullscreen="1"] {
  top: 0; right: 0; bottom: 0; left: 0;
}
.widget-root[data-fullscreen="1"] .panel {
  width: 100%; height: 100%; max-height: none; border-radius: 0;
}

/* ── Header ────────────────────────────────────────────────── */
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
Add full-screen panel styling

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `embed.html` — header button, state, and boot-time default

**Files:**
- Modify: `public/embed.html:49` (header markup), `public/embed.html:124` (state var), `public/embed.html:143` (DOM const), `public/embed.html:170-173` (boot() logic)

- [ ] **Step 1: Add the header button markup**

Find (lines 49-51):
```html
        <button class="icon-btn" id="minimize-btn" title="Minimize" aria-label="Minimize">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg>
        </button>
```
Change to:
```html
        <button class="icon-btn" id="fullscreen-btn" title="Full screen" aria-label="Full screen" hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>
        </button>
        <button class="icon-btn" id="minimize-btn" title="Minimize" aria-label="Minimize">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg>
        </button>
```

- [ ] **Step 2: Add the `fullscreenActive` state variable**

Find (line 124):
```js
  let panelOpen = true;
```
Change to:
```js
  let panelOpen = true;
  let fullscreenActive = false;
```

- [ ] **Step 3: Add the DOM constant**

Find (line 143):
```js
  const minimizeBtn       = document.getElementById('minimize-btn');
```
Change to:
```js
  const minimizeBtn       = document.getElementById('minimize-btn');
  const fullscreenBtn     = document.getElementById('fullscreen-btn');
```

- [ ] **Step 4: Compute the boot-time default in `boot()`**

Find (lines 170-173):
```js
    if (config.project.capabilityTier === 'advanced') {
      quizBtn.style.display = '';
      progressBtn.style.display = '';
    }
```
Add directly after it:
```js

    // Full-screen mode: desktop/mobile decided by pointer type, not
    // viewport width — the iframe's own rendered box is small (≤400px)
    // regardless of the host device, so a width check would always
    // read "mobile". Not applicable to 'inline' (already full-bleed).
    if (position !== 'inline') {
      const isMobileDevice = window.matchMedia('(pointer: coarse)').matches;
      fullscreenActive = isMobileDevice
        ? !!config.project.fullScreenOnMobile
        : !!config.project.fullScreenOnDesktop;
      root.dataset.fullscreen = fullscreenActive ? '1' : '0';
      if (config.project.showFullScreenToggle) {
        fullscreenBtn.hidden = false;
        updateFullscreenIcon();
      }
    }
```

- [ ] **Step 5: Verify the file parses**

```bash
node -e "
const html = require('fs').readFileSync('public/embed.html', 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
new Function(script);
console.log('script parses OK');
"
```
Expected output: `script parses OK`. (`updateFullscreenIcon` isn't defined until Task 6, but `new Function(...)` only parses/compiles the script — it doesn't execute `boot()` — so an undefined reference at this point is not a syntax error and won't surface here.)

- [ ] **Step 6: Commit**

```bash
git add public/embed.html
git commit -m "$(cat <<'EOF'
Add full-screen header button and boot-time default

Desktop/mobile default decided by pointer type. Icon wiring and
click behavior land in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `embed.html` — toggle behavior and drag guard

**Files:**
- Modify: `public/embed.html` — add `updateFullscreenIcon` near `applyDirection`, update `openPanel()`, add click handler near `minimizeBtn`'s listener, guard `setupDrag()`

- [ ] **Step 1: Add `updateFullscreenIcon`**

Find:
```js
  function applyDirection(setting) {
    let dir = setting;
    if (setting === 'auto') {
      dir = detectDirection(config.project.welcomeMessage || '') || 'ltr';
    }
    document.documentElement.dir = dir;
    document.documentElement.lang = dir === 'rtl' ? 'ar' : 'en';
  }
```
Add directly after it:
```js

  function updateFullscreenIcon() {
    fullscreenBtn.innerHTML = fullscreenActive
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v4a2 2 0 0 1-2 2H3M15 3v4a2 2 0 0 0 2 2h4M9 21v-4a2 2 0 0 0-2-2H3M15 21v-4a2 2 0 0 1 2-2h4"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>';
    fullscreenBtn.title = fullscreenActive ? 'Exit full screen' : 'Full screen';
    fullscreenBtn.setAttribute('aria-label', fullscreenBtn.title);
  }
```

- [ ] **Step 2: Notify the parent of the initial full-screen state on open**

Find (inside `openPanel()`):
```js
    notifyParent({ type: 'open' });
```
Change to:
```js
    notifyParent({ type: 'open', fullscreen: fullscreenActive });
```

- [ ] **Step 3: Add the click handler**

Find:
```js
  launcher.addEventListener('click', openPanel);
  minimizeBtn.addEventListener('click', () => closePanel());
```
Change to:
```js
  launcher.addEventListener('click', openPanel);
  minimizeBtn.addEventListener('click', () => closePanel());
  fullscreenBtn.addEventListener('click', () => {
    fullscreenActive = !fullscreenActive;
    root.dataset.fullscreen = fullscreenActive ? '1' : '0';
    updateFullscreenIcon();
    notifyParent({ type: 'fullscreen', enabled: fullscreenActive });
  });
```

- [ ] **Step 4: Guard drag-to-reposition while full-screen**

Find (inside `setupDrag()`):
```js
    const headerEl = document.getElementById('header');
    const minBtn   = document.getElementById('minimize-btn');

    headerEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (minBtn.contains(e.target)) return;
      headerEl.style.cursor = 'grabbing';
      notifyParent({ type: 'drag-start' });
    });
```
Change to:
```js
    const headerEl = document.getElementById('header');
    const minBtn   = document.getElementById('minimize-btn');
    const fsBtn    = document.getElementById('fullscreen-btn');

    headerEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (minBtn.contains(e.target) || fsBtn.contains(e.target)) return;
      if (root.dataset.fullscreen === '1') return;
      headerEl.style.cursor = 'grabbing';
      notifyParent({ type: 'drag-start' });
    });
```

- [ ] **Step 5: Verify the file parses**

```bash
node -e "
const html = require('fs').readFileSync('public/embed.html', 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
new Function(script);
console.log('script parses OK');
"
```
Expected output: `script parses OK`

- [ ] **Step 6: Commit**

```bash
git add public/embed.html
git commit -m "$(cat <<'EOF'
Wire full-screen toggle behavior and disable drag while full-screen

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `embed-loader.js` — resize the real host-page iframe

**Files:**
- Modify: `public/js/embed-loader.js` — doc comment, state vars, new `setFullscreenIframe` helper, message-bus handlers

This is the part that makes full-screen mode actually cover the host page, not just fill a small box — see the spec's "Key constraint" note.

- [ ] **Step 1: Update the doc comment**

Find:
```js
 *   4. Resizes the iframe wrapper on open/close postMessages from inside.
 *   5. Enables drag-to-reposition on desktop (pointer: fine). A transparent
 *      overlay captures pointermove/pointerup during the drag so events
 *      don't get swallowed by the iframe. Final position is persisted to
 *      localStorage keyed by publicId.
 */
```
Change to:
```js
 *   4. Resizes the iframe wrapper on open/close postMessages from inside.
 *   5. Enables drag-to-reposition on desktop (pointer: fine). A transparent
 *      overlay captures pointermove/pointerup during the drag so events
 *      don't get swallowed by the iframe. Final position is persisted to
 *      localStorage keyed by publicId.
 *   6. Expands the iframe to cover the whole viewport on a 'fullscreen'
 *      postMessage (or an 'open' message carrying { fullscreen: true }),
 *      snapshotting the prior inline styles so restoring is exact.
 */
```

- [ ] **Step 2: Add the `preFullscreenStyle` state variable**

Find:
```js
  // ── State ──────────────────────────────────────────────────────
  let iframe      = null;
  let panelOpen   = false;
  let position    = 'bottom-right';  // 'bottom-right' | 'bottom-left' | 'inline'
  let iframeReady = false;           // true once iframe fires the 'ready' postMessage
  let pendingOpen = false;           // user clicked placeholder before iframe was ready
  let placeholder = null;            // FAB shown while iframe loads
```
Change to:
```js
  // ── State ──────────────────────────────────────────────────────
  let iframe      = null;
  let panelOpen   = false;
  let position    = 'bottom-right';  // 'bottom-right' | 'bottom-left' | 'inline'
  let iframeReady = false;           // true once iframe fires the 'ready' postMessage
  let pendingOpen = false;           // user clicked placeholder before iframe was ready
  let placeholder = null;            // FAB shown while iframe loads
  let preFullscreenStyle = null;     // snapshot of inline styles before entering full-screen
```

- [ ] **Step 3: Add the `setFullscreenIframe` helper**

Find:
```js
  // ── Helpers ────────────────────────────────────────────────────
  function sendToIframe(data) {
```
Change to:
```js
  // ── Helpers ────────────────────────────────────────────────────
  // Snapshots live inline styles before overriding them, so restoring
  // is exact even if the widget was dragged to a custom position first.
  function setFullscreenIframe(enabled) {
    if (enabled) {
      if (!preFullscreenStyle) {
        preFullscreenStyle = {
          top: iframe.style.top, left: iframe.style.left,
          right: iframe.style.right, bottom: iframe.style.bottom,
          width: iframe.style.width, height: iframe.style.height,
        };
      }
      Object.assign(iframe.style, { top: '0', left: '0', right: '0', bottom: '0', width: '', height: '' });
    } else if (preFullscreenStyle) {
      Object.assign(iframe.style, preFullscreenStyle);
      preFullscreenStyle = null;
    }
  }

  function sendToIframe(data) {
```

- [ ] **Step 4: Handle the `open`/`close`/`fullscreen` messages**

Find:
```js
    // ── Open / close resize ──────────────────────────────────────
    if (iframe.style.position !== 'fixed') return; // inline mode

    if (data.type === 'open') {
      panelOpen = true;
      iframe.style.width  = `min(${OPEN_W}px, calc(100vw - ${OFFSET_X * 2 + 8}px))`;
      iframe.style.height = `min(${OPEN_H}px, calc(100vh - ${OFFSET_Y + 8}px))`;
    } else if (data.type === 'close') {
      panelOpen = false;
      iframe.style.width  = CLOSED_W + 'px';
      iframe.style.height = CLOSED_H + 'px';
    }
  });
})();
```
Change to:
```js
    // ── Open / close resize ──────────────────────────────────────
    if (iframe.style.position !== 'fixed') return; // inline mode

    if (data.type === 'open') {
      panelOpen = true;
      if (data.fullscreen) {
        setFullscreenIframe(true);
      } else {
        iframe.style.width  = `min(${OPEN_W}px, calc(100vw - ${OFFSET_X * 2 + 8}px))`;
        iframe.style.height = `min(${OPEN_H}px, calc(100vh - ${OFFSET_Y + 8}px))`;
      }
    } else if (data.type === 'close') {
      panelOpen = false;
      setFullscreenIframe(false);
      iframe.style.width  = CLOSED_W + 'px';
      iframe.style.height = CLOSED_H + 'px';
    } else if (data.type === 'fullscreen') {
      if (!panelOpen) return;
      setFullscreenIframe(!!data.enabled);
    }
  });
})();
```

- [ ] **Step 5: Verify the file parses**

```bash
node --check public/js/embed-loader.js && echo "syntax OK"
```
Expected output: `syntax OK`

- [ ] **Step 6: Commit**

```bash
git add public/js/embed-loader.js
git commit -m "$(cat <<'EOF'
Resize the host-page iframe for full-screen widget mode

setFullscreenIframe snapshots pre-fullscreen inline styles so
restoring returns to the exact prior floating position, including
after a drag reposition. Guarded the same way existing open/close
resize logic already is: skipped entirely for inline-mode embeds.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Owner-facing settings UI

**Files:**
- Modify: `public/project.html` — field markup (Widget tab), load, save

- [ ] **Step 1: Add the settings field markup**

Find:
```html
          <div class="field">
            <label>Show quick-reply buttons</label>
            <select class="select" id="f-quickreplies">
              <option value="false">No</option>
              <option value="true">Yes — let visitors tap a choice instead of typing</option>
            </select>
            <span class="help">When the assistant offers a short menu of choices, show them as tappable buttons.</span>
          </div>
          <div class="field">
            <label>Show "Powered by" branding</label>
```
Change to:
```html
          <div class="field">
            <label>Show quick-reply buttons</label>
            <select class="select" id="f-quickreplies">
              <option value="false">No</option>
              <option value="true">Yes — let visitors tap a choice instead of typing</option>
            </select>
            <span class="help">When the assistant offers a short menu of choices, show them as tappable buttons.</span>
          </div>
          <div class="field">
            <label>Full-screen on desktop</label>
            <select class="select" id="f-fullscreen-desktop">
              <option value="false">No — floating panel (default)</option>
              <option value="true">Yes — open panel fills the screen</option>
            </select>
            <span class="help">No effect when Position is Inline.</span>
          </div>
          <div class="field">
            <label>Full-screen on mobile</label>
            <select class="select" id="f-fullscreen-mobile">
              <option value="false">No — floating panel (default)</option>
              <option value="true">Yes — open panel fills the screen</option>
            </select>
            <span class="help">No effect when Position is Inline.</span>
          </div>
          <div class="field">
            <label>Show maximize/restore button</label>
            <select class="select" id="f-fullscreen-toggle">
              <option value="false">No</option>
              <option value="true">Yes — let visitors switch modes themselves</option>
            </select>
            <span class="help">Adds a header button so visitors can toggle full screen regardless of the defaults above.</span>
          </div>
          <div class="field">
            <label>Show "Powered by" branding</label>
```

- [ ] **Step 2: Load the current values**

Find:
```js
      document.getElementById('f-quickreplies').value = String(p.showQuickReplies === true);
```
Change to:
```js
      document.getElementById('f-quickreplies').value = String(p.showQuickReplies === true);
      document.getElementById('f-fullscreen-desktop').value = String(p.fullScreenOnDesktop === true);
      document.getElementById('f-fullscreen-mobile').value  = String(p.fullScreenOnMobile === true);
      document.getElementById('f-fullscreen-toggle').value  = String(p.showFullScreenToggle === true);
```

- [ ] **Step 3: Save the values**

Find:
```js
        showQuickReplies:     document.getElementById('f-quickreplies').value === 'true',
```
Change to:
```js
        showQuickReplies:     document.getElementById('f-quickreplies').value === 'true',
        fullScreenOnDesktop:  document.getElementById('f-fullscreen-desktop').value === 'true',
        fullScreenOnMobile:   document.getElementById('f-fullscreen-mobile').value === 'true',
        showFullScreenToggle: document.getElementById('f-fullscreen-toggle').value === 'true',
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
Add owner-facing settings for full-screen widget mode

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: End-to-end manual verification

**Files:** none (verification only). This exercises the real host-page iframe resize from Task 7, which the Preview tab's iframe (embedded directly, not via `embed-loader.js`) cannot — build a minimal local HTML file that uses the loader script, per the snippet already shown on the project's Embed tab.

- [ ] **Step 1: Start the app**

```bash
npm run dev
```

- [ ] **Step 2: Build a test host page**

Create a scratch file (not committed) that mirrors the Embed tab's script snippet, e.g. `/tmp/fullscreen-test.html`:
```html
<!doctype html>
<html><body style="margin:0">
  <h1>Host page content</h1>
  <script src="http://localhost:8080/js/embed-loader.js" data-bot="<publicId>" defer></script>
</body></html>
```
Replace `<publicId>` with a real test project's public ID (from its project.html page or the Embed tab). Open the file directly in a browser (`file://...` works; the loader fetches config via absolute `http://localhost:8080` URLs).

- [ ] **Step 3: Configure and verify the desktop default**

In `project.html`'s Widget tab for that project: set "Full-screen on desktop" to Yes, "Full-screen on mobile" to No, save. Reload the test host page in a normal desktop browser window and click the launcher. Confirm the widget expands to cover the entire browser viewport (not just a bigger corner box), and the host page's own content is fully covered.

- [ ] **Step 4: Verify the mobile default is independent**

With the same settings, open Chrome DevTools device emulation (a touch-enabled mobile profile) and reload the test page. Click the launcher. Confirm it opens as the normal small floating panel (mobile default is still No) — proving desktop/mobile are decided independently.

Then flip the settings (Desktop: No, Mobile: Yes), save, reload in the same mobile emulation profile, and confirm it now opens full-screen there instead.

- [ ] **Step 5: Verify the maximize/restore toggle**

Set "Show maximize/restore button" to Yes (leave both full-screen defaults off), save, reload the test page on desktop. Open the widget (starts floating, small icon in header). Click the maximize icon — confirm the widget expands to full-screen and the icon changes to a "restore" glyph. Click it again — confirm it returns to exactly its prior floating position and size (not shifted).

- [ ] **Step 6: Verify restore-after-drag**

With the maximize/restore button on, open the widget and drag it (via the header) to a different corner of the screen. Click maximize, then click restore. Confirm it returns to the dragged position, not the original default corner.

- [ ] **Step 7: Verify drag is disabled while full-screen**

While the widget is full-screen, try to drag the header. Confirm nothing happens (no drag-start, cursor doesn't change to grabbing).

- [ ] **Step 8: Verify `inline` position is unaffected**

Set Position to "Inline (full iframe)" with all three full-screen settings on, save. Reload the test page (or the plain `<iframe>` embed snippet). Confirm no maximize/restore button appears and behavior is unchanged from before this feature existed.

- [ ] **Step 9: Verify closing from full-screen**

With the widget full-screen (either via a default or the toggle), click minimize. Confirm it collapses back to the small FAB in its correct corner — not stuck full-screen or misplaced. Reopen it and confirm it still respects the configured default.

- [ ] **Step 10: Regression check — everything off**

Set all three settings back to off/No, save. Confirm the widget behaves exactly as it did before this feature (small floating panel, no header button, drag works normally).
