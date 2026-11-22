import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PullRequestInfo } from "../../../../stores/useGitHubStore";
import { PullRequestRow } from "../PullRequestRow";

function buildPullRequest(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 42,
    title: "Fix the thing",
    state: "OPEN",
    author: {
      login: "octocat",
    },
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    updatedAt: new Date().toISOString(),
    headRefName: "feature/fix",
    baseRefName: "main",
    isDraft: false,
    additions: 10,
    deletions: 5,
    url: "https://github.com/repo/pulls/42",
    labels: [],
    mergedAt: null,
    closedAt: null,
    ...overrides,
  };
}

describe("PullRequestRow", () => {
  it("renders PR metadata including number, branches, and author", () => {
    const pr = buildPullRequest();
    render(<PullRequestRow pr={pr} isSelected={false} onClick={() => {}} />);

    // Check PR number
    expect(screen.getByText("#42")).toBeInTheDocument();

    // Check branch info
    expect(screen.getByText(/feature\/fix → main/)).toBeInTheDocument();

    // Check author is displayed
    expect(screen.getByText("by octocat")).toBeInTheDocument();

    // Check title
    expect(screen.getByText("Fix the thing")).toBeInTheDocument();
  });

  it("handles missing author gracefully", () => {
    const pr = buildPullRequest({
      author: { login: "" },
    });
    render(<PullRequestRow pr={pr} isSelected={false} onClick={() => {}} />);

    // PR should still render without the author when login is empty
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("Fix the thing")).toBeInTheDocument();

    // Author should not be displayed when login is falsy
    expect(screen.queryByText(/^by /)).not.toBeInTheDocument();
  });

  it("renders Draft badge when PR is a draft", () => {
    const pr = buildPullRequest({ isDraft: true });
    render(<PullRequestRow pr={pr} isSelected={false} onClick={() => {}} />);

    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("displays addition and deletion counts", () => {
    const pr = buildPullRequest({ additions: 25, deletions: 10 });
    render(<PullRequestRow pr={pr} isSelected={false} onClick={() => {}} />);

    expect(screen.getByText("+25")).toBeInTheDocument();
    expect(screen.getByText("-10")).toBeInTheDocument();
  });

  it("offers no actions menu: the whole row is the one button that opens the detail", () => {
    render(<PullRequestRow pr={buildPullRequest()} isSelected={false} onClick={() => {}} />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /actions for pr/i })).not.toBeInTheDocument();
  });
});
