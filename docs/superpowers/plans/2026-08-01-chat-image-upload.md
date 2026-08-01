# Chat Image Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a widget visitor upload an image (click a button, or drag-drop if the project owner enables it) during a live chat, pushed straight into the same Gemini Live WebSocket session already running the avatar, so the AI can analyze it and ask a clarifying question — with zero image persistence anywhere server-side.

**Architecture:** The image never touches the backend. The browser downscales/encodes it to base64 client-side, sends it over the existing direct browser↔Gemini Live WebSocket (`public/lipsync-sdk.js`) alongside a short fixed nudge instruction, and renders a local-only thumbnail in the chat log. A placeholder text row (`"[Image shared]"`) is logged via the existing `POST /embed/:publicId/log` endpoint so it shows up in transcripts/analytics. A new per-project `allowDragDropUpload` boolean (default off) gates only the drag-and-drop surface — the click-to-upload button is always available.

**Tech Stack:** Vanilla JS (no framework) in `public/embed.html` / `public/lipsync-sdk.js`, Express routes in `backend/`, PostgreSQL via the existing `backend/db.js` camelCase↔snake_case layer, Gemini Live API (`realtime_input` WebSocket channel).

**Full design spec:** `docs/superpowers/specs/2026-08-01-chat-image-upload-design.md`

---

## Context for the implementer

- This repo has **no automated test suite** (no `*.test.js` files, no test runner in `package.json`). Verification steps below use `curl` for backend routes and manual browser QA for the widget — this matches how every other feature in this codebase is verified.
- `public/embed.html` loads `/lipsync-sdk.min.js`, a **minified build** of `public/lipsync-sdk.js` produced by `npm run build` (see `package.json:9`, uses `terser`). **Any edit to `lipsync-sdk.js` is invisible in the browser until you rebuild.**
- The Gemini Live WebSocket wire format already proven in this codebase (see `public/lipsync-sdk.js:1100` for text, `:1973-1975` for audio) uses **snake_case** keys: `realtime_input: { audio: { data, mime_type } }`. Task 6 mirrors this exact shape for images (`realtime_input: { video: { data, mime_type } }`) — this is the "known technical unknown" flagged in the design spec, now de-risked by this existing pattern, but Task 8 includes a manual live-session check before considering the feature done.
- `backend/db.js` auto-converts JS camelCase columns to Postgres snake_case (`camelToSnake`, `backend/db.js:53`) and back — so `allowDragDropUpload` in JS automatically reads/writes the `allow_drag_drop_upload` column with no extra mapping code.

---

### Task 1: Database column

**Files:**
- Modify: `supabase/schema.sql` (projects table, ~line 55, after `show_quick_replies`)

- [ ] **Step 1: Add the column to the fresh-install schema**

In `supabase/schema.sql`, inside the `projects` table definition, add the new column right after `show_quick_replies`:

```sql
  show_quick_replies       BOOLEAN DEFAULT false,
  allow_drag_drop_upload   BOOLEAN DEFAULT false,
```

- [ ] **Step 2: Apply the column to the live database**

This project's existing pattern (see `git show 0028ca8`) is: update `schema.sql` for fresh installs, then apply the same change directly to the live Supabase database via the SQL Editor. Run this in the Supabase SQL Editor (or `psql $DATABASE_URL -c "..."`):

```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS allow_drag_drop_upload BOOLEAN DEFAULT false;
```

This is a live-database schema change — confirm with the user before running it if you're not certain the database connection you have is the intended one.

- [ ] **Step 3: Verify the column exists**

```bash
psql "$DATABASE_URL" -c "\d projects" | grep allow_drag_drop_upload
```
Expected output: a row showing `allow_drag_drop_upload | boolean | ... | default false`

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql
git commit -m "Add allow_drag_drop_upload column to projects table"
```

---

### Task 2: Backend — project creation defaults + PATCH allowlist

**Files:**
- Modify: `backend/routes/projects.js:53` (creation defaults)
- Modify: `backend/routes/projects.js:88` (PATCH allowlist)

- [ ] **Step 1: Add the default at project creation**

In `backend/routes/projects.js`, in the `POST /` handler's `db.insert('projects', {...})` call, add the new field right after `showQuickReplies: false,`:

```javascript
    showQuickReplies: false,
    allowDragDropUpload: false,
```

- [ ] **Step 2: Add it to the PATCH allowlist**

In the same file, in the `router.patch('/:id', ...)` handler, add `'allowDragDropUpload'` to the `allowed` array right after `'showQuickReplies'`:

```javascript
  const allowed = [
    'name', 'characterId', 'systemPrompt', 'voice', 'welcomeMessage',
    'widgetPosition', 'widgetStartOpen', 'textDirection', 'themeColor',
    'showBranding', 'showSourceCards', 'showQuickReplies', 'allowDragDropUpload', 'widgetOffsetX', 'widgetOffsetY',
    'fullScreenOnDesktop', 'fullScreenOnMobile', 'showFullScreenToggle',
    'avatarPosition', 'avatarSize', 'showAvatarInLauncher',
    'avatarOffsetX', 'avatarOffsetY', 'avatarKeepVisible', 'avatarCompactOnMobile',
    'webhookUrl', 'capabilityTier',
  ];
```

- [ ] **Step 3: Verify with curl** (requires a running server and a valid JWT + project id — substitute your own; if you don't have a way to obtain these quickly, skip to visual verification via the project.html UI in Task 4 instead)

```bash
npm run dev &
sleep 1
curl -s -X PATCH http://localhost:3000/api/projects/<PROJECT_ID> \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"allowDragDropUpload": true}' | python3 -m json.tool
```
Expected: JSON response with `"project": { ..., "allowDragDropUpload": true, ... }` — wait, note the response is stripped via `strip()` (`backend/routes/projects.js:272-276`), which currently passes all fields through unchanged, so the field will appear in the response as-is.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/projects.js
git commit -m "Add allowDragDropUpload to project creation defaults and PATCH allowlist"
```

---

### Task 3: Backend — expose the setting in the embed config

**Files:**
- Modify: `backend/routes/embed.js:84` (config response)

- [ ] **Step 1: Add the field to `GET /embed/:publicId/config`**

In `backend/routes/embed.js`, in the `router.get('/:publicId/config', ...)` handler, add the new field to the `project` object right after `showQuickReplies`:

```javascript
        showQuickReplies:      project.showQuickReplies      === true,
        allowDragDropUpload:   project.allowDragDropUpload   === true,
```

- [ ] **Step 2: Verify with curl**

```bash
npm run dev &
sleep 1
curl -s http://localhost:3000/embed/<PUBLIC_ID>/config | python3 -m json.tool | grep -A1 allowDragDropUpload
```
Expected: `"allowDragDropUpload": false,` (or `true` if you set it via Task 2's PATCH test) with no server error.

- [ ] **Step 3: Commit**

```bash
git add backend/routes/embed.js
git commit -m "Expose allowDragDropUpload in embed config response"
```

---

### Task 4: Settings UI — project.html toggle

**Files:**
- Modify: `public/project.html:207` (new field markup)
- Modify: `public/project.html:746` (load-populate)
- Modify: `public/project.html:849` (save-serialize)

- [ ] **Step 1: Add the toggle markup**

In `public/project.html`, right after the "Show quick-reply buttons" field block (ends at line 207, just before the "Full-screen on desktop" field), add:

```html
          <div class="field">
            <label>Allow drag &amp; drop image upload</label>
            <select class="select" id="f-dragdrop">
              <option value="false">No — click-to-upload button only (default)</option>
              <option value="true">Yes — visitors can also drag an image onto the widget</option>
            </select>
            <span class="help">The image upload button is always available regardless of this setting; this only controls whether dropping a file onto the widget also works.</span>
          </div>
```

- [ ] **Step 2: Populate it on load**

In the function that populates the Widget tab (around line 746), add right after the `f-quickreplies` line:

```javascript
      document.getElementById('f-quickreplies').value = String(p.showQuickReplies === true);
      document.getElementById('f-dragdrop').value = String(p.allowDragDropUpload === true);
```

- [ ] **Step 3: Serialize it on save**

In the `save-widget` click handler's `patch` object (around line 849), add right after `showQuickReplies`:

```javascript
        showQuickReplies:     document.getElementById('f-quickreplies').value === 'true',
        allowDragDropUpload:  document.getElementById('f-dragdrop').value === 'true',
```

- [ ] **Step 4: Manual verification**

Start the app (`npm run dev`), log in, open a project's settings page, go to the Widget tab, confirm "Allow drag & drop image upload" appears under "Show quick-reply buttons", toggle it to Yes, click Save, reload the page, and confirm it's still set to Yes (proves the PATCH + load round-trip works end to end).

- [ ] **Step 5: Commit**

```bash
git add public/project.html
git commit -m "Add drag-and-drop image upload toggle to project settings"
```

---

### Task 5: SDK — `sendImage()` method + rebuild

**Files:**
- Modify: `public/lipsync-sdk.js:1103` (new method, right after `sendText`)
- Build output: `public/lipsync-sdk.min.js` (regenerated, not hand-edited)

- [ ] **Step 1: Add `sendImage()` to the `LipsyncAvatar` class**

In `public/lipsync-sdk.js`, right after the existing `sendText` method (ends at line 1103, before the `startMic` method), add:

```javascript
    /**
     * Send an image into the live conversation. Mirrors sendText's
     * realtime_input channel and the audio Blob shape already used for
     * mic capture (data + mime_type) — see _startMicCapture below.
     */
    sendImage(base64Data, mimeType) {
      if (!base64Data || !this._isConnected || !this._ws) {
        throw new Error('Not connected — start the session before sending an image.');
      }
      this._ws.send(JSON.stringify({
        realtime_input: { video: { data: base64Data, mime_type: mimeType } },
      }));
      this._ws.send(JSON.stringify({
        realtime_input: { text: 'The user just shared an image. Briefly describe what you notice and ask a clarifying question about what they\'d like to know.' },
      }));
    }
```

- [ ] **Step 2: Rebuild the minified bundle**

```bash
npm run build
```
Expected: no errors; `public/lipsync-sdk.min.js` and its `.map` file are regenerated (check `git status` shows them modified).

- [ ] **Step 3: Spot-check the method made it into the minified output**

```bash
grep -o "sendImage" public/lipsync-sdk.min.js
```
Expected: prints `sendImage` (terser preserves public method names on the class by default since they're accessed as `avatar.sendImage(...)` from outside — if this comes back empty, check whether terser's mangle settings need a `reserved` list entry for `sendImage`, matching how `sendText`/`connect`/`disconnect` are already handled).

- [ ] **Step 4: Commit**

```bash
git add public/lipsync-sdk.js public/lipsync-sdk.min.js public/lipsync-sdk.min.js.map
git commit -m "Add sendImage() to LipsyncAvatar SDK"
```

---

### Task 6: Widget UI — upload button, drag-drop, thumbnail, wiring

**Files:**
- Modify: `public/embed.html` (composer markup ~line 66-76; script section for DOM refs, config handling, new helpers, event wiring)

- [ ] **Step 1: Add the upload button and hidden file input to the composer**

In `public/embed.html`, in the `.composer` div (line 66-76), add right after the `mic-btn` button (line 69) and before `quiz-btn`:

```html
        <button class="icon-btn" id="image-btn" title="Upload an image" aria-label="Upload an image" type="button">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
        </button>
        <input type="file" id="image-input" accept="image/jpeg,image/png,image/webp" style="display:none" />
```

- [ ] **Step 2: Add DOM refs**

Near the other `const ... = document.getElementById(...)` declarations (around line 142-152), add:

```javascript
  const imageBtn           = document.getElementById('image-btn');
  const imageInput         = document.getElementById('image-input');
```

- [ ] **Step 3: Add the image validation/downscale helper**

Add this new function block right after the `sendMessage` function (after line 403, before the "── 4. Streaming bot replies" section):

```javascript
  // ── Image upload ──────────────────────────────────────────────
  const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_IMAGE_DIM = 1600;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image file.')); };
      img.src = url;
    });
  }

  async function prepareImageForSend(file) {
    if (!file) throw new Error('No file selected.');
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      throw new Error('Please upload a JPEG, PNG, or WEBP image.');
    }

    const img = await loadImageFile(file);
    const longEdge = Math.max(img.width, img.height);
    const scale = longEdge > MAX_IMAGE_DIM ? MAX_IMAGE_DIM / longEdge : 1;
    const targetW = Math.max(1, Math.round(img.width * scale));
    const targetH = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    canvas.getContext('2d').drawImage(img, 0, 0, targetW, targetH);

    let quality = 0.85;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length * 0.75 > MAX_IMAGE_BYTES && quality > 0.4) {
      quality -= 0.15;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    if (dataUrl.length * 0.75 > MAX_IMAGE_BYTES) {
      throw new Error('That image is too large even after compression — try a smaller photo.');
    }

    return { base64: dataUrl.split(',')[1], mimeType: 'image/jpeg', dataUrl };
  }

  function addImageMessage(dataUrl) {
    const el = document.createElement('div');
    el.className = 'msg user image-msg';
    const img = document.createElement('img');
    img.className = 'image-thumb';
    img.src = dataUrl;
    img.alt = 'Uploaded image';
    el.appendChild(img);
    messagesEl.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    scrollToBottom();
  }

  async function handleImageFile(file) {
    let prepared;
    try {
      prepared = await prepareImageForSend(file);
    } catch (e) {
      addMessage('bot', `⚠️ ${e.message}`);
      return;
    }

    addImageMessage(prepared.dataUrl);

    const send = () => {
      try {
        avatar.sendImage(prepared.base64, prepared.mimeType);
        logTurn('user', '[Image shared]');
      } catch (e) {
        addMessage('bot', '⚠️ Could not send the image — try again once the chat has started.');
      }
    };

    if (!statusDot.classList.contains('connected')) {
      avatar.connect();
      waitForConnected(send);
    } else {
      send();
    }
  }
```

- [ ] **Step 4: Wire up the button and file input**

Add right after the existing `sendBtn.addEventListener('click', ...)` line (line 948):

```javascript
  imageBtn.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', () => {
    const file = imageInput.files[0];
    imageInput.value = '';
    if (file) handleImageFile(file);
  });
```

- [ ] **Step 5: Add conditional drag-and-drop**

Add this new function after `setupDrag()` (after line 353, before the "── 3. Sending messages" section):

```javascript
  // ── Drag-and-drop image upload (opt-in per project) ────────────
  function setupImageDragDrop() {
    if (!config.project.allowDragDropUpload) return;
    let dragDepth = 0;
    const hasFiles = e => e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files');

    root.addEventListener('dragenter', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      root.classList.add('drag-over-image');
    });
    root.addEventListener('dragover', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
    });
    root.addEventListener('dragleave', e => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) root.classList.remove('drag-over-image');
    });
    root.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      root.classList.remove('drag-over-image');
      const file = e.dataTransfer.files[0];
      if (file) handleImageFile(file);
    });
  }
```

Then call it from `finishBoot()` — modify the function (line 321-333) to add the call right after `setupDrag();`:

```javascript
    setupDrag();
    setupImageDragDrop();
    notifyParent({ type: 'ready' });
```

- [ ] **Step 6: Commit**

```bash
git add public/embed.html
git commit -m "Add click and drag-drop image upload to the chat widget"
```

---

### Task 7: CSS for the image thumbnail and drag-over indicator

**Files:**
- Modify: `public/css/embed.css` (after the `.msg.interim` rule, ~line 262)

- [ ] **Step 1: Add thumbnail and drag-over styles**

Add right after the `.msg.interim { opacity: .65; font-style: italic; }` rule (line 262):

```css
.msg.image-msg { padding: 6px; background: transparent; }
.image-thumb {
  display: block;
  max-width: 160px;
  max-height: 160px;
  border-radius: 10px;
  object-fit: cover;
}

.widget-root.drag-over-image .panel {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
}
```

- [ ] **Step 2: Wire the class onto the root element for the drag-over rule**

The `setupImageDragDrop()` function in Task 6 already toggles `drag-over-image` on `root`, which has `id="root"` and class `widget-root` (line 29 of `embed.html`) — no markup change needed here, just confirm the selector matches: `.widget-root.drag-over-image .panel`.

- [ ] **Step 3: Manual verification**

Open the widget in a browser with drag-drop enabled for the test project (Task 4), drag an image file over the widget, and confirm the panel gets a dashed accent-color outline; drop it and confirm the outline clears and a thumbnail appears in the chat.

- [ ] **Step 4: Commit**

```bash
git add public/css/embed.css
git commit -m "Add styles for image thumbnails and drag-drop indicator"
```

---

### Task 8: End-to-end verification

No new files — this is a manual QA pass tying Tasks 1-7 together, plus the wire-format check flagged in the design spec.

- [ ] **Step 1: Wire-format spike — confirm `realtime_input.video` works for a single image**

With `npm run dev` running and a project open in the widget (drag-drop enabled via Task 4's UI), open the browser dev tools Network tab (WS frames), click the image upload button, select a real photo, and confirm:
- A WS frame goes out shaped like `{"realtime_input":{"video":{"data":"...","mime_type":"image/jpeg"}}}` followed by a `{"realtime_input":{"text":"..."}}` frame.
- The avatar visibly/audibly responds shortly after, referencing the image content (not a generic "I can't see images" response).

If Gemini does **not** react to the image (responds as if nothing was sent, or errors), this is the fallback case flagged in the design spec: switch `sendImage()` in Task 5 to build a `clientContent.turns` message instead —
```javascript
this._ws.send(JSON.stringify({
  client_content: {
    turns: [{ role: 'user', parts: [
      { inline_data: { data: base64Data, mime_type: mimeType } },
      { text: 'The user just shared an image. Briefly describe what you notice and ask a clarifying question about what they\'d like to know.' },
    ] }],
    turn_complete: true,
  },
}));
```
and re-run this step.

- [ ] **Step 2: Click-to-upload works regardless of the setting**

With "Allow drag & drop image upload" set to **No** for the test project, confirm the image button still opens a file picker and sends successfully (button is never gated by the setting).

- [ ] **Step 3: Drag-drop respects the setting**

With the setting **Off**, drag an image onto the widget and confirm nothing happens (no listeners attached). Turn it **On**, reload the widget, and confirm dragging now shows the outline and dropping sends the image.

- [ ] **Step 4: Validation errors**

Try uploading a `.txt` file (renamed to `.jpg` won't trigger this — use the file picker's "All files" option or a real non-image) and confirm the wrong-type error message appears without crashing the widget. Try a very large image (>10MB) and confirm it either downscales successfully or shows the "too large" error.

- [ ] **Step 5: Transcript logging**

After sending an image, check the project's session transcript (Project → Sessions in the dashboard, or query `messages` directly) and confirm a `role: 'user', text: '[Image shared]'` row was created, and confirm no image data appears anywhere in the database.

```bash
psql "$DATABASE_URL" -c "SELECT role, text FROM messages ORDER BY created_at DESC LIMIT 5;"
```

- [ ] **Step 6: No regressions on existing text/voice flow**

Send a plain text message and use the mic button as before, confirming both still work unaffected by these changes.

---

## Self-Review Notes

- **Spec coverage:** Task 1 → schema; Task 2/3 → backend allowlist/config; Task 4 → settings UI; Task 5 → SDK send method; Task 6 → button/drag-drop/thumbnail/wiring; Task 7 → CSS; Task 8 → the design spec's flagged wire-format unknown, error handling table, and testing plan. All design spec sections are covered.
- **Type/naming consistency:** `allowDragDropUpload` (JS/API) ↔ `allow_drag_drop_upload` (SQL) used consistently across all tasks; `sendImage(base64Data, mimeType)` signature matches between Task 5 (definition) and Task 6 (call site).
- **No placeholders:** every step has real, complete code — nothing deferred to "handle appropriately."
