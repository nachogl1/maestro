import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buildIssueMap,
  descriptionText,
  type IssueMapKind,
  type IssueMapNode,
  type IssueMapStatus,
  KIND_META,
  KIND_ORDER,
  LEVEL_EXPLANATION,
  MAP_BAND_Y,
  MAP_CHIP_FONT,
  MAP_CHIP_H,
  MAP_CHIP_Y,
  MAP_COL_W,
  MAP_LABEL_Y,
  MAP_NODE_H,
  MAP_NODE_W,
  nodeText,
  problemText,
  STATUS_META,
  STATUS_ORDER,
  walk,
} from "@/lib/issueMap";
import { buildIssueMapHtml } from "@/lib/issueMapHtml";
import { type AuthStatus, useGitHubStore } from "@/stores/useGitHubStore";
import { MAP_ISSUE_LIMIT, type RepoAssignee, useIssueMap } from "./useIssueMap";

interface IssueMapModalProps {
  repoPath: string;
  /** The sidebar's search query, so quick chips like `assignee:@me` still apply. */
  search: string;
  onSelectIssue: (issueNumber: number) => void;
  onClose: () => void;
}

/** Assignee filter key for "nobody assigned". */
const NOBODY = "\u0000nobody";

const HINT =
  "Hover an issue to see its chain and a tooltip. Click to pin, double-click to open it on GitHub. " +
  "Click a legend entry to hide or show that type; each shows shown/total.";

const STATUS_FILL: Record<IssueMapStatus, string> = {
  closed: "rgb(var(--maestro-muted) / 0.22)",
  inprog: "rgb(var(--maestro-yellow) / 0.22)",
  ready: "rgb(var(--maestro-green) / 0.22)",
  blocked: "rgb(var(--maestro-red) / 0.22)",
};

const KIND_STROKE: Record<IssueMapKind, { stroke: string; dash?: string }> = {
  agent: { stroke: "rgb(var(--maestro-blue))" },
  human: { stroke: "rgb(var(--maestro-yellow))" },
  outside: { stroke: "rgb(var(--maestro-text))", dash: "7 4" },
  decision: { stroke: "rgb(var(--maestro-muted))", dash: "5 4" },
};

const EDGE_CLOSED = "rgb(var(--maestro-muted))";
const EDGE_OPEN = "rgb(var(--maestro-red))";
const TEXT = "rgb(var(--maestro-text))";
const MUTED = "rgb(var(--maestro-muted))";
const CROSS = "rgb(var(--maestro-red))";
const CHIP_FILL = "rgb(var(--maestro-card))";
const CHIP_STROKE = "rgb(var(--maestro-border))";
const BAND_FILLS = ["rgb(var(--maestro-card) / 0.45)", "rgb(var(--maestro-card))"];

const toolbarButton =
  "flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-maestro-border bg-maestro-card px-1.5 py-1 text-[11px] text-maestro-muted transition-colors hover:text-maestro-text disabled:opacity-40";

const chipStyle = (status?: IssueMapStatus, kind?: IssueMapKind): React.CSSProperties => ({
  background: status ? STATUS_FILL[status] : "transparent",
  borderColor: kind ? KIND_STROKE[kind].stroke : "rgb(var(--maestro-border))",
  borderStyle: kind?.match(/outside|decision/) ? "dashed" : "solid",
});

/** "owner/repo" from an issue URL, else the last path segment of the checkout. */
function repoLabel(repoPath: string, issueUrl: string | undefined): string {
  const m = issueUrl?.match(/\/\/[^/]+\/([^/]+\/[^/]+)\/issues\//);
  if (m) return m[1];
  return repoPath.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
}

/** Human-readable "12 Oct 2026, 22:52 GMT+1" for the export banner. */
function formatCreatedAt(date: Date): string {
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function fitInWindow(x: number, y: number, box: { width: number; height: number }) {
  let left = x + 16;
  let top = y + 16;
  if (left + box.width > window.innerWidth - 8) left = x - box.width - 16;
  if (top + box.height > window.innerHeight - 8) top = y - box.height - 16;
  return { left: Math.max(8, left), top: Math.max(8, top) };
}

interface LegendEntryProps {
  checked: boolean;
  label: string;
  shown: number;
  total: number;
  swatch?: React.ReactNode;
  onToggle: () => void;
}

function LegendEntry({ checked, label, shown, total, swatch, onToggle }: LegendEntryProps) {
  return (
    <label
      className={`inline-flex cursor-pointer select-none items-center gap-1 rounded-full px-2 py-px text-[12px] text-maestro-text hover:bg-maestro-card ${
        checked ? "" : "line-through opacity-40"
      }`}
    >
      <input
        type="checkbox"
        className="hidden"
        checked={checked}
        onChange={onToggle}
        aria-label={label}
      />
      {swatch}
      {label}
      <span className="text-[11px] text-maestro-muted">
        {shown}/{total}
      </span>
    </label>
  );
}

interface AssignSectionProps {
  node: IssueMapNode;
  repoAssignees: RepoAssignee[];
  setAssignees: (number: number, add: string[], remove: string[]) => Promise<void>;
}

/** Checkbox list of every repo assignee; toggling assigns/unassigns at once. */
function AssignSection({ node, repoAssignees, setAssignees }: AssignSectionProps) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const assigned = new Set(node.assignees);
  // Current assignees missing from the repo list must stay un-assignable.
  const logins = [
    ...repoAssignees.map((a) => a.login),
    ...node.assignees.filter((l) => !repoAssignees.some((r) => r.login === l)),
  ];

  const toggle = async (login: string): Promise<void> => {
    const isAssigned = assigned.has(login);
    setPending(login);
    setError(null);
    try {
      await setAssignees(node.number, isAssigned ? [] : [login], isAssigned ? [login] : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <fieldset
      aria-label={`Assignees for #${node.number}`}
      className="mt-2 border-t border-maestro-border pt-2"
    >
      <b>Assign</b>
      <div className="mt-1 flex max-h-32 flex-wrap gap-1 overflow-auto">
        {logins.length === 0 && <span className="text-maestro-muted">No assignable users</span>}
        {logins.map((login) => (
          <label
            key={login}
            className="flex cursor-pointer items-center gap-1 rounded border border-maestro-border px-1.5 py-0.5 text-[11px] hover:bg-maestro-card"
          >
            <input
              type="checkbox"
              checked={assigned.has(login)}
              disabled={pending !== null}
              onChange={() => void toggle(login)}
              aria-label={login}
            />
            {login}
          </label>
        ))}
      </div>
      {error && <p className="mt-1 text-[11px] text-maestro-red">{error}</p>}
    </fieldset>
  );
}

/**
 * Full-screen map of what is blocked by what, level by level: columns are
 * levels, the background of a box is its progress, the border is who takes it,
 * and every line runs from a blocker to the issue that waits for it.
 */
export function IssueMapModal({ repoPath, search, onSelectIssue, onClose }: IssueMapModalProps) {
  const { issues, links, assignees, isLoading, error, truncated, reload, setAssignees } =
    useIssueMap(repoPath, search);

  const [statusOff, setStatusOff] = useState<Set<IssueMapStatus>>(new Set());
  const [kindOff, setKindOff] = useState<Set<IssueMapKind>>(new Set());
  const [whoOff, setWhoOff] = useState<Set<string>>(new Set());
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [tipAt, setTipAt] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const authStatus = useGitHubStore((s) => s.authStatus);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isLoading && !error) setFetchedAt(new Date());
  }, [isLoading, error]);

  const map = useMemo(() => buildIssueMap(issues, links), [issues, links]);
  const byNumber = useMemo(() => new Map(map.nodes.map((n) => [n.number, n])), [map]);

  const logins = useMemo(() => {
    const set = new Set<string>();
    for (const node of map.nodes) for (const login of node.assignees) set.add(login);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [map]);

  /* ── Filters ── */
  const whoMatches = useCallback(
    (node: IssueMapNode, who: string) =>
      who === NOBODY ? node.assignees.length === 0 : node.assignees.includes(who),
    [],
  );
  const visible = useMemo(() => {
    const set = new Set<number>();
    for (const node of map.nodes) {
      if (statusOff.has(node.status) || kindOff.has(node.kind)) continue;
      const whoOk =
        node.assignees.length > 0
          ? node.assignees.some((a) => !whoOff.has(a))
          : !whoOff.has(NOBODY);
      if (whoOk) set.add(node.number);
    }
    return set;
  }, [map, statusOff, kindOff, whoOff]);

  const toggleIn = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };
  const showAll = () => {
    setStatusOff(new Set());
    setKindOff(new Set());
    setWhoOff(new Set());
  };

  const count = (pred: (node: IssueMapNode) => boolean) => ({
    total: map.nodes.filter(pred).length,
    shown: map.nodes.filter((n) => visible.has(n.number) && pred(n)).length,
  });

  /* ── Focus (hover / pin) ── */
  const focusId = pinned ?? hovered;
  const focus = useMemo(() => {
    if (focusId === null || !byNumber.has(focusId)) return null;
    const up = walk(focusId, map.up);
    const down = walk(focusId, map.down);
    return { up, down, all: new Set([...up, ...down, focusId]) };
  }, [focusId, map, byNumber]);
  const focusNode = focusId !== null ? byNumber.get(focusId) : undefined;

  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!tip) return;
    const { left, top } = fitInWindow(tipAt.x, tipAt.y, tip.getBoundingClientRect());
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }, [tipAt]);

  const place = (ev: React.MouseEvent) => setTipAt({ x: ev.clientX, y: ev.clientY });

  // Esc backs out one level: unpin, else close the modal. Capture phase,
  // because a terminal underneath still holds DOM focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (pinned !== null) setPinned(null);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [pinned, onClose]);

  const openOnGitHub = (node: IssueMapNode) => {
    openUrl(node.url).catch((err) => console.error("Failed to open issue URL:", err));
  };

  // Save the whole map (every issue, filters ignored) as one standalone HTML
  // file to hand around. The banner inside names who saved it and when.
  const handleSave = async (): Promise<void> => {
    setExportError(null);
    setExporting(true);
    try {
      const repo = repoLabel(repoPath, map.nodes[0]?.url);
      const stamp = new Date().toISOString().slice(0, 10);
      const path = await save({
        defaultPath: `issue-map-${repo.replace(/[^\w.-]+/g, "-")}-${stamp}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!path) return;
      let createdBy = authStatus?.username ?? null;
      if (!createdBy) {
        try {
          createdBy = (await invoke<AuthStatus>("github_auth_status", { repoPath })).username;
        } catch (err) {
          console.error("Failed to read the GitHub login for the export banner:", err);
        }
      }
      const content = buildIssueMapHtml(map, {
        repo,
        createdBy: createdBy ?? "unknown user",
        createdAt: formatCreatedAt(new Date()),
      });
      await invoke("export_issue_map", { path, content });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  /* ── Body ── */
  let hint = HINT;
  if (focus && focusId !== null) {
    hint = `#${focusId}: ${focus.up.size} issue(s) upstream must close first (left), ${focus.down.size} wait on it (right).`;
  }

  let body: React.ReactNode;
  if (error) {
    body = (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-maestro-red">
        <div>
          <p>Failed to load issues</p>
          <p className="mt-1 text-xs text-maestro-muted">{error}</p>
        </div>
      </div>
    );
  } else if (isLoading && issues.length === 0) {
    body = (
      <div className="flex h-full items-center justify-center text-sm text-maestro-muted">
        Loading issues...
      </div>
    );
  } else if (map.nodes.length === 0) {
    body = (
      <div className="flex h-full items-center justify-center text-xs text-maestro-muted">
        No issues to map.
      </div>
    );
  } else {
    body = (
      <svg
        width={map.width}
        height={map.height}
        viewBox={`0 0 ${map.width} ${map.height}`}
        role="img"
        aria-label="Issue map"
        className="block"
      >
        {map.columns.map((col) => (
          <g key={col.index}>
            <rect
              x={col.x - (MAP_COL_W - MAP_NODE_W) / 2}
              y={MAP_BAND_Y}
              width={MAP_COL_W}
              height={map.height - MAP_BAND_Y}
              fill={BAND_FILLS[col.index % 2]}
            />
            <text
              x={col.x + MAP_NODE_W / 2}
              y={MAP_LABEL_Y}
              textAnchor="middle"
              fontSize={15}
              fontWeight={700}
              fill={TEXT}
            >
              {col.label}{" "}
              <tspan fontSize={12} fontWeight={500} fill={MUTED}>
                {col.closed}/{col.total} closed
              </tspan>
            </text>
          </g>
        ))}
        {map.edges.map((edge) => {
          const off = !visible.has(edge.from) || !visible.has(edge.to);
          const hl = focus ? focus.all.has(edge.from) && focus.all.has(edge.to) : false;
          let opacity = 0.6;
          if (off) opacity = 0.06;
          else if (focus) opacity = hl ? 1 : 0.12;
          let width = edge.open ? 2 : 1.6;
          if (hl) width = 3;
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              data-from={edge.from}
              data-to={edge.to}
              data-hl={hl ? "true" : undefined}
              d={edge.path}
              fill="none"
              stroke={edge.open ? EDGE_OPEN : EDGE_CLOSED}
              strokeWidth={width}
              opacity={opacity}
            />
          );
        })}
        {map.nodes.map((node) => {
          const text = nodeText(node);
          const off = !visible.has(node.number);
          const hl = focus?.all.has(node.number) ?? false;
          const sel = focusId === node.number;
          let opacity = 1;
          if (off) opacity = 0.06;
          else if (focus) opacity = hl ? 1 : 0.12;
          const kind = KIND_STROKE[node.kind];
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: SVG issue box; keyboard users get the sidebar list
            <g
              key={node.number}
              data-testid={`issue-node-${node.number}`}
              data-status={node.status}
              data-kind={node.kind}
              data-level={node.level}
              data-hl={hl ? "true" : undefined}
              transform={`translate(${node.x},${node.y})`}
              opacity={opacity}
              style={{ cursor: "pointer" }}
              onMouseEnter={(ev) => {
                if (pinned !== null) return;
                setHovered(node.number);
                place(ev);
              }}
              onMouseMove={(ev) => {
                if (pinned === null) place(ev);
              }}
              onMouseLeave={() => {
                if (pinned === null) setHovered(null);
              }}
              onClick={(ev) => {
                if (pinned === node.number) {
                  setPinned(null);
                } else {
                  setPinned(node.number);
                  setHovered(node.number);
                  place(ev);
                }
              }}
              onDoubleClick={() => openOnGitHub(node)}
            >
              <rect
                width={MAP_NODE_W}
                height={MAP_NODE_H}
                rx={7}
                fill={STATUS_FILL[node.status]}
                stroke={kind.stroke}
                strokeWidth={sel ? 7 : 4}
                strokeDasharray={kind.dash}
              />
              {node.status === "closed" && (
                <>
                  <line
                    x1={4}
                    y1={4}
                    x2={MAP_NODE_W - 4}
                    y2={MAP_NODE_H - 4}
                    stroke={CROSS}
                    strokeWidth={2}
                    opacity={0.55}
                    pointerEvents="none"
                  />
                  <line
                    x1={MAP_NODE_W - 4}
                    y1={4}
                    x2={4}
                    y2={MAP_NODE_H - 4}
                    stroke={CROSS}
                    strokeWidth={2}
                    opacity={0.55}
                    pointerEvents="none"
                  />
                </>
              )}
              <text x={10} y={18} fontSize={13} fontWeight={700} fill={TEXT} pointerEvents="none">
                #{node.number} <tspan fontSize={12}>{text.icons}</tspan>
              </text>
              <text
                x={MAP_NODE_W - 10}
                y={18}
                textAnchor="end"
                fontSize={11}
                fill={MUTED}
                pointerEvents="none"
              >
                {text.tag}
              </text>
              <text
                x={10}
                y={36}
                fontSize={12}
                fill={node.kind === "decision" ? MUTED : TEXT}
                fontStyle={node.kind === "decision" ? "italic" : undefined}
                pointerEvents="none"
              >
                {text.title}
              </text>
              <text x={10} y={52} fontSize={11} fontWeight={700} fill={MUTED} pointerEvents="none">
                {text.assignees}
              </text>
              {text.chips.map((chip) => (
                <g
                  key={chip.x}
                  data-testid={`issue-chip-${node.number}`}
                  transform={`translate(${10 + chip.x},${MAP_CHIP_Y})`}
                  pointerEvents="none"
                >
                  <rect
                    width={chip.w}
                    height={MAP_CHIP_H}
                    rx={8}
                    fill={CHIP_FILL}
                    stroke={CHIP_STROKE}
                  />
                  <text
                    x={chip.w / 2}
                    y={MAP_CHIP_H - 4}
                    textAnchor="middle"
                    fontSize={MAP_CHIP_FONT}
                    fill={MUTED}
                  >
                    {chip.text}
                  </text>
                </g>
              ))}
            </g>
          );
        })}
      </svg>
    );
  }

  const linkCount = map.edges.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        role="dialog"
        aria-label="Issue map"
        className="flex h-[94vh] w-[96vw] flex-col overflow-hidden rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl"
      >
        {/* Header */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-maestro-border px-3">
          <h2 className="text-sm font-semibold text-maestro-text">
            Issue map: what is blocked by what, level by level
          </h2>
          <span className="text-[11px] text-maestro-muted">
            {map.nodes.length} issue{map.nodes.length === 1 ? "" : "s"} · {linkCount} blocked-by
            link{linkCount === 1 ? "" : "s"}
          </span>
          {truncated && (
            <span className="text-[11px] text-maestro-yellow">
              ⚠ Showing the first {MAP_ISSUE_LIMIT} issues, links beyond it are dropped.
            </span>
          )}
          <div className="flex-1" />
          {exportError && (
            <span className="truncate text-[11px] text-maestro-red" title={exportError}>
              Save failed: {exportError}
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={exporting || isLoading || map.nodes.length === 0}
            title="Save the map as a standalone HTML file to share"
            className={toolbarButton}
          >
            <Download size={11} />
            Save HTML
          </button>
          <button
            type="button"
            onClick={() => void reload()}
            disabled={isLoading}
            title="Rebuild the map from GitHub"
            className={toolbarButton}
          >
            <RefreshCw size={11} className={isLoading ? "animate-spin" : ""} />
            Reload
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close issue map"
            title="Close (Esc)"
            className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          >
            <X size={14} />
          </button>
        </div>

        {/* Banner + legend */}
        <div className="shrink-0 border-b border-maestro-border px-3 py-2 text-[12px]">
          <div className="mb-2 rounded-md border border-maestro-yellow/40 bg-maestro-yellow/10 px-3 py-1 text-maestro-yellow">
            ⚠ Transient snapshot, not a source of truth. Built from the GitHub issues as they were
            {fetchedAt ? ` at ${fetchedAt.toLocaleString()}` : " when fetched"}; it goes stale as
            soon as any issue changes. Rebuild it with Reload. The live state is always GitHub.
          </div>
          <div className="flex flex-wrap items-center">
            <b className="inline-block w-40 text-maestro-muted">Background = progress</b>
            {STATUS_ORDER.map((status) => {
              const c = count((n) => n.status === status);
              return (
                <LegendEntry
                  key={status}
                  checked={!statusOff.has(status)}
                  label={`${STATUS_META[status].icon} ${STATUS_META[status].name}`}
                  shown={c.shown}
                  total={c.total}
                  swatch={
                    <i
                      className="inline-block h-[18px] w-[18px] rounded-[5px] border-[3px]"
                      style={chipStyle(status)}
                    />
                  }
                  onToggle={() => setStatusOff((s) => toggleIn(s, status))}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap items-center">
            <b className="inline-block w-40 text-maestro-muted">Border = who takes it</b>
            {KIND_ORDER.map((kind) => {
              const c = count((n) => n.kind === kind);
              return (
                <LegendEntry
                  key={kind}
                  checked={!kindOff.has(kind)}
                  label={`${KIND_META[kind].icon} ${KIND_META[kind].name}`}
                  shown={c.shown}
                  total={c.total}
                  swatch={
                    <i
                      className="inline-block h-[18px] w-[18px] rounded-[5px] border-[3px]"
                      style={chipStyle(undefined, kind)}
                    />
                  }
                  onToggle={() => setKindOff((s) => toggleIn(s, kind))}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap items-center">
            <b className="inline-block w-40 text-maestro-muted">Assignee</b>
            {[...logins, NOBODY].map((who) => {
              const c = count((n) => whoMatches(n, who));
              return (
                <LegendEntry
                  key={who}
                  checked={!whoOff.has(who)}
                  label={who === NOBODY ? "nobody assigned" : `\u{1F464} ${who}`}
                  shown={c.shown}
                  total={c.total}
                  onToggle={() => setWhoOff((s) => toggleIn(s, who))}
                />
              );
            })}
            <span className="ml-2 font-bold text-maestro-text">
              Showing {visible.size} of {map.nodes.length} issues
            </span>
            <button
              type="button"
              onClick={showAll}
              className="ml-2 text-[11px] text-maestro-blue hover:underline"
            >
              show all
            </button>
          </div>
          <div className="flex flex-wrap items-center">
            <b className="inline-block w-40 text-maestro-muted">Lines = blocked by</b>
            <span className="mr-3 inline-flex items-center gap-1">
              <i
                className="inline-block h-0 w-[18px] border-t-[3px]"
                style={{ borderColor: EDGE_CLOSED }}
              />
              blocker closed
            </span>
            <span className="mr-3 inline-flex items-center gap-1">
              <i
                className="inline-block h-0 w-[18px] border-t-[3px]"
                style={{ borderColor: EDGE_OPEN }}
              />
              blocker still open
            </span>
          </div>
          <div className="mt-1 text-maestro-muted" data-testid="issue-map-hint">
            {hint}
          </div>
        </div>

        {/* Canvas */}
        <div className="min-h-0 flex-1 overflow-auto p-2" style={{ scrollbarWidth: "thin" }}>
          {body}
        </div>

        <footer className="shrink-0 border-t border-maestro-border px-3 py-1.5 text-[11px] text-maestro-muted">
          {LEVEL_EXPLANATION} A line always runs from the blocker to the issue that waits for it; an
          issue opens the moment every line coming into it is grey.
          {map.problems.length === 0 ? (
            <span data-testid="issue-map-problems"> No data problems.</span>
          ) : (
            <details data-testid="issue-map-problems" className="mt-1">
              <summary className="cursor-pointer">
                {map.problems.length} data problem{map.problems.length === 1 ? "" : "s"} (links
                dropped or sources disagreeing)
              </summary>
              <ul className="mt-1 max-h-24 list-disc overflow-auto pl-4">
                {map.problems.map((p) => {
                  const text = problemText(p);
                  return <li key={text}>{text}</li>;
                })}
              </ul>
            </details>
          )}
        </footer>
      </div>

      {/* Tooltip */}
      {focusNode && (
        <div
          ref={tipRef}
          role="tooltip"
          data-testid="issue-map-tip"
          className={`fixed z-[60] max-w-[480px] rounded-[10px] border border-maestro-border bg-maestro-surface px-3.5 py-2.5 text-[13px] text-maestro-text shadow-xl ${
            pinned === null ? "pointer-events-none" : ""
          }`}
          style={{ left: tipAt.x + 16, top: tipAt.y + 16 }}
        >
          <h3 className="mb-1 text-[14px] font-bold">
            #{focusNode.number} {focusNode.title}
          </h3>
          <div className="my-0.5">
            <b>Progress</b>{" "}
            <span
              className="inline-block rounded-full border-[3px] px-2 font-bold"
              style={chipStyle(focusNode.status)}
            >
              {STATUS_META[focusNode.status].icon} {STATUS_META[focusNode.status].name}
            </span>{" "}
            <span className="text-maestro-muted">{STATUS_META[focusNode.status].meaning}</span>
          </div>
          <div className="my-0.5">
            <b>Who takes it</b>{" "}
            <span
              className="inline-block rounded-full border-[3px] px-2 font-bold"
              style={chipStyle(undefined, focusNode.kind)}
            >
              {KIND_META[focusNode.kind].icon} {KIND_META[focusNode.kind].name}
            </span>{" "}
            <span className="text-maestro-muted">{KIND_META[focusNode.kind].meaning}</span>
          </div>
          <span className="text-maestro-muted">
            Level {focusNode.level} · GitHub state: {focusNode.state}
            {focusNode.assignees.length > 0
              ? ` · assigned to ${focusNode.assignees.join(", ")}`
              : " · nobody assigned"}
          </span>
          <div className="my-0.5" data-testid="issue-map-tip-labels">
            <b>Labels:</b> {focusNode.labels.length === 0 && "none"}
            {focusNode.labels.map((label) => (
              <span
                key={label}
                className={`ml-1 inline-block rounded-full border bg-maestro-card px-1.5 text-[11px] ${
                  label === focusNode.kindLabel
                    ? "border-maestro-text font-bold"
                    : "border-maestro-border"
                }`}
              >
                {label}
              </span>
            ))}
          </div>
          <div className="my-0.5">
            <b>Description</b>
            <div
              data-testid="issue-map-tip-description"
              className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-maestro-border px-1.5 py-1 text-[12px] text-maestro-muted"
            >
              {descriptionText(focusNode.body) || <i>empty</i>}
            </div>
          </div>
          <div className="mt-1.5">
            <b>Blocked by:</b> {focusNode.blockers.length === 0 && "nothing"}
          </div>
          {focusNode.blockers.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {focusNode.blockers.map((b) => (
                <li
                  key={b.number}
                  className={
                    b.state === "OPEN"
                      ? "font-bold text-maestro-red"
                      : "text-maestro-muted line-through"
                  }
                >
                  #{b.number} {b.title} ({b.state.toLowerCase()})
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1.5">
            <b>Waiting on it:</b>{" "}
            {focusNode.waiting.length > 0
              ? focusNode.waiting.map((w) => `#${w}`).join(", ")
              : "nothing"}
          </div>
          {pinned !== null ? (
            <>
              <AssignSection
                node={focusNode}
                repoAssignees={assignees}
                setAssignees={setAssignees}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openOnGitHub(focusNode)}
                  className={toolbarButton}
                >
                  Open on GitHub
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onSelectIssue(focusNode.number);
                    onClose();
                  }}
                  className={toolbarButton}
                >
                  Show in sidebar
                </button>
                <span className="text-[12px] text-maestro-muted">
                  Pinned. Click the box again to unpin.
                </span>
              </div>
            </>
          ) : (
            <div className="mt-1.5 text-[12px] text-maestro-muted">
              Click to pin · double-click opens it on GitHub
            </div>
          )}
        </div>
      )}
    </div>
  );
}
