import { zonedParts, zonedTimeToUtc } from "@/lib/timezone";

export interface AvailabilityRule {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

export interface BusyRange {
  startAt: Date;
  endAt: Date;
}

export interface FreeWindow {
  startAt: Date;
  endAt: Date;
}

/**
 * Expands an instructor's recurring weekly rules into actual free windows over the next
 * `days` calendar days (in the instructor's own timezone), with anything already booked
 * subtracted out. This is what the student-facing calendar renders.
 */
export function computeFreeWindowsByDate(opts: {
  timezone: string;
  rules: AvailabilityRule[];
  busy: BusyRange[];
  days: number;
  minNoticeMinutes?: number;
  now?: Date;
}): Map<string, FreeWindow[]> {
  const now = opts.now ?? new Date();
  const earliestStart = new Date(now.getTime() + (opts.minNoticeMinutes ?? 0) * 60_000);
  const today = zonedParts(now, opts.timezone);
  const result = new Map<string, FreeWindow[]>();

  for (let i = 0; i < opts.days; i++) {
    // Advancing the UTC-anchored calendar date by `i` days and reading y/m/d back off it is a
    // safe way to walk consecutive calendar dates — we never read a wall-clock hour off this
    // anchor, so it's not sensitive to the anchor's own (irrelevant) timezone.
    const anchor = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth() + 1;
    const d = anchor.getUTCDate();
    const dayOfWeek = anchor.getUTCDay();

    const dayRules = opts.rules.filter((r) => r.dayOfWeek === dayOfWeek);
    if (dayRules.length === 0) continue;

    const windows: FreeWindow[] = [];
    for (const rule of dayRules) {
      let windowStart = zonedTimeToUtc(y, m, d, rule.startMinute, opts.timezone);
      const windowEnd = zonedTimeToUtc(y, m, d, rule.endMinute, opts.timezone);
      if (windowStart < earliestStart) windowStart = earliestStart;
      if (windowStart >= windowEnd) continue;
      windows.push(...subtractBusy({ startAt: windowStart, endAt: windowEnd }, opts.busy));
    }

    if (windows.length > 0) {
      windows.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
      const dateKey = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      result.set(dateKey, windows);
    }
  }

  return result;
}

function subtractBusy(window: FreeWindow, busy: BusyRange[]): FreeWindow[] {
  const overlapping = busy
    .filter((b) => b.startAt < window.endAt && b.endAt > window.startAt)
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  const free: FreeWindow[] = [];
  let cursor = window.startAt;
  for (const b of overlapping) {
    if (b.startAt > cursor) {
      free.push({ startAt: cursor, endAt: b.startAt < window.endAt ? b.startAt : window.endAt });
    }
    if (b.endAt > cursor) cursor = b.endAt;
    if (cursor >= window.endAt) break;
  }
  if (cursor < window.endAt) {
    free.push({ startAt: cursor, endAt: window.endAt });
  }
  return free;
}

/**
 * The source-of-truth check run at booking time: does [candidateStart, +durationMinutes) sit
 * entirely inside one of the instructor's recurring windows, with no existing booking overlap?
 * Sessions that would cross local midnight are rejected — simplification, not a hard limit
 * that couldn't be lifted later.
 */
export function checkWindowAvailable(
  candidateStart: Date,
  durationMinutes: number,
  opts: { timezone: string; rules: AvailabilityRule[]; busy: BusyRange[] }
): { ok: true; endAt: Date } | { ok: false; reason: string } {
  const startParts = zonedParts(candidateStart, opts.timezone);
  const endMinuteOfDay = startParts.minuteOfDay + durationMinutes;
  if (endMinuteOfDay > 24 * 60) {
    return { ok: false, reason: "Sessions can't cross midnight in the instructor's timezone" };
  }

  const candidateEnd = new Date(candidateStart.getTime() + durationMinutes * 60_000);

  const fits = opts.rules.some(
    (r) => r.dayOfWeek === startParts.dayOfWeek && r.startMinute <= startParts.minuteOfDay && r.endMinute >= endMinuteOfDay
  );
  if (!fits) {
    return { ok: false, reason: "That time isn't within the instructor's availability" };
  }

  const conflict = opts.busy.some((b) => candidateStart < b.endAt && candidateEnd > b.startAt);
  if (conflict) {
    return { ok: false, reason: "That time was just booked by someone else" };
  }

  return { ok: true, endAt: candidateEnd };
}
