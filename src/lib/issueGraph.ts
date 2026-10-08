/**
 * Issue hierarchy graph: turns a list of GitHub issues plus their links
 * (native "blocked by" / "blocking" dependencies, parent/sub-issue, and a
 * text fallback parsed from the body) into nodes + edges, and lays them out.
 *
 * Pure functions, no React — the modal renders whatever comes out of here.
 */

import type { IssueInfo, PrAuthor, PrLabel } from "@/stores/useGitHubStore";

/** Links for one issue, as the `github_issue_links` command returns them. */
export interface IssueLinks {
  number: number;
  /** Issues that block this one (GitHub native dependency). */
  blockedBy: number[];
  /** Issues this one blocks (GitHub native dependency). */
  blocking: number[];
  /** Parent issue (GitHub sub-issues), if any. */
  parent: number | null;
  /** Child issues (GitHub sub-issues). */
  subIssues: number[];
  /** Raw body, for the text fallback. */
  body: string;
}

export type IssueEdgeKind = "blocks" | "parent";

export interface IssueGraphEdge {
  /** `${kind}:${source}->${target}` — stable and unique per pair+kind. */
  id: string;
  /** Blocker (kind "blocks") or epic (kind "parent"). */
  source: number;
  /** Blocked issue (kind "blocks") or child (kind "parent"). */
  target: number;
  kind: IssueEdgeKind;
  /** True when the edge came from body text, not a native GitHub link. */
  inferred: boolean;
  /** True when the edge closes a cycle; the layout ignores it. */
  backEdge: boolean;
}

export interface IssueGraphNode {
  number: number;
  title: string;
  state: string;
  labels: PrLabel[];
  assignees: PrAuthor[];
  /** Linked from a listed issue but not in the current list itself. */
  stub: boolean;
}

export interface IssueGraph {
  nodes: IssueGraphNode[];
  edges: IssueGraphEdge[];
}

export interface XY {
  x: number;
  y: number;
}

export const ISSUE_NODE_W = 240;
export const ISSUE_NODE_H = 116;
const GAP_X = 72;
const GAP_Y = 20;
const COMPONENT_GAP = 48;
const UNLINKED_COLUMNS = 4;

/** One text-inferred relationship. */
export interface TextRef {
  kind: IssueEdgeKind;
  source: number;
  target: number;
}

// "blocked by #1, #2 and #3" — keyword, then a run of #N separated by
// commas / "and" / whitespace. Alternation order matters: "part of epic"
// must win over bare "epic". Keywords must be followed (after an optional
// colon) directly by "#", so "epic). The #103" does not match.
const TEXT_REF_RE =
  /\b(blocked by|depends on|depend on|blocks|blocking|part of epic|part of|child of|parent|epic)\b:?\s*((?:#\d+(?:\s*(?:,|and|&)?\s*)?)+)/gi;

const BLOCKED_BY_WORDS = new Set(["blocked by", "depends on", "depend on"]);
const BLOCKS_WORDS = new Set(["blocks", "blocking"]);

/**
 * Pull "blocked by #N" / "blocks #N" / "part of epic #N" style references out
 * of an issue body. `self` is the issue the body belongs to.
 */
export function parseTextRefs(body: string, self: number): TextRef[] {
  const refs: TextRef[] = [];
  const seen = new Set<string>();
  const push = (ref: TextRef) => {
    if (ref.source === ref.target) return;
    const key = `${ref.kind}:${ref.source}->${ref.target}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };
  TEXT_REF_RE.lastIndex = 0;
  for (let m = TEXT_REF_RE.exec(body); m !== null; m = TEXT_REF_RE.exec(body)) {
    const word = m[1].toLowerCase();
    const numbers = Array.from(m[2].matchAll(/#(\d+)/g), (n) => Number(n[1]));
    for (const n of numbers) {
      if (BLOCKED_BY_WORDS.has(word)) push({ kind: "blocks", source: n, target: self });
      else if (BLOCKS_WORDS.has(word)) push({ kind: "blocks", source: self, target: n });
      else push({ kind: "parent", source: n, target: self });
    }
  }
  return refs;
}

const edgeId = (kind: IssueEdgeKind, source: number, target: number) =>
  `${kind}:${source}->${target}`;

/**
 * Build the graph for the listed issues. Native links win over text-inferred
 * ones for the same (kind, source, target). Issues referenced by a link but
 * not in `issues` become stub nodes.
 */
export function buildIssueGraph(
  issues: IssueInfo[],
  links: Record<number, IssueLinks | undefined>,
): IssueGraph {
  const listed = new Map<number, IssueInfo>();
  for (const issue of issues) listed.set(issue.number, issue);

  const edges = new Map<string, IssueGraphEdge>();
  const addEdge = (kind: IssueEdgeKind, source: number, target: number, inferred: boolean) => {
    if (source === target) return;
    const id = edgeId(kind, source, target);
    const existing = edges.get(id);
    if (existing && (!existing.inferred || inferred)) return;
    edges.set(id, { id, source, target, kind, inferred, backEdge: false });
  };

  for (const issue of issues) {
    const link = links[issue.number];
    if (!link) continue;
    for (const b of link.blockedBy) addEdge("blocks", b, issue.number, false);
    for (const b of link.blocking) addEdge("blocks", issue.number, b, false);
    if (link.parent !== null) addEdge("parent", link.parent, issue.number, false);
    for (const s of link.subIssues) addEdge("parent", issue.number, s, false);
  }
  for (const issue of issues) {
    const link = links[issue.number];
    if (!link) continue;
    for (const ref of parseTextRefs(link.body, issue.number)) {
      addEdge(ref.kind, ref.source, ref.target, true);
    }
  }

  const nodes: IssueGraphNode[] = issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels,
    assignees: issue.assignees ?? [],
    stub: false,
  }));
  const stubs = new Set<number>();
  for (const edge of edges.values()) {
    for (const n of [edge.source, edge.target]) {
      if (!listed.has(n)) stubs.add(n);
    }
  }
  for (const n of Array.from(stubs).sort((a, b) => a - b)) {
    nodes.push({
      number: n,
      title: `#${n}`,
      state: "UNKNOWN",
      labels: [],
      assignees: [],
      stub: true,
    });
  }

  const graph = { nodes, edges: Array.from(edges.values()) };
  markBackEdges(graph);
  return graph;
}

/** DFS cycle detection: flag the edge that closes each cycle. */
function markBackEdges(graph: IssueGraph): void {
  const out = new Map<number, IssueGraphEdge[]>();
  for (const node of graph.nodes) out.set(node.number, []);
  // Deterministic: visit edges in a stable order so the same back-edge is
  // flagged every time for the same input.
  const sorted = [...graph.edges].sort((a, b) => a.id.localeCompare(b.id));
  for (const edge of sorted) out.get(edge.source)?.push(edge);

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<number, number>();
  const visit = (n: number) => {
    color.set(n, GREY);
    for (const edge of out.get(n) ?? []) {
      const c = color.get(edge.target) ?? WHITE;
      if (c === GREY) edge.backEdge = true;
      else if (c === WHITE) visit(edge.target);
    }
    color.set(n, BLACK);
  };
  const order = [...graph.nodes].map((n) => n.number).sort((a, b) => a - b);
  for (const n of order) {
    if ((color.get(n) ?? WHITE) === WHITE) visit(n);
  }
}

/**
 * Deterministic layered layout. Linked issues: one block per connected
 * component, blockers/epics in the left column, what they block to the right
 * (longest-path layering). Unlinked issues: a grid underneath.
 */
export function layoutIssueGraph(graph: IssueGraph): Map<number, XY> {
  const positions = new Map<number, XY>();
  const live = graph.edges.filter((e) => !e.backEdge);

  const neighbours = new Map<number, Set<number>>();
  const preds = new Map<number, number[]>();
  for (const node of graph.nodes) {
    neighbours.set(node.number, new Set());
    preds.set(node.number, []);
  }
  for (const edge of live) {
    neighbours.get(edge.source)?.add(edge.target);
    neighbours.get(edge.target)?.add(edge.source);
    preds.get(edge.target)?.push(edge.source);
  }

  // Connected components (undirected), smallest member first for stability.
  const seen = new Set<number>();
  const components: number[][] = [];
  const unlinked: number[] = [];
  const ordered = [...graph.nodes].map((n) => n.number).sort((a, b) => a - b);
  for (const start of ordered) {
    if (seen.has(start)) continue;
    if ((neighbours.get(start)?.size ?? 0) === 0) {
      seen.add(start);
      unlinked.push(start);
      continue;
    }
    const members: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const n = stack.pop() as number;
      members.push(n);
      for (const m of neighbours.get(n) ?? []) {
        if (!seen.has(m)) {
          seen.add(m);
          stack.push(m);
        }
      }
    }
    components.push(members.sort((a, b) => a - b));
  }

  let y = 0;
  for (const members of components) {
    const memberSet = new Set(members);
    const layer = new Map<number, number>();
    const depth = (n: number): number => {
      const cached = layer.get(n);
      if (cached !== undefined) return cached;
      layer.set(n, 0); // guard: back edges are excluded, but stay safe
      let d = 0;
      for (const p of preds.get(n) ?? []) {
        if (memberSet.has(p)) d = Math.max(d, depth(p) + 1);
      }
      layer.set(n, d);
      return d;
    };
    const columns = new Map<number, number[]>();
    for (const n of members) {
      const d = depth(n);
      const col = columns.get(d) ?? [];
      col.push(n);
      columns.set(d, col);
    }
    let tallest = 0;
    for (const [d, col] of columns) {
      col.forEach((n, row) => {
        positions.set(n, { x: d * (ISSUE_NODE_W + GAP_X), y: y + row * (ISSUE_NODE_H + GAP_Y) });
      });
      tallest = Math.max(tallest, col.length);
    }
    y += tallest * (ISSUE_NODE_H + GAP_Y) + COMPONENT_GAP;
  }

  unlinked.forEach((n, i) => {
    const col = i % UNLINKED_COLUMNS;
    const row = Math.floor(i / UNLINKED_COLUMNS);
    positions.set(n, {
      x: col * (ISSUE_NODE_W + GAP_X / 2),
      y: y + row * (ISSUE_NODE_H + GAP_Y),
    });
  });

  return positions;
}
