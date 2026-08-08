import type { MountAvatarWidgetOptions } from './types';

/**
 * Mounts the AvatarPlatform embed widget by injecting the real
 * embed-loader.js script tag (same mechanism as the plain HTML snippet
 * from the dashboard's Embed tab). Idempotent per botId — calling this
 * twice with the same botId (e.g. React StrictMode's double-invoke) is a
 * safe no-op, since embed-loader.js provides no unmount hook itself
 * (it appends the iframe/launcher directly to document.body with no
 * identifiable wrapper to remove later). Meant to be mounted once for
 * the lifetime of the page, typically near your app root.
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
