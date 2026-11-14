import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The PR workflow store hydrates through the Tauri store plugin at import
// time; happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));

import { DEFAULT_PR_WORKFLOW } from "@/lib/prWorkflow";
import type { WorkflowGraph } from "@/lib/workflowGraphTypes";
import type { PullRequestInfo } from "@/stores/useGitHubStore";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { prWorkflowGraphForLaunch, usePrWorkflowStore } from "@/stores/usePrWorkflowStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { PrActionsMenu } from "../PrActionsMenu";

const REPO_PATH = "C:\\git\\maestro";

function buildTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "maestro",
    projectPath: REPO_PATH,
    active: true,
    sessionIds: [],
    sessionsLaunched: false,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
    ...overrides,
  };
}

function buildPr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 123,
    title: "feat(pr): monitoring tower",
    state: "OPEN",
    author: { login: "nachogl1" },
    createdAt: "2026-08-13T10:00:00Z",
    updatedAt: "2026-08-13T12:00:00Z",
    headRefName: "feat/pr-monitor",
    baseRefName: "main",
    isDraft: false,
    additions: 12,
    deletions: 3,
    url: "https://github.com/nachogl1/maestro/pull/123",
    labels: [],
    mergedAt: null,
    closedAt: null,
    ...overrides,
  };
}

/** The default chain plus a user-added fifth step, wired onto the end. */
function graphWithExtraStep(): WorkflowGraph {
  return {
    nodes: [
      ...DEFAULT_PR_WORKFLOW.nodes,
      { id: "announce", label: "Announce result", text: "Post the outcome to the team channel." },
    ],
    edges: [...DEFAULT_PR_WORKFLOW.edges, { from: "merge", to: "announce" }],
    start: DEFAULT_PR_WORKFLOW.start,
  };
}

function openMenu() {
  fireEvent.click(screen.getByLabelText("Actions for PR #123"));
}

function checkboxFor(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

describe("PrActionsMenu", () => {
  beforeEach(async () => {
    // Let the persisted store finish hydrating before seeding it, so a late
    // rehydration cannot overwrite the graph a test just set.
    await prWorkflowGraphForLaunch();
    usePrWorkflowStore.setState({ graph: null });
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    usePendingLaunchStore.setState({ pending: [] });
  });

  it("derives one checkbox per workflow step, with only the first ticked", () => {
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    expect(checkboxFor("Check status").checked).toBe(true);
    expect(checkboxFor("Review & post").checked).toBe(false);
    expect(checkboxFor("Fix issues").checked).toBe(false);
    expect(checkboxFor("Merge if green").checked).toBe(false);
    expect(screen.getByRole("button", { name: /Launch 1 step/ })).toBeInTheDocument();
  });

  it("shows a step the user added to the workflow graph", () => {
    usePrWorkflowStore.setState({ graph: graphWithExtraStep() });
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
    expect(checkboxFor("Announce result")).toBeInTheDocument();
  });

  it("ticks every earlier step and unticks every later one", () => {
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    // Ticking "Fix issues" pulls the two steps before it in with it.
    fireEvent.click(checkboxFor("Fix issues"));
    expect(checkboxFor("Check status").checked).toBe(true);
    expect(checkboxFor("Review & post").checked).toBe(true);
    expect(checkboxFor("Fix issues").checked).toBe(true);
    expect(checkboxFor("Merge if green").checked).toBe(false);
    expect(screen.getByRole("button", { name: /Launch 3 steps/ })).toBeInTheDocument();

    // Unticking "Review & post" drops it and everything after it.
    fireEvent.click(checkboxFor("Review & post"));
    expect(checkboxFor("Check status").checked).toBe(true);
    expect(checkboxFor("Review & post").checked).toBe(false);
    expect(checkboxFor("Fix issues").checked).toBe(false);
    expect(screen.getByRole("button", { name: /Launch 1 step/ })).toBeInTheDocument();
  });

  it("disables Launch when nothing is ticked", () => {
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    fireEvent.click(checkboxFor("Check status"));
    const launch = screen.getByRole("button", { name: /Launch 0 steps/ });
    expect(launch).toBeDisabled();
    fireEvent.click(launch);
    expect(usePendingLaunchStore.getState().pending).toHaveLength(0);
  });

  it("requests a pending launch carrying the compiled prompt, and closes", async () => {
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    fireEvent.click(checkboxFor("Review & post"));
    fireEvent.click(screen.getByRole("button", { name: /Launch 2 steps/ }));

    await waitFor(() => expect(usePendingLaunchStore.getState().pending).toHaveLength(1));
    const launch = usePendingLaunchStore.getState().pending[0];
    expect(launch.tabId).toBe("tab-1");
    expect(launch.mode).toBe("Claude");
    expect(launch.workingDirOverride).toBe(REPO_PATH);
    expect(launch.customName).toBe("PR #123 check+review");
    expect(launch.initialPrompt).toContain('PR: #123 "feat(pr): monitoring tower"');
    expect(launch.initialPrompt).toContain("--repo nachogl1/maestro");
    expect(launch.initialPrompt).toContain("Step 1:");
    expect(launch.initialPrompt).toContain("Step 2:");
    // Only check+review are ticked, so the run stays read-only.
    expect(launch.initialPrompt).toContain("READ-ONLY");

    // The grid must be mounted to consume the request.
    expect(useWorkspaceStore.getState().tabs[0].sessionsLaunched).toBe(true);
    await waitFor(() => expect(screen.queryByLabelText("Check status")).not.toBeInTheDocument());
  });

  it("stages the prompt as a brief file in the project checkout", async () => {
    // Issue #138: the launch names where the prompt is written and under what
    // stem, so the backend types a one-line pointer instead of a multi-KB
    // payload the PTY delivers in spliced fragments.
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    fireEvent.click(checkboxFor("Review & post"));
    fireEvent.click(screen.getByRole("button", { name: /Launch 2 steps/ }));

    await waitFor(() => expect(usePendingLaunchStore.getState().pending).toHaveLength(1));
    const launch = usePendingLaunchStore.getState().pending[0];
    expect(launch.briefDir).toBe(REPO_PATH);
    // Review finding C9: the stem carries a hash of the exact step selection,
    // so a second review never overwrites a running one's brief.
    expect(launch.briefStem).toMatch(/^pr-123-check-review-[0-9a-f]{8}$/);
  });

  it("records the review as a run so its artifacts have work to belong to", async () => {
    // Issue #139: a PR review used to leave NOTHING on disk, so its brief and
    // audit rows had no group. The launch now carries the record's metadata —
    // PR, title, repo slug, checkout, ticked steps — and the backend adds the
    // session id and the brief path at the arm hop.
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    fireEvent.click(checkboxFor("Review & post"));
    fireEvent.click(screen.getByRole("button", { name: /Launch 2 steps/ }));

    await waitFor(() => expect(usePendingLaunchStore.getState().pending).toHaveLength(1));
    expect(usePendingLaunchStore.getState().pending[0].prRun).toEqual({
      pr: 123,
      title: "feat(pr): monitoring tower",
      repo: "nachogl1/maestro",
      project_path: REPO_PATH,
      steps: ["check", "review"],
    });
  });

  it("records the review under the PR's own checkout, not the active tab's project", async () => {
    // Review finding C10: in a multi-repo workspace the PR belongs to a
    // repository inside the tab, so recording the tab's project filed the
    // review under the wrong project. The brief still goes to the terminal's
    // cwd — that is the directory the launch actually opens in.
    const PR_CHECKOUT = "C:\\git\\maestro\\packages\\api";
    render(<PrActionsMenu pr={buildPr()} repoPath={PR_CHECKOUT} />);
    openMenu();

    fireEvent.click(screen.getByRole("button", { name: /Launch 1 step/ }));

    await waitFor(() => expect(usePendingLaunchStore.getState().pending).toHaveLength(1));
    const launch = usePendingLaunchStore.getState().pending[0];
    expect(launch.prRun?.project_path).toBe(PR_CHECKOUT);
    expect(launch.briefDir).toBe(REPO_PATH);
    expect(launch.workingDirOverride).toBe(REPO_PATH);
  });

  it("records an unparseable PR url as an empty repo slug rather than blocking", async () => {
    // A slug that will not parse must never stop a review launching: the
    // group still keys off the PR number within the checkout.
    render(<PrActionsMenu pr={buildPr({ url: "not-a-github-url" })} repoPath={REPO_PATH} />);
    openMenu();

    fireEvent.click(screen.getByRole("button", { name: /Launch 1 step/ }));

    await waitFor(() => expect(usePendingLaunchStore.getState().pending).toHaveLength(1));
    expect(usePendingLaunchStore.getState().pending[0].prRun?.repo).toBe("");
  });

  it("keeps the brief stem filesystem-safe for step ids with symbols or spaces", async () => {
    // Step ids come from the workflow editor, so they are free text: a stem
    // built from them must still be one legal file name.
    usePrWorkflowStore.setState({
      graph: {
        nodes: [
          { id: "triage + verdict", label: "Triage", text: "Custom triage ritual." },
          { id: "post NOTES", label: "Post", text: "Custom posting ritual." },
        ],
        edges: [{ from: "triage + verdict", to: "post NOTES" }],
        start: "triage + verdict",
      },
    });
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    fireEvent.click(checkboxFor("Post"));
    fireEvent.click(screen.getByRole("button", { name: /Launch 2 steps/ }));

    await waitFor(() => expect(usePendingLaunchStore.getState().pending).toHaveLength(1));
    expect(usePendingLaunchStore.getState().pending[0].briefStem).toMatch(
      /^pr-123-triage-verdict-post-notes-[0-9a-f]{8}$/,
    );
  });

  it("launches the edited workflow verbatim: custom steps, edge order, no default text", async () => {
    // A fully user-edited graph: custom texts, node-array order REVERSED
    // relative to the edge order (so the prompt order can only come from the
    // graph walk, never from array position), plus a disconnected box that
    // must not leak into the prompt.
    const edited: WorkflowGraph = {
      nodes: [
        { id: "verdict", label: "Verdict", text: "Custom verdict ritual." },
        { id: "triage", label: "Triage", text: "Custom triage ritual for <PR>." },
        { id: "orphan", label: "Orphan", text: "Disconnected ritual." },
      ],
      edges: [{ from: "triage", to: "verdict" }],
      start: "triage",
    };
    usePrWorkflowStore.setState({ graph: edited });
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    // The disconnected box never becomes a checkbox.
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(checkboxFor("Verdict"));
    fireEvent.click(screen.getByRole("button", { name: /Launch 2 steps/ }));

    await waitFor(() => expect(usePendingLaunchStore.getState().pending).toHaveLength(1));
    const launch = usePendingLaunchStore.getState().pending[0];
    // The edited texts ride verbatim, renumbered in WALK order (triage first
    // despite being listed second), with <PR> resolved to this PR's number.
    const prompt = launch.initialPrompt ?? "";
    expect(prompt).toContain("Step 1: Custom triage ritual for 123.");
    expect(prompt).toContain("Step 2: Custom verdict ritual.");
    expect(prompt.indexOf("Custom triage ritual")).toBeLessThan(
      prompt.indexOf("Custom verdict ritual"),
    );
    // Nothing of the replaced default workflow leaks in…
    expect(prompt).not.toContain("Gather the full picture");
    expect(prompt).not.toContain("gh pr merge");
    // …and neither does the disconnected box.
    expect(prompt).not.toContain("Disconnected ritual");
    // The launch is named after the edited step ids too.
    expect(launch.customName).toBe("PR #123 triage+verdict");
  });

  it("asks for a project tab instead of launching when none is active", async () => {
    useWorkspaceStore.setState({ tabs: [buildTab({ active: false })] });
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);
    openMenu();

    fireEvent.click(screen.getByRole("button", { name: /Launch 1 step/ }));

    expect(
      await screen.findByText("Open a project tab to launch a PR action."),
    ).toBeInTheDocument();
    expect(usePendingLaunchStore.getState().pending).toHaveLength(0);
  });

  it("closes on Escape and on an outside click", () => {
    render(<PrActionsMenu pr={buildPr()} repoPath={REPO_PATH} />);

    openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByLabelText("Check status")).not.toBeInTheDocument();

    openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByLabelText("Check status")).not.toBeInTheDocument();
  });
});
