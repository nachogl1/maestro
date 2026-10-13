import { GitPullRequest } from "lucide-react";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";

interface GitHubWatchdogBadgeProps {
  /** Navigate to the git panel: PRs tab (review-requested) with the
   *  watchdog search filter applied. */
  onNavigate: (kind: "prs" | "issues") => void;
}

/**
 * Compact top-bar badge with the watchdog review-request total across all
 * projects, e.g. "2 PRs". Hidden when the total is zero. Clicking it routes
 * to the git panel's PRs tab + filter. Assigned issues are still watched
 * (toasts + the Issues tab) but no longer get a pill here.
 */
export function GitHubWatchdogBadge({ onNavigate }: GitHubWatchdogBadgeProps) {
  const projects = useGitHubWatchdogStore((s) => s.projects);

  const prCount = projects.reduce((sum, p) => sum + p.reviewRequests.length, 0);

  if (prCount === 0) return null;

  const projectNames = projects
    .filter((p) => p.reviewRequests.length > 0)
    .map((p) => `${p.name} (${p.reviewRequests.length})`)
    .join(", ");

  return (
    <div className="mr-1 flex items-center gap-1 rounded-full border border-maestro-border bg-maestro-card px-1.5 py-0.5">
      <button
        type="button"
        onClick={() => onNavigate("prs")}
        className="flex items-center gap-1 rounded-full px-1 text-[10px] font-medium text-maestro-accent transition-colors hover:bg-maestro-accent/10"
        title={`Review requested: ${projectNames}`}
      >
        <GitPullRequest size={11} />
        <span>
          {prCount} PR{prCount === 1 ? "" : "s"}
        </span>
      </button>
    </div>
  );
}
