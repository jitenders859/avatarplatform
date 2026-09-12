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
 * safe no-op.
 */
declare function mountAvatarWidget({ serverUrl, botId }: MountAvatarWidgetOptions): void;
/**
 * Tears down a widget previously mounted with mountAvatarWidget: removes
 * its iframe/placeholder, listeners, and script tag (see embed-loader.js's
 * own destroy()/window.AvatarPlatform.unmount). Call this before mounting
 * a different botId in the same spot — e.g. in a React effect's cleanup
 * function — or the previous bot's iframe (and the AudioContext/Gemini
 * Live socket inside it) is simply left running alongside the new one.
 */
declare function unmountAvatarWidget(botId: string): void;

/** Calls POST /embed/:publicId/ask directly — no widget UI required. */
declare function askAvatar({ serverUrl, botId, question, sessionId }: AskAvatarOptions): Promise<AskAvatarResult>;

export { type AskAvatarOptions, type AskAvatarResult, type AskAvatarSource, type MountAvatarWidgetOptions, askAvatar, mountAvatarWidget, unmountAvatarWidget };
