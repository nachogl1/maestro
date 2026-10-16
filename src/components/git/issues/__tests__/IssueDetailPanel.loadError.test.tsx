import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueDetail } from "../../../../stores/useGitHubStore";
import { useGitHubStore } from "../../../../stores/useGitHubStore";
import { IssueDetailPanel } from "../IssueDetailPanel";
import { IssueRow } from "../IssueRow";

const invokeMock = vi.mocked(invoke);

function issue(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    number: 9,
    title: "Broken thing",
    state: "OPEN",
    author: { login: "octocat" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    url: "https://github.com/o/r/issues/9",
    labels: [],
    closedAt: null,
    assignees: [],
    body: "Issue body",
    comments: [],
    ...overrides,
  };
}

describe("IssueDetailPanel load failure and author", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useGitHubStore.getState().reset();
  });

  it("shows the fetch error with a Back button instead of an empty pane", async () => {
    invokeMock.mockRejectedValueOnce("Issue not found");
    await useGitHubStore.getState().fetchIssueDetail("/repo", 9);

    const onClose = vi.fn();
    render(<IssueDetailPanel repoPath="/repo" onClose={onClose} />);

    expect(screen.getByText("Could not load this issue.")).toBeInTheDocument();
    expect(screen.getByText("Issue not found")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Back to list"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("omits the 'by' fragment for an empty author login in the detail panel", () => {
    useGitHubStore.setState({ selectedIssue: issue({ author: { login: "" } }) });

    render(<IssueDetailPanel repoPath="/repo" onClose={vi.fn()} />);

    expect(screen.getByText(/Opened on/)).toBeInTheDocument();
    expect(screen.queryByText(/by\s+on/)).not.toBeInTheDocument();
  });

  it("omits the 'by' fragment for an empty author login in the row", () => {
    render(
      <IssueRow issue={issue({ author: { login: "" } })} isSelected={false} onClick={vi.fn()} />,
    );

    expect(screen.getByText("Broken thing")).toBeInTheDocument();
    expect(screen.queryByText(/^by/)).not.toBeInTheDocument();
  });
});
