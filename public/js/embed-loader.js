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
  const CLOSED_W = 80, CLOSED_H = 80;
  let OPEN_W   = parseInt(SCRIPT.getAttribute('data-width'),    10) || 400;
  let OPEN_H   = parseInt(SCRIPT.getAttribute('data-height'),   10) || 640;
  let OFFSET_X = parseInt(SCRIPT.getAttribute('data-offset-x'), 10) || 0;
  let OFFSET_Y = parseInt(SCRIPT.getAttribute('data-offset-y'), 10) || 0;

  // ── State ──────────────────────────────────────────────────────
  let iframe      = null;
  let panelOpen   = false;
  let position    = 'bottom-right';  // 'bottom-right' | 'bottom-left' | 'inline'
  let iframeReady = false;           // true once iframe fires the 'ready' postMessage
  let pendingOpen = false;           // user clicked placeholder before iframe was ready
  let placeholder = null;            // FAB shown while iframe loads
  let preFullscreenStyle = null;     // snapshot of inline styles before entering full-screen
  let wholePanelFullscreen = false;  // whole-panel fullscreen toggle (header button) is active
  let characterFullscreenOn = false; // character-only fullscreen (click avatar) is active

  // localStorage key for persisting drag position
  const POS_KEY = `ap-pos-${publicId}`;

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
    const saved   = loadSavedPosition(pos);
    const isLeft  = pos === 'bottom-left';
    const corner  = isLeft ? 'left' : 'right';
    const cornerV = saved ? (isLeft ? saved.left : saved.right) : OFFSET_X;
    const bottomV = saved ? saved.bottom : OFFSET_Y;

    Object.assign(iframe.style, {
      position:   'fixed',
      bottom:     bottomV + 'px',
      [corner]:   cornerV + 'px',
      width:      CLOSED_W + 'px',
      height:     CLOSED_H + 'px',
      zIndex:     '2147483647',
      transition: 'width .25s ease, height .25s ease',
    });
    document.body.appendChild(iframe);

    // Show placeholder FAB immediately (same corner as iframe)
    createPlaceholder(pos, cornerV, bottomV);
  }

  // ── Placeholder FAB ────────────────────────────────────────────
  // Displayed while the iframe is loading. Clicking it before the iframe
  // is ready sets pendingOpen so the click is replayed once 'ready' fires.
  function createPlaceholder(pos, cornerV, bottomV) {
    const corner = pos === 'bottom-left' ? 'left' : 'right';

    placeholder = document.createElement('div');
    Object.assign(placeholder.style, {
      position:    'fixed',
      [corner]:    cornerV + 'px',
      bottom:      bottomV + 'px',
      width:       CLOSED_W + 'px',
      height:      CLOSED_H + 'px',
      zIndex:      '2147483646',  // just below iframe
      display:     'grid',
      placeItems:  'center',
      cursor:      'pointer',
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

    const rect   = iframe.getBoundingClientRect();
    const isLeft = position === 'bottom-left';
    const corner = isLeft ? 'left' : 'right';

    // Snapshot the current corner offsets in pixels
    const initCorner = isLeft
      ? rect.left
      : (window.innerWidth - rect.right);
    const initBottom = window.innerHeight - rect.bottom;

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
      const maxCorner = window.innerWidth  - W - 8;
      const maxBottom = window.innerHeight - H - 8;

      const newCorner = Math.max(8, Math.min(maxCorner, isLeft
        ? initCorner + dx
        : initCorner - dx));
      const newBottom = Math.max(8, Math.min(maxBottom, initBottom - dy));

      iframe.style[corner] = newCorner + 'px';
      iframe.style.bottom  = newBottom + 'px';
    }

    function onUp() {
      overlay.remove();
      iframe.style.transition = 'width .25s ease, height .25s ease';

      // Persist the final position
      const finalRect   = iframe.getBoundingClientRect();
      const finalCorner = isLeft
        ? finalRect.left
        : (window.innerWidth - finalRect.right);
      const finalBottom = window.innerHeight - finalRect.bottom;
      savePosition(pos => pos === 'bottom-left'
        ? { left: finalCorner, bottom: finalBottom }
        : { right: finalCorner, bottom: finalBottom });

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
        };
      }
      Object.assign(iframe.style, { top: '0', left: '0', right: '0', bottom: '0', width: '', height: '' });
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
  document.addEventListener('ap:open',  (e) => { if (matchesThisBot(e)) requestOpen(); });
  document.addEventListener('ap:close', (e) => { if (matchesThisBot(e)) requestClose(); });
  document.addEventListener('ap:hide',  (e) => { if (matchesThisBot(e)) setWidgetVisible(false); });
  document.addEventListener('ap:show',  (e) => { if (matchesThisBot(e)) setWidgetVisible(true); });

  function loadSavedPosition(pos) {
    try {
      const data = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (!data) return null;
      if (pos === 'bottom-right' && typeof data.right  === 'number') return data;
      if (pos === 'bottom-left'  && typeof data.left   === 'number') return data;
      return null;
    } catch (_) { return null; }
  }

  function savePosition(builder) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(builder(position)));
    } catch (_) {}
  }

  // ── Message bus ────────────────────────────────────────────────
  window.addEventListener('message', (e) => {
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
    }
  });

  // ── window.AvatarPlatform (public/docs/prefetching.html) ───────────
  // A page-level namespace, not scoped to this one <script data-bot> tag,
  // so it's guarded against redefinition if more than one embed-loader
  // script tag is present (multiple bots on one page). Whichever tag loads
  // first wins — ORIGIN is the same for all of them on a real deployment,
  // since they all point at the same AvatarPlatform host.
  if (!window.AvatarPlatform) {
    const preloadCache = new Map();
    window.AvatarPlatform = {
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
