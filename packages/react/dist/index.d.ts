export { AskAvatarOptions, AskAvatarResult, AskAvatarSource, askAvatar } from '@avatar-platform/js';

interface AvatarWidgetProps {
    /** Base URL of your AvatarPlatform deployment, no trailing slash. */
    serverUrl: string;
    /** Your project's public ID. */
    botId: string;
}
/**
 * Renders nothing itself — mounts the AvatarPlatform embed widget as a
 * side effect. Place once near your app root so it persists across route
 * changes; unmounting this component does not remove the widget (see
 * @avatar-platform/js's mountAvatarWidget for why).
 */
declare function AvatarWidget({ serverUrl, botId }: AvatarWidgetProps): null;

interface UseAvatarPlatformResult {
    open: () => void;
    close: () => void;
    hide: () => void;
    show: () => void;
}
/**
 * Thin wrapper around the `ap:open`/`ap:close`/`ap:hide`/`ap:show` document
 * events that embed-loader.js (the script AvatarWidget mounts) listens for
 * — see public/docs/prefetching.html "Controlling the widget". Doesn't talk
 * to the widget directly; it only dispatches the same events a vanilla-JS
 * page would, so it works with whichever <AvatarWidget> instance is mounted
 * for `botId`.
 */
declare function useAvatarPlatform(botId: string): UseAvatarPlatformResult;

export { AvatarWidget, type AvatarWidgetProps, type UseAvatarPlatformResult, useAvatarPlatform };
