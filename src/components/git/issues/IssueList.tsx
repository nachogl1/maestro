import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CircleDot } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  ISSUE_MAP_CLOSED_EVENT,
  ISSUE_MAP_SELECT_EVENT,
  type IssueMapSelection,
  type IssueMapTarget,
  openIssueMapWindow,
} from "@/lib/issueMapWindow";
import { useGitHubStore } from "../../../stores/useGitHubStore";
import { IssueFilters } from "./IssueFilters";
import { IssueRow } from "./IssueRow";

interface IssueListProps {
  repoPath: string;
  onSelectIssue: (issueNumber: number) => void;
  selectedIssueNumber: number | null;
}

export function IssueList({ repoPath, onSelectIssue, selectedIssueNumber }: IssueListProps) {
  const { issues, isIssuesLoading, issuesError, issueSearch, fetchIssues } = useGitHubStore();
  const onSelectIssueRef = useRef(onSelectIssue);
  onSelectIssueRef.current = onSelectIssue;

  // The map runs in its own window; it reports back by events.
  useEffect(() => {
    const unlistenSelect = listen<IssueMapSelection>(ISSUE_MAP_SELECT_EVENT, (event) => {
      if (event.payload.repoPath !== repoPath) return;
      onSelectIssueRef.current(event.payload.number);
      void getCurrentWindow().setFocus();
    });
    const unlistenClosed = listen<IssueMapTarget>(ISSUE_MAP_CLOSED_EVENT, (event) => {
      // Pick up assignment changes made in the map.
      if (event.payload.repoPath === repoPath) fetchIssues(repoPath);
    });
    return () => {
      void unlistenSelect.then((fn) => fn());
      void unlistenClosed.then((fn) => fn());
    };
  }, [repoPath, fetchIssues]);

  const openMap = () => {
    openIssueMapWindow({ repoPath, search: issueSearch }).catch((err) =>
      console.error("Failed to open the issue map window:", err),
    );
  };

  if (issuesError) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="text-center text-sm text-maestro-red">
          <p>Failed to load issues</p>
          <p className="mt-1 text-xs text-maestro-muted">{issuesError}</p>
        </div>
      </div>
    );
  }

  if (isIssuesLoading && issues.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-maestro-muted">Loading issues...</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <IssueFilters repoPath={repoPath} onOpenMap={openMap} />

      {issues.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <div className="flex flex-col items-center gap-3">
            <CircleDot size={32} className="text-maestro-muted/30" strokeWidth={1} />
            <p className="text-xs text-maestro-muted/60">No issues found</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto" style={{ scrollbarWidth: "thin" }}>
          {issues.map((issue) => (
            <IssueRow
              key={issue.number}
              issue={issue}
              isSelected={issue.number === selectedIssueNumber}
              onClick={() => onSelectIssue(issue.number)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
