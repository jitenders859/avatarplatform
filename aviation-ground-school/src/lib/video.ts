import { env } from "@/lib/env";

const DAILY_API = "https://api.daily.co/v1";

async function dailyFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DAILY_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.dailyApiKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Daily.co API error (${res.status}) on ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export interface VideoRoom {
  name: string;
  url: string;
}

/** How long before/after the booked window the room (and the join button) actually opens. */
export const JOIN_GRACE_MINUTES_BEFORE = 10;
export const JOIN_GRACE_MINUTES_AFTER = 15;

/**
 * Creates a private, time-boxed video room for one confirmed booking. The room only accepts
 * joins from `graceMinutesBefore` before the session to `graceMinutesAfter` after it —
 * enforced by Daily itself (nbf/exp), not just by our UI.
 *
 * No-ops (returns null) when DAILY_API_KEY isn't configured, so booking/payment still works
 * in environments that haven't set up video yet.
 */
export async function createSessionRoom(
  bookingId: string,
  startAt: Date,
  endAt: Date,
  opts: { graceMinutesBefore?: number; graceMinutesAfter?: number } = {}
): Promise<VideoRoom | null> {
  if (!env.dailyApiKey) {
    console.warn(`DAILY_API_KEY not set — skipping video room creation for booking ${bookingId}`);
    return null;
  }

  const graceBefore = opts.graceMinutesBefore ?? JOIN_GRACE_MINUTES_BEFORE;
  const graceAfter = opts.graceMinutesAfter ?? JOIN_GRACE_MINUTES_AFTER;

  const room = await dailyFetch<{ name: string; url: string }>("/rooms", {
    method: "POST",
    body: JSON.stringify({
      name: `booking-${bookingId}`,
      privacy: "private",
      properties: {
        nbf: Math.floor(startAt.getTime() / 1000) - graceBefore * 60,
        exp: Math.floor(endAt.getTime() / 1000) + graceAfter * 60,
        max_participants: 4,
        enable_chat: true,
        enable_screenshare: true,
        eject_at_room_exp: true,
      },
    }),
  });

  return { name: room.name, url: room.url };
}

/**
 * Moves an existing room's join window to match a rescheduled booking, instead of deleting
 * and recreating it (keeps the same room URL). No-ops quietly if video isn't configured or
 * the booking never got a room in the first place (e.g. it was booked before DAILY_API_KEY
 * was set) — a reschedule shouldn't fail just because there's no room to move.
 */
export async function updateSessionRoomWindow(
  roomName: string,
  startAt: Date,
  endAt: Date,
  opts: { graceMinutesBefore?: number; graceMinutesAfter?: number } = {}
): Promise<void> {
  if (!env.dailyApiKey) return;

  const graceBefore = opts.graceMinutesBefore ?? JOIN_GRACE_MINUTES_BEFORE;
  const graceAfter = opts.graceMinutesAfter ?? JOIN_GRACE_MINUTES_AFTER;

  await dailyFetch(`/rooms/${roomName}`, {
    method: "POST",
    body: JSON.stringify({
      properties: {
        nbf: Math.floor(startAt.getTime() / 1000) - graceBefore * 60,
        exp: Math.floor(endAt.getTime() / 1000) + graceAfter * 60,
      },
    }),
  });
}

/** Mints a short-lived, per-participant token for joining a booking's private room. */
export async function createJoinToken(
  roomName: string,
  opts: { userName: string; isOwner: boolean; exp: Date }
): Promise<string> {
  if (!env.dailyApiKey) {
    throw new Error("DAILY_API_KEY not set — video isn't configured for this deployment");
  }

  const token = await dailyFetch<{ token: string }>("/meeting-tokens", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        room_name: roomName,
        user_name: opts.userName,
        is_owner: opts.isOwner,
        exp: Math.floor(opts.exp.getTime() / 1000),
      },
    }),
  });

  return token.token;
}
