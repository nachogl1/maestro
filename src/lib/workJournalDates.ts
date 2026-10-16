/**
 * Date helpers for the Work Journal. Every journal date is a LOCAL calendar
 * date as `YYYY-MM-DD` (never `toISOString()`, which is the UTC date and is a
 * day off near midnight outside UTC).
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** The local calendar date of `now` as `YYYY-MM-DD`. */
export function localDateString(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Parses `YYYY-MM-DD` into its parts; null when it is not a valid date. */
function parseIsoDate(date: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

/** Whether `date` is a real `YYYY-MM-DD` calendar date. */
export function isValidJournalDate(date: string): boolean {
  return parseIsoDate(date) !== null;
}

/** Days since the epoch for a `YYYY-MM-DD` date (for distances between dates). */
function dayNumber(date: string): number {
  const parts = parseIsoDate(date);
  if (!parts) return Number.NaN;
  return Date.UTC(parts.y, parts.m - 1, parts.d) / 86_400_000;
}

/** Whole days between two `YYYY-MM-DD` dates, ignoring sign. */
export function daysBetween(a: string, b: string): number {
  return Math.abs(dayNumber(a) - dayNumber(b));
}

/**
 * The `YYYY-MM-DD` date `days` calendar days after `date` (negative goes back);
 * an invalid `date` comes back unchanged.
 */
export function shiftJournalDate(date: string, days: number): string {
  const parts = parseIsoDate(date);
  if (!parts) return date;
  const shifted = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + days));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Whether a `YYYY-MM-DD` date is a Saturday or a Sunday. */
export function isWeekend(date: string): boolean {
  const parts = parseIsoDate(date);
  if (!parts) return false;
  const weekday = new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * The default page title, like `Wed 14 Oct 2026`: short weekday, day without a
 * leading zero, short month, year. Always English (the backend's
 * `default_title` uses the same format).
 */
export function defaultWorkJournalTitle(date: string): string {
  const parts = parseIsoDate(date);
  if (!parts) return date;
  const weekday = new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${parts.d} ${MONTHS[parts.m - 1]} ${parts.y}`;
}

/** Milliseconds from `now` until the next local midnight. */
export function msUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now.getTime();
}
