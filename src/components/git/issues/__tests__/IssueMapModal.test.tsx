import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueLinks } from "@/lib/issueGraph";
import { type IssueInfo, useGitHubStore } from "@/stores/useGitHubStore";
import { IssueMapModal } from "../IssueMapModal";
import { MAP_ISSUE_LIMIT } from "../useIssueMap";

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
    labels: [
      { name: "needs-human-decision", color: "d93f0b" },
      { name: "bug", color: "ff0000" },
    ],
    assignees: [{ login: "alice" }],
  }),
  buildIssue({ number: 4, title: "Epic: all of it", labels: [{ name: "epic", color: "5319e7" }] }),
];

const LINKS: IssueLinks[] = [
  buildLinks({ number: 1 }),
  buildLinks({
    number: 2,
    blockedBy: [1],
    body: "## Goal\n\nDraw the **canvas** with `svg`.\n\n### Blocked by\n- #1\n",
  }),
  buildLinks({ number: 3, blockedBy: [2], body: "### Blocked by\n- #2\n- #4\n" }),
  buildLinks({ number: 4, subIssues: [3] }),
];

const mockedInvoke = vi.mocked(invoke);
const REPO = "/repo";

function mockBackend(
  options: { failAssign?: boolean; failExport?: boolean; issues?: IssueInfo[] } = {},
) {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "github_auth_status":
        return { logged_in: true, username: "alice-from-gh", scopes: [] };
      case "export_issue_map":
        if (options.failExport) throw new Error("disk full");
        return undefined;
      case "github_list_issues":
        return options.issues ?? ISSUES;
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

/** Opens one filter menu by its button (the button also shows "all", "4/5", ...). */
const openFilter = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));

describe("IssueMapModal", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    vi.mocked(openUrl).mockClear();
    vi.mocked(save).mockReset();
    useGitHubStore.setState({ authStatus: null });
    mockBackend();
  });

  it("fetches every issue state up to the limit; epics and closed issues start hidden", async () => {
    renderModal();
    expect(await screen.findByTestId("issue-node-2")).toHaveAttribute("data-level", "1");
    expect(screen.getByTestId("issue-node-2")).toHaveAttribute("data-status", "ready");
    const n3 = screen.getByTestId("issue-node-3");
    expect(n3).toHaveAttribute("data-level", "2");
    expect(n3).toHaveAttribute("data-status", "blocked");
    expect(n3).toHaveAttribute("data-kind", "human");
    expect(screen.queryByTestId("issue-node-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("issue-node-4")).not.toBeInTheDocument();
    expect(screen.getByText(/3 issues \+ 1 epic · 2 blocked-by links/)).toBeInTheDocument();
    expect(screen.queryByText(/Wave|Foundation|Already done/)).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 2 of 4 issues/)).toBeInTheDocument();
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();

    // Ticking everything brings back the closed #1 and the epic in its own column.
    fireEvent.click(screen.getByRole("button", { name: "show all" }));
    const n1 = screen.getByTestId("issue-node-1");
    expect(n1).toHaveAttribute("data-level", "0");
    expect(n1).toHaveAttribute("data-status", "closed");
    expect(screen.getByTestId("issue-node-4")).toHaveAttribute("data-kind", "epic");
    expect(screen.getByTestId("issue-map-column-Epics")).toBeInTheDocument();
    expect(screen.getByText("Level 0")).toBeInTheDocument();
    expect(screen.getByText(/Showing 4 of 4 issues/)).toBeInTheDocument();
    expect(mockedInvoke).toHaveBeenCalledWith("github_list_issues", {
      repoPath: REPO,
      state: "all",
      limit: 1000,
      search: "assignee:@me",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("github_issue_links", {
      repoPath: REPO,
      numbers: [1, 2, 3, 4],
    });
  });

  it("warns in the header and in the saved HTML when the fetch hit the issue limit", async () => {
    // Only #1 and #2 are open: closed issues start hidden, so the modal does not
    // render a thousand boxes (that alone took ~5 s under load and timed out).
    const many = Array.from({ length: MAP_ISSUE_LIMIT }, (_, i) =>
      buildIssue({ number: i + 1, state: i < 2 ? "OPEN" : "CLOSED" }),
    );
    mockBackend({ issues: many });
    useGitHubStore.setState({ authStatus: { logged_in: true, username: "alice", scopes: [] } });
    vi.mocked(save).mockResolvedValue("C:/exports/map.html");
    renderModal();
    await screen.findByTestId("issue-node-2");
    const warning = `⚠ Showing the first ${MAP_ISSUE_LIMIT} issues, links beyond it are dropped.`;
    expect(screen.getByText(warning)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save HTML" }));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("export_issue_map", expect.anything()),
    );
    const call = mockedInvoke.mock.calls.find((c) => c[0] === "export_issue_map");
    expect((call?.[1] as { content: string }).content).toContain(
      `<div id="limit">${warning}</div>`,
    );
  });

  it("prints label chips on the box", async () => {
    renderModal();
    await screen.findByTestId("issue-node-2");
    const chips = screen.getAllByTestId("issue-chip-3").map((c) => c.textContent);
    expect(chips).toEqual(["needs-huma…", "bug"]);
    expect(screen.getAllByTestId("issue-chip-2").map((c) => c.textContent)).toEqual([
      "agent-read…",
    ]);
  });

  it("lists the data problems in a right-hand pane that starts open and toggles", async () => {
    renderModal();
    await screen.findByTestId("issue-node-2");
    // No legend, explanation lines or footer any more.
    expect(screen.queryByText(/An issue's level is 1 \+ the highest level/)).toBeNull();
    expect(screen.queryByTestId("issue-map-encoding")).toBeNull();
    expect(screen.queryByTestId("issue-map-hint")).toBeNull();
    expect(screen.queryByRole("contentinfo")).toBeNull();

    const toggle = screen.getByRole("button", { name: "2 data problems" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    // Open by default, so the user sees what is wrong without hunting for it.
    const problems = screen.getByRole("complementary", { name: "Data problems" });
    expect(problems).toHaveAttribute("data-testid", "issue-map-problems");
    expect(within(problems).getByText(/^Some "blocked by" links could not/)).toBeInTheDocument();
    expect(
      within(problems).getByText('#3 "Ship it": its two "blocked by" sources disagree'),
    ).toBeInTheDocument();
    expect(
      within(problems).getByText(
        '#3 "Ship it" is blocked by #4 "Epic: all of it", which is an epic: link dropped',
      ),
    ).toBeInTheDocument();
    expect(problems.textContent).toContain("Epics are containers, not work");
    expect(problems.textContent).toContain("Fix: On GitHub, make the section and the relation");

    fireEvent.click(toggle);
    expect(screen.queryByTestId("issue-map-problems")).toBeNull();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(screen.getByTestId("issue-map-problems")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide data problems" }));
    expect(screen.queryByTestId("issue-map-problems")).toBeNull();
  });

  it("says 'No data problems' and keeps the pane shut when every link was kept", async () => {
    mockBackend({ issues: ISSUES.slice(0, 2) });
    renderModal();
    await screen.findByTestId("issue-node-2");
    expect(screen.queryByTestId("issue-map-problems")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "No data problems" }));
    expect(screen.getByTestId("issue-map-problems")).toHaveTextContent(
      'No data problemsEvery "blocked by" link was drawn and no two sources disagree.',
    );
  });

  it("filter menus take a type off the map, re-pack the rest, and 'show all' restores", async () => {
    renderModal();
    await screen.findByTestId("issue-node-2");
    // Epics and closed start unticked, so those two menus show a partial count.
    expect(screen.getByRole("button", { name: /^Orion labels/ })).toHaveTextContent("4/5");
    expect(screen.getByRole("button", { name: /^Progress/ })).toHaveTextContent("3/4");
    expect(screen.getByRole("button", { name: /^Assignee/ })).toHaveTextContent("all");
    expect(screen.queryByLabelText("Closed")).toBeNull();
    openFilter("Progress");
    const closed = screen.getByLabelText("Closed");
    expect(closed).not.toBeChecked();
    expect(closed.parentElement?.textContent).toContain("0/1");
    // #1 is the only Level 0 issue, so with it hidden the column packs away.
    expect(screen.queryByTestId("issue-map-column-Level 0")).not.toBeInTheDocument();
    const xOf = (n: number) =>
      screen
        .getByTestId(`issue-node-${n}`)
        .getAttribute("transform")
        ?.match(/translate\(([\d.]+)/)?.[1];
    expect(xOf(2)).toBe("30");

    fireEvent.click(closed);
    expect(screen.getByTestId("issue-node-1")).toBeInTheDocument();
    expect(screen.getByTestId("issue-map-column-Level 0")).toBeInTheDocument();
    expect(xOf(1)).toBe("30");
    expect(xOf(2)).toBe("320");
    expect(screen.getByText(/Showing 3 of 4 issues/)).toBeInTheDocument();
    expect(closed.parentElement?.textContent).toContain("1/1");
    expect(screen.getByRole("button", { name: /^Progress/ })).toHaveTextContent("all");

    // Opening another menu closes the first.
    openFilter("Assignee");
    expect(screen.queryByLabelText("Closed")).toBeNull();
    fireEvent.click(screen.getByLabelText("👤 alice"));
    expect(screen.queryByTestId("issue-node-3")).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 2 of 4 issues/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "show all" }));
    expect(screen.getByText(/Showing 4 of 4 issues/)).toBeInTheDocument();
  });

  it("the Labels menu lists every label except the kind ones, new ones included", async () => {
    mockBackend({
      issues: [
        ...ISSUES.slice(0, 3),
        buildIssue({
          number: 5,
          title: "Brand new label",
          labels: [
            { name: "agent-ready", color: "0e8a16" },
            { name: "team:platform", color: "bfd4f2" },
          ],
        }),
      ],
    });
    renderModal();
    await screen.findByTestId("issue-node-2");
    openFilter("Labels");
    const menu = screen.getByRole("dialog", { name: "Labels filter" });
    const names = within(menu)
      .getAllByRole("checkbox")
      .map((c) => c.getAttribute("aria-label"));
    expect(names).toEqual(["bug", "team:platform", "no other label"]);
    // The GitHub colour sits next to the name.
    expect(
      within(menu).getByLabelText("team:platform").parentElement?.querySelector("i"),
    ).toHaveStyle({ background: "#bfd4f2" });
    expect(within(menu).getByText(/labels the team adds later show up here/)).toBeInTheDocument();

    // #3's only other label is bug, so unticking it hides #3; #2 has none, #5 keeps its own.
    fireEvent.click(within(menu).getByLabelText("bug"));
    expect(screen.queryByTestId("issue-node-3")).toBeNull();
    expect(screen.getByTestId("issue-node-2")).toBeInTheDocument();
    expect(screen.getByTestId("issue-node-5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Labels/ })).toHaveTextContent("2/3");

    // "only" keeps just that label; "no other label" covers #2.
    fireEvent.click(within(menu).getByRole("button", { name: "Only team:platform" }));
    expect(screen.getByTestId("issue-node-5")).toBeInTheDocument();
    expect(screen.queryByTestId("issue-node-2")).toBeNull();
    fireEvent.click(within(menu).getByLabelText("no other label"));
    expect(screen.getByTestId("issue-node-2")).toBeInTheDocument();

    // The search box narrows the list; None and All flip the family.
    fireEvent.change(within(menu).getByLabelText("Find labels"), { target: { value: "TEAM" } });
    expect(
      within(menu)
        .getAllByRole("checkbox")
        .map((c) => c.getAttribute("aria-label")),
    ).toEqual(["team:platform"]);
    fireEvent.click(within(menu).getByRole("button", { name: "None" }));
    expect(screen.getByText(/Showing 0 of 4 issues/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Labels/ })).toHaveTextContent("none");
    fireEvent.click(within(menu).getByRole("button", { name: "All" }));
    expect(screen.getByText(/Showing 3 of 4 issues/)).toBeInTheDocument();
  });

  it("colours the box by who takes it, crosses closed ones and shows one status icon", async () => {
    mockBackend({
      issues: [
        ...ISSUES,
        buildIssue({
          number: 5,
          title: "Outside",
          labels: [{ name: "outside-change", color: "0" }],
        }),
        buildIssue({ number: 6, title: "Undecided", labels: [{ name: "bug", color: "0" }] }),
      ],
    });
    renderModal();
    await screen.findByTestId("issue-node-2");
    fireEvent.click(screen.getByRole("button", { name: "show all" }));
    const n1 = screen.getByTestId("issue-node-1");
    const rect = (n: number) => screen.getByTestId(`issue-node-${n}`).querySelector("rect");
    const iconRun = (n: number) =>
      screen.getByTestId(`issue-node-${n}`).querySelector("text")?.textContent;

    // Background = kind, border neutral for every box, no dash patterns.
    expect(rect(1)).toHaveAttribute("fill", "rgb(var(--maestro-green) / 0.22)");
    expect(rect(2)).toHaveAttribute("fill", "rgb(var(--maestro-green) / 0.22)");
    expect(rect(3)).toHaveAttribute("fill", "rgb(var(--maestro-red) / 0.22)");
    expect(rect(5)).toHaveAttribute("fill", "rgb(var(--maestro-blue) / 0.22)");
    expect(rect(6)).toHaveAttribute("fill", "rgb(var(--maestro-yellow) / 0.22)");
    expect(rect(4)).toHaveAttribute("fill", "rgb(var(--maestro-purple) / 0.22)");
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(rect(n)).toHaveAttribute("stroke", "rgb(var(--maestro-border))");
      expect(rect(n)).not.toHaveAttribute("stroke-dasharray");
    }

    // Closed #1: two cross lines, no status icon; open boxes: one status icon, no cross.
    expect(n1.querySelectorAll("line")).toHaveLength(2);
    expect(iconRun(1)).toBe("#1 ");
    expect(screen.getByTestId("issue-node-2").querySelectorAll("line")).toHaveLength(0);
    expect(iconRun(2)).toBe("#2 \u{1F7E2}");
    expect(iconRun(3)).toBe("#3 \u{1F512}");
    expect(screen.getByRole("img", { name: "Issue map" }).textContent).not.toMatch(
      /\u{1F916}|\u{1F64B}|\u{1F3E2}|❓|✕|✔/u,
    );

    // No legend rows: the menus carry the swatches and icons instead.
    expect(
      screen.queryByText(/Background = who takes it|Icon = progress|Cross = closed/),
    ).toBeNull();
    openFilter("Orion labels");
    for (const label of [
      "agent-ready",
      "needs-human",
      "outside-change",
      "decision / planning",
      "epic",
    ]) {
      expect(screen.getByLabelText(label).parentElement?.querySelector("i")).not.toBeNull();
    }
    const agent = screen.getByLabelText("agent-ready");
    expect(agent.parentElement?.textContent).toContain("2/2");
    fireEvent.click(agent);
    expect(screen.queryByTestId("issue-node-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("issue-node-2")).not.toBeInTheDocument();
    expect(screen.getByTestId("issue-node-3")).toHaveAttribute("opacity", "1");
    expect(screen.getByText(/Showing 4 of 6 issues/)).toBeInTheDocument();
    expect(agent.parentElement?.textContent).toContain("0/2");
    openFilter("Progress");
    expect(screen.getByLabelText("\u{1F528} In progress")).toBeInTheDocument();
    expect(screen.getByLabelText("\u{1F7E2} Ready to take")).toBeInTheDocument();
    expect(screen.getByLabelText("Closed").parentElement?.querySelector("svg line")).not.toBeNull();
    // Visibility = status filter AND kind filter: hiding "blocked" too drops #3.
    fireEvent.click(screen.getByLabelText("\u{1F512} Blocked"));
    expect(screen.queryByTestId("issue-node-3")).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 3 of 6 issues/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "show all" }));

    // Tooltip chips: kind chip coloured, progress chip neutral; closed says "✕ Closed".
    fireEvent.click(screen.getByTestId("issue-node-3"), { clientX: 100, clientY: 100 });
    expect(screen.getByTestId("issue-map-tip-progress")).toHaveTextContent("\u{1F512} Blocked");
    expect(screen.getByTestId("issue-map-tip-progress")).not.toHaveAttribute("style");
    expect(screen.getByTestId("issue-map-tip-kind")).toHaveTextContent(/^needs-human$/);
    expect(screen.getByTestId("issue-map-tip-kind")).toHaveStyle({
      background: "rgb(var(--maestro-red) / 0.22)",
    });
    fireEvent.click(screen.getByTestId("issue-node-1"), { clientX: 100, clientY: 100 });
    expect(screen.getByTestId("issue-map-tip-progress")).toHaveTextContent("✕ Closed");
  });

  it("click focuses the chain and shows the tooltip; hover does nothing", async () => {
    renderModal();
    const n2 = await screen.findByTestId("issue-node-2");
    fireEvent.mouseEnter(n2, { clientX: 100, clientY: 100 });
    expect(screen.queryByTestId("issue-map-tip")).not.toBeInTheDocument();

    fireEvent.click(n2, { clientX: 100, clientY: 100 });
    const tip = screen.getByTestId("issue-map-tip");
    expect(within(tip).getByText("#2 Build the canvas")).toBeInTheDocument();
    expect(
      within(tip).getByText(/Level 1 · GitHub state: OPEN · nobody assigned/),
    ).toBeInTheDocument();
    expect(within(tip).getByText("#1 Scaffold (closed)")).toBeInTheDocument();
    expect(within(tip).getByText("#3")).toBeInTheDocument();
    // Labels as chips, the deciding one bold; the description as plain text.
    const labels = within(screen.getByTestId("issue-map-tip-labels")).getAllByText(/\S/, {
      selector: "span",
    });
    expect(labels.map((l) => [l.textContent, l.className.includes("font-bold")])).toEqual([
      ["agent-ready", true],
    ]);
    expect(screen.getByTestId("issue-map-tip-description")).toHaveTextContent(
      "Goal Draw the canvas with svg. Blocked by - #1",
    );
    expect(screen.getByTestId("issue-map-tip-description")).toHaveClass("max-h-40");
    expect(screen.getByTestId("issue-node-3")).toHaveAttribute("data-hl", "true");
    expect(
      within(tip).getByText(/Click the box again to clear · double-click opens it on GitHub/),
    ).toBeInTheDocument();

    fireEvent.click(n2);
    expect(screen.queryByTestId("issue-map-tip")).not.toBeInTheDocument();
    expect(screen.getByTestId("issue-node-3")).not.toHaveAttribute("data-hl");

    // An issue with several labels marks only the deciding one; it names its epic.
    fireEvent.click(screen.getByTestId("issue-node-3"), { clientX: 100, clientY: 100 });
    const chips = within(screen.getByTestId("issue-map-tip-labels")).getAllByText(/\S/, {
      selector: "span",
    });
    expect(chips.map((l) => [l.textContent, l.className.includes("font-bold")])).toEqual([
      ["needs-human-decision", true],
      ["bug", false],
    ]);
    expect(screen.getByTestId("issue-map-tip-description")).toHaveTextContent(
      "Blocked by - #2 - #4",
    );
    expect(screen.getByTestId("issue-map-tip-epic")).toHaveTextContent("Epic #4 Epic: all of it");
  });

  it("click pins, Esc unpins first and closes second", async () => {
    const { onClose } = renderModal();
    const n2 = await screen.findByTestId("issue-node-2");
    fireEvent.click(n2, { clientX: 100, clientY: 100 });
    expect(screen.getByTestId("issue-map-tip")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("issue-map-tip")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("F5 and Ctrl+R rebuild the map from GitHub", async () => {
    renderModal();
    await screen.findByTestId("issue-node-2");
    const listCalls = () =>
      mockedInvoke.mock.calls.filter(([cmd]) => cmd === "github_list_issues").length;
    const before = listCalls();

    const f5 = fireEvent.keyDown(window, { key: "F5", cancelable: true });
    expect(f5).toBe(false);
    await waitFor(() => expect(listCalls()).toBe(before + 1));
    await waitFor(() => expect(screen.getByRole("button", { name: /Reload/ })).toBeEnabled());

    fireEvent.keyDown(window, { key: "r", ctrlKey: true, cancelable: true });
    await waitFor(() => expect(listCalls()).toBe(before + 2));
  });

  it("Esc and a press outside close an open filter menu before anything else", async () => {
    const { onClose } = renderModal();
    const n2 = await screen.findByTestId("issue-node-2");
    fireEvent.click(n2, { clientX: 100, clientY: 100 });
    openFilter("Assignee");
    expect(screen.getByRole("dialog", { name: "Assignee filter" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Assignee filter" })).toBeNull();
    expect(screen.getByTestId("issue-map-tip")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    openFilter("Assignee");
    fireEvent.pointerDown(screen.getByTestId("issue-map-canvas"));
    expect(screen.queryByRole("dialog", { name: "Assignee filter" })).toBeNull();
  });

  it("drags the card by its title and keeps it there for the next issue and a map drag", async () => {
    renderModal();
    const n2 = await screen.findByTestId("issue-node-2");
    fireEvent.click(n2, { clientX: 100, clientY: 100 });
    const tip = screen.getByTestId("issue-map-tip");
    // happy-dom does no layout, so give the card the box a browser would.
    vi.spyOn(tip, "getBoundingClientRect").mockReturnValue({
      left: 116,
      top: 116,
      width: 480,
      height: 600,
    } as DOMRect);
    const viewport = screen.getByTestId("issue-map-viewport");
    const before = viewport.getAttribute("transform");

    const handle = screen.getByTestId("issue-map-tip-handle");
    fireEvent.pointerDown(handle, { button: 0, clientX: 120, clientY: 120 });
    fireEvent.pointerMove(window, { clientX: 420, clientY: 320 });
    fireEvent.pointerUp(window);
    expect(tip.style.left).toBe("416px");
    expect(tip.style.top).toBe("316px");
    // Moving the card does not pan the map.
    expect(viewport.getAttribute("transform")).toBe(before);

    // The next issue's card opens where the user put the last one.
    fireEvent.click(screen.getByTestId("issue-node-3"), { clientX: 700, clientY: 500 });
    expect(screen.getByTestId("issue-map-tip")).toHaveStyle({ left: "416px", top: "316px" });

    // A moved card stays up while the map is dragged.
    fireEvent.pointerDown(n2, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 30 });
    fireEvent.pointerUp(window);
    expect(screen.getByTestId("issue-map-tip")).toBeInTheDocument();

    // It cannot be dragged off screen.
    fireEvent.pointerDown(handle, { button: 0, clientX: 420, clientY: 320 });
    fireEvent.pointerMove(window, { clientX: 5000, clientY: -5000 });
    fireEvent.pointerUp(window);
    expect(tip.style.left).toBe(`${window.innerWidth - 60}px`);
    expect(tip.style.top).toBe("0px");
  });

  it("an epic sits in the Epics column, draws dashed lines to its stories and lists them", async () => {
    renderModal();
    await screen.findByTestId("issue-node-2");
    expect(screen.queryByTestId("issue-map-epic-edge-4-3")).not.toBeInTheDocument();
    openFilter("Orion labels");
    fireEvent.click(screen.getByLabelText("epic"));
    const epic = screen.getByTestId("issue-node-4");
    expect(epic).toHaveAttribute("data-level", "-1");
    expect(within(epic).getByText("0/1 stories closed")).toBeInTheDocument();
    const line = screen.getByTestId("issue-map-epic-edge-4-3");
    expect(line).toHaveAttribute("stroke-dasharray", "5 4");
    expect(line).toHaveAttribute("stroke", "rgb(var(--maestro-purple))");

    fireEvent.click(epic, { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("issue-map-tip-stories")).toHaveTextContent("Stories:");
    expect(
      within(screen.getByTestId("issue-map-tip")).getByText("#3 Ship it (open)"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("issue-map-tip")).getByText(/^Epics · GitHub/),
    ).toBeInTheDocument();
    expect(screen.getByTestId("issue-node-3")).toHaveAttribute("data-hl", "true");
    expect(line).toHaveAttribute("data-hl", "true");
  });

  it("zooms with the buttons and drags the map without pinning the box under the pointer", async () => {
    renderModal();
    const n2 = await screen.findByTestId("issue-node-2");
    const viewport = screen.getByTestId("issue-map-viewport");
    expect(screen.getByTestId("issue-map-zoom")).toHaveTextContent("100%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByTestId("issue-map-zoom")).toHaveTextContent("125%");
    expect(viewport.getAttribute("transform")).toContain("scale(1.25)");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByTestId("issue-map-zoom")).toHaveTextContent("100%");

    const canvas = screen.getByTestId("issue-map-canvas");
    fireEvent.pointerDown(n2, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 30 });
    fireEvent.pointerUp(window);
    expect(viewport.getAttribute("transform")).toMatch(/^translate\(50,30\)/);
    expect(canvas).toHaveClass("cursor-grab");
    // The click that ends the drag must not pin the box.
    fireEvent.click(n2, { clientX: 50, clientY: 30 });
    expect(screen.queryByTestId("issue-map-tip")).not.toBeInTheDocument();
    fireEvent.click(n2, { clientX: 50, clientY: 30 });
    expect(screen.getByTestId("issue-map-tip")).toBeInTheDocument();
  });

  it("double-click opens the issue on GitHub", async () => {
    renderModal();
    fireEvent.doubleClick(await screen.findByTestId("issue-node-3"));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/o/r/issues/3");
  });

  it("'Show in sidebar' selects the issue and keeps the map window open", async () => {
    const { onSelectIssue, onClose } = renderModal();
    fireEvent.click(await screen.findByTestId("issue-node-3"), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Show in sidebar" }));
    expect(onSelectIssue).toHaveBeenCalledWith(3);
    expect(onClose).not.toHaveBeenCalled();
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

  it("'Save HTML' writes a standalone file named by the save dialog", async () => {
    useGitHubStore.setState({
      authStatus: { logged_in: true, username: "alice", scopes: [] },
    });
    vi.mocked(save).mockResolvedValue("C:/exports/map.html");
    renderModal();
    await screen.findByTestId("issue-node-2");
    fireEvent.click(screen.getByRole("button", { name: "Save HTML" }));

    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith(
        "export_issue_map",
        expect.objectContaining({ path: "C:/exports/map.html" }),
      ),
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^issue-map-o-r-\d{4}-\d{2}-\d{2}\.html$/),
        filters: [{ name: "HTML", extensions: ["html"] }],
      }),
    );
    const call = mockedInvoke.mock.calls.find((c) => c[0] === "export_issue_map");
    const content = (call?.[1] as { content: string }).content;
    expect(content.startsWith("<!doctype html>")).toBe(true);
    expect(content).toContain(
      "Transient snapshot, not a source of truth. Generated by <b>alice</b> on <b>",
    );
    expect(content).toContain('data-id="3"');
    expect(content).toContain("Build the canvas");
    expect(content).not.toContain('id="limit"');
    // The login already in the store is used; no extra auth call.
    expect(mockedInvoke).not.toHaveBeenCalledWith("github_auth_status", expect.anything());
  });

  it("'Save HTML' asks GitHub for the login when the store has none, and reports failures", async () => {
    mockBackend({ failExport: true });
    vi.mocked(save).mockResolvedValue("C:/exports/map.html");
    renderModal();
    await screen.findByTestId("issue-node-2");
    fireEvent.click(screen.getByRole("button", { name: "Save HTML" }));

    expect(await screen.findByText("Save failed: disk full")).toBeInTheDocument();
    expect(mockedInvoke).toHaveBeenCalledWith("github_auth_status", { repoPath: REPO });
    const call = mockedInvoke.mock.calls.find((c) => c[0] === "export_issue_map");
    expect((call?.[1] as { content: string }).content).toContain(
      "Generated by <b>alice-from-gh</b>",
    );
  });

  it("'Save HTML' does nothing when the save dialog is cancelled", async () => {
    vi.mocked(save).mockResolvedValue(null);
    renderModal();
    await screen.findByTestId("issue-node-2");
    fireEvent.click(screen.getByRole("button", { name: "Save HTML" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(mockedInvoke).not.toHaveBeenCalledWith("export_issue_map", expect.anything());
  });
});
