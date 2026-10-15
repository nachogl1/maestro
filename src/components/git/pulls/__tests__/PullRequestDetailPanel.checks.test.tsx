import { openUrl } from "@tauri-apps/plugin-opener";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDetail } from "../../../../stores/useGitHubStore";
import { useGitHubStore } from "../../../../stores/useGitHubStore";
import { PullRequestDetailPanel } from "../PullRequestDetailPanel";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const openUrlMock = vi.mocked(openUrl);

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

describe("PullRequestDetailPanel checks section", () => {
  beforeEach(() => {
    openUrlMock.mockClear();
    useGitHubStore.getState().reset();
  });

  it("renders nothing when there is no checks summary", () => {
    useGitHubStore.setState({ selectedPR: pr() });

    render(<PullRequestDetailPanel onClose={vi.fn()} />);

    expect(screen.getByText("Add feature")).toBeInTheDocument();
    expect(screen.queryByText(/passed|failed|pending/)).not.toBeInTheDocument();
  });

  it("shows the verdict header and each check, opening its URL on click", async () => {
    useGitHubStore.setState({
      selectedPR: pr({
        checksSummary: { success: 1, failure: 1, pending: 0, total: 2, verdict: "failure" },
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "build",
            workflowName: "CI",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            detailsUrl: "https://github.com/o/r/runs/1",
          },
          {
            __typename: "StatusContext",
            context: "ci/legacy",
            state: "ERROR",
            targetUrl: "https://example.com/legacy",
          },
        ],
      }),
    });

    render(<PullRequestDetailPanel onClose={vi.fn()} />);

    expect(await screen.findByText("1 passed, 1 failed")).toBeInTheDocument();
    expect(screen.getByText("CI / build")).toBeInTheDocument();
    expect(screen.getByText("ci/legacy")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Open ci/legacy details on GitHub"));
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com/legacy");
  });

  it("collapses to failing/pending checks when there are more than 6, with a working show-all toggle", () => {
    const passing = Array.from({ length: 5 }, (_, i) => ({
      name: `passing-${i}`,
      status: "COMPLETED",
      conclusion: "SUCCESS",
    }));
    const failing = { name: "failing-check", status: "COMPLETED", conclusion: "FAILURE" };
    const pending = { name: "pending-check", status: "IN_PROGRESS" };

    useGitHubStore.setState({
      selectedPR: pr({
        checksSummary: { success: 5, failure: 1, pending: 1, total: 7, verdict: "failure" },
        statusCheckRollup: [...passing, failing, pending],
      }),
    });

    render(<PullRequestDetailPanel onClose={vi.fn()} />);

    expect(screen.getByText("failing-check")).toBeInTheDocument();
    expect(screen.getByText("pending-check")).toBeInTheDocument();
    expect(screen.queryByText("passing-0")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Show all 7"));

    expect(screen.getByText("passing-0")).toBeInTheDocument();
    expect(screen.getByText("Show only failing/pending")).toBeInTheDocument();
  });
});
