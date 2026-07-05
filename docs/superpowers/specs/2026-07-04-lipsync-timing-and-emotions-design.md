# Lip-sync timing accuracy & multilingual emotion reactions

**File:** `public/lipsync-sdk.js` (production embed widget, v2.2.0)
**Status:** Approved, ready for implementation plan

## Context

`LipsyncAvatar` drives a Rive character's mouth from Gemini Live's `outputTranscription` text deltas, since the Live API provides audio and transcript but no phoneme-level timestamps. Two gaps were identified:

1. Viseme timing anchors each new transcript delta to "current audio position + a fixed 150ms guess" rather than the audio actually scheduled for that delta, so timing drifts on chunk boundaries.
2. Emotion reactions (`CharacterBehaviorController.reactToEmotion`) are English-only regex keyword matching, with inconsistent trigger priority (a gesture can double-fire).

Two other ideas raised during scoping — a translation mode, and driving expressions from Gemini-emitted structured emotion tags — are explicitly **out of scope**. The latter isn't viable anyway: the session uses `response_modalities: ['AUDIO']`, so anything the model "says" as a tag would be spoken aloud by the TTS voice, not delivered as silent metadata.

---

## Part 1 — Byte-clock-windowed viseme timing

**Current behavior** (`_scheduleFromText`, line ~1433): computes `audioOffsetMs = (currentTime - audioStart) * 1000 + 150`, then queues G2P-derived phoneme entries back-to-back from that offset using fixed importance-weighted durations. The 150ms and the stacking are both guesses — nothing ties the delta's viseme timeline to how much audio actually plays under it.

**Change:** use the audio scheduling clock the SDK already maintains (`_nextPlayAt`, accumulated in `_playPCM` from each chunk's exact `bytes / 48000` duration) as ground truth.

- Add `_lastTextAnchorMs`: the scheduled-audio position, `(this._nextPlayAt - this._audioStart) * 1000`, recorded each time a transcript delta is processed.
- On each new delta, compute `windowMs = currentScheduledAudioMs - this._lastTextAnchorMs` — the amount of new audio scheduled since the previous delta.
- Run G2P as today to get raw per-phoneme durations and their sum (`rawTotalMs`). If `windowMs` is sane (roughly 80ms–4000ms), scale every duration by `windowMs / rawTotalMs` so the viseme timeline fits the real audio window.
- If `windowMs` is unavailable or out of that sane range (first delta before any audio is scheduled, or a long network stall), skip scaling and fall back to exactly today's stacking behavior. The change can only improve or preserve current timing, never regress it.
- `mouthDelayMs` and `anticipationMs` apply on top of the corrected base timing, unchanged.
- No changes to the Rive contract, the G2P engines, or `_driveSchedule`'s per-frame rendering — only how `startMs`/`durationMs` are computed before entries are queued.

## Part 2 — Richer, multilingual emotion reactions

**Current behavior** (`CharacterBehaviorController.reactToEmotion`, line ~751): English-only regex for surprise/positive/negative keywords plus a `?` check. Surprise and positive return early; negative does not, so a thinking-look can fire on top of it in the same call. Matching runs against the raw delta, so a keyword split across two streaming chunks can be missed entirely.

**Change:**

- **Categories, in priority order (each mutually exclusive — fire and return):** `surprised` → `happy` → `sad` → `curious` (question mark, language-agnostic across `?`/`؟`/`？`).
- **Multilingual keyword tables**, keyed by the same language codes `detectLanguage()` already returns (english, devanagari, arabic, japanese, chinese, cyrillic, bengali, french, german, spanish, portuguese, indonesian). `detectLanguage()` runs on the transcript first to pick the right table — mirrors the existing G2P language-selection pattern.
- **Boundary-split fix:** test against the last ~60 characters of `_outputTranscriptBuf` (already accumulates full response text) instead of only the raw delta.
- **Gestures, built only from the 8 existing Rive inputs** (Blink, EyeX, EyeY, HeadTilt, HeadNod, Breathe, Smile, BrowRaise):
  - *Surprised* — BrowRaise spike (existing `_triggerBrows`) + a quick small negative HeadNod (startled pull-back)
  - *Happy* — stronger Smile (existing `_triggerSmile`) + small HeadNod bounce
  - *Sad* (new) — no smile; BrowRaise pulled slightly negative (furrow/droop) + HeadNod down + HeadTilt down + briefly slower blink interval
  - *Curious* — existing eyes-up-right thinking look (`_triggerThinkingLook`)
- **Customization hook:** `opts.emotionKeywords` to override/extend per-language keyword lists, matching the SDK's existing `inputMap`-style override pattern — the non-English lists are best-effort translations and a real deployment may want to tune wording per persona.

---

## Error handling / edge cases

- Degenerate timing windows (Part 1) always fall back to current behavior rather than producing a broken/garbled viseme timeline.
- Unrecognized language codes (Part 2) fall back to the English keyword table rather than silently disabling emotions.
- Gesture cooldowns (existing `_canGesture`/`_markGesture` mechanism) are preserved so new gestures can't spam-trigger on consecutive deltas.

## Testing

- Manual QA via the existing debug viseme/lang pill UI in the widget's dev panel: verify mouth timing subjectively tracks audio across a range of response lengths (short "yes"/"no" replies through multi-sentence answers) and across at least 3 languages.
- Manual QA for emotions: drive scripted phrases per language through each category (surprised/happy/sad/curious) and confirm the correct gesture fires exactly once, with no double-fire when multiple triggers are present in one delta.
