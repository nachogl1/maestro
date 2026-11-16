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

import type { PullRequestInfo } from "@/stores/useGitHubStore";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { PrsPill } from "../PrsPill";
import { usePrsPillStore } from "../usePrsPillStore";

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

const rawPr = (number: number, createdAt: string, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Made-up change ${number}`,
  url: `https://github.com/acme/widgets/pull/${number}`,
  author: { login: "dev-otter" },
  isDraft: false,
  createdAt,
  reviewDecision: "REVIEW_REQUIRED",
  checksSummary: { success: 1, failure: 0, pending: 0, total: 1, verdict: "success" },
  ...extra,
});

// widgets: #548 waits for my review; #553 is the newest; #551 sits between them.
const WIDGETS = [
  rawPr(548, "2026-11-14T10:00:00Z"),
  rawPr(551, "2026-11-15T10:00:00Z", {
    checksSummary: { verdict: "failure" },
    reviewDecision: "CHANGES_REQUESTED",
  }),
  rawPr(553, "2026-11-16T10:00:00Z", { isDraft: true, reviewDecision: null }),
];
const SHOP = [rawPr(61, "2026-11-10T10:00:00Z", { reviewDecision: "APPROVED" })];

type Answer = unknown[] | Error | (() => Promise<unknown>);

function answers(byRepo: Record<string, Answer>) {
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    if (command !== "github_list_prs") throw new Error(`unexpected command ${command}`);
    const answer = byRepo[(args as { repoPath: string }).repoPath];
    if (answer === undefined) throw new Error("no fixture");
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer();
    return answer;
  });
}

const prCalls = () =>
  vi.mocked(invoke).mock.calls.filter(([command]) => command === "github_list_prs").length;

const reviewRequest = (number: number) => ({ number }) as PullRequestInfo;

const pill = () => screen.getByRole("button", { name: /PRs?$/ });
const list = () => screen.getByRole("dialog", { name: "Pull requests list" });

async function renderLoaded() {
  render(<PrsPill />);
  await screen.findByRole("button", { name: /PRs?$/ });
}

async function openList() {
  await renderLoaded();
  fireEvent.click(pill());
  await within(list()).findByText("Updated just now.");
}

describe("PrsPill", () => {
  beforeEach(() => {
    usePrsPillStore.setState({ loads: {}, refreshing: {} });
    useGitHubWatchdogStore.setState({
      projects: [
        {
          name: "widgets",
          repoPath: "/work/widgets",
          reviewRequests: [reviewRequest(548)],
          assignedIssues: [],
          reviewRequestsErrored: false,
          assignedIssuesErrored: false,
        },
      ],
      lastPolledAt: null,
    });
    useWorkspaceStore.setState({
      tabs: [tab("w", "widgets"), tab("s", "shop"), tab("e", "empty"), tab("n", "notes")],
    });
    answers({
      "/work/widgets": WIDGETS,
      "/work/shop": SHOP,
      "/work/empty": [],
      "/work/notes": new Error(
        "none of the git remotes configured are GitHub: not a GitHub repository",
      ),
    });
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(openUrl).mockClear();
  });

  it("totals the open pull requests across open projects and lists only projects that have some", async () => {
    // A second tab on the same repository and a non-git folder are not read again.
    useWorkspaceStore.setState({
      tabs: [
        ...useWorkspaceStore.getState().tabs,
        tab("w2", "widgets again", { projectPath: "/work/widgets" }),
        tab("x", "scratch", { workspaceType: "non-git" }),
      ],
    });
    await openList();

    expect(pill()).toHaveTextContent("4 PRs");
    expect(prCalls()).toBe(8); // 4 repositories, at start and on open
    const rows = within(list()).getAllByRole("button", { name: /open$/ });
    expect(rows.map((r) => r.textContent)).toEqual(["widgets👁 13 open", "shop1 open"]);
  });

  it("is hidden when no open project has an open pull request", async () => {
    answers({ "/work/widgets": [], "/work/shop": [], "/work/empty": [], "/work/notes": [] });
    render(<PrsPill />);
    await act(async () => {});

    expect(screen.queryByRole("button", { name: /PRs?$/ })).toBeNull();
    expect(prCalls()).toBe(4);
  });

  it("lists a project's pull requests waiting for my review first, marked, then newest first", async () => {
    await openList();
    fireEvent.click(within(list()).getByRole("button", { name: /^widgets/ }));

    const rows = within(list()).getAllByRole("button", { name: /^#\d+/ });
    expect(rows.map((r) => r.textContent?.slice(0, 4))).toEqual(["#548", "#553", "#551"]);
    expect(within(rows[0]).getByRole("img", { name: "Waiting for your review" })).toBeTruthy();
    expect(within(rows[1]).queryByRole("img")).toBeNull();
    expect(within(rows[1]).getByText("draft")).toBeTruthy();
    expect(within(list()).getByRole("navigation", { name: "Path" }).textContent).toBe(
      "Pull requests › widgets",
    );
  });

  it("shows a detail card whose button opens the pull request on GitHub, and steps back", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 16, 15, 0) });
    try {
      await openList();
      fireEvent.click(within(list()).getByRole("button", { name: /^widgets/ }));
      fireEvent.click(within(list()).getByRole("button", { name: /^#551/ }));

      const card = list();
      expect(within(card).getByText("Made-up change 551")).toBeTruthy();
      expect(within(card).getByText("#551 · by dev-otter")).toBeTruthy();
      expect(within(card).getByText("Ready for review")).toBeTruthy();
      expect(within(card).getByText("Failing")).toBeTruthy();
      expect(within(card).getByText("Changes requested")).toBeTruthy();
      expect(within(card).getByText(/^15 Nov 2026 \(yesterday\)$/)).toBeTruthy();
      expect(within(card).queryByText(/Waiting for your review/)).toBeNull();
      expect(within(card).getByRole("navigation", { name: "Path" }).textContent).toBe(
        "Pull requests › widgets › #551",
      );

      fireEvent.click(within(card).getByRole("button", { name: /Open on GitHub/ }));
      expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/widgets/pull/551");

      fireEvent.click(within(card).getByRole("button", { name: "Back" }));
      fireEvent.click(within(list()).getByRole("button", { name: /^#553/ }));
      expect(within(list()).getByText("Draft")).toBeTruthy();
      expect(within(list()).getByText("No review yet")).toBeTruthy();

      const path = within(list()).getByRole("navigation", { name: "Path" });
      fireEvent.click(within(path).getByRole("button", { name: "widgets" }));
      expect(within(list()).getAllByRole("button", { name: /^#\d+/ })).toHaveLength(3);
      fireEvent.click(within(list()).getByRole("button", { name: "Back" }));
      expect(within(list()).getAllByRole("button", { name: /open$/ })).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the last results at once on a second open and refreshes them", async () => {
    await openList();
    fireEvent.click(pill());
    expect(screen.queryByRole("dialog")).toBeNull();

    let release: (value: unknown) => void = () => {};
    answers({
      "/work/widgets": () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      "/work/shop": SHOP,
      "/work/empty": [],
      "/work/notes": [],
    });
    fireEvent.click(pill());

    expect(within(list()).getByRole("button", { name: /^widgets/ })).toHaveTextContent("3 open");
    expect(within(list()).getByText("updating")).toBeTruthy();
    expect(within(list()).getByText("Updating…")).toBeTruthy();

    await act(async () => release([rawPr(548, "2026-11-14T10:00:00Z")]));
    expect(within(list()).getByRole("button", { name: /^widgets/ })).toHaveTextContent("1 open");
    expect(within(list()).queryByText("updating")).toBeNull();
    expect(pill()).toHaveTextContent("2 PRs");
  });

  it("shows a failed project's error with Try again while the others stay", async () => {
    answers({
      "/work/widgets": new Error("GitHub did not answer."),
      "/work/shop": SHOP,
      "/work/empty": [],
      "/work/notes": [],
    });
    await openList();

    const alert = within(list()).getByRole("alert");
    expect(alert).toHaveTextContent("Could not load: GitHub did not answer. Try again");
    expect(within(list()).getByRole("button", { name: /^shop/ })).toBeTruthy();
    expect(pill()).toHaveTextContent("1 PR");

    answers({ "/work/widgets": WIDGETS, "/work/shop": SHOP, "/work/empty": [], "/work/notes": [] });
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await within(list()).findByRole("button", { name: /^widgets/ })).toHaveTextContent(
      "3 open",
    );
    expect(pill()).toHaveTextContent("4 PRs");
  });

  it("refreshes the total on every watchdog poll while closed", async () => {
    await renderLoaded();
    expect(prCalls()).toBe(4);
    answers({ "/work/widgets": WIDGETS, "/work/shop": [], "/work/empty": [], "/work/notes": [] });

    await act(async () => useGitHubWatchdogStore.setState({ lastPolledAt: 1 }));

    expect(prCalls()).toBe(8);
    expect(pill()).toHaveTextContent("3 PRs");
  });

  it("closes on Escape and on a click outside", async () => {
    await openList();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(pill());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
