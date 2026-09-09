import { memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { formatResumeAt, useCountdownNow } from "@/lib/parkTime";
import { samePath } from "@/lib/path";
import { isParkEntry } from "@/lib/samurai";
import { resumeRunNow } from "@/lib/samuraiResume";
import {
  type SamuraiBreakerPark,
  type SamuraiScheduleEntry,
  samuraiRunKey,
  useSessionStore,
} from "@/stores/useSessionStore";

/**
 * The chip for one circuit-breaker park (issue #209) — the park kind that
 * arms NO resume timer, so it can never count down to anything and the
 * acknowledge-only allowance chip below would say nothing useful about it.
 *
 * Red, and it carries an action: the breaker fires because the agent was
 * burning allowance without moving HEAD, an automatic restart would loop
 * straight back into the same burn, so the ONLY way out is a human's click.
 * Acknowledging it would just hide a run that nothing will ever restart.
 */
function BreakerParkChip({ park }: { park: SamuraiBreakerPark }) {
  const [error, setError] = useState<string | null>(null);
  // Shared with the Active Runs row's Resume: both call the same command,
  // which takes no lock and cannot see a successor until it registers, so a
  // per-component flag let the two surfaces double-spawn between them.
  const resuming = useSessionStore((s) =>
    s.samuraiResumingRuns.includes(samuraiRunKey(park.project, park.epic)),
  );

  const resume = async () => {
    if (resuming) return;
    setError(null);
    try {
      // Issue #211: ONE resume action for every park kind. It claims the
      // shared in-flight guard, warns on an exhausted allowance, and drops
      // this chip itself once the run has an owner again.
      await resumeRunNow(park.project, park.epic);
    } catch (err) {
      // Surfaced on the chip: a refusal that vanished would read as a click
      // that did nothing.
      setError(String(err));
    }
  };

  return (
    <span
      className="flex min-w-0 items-center gap-1 rounded border border-maestro-red/40 bg-maestro-red/15 px-1 py-px text-[9px] font-bold leading-tight tracking-wide text-maestro-red"
      title={
        error ??
        `The circuit breaker parked ${park.epic}: it was burning allowance without moving HEAD. NOTHING will restart it — an automatic resume would loop. Resume it here, or abandon it in Active Runs.`
      }
    >
      parked · breaker
      <button
        type="button"
        onClick={resume}
        disabled={resuming}
        className="rounded border border-maestro-red/50 px-1 hover:bg-maestro-red/20 disabled:opacity-50"
        aria-label={`Resume run ${park.epic}`}
      >
        {resuming ? "Resuming…" : "Resume"}
      </button>
    </span>
  );
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
 *
 * Shines (amber pulse ring) while the project holds a park the user has not
 * acknowledged: a park raises no error chrome and can last a week, so the
 * quiet flat chip was routinely walked past. Clicking acknowledges it — the
 * chip stays and keeps counting down, it just stops shouting.
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
  const unacknowledged = useSessionStore((s) =>
    s.samuraiParkAlerts.some((a) => !a.acknowledged && samePath(a.project, projectPath)),
  );
  const acknowledgeParks = useSessionStore((s) => s.acknowledgeSamuraiParks);
  // Issue #209: breaker parks arm no timer, so they are NOT in the schedule
  // and need their own source. They render alongside a countdown chip rather
  // than instead of it — a project can hold both kinds at once.
  const breakerParks = useSessionStore(
    useShallow((s) => s.samuraiBreakerParks.filter((p) => samePath(p.project, projectPath))),
  );
  const soonest = earliestEntry(entries);
  // Hooks run unconditionally; the tick only arms while something is parked.
  const now = useCountdownNow(soonest !== null);
  if (!soonest) {
    return breakerParks.length === 0 ? null : (
      <span className={`flex min-w-0 flex-wrap gap-1 ${className}`}>
        {breakerParks.map((park) => (
          <BreakerParkChip key={`${park.project}|${park.epic}`} park={park} />
        ))}
      </span>
    );
  }

  const resume = formatResumeAt(soonest.fire_at, now);
  const label = resume ? `parked · resumes ${resume}` : "parked";
  const detail = entries
    .map((e) => `${e.epic}: ${formatResumeAt(e.fire_at, now) ?? e.fire_at}`)
    .join(", ");
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {breakerParks.map((park) => (
        <BreakerParkChip key={`${park.project}|${park.epic}`} park={park} />
      ))}
      <button
        type="button"
        onClick={() => acknowledgeParks(projectPath)}
        title={
          unacknowledged
            ? `Samurai park countdown — work resumes automatically (${detail}). Click to acknowledge.`
            : `Samurai park countdown — work resumes automatically (${detail})`
        }
        // Wraps rather than clipping: the full date + countdown is the whole
        // point of the chip, so a narrow sidebar takes a second line instead of
        // truncating the reading away.
        className={`min-w-0 rounded border px-1 py-px text-[9px] font-bold leading-tight tracking-wide bg-maestro-orange/15 text-maestro-orange ${
          unacknowledged ? "samurai-park-shine" : "border-maestro-orange/40"
        } ${className}`}
      >
        {label}
      </button>
      {/* Issue #211: acknowledging was the ONLY thing this chip did — a user
          who knows the window has actually reset had no button anywhere. It
          acts on the soonest-firing run (the one the countdown shows), which
          is the only epic this chip ever names. */}
      <ParkResumeButton entry={soonest} />
    </span>
  );
});

/**
 * "Resume now" for one park timer (issue #211), next to the acknowledge
 * click. Ends the park early: the timer is cancelled and the successor
 * spawns immediately.
 */
function ParkResumeButton({ entry }: { entry: SamuraiScheduleEntry }) {
  const [error, setError] = useState<string | null>(null);
  // The same shared guard the breaker chip and the Active Runs row claim:
  // the command takes no backend lock and cannot see a successor until it
  // registers, so a per-component flag let two surfaces double-spawn.
  const resuming = useSessionStore((s) =>
    s.samuraiResumingRuns.includes(samuraiRunKey(entry.project_path, entry.epic)),
  );
  const resume = async () => {
    if (resuming) return;
    setError(null);
    try {
      await resumeRunNow(entry.project_path, entry.epic);
    } catch (err) {
      setError(String(err));
    }
  };
  return (
    <button
      type="button"
      onClick={resume}
      disabled={resuming}
      title={
        error ??
        `Resume ${entry.epic} now: cancel its resume timer and spawn a fresh agent immediately. Use it when the allowance window has actually reset — if it has not, you are warned first.`
      }
      className="rounded border border-maestro-orange/50 px-1 py-px text-[9px] font-bold leading-tight tracking-wide text-maestro-orange hover:bg-maestro-orange/20 disabled:opacity-50"
      aria-label={`Resume run ${entry.epic}`}
    >
      {resuming ? "Resuming…" : "Resume"}
    </button>
  );
}
