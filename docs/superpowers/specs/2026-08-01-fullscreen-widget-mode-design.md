# Full-screen widget mode

**Files:** `public/embed.html`, `public/css/embed.css`, `public/js/embed-loader.js`, `public/project.html`, `backend/routes/projects.js`, `backend/routes/embed.js`, `supabase/schema.sql`
**Status:** Approved, ready for implementation plan

## Context

The floating widget (`widgetPosition` = `bottom-right`/`bottom-left`) opens as a small fixed-size panel (`.panel`: 380×600px, capped at 70vh height on narrow viewports). Some owners want the open panel to take over the whole screen instead — a more app-like, focused experience, especially useful on mobile or for content-heavy sessions (study mode, long documents).

This is distinct from the existing `widgetPosition: 'inline'` option, which makes the widget fill whatever box the *host page* gives its iframe (the host controls sizing, e.g. a full-page embed). Full-screen mode instead makes the widget *take over the viewport itself* when opened, regardless of how the host page placed it, and only applies to the two floating positions — it's a no-op for `inline`, which is already full-bleed by definition.

**Key constraint driving the design:** the widget is normally delivered as a small `<iframe>` that `public/js/embed-loader.js` creates and resizes on the *host page* — `embed.html` itself only controls what's inside that iframe box. Styling `.panel` to `width:100%;height:100%` inside `embed.html` would only fill whatever small box the iframe already is; it would not make the widget cover the host page. Real full-screen requires `embed-loader.js` to resize the outer iframe to cover the viewport, driven by a postMessage from inside `embed.html`. Sites using the plain `<iframe>` snippet from the Embed tab (not the loader script) or the Preview tab's iframe won't get the outer-resize behavior — for those, the widget degrades to filling whatever box it's given, same as today.

Out of scope: full-screen behavior for `inline` position; animating the outer iframe's position/size (only width/height transition, matching existing loader behavior); a chatbot switching from mobile to desktop mid-session recomputing its default (computed once at boot, matching how avatar sizing already works).

---

## Part 1 — Settings (opt-in per project, 3 new fields)

- `fullScreenOnDesktop` (boolean, default `false`) — open full-screen by default on pointer-fine (mouse) devices.
- `fullScreenOnMobile` (boolean, default `false`) — open full-screen by default on pointer-coarse (touch) devices.
- `showFullScreenToggle` (boolean, default `false`) — show a maximize/restore icon button in the widget header so visitors can flip modes themselves at runtime, independent of the owner's default.

Desktop vs. mobile is decided with `window.matchMedia('(pointer: coarse)').matches`, the same signal `embed.html` already uses to gate drag-to-reposition — not a viewport-width media query, because the iframe's own rendered width is small (≤400px) regardless of the host device, which would make a width-based check always report "mobile."

New columns in `supabase/schema.sql`, in the "Widget" group of `projects` next to `show_quick_replies`:
```sql
full_screen_on_desktop   BOOLEAN DEFAULT false,
full_screen_on_mobile    BOOLEAN DEFAULT false,
show_full_screen_toggle  BOOLEAN DEFAULT false,
```
Applied to the live Supabase DB via a one-off `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` script (same pattern used for `show_quick_replies`), run with explicit user confirmation since it touches the production database.

`backend/routes/projects.js`: add the three fields (all `false`) to project-creation defaults; add all three to the `PATCH /:id` allowed-fields list.

`backend/routes/embed.js` `GET /:publicId/config`: expose all three alongside the other widget settings (`fullScreenOnDesktop: project.fullScreenOnDesktop === true`, etc).

`public/project.html` (Widget tab): three new `<select>` fields next to "Position" — "Full-screen on desktop", "Full-screen on mobile", "Show maximize/restore button" — following the exact load/save wiring already used for `f-quickreplies`. Help text notes these have no effect when Position is set to Inline.

## Part 2 — `embed.html`: deciding and toggling fullscreen state

- New state: `let fullscreenActive = false;`
- New header button `#fullscreen-btn` (icon-btn, next to minimize), `hidden` by default.
- In `boot()`, after `position` is resolved:
  - If `position !== 'inline'`: compute `const isMobileDevice = window.matchMedia('(pointer: coarse)').matches;` and set `fullscreenActive = isMobileDevice ? !!config.project.fullScreenOnMobile : !!config.project.fullScreenOnDesktop;`. Set `root.dataset.fullscreen = fullscreenActive ? '1' : '0'`.
  - `fullscreenBtn.hidden = position === 'inline' || !config.project.showFullScreenToggle`.
- `openPanel()`: `notifyParent({ type: 'open', fullscreen: fullscreenActive })` (adds a field to the existing message rather than a new type).
- `fullscreenBtn` click handler: flip `fullscreenActive`, update `root.dataset.fullscreen`, swap the button's icon/aria-label (expand ↔ restore), and `notifyParent({ type: 'fullscreen', enabled: fullscreenActive })`.
- `setupDrag()`'s header `mousedown` handler gets an early return when `root.dataset.fullscreen === '1'` (in addition to the existing `minBtn.contains(e.target)` check, extended to also exclude `fullscreenBtn`) — dragging a full-screen panel makes no sense.

## Part 3 — `embed.css`: in-iframe styling

```css
.widget-root[data-fullscreen="1"] {
  top: 0; right: 0; bottom: 0; left: 0;
}
.widget-root[data-fullscreen="1"] .panel {
  width: 100%; height: 100%; max-height: none; border-radius: 0;
}
```
Placed in the "Panel" section. Specificity (`.widget-root[attr] .panel` = 3 simple selectors) already beats the mobile media query's plain `.panel` rule, so no `!important` or media-query duplication needed — this works correctly whether or not the outer iframe actually resized (Part 4), so the Preview-tab / raw-iframe-embed degraded case still fills whatever box it's given.

## Part 4 — `embed-loader.js`: resizing the real iframe

This is what makes it *actually* full-screen on the host page, not just cosmetic inside a small box.

- New helper:
  ```js
  let preFullscreenStyle = null;
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
  ```
  Snapshotting the live inline styles (rather than recomputing the anchored corner from `OPEN_W`/offsets) means restore is correct even if the user dragged the widget to a new position before or after using full-screen.
- `'open'` handler: if `data.fullscreen`, call `setFullscreenIframe(true)`; else ensure it's off and set width/height as today.
- New `'fullscreen'` handler: `if (!panelOpen) return; setFullscreenIframe(!!data.enabled);` — runtime toggle from the maximize/restore button while already open.
- `'close'` handler: call `setFullscreenIframe(false)` first (restoring/clearing any fullscreen override; no-op if not active) before setting `CLOSED_W`/`CLOSED_H`, so closing from full-screen doesn't leave a stray `top:0` on the collapsed FAB.
- Guarded the same way existing open/close logic already is: `if (iframe.style.position !== 'fixed') return;` skips all of this for `inline` mode.

---

## Error handling / edge cases

- Host page embeds via the raw `<iframe>` snippet (Embed tab) or `project.html`'s Preview tab instead of `embed-loader.js`: no listener exists on the host side, so `notifyParent` messages are simply ignored — the widget still applies its internal `data-fullscreen` CSS and fills whatever box it's in, a reasonable degrade, not an error.
- Owner turns on both `fullScreenOnDesktop`/`fullScreenOnMobile` and later switches `widgetPosition` to `inline`: settings stay saved but have no effect (`position === 'inline'` short-circuits both the boot-time default and the toggle button's visibility) — same "hidden, not deleted" precedent as the tier-gated Quiz/Flashcards/Videos tabs.
- Toggle clicked while `panelOpen` is false: the button is only reachable in the open panel (it's a header control), so this can't happen in practice; the loader's `fullscreen` handler still guards with `if (!panelOpen) return;` defensively.
- Rapid toggle clicks: each click is a synchronous style flip plus one postMessage — no debouncing needed, mirrors how the minimize/open buttons already work.

## Testing

No automated harness for the embed widget (consistent with existing widget features — verified manually via a real page using `embed-loader.js`, since the Preview tab can't exercise the outer-iframe-resize path).

1. Enable "Full-screen on desktop" only, load a test host page on a desktop browser (mouse), open the widget — confirm it covers the viewport, not just a bigger corner box.
2. Same test on a touch device / mobile emulation — confirm it stays floating (desktop-only default), and vice versa for "Full-screen on mobile."
3. Enable "Show maximize/restore button" — confirm the header icon appears, toggling it flips between floating and full-screen live, and restoring returns the widget to its exact prior floating position (including after dragging it to a custom spot first).
4. Confirm dragging is disabled while full-screen (header mousedown does nothing).
5. Confirm `widgetPosition: inline` never shows the toggle button and both full-screen settings are no-ops there.
6. Close the panel while full-screen, then reopen — confirm it returns to the FAB correctly (no stray full-viewport overlay) and reopens per the configured default.
7. Confirm a project with all three settings off behaves exactly as before (regression check).
