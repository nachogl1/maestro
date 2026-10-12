import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueLinks } from "@/lib/issueGraph";
import type { IssueInfo } from "@/stores/useGitHubStore";
import { IssueMapModal } from "../IssueMapModal";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

function buildIssue(overrides: Partial<IssueInfo> & { number: number }): IssueInfo {
  return {
    title: `Issue ${overrides.number}`,
    state: "OPEN",
    author: { login: "alice" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: `https://github.com/o/r/issues/${overrides.number}`,
    labels: [],
    closedAt: null,
    assignees: [],
    ...overrides,
  };
}

function buildLinks(overrides: Partial<IssueLinks> & { number: number }): IssueLinks {
  return { blockedBy: [], blocking: [], parent: null, subIssues: [], body: "", ...overrides };
}

const ISSUES: IssueInfo[] = [
  buildIssue({
    number: 1,
    title: "Scaffold",
    state: "CLOSED",
    labels: [{ name: "agent-ready", color: "0e8a16" }],
  }),
  buildIssue({
    number: 2,
    title: "Build the canvas",
    labels: [{ name: "agent-ready", color: "0e8a16" }],
  }),
  buildIssue({
    number: 3,
    title: "Ship it",
    labels: [{ name: "needs-human-decision", color: "d93f0b" }],
    assignees: [{ login: "alice" }],
  }),
];

const LINKS: IssueLinks[] = [
  buildLinks({ number: 1 }),
  buildLinks({ number: 2, blockedBy: [1] }),
  buildLinks({ number: 3, blockedBy: [2] }),
];

const mockedInvoke = vi.mocked(invoke);
const REPO = "/repo";

function mockBackend(options: { failAssign?: boolean } = {}) {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "github_list_issues":
        return ISSUES;
      case "github_issue_links":
        return LINKS;
      case "github_list_assignees":
        return [
          { login: "alice", avatarUrl: "" },
          { login: "bob", avatarUrl: "" },
        ];
      case "github_update_issue_assignees":
        if (options.failAssign) throw new Error("nope");
        return undefined;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
}

function renderModal() {
  const onSelectIssue = vi.fn();
  const onClose = vi.fn();
  render(
    <IssueMapModal
      repoPath={REPO}
      search="assignee:@me"
      onSelectIssue={onSelectIssue}
      onClose={onClose}
    />,
  );
  return { onSelectIssue, onClose };
}

const hint = () => screen.getByTestId("issue-map-hint").textContent;

describe("IssueMapModal", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    vi.mocked(openUrl).mockClear();
    mockBackend();
  });

  it("draws every issue in its wave with progress and owner", async () => {
    renderModal();
    const n1 = await screen.findByTestId("issue-node-1");
    expect(n1).toHaveAttribute("data-wave", "Foundation");
    expect(n1).toHaveAttribute("data-status", "closed");
    expect(screen.getByTestId("issue-node-2")).toHaveAttribute("data-wave", "Wave 1");
    expect(screen.getByTestId("issue-node-2")).toHaveAttribute("data-status", "ready");
    const n3 = screen.getByTestId("issue-node-3");
    expect(n3).toHaveAttribute("data-wave", "Wave 2");
    expect(n3).toHaveAttribute("data-status", "blocked");
    expect(n3).toHaveAttribute("data-kind", "human");
    expect(screen.getByText(/3 issues · 2 blocked-by links/)).toBeInTheDocument();
    expect(screen.getByText("Foundation")).toBeInTheDocument();
    expect(screen.getByText(/Showing 3 of 3 issues/)).toBeInTheDocument();
    expect(mockedInvoke).toHaveBeenCalledWith("github_list_issues", {
      repoPath: REPO,
      state: null,
      limit: 200,
      search: "assignee:@me",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("github_issue_links", {
      repoPath: REPO,
      numbers: [1, 2, 3],
    });
  });

  it("legend entries hide a type, show counts, and 'show all' restores", async () => {
    renderModal();
    await screen.findByTestId("issue-node-1");
    const closed = screen.getByLabelText("✔ Closed");
    expect(closed.parentElement?.textContent).toContain("1/1");
    fireEvent.click(closed);
    expect(screen.getByTestId("issue-node-1")).toHaveAttribute("opacity", "0.06");
    expect(screen.getByTestId("issue-node-2")).toHaveAttribute("opacity", "1");
    expect(screen.getByText(/Showing 2 of 3 issues/)).toBeInTheDocument();
    expect(closed.parentElement?.textContent).toContain("0/1");

    fireEvent.click(screen.getByLabelText("👤 alice"));
    expect(screen.getByTestId("issue-node-3")).toHaveAttribute("opacity", "0.06");
    expect(screen.getByText(/Showing 1 of 3 issues/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "show all" }));
    expect(screen.getByText(/Showing 3 of 3 issues/)).toBeInTheDocument();
  });

  it("hover focuses the chain, shows the tooltip and explains the hint", async () => {
    renderModal();
    const n2 = await screen.findByTestId("issue-node-2");
    fireEvent.mouseEnter(n2, { clientX: 100, clientY: 100 });
    expect(hint()).toBe("#2: 1 issue(s) upstream must close first (left), 1 wait on it (right).");
    const tip = screen.getByTestId("issue-map-tip");
    expect(within(tip).getByText("#2 Build the canvas")).toBeInTheDocument();
    expect(within(tip).getByText("#1 Scaffold (closed)")).toBeInTheDocument();
    expect(within(tip).getByText("#3")).toBeInTheDocument();
    expect(screen.getByTestId("issue-node-1")).toHaveAttribute("data-hl", "true");
    expect(screen.getByTestId("issue-node-3")).toHaveAttribute("data-hl", "true");
    expect(tip).toHaveClass("pointer-events-none");

    fireEvent.mouseLeave(n2);
    expect(screen.queryByTestId("issue-map-tip")).not.toBeInTheDocument();
    expect(hint()).toMatch(/^Hover an issue/);
  });

  it("click pins, Esc unpins first and closes second", async () => {
    const { onClose } = renderModal();
    const n2 = await screen.findByTestId("issue-node-2");
    fireEvent.click(n2, { clientX: 100, clientY: 100 });
    fireEvent.mouseLeave(n2);
    const tip = screen.getByTestId("issue-map-tip");
    expect(within(tip).getByText(/Pinned\. Click the box again to unpin/)).toBeInTheDocument();
    expect(tip).not.toHaveClass("pointer-events-none");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/Pinned\./)).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("double-click opens the issue on GitHub", async () => {
    renderModal();
    fireEvent.doubleClick(await screen.findByTestId("issue-node-3"));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/o/r/issues/3");
  });

  it("'Show in sidebar' selects the issue and closes the modal", async () => {
    const { onSelectIssue, onClose } = renderModal();
    fireEvent.click(await screen.findByTestId("issue-node-3"), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Show in sidebar" }));
    expect(onSelectIssue).toHaveBeenCalledWith(3);
    expect(onClose).toHaveBeenCalled();
  });

  it("pinned tooltip assigns and unassigns through the backend", async () => {
    renderModal();
    fireEvent.click(await screen.findByTestId("issue-node-2"), { clientX: 5, clientY: 5 });
    const section = screen.getByLabelText("Assignees for #2");

    fireEvent.click(within(section).getByLabelText("bob"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("github_update_issue_assignees", {
        repoPath: REPO,
        number: 2,
        add: ["bob"],
        remove: [],
      }),
    );
    await waitFor(() => expect(within(section).getByLabelText("bob")).toBeChecked());
    // The box now shows the assignee and counts as in progress.
    expect(screen.getByTestId("issue-node-2")).toHaveAttribute("data-status", "inprog");
    expect(within(screen.getByTestId("issue-node-2")).getByText("👤 bob")).toBeInTheDocument();

    fireEvent.click(within(section).getByLabelText("bob"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("github_update_issue_assignees", {
        repoPath: REPO,
        number: 2,
        add: [],
        remove: ["bob"],
      }),
    );
  });

  it("reverts the optimistic assignee patch when the backend fails", async () => {
    mockBackend({ failAssign: true });
    renderModal();
    fireEvent.click(await screen.findByTestId("issue-node-2"), { clientX: 5, clientY: 5 });
    const section = screen.getByLabelText("Assignees for #2");
    fireEvent.click(within(section).getByLabelText("bob"));
    expect(await within(section).findByText("nope")).toBeInTheDocument();
    expect(within(section).getByLabelText("bob")).not.toBeChecked();
    expect(screen.getByTestId("issue-node-2")).toHaveAttribute("data-status", "ready");
  });
});
