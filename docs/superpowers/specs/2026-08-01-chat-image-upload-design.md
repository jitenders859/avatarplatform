# Chat Image Upload — Design

**Date:** 2026-08-01
**Status:** Approved, pending implementation plan

## Problem

Widget visitors can currently only talk or type to the avatar. There's no way
to show the AI something — a photo, a screenshot, a diagram — and have it
look at it and respond. This adds image upload to the live chat: a visitor
uploads (or drags in, if enabled) an image, and the AI analyzes it in the
context of the ongoing conversation and asks a clarifying question about it.

## Goals

- Upload button always available in the widget chat input.
- Optional per-project drag-and-drop onto the widget, gated by a new setting.
- Image is pushed into the *same* Gemini Live session already running the
  avatar's voice/text conversation — no separate vision API call.
- Fully ephemeral: the image itself is never stored anywhere (not on disk,
  not in Supabase, not in the `messages` table). Only a placeholder text
  entry ("[Image shared]") is logged, exactly as much trace as an audio turn
  currently leaves.
- Scoped to the main Live avatar widget only — not the REST-based `/study`
  mode chat.

## Non-goals

- No image persistence, no image thumbnails in transcript history/analytics
  (only the placeholder text).
- No changes to `/study` mode or any REST (`/ask`) chat path.
- No knowledge-base ingestion — this is unrelated to the existing
  `files`/`chunks` RAG pipeline; images uploaded here are never embedded or
  searchable.
- No confirm/cancel step before sending — images send immediately, like text.

## Architecture

```
User clicks 📎 or drags a file onto the widget (if drag-drop enabled)
        │
        ▼
Client-side validate (type/size) + downscale via canvas → base64, ≤5MB
        │
        ▼
avatar.sendImage(base64, mimeType)   [new method, public/lipsync-sdk.js]
        │   sent over the existing direct browser↔Gemini WebSocket
        │   (same connection sendText()/audio already use — no backend
        │   round-trip for the image bytes)
        ▼
Gemini Live session
        │   responds with speech/avatar reaction — analyzes the image and
        │   asks a clarifying question (nudged by a short fixed instruction
        │   sent alongside the image, see "AI prompting" below)
        ▼
Thumbnail rendered client-side in the chat log (not persisted)
        │
        ▼
POST /embed/:publicId/log  →  messages row: role=user, text="[Image shared]"
   (existing endpoint, reused as-is — no schema change to `messages`)
```

### Known technical unknown

The Live API's exact wire format for a one-off (non-streaming) image isn't
fully pinned down from public docs. Two candidates:

- **`realtimeInput.video`** — a `Blob` (`mimeType` + base64 `data`) sent on
  the same `realtime_input` channel `sendText()` (text) and the audio
  streaming code already use in `lipsync-sdk.js`. Intended primarily for
  continuous video/webcam frames, but a single frame is just one instance of
  that stream.
- **`clientContent.turns[]`** — a discrete `Content` turn with an
  `inlineData` `Part`, closer to "attach this to the conversation" semantics.

**Recommendation:** try `realtimeInput.video` first, since it's consistent
with the existing `realtime_input.text`/`realtime_input.audio` pattern
already proven to work in this codebase. Fall back to `clientContent.turns`
if that doesn't behave like a discrete one-off attachment (e.g. if Gemini
treats it as an ongoing video stream rather than a single frame). This
should be verified with a quick manual spike against a live session as the
first implementation task, before wiring up UI around it.

## Components

### 1. Database schema (`supabase/schema.sql`)

Add one column to `projects`:

```sql
allow_drag_drop_upload BOOLEAN DEFAULT false
```

Click-to-upload is always available and not gated by this column — the
setting only controls whether dropping a file onto the widget also
triggers an upload. Defaults to `false` so existing projects are unaffected
until the owner opts in.

### 2. Backend — `backend/routes/projects.js`

- Add `allowDragDropUpload` to the PATCH allowlist (~line 85-93).
- Add it to the defaults set at project creation (~line 46-66).

### 3. Backend — `backend/routes/embed.js`

- Add `allowDragDropUpload` to the `/embed/:publicId/config` response
  (~line 69-98), alongside `showQuickReplies`, so the widget knows whether
  to attach drop-zone listeners.
- No new endpoint for the image itself — it never reaches the backend.
  `POST /embed/:publicId/log` (~line 629) is reused unmodified for the
  placeholder transcript entry.

### 4. Widget UI — `public/embed.html`

- New image/paperclip button next to the send button, wired to a hidden
  `<input type="file" accept="image/jpeg,image/png,image/webp">`.
- If `config.allowDragDropUpload` is true, attach `dragenter`/`dragover`/
  `drop` listeners to the widget container, gated on
  `e.dataTransfer.types.includes('Files')` so they don't conflict with the
  existing bubble-reposition drag handling (lines ~340, 351, 978).
- On file select/drop:
  - Validate MIME type (`image/jpeg`, `image/png`, `image/webp`); reject
    others with an inline error.
  - If over ~1600px on the long edge or over 5MB, downscale via an
    offscreen `<canvas>` (draw + re-encode as JPEG, quality ~0.85) until
    under the cap. If still over 5MB after downscaling, reject with an
    error instead of truncating.
  - Render a thumbnail bubble in the chat log immediately (no
    confirm/cancel step).
  - Call `avatar.sendImage(base64, mimeType)`.
  - `POST /embed/:publicId/log` with `{ role: 'user', text: '[Image shared]' }`.
- If the Live WebSocket isn't connected, show an inline error ("Try again
  once the chat has started") instead of silently dropping the image or
  queuing it.

### 5. Widget SDK — `public/lipsync-sdk.js`

- New method `sendImage(base64Data, mimeType)` alongside the existing
  `sendText()` (~line 1098) and audio-sending code (~line 1974).
- Constructs the `realtime_input` message with the image `Blob`, plus a
  short fixed nudge instruction sent as accompanying `realtime_input.text`
  in the same call:

  > "The user just shared an image. Briefly describe what you notice and
  > ask a clarifying question about what they'd like to know."

- Throws/reports an error if there's no active Live connection, rather than
  failing silently.

### 6. Settings UI — `public/project.html`

Follows the existing 3-touchpoint toggle pattern used for
`#f-quickreplies`:

1. Add `<select id="f-dragdrop">` (On/Off) near the other widget-behavior
   toggles, labeled "Allow drag & drop image upload" with helper text
   noting the upload button itself is always available regardless of this
   setting.
2. Populate from `project.allowDragDropUpload` on load (~line 746).
3. Serialize into the PATCH body on save (~line 849).

## Error handling & edge cases

| Case | Behavior |
|---|---|
| Wrong file type | Inline error near the button; nothing sent |
| Oversized after downscale (>5MB) | Rejected with a clear message |
| Live session not connected | Inline error; image not queued |
| Rapid repeated uploads | No special debouncing — same behavior as rapid text sends |
| Drag-drop disabled for project | Drop listeners simply not attached; button still works |

## Testing plan

- **Spike first:** confirm the real Live API wire format for a discrete
  image turn (see "Known technical unknown") against a live session before
  building the UI around it.
- **Manual browser QA** (no automated widget test suite exists today — this
  stays consistent with how the existing text/voice paths are verified):
  - Drag-drop toggle on/off takes effect; click-upload always works
    regardless.
  - Oversized and wrong-type files are rejected with clear messages.
  - Thumbnail renders in the chat log on send.
  - Gemini visibly reacts to the image (speech/avatar) and asks a
    clarifying question.
  - Transcript (`messages` table / analytics) shows the `[Image shared]`
    placeholder afterward, with no image bytes anywhere server-side.
