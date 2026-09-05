# Lipsync speed-up + character-only fullscreen mode

**Files:** `public/lipsync-sdk.js`, `public/embed.html`, `public/css/embed.css`, `public/js/embed-loader.js`, `public/project.html`, `backend/routes/embed.js`, `backend/middleware/validate.js`, `supabase/schema.sql`
**Status:** Approved, ready for implementation plan

## Context

Two independent requests bundled together:

1. Lipsync mouth movement feels laggy — the visemes lag behind the audio because the mouth glides toward its target over a fairly long smoothing window.
2. A new opt-in widget mode: when enabled by the project owner, a visitor can click the avatar (while the chat panel is open) to make **only the character** fill the screen — no header, message log, or composer — and click it again to return to the normal chat panel. Voice (Gemini Live) keeps running throughout; there's no visible chrome or close icon in this mode, by design.

This is distinct from the already-shipped whole-panel fullscreen feature (`docs/superpowers/specs/2026-08-01-fullscreen-widget-mode-design.md`, implemented at `embed.html` `root.dataset.fullscreen` / `#fullscreen-btn` / `embed-loader.js`'s `setFullscreenIframe()`), which expands the *entire panel* (header + messages + avatar + composer) to cover the viewport but keeps all chat chrome visible. That feature is left untouched — this spec adds a second, orthogonal state on top of it rather than modifying it, to avoid regressing an already-shipped, tested feature.

---

## Part 1 — Lipsync speed

`public/lipsync-sdk.js`, constructor defaults (`lines 1101-1112`):

| Constant | Current | New | Why |
|---|---|---|---|
| `visemeSmoothingMs` | 90 | 45 | Primary lag source — exponential glide time-constant used every frame in `_applyVisemeTargets()` (`lines 1583-1613`). Halving it makes the mouth reach its target twice as fast. |
| `visemeOverlapMs` | 35 | 18 | Cross-fade start between consecutive visemes (`_driveSchedule()`, `lines 1782-1839`). Scaled down proportionally with the smoothing change so overlaps don't outlast the now-faster glide and cause a muddy blend. |
| `anticipationMs` | 40 | 20 | Pre-roll before a viseme's nominal start (`lines 1766-1778`). Scaled down for the same reason — a large pre-roll against a fast glide would make the mouth move before the audio implies it should. |

Left unchanged: `minVisemeMs` (50 — a hold-time floor, not a lag source) and `visemePeakRatio` (0.88 — shapes the ramp curve within a viseme's duration, not its overall speed).

No other files touch these constants (`embed.html`'s `new LipsyncAvatar({...})` call doesn't override them), so this is a pure default-value change, no call-site or API changes.

## Part 2 — Character-only fullscreen mode

### Settings (opt-in per project, 1 new field)

- `showCharacterFullscreen` (boolean, default `false`) — when true, the avatar becomes clickable inside the open chat panel to enter/exit character-only fullscreen.

New column in `supabase/schema.sql`, in the "Widget" group of `projects` next to `show_full_screen_toggle`:
```sql
show_character_fullscreen  BOOLEAN DEFAULT false,
```
Applied via the same one-off `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` pattern used for the other widget booleans, run with explicit user confirmation since it touches the production database.

`backend/middleware/validate.js` `patchProject` schema: add `showCharacterFullscreen: z.boolean().optional()` next to the existing fullscreen fields (`~lines 101-103`).

`backend/routes/embed.js` `GET /:publicId/config`: expose it alongside the other widget settings — `showCharacterFullscreen: project.showCharacterFullscreen === true`.

`public/project.html` (Widget tab): one new `<select>` — "Character full screen (click avatar)" — next to "Show maximize/restore button", same true/false load/save wiring as `f-quickreplies` / the existing fullscreen fields, and sent through the existing PATCH payload.

### `embed.html`: state and toggling

- New independent state: `let characterFullscreenActive = false;` (kept separate from `fullscreenActive`/`data-fullscreen` — the two can coexist harmlessly: if whole-panel fullscreen is already active, entering character mode just hides the remaining chrome within the already-full iframe).
- `root.dataset.characterFullscreen = '0'|'1'`, reflecting `characterFullscreenActive`.
- After `boot()` resolves `config`, if `config.project.showCharacterFullscreen`, add a click listener on `avatarCanvasSlot` (`#avatar-canvas-slot`, `line 71`) that only fires while `panelOpen` is true:
  ```js
  avatarCanvasSlot.addEventListener('click', () => {
    if (!panelOpen) return;
    characterFullscreenActive = !characterFullscreenActive;
    root.dataset.characterFullscreen = characterFullscreenActive ? '1' : '0';
    notifyParent({ type: 'character-fullscreen', enabled: characterFullscreenActive });
  });
  ```
  A `cursor: pointer` style on `.avatar-stage` is applied only when the config flag is set (owner-gated, so it never shows as clickable for projects that didn't enable it).
- `closePanel()`: reset `characterFullscreenActive = false` / `root.dataset.characterFullscreen = '0'` before closing, so reopening the widget never starts stuck in character-fullscreen.
- No new button, no aria-label swap, no icon — clicking the avatar is the only affordance, matching the "no visible chrome" decision.

### `embed.css`: hiding chrome, expanding the avatar

```css
.widget-root[data-character-fullscreen="1"] #header,
.widget-root[data-character-fullscreen="1"] #messages,
.widget-root[data-character-fullscreen="1"] .composer {
  display: none;
}
.widget-root[data-character-fullscreen="1"] .panel {
  width: 100%; height: 100%; max-height: none; border-radius: 0;
}
.widget-root[data-character-fullscreen="1"] .avatar-row {
  flex: 1; height: 100%;
}
.widget-root[data-character-fullscreen="1"] .avatar-stage {
  width: 100%; height: 100%;
}
```
Placed in the "Panel" section next to the existing `[data-fullscreen="1"]` rules. Selector specificity mirrors the existing pattern (attribute selector + descendant), so no `!important` needed.

### `embed-loader.js`: expanding the real iframe

Reuses the existing `setFullscreenIframe()` helper (`lines 241-255`) — the outer-iframe-resize logic is identical regardless of *why* the widget wants to cover the viewport, so no new helper is needed.

New `'character-fullscreen'` postMessage handler, alongside the existing `'fullscreen'` handler:
```js
if (data.type === 'character-fullscreen') {
  if (!panelOpen) return;
  setFullscreenIframe(!!data.enabled || fullscreenActive);
}
```
The `|| fullscreenActive` guard means: if whole-panel fullscreen is already on, turning character-fullscreen off doesn't shrink the iframe back down (whole-panel mode still owns that expanded state) — `setFullscreenIframe` is idempotent (it only snapshots pre-fullscreen style once), so calling it while already expanded is a harmless no-op.

`'close'` handler already calls `setFullscreenIframe(false)` unconditionally, so closing the panel from character-fullscreen (or any combination of states) still restores correctly — no change needed there.

---

## Error handling / edge cases

- **Owner hasn't enabled the setting:** no click listener is attached, avatar has default cursor, no behavior change from today.
- **Click fires before panel is open:** guarded by `if (!panelOpen) return;` in both the `embed.html` click handler and the loader's message handler — avatar isn't clickable-looking or reachable in the minimized launcher state per the approved design (entry point is panel-open-only).
- **Both whole-panel fullscreen and character-fullscreen active at once:** harmless — CSS rules are independent selectors that both apply; visually character-fullscreen's chrome-hiding wins since it hides everything panel-fullscreen would otherwise show, and the iframe stays expanded either way (see the `|| fullscreenActive` guard above).
- **Raw `<iframe>` embed (not `embed-loader.js`):** same degrade as the existing fullscreen feature — no listener on the host side, so `notifyParent` is a no-op; the widget still applies its internal CSS and fills whatever box it's in.
- **Voice/audio session:** untouched by any of this — it's a pure DOM/CSS + postMessage change, no teardown or reconnection of the Gemini Live session when entering/exiting.

## Testing

No automated harness for the embed widget (consistent with the existing fullscreen feature) — manual verification:

**Lipsync:**
1. Load a bot, trigger speech, subjectively compare mouth responsiveness before/after — should feel noticeably snappier, not jittery or mechanical.
2. Check for visible seams/gaps between consecutive visemes at the new overlap value (rapid speech, sibilant-heavy phrases).

**Character fullscreen:**
1. Leave `showCharacterFullscreen` off on a test project — confirm avatar has no pointer cursor and clicking it does nothing (regression check).
2. Enable it, open the widget, click the avatar — confirm header/messages/composer disappear, avatar fills the panel, and (via `embed-loader.js`) the iframe covers the viewport.
3. Click the avatar again — confirm exact return to the normal open panel (chrome restored, iframe back to its prior floating size/position, including after dragging beforehand).
4. Confirm voice keeps working (bot responds to speech) while in character-fullscreen.
5. Enable both `showFullScreenToggle` and `showCharacterFullscreen`: toggle whole-panel fullscreen on, then click the avatar to enter character-fullscreen, then click again to exit — confirm it returns to whole-panel fullscreen (not fully closed/shrunk), since panel-fullscreen was never turned off.
6. Close the panel while in character-fullscreen, reopen — confirm it reopens in normal (non-character-fullscreen) state.
