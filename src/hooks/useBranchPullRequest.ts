import { useEffect, useState } from "react";

import { type BranchPullRequest, getBranchPullRequest } from "@/lib/github";
import { createSharedPoller } from "@/lib/sharedPoller";

/**
 * How often a terminal re-checks whether its branch has a PR yet. The lib-level
 * cache absorbs most of these; this interval only bounds how long after opening
 * a PR the header takes to notice it.
 */
const POLL_INTERVAL_MS = 60_000;

/** Placeholder the header shows while the branch name is still being read. */
const UNKNOWN_BRANCH = "...";

/** One PR poll per repo path + branch, however many terminal views show it. */
const prPoller = createSharedPoller<BranchPullRequest | null>(POLL_INTERVAL_MS);

/**
 * The pull request for a terminal's branch, or null when it has none (or the
 * repo isn't on GitHub, or `gh` isn't available — all indistinguishable, and
 * all mean "no link to show").
 *
 * Follows {@link useSessionBranch}: fetch on mount, poll while the terminal is
 * in the active tab and the window has focus, so background projects don't keep
 * spawning `gh` processes.
 */
export function useBranchPullRequest(
  repoPath: string,
  branch: string | null,
  isActive: boolean = true,
): BranchPullRequest | null {
  const [pr, setPr] = useState<BranchPullRequest | null>(null);

  useEffect(() => {
    // A branch is needed to ask the question at all; the placeholder means the
    // branch read is still in flight and this effect re-runs when it lands.
    if (!repoPath || !branch || branch === UNKNOWN_BRANCH || branch === "HEAD") {
      setPr(null);
      return;
    }

    return prPoller.subscribe(
      JSON.stringify([repoPath, branch]),
      () => getBranchPullRequest(repoPath, branch),
      setPr,
      isActive,
    );
  }, [repoPath, branch, isActive]);

  return pr;
}
