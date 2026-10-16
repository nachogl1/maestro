import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted store hydrates through the Tauri store plugin at import time;
// happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));

import type { IssueInfo, PullRequestInfo } from "../useGitHubStore";
import {
  carryForwardErroredLists,
  diffNewItems,
  useGitHubWatchdogStore,
  type WatchdogProjectResult,
  type WatchdogSnapshot,
  watchedProjectsFromTabs,
} from "../useGitHubWatchdogStore";

const invokeMock = vi.mocked(invoke);

function pr(number: number, title = `PR ${number}`): PullRequestInfo {
  return {
    number,
    title,
    state: "OPEN",
    author: { login: "someone" },
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    headRefName: "feature",
    baseRefName: "main",
    isDraft: false,
    additions: 1,
    deletions: 1,
    url: `https://github.com/o/r/pull/${number}`,
    labels: [],
    mergedAt: null,
    closedAt: null,
  };
}

function issue(number: number, title = `Issue ${number}`): IssueInfo {
  return {
    number,
    title,
    state: "OPEN",
    author: { login: "someone" },
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    url: `https://github.com/o/r/issues/${number}`,
    labels: [],
    closedAt: null,
  };
}

function project(
  repoPath: string,
  reviewRequests: PullRequestInfo[] = [],
  assignedIssues: IssueInfo[] = [],
  errored: { prs?: boolean; issues?: boolean } = {},
): WatchdogProjectResult {
  return {
    name: repoPath.split("/").pop() ?? repoPath,
    repoPath,
    reviewRequests,
    assignedIssues,
    reviewRequestsErrored: errored.prs ?? false,
    assignedIssuesErrored: errored.issues ?? false,
  };
}

function snapshot(projects: WatchdogProjectResult[], polledAt = 1000): WatchdogSnapshot {
  return { status: "ok", projects, polledAt };
}

describe("diffNewItems", () => {
  it("reports nothing when there is no previous result (first poll)", () => {
    const next = project("C:/git/maestro", [pr(1)], [issue(2)]);
    expect(diffNewItems(undefined, next)).toEqual({ newPrs: [], newIssues: [] });
  });

  it("reports only items absent from the previous result", () => {
    const prev = project("C:/git/maestro", [pr(1)], [issue(10)]);
    const next = project("C:/git/maestro", [pr(1), pr(2)], [issue(10), issue(11)]);
    const diff = diffNewItems(prev, next);
    expect(diff.newPrs.map((p) => p.number)).toEqual([2]);
    expect(diff.newIssues.map((i) => i.number)).toEqual([11]);
  });

  it("reports nothing when items only disappear", () => {
    const prev = project("C:/git/maestro", [pr(1), pr(2)], [issue(10)]);
    const next = project("C:/git/maestro", [pr(1)], []);
    expect(diffNewItems(prev, next)).toEqual({ newPrs: [], newIssues: [] });
  });

  it("treats a baseline-less (errored) prev list like a first poll", () => {
    // First data after an errored fetch must not toast everything.
    const prev = project("C:/git/maestro", [], [issue(10)], { prs: true });
    const next = project("C:/git/maestro", [pr(1), pr(2)], [issue(10), issue(11)]);
    const diff = diffNewItems(prev, next);
    expect(diff.newPrs).toEqual([]);
    expect(diff.newIssues.map((i) => i.number)).toEqual([11]);
  });
});

describe("carryForwardErroredLists", () => {
  it("passes clean results through untouched", () => {
    const prev = project("C:/git/maestro", [pr(1)]);
    const next = project("C:/git/maestro", [pr(2)]);
    expect(carryForwardErroredLists(prev, next)).toBe(next);
  });

  it("keeps previous data for an errored list and clears the flag", () => {
    const prev = project("C:/git/maestro", [pr(1)], [issue(10)]);
    const next = project("C:/git/maestro", [], [issue(10), issue(11)], { prs: true });
    const merged = carryForwardErroredLists(prev, next);
    expect(merged.reviewRequests.map((p) => p.number)).toEqual([1]);
    expect(merged.reviewRequestsErrored).toBe(false);
    // The healthy issues list is taken from the new poll.
    expect(merged.assignedIssues.map((i) => i.number)).toEqual([10, 11]);
  });

  it("stays flagged when there is no baseline to carry", () => {
    const next = project("C:/git/maestro", [], [], { prs: true, issues: true });
    const merged = carryForwardErroredLists(undefined, next);
    expect(merged.reviewRequestsErrored).toBe(true);
    expect(merged.assignedIssuesErrored).toBe(true);

    // A prev entry that is itself baseline-less doesn't count either.
    const prev = project("C:/git/maestro", [], [], { prs: true });
    const again = carryForwardErroredLists(prev, next);
    expect(again.reviewRequestsErrored).toBe(true);
  });
});

describe("watchedProjectsFromTabs", () => {
  it("dedupes tabs that resolve to the same repo path (first wins)", () => {
    const projects = watchedProjectsFromTabs([
      { name: "maestro", projectPath: "C:/git/maestro", selectedRepoPath: null },
      {
        name: "maestro-again",
        projectPath: "C:/git/elsewhere",
        selectedRepoPath: "C:/git/maestro",
      },
      { name: "other", projectPath: "C:/git/other", selectedRepoPath: null },
    ]);
    expect(projects).toEqual([
      { name: "maestro", repoPath: "C:/git/maestro" },
      { name: "other", repoPath: "C:/git/other" },
    ]);
  });

  it("dedupes the same repo open under a \\\\?\\ spelling (first wins)", () => {
    const projects = watchedProjectsFromTabs([
      { name: "proj", projectPath: "C:\\git\\proj", selectedRepoPath: null },
      { name: "proj-cli", projectPath: "\\\\?\\C:\\git\\proj", selectedRepoPath: null },
    ]);
    expect(projects).toEqual([{ name: "proj", repoPath: "C:\\git\\proj" }]);
  });

  it("prefers the selected repo path over the project path", () => {
    const projects = watchedProjectsFromTabs([
      { name: "ws", projectPath: "C:/git/workspace", selectedRepoPath: "C:/git/workspace/repo" },
    ]);
    expect(projects).toEqual([{ name: "ws", repoPath: "C:/git/workspace/repo" }]);
  });
});

describe("useGitHubWatchdogStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    useGitHubWatchdogStore.setState({
      notificationsEnabled: true,
      status: "ok",
      projects: [],
      lastPolledAt: null,
      toasts: [],
    });
  });

  it("stores the snapshot without toasts on the first poll", () => {
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(snapshot([project("C:/git/maestro", [pr(1)], [issue(2)])]));

    const state = useGitHubWatchdogStore.getState();
    expect(state.projects).toHaveLength(1);
    expect(state.lastPolledAt).toBe(1000);
    expect(state.toasts).toEqual([]);
  });

  it("queues toasts only for items that appeared since the previous poll", () => {
    const store = useGitHubWatchdogStore.getState();
    store.applySnapshot(snapshot([project("C:/git/maestro", [pr(1)], [issue(10)])]));
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(
        snapshot([project("C:/git/maestro", [pr(1), pr(2, "New PR")], [issue(10)])], 2000),
      );

    const { toasts } = useGitHubWatchdogStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      kind: "pr",
      number: 2,
      title: "New PR",
      projectName: "maestro",
      url: "https://github.com/o/r/pull/2",
    });
  });

  it("does not toast for a project seen for the first time mid-run", () => {
    const store = useGitHubWatchdogStore.getState();
    store.applySnapshot(snapshot([project("C:/git/maestro", [pr(1)])]));
    // A second project appears (tab opened): its items are not "new work".
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(
        snapshot(
          [project("C:/git/maestro", [pr(1)]), project("C:/git/other", [pr(7)], [issue(8)])],
          2000,
        ),
      );
    expect(useGitHubWatchdogStore.getState().toasts).toEqual([]);
  });

  it("mutes toasts when notifications are disabled but still updates data", () => {
    const store = useGitHubWatchdogStore.getState();
    store.applySnapshot(snapshot([project("C:/git/maestro", [pr(1)])]));
    store.setNotificationsEnabled(false);
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(snapshot([project("C:/git/maestro", [pr(1), pr(2)])], 2000));

    const state = useGitHubWatchdogStore.getState();
    expect(state.toasts).toEqual([]);
    expect(state.projects[0].reviewRequests).toHaveLength(2);
    expect(state.lastPolledAt).toBe(2000);
  });

  it("disabling notifications clears queued toasts", () => {
    const store = useGitHubWatchdogStore.getState();
    store.applySnapshot(snapshot([project("C:/git/maestro")]));
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(snapshot([project("C:/git/maestro", [pr(1)])], 2000));
    expect(useGitHubWatchdogStore.getState().toasts).toHaveLength(1);

    useGitHubWatchdogStore.getState().setNotificationsEnabled(false);
    expect(useGitHubWatchdogStore.getState().toasts).toEqual([]);
  });

  it("dismissToast removes only the given toast", () => {
    const store = useGitHubWatchdogStore.getState();
    store.applySnapshot(snapshot([project("C:/git/maestro")]));
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(snapshot([project("C:/git/maestro", [pr(1)], [issue(2)])], 2000));
    const { toasts } = useGitHubWatchdogStore.getState();
    expect(toasts).toHaveLength(2);

    useGitHubWatchdogStore.getState().dismissToast(toasts[0].id);
    const remaining = useGitHubWatchdogStore.getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(toasts[1].id);
  });

  it("records the gh status from the snapshot", () => {
    useGitHubWatchdogStore
      .getState()
      .applySnapshot({ status: "gh-missing", projects: [], polledAt: 500 });
    expect(useGitHubWatchdogStore.getState().status).toBe("gh-missing");
  });

  it("keeps previous data through a transient errored poll (no toasts, stable badge)", () => {
    const store = useGitHubWatchdogStore.getState();
    store.applySnapshot(snapshot([project("C:/git/maestro", [pr(1)], [issue(10)])]));
    // Sleep/resume: the poll fails, lists arrive empty but flagged.
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(
        snapshot([project("C:/git/maestro", [], [], { prs: true, issues: true })], 2000),
      );

    const state = useGitHubWatchdogStore.getState();
    expect(state.toasts).toEqual([]);
    // Badge counts stay stable: last-known-good data carried forward.
    expect(state.projects[0].reviewRequests.map((p) => p.number)).toEqual([1]);
    expect(state.projects[0].assignedIssues.map((i) => i.number)).toEqual([10]);
  });

  it("toasts only genuinely new items after recovering from an errored poll", () => {
    const store = useGitHubWatchdogStore.getState();
    store.applySnapshot(snapshot([project("C:/git/maestro", [pr(1)])]));
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(snapshot([project("C:/git/maestro", [], [], { prs: true })], 2000));
    // Recovery poll: pr(1) still open (carried baseline), pr(2) is new.
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(snapshot([project("C:/git/maestro", [pr(1), pr(2)])], 3000));

    const { toasts } = useGitHubWatchdogStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: "pr", number: 2 });
  });

  it("does not toast the first successful data after an errored first poll", () => {
    const store = useGitHubWatchdogStore.getState();
    // First-ever poll for the project fails (e.g. gh unauthenticated).
    store.applySnapshot(snapshot([project("C:/git/maestro", [], [], { prs: true, issues: true })]));
    // Auth fixed: everything the fetch returns is pre-existing, not "new".
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(snapshot([project("C:/git/maestro", [pr(1)], [issue(10)])], 2000));

    expect(useGitHubWatchdogStore.getState().toasts).toEqual([]);
    // The baseline now exists, so later additions do toast.
    useGitHubWatchdogStore
      .getState()
      .applySnapshot(snapshot([project("C:/git/maestro", [pr(1), pr(2)], [issue(10)])], 3000));
    expect(useGitHubWatchdogStore.getState().toasts).toHaveLength(1);
  });

  it("an empty snapshot clears all project data (badge hides)", () => {
    const store = useGitHubWatchdogStore.getState();
    store.applySnapshot(snapshot([project("C:/git/maestro", [pr(1)], [issue(10)])]));
    // Last project tab closed: the poller emits an empty snapshot.
    useGitHubWatchdogStore.getState().applySnapshot(snapshot([], 2000));

    const state = useGitHubWatchdogStore.getState();
    expect(state.projects).toEqual([]);
    expect(state.lastPolledAt).toBe(2000);
    expect(state.toasts).toEqual([]);
  });

  it("syncProjects forwards the project set to the backend command", async () => {
    const projects = [{ name: "maestro", repoPath: "C:/git/maestro" }];
    await useGitHubWatchdogStore.getState().syncProjects(projects);
    expect(invokeMock).toHaveBeenCalledWith("github_watchdog_set_projects", { projects });
  });
});
