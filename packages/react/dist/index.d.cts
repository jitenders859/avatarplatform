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

export { AvatarWidget, type AvatarWidgetProps };
