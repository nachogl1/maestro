import { ask } from "@tauri-apps/plugin-dialog";
import { type SamuraiRecoverResult, samuraiGetConfig, samuraiResumeNow } from "@/lib/samurai";
import { useUsageStore } from "@/stores/useUsageStore";

/**
 * The hard park thresholds used when the backend config cannot be read
 * (`samurai_config.rs`'s own defaults). A warning is a courtesy, so a
 * config read that fails must never stop the resume — it just falls back to
 * the shipped numbers.
 */
const DEFAULT_HARD_5H_PCT = 90;
const DEFAULT_HARD_7D_PCT = 95;

/** One live allowance reading that is already past its hard park threshold. */
interface OverThreshold {
  label: string;
  percent: number;
  threshold: number;
}

/**
 * The allowance windows that would park a run again the moment it spawns:
 * the 5-hour session and the 7-day week, each against the threshold the
 * parker actually uses. Empty when nothing is over (or when there is no
 * reading at all — an unknown allowance is not a warning).
 */
async function overHardThresholds(): Promise<OverThreshold[]> {
  let hard5h = DEFAULT_HARD_5H_PCT;
  let hard7d = DEFAULT_HARD_7D_PCT;
  try {
    const config = await samuraiGetConfig();
    hard5h = config.park_hard_5h_pct;
    hard7d = config.park_hard_7d_pct;
  } catch {
    // Defaults above; see DEFAULT_HARD_5H_PCT.
  }
  const usage = useUsageStore.getState().usage;
  const readings: OverThreshold[] = [
    {
      label: "the 5-hour session",
      percent: usage?.sessionPercent ?? Number.NaN,
      threshold: hard5h,
    },
    { label: "the weekly window", percent: usage?.weeklyPercent ?? Number.NaN, threshold: hard7d },
  ];
  return readings.filter((r) => Number.isFinite(r.percent) && r.percent >= r.threshold);
}

/**
 * Issue #211: end a park EARLY — the resume action behind the Second Brain's
 * timer row (the Launch panel and the park chip that also offered it are
 * gone).
 *
 * It cancels the run's pending resume timer and spawns the successor
 * immediately (`samurai_resume_now`); the backend still refuses a run that
 * is not ACTIVE or that has a live supervised session, and still clears a
 * breaker park's stamp and counter.
 *
 * What it does that the raw command cannot: it **warns on an exhausted
 * allowance.** If a window is still past its hard park threshold the run will
 * very likely park again within minutes, so the user is told the actual
 * reading and confirms. It is their call — this never refuses on its own.
 * The one remaining caller is busy while this runs, so a second click cannot
 * stage a duplicate successor.
 *
 * Resolves `null` when the user declined the allowance warning and REJECTS
 * with the backend's refusal, which the caller surfaces in place.
 */
export async function resumeRunNow(
  project: string,
  epic: string,
): Promise<SamuraiRecoverResult | null> {
  const over = await overHardThresholds();
  if (over.length > 0) {
    const readings = over
      .map((r) => `${r.label} is at ${Math.round(r.percent)}% (parks at ${r.threshold}%)`)
      .join(", and ");
    const confirmed = await ask(
      `Resume ${epic} now? The allowance has not recovered: ${readings}. The run will very likely park again within minutes.`,
      { title: "Allowance Still Exhausted", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return null;
  }
  return samuraiResumeNow(project, epic);
}
