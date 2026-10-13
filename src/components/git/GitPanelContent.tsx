import type { GraphNode } from "../../lib/graphLayout";
import { BranchesPanel } from "./branches/BranchesPanel";
import { CommitGraph } from "./CommitGraph";
import { DiscussionList } from "./discussions/DiscussionList";
import type { GitPanelTab } from "./GitPanelTabs";
import { IssueList } from "./issues/IssueList";
import { PullRequestList } from "./pulls/PullRequestList";
import { WorktreeStatusList } from "./status/WorktreeStatusList";

interface GitPanelContentProps {
  activeTab: GitPanelTab;
  repoPath: string;
  /** `false` while the git panel is shut. The panel stays mounted at width 0
   *  for the open/close animation, so tab content must stop polling itself
   *  rather than rely on being unmounted. */
  open?: boolean;
  currentBranch: string | null;
  onSelectCommit: (node: GraphNode) => void;
  selectedCommitHash: string | null;
  onSelectPR: (prNumber: number) => void;
  selectedPRNumber: number | null;
  onSelectIssue: (issueNumber: number) => void;
  selectedIssueNumber: number | null;
  onSelectDiscussion: (discussionNumber: number) => void;
  selectedDiscussionNumber: number | null;
}

export function GitPanelContent({
  activeTab,
  repoPath,
  open = true,
  currentBranch,
  onSelectCommit,
  selectedCommitHash,
  onSelectPR,
  selectedPRNumber,
  onSelectIssue,
  selectedIssueNumber,
  onSelectDiscussion,
  selectedDiscussionNumber,
}: GitPanelContentProps) {
  switch (activeTab) {
    case "commits":
      return (
        <CommitGraph
          repoPath={repoPath}
          onSelectCommit={onSelectCommit}
          selectedCommitHash={selectedCommitHash}
          currentBranch={currentBranch}
        />
      );
    case "branches":
      return <BranchesPanel repoPath={repoPath} />;
    case "status":
      return <WorktreeStatusList repoPath={repoPath} active={open} />;
    case "prs":
      return (
        <PullRequestList
          repoPath={repoPath}
          onSelectPR={onSelectPR}
          selectedPRNumber={selectedPRNumber}
        />
      );
    case "issues":
      return (
        <IssueList
          repoPath={repoPath}
          onSelectIssue={onSelectIssue}
          selectedIssueNumber={selectedIssueNumber}
        />
      );
    case "discussions":
      return (
        <DiscussionList
          onSelectDiscussion={onSelectDiscussion}
          selectedDiscussionNumber={selectedDiscussionNumber}
        />
      );
    default:
      return null;
  }
}
