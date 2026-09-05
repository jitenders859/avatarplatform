# Lipsync speed-up + character-only fullscreen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the avatar's lipsync feel snappier, and add an opt-in per-project setting that lets a visitor click the avatar (while the chat panel is open) to expand it into a character-only fullscreen view with all chat chrome hidden, click again to return to normal.

**Architecture:** Two independent slices. (1) A pure constant-tuning change in `public/lipsync-sdk.js`'s viseme timing defaults. (2) A new boolean project setting (`showCharacterFullscreen`) that flows DB → validation → embed config API → owner settings UI → widget runtime, following the exact pattern the existing `showFullScreenToggle`/whole-panel-fullscreen feature already established. The new character-fullscreen state (`root.dataset.characterFullscreen`) is kept independent from the existing `root.dataset.fullscreen` state so the already-shipped whole-panel fullscreen feature is not touched or risked.

**Tech Stack:** Vanilla JS (`public/embed.html`, `public/js/embed-loader.js`, `public/lipsync-sdk.js`), plain CSS (`public/css/embed.css`), Express + Zod (`backend/routes/embed.js`, `backend/middleware/validate.js`), Postgres/Supabase (`supabase/schema.sql`), `node:test` for backend tests.

**Spec:** `docs/superpowers/specs/2026-08-28-lipsync-speed-and-character-fullscreen-design.md`

---

### Task 1: Speed up lipsync timing constants

**Files:**
- Modify: `public/lipsync-sdk.js:1104-1109`

- [ ] **Step 1: Change the three timing defaults**

In the `LipsyncAvatar` constructor's option defaults, change:

```js
        visemePeakRatio: 0.88,
        visemeOverlapMs: 35,
        visemeSmoothingMs: 90,
        // Hybrid lip-sync params
        anticipationMs: 40,      // pre-roll mouth N ms before phoneme starts
        minVisemeMs: 50,         // minimum hold per viseme (prevents flutter on fast consonants)
```

to:

```js
        visemePeakRatio: 0.88,
        visemeOverlapMs: 18,
        visemeSmoothingMs: 45,
        // Hybrid lip-sync params
        anticipationMs: 20,      // pre-roll mouth N ms before phoneme starts
        minVisemeMs: 50,         // minimum hold per viseme (prevents flutter on fast consonants)
```

`visemePeakRatio` and `minVisemeMs` are unchanged — they shape a viseme's ramp curve and floor hold time, not the overall lag.

- [ ] **Step 2: Rebuild the minified SDK**

The widget loads `public/lipsync-sdk.min.js` first, falling back to the unminified source only on error (`embed.html:19`), so the minified build must be regenerated or the change won't be visible in production.

Run: `npm run build`
Expected: exits 0, `public/lipsync-sdk.min.js` timestamp updates.

- [ ] **Step 3: Manually verify in a real widget**

No automated harness exists for the embed widget's runtime behavior. Serve the app locally, open a test project's widget, and speak/type to trigger a voice response.

Confirm:
- Mouth movement visibly tracks speech more tightly than before (less lag between audio and mouth shape).
- No new jitter/flutter — consecutive visemes still blend smoothly, no visible "snapping."
- Rapid, sibilant-heavy speech doesn't show gaps between visemes (would indicate `visemeOverlapMs: 18` is too low).

- [ ] **Step 4: Commit**

```bash
git add public/lipsync-sdk.js public/lipsync-sdk.min.js
git commit -m "perf: speed up lipsync mouth response (halve smoothing/overlap/anticipation)"
```

---

### Task 2: Add `show_character_fullscreen` column

**Files:**
- Modify: `supabase/schema.sql:62`
- Create: `supabase/migrations/2026-08-28_add_character_fullscreen.sql`

- [ ] **Step 1: Add the column to schema.sql**

In the `projects` table's "Widget" group, right after `show_full_screen_toggle`:

```sql
  full_screen_on_desktop   BOOLEAN DEFAULT false,
  full_screen_on_mobile    BOOLEAN DEFAULT false,
  show_full_screen_toggle  BOOLEAN DEFAULT false,
  show_character_fullscreen BOOLEAN DEFAULT false,
```

- [ ] **Step 2: Write the standalone migration file**

This project has no migration runner (confirmed by the pattern used in every file under `supabase/migrations/`) — `schema.sql` is the source of truth, and each migration file is a dated, standalone record that can also be run directly against an existing database.

```sql
-- ═══════════════════════════════════════════════════════════════════
-- Migration: character-only fullscreen mode — lets a visitor click the
-- avatar (while the chat panel is open) to expand it to a chrome-free,
-- character-only fullscreen view. Opt-in per project; independent of the
-- existing full_screen_on_desktop/mobile + show_full_screen_toggle
-- fields, which control the whole *panel* going fullscreen, not the
-- character-only, chat-chrome-hidden mode this adds.
--
-- This project has no migration runner — supabase/schema.sql is the single
-- idempotent source of truth, re-run in full against an existing database
-- to apply new changes. The statement below is already appended to
-- schema.sql; this file is a standalone, dated record of *why* it was
-- added, and can also be run directly:
--   psql $DATABASE_URL -f supabase/migrations/2026-08-28_add_character_fullscreen.sql
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE projects ADD COLUMN IF NOT EXISTS show_character_fullscreen BOOLEAN DEFAULT false;
```

- [ ] **Step 3: Confirm the column is picked up by the camelCase row mapper**

`backend/db.js` converts snake_case columns to camelCase automatically (verified — no per-field mapping list exists elsewhere), so `show_character_fullscreen` becomes `project.showCharacterFullscreen` on any row read through `db.findOne`/`db.query` with no additional code. Nothing to change here — this step is just confirming the assumption before Task 3 relies on it.

Run: `grep -n "camelCase\|snake_case" backend/db.js`
Expected: shows the conversion logic exists (already confirmed during planning — this is a sanity check, not new work).

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql supabase/migrations/2026-08-28_add_character_fullscreen.sql
git commit -m "feat: add show_character_fullscreen project column"
```

---

### Task 3: Backend — validation, creation default, embed config

**Files:**
- Modify: `backend/middleware/validate.js:103`
- Modify: `backend/routes/projects.js:109`
- Modify: `backend/routes/embed.js:172`
- Modify: `backend/routes/embed.test.js`

- [ ] **Step 1: Add the field to the PATCH validation schema**

In `patchProject`, right after the existing fullscreen fields:

```js
    fullScreenOnDesktop: z.boolean().optional(),
    fullScreenOnMobile: z.boolean().optional(),
    showFullScreenToggle: z.boolean().optional(),
    showCharacterFullscreen: z.boolean().optional(),
```

- [ ] **Step 2: Add the field to project-creation defaults**

In the new-project defaults object, right after the existing fullscreen defaults:

```js
    fullScreenOnDesktop: false,
    fullScreenOnMobile: false,
    showFullScreenToggle: false,
    showCharacterFullscreen: false,
```

- [ ] **Step 3: Write the failing test for the config route**

Add to `backend/routes/embed.test.js`, right after the `widgetMessages` test (before `test.after`):

```js
test('config exposes showCharacterFullscreen', async (t) => {
  process.env.GEMINI_API_KEY = SERVER_KEY;
  delete process.env.PUBLIC_GEMINI_API_KEY;
  delete require.cache[require.resolve('./embed')];

  const CHARFS_PROJECT = { ...PROJECT, publicId: 'test-public-id-charfs', showCharacterFullscreen: true };
  const resolved = require.resolve('../db');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, children: [], paths: [],
    exports: {
      findOne: async (table) => (table === 'projects' ? { ...CHARFS_PROJECT } : null),
      findAll: async () => [], insert: async (t, r) => r, insertMany: async () => [],
      update: async () => null, remove: async () => 0, query: async () => [], queryOne: async () => null,
      pool: { end: async () => {} },
    },
  };

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/embed', require('./embed'));
  const agent = require('supertest')(app);

  const res = await agent.get('/embed/test-public-id-charfs/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.project.showCharacterFullscreen, true);
});
```

This mirrors the exact require-cache-stubbing pattern the `widgetMessages` test above it already uses (distinct `publicId` to dodge `routes/embed.js`'s 60s project cache, per that test's own comment).

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test backend/routes/embed.test.js`
Expected: FAIL — `res.body.project.showCharacterFullscreen` is `undefined`, not `true` (the route doesn't map the field yet).

- [ ] **Step 3: Add the field to the embed config response**

In `GET /:publicId/config`'s response body, right after the existing fullscreen fields:

```js
        fullScreenOnDesktop:   project.fullScreenOnDesktop   === true,
        fullScreenOnMobile:    project.fullScreenOnMobile    === true,
        showFullScreenToggle:  project.showFullScreenToggle  === true,
        showCharacterFullscreen: project.showCharacterFullscreen === true,
```

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `node --test backend/routes/embed.test.js`
Expected: PASS — all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add backend/middleware/validate.js backend/routes/projects.js backend/routes/embed.js backend/routes/embed.test.js
git commit -m "feat: wire showCharacterFullscreen through validation, defaults, and embed config"
```

---

### Task 4: Owner-facing settings toggle in `project.html`

**Files:**
- Modify: `public/project.html:281` (new field markup)
- Modify: `public/project.html:871` (load)
- Modify: `public/project.html:1090` (save)

- [ ] **Step 1: Add the settings field**

Right after the "Show maximize/restore button" field (ends at line 281) and before the "Show 'Powered by' branding" field:

```html
          <div class="field">
            <label>Character full screen (click avatar)</label>
            <select class="select" id="f-character-fullscreen">
              <option value="false">No</option>
              <option value="true">Yes — visitors can click the avatar to fill the screen with just the character</option>
            </select>
            <span class="help">Distinct from the full-screen settings above: this hides the whole chat window (header, messages, composer) and shows only the talking character. Exit is by clicking the character again — no close button is shown.</span>
          </div>
```

- [ ] **Step 2: Load the saved value**

Right after the existing `f-fullscreen-toggle` load line:

```js
      document.getElementById('f-fullscreen-toggle').value  = String(p.showFullScreenToggle === true);
      document.getElementById('f-character-fullscreen').value = String(p.showCharacterFullscreen === true);
```

- [ ] **Step 3: Include it in the save payload**

Right after the existing `showFullScreenToggle` save line:

```js
        showFullScreenToggle: document.getElementById('f-fullscreen-toggle').value === 'true',
        showCharacterFullscreen: document.getElementById('f-character-fullscreen').value === 'true',
```

- [ ] **Step 4: Manually verify**

Run the app locally, open a project's Widget settings tab.

Confirm:
- New "Character full screen (click avatar)" field appears, defaults to "No".
- Setting it to "Yes" and saving persists (reload the page, value still "Yes").
- `GET /embed/:publicId/config` for that project now returns `project.showCharacterFullscreen: true` (can check via browser devtools network tab or curl).

- [ ] **Step 5: Commit**

```bash
git add public/project.html
git commit -m "feat: add character-fullscreen owner setting to project settings UI"
```

---

### Task 5: `embed.html` — click-to-toggle state

**Files:**
- Modify: `public/embed.html:148` (new state var)
- Modify: `public/embed.html:225` (boot: wire up click listener)
- Modify: `public/embed.html:1199-1221` (closePanel: reset state)

- [ ] **Step 1: Add the new state variable**

Right after the existing `fullscreenActive` declaration:

```js
  let fullscreenActive = false;
  let characterFullscreenActive = false;
```

- [ ] **Step 2: Wire up the click listener at the end of the existing fullscreen block in `boot()`**

Right after the existing `if (position !== 'inline') { ... }` fullscreen block (ends at line 225, just before the "Avatar placement settings" comment):

```js
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

    // Character-only fullscreen: opt-in per project, click-to-toggle only
    // while the panel is open (no separate button, no visible chrome —
    // see docs/superpowers/specs/2026-08-28-lipsync-speed-and-character-fullscreen-design.md).
    // Independent of the whole-panel fullscreen state above; both can be
    // active at once (CSS in embed.css handles that combination).
    if (config.project.showCharacterFullscreen) {
      avatarCanvasSlot.style.cursor = 'pointer';
      avatarCanvasSlot.addEventListener('click', () => {
        if (!panelOpen) return;
        characterFullscreenActive = !characterFullscreenActive;
        root.dataset.characterFullscreen = characterFullscreenActive ? '1' : '0';
        notifyParent({ type: 'character-fullscreen', enabled: characterFullscreenActive });
      });
    }
```

- [ ] **Step 3: Reset the state when the panel closes**

In `closePanel()`, right after `panelOpen = false;`:

```js
  function closePanel(skipAnim) {
    panelOpen = false;
    if (characterFullscreenActive) {
      characterFullscreenActive = false;
      root.dataset.characterFullscreen = '0';
      notifyParent({ type: 'character-fullscreen', enabled: false });
    }
    root.dataset.state = skipAnim ? 'closed-instant' : 'closed';
```

This ensures reopening the widget never starts stuck in character-fullscreen, and tells `embed-loader.js` to shrink the iframe back down if it was expanded solely for character-fullscreen (not whole-panel fullscreen — see Task 7's guard).

- [ ] **Step 4: Manually verify (full click cycle, no styling yet — this is just state)**

With Task 6/7 not yet done, this step alone won't visibly change anything except the cursor and the `data-character-fullscreen` attribute — confirm via devtools:
- Elements panel: `#root` gets `data-character-fullscreen="1"` after clicking the avatar (with the project setting enabled), and back to `"0"` on a second click.
- Console: no errors when clicking.

- [ ] **Step 5: Commit**

```bash
git add public/embed.html
git commit -m "feat: add character-fullscreen click-to-toggle state in embed.html"
```

---

### Task 6: `embed.css` — hide chrome, expand the avatar

**Files:**
- Modify: `public/css/embed.css` (new rules after the existing `[data-fullscreen="1"]` block, ~line 191)

- [ ] **Step 1: Add the character-fullscreen CSS rules**

Right after the existing `.widget-root[data-fullscreen="1"] .panel { ... }` rule:

```css
/* ── Character-only fullscreen ────────────────────────────────
   Independent of [data-fullscreen] above — hides all chat chrome and
   expands just the avatar. Can be combined with [data-fullscreen="1"]
   (panel already fills the iframe); the chrome-hiding rules below simply
   take priority visually in that case, no conflict. */
.widget-root[data-character-fullscreen="1"] .panel {
  width: 100%; height: 100%; max-height: none; border-radius: 0;
}
.widget-root[data-character-fullscreen="1"] .header,
.widget-root[data-character-fullscreen="1"] .body,
.widget-root[data-character-fullscreen="1"] .composer,
.widget-root[data-character-fullscreen="1"] .branding {
  display: none;
}
.widget-root[data-character-fullscreen="1"] .avatar-row {
  flex: 1;
  height: 100%;
  pointer-events: auto;
}
.widget-root[data-character-fullscreen="1"] .avatar-stage {
  width: 100%;
  height: 100%;
  border-radius: 0;
}
```

`.avatar-row` normally has `pointer-events: none` (it's an overlay-style flex item — see `public/css/embed.css:488`) with only the canvas itself (reparented inside `.avatar-stage`) receiving clicks; re-enabling `pointer-events: auto` here isn't strictly required for the click listener (which is bound to `#avatar-canvas-slot`, not `.avatar-row`) but keeps the whole expanded area visually/interactively consistent as "the character" rather than leaving a dead click zone around the canvas.

- [ ] **Step 2: Manually verify the full visual flow**

With Tasks 5-6 both in place:
- Enable the setting for a test project, open the widget, click the avatar.
- Confirm: header, message list, composer, and branding all disappear; the avatar visibly grows to fill the panel.
- Click the avatar again — confirm everything returns exactly as before (no layout shift/jump).
- Confirm the widget with the setting **off** shows no cursor change and clicking the avatar does nothing (regression check against Task 5's guard).

- [ ] **Step 3: Commit**

```bash
git add public/css/embed.css
git commit -m "feat: add character-fullscreen CSS (hide chrome, expand avatar)"
```

---

### Task 7: `embed-loader.js` — expand the real iframe

**Files:**
- Modify: `public/js/embed-loader.js:54-56` (new state vars), `365-381` (open/close/fullscreen handlers)

**Correction found during execution:** the spec/original plan assumed a `fullscreenActive` variable already existed in `embed-loader.js`'s scope, mirroring `embed.html`'s. It doesn't — the loader never persisted *why* the iframe is expanded, only applied `setFullscreenIframe()` calls transiently. Fixed by adding two real state flags (`wholePanelFullscreen`, `characterFullscreenOn`) and having every handler drive `setFullscreenIframe` off their OR, so the iframe only shrinks once both are off.

- [ ] **Step 1: Add the new state flags**

Right after the existing `preFullscreenStyle` declaration:

```js
  let placeholder = null;            // FAB shown while iframe loads
  let preFullscreenStyle = null;     // snapshot of inline styles before entering full-screen
  let wholePanelFullscreen = false;  // whole-panel fullscreen toggle (header button) is active
  let characterFullscreenOn = false; // character-only fullscreen (click avatar) is active
```

- [ ] **Step 2: Update `open`/`close`/`fullscreen` to track `wholePanelFullscreen`, and add the new `character-fullscreen` handler**

```js
    if (data.type === 'open') {
      panelOpen = true;
      wholePanelFullscreen = !!data.fullscreen;
      if (wholePanelFullscreen) {
        setFullscreenIframe(true);
      } else {
        iframe.style.width  = `min(${OPEN_W}px, calc(100vw - ${OFFSET_X * 2 + 8}px))`;
        iframe.style.height = `min(${OPEN_H}px, calc(100vh - ${OFFSET_Y + 8}px))`;
      }
      document.dispatchEvent(new CustomEvent('ap:opened', { detail: { botId: publicId } }));
    } else if (data.type === 'close') {
      panelOpen = false;
      wholePanelFullscreen = false;
      characterFullscreenOn = false;
      setFullscreenIframe(false);
      iframe.style.width  = CLOSED_W + 'px';
      iframe.style.height = CLOSED_H + 'px';
    } else if (data.type === 'fullscreen') {
      if (!panelOpen) return;
      wholePanelFullscreen = !!data.enabled;
      setFullscreenIframe(wholePanelFullscreen || characterFullscreenOn);
    } else if (data.type === 'character-fullscreen') {
      if (!panelOpen) return;
      // Two independent triggers can each want the iframe expanded — the
      // header maximize/restore button (wholePanelFullscreen) and clicking
      // the avatar (characterFullscreenOn). The iframe should only shrink
      // back down once BOTH are off, so it's driven by the OR of both
      // flags rather than this message's `enabled` value alone.
      characterFullscreenOn = !!data.enabled;
      setFullscreenIframe(wholePanelFullscreen || characterFullscreenOn);
    }
```

- [ ] **Step 2: Manually verify the full end-to-end flow (Tasks 5-7 together)**

Using a real host page with the `embed-loader.js` snippet (not the Preview tab, which can't exercise outer-iframe resizing — same caveat as the existing fullscreen feature):

1. Enable "Character full screen" only (whole-panel fullscreen settings off). Open the widget, click the avatar — confirm the **iframe itself** expands to cover the browser viewport, not just the panel inside a small box.
2. Click the avatar again — confirm the iframe shrinks back to its normal floating position (including after dragging it to a custom spot first, per the existing `setFullscreenIframe` snapshot/restore behavior).
3. Enable both "Show maximize/restore button" and "Character full screen". Toggle whole-panel fullscreen on via the header button, then click the avatar to enter character-fullscreen, then click again to exit — confirm the iframe stays fullscreen throughout (still in whole-panel fullscreen, not shrunk).
4. Confirm voice keeps working (the bot responds to speech) while in character-fullscreen — no reconnect, no dropped session.
5. Close the panel while in character-fullscreen (e.g. via a host-page `ap:close` call, since there's no visible minimize button in this mode) — confirm the iframe returns to the closed FAB size, and reopening starts in normal (non-character-fullscreen) state.
6. Confirm a project with the setting off behaves exactly as before (regression check).

- [ ] **Step 3: Commit**

```bash
git add public/js/embed-loader.js
git commit -m "feat: expand the host iframe on character-fullscreen toggle"
```

---

## Self-Review Notes

- **Spec coverage:** Lipsync speed (Task 1) ✓. DB column + migration (Task 2) ✓. Validation/defaults/config API (Task 3) ✓. Owner settings UI (Task 4) ✓. Click-to-toggle state, panel-open-only gating, no visible chrome/icon (Task 5) ✓. CSS chrome-hiding + avatar expansion (Task 6) ✓. Iframe-level fullscreen + coexistence with whole-panel fullscreen (Task 7) ✓. All error-handling/edge cases from the spec are covered by the manual verification steps in Tasks 5-7 (setting off = no-op, panel-closed guard, combined-with-whole-panel-fullscreen, raw-iframe-embed degrade already covered by reusing `setFullscreenIframe`'s existing behavior, voice session untouched).
- **Type/naming consistency:** `showCharacterFullscreen` (camelCase JS/API) / `show_character_fullscreen` (snake_case DB) used consistently across all tasks, matching the sibling `showFullScreenToggle`/`show_full_screen_toggle` naming exactly. `characterFullscreenActive` / `data-character-fullscreen` / `'character-fullscreen'` postMessage type used consistently across Tasks 5-7.
- **No placeholders:** every step has complete, real code.
