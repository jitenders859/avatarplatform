interface MountAvatarWidgetOptions {
    /** Base URL of your AvatarPlatform deployment, no trailing slash. */
    serverUrl: string;
    /** Your project's public ID (Dashboard → project → Embed tab). */
    botId: string;
}
interface AskAvatarOptions {
    serverUrl: string;
    botId: string;
    question: string;
    /** Continue an existing conversation; omit to start a new one. */
    sessionId?: string;
}
interface AskAvatarSource {
    title: string;
    url: string | null;
    snippet: string;
}
interface AskAvatarResult {
    answer: string;
    sources: AskAvatarSource[];
    sessionId: string;
}

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
declare function mountAvatarWidget({ serverUrl, botId }: MountAvatarWidgetOptions): void;

/** Calls POST /embed/:publicId/ask directly — no widget UI required. */
declare function askAvatar({ serverUrl, botId, question, sessionId }: AskAvatarOptions): Promise<AskAvatarResult>;

export { type AskAvatarOptions, type AskAvatarResult, type AskAvatarSource, type MountAvatarWidgetOptions, askAvatar, mountAvatarWidget };
