import { GitPullRequest, RefreshCw } from "lucide-react";
import { useGitHubStore } from "../../../stores/useGitHubStore";
import { PullRequestFilters } from "./PullRequestFilters";
import { PullRequestRow } from "./PullRequestRow";

interface PullRequestListProps {
  repoPath: string;
  onSelectPR: (prNumber: number) => void;
  selectedPRNumber: number | null;
}

export function PullRequestList({ repoPath, onSelectPR, selectedPRNumber }: PullRequestListProps) {
  const { pullRequests, isPRsLoading, prsError, fetchPullRequests } = useGitHubStore();

  if (prsError) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="text-center text-sm text-maestro-red">
          <p>Failed to load pull requests</p>
          <p className="mt-1 text-xs text-maestro-muted">{prsError}</p>
        </div>
      </div>
    );
  }

  if (isPRsLoading && pullRequests.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-maestro-muted">Loading pull requests...</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PullRequestFilters repoPath={repoPath} />

      {/* Count + manual refresh. No polling: the list reloads on demand. */}
      <div className="flex shrink-0 items-center justify-between border-b border-maestro-border px-3 py-1">
        <span className="text-[10px] uppercase tracking-wide text-maestro-muted">
          {pullRequests.length} {pullRequests.length === 1 ? "pull request" : "pull requests"}
        </span>
        <button
          type="button"
          onClick={() => fetchPullRequests(repoPath)}
          className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
          title="Reload pull requests"
          aria-label="Refresh pull requests"
        >
          <RefreshCw size={11} className={isPRsLoading ? "animate-spin" : undefined} />
        </button>
      </div>

      {pullRequests.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <div className="flex flex-col items-center gap-3">
            <GitPullRequest size={32} className="text-maestro-muted/30" strokeWidth={1} />
            <p className="text-xs text-maestro-muted/60">No pull requests found</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto" style={{ scrollbarWidth: "thin" }}>
          {pullRequests.map((pr) => (
            <PullRequestRow
              key={pr.number}
              pr={pr}
              isSelected={pr.number === selectedPRNumber}
              onClick={() => onSelectPR(pr.number)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
