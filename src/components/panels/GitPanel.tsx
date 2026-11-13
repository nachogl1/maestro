import { RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { GitGraphPanel } from "@/components/git/GitGraphPanel";
import type { GitPanelTab } from "@/components/git/GitPanelTabs";
import { useGitStore } from "@/stores/useGitStore";

/** Header title for each git-panel tab. */
const GIT_PANEL_TITLES: Record<GitPanelTab, string> = {
  commits: "Commits",
  branches: "Branches",
  status: "Status",
  prs: "Pull Requests",
  issues: "Issues",
  discussions: "Discussions",
};

/** What the Git panel shows; App owns this state so shortcuts and badges can drive it. */
export type GitPanelProps = Omit<Parameters<typeof GitGraphPanel>[0], "open" | "onClose">;

/** The Git panel's header details: repository, tab title, commit count and refresh. */
export function GitPanelHeaderExtra({
  repoPath,
  repositories,
  workspaceType,
  activeTab,
}: GitPanelProps) {
  // Granular selectors: a whole-store subscription re-renders on every git `set()`.
  const commitCount = useGitStore((s) => s.commits.length);
  const fetchCommits = useGitStore((s) => s.fetchCommits);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (!repoPath) return;
    setIsRefreshing(true);
    try {
      await fetchCommits(repoPath);
    } finally {
      setIsRefreshing(false);
    }
  }, [repoPath, fetchCommits]);

  const repoName =
    workspaceType === "multi-repo"
      ? repositories.find((r) => r.path === repoPath)?.name
      : undefined;

  return (
    <>
      {repoName && <span className="text-xs font-medium text-maestro-accent">{repoName}</span>}
      <span className="truncate text-xs text-maestro-muted">{GIT_PANEL_TITLES[activeTab]}</span>
      {activeTab === "commits" && commitCount > 0 && (
        <span className="rounded-full bg-maestro-accent/15 px-1.5 py-px text-[10px] font-medium text-maestro-accent">
          {commitCount}
        </span>
      )}
      {repoPath && (
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text disabled:opacity-50"
          aria-label="Refresh commits"
          title="Refresh commits"
        >
          <RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} />
        </button>
      )}
    </>
  );
}

/** The Git panel's body: the git graph panel, with its eagle-view carousel. */
export function GitPanelBody({ open, ...props }: GitPanelProps & { open: boolean }) {
  return <GitGraphPanel {...props} open={open} onClose={() => {}} />;
}
