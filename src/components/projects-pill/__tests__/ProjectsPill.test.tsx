import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/terminal", () => ({
  killSession: vi.fn().mockResolvedValue(undefined),
}));

import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { ProjectsPill } from "../ProjectsPill";
import { forgetRunningLoads } from "../projectsPillLoad";
import { forgetRememberedProjects, recallProject } from "../projectsPillMemory";
import { useProjectsPillLockStore } from "../useProjectsPillLockStore";
import { WARMUP_DELAY_MS } from "../useProjectsPillWarmup";

const REPO = "https://github.com/acme/widgets";

const tab = (id: string, name: string, extra: Partial<WorkspaceTab> = {}): WorkspaceTab => ({
  id,
  name,
  projectPath: `/work/${name}`,
  active: false,
  sessionIds: [],
  sessionsLaunched: false,
  workspaceType: "single-repo",
  repositories: [],
  selectedRepoPath: null,
  worktreeBasePath: null,
  ...extra,
});

const issue = (number: number, labels: string[]) => ({
  number,
  title: `Made-up issue ${number}`,
  state: "OPEN",
  url: `${REPO}/issues/${number}`,
  labels: labels.map((name) => ({ name, color: "f87171" })),
});

const links = (number: number, blockedBy: number[] = []) => ({
  number,
  blockedBy,
  blocking: [],
  parent: null,
  subIssues: [],
  body: "",
});

// widgets: bug has #1 (free) and #2 (blocked by #1); docs has nothing open.
const WIDGETS = {
  labels: [
    { name: "bug", color: "f87171" },
    { name: "docs", color: "58a6ff" },
  ],
  issues: [issue(1, ["bug"]), issue(2, ["bug"])],
  links: [links(1), links(2, [1])],
};

type Handler = (command: string, repoPath: string) => Promise<unknown>;

function githubAnswers(byRepo: Record<string, typeof WIDGETS | Error>): Handler {
  return async (command, repoPath) => {
    const repo = byRepo[repoPath];
    if (repo instanceof Error) throw repo;
    if (!repo) throw new Error(`no fixture for ${repoPath}`);
    if (command === "github_list_labels") return repo.labels;
    if (command === "github_list_issues") return repo.issues;
    if (command === "github_issue_links") return repo.links;
    throw new Error(`unexpected command ${command}`);
  };
}

function useAnswers(handler: Handler) {
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) =>
    handler(command, (args as { repoPath: string }).repoPath),
  );
}

const pill = () => screen.getByRole("button", { name: /PROJECTS/ });
const list = () => screen.getByRole("dialog", { name: "Projects list" });
const UPDATED_NOTE = "Updated just now.";

async function openList() {
  render(<ProjectsPill />);
  fireEvent.click(pill());
  await screen.findByText(UPDATED_NOTE);
}

/** Answers that wait until the test lets the next batch through. */
function heldAnswers(answers: Handler) {
  let release: () => void = () => {};
  let gate = Promise.resolve();
  const hold = () => {
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  useAnswers(async (command, repoPath) => {
    await gate;
    return answers(command, repoPath);
  });
  return { hold, release: () => act(async () => release()) };
}

/**
 * Renders the pill on a fake clock that also follows real time, so waiting for
 * the list still works, and lets the startup delay pass.
 */
async function renderPastStartup() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<ProjectsPill />);
  await act(() => vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS));
}

/** Changes the open tabs the way opening, closing or switching one does. */
const setTabs = (tabs: WorkspaceTab[]) =>
  act(async () => {
    useWorkspaceStore.setState({ tabs });
  });

const labelCalls = () =>
  vi.mocked(invoke).mock.calls.filter(([command]) => command === "github_list_labels");

async function closeAndOpen() {
  fireEvent.click(pill());
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(pill());
}

describe("ProjectsPill", () => {
  beforeEach(() => {
    forgetRememberedProjects();
    forgetRunningLoads();
    useProjectsPillLockStore.setState({ countBlocked: true });
    useWorkspaceStore.setState({ tabs: [tab("w", "widgets")] });
    useAnswers(githubAnswers({ "/work/widgets": WIDGETS }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.mocked(invoke).mockReset();
    vi.mocked(openUrl).mockClear();
  });

  it("steps from projects to labels to issues, and the back arrow and path return", async () => {
    await openList();
    fireEvent.click(within(list()).getByRole("button", { name: /widgets/ }));

    const rows = within(list()).getAllByTestId("pill-label-row");
    expect(rows.map((r) => r.textContent)).toEqual(["bug2", "docs0"]);
    // A label with no open issue is not a step.
    expect(rows[1].tagName).not.toBe("BUTTON");

    fireEvent.click(rows[0]);
    expect(within(list()).getByText("Made-up issue 1")).toBeInTheDocument();
    expect(within(list()).getByRole("navigation", { name: "Path" }).textContent).toBe(
      "Projects › widgets › bug",
    );

    fireEvent.click(within(list()).getByRole("button", { name: "Back" }));
    expect(within(list()).getAllByTestId("pill-label-row")).toHaveLength(2);

    fireEvent.click(within(list()).getByRole("button", { name: /bug/ }));
    const path = within(list()).getByRole("navigation", { name: "Path" });
    fireEvent.click(within(path).getByRole("button", { name: "widgets" }));
    expect(within(list()).getAllByTestId("pill-label-row")).toHaveLength(2);

    fireEvent.click(within(path).getByRole("button", { name: "Projects" }));
    expect(within(list()).getByRole("button", { name: /widgets/ })).toHaveTextContent("2 open");
  });

  it("opens a clicked issue on GitHub", async () => {
    await openList();
    fireEvent.click(within(list()).getByRole("button", { name: /widgets/ }));
    fireEvent.click(within(list()).getByRole("button", { name: /bug/ }));

    fireEvent.click(within(list()).getByText("Made-up issue 2"));

    expect(openUrl).toHaveBeenCalledWith(`${REPO}/issues/2`);
  });

  it("marks blocked issues while counted and leaves them out under Ready only", async () => {
    await openList();
    fireEvent.click(within(list()).getByRole("button", { name: /widgets/ }));
    fireEvent.click(within(list()).getByRole("button", { name: /bug/ }));

    const lock = within(list()).getByRole("button", { name: /Blocked counted/ });
    expect(screen.getByRole("tooltip")).toHaveTextContent(/blocked ones included/);
    const blockedRow = within(list()).getByText("Made-up issue 2").closest("button");
    expect(within(blockedRow as HTMLElement).getByLabelText("Blocked")).toBeInTheDocument();
    const freeRow = within(list()).getByText("Made-up issue 1").closest("button");
    expect(within(freeRow as HTMLElement).queryByLabelText("Blocked")).toBeNull();

    fireEvent.click(lock);

    expect(within(list()).getByRole("button", { name: /Ready only/ })).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Counting only ready issues/);
    expect(within(list()).queryByText("Made-up issue 2")).toBeNull();
    expect(useProjectsPillLockStore.getState().countBlocked).toBe(false);

    fireEvent.click(within(list()).getByRole("button", { name: "Back" }));
    expect(within(list()).getAllByTestId("pill-label-row")[0].textContent).toBe("bug1");
  });

  it("steps back to the labels when Ready only leaves a label empty", async () => {
    useAnswers(
      githubAnswers({
        "/work/widgets": { ...WIDGETS, issues: [issue(1, []), issue(2, ["bug"])] },
      }),
    );
    await openList();
    fireEvent.click(within(list()).getByRole("button", { name: /widgets/ }));
    fireEvent.click(within(list()).getByRole("button", { name: /bug/ }));

    fireEvent.click(within(list()).getByRole("button", { name: /Blocked counted/ }));

    expect(
      within(list())
        .getAllByTestId("pill-label-row")
        .map((r) => r.textContent),
    ).toEqual(["bug0", "docs0"]);
  });

  it("shows a spinner on the first open, then the last counts at once while they refresh", async () => {
    let fixture = WIDGETS;
    const answers = heldAnswers((command, repoPath) =>
      githubAnswers({ "/work/widgets": fixture })(command, repoPath),
    );

    answers.hold();
    render(<ProjectsPill />);
    fireEvent.click(pill());
    expect(within(list()).getByRole("status")).toHaveTextContent("Loading labels and counts…");
    expect(within(list()).getByText("Loading…")).toBeInTheDocument();
    expect(within(list()).queryByText("updating")).toBeNull();
    await answers.release();
    expect(await within(list()).findByText(UPDATED_NOTE)).toBeInTheDocument();

    // GitHub now has a third open bug; the second open shows the old count until it lands.
    fixture = { ...WIDGETS, issues: [...WIDGETS.issues, issue(3, ["bug"])], links: [] };
    answers.hold();
    await closeAndOpen();
    expect(within(list()).queryByRole("status")).toBeNull();
    expect(within(list()).getByRole("button", { name: /widgets/ })).toHaveTextContent("2 open");
    expect(within(list()).getByText("updating")).toBeInTheDocument();
    expect(within(list()).getByText("Updating…")).toBeInTheDocument();

    await answers.release();
    expect(await within(list()).findByText(UPDATED_NOTE)).toBeInTheDocument();
    expect(within(list()).getByRole("button", { name: /widgets/ })).toHaveTextContent("3 open");
    expect(within(list()).queryByText("updating")).toBeNull();

    expect(labelCalls()).toHaveLength(2);
  });

  it("shows the spinner again for a newly opened project tab", async () => {
    await openList();
    useWorkspaceStore.setState({ tabs: [tab("w", "widgets"), tab("g", "gadgets")] });
    const answers = heldAnswers(
      githubAnswers({ "/work/widgets": WIDGETS, "/work/gadgets": WIDGETS }),
    );
    answers.hold();

    await closeAndOpen();

    expect(within(list()).getByRole("status")).toHaveTextContent("Loading labels and counts…");
    await answers.release();
    expect(await within(list()).findByText(UPDATED_NOTE)).toBeInTheDocument();
    expect(within(list()).getByRole("button", { name: /gadgets/ })).toHaveTextContent("2 open");
  });

  it("keeps a project that keeps failing from bringing the spinner back", async () => {
    useWorkspaceStore.setState({ tabs: [tab("w", "widgets"), tab("d", "docs-site")] });
    const answers = heldAnswers(
      githubAnswers({
        "/work/widgets": WIDGETS,
        "/work/docs-site": new Error("Not authenticated with GitHub."),
      }),
    );
    await openList();

    answers.hold();
    await closeAndOpen();

    expect(within(list()).queryByRole("status")).toBeNull();
    expect(within(list()).getByRole("button", { name: /widgets/ })).toHaveTextContent("2 open");
    expect(within(list()).getByRole("button", { name: /docs-site/ })).not.toHaveTextContent("open");
    expect(within(list()).getByText("updating")).toBeInTheDocument();
    await answers.release();
    expect(await within(list()).findByText(UPDATED_NOTE)).toBeInTheDocument();

    fireEvent.click(within(list()).getByRole("button", { name: /docs-site/ }));
    expect(within(list()).getByRole("alert")).toHaveTextContent(
      "Could not load this repository's labels: Not authenticated with GitHub.",
    );
    expect(within(list()).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("keeps the last counts when an update fails, with Try again", async () => {
    let fail = false;
    const answers = githubAnswers({ "/work/widgets": WIDGETS });
    useAnswers(async (command, repoPath) => {
      if (fail) throw new Error("GitHub did not answer.");
      return answers(command, repoPath);
    });
    await openList();
    fireEvent.click(within(list()).getByRole("button", { name: /widgets/ }));

    fail = true;
    await closeAndOpen();
    fireEvent.click(within(list()).getByRole("button", { name: /widgets/ }));

    const note = await within(list()).findByText(/Could not update/);
    expect(note).toHaveTextContent(
      "Could not update: GitHub did not answer. Showing the last counts. Try again",
    );
    expect(within(list()).queryByRole("alert")).toBeNull();
    expect(
      within(list())
        .getAllByTestId("pill-label-row")
        .map((r) => r.textContent),
    ).toEqual(["bug2", "docs0"]);

    fail = false;
    fireEvent.click(within(note).getByRole("button", { name: "Try again" }));
    expect(await within(list()).findByText(UPDATED_NOTE)).toBeInTheDocument();
  });

  it("greys out a project with no GitHub repository", async () => {
    useWorkspaceStore.setState({
      tabs: [
        tab("w", "widgets"),
        tab("n", "notes", { workspaceType: "non-git" }),
        tab("l", "local-only"),
      ],
    });
    useAnswers(
      githubAnswers({
        "/work/widgets": WIDGETS,
        "/work/local-only": new Error(
          "gh command failed (exit code 1): unable to expand placeholder in path: no git remotes found",
        ),
      }),
    );

    await openList();

    for (const name of ["notes", "local-only"]) {
      const row = within(list()).getByText(name).parentElement as HTMLElement;
      expect(row.tagName).not.toBe("BUTTON");
      expect(row).toHaveTextContent("no GitHub repository");
    }
    expect(invoke).not.toHaveBeenCalledWith("github_list_labels", { repoPath: "/work/notes" });
  });

  it("shows a failed load with Try again, which loads that project again", async () => {
    let fail = true;
    const answers = githubAnswers({ "/work/widgets": WIDGETS });
    useAnswers(async (command, repoPath) => {
      if (fail) throw new Error("GitHub API rate limit exceeded. Try again later.");
      return answers(command, repoPath);
    });

    await openList();
    fireEvent.click(within(list()).getByRole("button", { name: /widgets/ }));
    expect(within(list()).getByRole("alert")).toHaveTextContent(
      "Could not load this repository's labels: GitHub API rate limit exceeded. Try again later.",
    );

    fail = false;
    fireEvent.click(within(list()).getByRole("button", { name: "Try again" }));

    expect(await within(list()).findAllByTestId("pill-label-row")).toHaveLength(2);
  });

  it("shows a malformed GitHub answer as the same error", async () => {
    useAnswers(githubAnswers({ "/work/widgets": { ...WIDGETS, labels: [{ name: null }] } }));

    await openList();
    fireEvent.click(within(list()).getByRole("button", { name: /widgets/ }));

    expect(within(list()).getByRole("alert")).toHaveTextContent(
      "GitHub sent an answer Maestro could not read",
    );
    expect(within(list()).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  describe("background fetch", () => {
    it("fetches each open tab once when the startup delay ends, and non-git tabs never", async () => {
      vi.useFakeTimers();
      useWorkspaceStore.setState({
        tabs: [tab("w", "widgets"), tab("n", "notes", { workspaceType: "non-git" })],
      });
      render(<ProjectsPill />);

      await act(() => vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS - 1));
      expect(invoke).not.toHaveBeenCalled();

      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(labelCalls()).toEqual([["github_list_labels", { repoPath: "/work/widgets" }]]);
      expect(recallProject("n", "/work/notes")).toEqual({ kind: "no-repo" });

      // A tab change that keeps every folder fetches nothing again.
      await setTabs([tab("w", "widgets", { active: true })]);
      await act(() => vi.advanceTimersByTimeAsync(WARMUP_DELAY_MS));
      expect(labelCalls()).toHaveLength(1);
    });

    it("opens with the fetched counts at once and the updating mark", async () => {
      const answers = heldAnswers(githubAnswers({ "/work/widgets": WIDGETS }));
      await renderPastStartup();
      await waitFor(() => expect(recallProject("w", "/work/widgets")).not.toBeNull());

      answers.hold();
      fireEvent.click(pill());

      expect(within(list()).queryByRole("status")).toBeNull();
      expect(within(list()).getByRole("button", { name: /widgets/ })).toHaveTextContent("2 open");
      expect(within(list()).getByText("updating")).toBeInTheDocument();
      await answers.release();
      expect(await within(list()).findByText(UPDATED_NOTE)).toBeInTheDocument();
    });

    it("fetches a tab opened later right away, and again when its folder changes", async () => {
      useAnswers(githubAnswers({ "/work/widgets": WIDGETS, "/work/gadgets": WIDGETS }));
      await renderPastStartup();

      await setTabs([tab("w", "widgets"), tab("g", "gadgets")]);
      await waitFor(() => expect(recallProject("g", "/work/gadgets")).not.toBeNull());

      await setTabs([
        tab("w", "widgets"),
        tab("g", "gadgets", { selectedRepoPath: "/work/widgets" }),
      ]);
      await waitFor(() => expect(recallProject("g", "/work/widgets")).not.toBeNull());
      expect(labelCalls().map(([, args]) => args)).toEqual([
        { repoPath: "/work/widgets" },
        { repoPath: "/work/gadgets" },
        { repoPath: "/work/widgets" },
      ]);
    });

    it("joins a background fetch still running when the list opens", async () => {
      const answers = heldAnswers(githubAnswers({ "/work/widgets": WIDGETS }));
      answers.hold();
      await renderPastStartup();

      fireEvent.click(pill());
      expect(within(list()).getByRole("status")).toHaveTextContent("Loading labels and counts…");
      await answers.release();

      expect(await within(list()).findByText(UPDATED_NOTE)).toBeInTheDocument();
      expect(within(list()).getByRole("button", { name: /widgets/ })).toHaveTextContent("2 open");
      expect(labelCalls()).toHaveLength(1);
    });

    it("keeps a failed background fetch quiet until the list opens", async () => {
      const failure = vi.spyOn(console, "error").mockImplementation(() => {});
      useAnswers(githubAnswers({ "/work/widgets": new Error("Not authenticated with GitHub.") }));
      await renderPastStartup();
      await waitFor(() => expect(failure).toHaveBeenCalled());
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();

      fireEvent.click(pill());
      expect(within(list()).queryByRole("status")).toBeNull();
      expect(await within(list()).findByText(UPDATED_NOTE)).toBeInTheDocument();
      fireEvent.click(within(list()).getByRole("button", { name: /widgets/ }));
      expect(within(list()).getByRole("alert")).toHaveTextContent(
        "Could not load this repository's labels: Not authenticated with GitHub.",
      );
      failure.mockRestore();
    });
  });
});
