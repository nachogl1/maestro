import { describe, expect, it } from "vitest";
import type { IssueInfo } from "@/stores/useGitHubStore";
import { buildIssueGraph, type IssueLinks, isEpic, parseBlockedBySection } from "../issueGraph";

function issue(number: number, overrides: Partial<IssueInfo> = {}): IssueInfo {
  return {
    number,
    title: `Issue ${number}`,
    state: "OPEN",
    author: { login: "nacho" },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    url: `https://github.com/x/y/issues/${number}`,
    labels: [],
    closedAt: null,
    assignees: [],
    ...overrides,
  };
}

function links(number: number, overrides: Partial<IssueLinks> = {}): IssueLinks {
  return {
    number,
    blockedBy: [],
    blocking: [],
    parent: null,
    subIssues: [],
    body: "",
    ...overrides,
  };
}

const EPIC = [{ name: "Epic", color: "5319e7" }];

describe("parseBlockedBySection", () => {
  it("reads every #N under the heading up to the next heading, any heading level", () => {
    const body = "Intro\n\n### Blocked by\n- #10 scaffold\n- [ ] #11\n\n### Notes\nsee #99 later";
    expect(parseBlockedBySection(body)).toEqual([10, 11]);
    expect(parseBlockedBySection("## Blocked by:\n#3, #4 and #3\n# Next\n#5")).toEqual([3, 4]);
  });

  it("reads CRLF bodies and a heading at the very end of the body", () => {
    expect(
      parseBlockedBySection("Intro\r\n\r\n### Blocked by\r\n- #1\r\n- #2\r\n\r\n## Next\r\n#3"),
    ).toEqual([1, 2]);
    expect(parseBlockedBySection("Intro\n### Blocked by")).toEqual([]);
    expect(parseBlockedBySection("Intro\r\n### Blocked by\r\n#7")).toEqual([7]);
  });

  it("reads issue links of the same repository, never of another one", () => {
    const body =
      "### Blocked by\n- [Backend](https://github.com/x/y/issues/305)\n" +
      "- https://github.com/x/other/issues/9\n- #4\n";
    expect(parseBlockedBySection(body, "https://github.com/x/y")).toEqual([305, 4]);
    expect(parseBlockedBySection(body)).toEqual([4]);
  });

  it("ignores prose references outside the section; null when there is no section", () => {
    expect(parseBlockedBySection("Blocked by #12 and #13.\nDepends on #14\nblocks #2")).toBeNull();
    expect(parseBlockedBySection("Part of epic #216")).toBeNull();
    expect(parseBlockedBySection("### Blocked by\nnothing yet\n")).toEqual([]);
  });
});

describe("isEpic", () => {
  it("matches the epic label exactly, case-insensitively", () => {
    expect(isEpic(EPIC)).toBe(true);
    expect(isEpic([{ name: "epic" }])).toBe(true);
    expect(isEpic([{ name: "epic-ish" }, { name: "bug" }])).toBe(false);
  });
});

describe("buildIssueGraph", () => {
  it("keeps every non-epic issue, open or closed, and drops epics entirely", () => {
    const graph = buildIssueGraph(
      [issue(3, { state: "CLOSED" }), issue(1), issue(2, { labels: EPIC })],
      {},
    );
    expect(graph.nodes.map((n) => n.number)).toEqual([1, 3]);
    expect(graph.edges).toEqual([]);
    expect(graph.problems).toEqual([]);
  });

  it("unions the native blockedBy relation with the '### Blocked by' section", () => {
    const graph = buildIssueGraph([issue(1), issue(2), issue(3)], {
      3: links(3, { blockedBy: [1], body: "### Blocked by\n- #1\n- #2\n" }),
    });
    expect(graph.edges).toEqual([
      { id: "1->3", source: 1, target: 3 },
      { id: "2->3", source: 2, target: 3 },
    ]);
    expect(graph.problems).toEqual([
      { kind: "disagreement", number: 3, sectionOnly: [2], nativeOnly: [] },
    ]);
  });

  it("ignores blocking, parent and sub-issues as links; parent only fills the epic tag", () => {
    const graph = buildIssueGraph([issue(1), issue(2), issue(4)], {
      1: links(1, { blocking: [2], subIssues: [4], body: "blocks #2\ndepends on #4" }),
      2: links(2, { parent: 9 }),
      4: links(4, { parent: 1 }),
    });
    expect(graph.edges).toEqual([]);
    expect(graph.nodes.find((n) => n.number === 2)?.epic).toBe(9);
    expect(graph.nodes.find((n) => n.number === 4)?.epic).toBe(1);
    expect(graph.nodes.find((n) => n.number === 1)?.epic).toBeNull();
  });

  it("drops links to epics and to issues that were not loaded, reporting each", () => {
    const graph = buildIssueGraph([issue(5), issue(7, { labels: EPIC })], {
      5: links(5, { blockedBy: [7, 99], body: "### Blocked by\n#7 #99" }),
    });
    expect(graph.edges).toEqual([]);
    expect(graph.problems).toEqual([
      { kind: "epic", blocked: 5, blocker: 7 },
      { kind: "not-loaded", blocked: 5, blocker: 99 },
    ]);
  });

  it("keeps section links and detects disagreements in a CRLF body", () => {
    const graph = buildIssueGraph([issue(1), issue(2), issue(3)], {
      3: links(3, { blockedBy: [1], body: "### Blocked by\r\n- #2\r\n" }),
    });
    expect(graph.edges.map((e) => e.id)).toEqual(["1->3", "2->3"]);
    expect(graph.problems).toEqual([
      { kind: "disagreement", number: 3, sectionOnly: [2], nativeOnly: [1] },
    ]);
  });

  it("does not call a section of same-repo issue links a disagreement", () => {
    const graph = buildIssueGraph([issue(305), issue(306)], {
      306: links(306, {
        blockedBy: [305],
        body: "### Blocked by\n- [Backend](https://github.com/x/y/issues/305)\n\n## Done means\n",
      }),
    });
    expect(graph.edges.map((e) => e.id)).toEqual(["305->306"]);
    expect(graph.problems).toEqual([]);
  });

  it("does not call a native-only link a disagreement when the body has no section", () => {
    const graph = buildIssueGraph([issue(1), issue(2)], {
      2: links(2, { blockedBy: [1], body: "Blocked by #1 in prose only" }),
    });
    expect(graph.edges.map((e) => e.id)).toEqual(["1->2"]);
    expect(graph.problems).toEqual([]);
  });

  it("reports both directions of a disagreement, sorted", () => {
    const graph = buildIssueGraph([issue(1), issue(2), issue(3), issue(4)], {
      4: links(4, { blockedBy: [3, 1], body: "### Blocked by\n#2 #1" }),
    });
    expect(graph.problems).toEqual([
      { kind: "disagreement", number: 4, sectionOnly: [2], nativeOnly: [3] },
    ]);
    expect(graph.edges.map((e) => e.id)).toEqual(["1->4", "2->4", "3->4"]);
  });

  it("drops exactly one deterministic back edge per cycle and reports it", () => {
    const build = () =>
      buildIssueGraph([issue(1), issue(2), issue(3)], {
        1: links(1, { blockedBy: [3] }),
        2: links(2, { blockedBy: [1] }),
        3: links(3, { blockedBy: [2] }),
      });
    const graph = build();
    expect(graph.edges).toHaveLength(2);
    const cycles = graph.problems.filter((p) => p.kind === "cycle");
    expect(cycles).toEqual([{ kind: "cycle", blocked: 1, blocker: 3 }]);
    expect(build()).toEqual(graph);
  });

  it("ignores self references and carries body, labels and assignees onto nodes", () => {
    const graph = buildIssueGraph(
      [issue(5, { assignees: [{ login: "ana" }], labels: [{ name: "bug", color: "ff0000" }] })],
      { 5: links(5, { blockedBy: [5], body: "### Blocked by\n#5\n\nText" }) },
    );
    expect(graph.edges).toEqual([]);
    expect(graph.problems).toEqual([]);
    expect(graph.nodes[0]).toMatchObject({
      assignees: [{ login: "ana" }],
      labels: [{ name: "bug", color: "ff0000" }],
      body: "### Blocked by\n#5\n\nText",
    });
  });

  it("survives issues with no link entry", () => {
    const graph = buildIssueGraph([issue(1)], {});
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({ epic: null, body: "" });
    expect(graph.edges).toEqual([]);
  });
});
