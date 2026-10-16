import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDetail } from "../../../../stores/useGitHubStore";
import { useGitHubStore } from "../../../../stores/useGitHubStore";
import { PullRequestDetailPanel } from "../PullRequestDetailPanel";

const invokeMock = vi.mocked(invoke);

function pr(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    number: 42,
    title: "Add feature",
    state: "OPEN",
    author: { login: "octocat" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    headRefName: "feature-x",
    baseRefName: "main",
    isDraft: false,
    additions: 10,
    deletions: 2,
    url: "https://github.com/o/r/pull/42",
    labels: [],
    mergedAt: null,
    closedAt: null,
    body: "PR body",
    changedFiles: 3,
    mergeable: "MERGEABLE",
    comments: [],
    ...overrides,
  };
}

describe("PullRequestDetailPanel load failure and author", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useGitHubStore.getState().reset();
  });

  it("shows the fetch error with a Back button instead of an empty pane", async () => {
    invokeMock.mockRejectedValueOnce("PR not found");
    await useGitHubStore.getState().fetchPullRequestDetail("/repo", 7);
    expect(useGitHubStore.getState().prDetailError).toBe("PR not found");

    const onClose = vi.fn();
    render(<PullRequestDetailPanel onClose={onClose} />);

    expect(screen.getByText("Could not load this pull request.")).toBeInTheDocument();
    expect(screen.getByText("PR not found")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Back to list"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears the detail error when the selection is cleared", async () => {
    invokeMock.mockRejectedValueOnce("offline");
    await useGitHubStore.getState().fetchPullRequestDetail("/repo", 7);

    useGitHubStore.getState().clearSelectedPR();

    expect(useGitHubStore.getState().prDetailError).toBeNull();
  });

  it("omits the 'by' fragment for an empty author login", () => {
    useGitHubStore.setState({ selectedPR: pr({ author: { login: "" } }) });

    render(<PullRequestDetailPanel onClose={vi.fn()} />);

    expect(screen.getByText(/Opened on/)).toBeInTheDocument();
    expect(screen.queryByText(/by\s+on/)).not.toBeInTheDocument();
  });

  it("keeps 'by <login>' when the author is known", () => {
    useGitHubStore.setState({ selectedPR: pr() });

    render(<PullRequestDetailPanel onClose={vi.fn()} />);

    expect(screen.getByText(/by octocat on/)).toBeInTheDocument();
  });
});
