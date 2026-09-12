/**
 * AvatarPlatform embed-loader
 *
 * Drop on any page:
 *   <script src="https://your-host.com/js/embed-loader.js"
 *           data-bot="PUBLIC_ID" defer></script>
 *
 * What it does:
 *   1. Fetches widget config (position, theme, etc.) from the API.
 *   2. Creates an <iframe> pointing at /e/PUBLIC_ID.
 *   3. Shows a lightweight placeholder FAB immediately so the user has
 *      something to click while the iframe boots. Buffered clicks are
 *      replayed once the iframe signals it is ready.
 *   4. Resizes the iframe wrapper on open/close postMessages from inside.
 *   5. Enables drag-to-reposition on desktop (pointer: fine). A transparent
 *      overlay captures pointermove/pointerup during the drag so events
 *      don't get swallowed by the iframe. Final position is persisted to
 *      localStorage keyed by publicId.
 *   6. Expands the iframe to cover the whole viewport on a 'fullscreen'
 *      postMessage (or an 'open' message carrying { fullscreen: true }),
 *      snapshotting the prior inline styles so restoring is exact.
 *   7. On request, reads the host page's own visible content (title, URL,
 *      main text) and relays it into the iframe — opt-in per project, and
 *      the only place in the widget that can actually see the host page
 *      (embed.html itself is sandboxed inside the cross-origin iframe).
 *   8. Positions the widget at any of six fixed anchors (top/middle/bottom
 *      × left/right), not just the two bottom corners — see parseAnchor()/
 *      anchorStyle(). In avatar-only launcher mode the closed box is sized
 *      to the bare avatar instead of the 80x80 bubble default.
 *   9. Resizes the closed box for a proactive "peek" greeting bubble
 *      (embed.html's schedulePeekGreeting) via peek-show/peek-hide
 *      messages, independent of the open/close chat-panel state.
 */
(function () {
  'use strict';

  const SCRIPT = document.currentScript || (function () {
    const all = document.getElementsByTagName('script');
    return all[all.length - 1];
  })();

  const publicId = SCRIPT.getAttribute('data-bot');
  if (!publicId) {
    console.error('[avatar-embed] data-bot attribute is required');
    return;
  }

  const SRC    = new URL(SCRIPT.src);
  const ORIGIN = `${SRC.protocol}//${SRC.host}`;
  const inlineMode = SCRIPT.getAttribute('data-mode') === 'inline';

  // ── Sizing — data-* attributes provide script-tag overrides ───
  // CLOSED_W/H are mutable: avatar-only launcher style (see below) sizes the
  // closed box to fit the bare character instead of this bubble default.
  let CLOSED_W = 80, CLOSED_H = 80;
  let OPEN_W   = parseInt(SCRIPT.getAttribute('data-width'),    10) || 400;
  let OPEN_H   = parseInt(SCRIPT.getAttribute('data-height'),   10) || 640;
  let OFFSET_X = parseInt(SCRIPT.getAttribute('data-offset-x'), 10) || 0;
  let OFFSET_Y = parseInt(SCRIPT.getAttribute('data-offset-y'), 10) || 0;

  // Matches public/embed.html's AVATAR_SIZES px mapping — kept in sync by
  // hand (both are small, stable lookup tables keyed by the same enum).
  const AVATAR_PX = { small: 80, medium: 120, large: 160, xlarge: 200 };
  // Padding around the bare avatar in avatar-only mode (see mount()) — also
  // matches the --widget-inset embed.html sets on itself in that mode.
  const AVATAR_ONLY_PAD = 24;

  // ── State ──────────────────────────────────────────────────────
  let iframe      = null;
  let panelOpen   = false;
  // One of 'top-left' | 'top-right' | 'middle-left' | 'middle-right' |
  // 'bottom-left' | 'bottom-right' | 'inline' — see parseAnchor().
  let position    = 'bottom-right';
  let iframeReady = false;           // true once iframe fires the 'ready' postMessage
  let pendingOpen = false;           // user clicked placeholder before iframe was ready
  let placeholder = null;            // FAB shown while iframe loads
  let preFullscreenStyle = null;     // snapshot of inline styles before entering full-screen
  let wholePanelFullscreen = false;  // whole-panel fullscreen toggle (header button) is active
  let characterFullscreenOn = false; // character-only fullscreen (click avatar) is active

  // localStorage key for persisting drag position
  const POS_KEY = `ap-pos-${publicId}`;

  // Splits a widgetPosition value into its vertical ('top'|'middle'|'bottom')
  // and horizontal ('left'|'right') anchor components. Not called for
  // 'inline', which has no anchor.
  function parseAnchor(pos) {
    const idx = pos.indexOf('-');
    return { v: pos.slice(0, idx), h: pos.slice(idx + 1) };
  }

  // Builds the inline-style patch that pins an element to one of the six
  // anchors. 'middle' centers via transform, which — unlike a computed pixel
  // top — stays correct automatically when the element's height changes
  // (closed avatar → open panel, or vice versa), no resize recompute needed.
  function anchorStyle(vAnchor, hAnchor, hOffsetPx, vOffsetPx) {
    const style = { left: '', right: '', top: '', bottom: '', transform: '' };
    style[hAnchor] = hOffsetPx + 'px';
    if (vAnchor === 'middle') {
      style.top = '50%';
      style.transform = `translateY(calc(-50% + ${vOffsetPx}px))`;
    } else {
      style[vAnchor] = vOffsetPx + 'px';
    }
    return style;
  }

  // ── Boot: fetch config then mount ─────────────────────────────
  fetch(`${ORIGIN}/embed/${encodeURIComponent(publicId)}/config`)
    .then(r => r.ok ? r.json() : null)
    .then(config => {
      const pos = inlineMode ? 'inline'
        : (config && config.project ? config.project.widgetPosition : null)
        || 'bottom-right';
      // Config values override script-tag data-* attributes
      if (config && config.project) {
        if (config.project.widgetOffsetX != null) OFFSET_X = config.project.widgetOffsetX;
        if (config.project.widgetOffsetY != null) OFFSET_Y = config.project.widgetOffsetY;
        // Avatar-only launcher: no circular bubble to crop it to, so the
        // closed box is sized to the actual avatar (+ padding) instead of
        // the fixed 80x80 bubble default — see public/embed.html's matching
        // --widget-inset / --launcher-size logic.
        if (config.project.avatarLauncherStyle === 'avatar-only') {
          const avatarPx = AVATAR_PX[config.project.avatarSize] || AVATAR_PX.large;
          CLOSED_W = CLOSED_H = avatarPx + AVATAR_ONLY_PAD;
        }
      }
      mount(pos);
    })
    .catch(() => mount('bottom-right'));

  // ── mount ──────────────────────────────────────────────────────
  function mount(pos) {
    position = pos;

    iframe = document.createElement('iframe');
    iframe.title = 'Chat';
    iframe.allow = 'microphone; autoplay';
    iframe.setAttribute('frameborder', '0');
    iframe.src = `${ORIGIN}/e/${encodeURIComponent(publicId)}`
      + (pos === 'inline' ? '?mode=inline' : '');

    Object.assign(iframe.style, {
      border:      'none',
      colorScheme: 'normal',
      background:  'transparent',
    });

    if (pos === 'inline') {
      Object.assign(iframe.style, { width: '100%', height: '600px', display: 'block' });
      SCRIPT.parentNode.insertBefore(iframe, SCRIPT);
      return; // inline mode: no FAB, no drag
    }

    // Floating mode — restore any saved drag position; fall back to configured offsets
    const { v: vAnchor, h: hAnchor } = parseAnchor(pos);
    const saved   = loadSavedPosition(hAnchor);
    const hOffset = saved ? saved.hOffset : OFFSET_X;
    const vOffset = saved ? saved.vOffset : OFFSET_Y;
    const effV    = saved ? saved.vAnchor : vAnchor; // a drag commits 'middle' to a concrete edge

    Object.assign(iframe.style, {
      position:   'fixed',
      width:      CLOSED_W + 'px',
      height:     CLOSED_H + 'px',
      zIndex:     '2147483647',
      transition: 'width .25s ease, height .25s ease',
      ...anchorStyle(effV, hAnchor, hOffset, vOffset),
    });
    document.body.appendChild(iframe);

    // Show placeholder FAB immediately (same anchor as iframe)
    createPlaceholder(effV, hAnchor, hOffset, vOffset);
  }

  // ── Placeholder FAB ────────────────────────────────────────────
  // Displayed while the iframe is loading. Clicking it before the iframe
  // is ready sets pendingOpen so the click is replayed once 'ready' fires.
  function createPlaceholder(vAnchor, hAnchor, hOffset, vOffset) {
    placeholder = document.createElement('div');
    Object.assign(placeholder.style, {
      position:    'fixed',
      width:       CLOSED_W + 'px',
      height:      CLOSED_H + 'px',
      zIndex:      '2147483646',  // just below iframe
      display:     'grid',
      placeItems:  'center',
      cursor:      'pointer',
      ...anchorStyle(vAnchor, hAnchor, hOffset, vOffset),
    });

    const btn = document.createElement('div');
    Object.assign(btn.style, {
      width:        '64px',
      height:       '64px',
      borderRadius: '50%',
      background:   'linear-gradient(135deg,#7c6af5,#a78bfa)',
      boxShadow:    '0 24px 60px rgba(0,0,0,.45)',
      display:      'grid',
      placeItems:   'center',
      fontSize:     '26px',
      color:        'white',
      userSelect:   'none',
    });
    btn.textContent = '💬';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Open chat');
    placeholder.appendChild(btn);

    placeholder.addEventListener('click', requestOpen);

    document.body.appendChild(placeholder);
  }

  // ── Drag-to-reposition ─────────────────────────────────────────
  // Called when embed.html sends { type: 'drag-start' }.
  // A transparent overlay is placed over the whole page so pointermove
  // events keep firing even as the cursor leaves the iframe.
  function startDrag() {
    if (!iframe || position === 'inline') return;

    const rect    = iframe.getBoundingClientRect();
    const { v: configuredV, h: hAnchor } = parseAnchor(position);
    const isLeft  = hAnchor === 'left';

    // 'middle' has no fixed edge to track deltas against (it's centered via
    // transform, not a pixel offset) — a drag commits it to whichever edge
    // the avatar is currently closer to, same as clicking-and-dragging any
    // other anchor from then on. loadSavedPosition()/mount() pick this
    // committed edge back up on the next page load.
    const vAnchor = configuredV === 'middle'
      ? (rect.top + rect.height / 2 < window.innerHeight / 2 ? 'top' : 'bottom')
      : configuredV;

    // Snapshot the current anchor offsets in pixels
    const initH = isLeft ? rect.left : (window.innerWidth - rect.right);
    const initV = vAnchor === 'top' ? rect.top : (window.innerHeight - rect.bottom);

    // Kill transition during drag for instant response
    iframe.style.transition = 'none';

    let startX = null, startY = null;

    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position:   'fixed',
      inset:      '0',
      zIndex:     '2147483648',
      cursor:     'grabbing',
      userSelect: 'none',
    });
    document.body.appendChild(overlay);

    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerup',   onUp);
    overlay.addEventListener('pointercancel', onUp);

    function onMove(e) {
      // Use the first event as our reference point
      if (startX === null) { startX = e.clientX; startY = e.clientY; return; }

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const W  = rect.width;
      const H  = rect.height;
      const maxH = window.innerWidth  - W - 8;
      const maxV = window.innerHeight - H - 8;

      const newH = Math.max(8, Math.min(maxH, isLeft ? initH + dx : initH - dx));
      const newV = Math.max(8, Math.min(maxV, vAnchor === 'top' ? initV + dy : initV - dy));

      Object.assign(iframe.style, anchorStyle(vAnchor, hAnchor, newH, newV));
    }

    function onUp() {
      overlay.remove();
      iframe.style.transition = 'width .25s ease, height .25s ease';

      // Persist the final position
      const finalRect = iframe.getBoundingClientRect();
      const finalH = isLeft ? finalRect.left : (window.innerWidth - finalRect.right);
      const finalV = vAnchor === 'top' ? finalRect.top : (window.innerHeight - finalRect.bottom);
      savePosition({ hAnchor, hOffset: finalH, vAnchor, vOffset: finalV });

      // Tell the iframe the drag is finished so it can reset cursor
      sendToIframe({ type: 'drag-end' });
    }
  }

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
          // A 'middle' vertical anchor centers via transform (see
          // anchorStyle) — must be snapshotted and cleared too, or it fights
          // the top:0/bottom:0 inset below, and restored after so the
          // avatar re-centers correctly once fullscreen exits.
          transform: iframe.style.transform,
        };
      }
      Object.assign(iframe.style, { top: '0', left: '0', right: '0', bottom: '0', width: '', height: '', transform: '' });
    } else if (preFullscreenStyle) {
      Object.assign(iframe.style, preFullscreenStyle);
      preFullscreenStyle = null;
    }
  }

  function sendToIframe(data) {
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ source: 'avatar-platform-host', ...data }, '*');
    }
  }

  // ── Page-content extraction (opt-in per project) ───────────────
  // Runs in the HOST page's own document (this script is loaded directly on
  // the customer's site, unlike embed.html which is sandboxed in the
  // iframe) — this is the only place in the widget that can actually read
  // the page it's embedded on. Only ever invoked in response to the
  // iframe's own 'request-page-content' message, itself only sent when the
  // project owner enabled this in project settings (config.project.
  // pageContextEnabled — see public/embed.html's boot()).
  function extractPageContent() {
    try {
      const metaDesc = document.querySelector('meta[name="description"]');
      const root = document.querySelector('main, article, [role="main"]') || document.body;
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, nav, footer, header, aside, svg, [aria-hidden="true"]')
        .forEach(n => n.remove());
      // .innerText would return empty here — the clone is detached from the
      // rendered DOM, so layout-dependent APIs don't work on it. textContent
      // doesn't need layout, at the cost of also picking up hidden text.
      const text = (clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
      return {
        url: location.href.slice(0, 2048),
        title: (document.title || '').slice(0, 300),
        description: metaDesc ? (metaDesc.getAttribute('content') || '').slice(0, 500) : null,
        text,
      };
    } catch (_) {
      return { url: location.href, title: document.title || '', description: null, text: '' };
    }
  }

  // ── Programmatic control (public/docs/prefetching.html "Controlling the
  // widget" section) — a host page dispatches ap:open/ap:close/ap:hide/
  // ap:show on document instead of needing a reference to this closure.
  // requestOpen is also the placeholder FAB's own click handler, so both
  // paths share the same "replay once ready" behavior.
  function requestOpen() {
    if (iframeReady) sendToIframe({ type: 'open' });
    else pendingOpen = true;
  }
  function requestClose() {
    if (iframeReady) sendToIframe({ type: 'close' });
    else pendingOpen = false;
  }

  // Snapshot of the iframe/placeholder inline `display` before ap:hide, so
  // ap:show restores exactly rather than guessing a value — same pattern
  // preFullscreenStyle uses for fullscreen toggling above.
  let hiddenDisplay = null;
  function setWidgetVisible(visible) {
    if (visible) {
      if (!hiddenDisplay) return;
      if (iframe) iframe.style.display = hiddenDisplay.iframe;
      if (placeholder) placeholder.style.display = hiddenDisplay.placeholder;
      hiddenDisplay = null;
    } else if (!hiddenDisplay) {
      hiddenDisplay = {
        iframe: iframe ? iframe.style.display : '',
        placeholder: placeholder ? placeholder.style.display : '',
      };
      if (iframe) iframe.style.display = 'none';
      if (placeholder) placeholder.style.display = 'none';
    }
  }

  function matchesThisBot(e) {
    return !e.detail || e.detail.botId == null || e.detail.botId === publicId;
  }
  // Named (not inline arrows) so destroy() below can remove exactly these
  // listeners — without that, a host app that mounts/unmounts this widget
  // repeatedly (see packages/react and packages/vue's AvatarWidget, which
  // remount on every botId change) would accumulate one full set of these
  // per mount for the life of the page.
  const onApOpen  = (e) => { if (matchesThisBot(e)) requestOpen(); };
  const onApClose = (e) => { if (matchesThisBot(e)) requestClose(); };
  const onApHide  = (e) => { if (matchesThisBot(e)) setWidgetVisible(false); };
  const onApShow  = (e) => { if (matchesThisBot(e)) setWidgetVisible(true); };
  document.addEventListener('ap:open',  onApOpen);
  document.addEventListener('ap:close', onApClose);
  document.addEventListener('ap:hide',  onApHide);
  document.addEventListener('ap:show',  onApShow);

  // Saved shape: { hAnchor: 'left'|'right', hOffset, vAnchor: 'top'|'bottom', vOffset }.
  // Keyed off hAnchor only (not the full configured position) — if the owner
  // later reconfigures to the opposite side, a stale saved drag on the old
  // side is correctly discarded; a vertical anchor change (including
  // 'middle', which a drag always resolves away from) is still honored from
  // the save, same as today's "drag always wins" behavior.
  function loadSavedPosition(hAnchor) {
    try {
      const data = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (!data || data.hAnchor !== hAnchor) return null;
      if (typeof data.hOffset !== 'number' || typeof data.vOffset !== 'number') return null;
      if (data.vAnchor !== 'top' && data.vAnchor !== 'bottom') return null;
      return data;
    } catch (_) { return null; }
  }

  function savePosition(data) {
    try { localStorage.setItem(POS_KEY, JSON.stringify(data)); } catch (_) {}
  }

  // ── Message bus ────────────────────────────────────────────────
  const onWindowMessage = (e) => {
    // ORIGIN is derived from this very script's own src, i.e. the same
    // host embed.html is served from — and iframe.contentWindow pins it
    // to this specific bot's iframe. Without both checks, any other
    // script on the host page could forge messages (e.g. fake ap:message/
    // ap:response events dispatched into the page's own DOM below) just
    // by matching the data.source/publicId string fields.
    if (e.origin !== ORIGIN || !iframe || e.source !== iframe.contentWindow) return;
    const data = e.data;
    if (!data || data.source !== 'avatar-platform' || data.publicId !== publicId) return;
    if (!iframe) return;

    // ── Ready handshake ──────────────────────────────────────────
    if (data.type === 'ready') {
      iframeReady = true;
      if (placeholder) placeholder.style.display = 'none';
      if (pendingOpen) {
        pendingOpen = false;
        sendToIframe({ type: 'open' });
      }
      return;
    }

    // ── Drag start ───────────────────────────────────────────────
    if (data.type === 'drag-start') {
      startDrag();
      return;
    }

    // ── Chat event relay (public/docs/prefetching.html "Listening for
    // events") — forwarded regardless of layout mode, unlike the
    // open/close resize logic below which only applies in floating mode.
    if (data.type === 'message') {
      document.dispatchEvent(new CustomEvent('ap:message', {
        detail: { botId: publicId, sessionId: data.sessionId, role: data.role, text: data.text },
      }));
      return;
    }
    if (data.type === 'response') {
      document.dispatchEvent(new CustomEvent('ap:response', {
        detail: { botId: publicId, sessionId: data.sessionId, answer: data.answer, sources: data.sources || [] },
      }));
      return;
    }

    // ── Page-content request (opt-in — see extractPageContent above) ────
    if (data.type === 'request-page-content') {
      sendToIframe({ type: 'page-content', ...extractPageContent() });
      return;
    }

    // ── Open / close resize ──────────────────────────────────────
    if (iframe.style.position !== 'fixed') return; // inline mode

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
    } else if (data.type === 'peek-show') {
      // Proactive greeting bubble (see public/embed.html's
      // schedulePeekGreeting) — grows the closed box just enough to fit the
      // avatar + speech bubble side by side, independent of panelOpen/
      // fullscreen state; embed.html sizes it to its own layout.
      if (panelOpen) return;
      iframe.style.width  = (data.width  || 320) + 'px';
      iframe.style.height = (data.height || 100) + 'px';
    } else if (data.type === 'peek-hide') {
      if (panelOpen) return;
      iframe.style.width  = CLOSED_W + 'px';
      iframe.style.height = CLOSED_H + 'px';
    }
  };
  window.addEventListener('message', onWindowMessage);

  // ── Teardown ─────────────────────────────────────────────────
  // Removes everything this script instance created: the iframe (removing
  // it lets the browser tear down its whole document itself — any live
  // AudioContext/Gemini Live WebSocket embed.html opened goes with it, no
  // explicit in-iframe cleanup needed), the placeholder FAB, and every
  // listener registered above. Exposed via window.AvatarPlatform.unmount()
  // so host frameworks can actually clean up on remount — see
  // packages/react and packages/vue's AvatarWidget, which previously
  // called mount() again on every botId change with no way to remove the
  // PREVIOUS bot's iframe/AudioContext/socket first.
  function destroy() {
    window.removeEventListener('message', onWindowMessage);
    document.removeEventListener('ap:open',  onApOpen);
    document.removeEventListener('ap:close', onApClose);
    document.removeEventListener('ap:hide',  onApHide);
    document.removeEventListener('ap:show',  onApShow);
    if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
    if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
    if (SCRIPT.parentNode) SCRIPT.parentNode.removeChild(SCRIPT);
    iframe = null;
    placeholder = null;
  }
  window.__avatarPlatformWidgets = window.__avatarPlatformWidgets || new Map();
  window.__avatarPlatformWidgets.set(publicId, destroy);

  // ── window.AvatarPlatform (public/docs/prefetching.html) ───────────
  // A page-level namespace, not scoped to this one <script data-bot> tag,
  // so it's guarded against redefinition if more than one embed-loader
  // script tag is present (multiple bots on one page). Whichever tag loads
  // first wins — ORIGIN is the same for all of them on a real deployment,
  // since they all point at the same AvatarPlatform host. unmount() itself
  // just reads the shared __avatarPlatformWidgets map above, so it works
  // for any botId regardless of which tag's copy of this code defines it.
  if (!window.AvatarPlatform) {
    const preloadCache = new Map();
    window.AvatarPlatform = {
      unmount(botId) {
        const fn = window.__avatarPlatformWidgets && window.__avatarPlatformWidgets.get(botId);
        if (fn) { fn(); window.__avatarPlatformWidgets.delete(botId); }
      },
      preload(botId) {
        if (!preloadCache.has(botId)) {
          preloadCache.set(botId, fetch(`${ORIGIN}/embed/${encodeURIComponent(botId)}/config`)
            .then(r => { if (!r.ok) throw new Error('Could not load bot config'); return r.json(); })
            .catch(err => { preloadCache.delete(botId); throw err; }));
        }
        return preloadCache.get(botId);
      },
      async ask(botId, question, sessionId) {
        const res = await fetch(`${ORIGIN}/embed/${encodeURIComponent(botId)}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, sessionId }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Ask failed');
        return body;
      },
    };
  }
})();
