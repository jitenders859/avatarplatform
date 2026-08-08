import type { AskAvatarOptions, AskAvatarResult } from './types';

/** Calls POST /embed/:publicId/ask directly — no widget UI required. */
export async function askAvatar({ serverUrl, botId, question, sessionId }: AskAvatarOptions): Promise<AskAvatarResult> {
  const res = await fetch(`${serverUrl.replace(/\/$/, '')}/embed/${encodeURIComponent(botId)}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, sessionId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  }
  return res.json();
}
