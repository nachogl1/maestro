import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
import { useProjectsPillLockStore } from "../useProjectsPillLockStore";

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

async function openList() {
  render(<ProjectsPill />);
  fireEvent.click(pill());
  await screen.findByText("Loaded just now. Counts refresh each time you open this list.");
}

describe("ProjectsPill", () => {
  beforeEach(() => {
    useProjectsPillLockStore.setState({ countBlocked: true });
    useWorkspaceStore.setState({ tabs: [tab("w", "widgets")] });
    useAnswers(githubAnswers({ "/work/widgets": WIDGETS }));
  });

  afterEach(() => {
    cleanup();
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

  it("shows a spinner and asks GitHub again on every open", async () => {
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const answers = githubAnswers({ "/work/widgets": WIDGETS });
    useAnswers(async (command, repoPath) => {
      await gate;
      return answers(command, repoPath);
    });

    render(<ProjectsPill />);
    fireEvent.click(pill());
    expect(within(list()).getByRole("status")).toHaveTextContent("Loading labels and counts…");
    await act(async () => finish());
    await screen.findByText(/Loaded just now/);

    fireEvent.click(pill());
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(pill());
    expect(within(list()).getByRole("status")).toBeInTheDocument();
    await screen.findByText(/Loaded just now/);

    const labelCalls = vi.mocked(invoke).mock.calls.filter(([c]) => c === "github_list_labels");
    expect(labelCalls).toHaveLength(2);
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
});
