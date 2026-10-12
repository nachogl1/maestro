import { describe, expect, it } from "vitest";
import type { IssueInfo } from "@/stores/useGitHubStore";
import type { IssueLinks } from "../issueGraph";
import { parseTextRefs } from "../issueGraph";
import {
  buildIssueMap,
  edgePath,
  kindOf,
  MAP_COL_W,
  MAP_X0,
  MAP_Y0,
  nodeText,
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

describe("kindOf", () => {
  it("maps triage labels, with decision > human > outside > agent precedence", () => {
    expect(kindOf(AGENT)).toBe("agent");
    expect(kindOf(HUMAN)).toBe("human");
    expect(kindOf([{ name: "outside-change" }])).toBe("outside");
    expect(kindOf(EPIC)).toBe("decision");
    expect(kindOf([{ name: "agent-ready" }, { name: "outside-change" }])).toBe("outside");
    expect(kindOf([{ name: "agent-ready" }, { name: "needs-human-decision" }])).toBe("human");
    expect(kindOf([{ name: "bug" }])).toBe("other");
  });
});

describe("parseTextRefs: '### Blocked by' section", () => {
  it("reads every #N under the heading up to the next heading", () => {
    const body = "Intro\n\n### Blocked by\n- #10 scaffold\n- [ ] #11\n\n### Notes\nsee #99 later";
    expect(parseTextRefs(body, 20)).toEqual([
      { kind: "blocks", source: 10, target: 20 },
      { kind: "blocks", source: 11, target: 20 },
    ]);
  });
});

describe("buildIssueMap", () => {
  // 1 (closed scaffold) → 2 → 3; 4 is an open epic that 3 also waits on;
  // 5 is closed and isolated (already done); 6 open, unlinked, assigned.
  const issues = [
    issue({ number: 1, state: "CLOSED", labels: AGENT, title: "Scaffold" }),
    issue({ number: 2, labels: AGENT, title: "Second step with a very long title indeed" }),
    issue({ number: 3, labels: HUMAN, assignees: [{ login: "bob" }] }),
    issue({ number: 4, labels: EPIC, title: "Epic: shape" }),
    issue({ number: 5, state: "CLOSED" }),
    issue({ number: 6, labels: AGENT, assignees: [{ login: "ann" }] }),
  ];
  const links = {
    1: link({ number: 1 }),
    2: link({ number: 2, blockedBy: [1], parent: 4 }),
    3: link({ number: 3, body: "### Blocked by\n- #2\n- #4\n" }),
    4: link({ number: 4, subIssues: [2] }),
    5: link({ number: 5 }),
    6: link({ number: 6 }),
  };
  const map = buildIssueMap(issues, links);
  const node = (n: number) => map.nodes.find((x) => x.number === n);

  it("derives status from state, open blockers and assignees", () => {
    expect(node(1)?.status).toBe("closed");
    expect(node(2)?.status).toBe("ready"); // blocker #1 is closed, nobody on it
    expect(node(3)?.status).toBe("blocked"); // #2 and #4 still open
    expect(node(4)?.status).toBe("ready");
    expect(node(6)?.status).toBe("inprog");
  });

  it("puts issues in waves by the longest chain of story blockers", () => {
    expect(node(1)?.wave).toBe("Foundation");
    expect(node(2)?.wave).toBe("Wave 1");
    expect(node(3)?.wave).toBe("Wave 2");
    // An epic blocker never moves a story; the epic itself sits in Foundation.
    expect(node(4)?.wave).toBe("Foundation");
    expect(node(6)?.wave).toBe("Foundation");
    // Closed and isolated → already done pile.
    expect(node(5)?.wave).toBe("Already done · 1 of 1");
    expect(map.columns.map((c) => c.label)).toEqual([
      "Already done · 1 of 1",
      "Foundation",
      "Wave 1",
      "Wave 2",
    ]);
    expect(map.columns[1]).toMatchObject({ closed: 1, total: 3 });
  });

  it("lays columns left to right and rows top to bottom", () => {
    expect(node(5)).toMatchObject({ x: MAP_X0, y: MAP_Y0 });
    expect(node(1)).toMatchObject({ x: MAP_X0 + MAP_COL_W, y: MAP_Y0 });
    expect(node(4)?.y).toBeGreaterThan(node(1)?.y ?? 0);
    expect(map.width).toBe(4 * MAP_COL_W - 10);
  });

  it("draws one line per blocked-by link, red while the blocker is open", () => {
    expect(map.edges.map((e) => [e.from, e.to, e.open])).toEqual([
      [1, 2, false],
      [2, 3, true],
      [4, 3, true],
    ]);
    const first = map.edges[0];
    expect(first.path).toBe(edgePath(node(1) as never, node(2) as never));
  });

  it("fills blockers, waiting, epic and up/down for the tooltip and focus", () => {
    expect(node(3)?.blockers).toEqual([
      { number: 2, title: "Second step with a very long title indeed", state: "OPEN" },
      { number: 4, title: "Epic: shape", state: "OPEN" },
    ]);
    expect(node(2)?.waiting).toEqual([3]);
    expect(node(2)?.epic).toBe(4);
    expect(walk(3, map.up)).toEqual(new Set([1, 2, 4]));
    expect(walk(1, map.down)).toEqual(new Set([2, 3]));
  });

  it("prints the box text: icons, epic tag, truncated title, assignees", () => {
    expect(nodeText(node(2) as never)).toEqual({
      icons: "\u{1F7E2}\u{1F916}",
      tag: "epic #4",
      title: "Second step with a very long t…",
      assignees: "",
    });
    expect(nodeText(node(3) as never).assignees).toBe("\u{1F464} bob");
  });

  it("lists an unfetched blocker as unknown without blocking the issue", () => {
    const partial = buildIssueMap([issue({ number: 7 })], {
      7: link({ number: 7, blockedBy: [99] }),
    });
    expect(partial.nodes[0].status).toBe("ready");
    expect(partial.nodes[0].blockers).toEqual([
      { number: 99, title: "not loaded", state: "UNKNOWN" },
    ]);
    expect(partial.edges).toEqual([]);
  });
});
