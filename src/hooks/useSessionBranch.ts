import { useEffect, useState } from "react";
import { getDeduplicatedCurrentBranch } from "@/lib/git";
import { createSharedPoller } from "@/lib/sharedPoller";

const POLL_INTERVAL_MS = 15_000;

/** One branch poll per repo path, however many terminal views show it. */
const branchPoller = createSharedPoller<string | null>(POLL_INTERVAL_MS);

/**
 * Hook that returns the live branch name for a terminal session.
 *
 * - Worktree sessions: returns `initialBranch` immediately (branch is locked).
 * - Non-worktree sessions: fetches the real branch on mount, then polls every
 *   15 s so the header stays in sync after `git checkout` / `git switch`.
 *
 * Returns `null` while the first fetch is in-flight (caller shows "...").
 */
export function useSessionBranch(
  projectPath: string,
  isWorktree: boolean,
  initialBranch: string | null,
  isActive: boolean = true,
): string | null {
  const [branch, setBranch] = useState<string | null>(isWorktree ? initialBranch : null);

  // Keep in sync if the store pushes a new initialBranch while mounted
  useEffect(() => {
    if (isWorktree && initialBranch !== null) {
      setBranch(initialBranch);
    }
  }, [isWorktree, initialBranch]);

  // Non-worktree: fetch immediately + poll
  // biome-ignore lint/correctness/useExhaustiveDependencies: `branch` is read only as a one-time "haven't fetched yet" guard on (re)mount; adding it as a dependency would re-run this effect (tearing down and restarting the poll interval) every time a fetch inside it calls setBranch.
  useEffect(() => {
    if (isWorktree || !projectPath) return;

    // Only reset if we don't have a value yet (initial mount)
    if (branch === null) {
      setBranch(null);
    }

    // Shared per path: fetches on subscribe when active, then polls while the
    // window has focus. Inactive tabs only receive what active ones fetch, to
    // avoid annoying macOS permission pop-ups in the background.
    return branchPoller.subscribe(
      projectPath,
      () => getDeduplicatedCurrentBranch(projectPath).catch(() => null),
      setBranch,
      isActive,
    );
  }, [isWorktree, projectPath, isActive]);

  return branch;
}
