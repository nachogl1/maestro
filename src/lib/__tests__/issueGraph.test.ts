import { describe, expect, it } from "vitest";
import type { IssueInfo } from "@/stores/useGitHubStore";
import {
  buildIssueGraph,
  ISSUE_NODE_W,
  type IssueLinks,
  layoutIssueGraph,
  parseTextRefs,
} from "../issueGraph";

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

describe("parseTextRefs", () => {
  it("reads blocked-by and depends-on as incoming blocks edges", () => {
    expect(parseTextRefs("Blocked by #12 and #13.\nDepends on #14", 7)).toEqual([
      { kind: "blocks", source: 12, target: 7 },
      { kind: "blocks", source: 13, target: 7 },
      { kind: "blocks", source: 14, target: 7 },
    ]);
  });

  it("reads blocks as an outgoing edge and part-of-epic as a parent edge", () => {
    expect(parseTextRefs("Blocks #3, #4\nPart of epic #216", 7)).toEqual([
      { kind: "blocks", source: 7, target: 3 },
      { kind: "blocks", source: 7, target: 4 },
      { kind: "parent", source: 216, target: 7 },
    ]);
  });

  it("accepts bare 'epic #N' and 'Epic: #N' but not a reference after a parenthesis", () => {
    expect(parseTextRefs("epic #136", 7)).toEqual([{ kind: "parent", source: 136, target: 7 }]);
    expect(parseTextRefs("Epic: #136", 7)).toEqual([{ kind: "parent", source: 136, target: 7 }]);
    expect(parseTextRefs("(see the epic). The #103 change", 7)).toEqual([]);
  });

  it("ignores self references and duplicates", () => {
    expect(parseTextRefs("blocked by #7 blocked by #8 blocked by #8", 7)).toEqual([
      { kind: "blocks", source: 8, target: 7 },
    ]);
  });
});

describe("buildIssueGraph", () => {
  it("builds native edges, dedupes mirrored links, and adds stub nodes", () => {
    const graph = buildIssueGraph([issue(208), issue(210)], {
      208: links(208, { blocking: [210, 211], parent: 216 }),
      210: links(210, { blockedBy: [208] }),
    });
    expect(graph.edges.map((e) => e.id).sort()).toEqual([
      "blocks:208->210",
      "blocks:208->211",
      "parent:216->208",
    ]);
    expect(graph.edges.every((e) => !e.inferred && !e.backEdge)).toBe(true);
    expect(graph.nodes.filter((n) => n.stub).map((n) => n.number)).toEqual([211, 216]);
    expect(graph.nodes.find((n) => n.number === 211)).toMatchObject({
      title: "#211",
      state: "UNKNOWN",
      stub: true,
    });
  });

  it("marks text-only edges as inferred and lets native edges win", () => {
    const graph = buildIssueGraph([issue(1), issue(2), issue(3)], {
      1: links(1, { blocking: [2], body: "blocks #2\nblocks #3" }),
      2: links(2),
      3: links(3),
    });
    const byId = new Map(graph.edges.map((e) => [e.id, e]));
    expect(byId.get("blocks:1->2")?.inferred).toBe(false);
    expect(byId.get("blocks:1->3")?.inferred).toBe(true);
  });

  it("carries assignees and labels onto nodes", () => {
    const graph = buildIssueGraph(
      [issue(5, { assignees: [{ login: "ana" }], labels: [{ name: "bug", color: "ff0000" }] })],
      {},
    );
    expect(graph.nodes[0]).toMatchObject({
      assignees: [{ login: "ana" }],
      labels: [{ name: "bug", color: "ff0000" }],
    });
  });

  it("flags exactly one back edge in a cycle", () => {
    const graph = buildIssueGraph([issue(1), issue(2), issue(3)], {
      1: links(1, { body: "blocked by #3" }),
      2: links(2, { body: "blocked by #1" }),
      3: links(3, { body: "blocked by #2" }),
    });
    expect(graph.edges.filter((e) => e.backEdge)).toHaveLength(1);
    expect(graph.edges.filter((e) => !e.backEdge)).toHaveLength(2);
  });

  it("survives issues with no link entry", () => {
    const graph = buildIssueGraph([issue(1)], {});
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toEqual([]);
  });
});

describe("layoutIssueGraph", () => {
  it("places blockers left of what they block, by longest path", () => {
    const graph = buildIssueGraph([issue(1), issue(2), issue(3)], {
      1: links(1, { blocking: [2, 3] }),
      2: links(2, { blocking: [3] }),
      3: links(3),
    });
    const pos = layoutIssueGraph(graph);
    expect(pos.get(1)?.x).toBe(0);
    expect(pos.get(2)?.x).toBeGreaterThan(pos.get(1)?.x ?? 0);
    expect(pos.get(3)?.x).toBeGreaterThan(pos.get(2)?.x ?? 0);
  });

  it("puts unlinked issues in a grid below the linked components", () => {
    const graph = buildIssueGraph([issue(1), issue(2), issue(10), issue(11)], {
      1: links(1, { blocking: [2] }),
    });
    const pos = layoutIssueGraph(graph);
    const linkedBottom = Math.max(pos.get(1)?.y ?? 0, pos.get(2)?.y ?? 0);
    expect(pos.get(10)?.y).toBeGreaterThan(linkedBottom);
    expect(pos.get(11)?.y).toBe(pos.get(10)?.y);
    expect(pos.get(11)?.x).toBeGreaterThanOrEqual(ISSUE_NODE_W);
  });

  it("is deterministic and ignores back edges", () => {
    const build = () =>
      buildIssueGraph([issue(1), issue(2)], {
        1: links(1, { blocking: [2], body: "blocked by #2" }),
        2: links(2),
      });
    const a = layoutIssueGraph(build());
    const b = layoutIssueGraph(build());
    expect(Array.from(a.entries())).toEqual(Array.from(b.entries()));
    expect(a.size).toBe(2);
  });
});
