import { useEffect, useState } from "react";

/**
 * How a parked Samurai run's resume time reads on the Second Brain timer
 * rows, the one surface left that shows one.
 *
 * A park is governed by the allowance window that ran out — which can be the
 * 7-day one. A bare `HH:MM` therefore reads as "this afternoon" for a run that
 * only resumes next week, so every surface shows the DATE and a live countdown.
 */

/**
 * Local date + time for an RFC 3339 fire time (`06/08/2026, 15:32` in the
 * user's locale); null when the timestamp does not parse — the caller then
 * still says the run is parked, just without a time. A broken stamp must
 * never hide the parked state.
 */
export function formatFireDateTime(fireAt: string): string | null {
  const d = new Date(fireAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

/**
 * `in 6d 3h 12m` — time left until the run resumes, at minute resolution.
 * Null when the timestamp does not parse.
 *
 * Units below the largest one present are always shown (`in 7d 0h 3m`), so
 * the reading has a fixed shape; smaller-than-largest leading units are not
 * padded in (`in 12m`, never `in 0d 0h 12m`). A timer whose moment has passed
 * reads "due now": the fire event and this render race by design, and a
 * negative countdown would be a lie.
 */
export function formatCountdown(fireAt: string, now: number = Date.now()): string | null {
  const at = new Date(fireAt).getTime();
  if (Number.isNaN(at)) return null;
  const remainingMs = at - now;
  if (remainingMs <= 0) return "due now";
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 1) return "in <1m";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return `in ${parts.join(" ")}`;
}

/**
 * The full resume reading — `06/08/2026, 15:32 · in 6d 3h 12m`. Null when the
 * timestamp does not parse (see `formatFireDateTime`).
 */
export function formatResumeAt(fireAt: string, now: number = Date.now()): string | null {
  const when = formatFireDateTime(fireAt);
  if (when === null) return null;
  return `${when} · ${formatCountdown(fireAt, now)}`;
}

/**
 * A `Date.now()` reading that refreshes on an interval, so a rendered
 * countdown keeps counting down instead of freezing at mount time.
 *
 * `active` gates the interval: these panels sit mounted for hours, and a
 * project with no pending timer must not pay a repeating re-render for a
 * countdown it is not showing. The default 30s tick is half the displayed
 * minute resolution — fast enough that a minute never looks stuck, slow
 * enough to be invisible in render cost.
 */
export function useCountdownNow(active = true, intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Re-read on activation: `now` may have been frozen since mount while
    // this surface had nothing parked to count down to.
    setNow((prev) => (Date.now() - prev > 1000 ? Date.now() : prev));
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
