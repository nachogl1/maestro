/**
 * Issue graph: turns a list of GitHub issues plus their links into the nodes
 * and "blocked by" edges the issue map lays out, and lists every link it had
 * to drop as a data problem.
 *
 * Shared mechanic v1:
 * - every fetched issue is a node, open or closed, except `epic`-labelled ones;
 * - a link is "blocked by", from GitHub's native relation OR a "### Blocked by"
 *   section of the body (union); nothing else counts;
 * - a link to an epic, to an issue that was not fetched, or one that closes a
 *   cycle is dropped and reported.
 *
 * Pure functions, no React.
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
  /** Raw body, for the "### Blocked by" section and the tooltip. */
  body: string;
}

export interface IssueGraphEdge {
  /** `${source}->${target}` — stable and unique per pair. */
  id: string;
  /** Blocker. */
  source: number;
  /** Blocked issue. */
  target: number;
}

export interface IssueGraphNode {
  number: number;
  title: string;
  state: string;
  labels: PrLabel[];
  assignees: PrAuthor[];
  /** Native parent issue, for the informational "epic #N" tag only. */
  epic: number | null;
  body: string;
}

/** A link the layout could not keep, or two sources that disagree. */
export type IssueLinkProblem =
  | {
      kind: "disagreement";
      number: number;
      /** Blockers only the "### Blocked by" section names. */
      sectionOnly: number[];
      /** Blockers only GitHub's native relation names. */
      nativeOnly: number[];
    }
  | { kind: "epic" | "not-loaded" | "cycle"; blocked: number; blocker: number };

export interface IssueGraph {
  nodes: IssueGraphNode[];
  /** Kept "blocked by" links only (no epics, no unknown issues, no cycles). */
  edges: IssueGraphEdge[];
  problems: IssueLinkProblem[];
}

// "### Blocked by" heading (also at the very end of the body), then every line
// up to the next markdown heading.
const BLOCKED_BY_SECTION_RE =
  /^#{1,6}[ \t]*blocked by[ \t]*:?[ \t]*(?:\n|$)((?:(?!#{1,6}[ \t]+\S)[^\n]*\n?)*)/gim;

/**
 * Every `#N` under a "### Blocked by" heading of `body`, in order, deduped;
 * null when the body has no such section at all. CRLF bodies are normalised.
 */
export function parseBlockedBySection(rawBody: string): number[] | null {
  const body = rawBody.replace(/\r\n?/g, "\n");
  const refs: number[] = [];
  let found = false;
  BLOCKED_BY_SECTION_RE.lastIndex = 0;
  for (let m = BLOCKED_BY_SECTION_RE.exec(body); m !== null; m = BLOCKED_BY_SECTION_RE.exec(body)) {
    found = true;
    for (const n of m[1].matchAll(/#(\d+)/g)) {
      const ref = Number(n[1]);
      if (!refs.includes(ref)) refs.push(ref);
    }
  }
  return found ? refs : null;
}

/** True when the issue carries an `epic` label (case-insensitive exact match). */
export function isEpic(labels: Array<{ name: string }>): boolean {
  return labels.some((l) => l.name.toLowerCase() === "epic");
}

const byNumberAsc = (a: number, b: number) => a - b;

/**
 * Build the graph for the fetched issues: non-epic nodes, kept "blocked by"
 * edges, and the data problems (dropped links, disagreeing sources).
 */
export function buildIssueGraph(
  issues: IssueInfo[],
  links: Record<number, IssueLinks | undefined>,
): IssueGraph {
  const fetched = new Map<number, IssueInfo>();
  for (const issue of issues) fetched.set(issue.number, issue);
  const ordered = [...issues].sort((a, b) => a.number - b.number);

  const nodes: IssueGraphNode[] = [];
  const edges: IssueGraphEdge[] = [];
  const problems: IssueLinkProblem[] = [];

  for (const issue of ordered) {
    if (isEpic(issue.labels)) continue;
    const n = issue.number;
    const link = links[n];
    nodes.push({
      number: n,
      title: issue.title,
      state: issue.state,
      labels: issue.labels,
      assignees: issue.assignees ?? [],
      epic: link?.parent ?? null,
      body: link?.body ?? "",
    });
    if (!link) continue;

    const native = new Set(link.blockedBy.filter((b) => b !== n));
    const sectionRefs = parseBlockedBySection(link.body);
    const section = new Set((sectionRefs ?? []).filter((b) => b !== n));
    // Only a body that has a "### Blocked by" section can disagree with GitHub.
    if (sectionRefs !== null) {
      const sectionOnly = [...section].filter((b) => !native.has(b)).sort(byNumberAsc);
      const nativeOnly = [...native].filter((b) => !section.has(b)).sort(byNumberAsc);
      if (sectionOnly.length > 0 || nativeOnly.length > 0) {
        problems.push({ kind: "disagreement", number: n, sectionOnly, nativeOnly });
      }
    }

    for (const blocker of [...new Set([...native, ...section])].sort(byNumberAsc)) {
      const target = fetched.get(blocker);
      if (!target) problems.push({ kind: "not-loaded", blocked: n, blocker });
      else if (isEpic(target.labels)) problems.push({ kind: "epic", blocked: n, blocker });
      else edges.push({ id: `${blocker}->${n}`, source: blocker, target: n });
    }
  }

  const backEdges = findBackEdges(nodes, edges);
  for (const edge of edges) {
    if (backEdges.has(edge.id)) {
      problems.push({ kind: "cycle", blocked: edge.target, blocker: edge.source });
    }
  }

  return { nodes, edges: edges.filter((e) => !backEdges.has(e.id)), problems };
}

/** DFS cycle detection: the ids of the edges that close each cycle. */
function findBackEdges(nodes: IssueGraphNode[], edges: IssueGraphEdge[]): Set<string> {
  const out = new Map<number, IssueGraphEdge[]>();
  for (const node of nodes) out.set(node.number, []);
  // Deterministic: visit edges in a stable order so the same back-edge is
  // flagged every time for the same input.
  const sorted = [...edges].sort((a, b) => a.source - b.source || a.target - b.target);
  for (const edge of sorted) out.get(edge.source)?.push(edge);

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<number, number>();
  const back = new Set<string>();
  const visit = (n: number) => {
    color.set(n, GREY);
    for (const edge of out.get(n) ?? []) {
      const c = color.get(edge.target) ?? WHITE;
      if (c === GREY) back.add(edge.id);
      else if (c === WHITE) visit(edge.target);
    }
    color.set(n, BLACK);
  };
  for (const node of nodes) {
    if ((color.get(node.number) ?? WHITE) === WHITE) visit(node.number);
  }
  return back;
}
