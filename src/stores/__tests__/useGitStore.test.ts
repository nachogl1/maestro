import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, invalidateMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  invalidateMock: vi.fn(),
}));

// Tauri APIs must be mocked before importing the store module.
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/git", () => ({ invalidateCurrentBranchCache: invalidateMock }));

import { type CommitInfo, useGitStore } from "../useGitStore";

function commits(n: number): CommitInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    hash: `h${i}`,
    short_hash: `s${i}`,
    parent_hashes: [],
    author_name: "a",
    author_email: "a@x",
    timestamp: i,
    summary: `c${i}`,
  }));
}

/** Routes invoke(cmd, args) to a per-command handler. */
function route(handlers: Record<string, (args: Record<string, unknown>) => unknown>): void {
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    const handler = handlers[cmd];
    if (!handler) throw new Error(`unexpected command ${cmd}`);
    return handler(args);
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("useGitStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invalidateMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    useGitStore.getState().reset();
  });

  it("fetchBranches stores the branches and clears loading", async () => {
    const branches = [{ name: "main", is_remote: false, is_current: true }];
    route({ git_branches: () => branches });

    await useGitStore.getState().fetchBranches("/repo");

    const s = useGitStore.getState();
    expect(s.branches).toEqual(branches);
    expect(s.isLoading).toBe(false);
    expect(s.activeRepoPath).toBe("/repo");
    expect(invokeMock).toHaveBeenCalledWith("git_branches", { repoPath: "/repo" });
  });

  it("fetchBranches records the error and empties branches on failure", async () => {
    useGitStore.setState({ branches: [{ name: "x", is_remote: false, is_current: false }] });
    route({
      git_branches: () => {
        throw "boom";
      },
    });

    await useGitStore.getState().fetchBranches("/repo");

    const s = useGitStore.getState();
    expect(s.error).toBe("boom");
    expect(s.branches).toEqual([]);
    expect(s.isLoading).toBe(false);
  });

  it("drops a branch response superseded by a fetch for another repo", async () => {
    const slow = deferred<unknown>();
    invokeMock.mockImplementation((_cmd: string, args: { repoPath: string }) =>
      args.repoPath === "/a"
        ? slow.promise
        : Promise.resolve([{ name: "b-main", is_remote: false, is_current: true }]),
    );

    const first = useGitStore.getState().fetchBranches("/a");
    await useGitStore.getState().fetchBranches("/b");
    slow.resolve([{ name: "a-main", is_remote: false, is_current: true }]);
    await first;

    expect(useGitStore.getState().branches.map((b) => b.name)).toEqual(["b-main"]);
  });

  it("fetchCurrentBranch sets and, on failure, clears the current branch", async () => {
    route({ git_current_branch: () => "feat/x" });
    await useGitStore.getState().fetchCurrentBranch("/repo");
    expect(useGitStore.getState().currentBranch).toBe("feat/x");

    route({
      git_current_branch: () => {
        throw new Error("no head");
      },
    });
    await useGitStore.getState().fetchCurrentBranch("/repo");
    expect(useGitStore.getState().currentBranch).toBeNull();
  });

  it("fetchCommits sets hasMoreCommits from whether the page was full", async () => {
    route({ git_commit_log: (a) => commits(a.maxCount === 3 ? 3 : 1) });

    await useGitStore.getState().fetchCommits("/repo", 3);
    expect(useGitStore.getState().commits).toHaveLength(3);
    expect(useGitStore.getState().hasMoreCommits).toBe(true);

    await useGitStore.getState().fetchCommits("/repo", 5);
    expect(useGitStore.getState().commits).toHaveLength(1);
    expect(useGitStore.getState().hasMoreCommits).toBe(false);
    expect(invokeMock).toHaveBeenLastCalledWith("git_commit_log", {
      repoPath: "/repo",
      maxCount: 5,
      allBranches: true,
    });
  });

  it("fetchCommits records the error on failure", async () => {
    route({
      git_commit_log: () => {
        throw "bad repo";
      },
    });

    await useGitStore.getState().fetchCommits("/repo");

    expect(useGitStore.getState().error).toBe("bad repo");
    expect(useGitStore.getState().commits).toEqual([]);
  });

  it("loadMoreCommits asks for 50 more and replaces the list", async () => {
    useGitStore.setState({ commits: commits(50), hasMoreCommits: true });
    route({ git_commit_log: () => commits(70) });

    await useGitStore.getState().loadMoreCommits("/repo", false);

    expect(invokeMock).toHaveBeenCalledWith("git_commit_log", {
      repoPath: "/repo",
      maxCount: 100,
      allBranches: false,
    });
    const s = useGitStore.getState();
    expect(s.commits).toHaveLength(70);
    expect(s.hasMoreCommits).toBe(false);
    expect(s.isLoadingMore).toBe(false);
  });

  it("loadMoreCommits is a no-op when there is nothing more or a load is running", async () => {
    useGitStore.setState({ hasMoreCommits: false });
    await useGitStore.getState().loadMoreCommits("/repo");
    useGitStore.setState({ hasMoreCommits: true, isLoadingMore: true });
    await useGitStore.getState().loadMoreCommits("/repo");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("checkoutBranch invalidates the branch cache and refreshes the current branch", async () => {
    route({
      git_checkout_branch: () => undefined,
      git_current_branch: () => "dev",
      git_commit_log: () => commits(2),
    });

    await useGitStore.getState().checkoutBranch("/repo", "dev");

    expect(invokeMock).toHaveBeenCalledWith("git_checkout_branch", {
      repoPath: "/repo",
      branchName: "dev",
    });
    expect(invalidateMock).toHaveBeenCalledWith("/repo");
    expect(useGitStore.getState().currentBranch).toBe("dev");
    await vi.waitFor(() => expect(useGitStore.getState().commits).toHaveLength(2));
  });

  it("checkoutBranch records the error and rethrows on failure", async () => {
    route({
      git_checkout_branch: () => {
        throw "dirty tree";
      },
    });

    await expect(useGitStore.getState().checkoutBranch("/repo", "dev")).rejects.toBe("dirty tree");
    expect(useGitStore.getState().error).toBe("dirty tree");
    expect(useGitStore.getState().isLoading).toBe(false);
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("createBranch passes a null start point and refetches branches", async () => {
    route({
      git_create_branch: () => undefined,
      git_branches: () => [{ name: "new", is_remote: false, is_current: false }],
    });

    await useGitStore.getState().createBranch("/repo", "new");

    expect(invokeMock).toHaveBeenCalledWith("git_create_branch", {
      repoPath: "/repo",
      branchName: "new",
      startPoint: null,
    });
    expect(useGitStore.getState().branches.map((b) => b.name)).toEqual(["new"]);
    expect(useGitStore.getState().isLoading).toBe(false);
  });

  it("deleteBranch, renameBranch and deleteRemoteBranch refetch branches", async () => {
    route({
      git_delete_branch: () => undefined,
      git_rename_branch: () => undefined,
      git_delete_remote_branch: () => undefined,
      git_current_branch: () => "renamed",
      git_branches: () => [],
    });

    await useGitStore.getState().deleteBranch("/repo", "old", true);
    await useGitStore.getState().renameBranch("/repo", "a", "renamed");
    await useGitStore.getState().deleteRemoteBranch("/repo", "origin", "gone");

    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds.filter((c) => c === "git_branches")).toHaveLength(3);
    expect(invokeMock).toHaveBeenCalledWith("git_delete_branch", {
      repoPath: "/repo",
      branchName: "old",
      force: true,
    });
    expect(useGitStore.getState().currentBranch).toBe("renamed");
  });

  it("deleteBranch records the error and rethrows", async () => {
    route({
      git_delete_branch: () => {
        throw "not merged";
      },
    });

    await expect(useGitStore.getState().deleteBranch("/repo", "x")).rejects.toBe("not merged");
    expect(useGitStore.getState().error).toBe("not merged");
  });

  it("setUserConfig writes then re-reads the user config", async () => {
    route({
      git_set_user_config: () => undefined,
      git_user_config: () => ({ name: "N", email: "e@x" }),
    });

    await useGitStore.getState().setUserConfig("/repo", "N", "e@x", true);

    expect(invokeMock).toHaveBeenCalledWith("git_set_user_config", {
      repoPath: "/repo",
      name: "N",
      email: "e@x",
      global: true,
    });
    expect(useGitStore.getState().userConfig).toEqual({ name: "N", email: "e@x" });
  });

  it("fetchUserConfig keeps only the latest response", async () => {
    const slow = deferred<unknown>();
    invokeMock.mockImplementation((_cmd: string, args: { repoPath: string }) =>
      args.repoPath === "/a" ? slow.promise : Promise.resolve({ name: "B", email: null }),
    );

    const first = useGitStore.getState().fetchUserConfig("/a");
    await useGitStore.getState().fetchUserConfig("/b");
    slow.resolve({ name: "A", email: null });
    await first;

    expect(useGitStore.getState().userConfig?.name).toBe("B");
  });

  it("removeRemote drops its status and refetches remotes", async () => {
    useGitStore.setState({ remoteStatuses: { origin: "connected", up: "disconnected" } });
    route({
      git_remove_remote: () => undefined,
      git_list_remotes: () => [{ name: "up", url: "u" }],
    });

    await useGitStore.getState().removeRemote("/repo", "origin");

    const s = useGitStore.getState();
    expect(s.remoteStatuses).toEqual({ up: "disconnected" });
    expect(s.remotes).toEqual([{ name: "up", url: "u" }]);
  });

  it("addRemote and setRemoteUrl refetch remotes; fetchRemotes empties on failure", async () => {
    route({
      git_add_remote: () => undefined,
      git_set_remote_url: () => undefined,
      git_list_remotes: () => [{ name: "origin", url: "new" }],
    });
    await useGitStore.getState().addRemote("/repo", "origin", "old");
    await useGitStore.getState().setRemoteUrl("/repo", "origin", "new");
    expect(useGitStore.getState().remotes).toEqual([{ name: "origin", url: "new" }]);

    route({
      git_list_remotes: () => {
        throw "x";
      },
    });
    await useGitStore.getState().fetchRemotes("/repo");
    expect(useGitStore.getState().remotes).toEqual([]);
  });

  it("testRemote maps the result to connected/disconnected", async () => {
    route({ git_test_remote: (a) => a.remoteName === "good" });

    await useGitStore.getState().testRemote("/repo", "good");
    await useGitStore.getState().testRemote("/repo", "bad");

    expect(useGitStore.getState().remoteStatuses).toEqual({
      good: "connected",
      bad: "disconnected",
    });
  });

  it("testRemote marks the remote disconnected when the check throws", async () => {
    route({
      git_test_remote: () => {
        throw "timeout";
      },
    });

    await useGitStore.getState().testRemote("/repo", "origin");

    expect(useGitStore.getState().remoteStatuses.origin).toBe("disconnected");
  });

  it("testAllRemotes resets statuses to checking then tests each remote", async () => {
    useGitStore.setState({
      remotes: [
        { name: "a", url: "1" },
        { name: "b", url: "2" },
      ],
      remoteStatuses: { stale: "connected" },
    });
    const gate = deferred<boolean>();
    route({ git_test_remote: () => gate.promise });

    const run = useGitStore.getState().testAllRemotes("/repo");
    expect(useGitStore.getState().remoteStatuses).toEqual({ a: "checking", b: "checking" });
    gate.resolve(true);
    await run;

    expect(useGitStore.getState().remoteStatuses).toEqual({ a: "connected", b: "connected" });
  });

  it("fetchRemoteRefs flags the remote while fetching and clears it on failure", async () => {
    const gate = deferred<void>();
    invokeMock.mockReturnValue(gate.promise);

    const run = useGitStore.getState().fetchRemoteRefs("/repo", "origin");
    expect(useGitStore.getState().fetchingRemotes.origin).toBe(true);
    gate.resolve();
    await run;
    expect(useGitStore.getState().fetchingRemotes.origin).toBe(false);

    invokeMock.mockRejectedValue("offline");
    await expect(useGitStore.getState().fetchRemoteRefs("/repo", "origin")).rejects.toBe("offline");
    expect(useGitStore.getState().fetchingRemotes.origin).toBe(false);
  });

  it("fetchAllRemoteRefs clears isFetching even when the fetch fails", async () => {
    invokeMock.mockRejectedValue("offline");

    await expect(useGitStore.getState().fetchAllRemoteRefs("/repo")).rejects.toBe("offline");

    expect(invokeMock).toHaveBeenCalledWith("git_fetch_all", { repoPath: "/repo" });
    expect(useGitStore.getState().isFetching).toBe(false);
    expect(useGitStore.getState().error).toBe("offline");
  });

  it("setDefaultBranch writes then re-reads the default branch", async () => {
    route({
      git_set_default_branch: () => undefined,
      git_get_default_branch: () => "trunk",
    });

    await useGitStore.getState().setDefaultBranch("/repo", "trunk");

    expect(invokeMock).toHaveBeenCalledWith("git_set_default_branch", {
      repoPath: "/repo",
      branch: "trunk",
      global: false,
    });
    expect(useGitStore.getState().defaultBranch).toBe("trunk");
  });

  it("getCommitFiles and getRefsForCommit return [] on failure", async () => {
    invokeMock.mockRejectedValue("bad hash");

    await expect(useGitStore.getState().getCommitFiles("/repo", "h")).resolves.toEqual([]);
    await expect(useGitStore.getState().getRefsForCommit("/repo", "h")).resolves.toEqual([]);
  });

  it("reset restores the initial state", () => {
    useGitStore.setState({
      currentBranch: "x",
      commits: commits(2),
      error: "e",
      activeRepoPath: "/repo",
      hasMoreCommits: false,
    });

    useGitStore.getState().reset();

    const s = useGitStore.getState();
    expect(s.currentBranch).toBeNull();
    expect(s.commits).toEqual([]);
    expect(s.error).toBeNull();
    expect(s.activeRepoPath).toBeNull();
    expect(s.hasMoreCommits).toBe(true);
  });
});
