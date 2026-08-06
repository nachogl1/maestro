import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { samePath } from "@/lib/path";
import { useSessionStore, type SamuraiScheduleEntry } from "@/stores/useSessionStore";

/**
 * `HH:MM` in the user's locale for an RFC 3339 fire time; null when the
 * timestamp does not parse (the chip then shows "parked" without a time —
 * a broken timestamp must not hide the fact that the project is parked).
 */
export function formatFireTime(fireAt: string): string | null {
  const d = new Date(fireAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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
 * Project-level park countdown (issue #61; PRD §9): "parked · resumes 14:32"
 * while the project has pending Samurai resume timers. Lives at PROJECT
 * level on purpose — a parked epic's terminal tile auto-closes (PRD decision
 * #6: every wake-up is a fresh spawn), so there is no session to badge.
 * Renders nothing when no timer is pending, so every existing view stays
 * visually unchanged. Reads the store directly by project path (same
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
    useShallow((s) => s.samuraiSchedule.filter((e) => samePath(e.project_path, projectPath)))
  );
  const soonest = earliestEntry(entries);
  if (!soonest) return null;

  const time = formatFireTime(soonest.fire_at);
  const label = time ? `parked · resumes ${time}` : "parked";
  const detail = entries
    .map((e) => `${e.epic}: ${formatFireTime(e.fire_at) ?? e.fire_at}`)
    .join(", ");
  return (
    <span
      title={`Samurai park countdown — work resumes automatically (${detail})`}
      className={`shrink-0 whitespace-nowrap rounded px-1 py-px text-[9px] font-bold tracking-wide bg-maestro-purple/20 text-maestro-purple ${className}`}
    >
      {label}
    </span>
  );
});
