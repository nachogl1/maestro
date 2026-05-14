import {
  GitBranch,
  GitPullRequest,
  CircleDot,
  MessageCircle,
  FileWarning,
  StickyNote,
} from "lucide-react";

export type GitPanelTab = "commits" | "status" | "prs" | "issues" | "discussions" | "notes";

/** Tabs that require GitHub auth + the `gh` CLI. */
export const GITHUB_TABS: ReadonlyArray<GitPanelTab> = ["prs", "issues", "discussions"];

interface GitPanelTabsProps {
  activeTab: GitPanelTab;
  onTabChange: (tab: GitPanelTab) => void;
  prCount?: number;
  issueCount?: number;
}

const TABS: Array<{
  id: GitPanelTab;
  label: string;
  icon: typeof GitBranch;
}> = [
  { id: "commits", label: "Commits", icon: GitBranch },
  { id: "status", label: "Status", icon: FileWarning },
  { id: "prs", label: "PRs", icon: GitPullRequest },
  { id: "issues", label: "Issues", icon: CircleDot },
  { id: "discussions", label: "Discussions", icon: MessageCircle },
  // Notes is a per-app (not per-repo) view but lives alongside these tabs so
  // users get a single right-pane home. It doesn't need a repo to function.
  { id: "notes", label: "Notes", icon: StickyNote },
];

export function GitPanelTabs({ activeTab, onTabChange, prCount, issueCount }: GitPanelTabsProps) {
  return (
    <div className="flex shrink-0 border-b border-maestro-border">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;

        // Get count for badge
        let count: number | undefined;
        if (tab.id === "prs") count = prCount;
        if (tab.id === "issues") count = issueCount;

        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs transition-colors ${
              isActive
                ? "border-b-2 border-maestro-accent text-maestro-accent"
                : "text-maestro-muted hover:text-maestro-text"
            }`}
          >
            <Icon size={14} />
            <span>{tab.label}</span>
            {count !== undefined && count > 0 && (
              <span
                className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  isActive
                    ? "bg-maestro-accent/20 text-maestro-accent"
                    : "bg-maestro-surface text-maestro-muted"
                }`}
              >
                {count > 99 ? "99+" : count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
