import type { MountAvatarWidgetOptions } from './types';

/**
 * Mounts the AvatarPlatform embed widget by injecting the real
 * embed-loader.js script tag (same mechanism as the plain HTML snippet
 * from the dashboard's Embed tab). Idempotent per botId — calling this
 * twice with the same botId (e.g. React StrictMode's double-invoke) is a
 * safe no-op.
 */
export function mountAvatarWidget({ serverUrl, botId }: MountAvatarWidgetOptions): void {
  if (typeof document === 'undefined') return; // SSR guard
  if (document.querySelector(`script[data-bot="${botId}"]`)) return;

  const script = document.createElement('script');
  script.src = `${serverUrl.replace(/\/$/, '')}/js/embed-loader.js`;
  script.dataset.bot = botId;
  script.defer = true;
  document.body.appendChild(script);
}

/**
 * Tears down a widget previously mounted with mountAvatarWidget: removes
 * its iframe/placeholder, listeners, and script tag (see embed-loader.js's
 * own destroy()/window.AvatarPlatform.unmount). Call this before mounting
 * a different botId in the same spot — e.g. in a React effect's cleanup
 * function — or the previous bot's iframe (and the AudioContext/Gemini
 * Live socket inside it) is simply left running alongside the new one.
 */
export function unmountAvatarWidget(botId: string): void {
  if (typeof document === 'undefined') return; // SSR guard
  (window as any).AvatarPlatform?.unmount?.(botId);
  // Belt-and-suspenders for the narrow window where mountAvatarWidget's
  // <script> tag was appended but embed-loader.js hasn't finished loading
  // (and thus registered itself for the unmount() call above) yet — if
  // that script is still just sitting in the DOM, removing it here stops
  // it from ever executing and mounting a widget nobody wants anymore.
  document.querySelector(`script[data-bot="${botId}"]`)?.remove();
}
