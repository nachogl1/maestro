import { describe, expect, it } from "vitest";
import { isWorktreeAtRisk, type WorktreeStatus } from "../git";

function cleanStatus(overrides: Partial<WorktreeStatus> = {}): WorktreeStatus {
  return {
    path: "/repo",
    branch: "main",
    head: "abc",
    is_main_worktree: true,
    upstream: "origin/main",
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

describe("isWorktreeAtRisk", () => {
  it("is false for a clean, fully-pushed worktree", () => {
    expect(isWorktreeAtRisk(cleanStatus())).toBe(false);
  });

  it("being behind upstream alone is not a risk (nothing would be lost)", () => {
    expect(isWorktreeAtRisk(cleanStatus({ behind: 4 }))).toBe(false);
  });

  it("is true when ahead of upstream", () => {
    expect(isWorktreeAtRisk(cleanStatus({ ahead: 1 }))).toBe(true);
  });

  it("is true with staged changes", () => {
    expect(
      isWorktreeAtRisk(
        cleanStatus({
          staged: [{ path: "a.ts", status: "modified", old_path: null }],
        })
      )
    ).toBe(true);
  });

  it("is true with unstaged changes", () => {
    expect(
      isWorktreeAtRisk(
        cleanStatus({
          unstaged: [{ path: "a.ts", status: "modified", old_path: null }],
        })
      )
    ).toBe(true);
  });

  it("is true with untracked files", () => {
    expect(isWorktreeAtRisk(cleanStatus({ untracked: ["new.ts"] }))).toBe(true);
  });

  it("is true with unpushed commits", () => {
    expect(
      isWorktreeAtRisk(
        cleanStatus({
          unpushed_commits: [
            {
              hash: "h",
              short_hash: "h",
              author: "x",
              timestamp: 0,
              summary: "wip",
            },
          ],
        })
      )
    ).toBe(true);
  });

  it("is true with stashes", () => {
    expect(
      isWorktreeAtRisk(
        cleanStatus({
          stashes: [{ ref_name: "stash@{0}", message: "wip", branch: "main" }],
        })
      )
    ).toBe(true);
  });
});
