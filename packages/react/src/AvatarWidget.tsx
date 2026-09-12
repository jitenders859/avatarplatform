import { useEffect } from 'react';
import { mountAvatarWidget, unmountAvatarWidget } from '@avatar-platform/js';

export interface AvatarWidgetProps {
  /** Base URL of your AvatarPlatform deployment, no trailing slash. */
  serverUrl: string;
  /** Your project's public ID. */
  botId: string;
}

/**
 * Renders nothing itself — mounts the AvatarPlatform embed widget as a
 * side effect. Place once near your app root so it persists across route
 * changes. The effect cleanup unmounts the widget on unmount AND before
 * every re-run (including a botId change) — without it, switching botId
 * left the previous bot's iframe (and the AudioContext/Gemini Live socket
 * running inside it) mounted forever alongside the new one.
 */
export function AvatarWidget({ serverUrl, botId }: AvatarWidgetProps) {
  useEffect(() => {
    mountAvatarWidget({ serverUrl, botId });
    return () => unmountAvatarWidget(botId);
  }, [serverUrl, botId]);
  return null;
}
