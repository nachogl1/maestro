/**
 * Issue map: "what is blocked by what, wave by wave".
 *
 * Turns the fetched issues plus their links into a column layout: every
 * story's wave is the length of the longest chain of story blockers beneath
 * it, the columns are the waves, and a line always runs from the blocker to
 * the story that waits for it. Pure functions, no React — the modal draws
 * whatever comes out of here as plain SVG.
 */

import type { IssueInfo } from "@/stores/useGitHubStore";
import { buildIssueGraph, type IssueLinks } from "./issueGraph";

export type IssueMapStatus = "closed" | "inprog" | "ready" | "blocked";
export type IssueMapKind = "agent" | "human" | "outside" | "decision" | "other";

export interface IssueMapAxisEntry {
  icon: string;
  name: string;
  meaning: string;
}

/** Background = progress. */
export const STATUS_META: Record<IssueMapStatus, IssueMapAxisEntry> = {
  closed: { icon: "✔", name: "Closed", meaning: "merged and closed, nothing left to do" },
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

/** Border = who takes it. */
export const KIND_META: Record<IssueMapKind, IssueMapAxisEntry> = {
  agent: {
    icon: "\u{1F916}",
    name: "agent-ready",
    meaning: "nothing left to ask, an agent can claim and build it",
  },
  human: {
    icon: "\u{1F64B}",
    name: "needs-human",
    meaning: "a person must act or decide first",
  },
  outside: {
    icon: "\u{1F3E2}",
    name: "outside-change",
    meaning: "a change lands outside the boundary repos, ends at a pull request for a reviewer",
  },
  decision: {
    icon: "❓",
    name: "decision / planning",
    meaning: "not a story, nothing to build; stories wait on its answer",
  },
  other: {
    icon: "▫",
    name: "untriaged",
    meaning: "no triage label yet, nobody has said who takes it",
  },
};

export const STATUS_ORDER: IssueMapStatus[] = ["closed", "inprog", "ready", "blocked"];
export const KIND_ORDER: IssueMapKind[] = ["agent", "human", "outside", "decision", "other"];

/** Label name → kind. First match wins, so order is precedence. */
const KIND_LABELS: Array<[IssueMapKind, RegExp]> = [
  ["decision", /^(epic|decision|planning|question)$/i],
  ["human", /^(needs-human(-decision)?|human-needed)$/i],
  ["outside", /^outside-change$/i],
  ["agent", /^agent-ready$/i],
];

export function kindOf(labels: Array<{ name: string }>): IssueMapKind {
  for (const [kind, re] of KIND_LABELS) {
    if (labels.some((l) => re.test(l.name))) return kind;
  }
  return "other";
}

/** One blocker as the tooltip lists it. */
export interface IssueMapBlocker {
  number: number;
  title: string;
  /** "OPEN" / "CLOSED", or "UNKNOWN" when the blocker was not fetched. */
  state: string;
}

export interface IssueMapNode {
  number: number;
  title: string;
  state: string;
  url: string;
  status: IssueMapStatus;
  kind: IssueMapKind;
  wave: string;
  assignees: string[];
  /** Parent epic, when GitHub (or the body) names one. */
  epic: number | null;
  blockers: IssueMapBlocker[];
  /** Issues that wait on this one. */
  waiting: number[];
  column: number;
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
  /** Blockers of each issue (listed issues only). */
  up: Record<number, number[]>;
  /** Issues each issue blocks (listed issues only). */
  down: Record<number, number[]>;
}

export const MAP_COL_W = 290;
export const MAP_NODE_W = 220;
export const MAP_NODE_H = 60;
export const MAP_ROW_H = 74;
export const MAP_X0 = 30;
export const MAP_Y0 = 70;
export const MAP_BAND_Y = 40;
export const MAP_LABEL_Y = 60;
const DONE_MIN_ROWS = 12;
const TITLE_MAX = 30;
const ASSIGNEE_MAX = 28;

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
 * Build the map for the fetched issues. Only "blocked by" links draw lines;
 * parent/epic links only fill the epic tag on the node.
 */
export function buildIssueMap(
  issues: IssueInfo[],
  links: Record<number, IssueLinks | undefined>,
): IssueMap {
  const byNumber = new Map<number, IssueInfo>();
  for (const issue of issues) byNumber.set(issue.number, issue);
  const graph = buildIssueGraph(issues, links);

  const kinds = new Map<number, IssueMapKind>();
  for (const issue of issues) kinds.set(issue.number, kindOf(issue.labels));

  const up: Record<number, number[]> = {};
  const down: Record<number, number[]> = {};
  const allBlockers = new Map<number, number[]>();
  const epics = new Map<number, number>();
  for (const issue of issues) {
    up[issue.number] = [];
    down[issue.number] = [];
    allBlockers.set(issue.number, []);
  }
  const sortedEdges = [...graph.edges].sort((a, b) => a.source - b.source || a.target - b.target);
  for (const edge of sortedEdges) {
    if (edge.kind === "parent") {
      if (byNumber.has(edge.target) && !epics.has(edge.target)) epics.set(edge.target, edge.source);
      continue;
    }
    allBlockers.get(edge.target)?.push(edge.source);
    if (!byNumber.has(edge.source) || !byNumber.has(edge.target) || edge.backEdge) continue;
    up[edge.target].push(edge.source);
    down[edge.source].push(edge.target);
  }

  // Wave = longest chain of *story* blockers beneath the issue; decisions
  // and planning issues never move a story to a later wave.
  const depthMemo = new Map<number, number>();
  const depth = (n: number): number => {
    const cached = depthMemo.get(n);
    if (cached !== undefined) return cached;
    depthMemo.set(n, 0);
    let d = 0;
    for (const b of up[n]) {
      if (kinds.get(b) !== "decision") d = Math.max(d, depth(b) + 1);
    }
    depthMemo.set(n, d);
    return d;
  };

  const ordered = [...issues].sort((a, b) => a.number - b.number);
  const done: number[] = [];
  const byWave = new Map<number, number[]>();
  for (const issue of ordered) {
    const n = issue.number;
    const isolated = up[n].length === 0 && down[n].length === 0;
    if (!isOpen(issue.state) && isolated) {
      done.push(n);
      continue;
    }
    const d = depth(n);
    const col = byWave.get(d) ?? [];
    col.push(n);
    byWave.set(d, col);
  }

  // The "already done" pile is split so no column is taller than the waves
  // (never shorter than DONE_MIN_ROWS, so a small map does not sprawl wide).
  let cap = DONE_MIN_ROWS;
  for (const col of byWave.values()) cap = Math.max(cap, col.length);
  const doneChunks: number[][] = [];
  for (let i = 0; i < done.length; i += cap) doneChunks.push(done.slice(i, i + cap));

  const columnMembers: Array<{ label: string; members: number[] }> = doneChunks.map(
    (members, i) => ({
      label: `Already done · ${i + 1} of ${doneChunks.length}`,
      members,
    }),
  );
  const maxWave = byWave.size > 0 ? Math.max(...byWave.keys()) : -1;
  for (let d = 0; d <= maxWave; d++) {
    columnMembers.push({
      label: d === 0 ? "Foundation" : `Wave ${d}`,
      members: byWave.get(d) ?? [],
    });
  }

  const columns: IssueMapColumn[] = [];
  const nodes: IssueMapNode[] = [];
  const positions = new Map<number, { x: number; y: number }>();
  let rows = 1;
  columnMembers.forEach(({ label, members }, index) => {
    const x = MAP_X0 + index * MAP_COL_W;
    let closed = 0;
    members.forEach((n, row) => {
      const issue = byNumber.get(n) as IssueInfo;
      if (!isOpen(issue.state)) closed++;
      positions.set(n, { x, y: MAP_Y0 + row * MAP_ROW_H });
    });
    rows = Math.max(rows, members.length);
    columns.push({ index, label, closed, total: members.length, x });
    for (const n of members) {
      const issue = byNumber.get(n) as IssueInfo;
      const blockers: IssueMapBlocker[] = (allBlockers.get(n) ?? []).map((b) => {
        const blocker = byNumber.get(b);
        return blocker
          ? { number: b, title: blocker.title, state: blocker.state.toUpperCase() }
          : { number: b, title: "not loaded", state: "UNKNOWN" };
      });
      const kind = kinds.get(n) ?? "other";
      let status: IssueMapStatus;
      if (!isOpen(issue.state)) status = "closed";
      else if (blockers.some((b) => b.state === "OPEN")) status = "blocked";
      else if (kind !== "decision" && (issue.assignees ?? []).length > 0) status = "inprog";
      else status = "ready";
      const pos = positions.get(n) as { x: number; y: number };
      nodes.push({
        number: n,
        title: issue.title,
        state: issue.state.toUpperCase(),
        url: issue.url,
        status,
        kind,
        wave: label,
        assignees: (issue.assignees ?? []).map((a) => a.login),
        epic: epics.get(n) ?? null,
        blockers,
        waiting: [...down[n]],
        column: index,
        x: pos.x,
        y: pos.y,
      });
    }
  });

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
    width: Math.max(1, columnMembers.length) * MAP_COL_W - 10,
    height: MAP_Y0 + rows * MAP_ROW_H + 30,
    up,
    down,
  };
}

/** What the node box prints: number + icons, epic tag, title, assignees. */
export function nodeText(node: IssueMapNode): {
  icons: string;
  tag: string;
  title: string;
  assignees: string;
} {
  return {
    icons: `${STATUS_META[node.status].icon}${KIND_META[node.kind].icon}`,
    tag: node.epic !== null ? `epic #${node.epic}` : "",
    title: truncate(node.title, TITLE_MAX),
    assignees:
      node.assignees.length > 0
        ? `\u{1F464} ${truncate(node.assignees.join(", "), ASSIGNEE_MAX)}`
        : "",
  };
}
