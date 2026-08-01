# Image Zoom Lightbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking/tapping an uploaded image thumbnail in the chat widget opens a full-panel overlay showing that image larger, using the image data already held in memory.

**Architecture:** A single hidden `<div id="image-lightbox">` overlay is added once to `public/embed.html`. `addImageMessage()` wires a click listener on each thumbnail that reveals the overlay with that image's already-downscaled data URL. Closing is handled by a close button, backdrop click, or Escape key — all client-side, no backend involvement, no new persisted state.

**Tech Stack:** Vanilla JS/HTML/CSS in `public/embed.html` and `public/css/embed.css` — same stack as the rest of the widget, no new dependencies.

**Full design spec:** `docs/superpowers/specs/2026-08-01-image-zoom-lightbox-design.md`

---

## Context for the implementer

- No automated test suite exists in this repo — verification is a mix of static syntax checks and manual browser QA, consistent with every other widget feature.
- `public/embed.html` loads directly (unlike `lipsync-sdk.js`, this file is NOT minified/built — edits take effect immediately on page reload).
- `.widget-root` (the `#root` element) already uses `z-index: 2147483640` so the embedded iframe's content sits above an arbitrary host page. The lightbox must exceed that within this same document, so it isn't hidden behind `#root`'s own stacking context — use `z-index: 2147483647` (max signed 32-bit int) to guarantee it's always on top.
- `addImageMessage(dataUrl)` (in `public/embed.html`, currently ~line 488) already returns the created bubble `<div>` element (added in a prior fix for the in-flight upload guard) — this plan's Task 1 adds a click listener to the `<img>` inside that bubble, not a new return value.

---

### Task 1: Add the lightbox markup and CSS

**Files:**
- Modify: `public/embed.html:92` (markup, right after `#root`'s closing `</div>`)
- Modify: `public/css/embed.css` (new rules, appended after the existing image-upload CSS block)

- [ ] **Step 1: Add the lightbox markup**

In `public/embed.html`, right after line 92 (the `</div>` that closes `<div class="widget-root" id="root" ...>`), and before the `<!-- Off-screen host the SDK uses... -->` comment, add:

```html

  <!-- Full-size image viewer, opened by clicking a chat thumbnail -->
  <div class="image-lightbox" id="image-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" hidden>
    <button class="lightbox-close" id="lightbox-close" aria-label="Close" type="button">✕</button>
    <img id="lightbox-img" alt="Uploaded image" />
  </div>
```

- [ ] **Step 2: Add the CSS**

In `public/css/embed.css`, find the existing image-upload block (it ends with the `.widget-root.drag-over-image .panel { ... }` rule, currently around line 264-280 — search for `drag-over-image` to locate it exactly). Add right after that block:

```css

/* ── Image lightbox ────────────────────────────────────────── */
.image-thumb { cursor: pointer; }

.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  background: rgba(0, 0, 0, .8);
  display: flex;
  align-items: center;
  justify-content: center;
}
.image-lightbox[hidden] { display: none; }

#lightbox-img {
  max-width: 92%;
  max-height: 92%;
  object-fit: contain;
  border-radius: 8px;
}

.lightbox-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: none;
  background: rgba(255, 255, 255, .12);
  color: #fff;
  cursor: pointer;
  display: grid;
  place-items: center;
  font-size: 16px;
  transition: background .15s;
}
.lightbox-close:hover { background: rgba(255, 255, 255, .22); }
```

- [ ] **Step 3: Verify HTML is well-formed**

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('public/embed.html', 'utf8');
if (!html.includes('id=\"image-lightbox\"') || !html.includes('id=\"lightbox-img\"') || !html.includes('id=\"lightbox-close\"')) {
  throw new Error('Lightbox markup missing');
}
console.log('Markup present');
"
```
Expected: `Markup present`

- [ ] **Step 4: Commit**

```bash
git add public/embed.html public/css/embed.css
git commit -m "Add image lightbox markup and styles"
```

---

### Task 2: Wire up open/close behavior

**Files:**
- Modify: `public/embed.html` (DOM refs, `addImageMessage()`, new `openLightbox`/`closeLightbox` functions, event wiring)

- [ ] **Step 1: Add DOM refs**

Find the block of `const ... = document.getElementById(...)` declarations (search for `const imageBtn` to locate it — it's in that same block). Add right after the `imageInput` line:

```javascript
  const imageLightbox      = document.getElementById('image-lightbox');
  const lightboxImg        = document.getElementById('lightbox-img');
  const lightboxClose      = document.getElementById('lightbox-close');
```

- [ ] **Step 2: Add open/close functions**

Add this new function block right after the `addImageMessage` function (search for `function addImageMessage(dataUrl) {` — the new code goes right after its closing `}`, before the `let imageUploadInFlight = false;` line):

```javascript
  function openLightbox(src) {
    lightboxImg.src = src;
    imageLightbox.hidden = false;
  }

  function closeLightbox() {
    imageLightbox.hidden = true;
  }

  lightboxClose.addEventListener('click', closeLightbox);
  imageLightbox.addEventListener('click', (e) => {
    if (e.target === imageLightbox) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !imageLightbox.hidden) closeLightbox();
  });
```

- [ ] **Step 3: Make thumbnails clickable**

Modify the existing `addImageMessage` function to add a click listener on the thumbnail it creates. Find:

```javascript
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
    return el;
  }
```

Replace with:

```javascript
  function addImageMessage(dataUrl) {
    const el = document.createElement('div');
    el.className = 'msg user image-msg';
    const img = document.createElement('img');
    img.className = 'image-thumb';
    img.src = dataUrl;
    img.alt = 'Uploaded image';
    img.addEventListener('click', () => openLightbox(dataUrl));
    el.appendChild(img);
    messagesEl.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    scrollToBottom();
    return el;
  }
```

(Only change: the new `img.addEventListener('click', ...)` line — everything else is unchanged, shown in full so nothing else is accidentally dropped.)

- [ ] **Step 4: Verify JS syntax**

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('public/embed.html', 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
fs.writeFileSync('/tmp/embed_lightbox_check.js', m[1]);
"
node --check /tmp/embed_lightbox_check.js
rm /tmp/embed_lightbox_check.js
```
Expected: no output from `node --check` (syntax OK), no errors.

- [ ] **Step 5: Manual verification**

Start the app (`npm run dev`), open a project's widget, upload an image (click-to-upload always works regardless of the drag-drop setting), then:
- Click the thumbnail → confirm the lightbox opens showing the image larger, centered, on a dark backdrop.
- Click the ✕ button → confirm it closes.
- Upload another image, open its lightbox, click the dark area outside the image → confirm it closes.
- Open the lightbox again, click directly on the enlarged image itself → confirm it does NOT close.
- Open the lightbox again, press Escape → confirm it closes.
- Confirm the lightbox visually appears above the widget panel, launcher, and boot overlay (there should be nothing else on top of it).

- [ ] **Step 6: Commit**

```bash
git add public/embed.html
git commit -m "Wire up image lightbox open/close behavior"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 covers the design spec's "Markup" and "CSS" components; Task 2 covers "Behavior" (open/close functions, all three close triggers, thumbnail click wiring). The design's "Error handling & edge cases" section has no actual code requirements (both listed cases are "not reachable" / "no special handling needed"), so no separate task is needed for them.
- **Type/naming consistency:** `openLightbox(src)` / `closeLightbox()` names match between their definition (Task 2 Step 2) and call sites (Task 2 Step 2's own listeners, and Task 2 Step 3's `addImageMessage` edit). DOM ref names (`imageLightbox`, `lightboxImg`, `lightboxClose`) match the element ids (`image-lightbox`, `lightbox-img`, `lightbox-close`) established in Task 1.
- **No placeholders:** every step shows complete, real code.
