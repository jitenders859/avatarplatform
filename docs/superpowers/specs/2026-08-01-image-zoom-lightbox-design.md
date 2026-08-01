# Image Zoom Lightbox — Design

**Date:** 2026-08-01
**Status:** Approved, pending implementation plan

## Problem

The chat image upload feature (`docs/superpowers/specs/2026-08-01-chat-image-upload-design.md`)
renders uploaded images as a small 160×160px thumbnail in the chat log
(`addImageMessage()` in `public/embed.html`), with no way to see the image
at a larger size.

## Goal

Clicking/tapping an uploaded image thumbnail opens a full-panel overlay
showing that image larger, using the same image data already held in
memory (no re-fetch, no re-processing, no new state persisted anywhere).

## Non-goals

- No pan/pinch-zoom beyond simple "fit to panel" display — this is a
  viewer, not an image editor.
- No gallery/multi-image navigation (next/previous) — each thumbnail opens
  independently to just that one image.
- No change to upload, validation, downscaling, or sending behavior from
  the existing feature.

## Architecture

```
User clicks/taps a .image-thumb <img> in the chat log
        │
        ▼
openLightbox(dataUrl)  [new function, public/embed.html]
        │   sets #lightbox-img src to the same dataUrl already
        │   used for the thumbnail (already downscaled/compressed,
        │   already in memory — no extra work)
        ▼
#image-lightbox overlay becomes visible (fixed, covers the widget)
        │
        ▼
User closes via: close button, clicking the dark backdrop, or Escape key
        │
        ▼
closeLightbox()  →  overlay hidden again
```

## Components

### 1. Markup (`public/embed.html`)

A single, hidden-by-default overlay added once near the end of `<body>`
(sibling to `#root`, not nested inside `.panel`, so it isn't affected by
`.panel`'s or `.body`'s scroll/overflow clipping):

```html
<div class="image-lightbox" id="image-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" hidden>
  <button class="lightbox-close" id="lightbox-close" aria-label="Close" type="button">✕</button>
  <img id="lightbox-img" alt="Uploaded image" />
</div>
```

### 2. Behavior (`public/embed.html`, inline `<script>`)

- `addImageMessage(dataUrl)` (already returns the created bubble element,
  from the earlier concurrency-guard fix) additionally attaches a `click`
  listener to its `<img class="image-thumb">` that calls
  `openLightbox(dataUrl)`. Also add `cursor: pointer` via CSS on
  `.image-thumb` as an affordance hint.
- `openLightbox(src)`: sets `#lightbox-img`'s `src` to `src`, removes the
  `hidden` attribute from `#image-lightbox`.
- `closeLightbox()`: sets `hidden` back on `#image-lightbox`. No need to
  clear the `<img src>` — these are already-small, already-in-memory data
  URLs (not blob URLs), so there's nothing to revoke/leak.
- Close triggers, all calling `closeLightbox()`:
  - Click on `#lightbox-close`.
  - Click directly on `#image-lightbox` itself (the backdrop) — but not
    when the click originated on `#lightbox-img` (check `e.target`).
  - `Escape` keydown, listened for on `document`, only while the lightbox
    is open (checked via the `hidden` attribute).

### 3. CSS (`public/css/embed.css`)

- `.image-thumb { cursor: pointer; }` (added to the existing rule from the
  chat-image-upload feature).
- `.image-lightbox`: `position: fixed; inset: 0;` covering the whole
  widget, dark semi-transparent backdrop (`background: rgba(0,0,0,.8)`),
  `display: flex; align-items: center; justify-content: center;`, high
  `z-index` (above `.boot-overlay` and everything else in this file — check
  existing z-index values and exceed the highest one).
- `.image-lightbox[hidden] { display: none; }` (native `hidden` attribute
  already overrides `display: flex` via UA stylesheet in most browsers, but
  being explicit here avoids any specificity surprise from the `display:
  flex` rule above).
- `#lightbox-img { max-width: 92%; max-height: 92%; object-fit: contain;
  border-radius: 8px; }`.
- `.lightbox-close`: positioned top-right (`position: absolute; top: 12px;
  right: 12px;`), styled consistently with the existing `.icon-btn` pattern
  already used elsewhere in this file (white/light icon color, since it
  sits on a dark backdrop — may need its own small rule rather than reusing
  `.icon-btn` directly, since that class assumes a light panel background).

## Error handling & edge cases

- Clicking a thumbnail while another lightbox instance is somehow already
  open: not reachable in practice since there's only one `#image-lightbox`
  element and clicking any thumbnail just re-sets its `src` — no special
  handling needed.
- No image ever fails to "open" — the data URL is already validated,
  in-memory browser data, not a network resource that can 404 or time out.

## Testing plan

No automated test suite exists for this widget (consistent with the rest
of the codebase). Manual verification:
- Click a thumbnail → lightbox opens showing the full (downscaled) image.
- Click the close button → closes.
- Click the dark backdrop (not the image) → closes.
- Click directly on the image inside the lightbox → does NOT close.
- Press Escape while open → closes.
- Confirm the lightbox visually sits above all other widget UI (boot
  overlay, panel, launcher) — check z-index ordering.
