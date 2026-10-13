/**
 * Issue map: "what is blocked by what, level by level".
 *
 * Turns the fetched issues plus their links into a column layout: an issue's
 * level is 1 + the highest level among its blockers (Level 0 has none), the
 * columns are the levels, and a line always runs from the blocker to the
 * issue that waits for it. Pure functions, no React — the modal draws
 * whatever comes out of here as plain SVG, and the HTML export draws the same.
 */

import type { IssueInfo } from "@/stores/useGitHubStore";
import {
  buildIssueGraph,
  type IssueGraphNode,
  type IssueLinkProblem,
  type IssueLinks,
} from "./issueGraph";

export type IssueMapStatus = "closed" | "inprog" | "ready" | "blocked";
export type IssueMapKind = "agent" | "human" | "outside" | "decision";

export interface IssueMapAxisEntry {
  name: string;
  meaning: string;
}

export interface IssueMapStatusEntry extends IssueMapAxisEntry {
  /** Drawn on the box for open issues; the closed "✕" is for the legend and tooltip only. */
  icon: string;
}

/** Icon = progress. */
export const STATUS_META: Record<IssueMapStatus, IssueMapStatusEntry> = {
  closed: { icon: "✕", name: "Closed", meaning: "merged and closed, nothing left to do" },
  inprog: {
    icon: "\u{1F528}",
    name: "In progress",
    meaning: "somebody has claimed it and is building it now",
  },
  ready: { icon: "\u{1F7E2}", name: "Ready", meaning: "open, nobody on it, every blocker closed" },
  blocked: {
    icon: "\u{1F512}",
    name: "Blocked",
    meaning: "at least one blocker (a red line coming in) is still open",
  },
};

/** Background = who takes it. */
export const KIND_META: Record<IssueMapKind, IssueMapAxisEntry> = {
  agent: {
    name: "agent-ready",
    meaning: "nothing left to ask, an agent can claim and build it",
  },
  human: {
    name: "needs-human",
    meaning: "a person must act or decide first",
  },
  outside: {
    name: "outside-change",
    meaning: "a change lands outside the boundary repos, ends at a pull request for a reviewer",
  },
  decision: {
    name: "decision / planning",
    meaning: "no triage label yet: not a story to build until somebody says who takes it",
  },
};

/** Maestro palette colour names; the modal and the export each map them to their own CSS. */
export type IssueMapTone = "green" | "red" | "blue" | "yellow";

/** Background = who takes it: the colour each kind's box is filled with. */
export const KIND_FILL: Record<IssueMapKind, IssueMapTone> = {
  agent: "green",
  human: "red",
  outside: "blue",
  decision: "yellow",
};

/** The one status icon a box shows; "" for a closed issue, whose cross says it all. */
export function statusIcon(node: { status: IssueMapStatus }): string {
  return node.status === "closed" ? "" : STATUS_META[node.status].icon;
}

/** How the boxes are coloured and marked; the modal legend and the export say the same. */
export const ENCODING_EXPLANATION =
  "Background = who takes it (green agent-ready, red needs-human, blue outside-change, " +
  "yellow anything else). Icon = progress (\u{1F528} in progress, \u{1F7E2} ready, " +
  "\u{1F512} blocked). A cross means closed.";

/** How many issues the map fetches, open and closed (`gh --limit`). */
export const MAP_ISSUE_LIMIT = 1000;

/** Header warning when the fetch hit MAP_ISSUE_LIMIT; modal and export print it. */
export const LIMIT_WARNING = `⚠ Showing the first ${MAP_ISSUE_LIMIT} issues, links beyond it are dropped.`;

/** What the hint line says when nothing is hovered or pinned. */
export const HINT =
  "Hover an issue to see its chain and a tooltip. Click to pin, double-click to open it on GitHub. " +
  "Click a legend entry to hide or show that type; each shows shown/total.";

/** How the levels are built; the modal footer and the export say the same. */
export const LEVEL_EXPLANATION =
  "An issue's level is 1 + the highest level among its blockers; Level 0 has no blockers. " +
  "Only GitHub 'blocked by' and a '### Blocked by' section count; epics are not drawn.";

export const STATUS_ORDER: IssueMapStatus[] = ["closed", "inprog", "ready", "blocked"];
export const KIND_ORDER: IssueMapKind[] = ["agent", "human", "outside", "decision"];

/** Label name → kind. First match wins, so order is precedence. */
const KIND_LABELS: Array<[IssueMapKind, RegExp]> = [
  ["outside", /^outside-change$/i],
  ["human", /^(needs-human(-decision)?|human-needed)$/i],
  ["agent", /^agent-ready$/i],
];

/** The kind and the label that decided it (null when nothing matched). */
export function kindOf(labels: Array<{ name: string }>): {
  kind: IssueMapKind;
  label: string | null;
} {
  for (const [kind, re] of KIND_LABELS) {
    const hit = labels.find((l) => re.test(l.name));
    if (hit) return { kind, label: hit.name };
  }
  return { kind: "decision", label: null };
}

/** One blocker as the tooltip lists it. */
export interface IssueMapBlocker {
  number: number;
  title: string;
  /** "OPEN" / "CLOSED". */
  state: string;
}

export interface IssueMapNode {
  number: number;
  title: string;
  state: string;
  url: string;
  status: IssueMapStatus;
  kind: IssueMapKind;
  /** The label that decided `kind`, null for the fallback. */
  kindLabel: string | null;
  level: number;
  labels: string[];
  /** Raw issue body ("" when the links did not load). */
  body: string;
  assignees: string[];
  /** Native parent issue, when GitHub names one (informational). */
  epic: number | null;
  /** Kept blockers: loaded, not epics, not closing a cycle. */
  blockers: IssueMapBlocker[];
  /** Issues that wait on this one. */
  waiting: number[];
  x: number;
  y: number;
}

export interface IssueMapEdge {
  from: number;
  to: number;
  /** True while the blocker is still open. */
  open: boolean;
  path: string;
}

export interface IssueMapColumn {
  index: number;
  label: string;
  closed: number;
  total: number;
  x: number;
}

export interface IssueMap {
  nodes: IssueMapNode[];
  edges: IssueMapEdge[];
  columns: IssueMapColumn[];
  width: number;
  height: number;
  /** Blockers of each issue (kept links only). */
  up: Record<number, number[]>;
  /** Issues each issue blocks (kept links only). */
  down: Record<number, number[]>;
  /** Dropped links and disagreeing sources, for the footer. */
  problems: IssueLinkProblem[];
}

export const MAP_COL_W = 290;
export const MAP_NODE_W = 220;
export const MAP_NODE_H = 84;
export const MAP_ROW_H = 98;
export const MAP_X0 = 30;
export const MAP_Y0 = 70;
export const MAP_BAND_Y = 40;
export const MAP_LABEL_Y = 60;
/** Label chip row inside the box. */
export const MAP_CHIP_Y = 62;
export const MAP_CHIP_H = 16;
export const MAP_CHIP_FONT = 10;
const CHIP_CHAR_W = 5.6;
const CHIP_PAD_X = 10;
const CHIP_GAP = 4;
const CHIP_TEXT_MAX = 10;
const CHIP_MAX = 3;
const TITLE_MAX = 30;
const ASSIGNEE_MAX = 28;
export const DESCRIPTION_MAX = 600;

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Everything reachable from `start` through `adj` (not including `start`). */
export function walk(start: number, adj: Record<number, number[]>): Set<number> {
  const seen = new Set<number>();
  const queue = [start];
  while (queue.length > 0) {
    const n = queue.pop() as number;
    for (const m of adj[n] ?? []) {
      if (!seen.has(m)) {
        seen.add(m);
        queue.push(m);
      }
    }
  }
  return seen;
}

const isOpen = (state: string) => state.toUpperCase() === "OPEN";

/** Cubic from the blocker's right edge to the waiting issue's left edge. */
export function edgePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const sx = from.x + MAP_NODE_W;
  const sy = from.y + MAP_NODE_H / 2;
  const tx = to.x;
  const ty = to.y + MAP_NODE_H / 2;
  const mx = (sx + tx) / 2;
  return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
}

/**
 * Build the map for the fetched issues. Only kept "blocked by" links draw
 * lines and set levels; the native parent only fills the epic tag on the box.
 */
export function buildIssueMap(
  issues: IssueInfo[],
  links: Record<number, IssueLinks | undefined>,
): IssueMap {
  const byNumber = new Map<number, IssueInfo>();
  for (const issue of issues) byNumber.set(issue.number, issue);
  const graph = buildIssueGraph(issues, links);

  const graphNodes = new Map(graph.nodes.map((g) => [g.number, g]));
  const up: Record<number, number[]> = {};
  const down: Record<number, number[]> = {};
  for (const node of graph.nodes) {
    up[node.number] = [];
    down[node.number] = [];
  }
  const sortedEdges = [...graph.edges].sort((a, b) => a.source - b.source || a.target - b.target);
  for (const edge of sortedEdges) {
    up[edge.target].push(edge.source);
    down[edge.source].push(edge.target);
  }

  // Level = 1 + the highest level among the blockers; no blockers = 0. Kept
  // links never close a cycle, so the recursion always ends.
  const levelMemo = new Map<number, number>();
  const levelOf = (n: number): number => {
    const cached = levelMemo.get(n);
    if (cached !== undefined) return cached;
    let level = 0;
    for (const b of up[n]) level = Math.max(level, levelOf(b) + 1);
    levelMemo.set(n, level);
    return level;
  };

  // Inside a column: open issues first (by number), closed ones at the bottom.
  const byLevel = new Map<number, number[]>();
  for (const node of graph.nodes) {
    const level = levelOf(node.number);
    const col = byLevel.get(level) ?? [];
    col.push(node.number);
    byLevel.set(level, col);
  }
  const rank = (n: number) => (isOpen((byNumber.get(n) as IssueInfo).state) ? 0 : 1);
  for (const members of byLevel.values()) members.sort((a, b) => rank(a) - rank(b) || a - b);

  const maxLevel = byLevel.size > 0 ? Math.max(...byLevel.keys()) : -1;
  const columns: IssueMapColumn[] = [];
  const nodes: IssueMapNode[] = [];
  const positions = new Map<number, { x: number; y: number }>();
  let rows = 1;
  for (let level = 0; level <= maxLevel; level++) {
    const members = byLevel.get(level) ?? [];
    const x = MAP_X0 + level * MAP_COL_W;
    let closed = 0;
    members.forEach((n, row) => {
      if (!isOpen((byNumber.get(n) as IssueInfo).state)) closed++;
      positions.set(n, { x, y: MAP_Y0 + row * MAP_ROW_H });
    });
    rows = Math.max(rows, members.length);
    columns.push({ index: level, label: `Level ${level}`, closed, total: members.length, x });
    for (const n of members) {
      const issue = byNumber.get(n) as IssueInfo;
      const graphNode = graphNodes.get(n) as IssueGraphNode;
      const blockers: IssueMapBlocker[] = up[n].map((b) => {
        const blocker = byNumber.get(b) as IssueInfo;
        return { number: b, title: blocker.title, state: blocker.state.toUpperCase() };
      });
      const { kind, label: kindLabel } = kindOf(issue.labels);
      let status: IssueMapStatus;
      if (!isOpen(issue.state)) status = "closed";
      else if (blockers.some((b) => b.state === "OPEN")) status = "blocked";
      else if ((issue.assignees ?? []).length > 0) status = "inprog";
      else status = "ready";
      const pos = positions.get(n) as { x: number; y: number };
      nodes.push({
        number: n,
        title: issue.title,
        state: issue.state.toUpperCase(),
        url: issue.url,
        status,
        kind,
        kindLabel,
        level,
        labels: issue.labels.map((l) => l.name),
        body: graphNode.body,
        assignees: (issue.assignees ?? []).map((a) => a.login),
        epic: graphNode.epic,
        blockers,
        waiting: [...down[n]],
        x: pos.x,
        y: pos.y,
      });
    }
  }

  const edges: IssueMapEdge[] = [];
  for (const node of nodes) {
    for (const b of up[node.number]) {
      const from = positions.get(b) as { x: number; y: number };
      const blocker = byNumber.get(b) as IssueInfo;
      edges.push({
        from: b,
        to: node.number,
        open: isOpen(blocker.state),
        path: edgePath(from, node),
      });
    }
  }

  return {
    nodes,
    edges,
    columns,
    width: Math.max(1, columns.length) * MAP_COL_W - 10,
    height: MAP_Y0 + rows * MAP_ROW_H + 30,
    up,
    down,
    problems: graph.problems,
  };
}

/** One label chip on the box, positioned relative to the box's left edge. */
export interface IssueMapChip {
  text: string;
  x: number;
  w: number;
}

const chipWidth = (text: string) => Math.round(text.length * CHIP_CHAR_W) + CHIP_PAD_X;

/** Up to CHIP_MAX label chips that fit the box, then a "+N" chip for the rest. */
export function labelChips(labels: string[]): IssueMapChip[] {
  const chips: IssueMapChip[] = [];
  const budget = MAP_NODE_W - 20;
  let x = 0;
  let shown = 0;
  for (const label of labels) {
    const text = truncate(label, CHIP_TEXT_MAX);
    const w = chipWidth(text);
    const rest = labels.length - shown - 1;
    const reserve = rest > 0 ? CHIP_GAP + chipWidth(`+${rest}`) : 0;
    if (shown >= CHIP_MAX || x + w + reserve > budget) break;
    chips.push({ text, x, w });
    x += w + CHIP_GAP;
    shown++;
  }
  const rest = labels.length - shown;
  if (rest > 0) chips.push({ text: `+${rest}`, x, w: chipWidth(`+${rest}`) });
  return chips;
}

/** What the node box prints: number + status icon, epic tag, title, assignees, labels. */
export function nodeText(node: IssueMapNode): {
  icons: string;
  tag: string;
  title: string;
  assignees: string;
  chips: IssueMapChip[];
} {
  return {
    icons: statusIcon(node),
    tag: node.epic !== null ? `epic #${node.epic}` : "",
    title: truncate(node.title, TITLE_MAX),
    assignees:
      node.assignees.length > 0
        ? `\u{1F464} ${truncate(node.assignees.join(", "), ASSIGNEE_MAX)}`
        : "",
    chips: labelChips(node.labels),
  };
}

/**
 * The tooltip's description: the body as plain text (markdown lightly
 * stripped), cut at DESCRIPTION_MAX characters.
 */
export function descriptionText(body: string): string {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/`+/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return truncate(text, DESCRIPTION_MAX);
}

const list = (numbers: number[]) => numbers.map((n) => `#${n}`).join(", ");

/** One footer line per data problem; the modal and the export print the same. */
export function problemText(problem: IssueLinkProblem): string {
  switch (problem.kind) {
    case "disagreement": {
      const { number, sectionOnly, nativeOnly } = problem;
      if (sectionOnly.length > 0 && nativeOnly.length > 0) {
        return `#${number}: section says ${list(sectionOnly)}, GitHub says ${list(nativeOnly)}`;
      }
      if (sectionOnly.length > 0) {
        return `#${number}: section says ${list(sectionOnly)}, GitHub does not`;
      }
      return `#${number}: GitHub says ${list(nativeOnly)}, section does not`;
    }
    case "epic":
      return `#${problem.blocked}: blocked by epic #${problem.blocker}, link dropped`;
    case "not-loaded":
      return `#${problem.blocked}: blocked by #${problem.blocker} which was not loaded, link dropped`;
    default:
      return `#${problem.blocked}: blocked by #${problem.blocker} closes a cycle, link dropped`;
  }
}
