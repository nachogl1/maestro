import { describe, expect, it } from "vitest";
import type { IssueInfo } from "@/stores/useGitHubStore";
import type { IssueLinks } from "../issueGraph";
import {
  buildIssueMap,
  descriptionText,
  ENCODING_EXPLANATION,
  edgePath,
  explainProblem,
  isKindLabel,
  KIND_FILL,
  KIND_META,
  KIND_ORDER,
  kindOf,
  labelChips,
  MAP_COL_W,
  MAP_NODE_H,
  MAP_NODE_W,
  MAP_ROW_H,
  MAP_X0,
  MAP_Y0,
  nodeText,
  packIssueMap,
  problemText,
  STATUS_META,
  statusIcon,
  titleLookup,
  walk,
} from "../issueMap";

function issue(overrides: Partial<IssueInfo> & { number: number }): IssueInfo {
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

function link(overrides: Partial<IssueLinks> & { number: number }): IssueLinks {
  return { blockedBy: [], blocking: [], parent: null, subIssues: [], body: "", ...overrides };
}

const AGENT = [{ name: "agent-ready", color: "0e8a16" }];
const HUMAN = [{ name: "needs-human-decision", color: "d93f0b" }];
const EPIC = [{ name: "epic", color: "5319e7" }];
const DECISION = [{ name: "decision", color: "cccccc" }];

describe("kindOf", () => {
  it("maps triage labels with outside > human > agent precedence and names the deciding label", () => {
    expect(kindOf(AGENT)).toEqual({ kind: "agent", label: "agent-ready" });
    expect(kindOf(HUMAN)).toEqual({ kind: "human", label: "needs-human-decision" });
    expect(kindOf([{ name: "Needs-Human" }])).toEqual({ kind: "human", label: "Needs-Human" });
    expect(kindOf([{ name: "human-needed" }]).kind).toBe("human");
    expect(kindOf([{ name: "outside-change" }]).kind).toBe("outside");
    expect(kindOf([{ name: "agent-ready" }, { name: "outside-change" }]).kind).toBe("outside");
    expect(kindOf([{ name: "needs-human" }, { name: "outside-change" }]).kind).toBe("outside");
    expect(kindOf([{ name: "agent-ready" }, { name: "needs-human-decision" }]).kind).toBe("human");
  });

  it("falls back to decision / planning for anything else; there is no 'other' kind", () => {
    expect(kindOf([{ name: "bug" }])).toEqual({ kind: "decision", label: null });
    expect(kindOf([])).toEqual({ kind: "decision", label: null });
    expect(kindOf(DECISION)).toEqual({ kind: "decision", label: null });
    expect(KIND_ORDER).toEqual(["agent", "human", "outside", "decision", "epic"]);
  });

  it("an `epic` label wins over every triage label", () => {
    expect(kindOf(EPIC)).toEqual({ kind: "epic", label: "epic" });
    expect(kindOf([...AGENT, { name: "Epic" }])).toEqual({ kind: "epic", label: "Epic" });
  });
});

describe("isKindLabel", () => {
  it("is true only for the labels that decide who takes an issue", () => {
    for (const name of ["agent-ready", "needs-human-decision", "outside-change", "Epic"]) {
      expect(isKindLabel(name)).toBe(true);
    }
    for (const name of ["bug", "team:platform", "decision", "wayfinder:map"]) {
      expect(isKindLabel(name)).toBe(false);
    }
  });
});

describe("buildIssueMap", () => {
  // 1 (closed) → 2 → 3; 3 also waits on 4 (closed, 'decision' label) and on
  // epic 9 (dropped); 5 is closed and unlinked; 6 open, unlinked, assigned;
  // 8 is blocked by #77 which is not loaded.
  const issues = [
    issue({ number: 1, state: "CLOSED", labels: AGENT, title: "Scaffold" }),
    issue({
      number: 2,
      labels: [...AGENT, { name: "bug", color: "ff0000" }, { name: "ui", color: "00ff00" }],
      title: "Second step with a very long title indeed",
    }),
    issue({ number: 3, labels: HUMAN, assignees: [{ login: "bob" }] }),
    issue({ number: 4, state: "CLOSED", labels: DECISION, title: "Decide the shape" }),
    issue({ number: 5, state: "CLOSED" }),
    issue({ number: 6, labels: AGENT, assignees: [{ login: "ann" }] }),
    issue({ number: 8 }),
    issue({ number: 9, labels: EPIC, title: "Epic: everything" }),
  ];
  const links = {
    1: link({ number: 1 }),
    2: link({ number: 2, blockedBy: [1], parent: 9, body: "### Blocked by\n- #1\n" }),
    3: link({ number: 3, body: "### Blocked by\n- #2\n- #4\n- #9\n" }),
    4: link({ number: 4 }),
    5: link({ number: 5 }),
    6: link({ number: 6, body: "# Title\n\nSome **bold** `code` and a [link](http://x).\n" }),
    8: link({ number: 8, blockedBy: [77] }),
    9: link({ number: 9, subIssues: [2] }),
  };
  const map = buildIssueMap(issues, links);
  const node = (n: number) => map.nodes.find((x) => x.number === n);

  it("draws every issue, closed included, with the epic in its own far-left column", () => {
    expect(map.nodes.map((n) => n.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 8, 9]);
    expect(node(9)).toMatchObject({ kind: "epic", level: -1, status: "ready", blockers: [] });
    expect(node(9)?.stories).toEqual([
      { number: 2, title: "Second step with a very long title indeed", state: "OPEN" },
    ]);
    expect(node(2)?.parent).toBe(9);
    expect(node(3)?.parent).toBeNull();
    expect(map.epicEdges.map((e) => [e.from, e.to, e.open])).toEqual([[9, 2, true]]);
    expect(map.epicEdges[0].path).toBe(edgePath(node(9) as never, node(2) as never));
    // The epic never blocks: it stays out of up/down and of every level.
    expect(map.up[9]).toBeUndefined();
    expect(walk(2, map.up)).toEqual(new Set([1]));
  });

  it("ties a story to its epic from either side of the sub-issue link", () => {
    const viaParent = buildIssueMap([issue({ number: 1, labels: EPIC }), issue({ number: 2 })], {
      2: link({ number: 2, parent: 1 }),
    });
    expect(viaParent.epicEdges.map((e) => [e.from, e.to])).toEqual([[1, 2]]);
    expect(nodeText(viaParent.nodes[0])).toMatchObject({
      tag: "epic",
      assignees: "0/1 stories closed",
    });
  });

  it("derives status from state, open kept blockers and assignees", () => {
    expect(node(1)?.status).toBe("closed");
    expect(node(2)?.status).toBe("ready"); // blocker #1 is closed, nobody on it
    expect(node(3)?.status).toBe("blocked"); // #2 still open (the epic does not count)
    expect(node(4)?.status).toBe("closed");
    expect(node(6)?.status).toBe("inprog");
    expect(node(8)?.status).toBe("ready"); // its only blocker was not loaded
  });

  it("levels: 1 + the highest blocker level; closed and decision blockers count too", () => {
    expect(node(1)?.level).toBe(0);
    expect(node(2)?.level).toBe(1); // blocked by closed #1
    expect(node(3)?.level).toBe(2); // #2 is level 1, #4 (closed, decision) is level 0
    expect(node(4)?.level).toBe(0);
    expect(node(5)?.level).toBe(0); // closed, unlinked: Level 0 like everything else
    expect(node(8)?.level).toBe(0); // dropped link does not count
    expect(map.columns.map((c) => c.label)).toEqual(["Epics", "Level 0", "Level 1", "Level 2"]);
    expect(map.columns[0]).toMatchObject({ closed: 0, total: 1, members: [9] });
    expect(map.columns[1]).toMatchObject({ closed: 3, total: 5 });
  });

  it("orders a column open first by number, then closed by number, centred on the tallest", () => {
    const column0 = map.nodes
      .filter((n) => n.level === 0)
      .sort((a, b) => a.y - b.y)
      .map((n) => n.number);
    expect(column0).toEqual([6, 8, 1, 4, 5]);
    expect(map.columns[1].members).toEqual([6, 8, 1, 4, 5]);
    expect(node(9)).toMatchObject({ x: MAP_X0, y: MAP_Y0 + 2 * MAP_ROW_H });
    expect(node(6)).toMatchObject({ x: MAP_X0 + MAP_COL_W, y: MAP_Y0 });
    expect(node(1)?.y).toBe(MAP_Y0 + 2 * MAP_ROW_H);
    // A one-issue column sits level with the middle row of the five-issue one.
    expect(node(2)).toMatchObject({ x: MAP_X0 + 2 * MAP_COL_W, y: MAP_Y0 + 2 * MAP_ROW_H });
    expect(map.width).toBe(4 * MAP_COL_W - 10);
    expect(map.height).toBe(MAP_Y0 + 5 * MAP_ROW_H + 30);
  });

  it("re-packs the shown issues: hidden ones and empty columns leave the map", () => {
    const open = new Set(
      map.nodes.filter((n) => n.state === "OPEN" && n.kind !== "epic").map((n) => n.number),
    );
    const packed = packIssueMap(map, open);
    expect(packed.columns.map((c) => [c.label, c.index, c.x])).toEqual([
      ["Level 0", 0, MAP_X0],
      ["Level 1", 1, MAP_X0 + MAP_COL_W],
      ["Level 2", 2, MAP_X0 + 2 * MAP_COL_W],
    ]);
    // The column keeps its whole-column count, whatever is filtered out.
    expect(packed.columns[0]).toMatchObject({ closed: 3, total: 5 });
    expect(packed.positions.get(6)).toEqual({ x: MAP_X0, y: MAP_Y0 });
    expect(packed.positions.get(8)).toEqual({ x: MAP_X0, y: MAP_Y0 + MAP_ROW_H });
    expect(packed.positions.get(2)).toEqual({ x: MAP_X0 + MAP_COL_W, y: MAP_Y0 + MAP_ROW_H / 2 });
    expect(packed.positions.has(1)).toBe(false);
    expect(packed.positions.has(9)).toBe(false);
    // Only lines whose two ends are shown get a path.
    expect([...packed.paths.keys()]).toEqual(["2->3"]);
    expect(packed.width).toBe(3 * MAP_COL_W - 10);
    expect(packed.height).toBe(MAP_Y0 + 2 * MAP_ROW_H + 30);
    expect(packIssueMap(map, new Set()).columns).toEqual([]);
  });

  it("draws one line per kept link, red while the blocker is open", () => {
    expect(map.edges.map((e) => [e.from, e.to, e.open])).toEqual([
      [1, 2, false],
      [2, 3, true],
      [4, 3, false],
    ]);
    expect(map.edges[0].path).toBe(edgePath(node(1) as never, node(2) as never));
    expect(MAP_NODE_H).toBeLessThan(MAP_ROW_H);
    expect(MAP_NODE_W).toBeLessThan(MAP_COL_W);
  });

  it("fills blockers, waiting, epic tag, labels, body and up/down", () => {
    expect(node(3)?.blockers).toEqual([
      { number: 2, title: "Second step with a very long title indeed", state: "OPEN" },
      { number: 4, title: "Decide the shape", state: "CLOSED" },
    ]);
    expect(node(2)?.waiting).toEqual([3]);
    expect(node(2)?.epic).toBe(9);
    expect(node(2)?.labels).toEqual(["agent-ready", "bug", "ui"]);
    expect(node(2)?.kindLabel).toBe("agent-ready");
    expect(node(8)?.kindLabel).toBeNull();
    expect(node(6)?.body).toBe(links[6].body);
    expect(node(8)?.blockers).toEqual([]);
    expect(walk(3, map.up)).toEqual(new Set([1, 2, 4]));
    expect(walk(1, map.down)).toEqual(new Set([2, 3]));
  });

  it("lists the dropped links and the disagreement as footer problems", () => {
    expect(map.problems.map((p) => problemText(p))).toEqual([
      '#3: its two "blocked by" sources disagree',
      "#3 is blocked by #9, which is an epic: link dropped",
      "#8 is blocked by #77, which is not on the map: link dropped",
    ]);
    const disagree = buildIssueMap([issue({ number: 1 }), issue({ number: 2 })], {
      2: link({ number: 2, blockedBy: [1], body: "### Blocked by\n#1 #5" }),
    });
    expect(disagree.problems.map((p) => problemText(p))).toEqual([
      '#2: its two "blocked by" sources disagree',
      "#2 is blocked by #5, which is not on the map: link dropped",
    ]);
    expect(
      problemText({ kind: "disagreement", number: 7, sectionOnly: [1, 2], nativeOnly: [3] }),
    ).toBe('#7: its two "blocked by" sources disagree');
    expect(problemText({ kind: "cycle", blocked: 1, blocker: 3 })).toBe(
      "#1 is blocked by #3, which closes a loop: link dropped",
    );
  });

  it("explains each problem with titles, what it changes on the map and how to fix it", () => {
    const titleOf = titleLookup(map.nodes);
    const [disagreement, epic, notLoaded] = map.problems.map((p) => explainProblem(p, titleOf));
    expect(disagreement.headline).toBe('#3 "Issue 3": its two "blocked by" sources disagree');
    expect(disagreement.effect).toContain(
      `the "### Blocked by" section in the body of #3 "Issue 3" names #2 "Second step with a very long title indeed", #4 "Decide the shape", #9 "Epic: everything" but GitHub's own blocked-by relation does not`,
    );
    expect(disagreement.effect).toContain("The map keeps every blocker from either source");
    expect(disagreement.fix).toContain("make the section and the relation name the same blockers");

    expect(epic.headline).toBe(
      '#3 "Issue 3" is blocked by #9 "Epic: everything", which is an epic: link dropped',
    );
    expect(epic.effect).toContain("Epics are containers, not work");
    expect(epic.fix).toContain('block #3 "Issue 3" by the concrete issue inside the epic');

    expect(notLoaded.headline).toBe(
      '#8 "Issue 8" is blocked by #77, which is not on the map: link dropped',
    );
    expect(notLoaded.effect).toContain("#77 is not among the issues the map loaded");
    expect(notLoaded.effect).toContain("1000-issue load limit");
    expect(notLoaded.fix).toContain("Open #77 on GitHub");

    const both = explainProblem({
      kind: "disagreement",
      number: 7,
      sectionOnly: [1],
      nativeOnly: [3],
    });
    expect(both.effect).toContain(
      "names #1 but GitHub's own blocked-by relation does not, and the relation names #3 but the section does not",
    );
    const nativeOnly = explainProblem({
      kind: "disagreement",
      number: 7,
      sectionOnly: [],
      nativeOnly: [3],
    });
    expect(nativeOnly.effect).toContain("GitHub's own blocked-by relation of #7 names #3 but the");

    const cycle = explainProblem({ kind: "cycle", blocked: 1, blocker: 3 }, titleOf);
    expect(cycle.effect).toContain("leads back to #1");
    expect(cycle.fix).toContain("remove the link that points the wrong way");
  });

  it("drops the edge that closes a cycle and still levels the rest", () => {
    const cyc = buildIssueMap([issue({ number: 1 }), issue({ number: 2 })], {
      1: link({ number: 1, blockedBy: [2] }),
      2: link({ number: 2, blockedBy: [1] }),
    });
    expect(cyc.edges).toHaveLength(1);
    expect(cyc.problems).toEqual([{ kind: "cycle", blocked: 1, blocker: 2 }]);
    expect(cyc.nodes.map((n) => [n.number, n.level])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it("prints the box text: status icon, epic tag, truncated title, assignees, label chips", () => {
    const text = nodeText(node(2) as never);
    expect(text).toMatchObject({
      icons: "\u{1F7E2}",
      tag: "epic #9",
      title: "Second step with a very long t…",
      assignees: "",
    });
    expect(text.chips.map((c) => c.text)).toEqual(["agent-read…", "bug", "ui"]);
    expect(text.chips[1].x).toBeGreaterThan(text.chips[0].x + text.chips[0].w);
    expect(nodeText(node(3) as never).assignees).toBe("\u{1F464} bob");
    expect(nodeText(node(5) as never).chips).toEqual([]);
  });

  it("shows exactly one status icon on an open box and none on a closed one", () => {
    expect(statusIcon(node(2) as never)).toBe("\u{1F7E2}"); // ready
    expect(statusIcon(node(3) as never)).toBe("\u{1F512}"); // blocked
    expect(statusIcon(node(6) as never)).toBe("\u{1F528}"); // in progress
    expect(statusIcon(node(1) as never)).toBe(""); // closed: the cross says it
    expect(nodeText(node(4) as never).icons).toBe("");
    // The closed icon exists for the legend and tooltip only, never for the box.
    expect(STATUS_META.closed.icon).toBe("✕");
    // No kind icon anywhere: colour carries the kind.
    for (const kind of KIND_ORDER) expect(KIND_META[kind]).not.toHaveProperty("icon");
    for (const n of map.nodes)
      expect(nodeText(n).icons).not.toMatch(/\u{1F916}|\u{1F64B}|\u{1F3E2}|❓/u);
  });

  it("colours the background by kind: green agent, red human, blue outside, yellow decision, purple epic", () => {
    expect(KIND_FILL).toEqual({
      agent: "green",
      human: "red",
      outside: "blue",
      decision: "yellow",
      epic: "purple",
    });
    expect(KIND_FILL[(node(9) as never as { kind: "epic" }).kind]).toBe("purple");
    expect(KIND_FILL[(node(1) as never as { kind: "agent" }).kind]).toBe("green");
    expect(KIND_FILL[(node(3) as never as { kind: "human" }).kind]).toBe("red");
    expect(KIND_FILL[(node(4) as never as { kind: "decision" }).kind]).toBe("yellow");
    expect(KIND_FILL[kindOf([{ name: "outside-change" }]).kind]).toBe("blue");
    expect(ENCODING_EXPLANATION).toBe(
      "Background = who takes it (green agent-ready, red needs-human, blue outside-change, " +
        "yellow anything else, purple epic). Icon = progress (\u{1F528} in progress, \u{1F7E2} ready, " +
        "\u{1F512} blocked). A cross means closed.",
    );
  });
});

describe("labelChips", () => {
  it("shows at most three chips, then a +N chip, all inside the box", () => {
    const chips = labelChips(["a", "b", "c", "d", "e"]);
    expect(chips.map((c) => c.text)).toEqual(["a", "b", "c", "+2"]);
    const last = chips[chips.length - 1];
    expect(last.x + last.w).toBeLessThanOrEqual(MAP_NODE_W - 20);
  });

  it("stops early when a long chip would not fit and counts the rest", () => {
    const chips = labelChips(["very-long-label", "another-long", "third-long-one", "x"]);
    const last = chips[chips.length - 1];
    expect(last.text).toMatch(/^\+\d$/);
    expect(last.x + last.w).toBeLessThanOrEqual(MAP_NODE_W - 20);
    const shown = chips.length - 1;
    expect(last.text).toBe(`+${4 - shown}`);
  });
});

describe("descriptionText", () => {
  it("strips headings, emphasis, backticks, link syntax and comments, keeps the text", () => {
    expect(
      descriptionText(
        "<!-- template -->\n# Title\n\n\n\nSome **bold** `code` and a [link](http://x).\n\n### Blocked by\n- #1",
      ),
    ).toBe("Title\n\nSome bold code and a link.\n\nBlocked by\n- #1");
  });

  it("cuts at 600 characters with an ellipsis and returns '' for an empty body", () => {
    const long = "x".repeat(700);
    expect(descriptionText(long)).toHaveLength(601);
    expect(descriptionText(long).endsWith("…")).toBe(true);
    expect(descriptionText("")).toBe("");
  });
});
