import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGitHubStore } from "../../../../stores/useGitHubStore";
import { useGitStore } from "../../../../stores/useGitStore";
import { BranchesPanel } from "../BranchesPanel";

const invokeMock = vi.mocked(invoke);
const askMock = vi.mocked(ask);

interface MockBranch {
  name: string;
  is_remote: boolean;
  is_current: boolean;
  lastCommitDate?: string;
  lastCommitAuthor?: string;
}

interface MockWorktree {
  path: string;
  branch: string | null;
  head: string;
  is_main_worktree: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: unknown[];
  unstaged: unknown[];
  untracked: string[];
  unpushed_commits: unknown[];
  stashes: unknown[];
}

function branch(overrides: Partial<MockBranch> = {}): MockBranch {
  return {
    name: "feature-x",
    is_remote: false,
    is_current: false,
    ...overrides,
  };
}

function worktree(overrides: Partial<MockWorktree> = {}): MockWorktree {
  return {
    path: "/repo/wt-feature-x",
    branch: "feature-x",
    head: "abc123",
    is_main_worktree: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    unpushed_commits: [],
    stashes: [],
    ...overrides,
  };
}

/**
 * Routes the global `invoke` mock by command name. Each list-y command reads
 * the next queued response so a post-action refresh can return a different
 * value; commands with only one meaningful response reuse the last queued
 * entry once exhausted.
 */
function mockInvoke(opts: {
  branches?: MockBranch[];
  worktrees?: MockWorktree[][];
  authLoggedIn?: boolean;
  prs?: unknown[];
}) {
  const worktreeQueue = opts.worktrees ?? [[]];
  let worktreeCall = 0;

  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "git_branches":
        return opts.branches ?? [];
      case "git_current_branch":
        return "main";
      case "git_worktrees_status": {
        const idx = Math.min(worktreeCall, worktreeQueue.length - 1);
        worktreeCall += 1;
        return worktreeQueue[idx];
      }
      case "git_worktree_remove":
        return undefined;
      case "github_auth_status":
        return {
          logged_in: opts.authLoggedIn ?? false,
          username: opts.authLoggedIn ? "octocat" : null,
          scopes: [],
        };
      case "github_list_prs":
        return opts.prs ?? [];
      default:
        return undefined;
    }
  });
}

describe("BranchesPanel", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    askMock.mockReset();
    useGitStore.getState().reset();
    useGitHubStore.getState().reset();
  });

  it("renders local branches with last-commit metadata and a merged-PR badge when gh is authenticated", async () => {
    mockInvoke({
      branches: [
        branch({
          name: "feature-x",
          lastCommitAuthor: "Jane Doe",
          lastCommitDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      authLoggedIn: true,
      prs: [
        {
          number: 42,
          state: "MERGED",
          author: { login: "jane" },
          createdAt: "2026-01-01T00:00:00Z",
          headRefName: "feature-x",
          mergedAt: "2026-01-05T00:00:00Z",
          closedAt: null,
          url: "https://example.com/pr/42",
        },
      ],
    });

    render(<BranchesPanel repoPath="/repo" />);

    expect(await screen.findByText("feature-x")).toBeInTheDocument();
    expect(await screen.findByText(/Jane Doe/)).toBeInTheDocument();
    expect(await screen.findByText(/PR #42 merged/)).toBeInTheDocument();
  });

  it("shows no PR badge and never calls github_list_prs when gh is not authenticated", async () => {
    mockInvoke({
      branches: [branch({ name: "feature-x" })],
      authLoggedIn: false,
    });

    render(<BranchesPanel repoPath="/repo" />);

    expect(await screen.findByText("feature-x")).toBeInTheDocument();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("github_auth_status", expect.anything());
    });
    expect(screen.queryByText(/^PR #/)).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("github_list_prs", expect.anything());
  });

  it("lists worktrees and deletes one after confirmation", async () => {
    mockInvoke({
      branches: [],
      worktrees: [[worktree({ path: "/repo/wt-feature-x", branch: "feature-x" })], []],
    });
    askMock.mockResolvedValue(true);

    render(<BranchesPanel repoPath="/repo" />);

    expect(await screen.findByText("/repo/wt-feature-x")).toBeInTheDocument();

    const deleteButton = screen.getByTitle("Delete worktree");
    deleteButton.click();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "git_worktree_remove",
        expect.objectContaining({ path: "/repo/wt-feature-x", force: false }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("/repo/wt-feature-x")).not.toBeInTheDocument();
    });
  });

  it("never renders a delete action for the main worktree", async () => {
    mockInvoke({
      branches: [],
      worktrees: [[worktree({ path: "/repo", branch: "main", is_main_worktree: true })]],
    });

    render(<BranchesPanel repoPath="/repo" />);

    expect(await screen.findByText("/repo")).toBeInTheDocument();
    expect(screen.queryByTitle("Delete worktree")).not.toBeInTheDocument();
  });

  it("filters local, remote, and worktree lists by the search query", async () => {
    mockInvoke({
      branches: [
        branch({ name: "feature-x", is_remote: false }),
        branch({ name: "bugfix-y", is_remote: false }),
        branch({ name: "origin/feature-z", is_remote: true }),
      ],
      worktrees: [
        [
          worktree({ path: "/repo/wt-feature-x", branch: "feature-x" }),
          worktree({ path: "/repo/wt-bugfix-y", branch: "bugfix-y" }),
        ],
      ],
    });

    render(<BranchesPanel repoPath="/repo" />);

    expect(await screen.findByText("feature-x")).toBeInTheDocument();
    expect(screen.getByText("Local (2)")).toBeInTheDocument();
    expect(screen.getByText("Remote (1)")).toBeInTheDocument();
    expect(screen.getByText("Worktrees (2)")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search branches and worktrees..."), {
      target: { value: "feature" },
    });

    expect(screen.getByText("Local (1 of 2)")).toBeInTheDocument();
    expect(screen.getByText("Remote (1)")).toBeInTheDocument();
    expect(screen.getByText("Worktrees (1 of 2)")).toBeInTheDocument();
    expect(screen.queryByText("bugfix-y")).not.toBeInTheDocument();
    expect(screen.queryByText("/repo/wt-bugfix-y")).not.toBeInTheDocument();
  });

  it("matches a worktree by path even when the branch name doesn't match", async () => {
    mockInvoke({
      branches: [],
      worktrees: [
        [
          worktree({ path: "/repo/wt-alpha", branch: "alpha" }),
          worktree({ path: "/repo/wt-standalone", branch: null }),
        ],
      ],
    });

    render(<BranchesPanel repoPath="/repo" />);

    expect(await screen.findByText("/repo/wt-alpha")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search branches and worktrees..."), {
      target: { value: "standalone" },
    });

    expect(screen.getByText("/repo/wt-standalone")).toBeInTheDocument();
    expect(screen.queryByText("/repo/wt-alpha")).not.toBeInTheDocument();
  });

  it("hides a section's branches when its chip is toggled off", async () => {
    mockInvoke({
      branches: [
        branch({ name: "feature-x", is_remote: false }),
        branch({ name: "origin/feature-x", is_remote: true }),
      ],
    });

    render(<BranchesPanel repoPath="/repo" />);

    expect(await screen.findByText("Remote (1)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remote" }));

    expect(screen.queryByText(/^Remote \(/)).not.toBeInTheDocument();
    expect(screen.queryByText("origin/feature-x")).not.toBeInTheDocument();
    // Local section is untouched.
    expect(screen.getByText("Local (1)")).toBeInTheDocument();
    expect(screen.getByText("feature-x")).toBeInTheDocument();
  });

  it("restricts the worktree list to at-risk worktrees when Needs attention is on", async () => {
    mockInvoke({
      branches: [],
      worktrees: [
        [
          worktree({ path: "/repo/wt-clean", branch: "clean-branch" }),
          worktree({ path: "/repo/wt-risky", branch: "risky-branch", ahead: 1 }),
        ],
      ],
    });

    render(<BranchesPanel repoPath="/repo" />);

    expect(await screen.findByText("Worktrees (2)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Needs attention" }));

    expect(screen.getByText("Worktrees (1 of 2)")).toBeInTheDocument();
    expect(screen.getByText("/repo/wt-risky")).toBeInTheDocument();
    expect(screen.queryByText("/repo/wt-clean")).not.toBeInTheDocument();
  });

  it("shows a per-section empty state when nothing matches, and Clear filters restores the lists", async () => {
    mockInvoke({
      branches: [branch({ name: "feature-x", is_remote: false })],
      worktrees: [[worktree({ path: "/repo/wt-feature-x", branch: "feature-x" })]],
    });

    render(<BranchesPanel repoPath="/repo" />);

    expect(await screen.findByText("feature-x")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search branches and worktrees..."), {
      target: { value: "zzz-does-not-match-anything" },
    });

    expect(screen.getByText("No local branches match")).toBeInTheDocument();
    expect(screen.getByText("No worktrees match")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(screen.getByPlaceholderText("Search branches and worktrees...")).toHaveValue("");
    expect(screen.getByText("Local (1)")).toBeInTheDocument();
    expect(screen.queryByText("No local branches match")).not.toBeInTheDocument();
    expect(screen.queryByText("No worktrees match")).not.toBeInTheDocument();
  });
});
