import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IssueLinks } from "@/lib/issueGraph";
import type { IssueInfo } from "@/stores/useGitHubStore";

/** A user who can be assigned to issues in the repo. */
export interface RepoAssignee {
  login: string;
  avatarUrl: string;
}

/** How many issues the hierarchy view fetches (the superset it filters locally). */
const HIERARCHY_ISSUE_LIMIT = 200;

export interface IssueHierarchyState {
  issues: IssueInfo[];
  links: Record<number, IssueLinks>;
  assignees: RepoAssignee[];
  isLoading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Add/remove assignees on one issue; re-throws (after reverting) on failure. */
  setAssignees: (number: number, add: string[], remove: string[]) => Promise<void>;
}

/**
 * Local data for the issue hierarchy modal.
 *
 * Deliberately NOT in `useGitHubStore`: the modal fetches a wider set (every
 * state, up to 200) than the sidebar list, and writing it into the store would
 * clobber what the sidebar shows.
 */
export function useIssueHierarchy(repoPath: string, search: string): IssueHierarchyState {
  const [issues, setIssues] = useState<IssueInfo[]>([]);
  const [links, setLinks] = useState<Record<number, IssueLinks>>({});
  const [assignees, setRepoAssignees] = useState<RepoAssignee[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped per load, so a slow response from an older load is dropped.
  const tokenRef = useRef(0);
  // Mirror of `issues` so `setAssignees` can snapshot the pre-patch value
  // synchronously (a state updater may run later than the await below).
  const issuesRef = useRef<IssueInfo[]>([]);
  issuesRef.current = issues;

  const reload = useCallback(async (): Promise<void> => {
    const token = ++tokenRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const trimmed = search.trim();
      const fetched = await invoke<IssueInfo[]>("github_list_issues", {
        repoPath,
        state: null,
        limit: HIERARCHY_ISSUE_LIMIT,
        search: trimmed ? trimmed : null,
      });
      if (token !== tokenRef.current) return;
      const numbers = fetched.map((issue) => issue.number);
      const [linkList, repoAssignees] = await Promise.all([
        numbers.length > 0
          ? invoke<IssueLinks[]>("github_issue_links", { repoPath, numbers })
          : Promise.resolve([] as IssueLinks[]),
        invoke<RepoAssignee[]>("github_list_assignees", { repoPath }),
      ]);
      if (token !== tokenRef.current) return;
      const byNumber: Record<number, IssueLinks> = {};
      for (const link of linkList) byNumber[link.number] = link;
      setIssues(fetched);
      setLinks(byNumber);
      setRepoAssignees(repoAssignees);
      setIsLoading(false);
    } catch (err) {
      if (token !== tokenRef.current) return;
      console.error("Failed to load issue hierarchy:", err);
      setError(err instanceof Error ? err.message : String(err));
      setIsLoading(false);
    }
  }, [repoPath, search]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setAssignees = useCallback(
    async (number: number, add: string[], remove: string[]): Promise<void> => {
      const previous = issuesRef.current.find((issue) => issue.number === number)?.assignees;
      const patch = (issue: IssueInfo): IssueInfo => {
        const kept = (issue.assignees ?? []).filter((a) => !remove.includes(a.login));
        const added = add
          .filter((login) => !kept.some((a) => a.login === login))
          .map((login) => ({ login }));
        return { ...issue, assignees: [...kept, ...added] };
      };
      setIssues((current) =>
        current.map((issue) => (issue.number === number ? patch(issue) : issue)),
      );
      try {
        await invoke<void>("github_update_issue_assignees", { repoPath, number, add, remove });
      } catch (err) {
        if (previous !== undefined) {
          setIssues((current) =>
            current.map((issue) =>
              issue.number === number ? { ...issue, assignees: previous } : issue,
            ),
          );
        }
        throw err;
      }
    },
    [repoPath],
  );

  return { issues, links, assignees, isLoading, error, reload, setAssignees };
}
