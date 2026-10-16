import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { useGitHubStore } from "../useGitHubStore";

describe("useGitHubStore list filters", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    useGitHubStore.getState().reset();
  });

  // gh defaults `--state` to "open" when the flag is missing, so "all" must be
  // sent explicitly or the All chip silently lists open items only.
  it("sends state 'all' for the All PR chip", async () => {
    await useGitHubStore.getState().fetchPullRequests("/repo", "all");

    expect(invokeMock).toHaveBeenCalledWith(
      "github_list_prs",
      expect.objectContaining({ repoPath: "/repo", state: "all" }),
    );
  });

  it("sends state 'all' for the default Issues filter", async () => {
    await useGitHubStore.getState().fetchIssues("/repo");

    expect(useGitHubStore.getState().issueFilter).toBe("all");
    expect(invokeMock).toHaveBeenCalledWith(
      "github_list_issues",
      expect.objectContaining({ repoPath: "/repo", state: "all" }),
    );
  });

  it("passes a specific filter through unchanged", async () => {
    await useGitHubStore.getState().fetchPullRequests("/repo", "merged");

    expect(invokeMock).toHaveBeenCalledWith(
      "github_list_prs",
      expect.objectContaining({ state: "merged" }),
    );
  });
});
