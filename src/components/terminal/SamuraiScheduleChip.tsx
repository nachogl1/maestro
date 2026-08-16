import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { formatResumeAt, useCountdownNow } from "@/lib/parkTime";
import { samePath } from "@/lib/path";
import { isParkEntry } from "@/lib/samurai";
import { type SamuraiScheduleEntry, useSessionStore } from "@/stores/useSessionStore";

/**
 * The earliest-firing entry — what a project-level chip counts down to when
 * several epics parked. Unparseable fire times sort last (they never beat a
 * real countdown), but a list of only unparseable ones still returns one.
 */
export function earliestEntry(entries: SamuraiScheduleEntry[]): SamuraiScheduleEntry | null {
  if (entries.length === 0) return null;
  return entries.reduce((best, entry) => {
    const bestAt = new Date(best.fire_at).getTime();
    const entryAt = new Date(entry.fire_at).getTime();
    if (Number.isNaN(entryAt)) return best;
    if (Number.isNaN(bestAt)) return entry;
    return entryAt < bestAt ? entry : best;
  });
}

/**
 * Project-level park countdown (issue #61; PRD §9): "parked · resumes
 * 06/08/2026, 14:32 · in 6d 3h 12m" while the project has pending Samurai
 * resume timers. The date and the countdown both ride the chip on purpose —
 * a park can be governed by the 7-day allowance window, and a bare `HH:MM`
 * read as "this afternoon" no matter how far out the resume really was.
 *
 * Lives at PROJECT level — a parked epic's terminal tile auto-closes (PRD
 * decision #6: every wake-up is a fresh spawn), so there is no session to
 * badge. Renders nothing when no timer is pending, so every existing view
 * stays visually unchanged. Reads the store directly by project path (same
 * pattern as SamuraiBadge).
 */
export const SamuraiScheduleChip = memo(function SamuraiScheduleChip({
  projectPath,
  className = "",
}: {
  projectPath: string;
  className?: string;
}) {
  const entries = useSessionStore(
    useShallow((s) =>
      // `isParkEntry` is not optional: scheduled-launch timers (issue #129)
      // share this list, and one would paint "parked · resumes …" on a
      // project with no run at all.
      s.samuraiSchedule.filter((e) => isParkEntry(e) && samePath(e.project_path, projectPath)),
    ),
  );
  const soonest = earliestEntry(entries);
  // Hooks run unconditionally; the tick only arms while something is parked.
  const now = useCountdownNow(soonest !== null);
  if (!soonest) return null;

  const resume = formatResumeAt(soonest.fire_at, now);
  const label = resume ? `parked · resumes ${resume}` : "parked";
  const detail = entries
    .map((e) => `${e.epic}: ${formatResumeAt(e.fire_at, now) ?? e.fire_at}`)
    .join(", ");
  return (
    <span
      title={`Samurai park countdown — work resumes automatically (${detail})`}
      // Wraps rather than clipping: the full date + countdown is the whole
      // point of the chip, so a narrow sidebar takes a second line instead of
      // truncating the reading away.
      className={`min-w-0 rounded px-1 py-px text-[9px] font-bold leading-tight tracking-wide bg-maestro-purple/20 text-maestro-purple ${className}`}
    >
      {label}
    </span>
  );
});
