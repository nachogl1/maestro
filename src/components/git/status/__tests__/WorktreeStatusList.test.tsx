import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { WorktreeStatusList } from "../WorktreeStatusList";
import type { WorktreeStatus } from "../../../../lib/git";

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
 * the file-action commands resolve to undefined and are asserted on directly.
 */
function mockInvoke(statuses: WorktreeStatus[][]) {
  let call = 0;
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "git_worktrees_status") {
      const idx = Math.min(call, statuses.length - 1);
      call += 1;
      return statuses[idx];
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
    expect(invokeMock).not.toHaveBeenCalledWith(
      "git_discard_file",
      expect.anything()
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("git_discard_file", {
        worktreePath: "/repo/main",
        path: "src/foo.ts",
        oldPath: null,
      });
    });
    // Refresh polled status again (mount + after-action = 2+ status reads).
    const statusCalls = invokeMock.mock.calls.filter(
      (c) => c[0] === "git_worktrees_status"
    );
    expect(statusCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("cancel dismisses the confirm without calling the backend", async () => {
    mockInvoke([[buildStatus()]]);
    render(<WorktreeStatusList repoPath="/repo/main" />);

    await screen.findByText("junk.txt");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(invokeMock).not.toHaveBeenCalledWith(
      "git_remove_file",
      expect.anything()
    );
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
    expect(
      await screen.findByTitle("fatal: discard exploded")
    ).toBeInTheDocument();
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
  });
});
