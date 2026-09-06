/**
 * DST-safe local <-> UTC conversion using only `Intl` — no date library dependency.
 * Instructor availability is stored as (dayOfWeek, minute-of-day) in the instructor's own
 * IANA timezone; these helpers turn that into real UTC instants for a given calendar date,
 * and back again, without the classic fixed-offset bugs around DST transitions.
 */

/** Offset in minutes to ADD to a UTC instant to get the wall-clock time in `timeZone`. */
function tzOffsetMinutes(utcDate: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(utcDate).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUtc - utcDate.getTime()) / 60_000;
}

/**
 * Given a calendar date (in `timeZone`) and a minute-of-day, returns the UTC instant it
 * represents. Uses a guess-then-correct pass so it's still right across a DST boundary.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, minuteOfDay: number, timeZone: string): Date {
  const naiveGuess = new Date(Date.UTC(year, month - 1, day, 0, minuteOfDay));
  const offset = tzOffsetMinutes(naiveGuess, timeZone);
  let utc = new Date(naiveGuess.getTime() - offset * 60_000);

  const offset2 = tzOffsetMinutes(utc, timeZone);
  if (offset2 !== offset) {
    utc = new Date(naiveGuess.getTime() - offset2 * 60_000);
  }
  return utc;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday ... 6 = Saturday, matching JS Date#getDay. */
  dayOfWeek: number;
  minuteOfDay: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Breaks a UTC instant down into its wall-clock date/time in `timeZone`. */
export function zonedParts(utcDate: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(dtf.formatToParts(utcDate).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    dayOfWeek: WEEKDAY_INDEX[parts.weekday ?? ""] ?? 0,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** YYYY-MM-DD for `utcDate` as seen in `timeZone` — used as the calendar's per-day grouping key. */
export function zonedDateKey(utcDate: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(utcDate, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
