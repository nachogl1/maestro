/**
 * Issue map: "what is blocked by what, level by level".
 *
 * Turns the fetched issues plus their links into a column layout: an issue's
 * level is 1 + the highest level among its blockers (Level 0 has none), the
 * columns are the levels, and a line always runs from the blocker to the
 * issue that waits for it. Epics sit in their own far-left column, outside
 * the levels, tied to their stories by GitHub's sub-issue link. Pure
 * functions, no React — the modal draws whatever comes out of here as plain
 * SVG, and the HTML export draws the same.
 */

import type { IssueInfo } from "@/stores/useGitHubStore";
import { buildIssueGraph, type IssueLinkProblem, type IssueLinks, isEpic } from "./issueGraph";

export type IssueMapStatus = "closed" | "inprog" | "ready" | "blocked";
export type IssueMapKind = "agent" | "human" | "outside" | "decision" | "epic";

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
  ready: {
    icon: "\u{1F7E2}",
    name: "Ready to take",
    meaning: "open, nobody on it, every blocker closed",
  },
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
  epic: {
    name: "epic",
    meaning: "an epic, far-left column; click it to see its stories",
  },
};

/** Maestro palette colour names; the modal and the export each map them to their own CSS. */
export type IssueMapTone = "green" | "red" | "blue" | "yellow" | "purple";

/** Background = who takes it: the colour each kind's box is filled with. */
export const KIND_FILL: Record<IssueMapKind, IssueMapTone> = {
  agent: "green",
  human: "red",
  outside: "blue",
  decision: "yellow",
  epic: "purple",
};

/** The one status icon a box shows; "" for a closed issue, whose cross says it all. */
export function statusIcon(node: { status: IssueMapStatus }): string {
  return node.status === "closed" ? "" : STATUS_META[node.status].icon;
}

/** How the boxes are coloured and marked; the modal legend and the export say the same. */
export const ENCODING_EXPLANATION =
  "Background = who takes it (green agent-ready, red needs-human, blue outside-change, " +
  "yellow anything else, purple epic). Icon = progress (\u{1F528} in progress, \u{1F7E2} ready, " +
  "\u{1F512} blocked). A cross means closed.";

/** How many issues the map fetches, open and closed (`gh --limit`). */
export const MAP_ISSUE_LIMIT = 1000;

/** Header warning when the fetch hit MAP_ISSUE_LIMIT; modal and export print it. */
export const LIMIT_WARNING = `⚠ Showing the first ${MAP_ISSUE_LIMIT} issues, links beyond it are dropped.`;

/** What the hint line says when no issue is clicked. */
export const HINT =
  "Drag to move around, scroll the wheel to zoom (or use the buttons). Click an issue to see its " +
  "chain and a tooltip, click it again to clear. Double-click opens it on GitHub. Click a legend " +
  "entry to hide or show that type (hidden issues leave the map and the rest close up); each " +
  "shows shown/total.";

/** How the levels are built; the modal footer and the export say the same. */
export const LEVEL_EXPLANATION =
  "An issue's level is 1 + the highest level among its blockers; Level 0 has no blockers. " +
  "Only GitHub 'blocked by' and a '### Blocked by' section count. Epics sit in the far-left " +
  "column, outside the levels, joined to their stories by dashed purple lines (GitHub's " +
  "sub-issue link). Epics and closed issues start hidden: tick them in the legend.";

export const STATUS_ORDER: IssueMapStatus[] = ["closed", "inprog", "ready", "blocked"];
export const KIND_ORDER: IssueMapKind[] = ["agent", "human", "outside", "decision", "epic"];

/** Legend entries that start unticked, so the first view is the open work. */
export const START_HIDDEN_KINDS: IssueMapKind[] = ["epic"];
export const START_HIDDEN_STATUSES: IssueMapStatus[] = ["closed"];

/** Name of the far-left column that holds the epics. */
export const EPICS_COLUMN = "Epics";

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
  const epic = labels.find((l) => l.name.toLowerCase() === "epic");
  if (epic) return { kind: "epic", label: epic.name };
  for (const [kind, re] of KIND_LABELS) {
    const hit = labels.find((l) => re.test(l.name));
    if (hit) return { kind, label: hit.name };
  }
  return { kind: "decision", label: null };
}

/** True when this label alone decides who takes an issue (agent-ready, epic, ...). */
export function isKindLabel(name: string): boolean {
  return kindOf([{ name }]).kind !== "decision";
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
  /** Level column; -1 for an epic, which sits in the Epics column. */
  level: number;
  labels: string[];
  /** Raw issue body ("" when the links did not load). */
  body: string;
  assignees: string[];
  /** Native parent issue, when GitHub names one (informational). */
  epic: number | null;
  /** The drawn epic this story belongs to (its sub-issue link), else null. */
  parent: number | null;
  /** An epic's stories on the map (its sub-issues); empty for anything else. */
  stories: IssueMapBlocker[];
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
  /** Position from the left, after empty columns are packed away. */
  index: number;
  label: string;
  /** Closed and total issues of the whole column, whatever is filtered out. */
  closed: number;
  total: number;
  x: number;
  /** Issue numbers top to bottom (open first by number, closed at the bottom). */
  members: number[];
}

export interface IssueMap {
  nodes: IssueMapNode[];
  /** Blocked-by lines. */
  edges: IssueMapEdge[];
  /** Dashed epic-to-story lines (sub-issue link); `open` is the story's state. */
  epicEdges: IssueMapEdge[];
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

/** Where every shown box, column and line sits once hidden issues leave the map. */
export interface IssueMapLayout {
  positions: Map<number, { x: number; y: number }>;
  /** Only the columns that still hold a shown issue, packed left to right. */
  columns: IssueMapColumn[];
  /** `${from}->${to}` → path, for every line whose two ends are shown. */
  paths: Map<string, string>;
  width: number;
  height: number;
}

export const edgeKey = (edge: { from: number; to: number }): string => `${edge.from}->${edge.to}`;

/**
 * Lay out the shown issues: hidden ones leave the map, empty columns go, the
 * rest close up left to right, and every column is centred on the tallest.
 */
export function packIssueMap(
  map: Pick<IssueMap, "columns" | "edges" | "epicEdges">,
  visible: Set<number>,
): IssueMapLayout {
  const cols = map.columns
    .map((col) => ({ col, members: col.members.filter((n) => visible.has(n)) }))
    .filter((c) => c.members.length > 0);
  const rows = Math.max(1, ...cols.map((c) => c.members.length));
  const positions = new Map<number, { x: number; y: number }>();
  const columns: IssueMapColumn[] = cols.map(({ col, members }, index) => {
    const x = MAP_X0 + index * MAP_COL_W;
    const offset = ((rows - members.length) * MAP_ROW_H) / 2;
    members.forEach((n, row) => {
      positions.set(n, { x, y: MAP_Y0 + offset + row * MAP_ROW_H });
    });
    return { ...col, index, x };
  });
  const paths = new Map<string, string>();
  for (const edge of [...map.edges, ...map.epicEdges]) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (from && to) paths.set(edgeKey(edge), edgePath(from, to));
  }
  return {
    positions,
    columns,
    paths,
    width: Math.max(1, columns.length) * MAP_COL_W - 10,
    height: MAP_Y0 + rows * MAP_ROW_H + 30,
  };
}

/**
 * Build the map for the fetched issues. Only kept "blocked by" links draw
 * solid lines and set levels; an epic's sub-issue link draws a dashed line
 * from the Epics column, and the native parent fills the epic tag on the box.
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

  // Epic → its stories, from GitHub's sub-issue link (either side of it).
  const epics = issues.filter((i) => isEpic(i.labels)).map((i) => i.number);
  const kids = new Map<number, number[]>();
  for (const e of epics) {
    const set = new Set((links[e]?.subIssues ?? []).filter((k) => graphNodes.has(k)));
    for (const node of graph.nodes) if (node.epic === e) set.add(node.number);
    kids.set(
      e,
      [...set].sort((a, b) => a - b),
    );
  }
  const parent = new Map<number, number>();
  for (const e of [...epics].sort((a, b) => a - b)) {
    for (const k of kids.get(e) ?? []) if (!parent.has(k)) parent.set(k, e);
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
  const ordered = (members: number[]) => members.sort((a, b) => rank(a) - rank(b) || a - b);

  const columnMembers: Array<{ label: string; level: number; members: number[] }> = [];
  if (epics.length > 0) {
    columnMembers.push({ label: EPICS_COLUMN, level: -1, members: ordered([...epics]) });
  }
  const maxLevel = byLevel.size > 0 ? Math.max(...byLevel.keys()) : -1;
  for (let level = 0; level <= maxLevel; level++) {
    columnMembers.push({
      label: `Level ${level}`,
      level,
      members: ordered(byLevel.get(level) ?? []),
    });
  }
  const columns: IssueMapColumn[] = columnMembers.map(({ label, members }, index) => ({
    index,
    label,
    closed: members.filter((n) => !isOpen((byNumber.get(n) as IssueInfo).state)).length,
    total: members.length,
    x: 0,
    members,
  }));

  const blockerOf = (b: number): IssueMapBlocker => {
    const blocker = byNumber.get(b) as IssueInfo;
    return { number: b, title: blocker.title, state: blocker.state.toUpperCase() };
  };
  const nodes: IssueMapNode[] = [];
  for (const { level, members } of columnMembers) {
    for (const n of members) {
      const issue = byNumber.get(n) as IssueInfo;
      const graphNode = graphNodes.get(n);
      const blockers = graphNode ? up[n].map(blockerOf) : [];
      const { kind, label: kindLabel } = kindOf(issue.labels);
      let status: IssueMapStatus;
      if (!isOpen(issue.state)) status = "closed";
      else if (blockers.some((b) => b.state === "OPEN")) status = "blocked";
      else if ((issue.assignees ?? []).length > 0) status = "inprog";
      else status = "ready";
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
        body: graphNode ? graphNode.body : (links[n]?.body ?? ""),
        assignees: (issue.assignees ?? []).map((a) => a.login),
        epic: graphNode ? graphNode.epic : null,
        parent: parent.get(n) ?? null,
        stories: (kids.get(n) ?? []).map(blockerOf),
        blockers,
        waiting: graphNode ? [...down[n]] : [],
        x: 0,
        y: 0,
      });
    }
  }

  const edges: IssueMapEdge[] = [];
  for (const node of nodes) {
    for (const b of up[node.number] ?? []) {
      const open = isOpen((byNumber.get(b) as IssueInfo).state);
      edges.push({ from: b, to: node.number, open, path: "" });
    }
  }
  const epicEdges: IssueMapEdge[] = [];
  for (const e of epics) {
    for (const k of kids.get(e) ?? []) {
      const open = isOpen((byNumber.get(k) as IssueInfo).state);
      epicEdges.push({ from: e, to: k, open, path: "" });
    }
  }

  // The full layout (nothing hidden) is what the boxes carry by default.
  const all = new Set(nodes.map((n) => n.number));
  const layout = packIssueMap({ columns, edges, epicEdges }, all);
  for (const node of nodes) Object.assign(node, layout.positions.get(node.number));
  for (const edge of [...edges, ...epicEdges]) edge.path = layout.paths.get(edgeKey(edge)) ?? "";

  return {
    nodes,
    edges,
    epicEdges,
    columns: layout.columns,
    width: layout.width,
    height: layout.height,
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

/** An epic's "3/5 stories closed", else the assignees (or ""). */
function nodeSubline(node: IssueMapNode): string {
  if (node.kind === "epic") {
    const closed = node.stories.filter((k) => k.state === "CLOSED").length;
    return `${closed}/${node.stories.length} stories closed`;
  }
  if (node.assignees.length === 0) return "";
  return `\u{1F464} ${truncate(node.assignees.join(", "), ASSIGNEE_MAX)}`;
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
    tag: node.kind === "epic" ? "epic" : node.epic !== null ? `epic #${node.epic}` : "",
    title: truncate(node.title, TITLE_MAX),
    assignees: nodeSubline(node),
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

/** What the footer's data-problem line says after the count. */
export const PROBLEMS_EXPLANATION =
  'some "blocked by" links could not be drawn, or two sources disagree. Each one says what ' +
  "it changes on the map and how to fix it on GitHub.";

/** Looks up an issue's title for the problem texts; undefined when it is not on the map. */
export type IssueTitleLookup = (number: number) => string | undefined;

/** A plain-language account of one data problem, for the footer and the export. */
export interface IssueProblemExplanation {
  /** Which issue and what was found, one line. */
  headline: string;
  /** What the map did about it and what that changes on the map. */
  effect: string;
  /** What to change on GitHub so the problem goes away. */
  fix: string;
}

/** The issues the map was built from, as a title lookup for the problem texts. */
export function titleLookup(nodes: IssueMapNode[]): IssueTitleLookup {
  const titles = new Map(nodes.map((n) => [n.number, n.title]));
  return (number) => titles.get(number);
}

const NO_TITLE: IssueTitleLookup = () => undefined;

/** `#12 "Its title"`, or just `#12` when the title is unknown. */
const ref = (number: number, titleOf: IssueTitleLookup): string => {
  const title = titleOf(number);
  return title === undefined ? `#${number}` : `#${number} "${title}"`;
};

const list = (numbers: number[], titleOf: IssueTitleLookup) =>
  numbers.map((n) => ref(n, titleOf)).join(", ");

/**
 * Explain one data problem in plain language: what was found, what the map did
 * about it, and what fixes it on GitHub. The modal and the export print the same.
 */
export function explainProblem(
  problem: IssueLinkProblem,
  titleOf: IssueTitleLookup = NO_TITLE,
): IssueProblemExplanation {
  switch (problem.kind) {
    case "disagreement": {
      const { number, sectionOnly, nativeOnly } = problem;
      const issue = ref(number, titleOf);
      const section = `the "### Blocked by" section in the body of ${issue}`;
      let found: string;
      if (sectionOnly.length > 0 && nativeOnly.length > 0) {
        found =
          `${section} names ${list(sectionOnly, titleOf)} but GitHub's own blocked-by relation ` +
          `does not, and the relation names ${list(nativeOnly, titleOf)} but the section does not`;
      } else if (sectionOnly.length > 0) {
        found = `${section} names ${list(sectionOnly, titleOf)} but GitHub's own blocked-by relation does not`;
      } else {
        found = `GitHub's own blocked-by relation of ${issue} names ${list(nativeOnly, titleOf)} but ${section} does not`;
      }
      return {
        headline: `${issue}: its two "blocked by" sources disagree`,
        effect:
          `${found}. The map keeps every blocker from either source, so nothing is missing ` +
          "here, but one of the two sources is out of date.",
        fix:
          "On GitHub, make the section and the relation name the same blockers, or delete the " +
          "section and keep only the relation.",
      };
    }
    case "epic": {
      const blocked = ref(problem.blocked, titleOf);
      const blocker = ref(problem.blocker, titleOf);
      return {
        headline: `${blocked} is blocked by ${blocker}, which is an epic: link dropped`,
        effect:
          "Epics are containers, not work, so they sit in their own column and never block " +
          `anything. Without this link ${blocked} may sit at a lower level than it should.`,
        fix:
          `On GitHub, block ${blocked} by the concrete issue inside the epic it really waits ` +
          "for, and remove the link to the epic.",
      };
    }
    case "not-loaded": {
      const blocked = ref(problem.blocked, titleOf);
      return {
        headline: `${blocked} is blocked by #${problem.blocker}, which is not on the map: link dropped`,
        effect:
          `#${problem.blocker} is not among the issues the map loaded. It is probably a pull ` +
          "request, an issue in another repository, a typo, or an issue beyond the " +
          `${MAP_ISSUE_LIMIT}-issue load limit. Without this link ${blocked} may sit at a lower ` +
          "level than it should.",
        fix:
          `Open #${problem.blocker} on GitHub. If it is a real issue of this repository, the ` +
          "map hit its load limit; otherwise point the link at the right issue or remove it.",
      };
    }
    default: {
      const blocked = ref(problem.blocked, titleOf);
      const blocker = ref(problem.blocker, titleOf);
      return {
        headline: `${blocked} is blocked by ${blocker}, which closes a loop: link dropped`,
        effect:
          `Following the blocked-by links from ${blocker} leads back to ${blocked}, so neither ` +
          "could ever open. The map drops this one link to break the loop; the other links in " +
          "the loop stay.",
        fix: "Decide which of the two really goes first and remove the link that points the wrong way.",
      };
    }
  }
}

/** The one-line headline of a data problem (see `explainProblem`). */
export function problemText(problem: IssueLinkProblem, titleOf?: IssueTitleLookup): string {
  return explainProblem(problem, titleOf).headline;
}
