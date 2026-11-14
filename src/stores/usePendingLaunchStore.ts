import { create } from "zustand";
import type { PrReviewLaunch } from "@/lib/terminalPrompt";
import type { AiMode } from "@/stores/useSessionStore";

/**
 * A one-shot request, made from outside the terminal grid (e.g. the sidebar
 * History tab), to create a pre-configured slot in a project's grid and
 * launch it immediately. The grid for `tabId` consumes the request on mount
 * or as soon as it arrives — this indirection works whether or not the grid
 * is currently mounted, which the imperative grid handle cannot do.
 */
export interface PendingLaunch {
  tabId: string;
  mode: AiMode;
  /** Claude conversation UUID to resume, or null for a fresh session. */
  resumeSessionId: string | null;
  /** Launch in this exact directory (an existing worktree) instead of deriving one. */
  workingDirOverride: string | null;
  /** Branch shown in the session header when launching into a worktree. */
  branch: string | null;
  /** Custom session name applied at launch (terminal header). */
  customName?: string | null;
  /**
   * Generic "launch a terminal with an initial prompt": the grid arms the
   * session via `terminal_arm_initial_prompt` right before the CLI launches,
   * and the backend types this text into the PTY on the session's first
   * SessionStarted hook signal. Claude-mode launches only — no other CLI
   * emits that hook. May be multi-line; the backend collapses every
   * whitespace run to a single space before typing (a newline inside an
   * injected prompt submits a partial message).
   */
  initialPrompt?: string | null;
  /**
   * Where a long `initialPrompt` is staged as a brief FILE instead of being
   * typed (issue #138): the checkout whose `.maestro/briefs/` receives it,
   * plus the file stem. Both are needed for the backend to use them; a launch
   * that leaves them unset has its prompt typed inline, whatever its size.
   */
  briefDir?: string | null;
  briefStem?: string | null;
  /**
   * PR-review launch metadata (issue #139): passed to the same arm hop, which
   * writes the review's persistent run record — the identity its brief and
   * audit rows are grouped under on disk. A review without it still runs; it
   * simply leaves nothing on disk to group.
   */
  prRun?: PrReviewLaunch | null;
  /**
   * Crash recovery (issue #608): one id per terminal being brought back, so
   * two terminals that look alike (two unnamed shells in one folder) are two
   * launches, not one deduplicated request.
   */
  restoreKey?: string | null;
}

interface PendingLaunchState {
  /**
   * FIFO queue of unconsumed requests (fresh-eyes finding B). A single slot
   * silently dropped launches when two arrived before either was consumed —
   * e.g. two terminals brought back by crash recovery in one tick. A queue with one entry behaves exactly like the
   * old single slot, so History-tab callers are unchanged.
   */
  pending: PendingLaunch[];
  request: (launch: PendingLaunch) => void;
  /** Atomically claim the OLDEST pending launch for a tab; null when none is queued for it. */
  consume: (tabId: string) => PendingLaunch | null;
}

/**
 * Two requests are the same launch when every identifying field matches. The
 * old single-slot store accidentally deduped rapid duplicate requests (e.g. a
 * History-tab double-click, which would otherwise resume the same Claude
 * session twice); the FIFO queue restores that on purpose, while distinct
 * launches still all queue.
 */
function sameLaunch(a: PendingLaunch, b: PendingLaunch): boolean {
  return (
    a.tabId === b.tabId &&
    a.mode === b.mode &&
    a.resumeSessionId === b.resumeSessionId &&
    a.workingDirOverride === b.workingDirOverride &&
    a.branch === b.branch &&
    (a.customName ?? null) === (b.customName ?? null) &&
    (a.initialPrompt ?? null) === (b.initialPrompt ?? null) &&
    // Issue #136 review (C11): two launches carrying the SAME prompt can
    // still differ in where that prompt is staged as a brief, or in which PR
    // review they record — collapsing them silently dropped one of the two.
    (a.briefDir ?? null) === (b.briefDir ?? null) &&
    (a.briefStem ?? null) === (b.briefStem ?? null) &&
    (a.prRun?.pr ?? null) === (b.prRun?.pr ?? null) &&
    (a.prRun?.repo ?? null) === (b.prRun?.repo ?? null) &&
    (a.prRun?.project_path ?? null) === (b.prRun?.project_path ?? null) &&
    JSON.stringify(a.prRun?.steps ?? []) === JSON.stringify(b.prRun?.steps ?? []) &&
    (a.restoreKey ?? null) === (b.restoreKey ?? null)
  );
}

export const usePendingLaunchStore = create<PendingLaunchState>((set, get) => ({
  pending: [],
  request: (launch) =>
    set((s) =>
      s.pending.some((p) => sameLaunch(p, launch)) ? s : { pending: [...s.pending, launch] },
    ),
  consume: (tabId) => {
    const queue = get().pending;
    const index = queue.findIndex((p) => p.tabId === tabId);
    if (index === -1) return null;
    set({ pending: queue.filter((_, i) => i !== index) });
    return queue[index];
  },
}));

/**
 * Whether a queued or claimed launch is about to land in the grid for `tabId`
 * (fresh-eyes finding A). TerminalGrid's last-slot kill path checks this
 * before returning the project to the idle landing view: unmounting the grid
 * at that moment would destroy a launch that is still queued here or already
 * claimed by the grid's consume effect (and not yet handed to launchSlot).
 * `claimedLaunchCount` is grid-local, so it counts regardless of `tabId`.
 */
export function pendingLaunchImminent(
  queued: readonly Pick<PendingLaunch, "tabId">[],
  claimedLaunchCount: number,
  tabId: string | null | undefined,
): boolean {
  if (claimedLaunchCount > 0) return true;
  if (!tabId) return false;
  return queued.some((p) => p.tabId === tabId);
}
