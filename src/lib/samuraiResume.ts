import { ask } from "@tauri-apps/plugin-dialog";
import { samePath } from "@/lib/path";
import { type SamuraiRecoverResult, samuraiGetConfig, samuraiResumeNow } from "@/lib/samurai";
import { samuraiRunKey, useSessionStore } from "@/stores/useSessionStore";
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
 * Issue #211: end a park EARLY — the ONE resume action behind every park
 * kind (allowance, gh-auth, circuit breaker), shared by the Active Runs
 * row, the park chip and the timer-cancel confirm.
 *
 * It cancels the run's pending resume timer and spawns the successor
 * immediately (`samurai_resume_now`); the backend still refuses a run that
 * is not ACTIVE or that has a live supervised session, and still clears a
 * breaker park's stamp and counter.
 *
 * Two things it does that the raw command cannot:
 *
 * - **Warns on an exhausted allowance.** If a window is still past its hard
 *   park threshold the run will very likely park again within minutes, so
 *   the user is told the actual reading and confirms. It is their call —
 *   this never refuses on its own.
 * - **Claims the shared in-flight guard** (`samuraiResumingRuns`, issue
 *   #209). The command takes no backend lock and its "no live session"
 *   check cannot bite until the successor registers, so two surfaces
 *   clicking at once could stage two gen-N+1 orchestrators into one
 *   worktree.
 *
 * Resolves `null` when the resume did not start (another surface holds the
 * guard, or the user declined the allowance warning) and REJECTS with the
 * backend's refusal, which every caller surfaces in place.
 */
export async function resumeRunNow(
  project: string,
  epic: string,
): Promise<SamuraiRecoverResult | null> {
  const store = useSessionStore.getState();
  if (store.samuraiResumingRuns.includes(samuraiRunKey(project, epic))) return null;

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

  store.setSamuraiRunResuming(project, epic, true);
  try {
    const result = await samuraiResumeNow(project, epic);
    // The run has an owner again, and its park is cleared backend-side — so
    // its breaker chip goes with it rather than lingering until the next
    // Active Runs refresh republishes the list.
    const state = useSessionStore.getState();
    state.setSamuraiBreakerParks(
      state.samuraiBreakerParks.filter((p) => !(samePath(p.project, project) && p.epic === epic)),
    );
    return result;
  } finally {
    useSessionStore.getState().setSamuraiRunResuming(project, epic, false);
  }
}
