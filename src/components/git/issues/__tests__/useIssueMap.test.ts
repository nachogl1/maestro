import { invoke } from "@tauri-apps/api/core";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueInfo } from "@/stores/useGitHubStore";
import { MAP_ISSUE_LIMIT, useIssueMap } from "../useIssueMap";

const mockedInvoke = vi.mocked(invoke);

function buildIssue(number: number): IssueInfo {
  return {
    number,
    title: `Issue ${number}`,
    state: number % 2 === 0 ? "CLOSED" : "OPEN",
    author: { login: "alice" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: `https://github.com/o/r/issues/${number}`,
    labels: [],
    closedAt: null,
    assignees: [],
  };
}

function mockBackend(count: number) {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "github_list_issues":
        return Array.from({ length: count }, (_, i) => buildIssue(i + 1));
      case "github_issue_links":
        return [];
      case "github_list_assignees":
        return [];
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
}

describe("useIssueMap", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("fetches open and closed issues up to the limit and is not truncated below it", async () => {
    mockBackend(3);
    const { result } = renderHook(() => useIssueMap("/repo", "  "));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockedInvoke).toHaveBeenCalledWith("github_list_issues", {
      repoPath: "/repo",
      state: "all",
      limit: MAP_ISSUE_LIMIT,
      search: null,
    });
    expect(MAP_ISSUE_LIMIT).toBe(1000);
    expect(result.current.issues.map((i) => i.state)).toEqual(["OPEN", "CLOSED", "OPEN"]);
    expect(result.current.truncated).toBe(false);
  });

  it("flags the result as truncated when the fetch returns exactly the limit", async () => {
    mockBackend(MAP_ISSUE_LIMIT);
    const { result } = renderHook(() => useIssueMap("/repo", ""));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.issues).toHaveLength(MAP_ISSUE_LIMIT);
    expect(result.current.truncated).toBe(true);
  });
});
