/**
 * @avatar-platform/react — browser-compatible ES module (no build step)
 *
 * Usage (CDN / docs demos):
 *   <script type="module">
 *     import { AvatarWidget, useAvatarPlatform } from '/sdk/react.js';
 *   </script>
 *
 * The npm package (@avatar-platform/react) ships a bundled version of this
 * same API — see README.md for install instructions.
 */
import React, { useEffect, useRef } from 'https://esm.run/react@18';

/**
 * AvatarWidget — drop-in React component that mounts the lipsync-sdk embed
 * widget inside a container div.
 *
 * @param {string}  botId         - Your project's publicId (required)
 * @param {string}  position      - Widget anchor: 'bottom-right' | 'bottom-left'
 * @param {string}  theme         - Primary hex color, e.g. '#6366f1'
 * @param {string}  size          - 'sm' | 'md' | 'lg'
 * @param {boolean} startOpen     - Open the chat panel on mount
 * @param {boolean} compactMobile - Shrink avatar on small screens
 */
export function AvatarWidget({
  botId,
  position = 'bottom-right',
  theme = '#6366f1',
  size = 'md',
  startOpen = false,
  compactMobile = true,
}) {
  const ref = useRef(null);

  useEffect(() => {
    const s = document.createElement('script');
    s.src = '/lipsync-sdk.js';
    s.dataset.publicId = botId;
    s.dataset.position = position;
    s.dataset.theme = theme;
    s.dataset.size = size;
    if (startOpen) s.dataset.startOpen = 'true';
    if (!compactMobile) s.dataset.compactMobile = 'false';
    document.body.appendChild(s);
    return () => { document.body.removeChild(s); };
  }, [botId]);

  return React.createElement('div', { ref, id: `ap-container-${botId}` });
}

/**
 * useAvatarPlatform — hook that returns imperative controls for a mounted widget.
 *
 * @param {string} botId - Same publicId passed to <AvatarWidget>
 * @returns {{ ask, preload, open, close }}
 */
export function useAvatarPlatform(botId) {
  return {
    ask: (question, sessionId) =>
      window.AvatarPlatform?.ask(botId, question, sessionId),
    preload: () =>
      window.AvatarPlatform?.preload(botId),
    open: () =>
      document.dispatchEvent(new CustomEvent('ap:open', { detail: { botId } })),
    close: () =>
      document.dispatchEvent(new CustomEvent('ap:close', { detail: { botId } })),
  };
}
