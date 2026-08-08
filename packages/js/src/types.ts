export interface MountAvatarWidgetOptions {
  /** Base URL of your AvatarPlatform deployment, no trailing slash. */
  serverUrl: string;
  /** Your project's public ID (Dashboard → project → Embed tab). */
  botId: string;
}

export interface AskAvatarOptions {
  serverUrl: string;
  botId: string;
  question: string;
  /** Continue an existing conversation; omit to start a new one. */
  sessionId?: string;
}

export interface AskAvatarSource {
  title: string;
  url: string | null;
  snippet: string;
}

export interface AskAvatarResult {
  answer: string;
  sources: AskAvatarSource[];
  sessionId: string;
}
