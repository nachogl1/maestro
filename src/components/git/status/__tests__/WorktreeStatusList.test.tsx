import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeStatus } from "../../../../lib/git";
import { WorktreeStatusList } from "../WorktreeStatusList";

const invokeMock = vi.mocked(invoke);

function buildStatus(overrides: Partial<WorktreeStatus> = {}): WorktreeStatus {
  return {
    path: "/repo/main",
    branch: "main",
    head: "abc123",
    is_main_worktree: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [{ path: "src/foo.ts", status: "modified", old_path: null }],
    untracked: ["junk.txt"],
    unpushed_commits: [],
    stashes: [],
    ...overrides,
  };
}

/**
 * Routes the global `invoke` mock by command name. `git_worktrees_status`
 * returns the next entry from `statuses` (so a post-action poll can differ);
 * `git_file_diff` returns a minimal one-line-changed diff; the file-action
 * commands resolve to undefined and are asserted on directly.
 */
function mockInvoke(statuses: WorktreeStatus[][]) {
  let call = 0;
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "git_worktrees_status") {
      const idx = Math.min(call, statuses.length - 1);
      call += 1;
      return statuses[idx];
    }
    if (cmd === "git_file_diff") {
      return {
        path: "src/foo.ts",
        old_path: null,
        is_binary: false,
        is_untracked: false,
        diff: [
          "--- a/src/foo.ts",
          "+++ b/src/foo.ts",
          "@@ -1,1 +1,1 @@",
          "-old line",
          "+new line",
          "",
        ].join("\n"),
        content: null,
      };
    }
    return undefined;
  });
}

describe("WorktreeStatusList file actions", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("renders a Restore action for tracked files and a Remove action for untracked files", async () => {
    mockInvoke([[buildStatus()]]);
    render(<WorktreeStatusList repoPath="/repo/main" />);

    expect(await screen.findByText("src/foo.ts")).toBeInTheDocument();
    expect(screen.getByText("junk.txt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("discards a tracked file only after the inline confirm and then refreshes", async () => {
    // First poll has the file; after discard the refresh poll returns it gone.
    mockInvoke([[buildStatus()], [buildStatus({ unstaged: [] })]]);
    render(<WorktreeStatusList repoPath="/repo/main" />);

    await screen.findByText("src/foo.ts");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    // Nothing destructive runs until the user confirms.
    expect(invokeMock).not.toHaveBeenCalledWith("git_discard_file", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("git_discard_file", {
        worktreePath: "/repo/main",
        path: "src/foo.ts",
        oldPath: null,
      });
    });
    // Refresh polled status again (mount + after-action = 2+ status reads).
    const statusCalls = invokeMock.mock.calls.filter((c) => c[0] === "git_worktrees_status");
    expect(statusCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("cancel dismisses the confirm without calling the backend", async () => {
    mockInvoke([[buildStatus()]]);
    render(<WorktreeStatusList repoPath="/repo/main" />);

    await screen.findByText("junk.txt");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(invokeMock).not.toHaveBeenCalledWith("git_remove_file", expect.anything());
    // Action button is back.
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("removes an untracked file through confirm", async () => {
    mockInvoke([[buildStatus()], [buildStatus({ untracked: [] })]]);
    render(<WorktreeStatusList repoPath="/repo/main" />);

    await screen.findByText("junk.txt");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("git_remove_file", {
        worktreePath: "/repo/main",
        path: "junk.txt",
      });
    });
  });

  it("opens the side-by-side diff modal when a file name is clicked", async () => {
    mockInvoke([[buildStatus()]]);
    render(<WorktreeStatusList repoPath="/repo/main" />);

    fireEvent.click(await screen.findByText("src/foo.ts"));

    // An unstaged file requests the index → worktree comparison.
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("git_file_diff", {
        worktreePath: "/repo/main",
        path: "src/foo.ts",
        mode: "unstaged",
        oldPath: null,
      });
    });

    // Old version on the left, current version on the right.
    expect(await screen.findByText("old line")).toBeInTheDocument();
    expect(screen.getByText("new line")).toBeInTheDocument();

    // Closing the modal removes the diff.
    fireEvent.click(screen.getByRole("button", { name: "Close diff" }));
    expect(screen.queryByText("old line")).not.toBeInTheDocument();
  });

  it("surfaces a backend error and keeps the file listed", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "git_worktrees_status") return [buildStatus()];
      if (cmd === "git_discard_file") throw "fatal: discard exploded";
      return undefined;
    });
    render(<WorktreeStatusList repoPath="/repo/main" />);

    await screen.findByText("src/foo.ts");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    // Error icon carries the message; file stays put.
    expect(await screen.findByTitle("fatal: discard exploded")).toBeInTheDocument();
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
  });
});

describe("WorktreeStatusList search and filters", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  function altWorktrees(): WorktreeStatus[] {
    return [
      buildStatus({
        path: "/repo/wt-alpha",
        branch: "feature/alpha",
        is_main_worktree: false,
        staged: [],
        unstaged: [{ path: "src/foo.ts", status: "modified", old_path: null }],
        untracked: ["junk.txt"],
      }),
      buildStatus({
        path: "/repo/wt-beta",
        branch: "feature/beta",
        is_main_worktree: false,
        staged: [],
        unstaged: [],
        untracked: ["src/other.ts"],
      }),
    ];
  }

  it("matches a worktree by branch name and hides the rest", async () => {
    mockInvoke([altWorktrees()]);
    render(<WorktreeStatusList repoPath="/repo/main" />);

    await screen.findByText("feature/alpha");
    expect(screen.getByText("feature/beta")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search worktrees or files..."), {
      target: { value: "alpha" },
    });

    expect(screen.getByText("feature/alpha")).toBeInTheDocument();
    expect(screen.queryByText("feature/beta")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 2 worktrees")).toBeInTheDocument();
  });

  it("matches by file path and shows only the matching file inside the worktree", async () => {
    mockInvoke([
      [
        buildStatus({
          path: "/repo/wt-alpha",
          branch: "feature/alpha",
          is_main_worktree: false,
          staged: [],
          unstaged: [{ path: "src/foo.ts", status: "modified", old_path: null }],
          untracked: ["src/bar.ts"],
        }),
      ],
    ]);
    render(<WorktreeStatusList repoPath="/repo/main" />);

    await screen.findByText("src/foo.ts");
    expect(screen.getByText("src/bar.ts")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search worktrees or files..."), {
      target: { value: "bar.ts" },
    });

    // The worktree's own branch/path don't match "bar.ts", but one of its
    // files does, so it stays visible with only that file shown.
    expect(screen.getByText("feature/alpha")).toBeInTheDocument();
    expect(screen.getByText("src/bar.ts")).toBeInTheDocument();
    expect(screen.queryByText("src/foo.ts")).not.toBeInTheDocument();
  });

  it("'Only with changes' hides worktrees with zero changed files", async () => {
    mockInvoke([
      [
        buildStatus({
          path: "/repo/wt-alpha",
          branch: "feature/alpha",
          is_main_worktree: false,
          staged: [],
          unstaged: [{ path: "src/foo.ts", status: "modified", old_path: null }],
          untracked: [],
        }),
        buildStatus({
          path: "/repo/wt-clean",
          branch: "feature/clean",
          is_main_worktree: false,
          staged: [],
          unstaged: [],
          untracked: [],
          unpushed_commits: [],
          stashes: [],
          ahead: 0,
        }),
      ],
    ]);
    render(<WorktreeStatusList repoPath="/repo/main" />);

    await screen.findByText("feature/alpha");
    expect(screen.getByText("feature/clean")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Only with changes" }));

    expect(screen.getByText("feature/alpha")).toBeInTheDocument();
    expect(screen.queryByText("feature/clean")).not.toBeInTheDocument();
  });

  it("'Needs attention' restricts the list to at-risk worktrees", async () => {
    mockInvoke([
      [
        buildStatus({
          path: "/repo/wt-risk",
          branch: "feature/risk",
          is_main_worktree: false,
          ahead: 1,
          staged: [],
          unstaged: [],
          untracked: [],
        }),
        buildStatus({
          path: "/repo/wt-safe",
          branch: "feature/safe",
          is_main_worktree: false,
          ahead: 0,
          staged: [],
          unstaged: [],
          untracked: [],
          unpushed_commits: [],
          stashes: [],
        }),
      ],
    ]);
    render(<WorktreeStatusList repoPath="/repo/main" />);

    await screen.findByText("feature/risk");
    expect(screen.getByText("feature/safe")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Needs attention" }));

    expect(screen.getByText("feature/risk")).toBeInTheDocument();
    expect(screen.queryByText("feature/safe")).not.toBeInTheDocument();
  });

  it("shows an empty state when filters match nothing, and Clear filters resets", async () => {
    mockInvoke([altWorktrees()]);
    render(<WorktreeStatusList repoPath="/repo/main" />);

    await screen.findByText("feature/alpha");

    fireEvent.change(screen.getByPlaceholderText("Search worktrees or files..."), {
      target: { value: "nonexistent-xyz" },
    });

    expect(await screen.findByText("No worktrees match your filters.")).toBeInTheDocument();
    expect(screen.queryByText("feature/alpha")).not.toBeInTheDocument();
    expect(screen.queryByText("feature/beta")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(await screen.findByText("feature/alpha")).toBeInTheDocument();
    expect(screen.getByText("feature/beta")).toBeInTheDocument();
  });
});
