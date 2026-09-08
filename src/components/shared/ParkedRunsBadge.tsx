import { Pause } from "lucide-react";
import { formatCountdown, formatResumeAt, useCountdownNow } from "@/lib/parkTime";
import { type SamuraiParkAlert, useSessionStore } from "@/stores/useSessionStore";

/** Last path segment — the project name the tab strip shows. */
function projectName(projectPath: string): string {
  const segments = projectPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

/**
 * The park that resumes first — what the badge counts down to. Unparseable
 * fire times sort last (they never beat a real countdown), same rule as the
 * project chip's `earliestEntry`.
 */
export function soonestPark(alerts: SamuraiParkAlert[]): SamuraiParkAlert | null {
  if (alerts.length === 0) return null;
  return alerts.reduce((best, alert) => {
    const bestAt = new Date(best.fireAt).getTime();
    const at = new Date(alert.fireAt).getTime();
    if (Number.isNaN(at)) return best;
    if (Number.isNaN(bestAt)) return alert;
    return at < bestAt ? alert : best;
  });
}

interface ParkedRunsBadgeProps {
  /** Selects the project a parked run belongs to (leaves eagle/landscape). */
  onNavigate?: (projectPath: string) => void;
}

/**
 * Compact top-bar chip with every allowance-parked Samurai run across all
 * projects — "2 parked · resumes in 6d 3h 12m". Hidden when nothing is parked.
 *
 * The top bar is the one surface mounted in EVERY view (per-project grid,
 * eagle, landscape), which is the point: the project chip and the parked
 * shelf are both view-local, so a park raised while the user was in landscape
 * used to have nowhere to show. Shines until acknowledged; clicking
 * acknowledges and jumps to the project that resumes first.
 */
export function ParkedRunsBadge({ onNavigate }: ParkedRunsBadgeProps) {
  const alerts = useSessionStore((s) => s.samuraiParkAlerts);
  const acknowledgeParks = useSessionStore((s) => s.acknowledgeSamuraiParks);
  // Hooks run unconditionally; the tick only arms while something is parked.
  const now = useCountdownNow(alerts.length > 0);

  const soonest = soonestPark(alerts);
  if (!soonest) return null;

  const countdown = formatCountdown(soonest.fireAt, now);
  const unacknowledged = alerts.some((a) => !a.acknowledged);
  const detail = alerts
    .map(
      (a) => `${projectName(a.project)} · ${a.epic} · ${formatResumeAt(a.fireAt, now) ?? a.fireAt}`,
    )
    .join("\n");

  return (
    <button
      type="button"
      onClick={() => {
        acknowledgeParks();
        onNavigate?.(soonest.project);
      }}
      className={`mr-1 flex items-center gap-1 rounded-full border bg-maestro-card px-1.5 py-0.5 text-[10px] font-medium text-maestro-orange transition-colors hover:bg-maestro-orange/10 ${
        unacknowledged ? "samurai-park-shine" : "border-maestro-orange/40"
      }`}
      title={`Samurai runs parked on token allowance — work resumes automatically:\n${detail}`}
    >
      <Pause size={11} />
      <span>
        {alerts.length} parked{countdown ? ` · resumes ${countdown}` : ""}
      </span>
    </button>
  );
}
