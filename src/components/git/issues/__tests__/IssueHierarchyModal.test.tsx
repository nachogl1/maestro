import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueLinks } from "@/lib/issueGraph";
import type { IssueInfo } from "@/stores/useGitHubStore";
import { IssueHierarchyModal } from "../IssueHierarchyModal";

/** React Flow measures through browser APIs happy-dom lacks (same stubs as LandscapeView). */
beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22 = 1;
    },
  );
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 800,
      toJSON: () => {},
    }),
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });
});

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
    title: "Epic: graph",
    labels: [{ name: "epic", color: "8250df" }],
  }),
  buildIssue({ number: 2, title: "Build the canvas", labels: [{ name: "bug", color: "d73a4a" }] }),
  buildIssue({ number: 3, title: "Old closed work", state: "CLOSED" }),
];

const LINKS: IssueLinks[] = [
  buildLinks({ number: 1, subIssues: [2] }),
  // #99 is not in the fetched set → stub node.
  buildLinks({ number: 2, parent: 1, blockedBy: [99] }),
  buildLinks({ number: 3 }),
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
    <IssueHierarchyModal
      repoPath={REPO}
      search="assignee:@me"
      onSelectIssue={onSelectIssue}
      onClose={onClose}
    />,
  );
  return { onSelectIssue, onClose };
}

describe("IssueHierarchyModal", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockBackend();
  });

  it("renders one node per open issue plus a stub for an out-of-set link", async () => {
    renderModal();
    expect(await screen.findByTestId("issue-node-1")).toBeInTheDocument();
    expect(screen.getByTestId("issue-node-2")).toBeInTheDocument();
    // Default filter is Open, so the closed issue is not drawn.
    expect(screen.queryByTestId("issue-node-3")).not.toBeInTheDocument();
    const stub = screen.getByTestId("issue-node-99");
    expect(within(stub).getByText("not in current filter")).toBeInTheDocument();
    expect(within(stub).queryByLabelText(/Assign/)).not.toBeInTheDocument();
    expect(screen.getByText(/2 issues · 2 links/)).toBeInTheDocument();
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

  it("state filter switches between open, closed and all", async () => {
    renderModal();
    await screen.findByTestId("issue-node-1");
    fireEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(screen.getByTestId("issue-node-3")).toBeInTheDocument();
    expect(screen.queryByTestId("issue-node-2")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByTestId("issue-node-3")).toBeInTheDocument();
    expect(screen.getByTestId("issue-node-2")).toBeInTheDocument();
  });

  it("label chips cycle include → exclude → neutral", async () => {
    renderModal();
    await screen.findByTestId("issue-node-1");
    const bugChip = screen.getByRole("button", { name: "bug" });

    fireEvent.click(bugChip); // include: only #2 is listed, #1 becomes a stub
    expect(bugChip).toHaveAttribute("data-mode", "include");
    expect(within(screen.getByTestId("issue-node-1")).getByText("not in current filter"));
    expect(within(screen.getByTestId("issue-node-2")).getByText("Build the canvas"));

    fireEvent.click(bugChip); // exclude: #2 is hidden, but #1's link leaves it as a stub
    expect(bugChip).toHaveAttribute("data-mode", "exclude");
    expect(within(screen.getByTestId("issue-node-1")).getByText("Epic: graph"));
    expect(within(screen.getByTestId("issue-node-2")).getByText("not in current filter"));

    fireEvent.click(bugChip); // neutral
    expect(bugChip).toHaveAttribute("data-mode", "neutral");
    expect(within(screen.getByTestId("issue-node-2")).getByText("Build the canvas"));
  });

  it("clicking a node selects the issue and closes the modal", async () => {
    const { onSelectIssue, onClose } = renderModal();
    fireEvent.click(await screen.findByText("Build the canvas"));
    expect(onSelectIssue).toHaveBeenCalledWith(2);
    expect(onClose).toHaveBeenCalled();
  });

  it("Esc closes the modal", async () => {
    const { onClose } = renderModal();
    await screen.findByTestId("issue-node-1");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("assign popover toggles assignees through the backend", async () => {
    const { onSelectIssue, onClose } = renderModal();
    await screen.findByTestId("issue-node-2");
    fireEvent.click(screen.getByLabelText("Assign #2"));
    const popover = screen.getByLabelText("Assignees for #2");

    fireEvent.click(within(popover).getByLabelText("bob"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("github_update_issue_assignees", {
        repoPath: REPO,
        number: 2,
        add: ["bob"],
        remove: [],
      }),
    );
    const node = screen.getByTestId("issue-node-2");
    await waitFor(() => expect(within(node).getAllByText("bob").length).toBeGreaterThan(0));
    expect(within(popover).getByLabelText("bob")).toBeChecked();

    fireEvent.click(within(popover).getByLabelText("bob"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("github_update_issue_assignees", {
        repoPath: REPO,
        number: 2,
        add: [],
        remove: ["bob"],
      }),
    );
    // Popover clicks must not select the node.
    expect(onSelectIssue).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reverts the optimistic assignee patch when the backend fails", async () => {
    mockBackend({ failAssign: true });
    renderModal();
    await screen.findByTestId("issue-node-2");
    fireEvent.click(screen.getByLabelText("Assign #2"));
    const popover = screen.getByLabelText("Assignees for #2");
    fireEvent.click(within(popover).getByLabelText("bob"));
    expect(await within(popover).findByText("nope")).toBeInTheDocument();
    expect(within(popover).getByLabelText("bob")).not.toBeChecked();
  });
});
