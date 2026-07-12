# Quick-reply option buttons in the main chat

**Files:** `public/embed.html`, `public/css/embed.css`, `public/project.html`, `backend/routes/projects.js`, `backend/routes/embed.js`, `supabase/schema.sql`
**Status:** Approved, ready for implementation plan

## Context

The main conversation (the live avatar widget, driven by Gemini Live over `public/lipsync-sdk.js`) is voice-first with no function-calling support (`response_modalities: ['AUDIO']`, `output_audio_transcription: {}` — see `lipsync-sdk.js:1707-1712`). When the assistant naturally offers the user a set of choices (e.g. "would you like A or B?"), there's currently no way to tap an answer — the user must type or speak it.

A separate, unrelated flow already does something visually similar: "Quiz me" study mode (`sendStudyMessage` → `POST /embed/:publicId/study`) uses real function calling against a non-live text endpoint and renders graded MCQ cards (`renderQuizCard`). That mechanism doesn't transfer here — it depends on structured tool-call output, which the live voice session can't produce.

Lead capture solves an analogous problem today: the system prompt instructs the model to append an invisible `[[CAPTURE:key=value]]` tag when it receives a value, which the client strips via regex before display (`buildCaptureInstructions` / `extractCaptureTags`, `embed.html:916-942`). This is a live-voice session, same as the main chat, so it's a proven precedent — confirmed with the user that the tag is never audibly spoken by the model in production despite the session being audio-only. This feature reuses that exact mechanism for a new tag rather than inventing a second one.

Out of scope: multi-select choices, editing a choice after sending it, disabling stale option buttons from earlier turns when a new message arrives, and any change to the study-mode quiz system (which is unrelated and already works).

---

## Part 1 — Tag convention and system prompt

New tag, parallel to `[[CAPTURE:...]]`:
```
[[OPTIONS:Choice one|Choice two|Choice three]]
```
- 2–5 options, pipe-separated, appended as its own line at the end of a turn.
- Added to the system prompt only when the project has the feature enabled (see Part 4). Mirrors `buildCaptureInstructions`'s shape:

  > "QUICK REPLY INSTRUCTIONS: When you offer the user a small, closed set of choices to pick from (a menu of next steps, an either/or decision, a short list of topics) — and only then — append a line in this exact format after your response: `[[OPTIONS:Choice one|Choice two|Choice three]]`. Use 2 to 5 short options. Do not mention the tag to the user — it will be stripped before display and shown as tappable buttons. Do not use this for open-ended questions or when collecting free-text information."

- Composes independently with the existing `[[CAPTURE:...]]` tag — a single turn could contain both.

## Part 2 — Client-side extraction and rendering

- Add `extractOptionsTag(text)` alongside `extractCaptureTags`, using `/\[\[OPTIONS:([^\]]+)\]\]/g`, splitting on `|`, trimming, dropping empties, capping at 5.
- `handleBotChunk` calls it on every streamed update (same as capture tags) and stores the latest parsed list in `pendingOptionsForMsg` (overwritten each call, since the SDK delivers cumulative transcript text, not deltas — same reasoning as `pendingSources`/`pendingFigures`).
- Rendering is deferred to the existing `botFlushTimer` callback (1500ms after the last chunk), the same point sources and figure cards attach today — this avoids flashing a partial option list mid-stream and matches existing turn-finalization timing.
- `attachOptionButtons(afterEl, options)` follows the `attachSources` pattern: builds a `.quick-replies` wrapper and inserts it via `afterEl.parentNode.insertBefore(wrap, afterEl.nextSibling)`.
- Each `.quick-reply` button's click handler: disable every button in that wrapper, mark the clicked one visually selected, then call the existing `sendMessage(optionText)` — identical code path to the user typing and hitting send (retrieval → avatar reconnect → `sendText`).
- Buttons from earlier turns are left alone (not retroactively disabled) when a new turn starts, consistent with how quiz cards already behave across turns.

## Part 3 — Styling

New CSS in `embed.css`, adjacent to the existing `.sources`/`.quiz-option` rules:
- `.quick-replies`: flex row, `flex-wrap: wrap`, `gap: 8px`, `align-self: flex-start` (mirrors `.sources`), with an `[dir="rtl"]` override to `flex-end` matching existing RTL rules.
- `.quick-reply`: pill-shaped button (`border-radius: 999px`), same color tokens as `.quiz-option` (`--bg-2` background, `--border` border, `--accent` on hover) so it reads as part of the same design system, but visually distinct from the boxed `.quiz-card` since these sit inline in the transcript rather than inside a card.
- `.quick-reply.selected` / `:disabled` states reuse the same visual language as `.quiz-option.correct` (accent-tinted background) minus any correct/incorrect coloring, since there's no right answer here.

## Part 4 — Settings (opt-in per project)

- New column: `show_quick_replies BOOLEAN DEFAULT false` in `supabase/schema.sql`, in the "Widget" group of the `projects` table next to `show_source_cards`.
- `backend/routes/projects.js`: add `showQuickReplies: false` to the project-creation defaults; add `'showQuickReplies'` to the `PATCH /:id` allowed-fields list.
- `backend/routes/embed.js`: expose `showQuickReplies: project.showQuickReplies === true` in the `GET /:publicId/config` response, next to `showSourceCards`.
- `public/project.html`: new "Show quick-reply buttons" `<select>` (`f-quickreplies`) in the Widget settings tab, directly under the existing "Show source cards" field, following its exact load/save wiring (`document.getElementById('f-quickreplies').value = String(p.showQuickReplies === true)` on load; included in the PATCH payload on save).
- `public/embed.html`: `initSDK()` only appends the QUICK REPLY INSTRUCTIONS block to the system prompt when `config.project.showQuickReplies` is true; `handleBotChunk`/render logic still runs the extraction (cheap, harmless) but `attachOptionButtons` is a no-op when the setting is off, as defense in depth in case the tag ever appears without the instruction (e.g. a project that was toggled off after being toggled on).

Default is **off** — existing chatbots are unaffected until an owner opts in.

---

## Error handling / edge cases

- Malformed/incomplete tag mid-stream (closing `]]` not yet arrived): regex simply doesn't match yet, same as `[[CAPTURE:...]]` today — the raw partial text is briefly visible in the streaming bubble until the tag completes, an accepted existing tradeoff for this convention.
- More than 5 options: extra ones dropped rather than erroring, to keep the UI from overflowing.
- Empty options after trim (e.g. `||`) are filtered out; if fewer than 2 remain, no buttons render.
- Setting toggled off after being on: no defensive-parsing issue since old messages already rendered aren't affected, and new turns simply won't have the tag (model wasn't instructed) or, if a stray tag appears, `attachOptionButtons` no-ops.

## Testing

No automated harness for the embed widget (verified manually via the Preview tab today, consistent with other widget features). Manual QA:
1. Toggle "Show quick-reply buttons" on for a test project, drive a conversation that should trigger a choice ("should I reset my password or talk to support?"), confirm buttons render after the bubble finalizes and the tag text itself never appears in the displayed message.
2. Confirm the model does not audibly speak the tag (spot-check a few turns), consistent with existing `[[CAPTURE:...]]` behavior.
3. Click a button, confirm it sends as the next user turn and the bot responds normally.
4. Confirm a project with the setting off never renders buttons, even if asked a question likely to produce a listy answer.
5. Confirm a turn containing both a `[[CAPTURE:...]]` tag and an `[[OPTIONS:...]]` tag resolves both correctly (lead field captured, buttons rendered, neither tag visible).
