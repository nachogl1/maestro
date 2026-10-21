import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Check,
  Download,
  GripHorizontal,
  Minus,
  PanelRight,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buildIssueMap,
  descriptionText,
  EPICS_COLUMN,
  edgeKey,
  explainProblem,
  type IssueMapKind,
  type IssueMapNode,
  type IssueMapStatus,
  isKindLabel,
  KIND_FILL,
  KIND_META,
  KIND_ORDER,
  LIMIT_WARNING,
  MAP_BAND_Y,
  MAP_CHIP_FONT,
  MAP_CHIP_H,
  MAP_CHIP_Y,
  MAP_COL_W,
  MAP_LABEL_Y,
  MAP_NODE_H,
  MAP_NODE_W,
  nodeText,
  PROBLEMS_EXPLANATION,
  packIssueMap,
  START_HIDDEN_KINDS,
  START_HIDDEN_STATUSES,
  STATUS_META,
  STATUS_ORDER,
  titleLookup,
  walk,
} from "@/lib/issueMap";
import { buildIssueMapHtml } from "@/lib/issueMapHtml";
import { type AuthStatus, useGitHubStore } from "@/stores/useGitHubStore";
import { IssueMapFilterMenu, type IssueMapFilterOption } from "./IssueMapFilterMenu";
import { type RepoAssignee, useIssueMap } from "./useIssueMap";

interface IssueMapModalProps {
  repoPath: string;
  /** The sidebar's search query, so quick chips like `assignee:@me` still apply. */
  search: string;
  onSelectIssue: (issueNumber: number) => void;
  onClose: () => void;
}

/** Assignee filter key for "nobody assigned". */
const NOBODY = "\u0000nobody";
/** Label filter key for "no other label". */
const NO_LABEL = "\u0000nolabel";

/** The filter menus; at most one is open at a time. */
type FilterMenu = "kind" | "status" | "who" | "label";

const LABELS_NOTE =
  "Every label on the loaded issues except the ones that decide who takes it, so labels the " +
  "team adds later show up here on the next Reload. An issue stays on the map while any of " +
  "its labels is ticked.";

/** Background = who takes it: the kind's palette colour at the box alpha. */
const kindFill = (kind: IssueMapKind): string => `rgb(var(--maestro-${KIND_FILL[kind]}) / 0.22)`;

const BORDER = "rgb(var(--maestro-border))";
const EDGE_CLOSED = "rgb(var(--maestro-muted))";
const EDGE_OPEN = "rgb(var(--maestro-red))";
const EDGE_EPIC = "rgb(var(--maestro-purple))";
const TEXT = "rgb(var(--maestro-text))";
const MUTED = "rgb(var(--maestro-muted))";
const CROSS = "rgb(var(--maestro-red))";
const CHIP_FILL = "rgb(var(--maestro-card))";
const CHIP_STROKE = "rgb(var(--maestro-border))";
const BAND_FILLS = ["rgb(var(--maestro-card) / 0.45)", "rgb(var(--maestro-card))"];

/** Zoom limits and steps, same as the morph map. */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;
/** A press that moves less than this is a click, not a drag. */
const DRAG_THRESHOLD = 4;
/** Pixels of a dragged issue card that must stay on screen so it can be grabbed again. */
const TIP_KEEP = 60;

interface MapView {
  z: number;
  tx: number;
  ty: number;
}

const toolbarButton =
  "flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-maestro-border bg-maestro-card px-1.5 py-1 text-[11px] text-maestro-muted transition-colors hover:text-maestro-text disabled:opacity-40";

/** Filter swatch for "closed": a neutral box with the same red cross the boxes get. */
function ClosedSwatch() {
  return (
    <svg
      className="inline-block h-[14px] w-[14px] shrink-0 rounded-[4px] border-2 border-maestro-border"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <line x1={1} y1={1} x2={11} y2={11} stroke={CROSS} strokeWidth={1.5} />
      <line x1={11} y1={1} x2={1} y2={11} stroke={CROSS} strokeWidth={1.5} />
    </svg>
  );
}

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
 * Map of what is blocked by what, level by level, filling its own window: columns are
 * levels, the background of a box is who takes it, its icon is the progress,
 * a cross means closed, and every line runs from a blocker to the issue that
 * waits for it.
 */
export function IssueMapModal({ repoPath, search, onSelectIssue, onClose }: IssueMapModalProps) {
  const { issues, links, assignees, isLoading, error, truncated, reload, setAssignees } =
    useIssueMap(repoPath, search);

  // Epics and closed issues start hidden, so the first view is the open work.
  const [statusOff, setStatusOff] = useState<Set<IssueMapStatus>>(
    () => new Set(START_HIDDEN_STATUSES),
  );
  const [kindOff, setKindOff] = useState<Set<IssueMapKind>>(() => new Set(START_HIDDEN_KINDS));
  const [whoOff, setWhoOff] = useState<Set<string>>(new Set());
  const [labelOff, setLabelOff] = useState<Set<string>>(new Set());
  const [openMenu, setOpenMenu] = useState<FilterMenu | null>(null);
  // Null until the user toggles the pane; until then it is open whenever there are problems.
  const [problemsPick, setProblemsPick] = useState<boolean | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [tipAt, setTipAt] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [tipHidden, setTipHidden] = useState(false);
  const [view, setView] = useState<MapView>({ z: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const movedRef = useRef(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const authStatus = useGitHubStore((s) => s.authStatus);
  const tipRef = useRef<HTMLDivElement>(null);
  // Where the user dragged the card; once set, later cards open there too.
  const tipSpotRef = useRef<{ left: number; top: number } | null>(null);
  const tipDragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => {
    if (!isLoading && !error) setFetchedAt(new Date());
  }, [isLoading, error]);

  const map = useMemo(() => buildIssueMap(issues, links), [issues, links]);
  const titleOf = useMemo(() => titleLookup(map.nodes), [map.nodes]);
  const byNumber = useMemo(() => new Map(map.nodes.map((n) => [n.number, n])), [map]);

  const logins = useMemo(() => {
    const set = new Set<string>();
    for (const node of map.nodes) for (const login of node.assignees) set.add(login);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [map]);

  // Every label except the ones that decide who takes it, so new team labels show up too.
  const otherLabels = useMemo(
    () => new Map(map.nodes.map((n) => [n.number, n.labels.filter((l) => !isKindLabel(l))])),
    [map],
  );
  const labelNames = useMemo(
    () => Array.from(new Set([...otherLabels.values()].flat())).sort((a, b) => a.localeCompare(b)),
    [otherLabels],
  );
  const labelColor = useMemo(() => {
    const colors = new Map<string, string>();
    for (const issue of issues) for (const l of issue.labels) colors.set(l.name, l.color);
    return colors;
  }, [issues]);

  /* ── Filters ── */
  const whoMatches = useCallback(
    (node: IssueMapNode, who: string) =>
      who === NOBODY ? node.assignees.length === 0 : node.assignees.includes(who),
    [],
  );
  const labelMatches = (node: IssueMapNode, label: string): boolean => {
    const own = otherLabels.get(node.number) ?? [];
    return label === NO_LABEL ? own.length === 0 : own.includes(label);
  };
  const visible = useMemo(() => {
    const set = new Set<number>();
    for (const node of map.nodes) {
      if (statusOff.has(node.status) || kindOff.has(node.kind)) continue;
      const whoOk =
        node.assignees.length > 0
          ? node.assignees.some((a) => !whoOff.has(a))
          : !whoOff.has(NOBODY);
      const own = otherLabels.get(node.number) ?? [];
      const labelOk = own.length > 0 ? own.some((l) => !labelOff.has(l)) : !labelOff.has(NO_LABEL);
      if (whoOk && labelOk) set.add(node.number);
    }
    return set;
  }, [map, statusOff, kindOff, whoOff, labelOff, otherLabels]);

  const showAll = () => {
    setStatusOff(new Set());
    setKindOff(new Set());
    setWhoOff(new Set());
    setLabelOff(new Set());
  };
  const menuProps = (menu: FilterMenu) => ({
    open: openMenu === menu,
    onOpenChange: (open: boolean) => setOpenMenu(open ? menu : null),
  });
  const problemsOpen = problemsPick ?? map.problems.length > 0;

  const count = (pred: (node: IssueMapNode) => boolean) => ({
    total: map.nodes.filter(pred).length,
    shown: map.nodes.filter((n) => visible.has(n.number) && pred(n)).length,
  });

  // Hidden issues leave the map and the rest close up.
  const layout = useMemo(() => packIssueMap(map, visible), [map, visible]);

  /* ── Focus (click only) ── */
  const focusId = pinned;
  const focus = useMemo(() => {
    const node = focusId !== null ? byNumber.get(focusId) : undefined;
    if (!node) return null;
    const up = walk(node.number, map.up);
    const down = walk(node.number, map.down);
    const all = new Set([...up, ...down, node.number, ...node.stories.map((k) => k.number)]);
    if (node.parent !== null) all.add(node.parent);
    return { up, down, all };
  }, [focusId, map, byNumber]);
  const focusNode = focusId !== null ? byNumber.get(focusId) : undefined;

  /* ── Zoom and drag ── */
  // Fit the map's width (capped at 100%) and pin it to the top, like morph.
  const fitMap = useCallback(
    (all: boolean) => {
      const wrap = wrapRef.current;
      if (!wrap || wrap.clientWidth <= 0 || wrap.clientHeight <= 0) return;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      const byHeight = all ? (h - 20) / layout.height : Number.POSITIVE_INFINITY;
      const z = Math.max(MIN_ZOOM, Math.min(1, (w - 20) / layout.width, byHeight));
      setView({
        z,
        tx: (w - layout.width * z) / 2,
        ty: all ? (h - layout.height * z) / 2 : 10,
      });
    },
    [layout],
  );
  // Refit whenever the packed layout changes (a filter, a reload).
  useLayoutEffect(() => fitMap(false), [fitMap]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z * factor));
      return { z, tx: cx - ((cx - v.tx) * z) / v.z, ty: cy - ((cy - v.ty) * z) / v.z };
    });
  }, []);
  const zoomMid = (factor: number) => {
    const wrap = wrapRef.current;
    zoomAt(factor, (wrap?.clientWidth ?? 0) / 2, (wrap?.clientHeight ?? 0) / 2);
  };

  // Wheel zoom needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = wrap.getBoundingClientRect();
      zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (!movedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      movedRef.current = true;
      setDragging(true);
      // A card the user moved is no longer tied to its box, so it stays up.
      if (!tipSpotRef.current) setTipHidden(true);
      setView((v) => ({ ...v, tx: drag.tx + dx, ty: drag.ty + dy }));
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const onPointerDown = (ev: React.PointerEvent) => {
    if (ev.button !== 0 || (ev.target as Element).closest("[data-zoom-controls]")) return;
    dragRef.current = { x: ev.clientX, y: ev.clientY, tx: view.tx, ty: view.ty };
    movedRef.current = false;
  };
  // A drag that ends on a box must not also click it.
  const onClickCapture = (ev: React.MouseEvent) => {
    if (movedRef.current) {
      ev.stopPropagation();
      movedRef.current = false;
    }
  };

  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!tip) return;
    const { left, top } =
      tipSpotRef.current ?? fitInWindow(tipAt.x, tipAt.y, tip.getBoundingClientRect());
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }, [tipAt]);

  const place = (ev: React.MouseEvent) => setTipAt({ x: ev.clientX, y: ev.clientY });

  // Drag the card by its title bar so it stops covering the boxes behind it.
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const drag = tipDragRef.current;
      const tip = tipRef.current;
      if (!drag || !tip) return;
      const left = Math.min(
        window.innerWidth - TIP_KEEP,
        Math.max(0, drag.left + ev.clientX - drag.x),
      );
      const top = Math.min(
        window.innerHeight - TIP_KEEP,
        Math.max(0, drag.top + ev.clientY - drag.y),
      );
      tipSpotRef.current = { left, top };
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };
    const onUp = () => {
      tipDragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const onTipGrab = (ev: React.PointerEvent) => {
    const tip = tipRef.current;
    if (ev.button !== 0 || !tip) return;
    ev.preventDefault();
    const r = tip.getBoundingClientRect();
    tipDragRef.current = { x: ev.clientX, y: ev.clientY, left: r.left, top: r.top };
  };

  // Esc backs out one level: close a filter menu, else unpin, else close the map window.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (openMenu !== null) setOpenMenu(null);
      else if (pinned !== null) setPinned(null);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [openMenu, pinned, onClose]);

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
        truncated,
      });
      await invoke("export_issue_map", { path, content });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  /* ── Body ── */
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
      <svg width="100%" height="100%" role="img" aria-label="Issue map" className="block">
        <g
          data-testid="issue-map-viewport"
          transform={`translate(${view.tx},${view.ty}) scale(${view.z})`}
        >
          {layout.columns.map((col) => (
            <g key={col.label} data-testid={`issue-map-column-${col.label}`}>
              <rect
                x={col.x - (MAP_COL_W - MAP_NODE_W) / 2}
                y={MAP_BAND_Y}
                width={MAP_COL_W}
                height={layout.height - MAP_BAND_Y}
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
            const path = layout.paths.get(edgeKey(edge));
            if (!path) return null;
            const hl = focus ? focus.all.has(edge.from) && focus.all.has(edge.to) : false;
            let opacity = 0.6;
            if (focus) opacity = hl ? 1 : 0.12;
            let width = edge.open ? 2 : 1.6;
            if (hl) width = 3;
            return (
              <path
                key={edgeKey(edge)}
                data-from={edge.from}
                data-to={edge.to}
                data-hl={hl ? "true" : undefined}
                d={path}
                fill="none"
                stroke={edge.open ? EDGE_OPEN : EDGE_CLOSED}
                strokeWidth={width}
                opacity={opacity}
              />
            );
          })}
          {map.epicEdges.map((edge) => {
            const path = layout.paths.get(edgeKey(edge));
            if (!path) return null;
            const hl = focus ? focus.all.has(edge.from) && focus.all.has(edge.to) : false;
            let opacity = 0.45;
            if (focus) opacity = hl ? 1 : 0.12;
            return (
              <path
                key={`epic:${edgeKey(edge)}`}
                data-testid={`issue-map-epic-edge-${edge.from}-${edge.to}`}
                data-hl={hl ? "true" : undefined}
                d={path}
                fill="none"
                stroke={EDGE_EPIC}
                strokeWidth={hl ? 3 : 1.6}
                strokeDasharray="5 4"
                opacity={opacity}
              />
            );
          })}
          {map.nodes.map((node) => {
            const pos = layout.positions.get(node.number);
            if (!pos) return null;
            const text = nodeText(node);
            const hl = focus?.all.has(node.number) ?? false;
            const sel = focusId === node.number;
            let opacity = 1;
            if (focus) opacity = hl ? 1 : 0.12;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: SVG issue box; keyboard users get the sidebar list
              <g
                key={node.number}
                data-testid={`issue-node-${node.number}`}
                data-status={node.status}
                data-kind={node.kind}
                data-level={node.level}
                data-hl={hl ? "true" : undefined}
                transform={`translate(${pos.x},${pos.y})`}
                opacity={opacity}
                style={{ cursor: "pointer" }}
                onClick={(ev) => {
                  if (pinned === node.number) {
                    setPinned(null);
                  } else {
                    setPinned(node.number);
                    setTipHidden(false);
                    place(ev);
                  }
                }}
                onDoubleClick={() => openOnGitHub(node)}
              >
                <rect
                  width={MAP_NODE_W}
                  height={MAP_NODE_H}
                  rx={7}
                  fill={kindFill(node.kind)}
                  stroke={BORDER}
                  strokeWidth={sel ? 7 : 4}
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
                <text
                  x={10}
                  y={52}
                  fontSize={11}
                  fontWeight={700}
                  fill={MUTED}
                  pointerEvents="none"
                >
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
        </g>
      </svg>
    );
  }

  const linkCount = map.edges.length;
  const epicCount = map.nodes.filter((n) => n.kind === "epic").length;
  const issueCount = map.nodes.length - epicCount;

  /* ── Filter menus ── */
  const kindOptions: IssueMapFilterOption<IssueMapKind>[] = KIND_ORDER.map((kind) => ({
    value: kind,
    label: KIND_META[kind].name,
    swatch: (
      <i
        className="inline-block h-[14px] w-[14px] shrink-0 rounded-[4px] border-2 border-maestro-border"
        style={{ background: kindFill(kind) }}
      />
    ),
    ...count((n) => n.kind === kind),
  }));
  // The open states first, then Closed.
  const progressOrder: IssueMapStatus[] = [
    ...STATUS_ORDER.filter((status) => status !== "closed"),
    "closed",
  ];
  const statusOptions: IssueMapFilterOption<IssueMapStatus>[] = progressOrder.map((status) => ({
    value: status,
    label:
      status === "closed"
        ? STATUS_META.closed.name
        : `${STATUS_META[status].icon} ${STATUS_META[status].name}`,
    swatch: status === "closed" ? <ClosedSwatch /> : undefined,
    ...count((n) => n.status === status),
  }));
  const whoOptions: IssueMapFilterOption<string>[] = [...logins, NOBODY].map((who) => ({
    value: who,
    label: who === NOBODY ? "nobody assigned" : `\u{1F464} ${who}`,
    apart: who === NOBODY,
    ...count((n) => whoMatches(n, who)),
  }));
  const labelOptions: IssueMapFilterOption<string>[] = [...labelNames, NO_LABEL].map((label) => ({
    value: label,
    label: label === NO_LABEL ? "no other label" : label,
    apart: label === NO_LABEL,
    swatch:
      label === NO_LABEL ? undefined : (
        <i
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-maestro-border"
          style={{ background: `#${labelColor.get(label) ?? "cfd3d7"}` }}
        />
      ),
    ...count((n) => labelMatches(n, label)),
  }));

  /* ── Data problems pane ── */
  const problemCount = map.problems.length;
  const problemsTitle =
    problemCount === 0
      ? "No data problems"
      : `${problemCount} data problem${problemCount === 1 ? "" : "s"}`;
  let problemsTone = "border-maestro-border text-maestro-muted hover:text-maestro-text";
  if (problemCount > 0) problemsTone = "border-maestro-yellow/40 text-maestro-yellow";
  let problemsFill = "bg-maestro-card";
  if (problemsOpen)
    problemsFill = problemCount > 0 ? "bg-maestro-yellow/10" : "bg-maestro-border/50";

  return (
    <div className="fixed inset-0 flex bg-maestro-bg">
      <main aria-label="Issue map" className="flex h-full w-full flex-col overflow-hidden">
        {/* Header */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-maestro-border px-3">
          <h2 className="text-sm font-semibold text-maestro-text">
            Issue map: what is blocked by what, level by level
          </h2>
          <span className="text-[11px] text-maestro-muted">
            {issueCount} issue{issueCount === 1 ? "" : "s"} + {epicCount} epic
            {epicCount === 1 ? "" : "s"} · {linkCount} blocked-by link{linkCount === 1 ? "" : "s"}
          </span>
          {truncated && <span className="text-[11px] text-maestro-yellow">{LIMIT_WARNING}</span>}
          <div className="flex-1" />
          {exportError && (
            <span className="truncate text-[11px] text-maestro-red" title={exportError}>
              Save failed: {exportError}
            </span>
          )}
          {map.nodes.length > 0 && (
            <button
              type="button"
              onClick={() => setProblemsPick(!problemsOpen)}
              aria-pressed={problemsOpen}
              title="Show or hide the data problems"
              className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 py-1 text-[11px] transition-colors ${problemsTone} ${problemsFill}`}
            >
              {problemCount > 0 ? <AlertTriangle size={11} /> : <Check size={11} />}
              {problemsTitle}
              <PanelRight size={11} />
            </button>
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

        {/* Banner + filters */}
        <div className="shrink-0 border-b border-maestro-border px-3 py-2 text-[12px]">
          <div className="mb-2 rounded-md border border-maestro-yellow/40 bg-maestro-yellow/10 px-3 py-1 text-maestro-yellow">
            ⚠ Transient snapshot, not a source of truth. Built from the GitHub issues as they were
            {fetchedAt ? ` at ${fetchedAt.toLocaleString()}` : " when fetched"}; it goes stale as
            soon as any issue changes. Rebuild it with Reload. The live state is always GitHub.
          </div>
          <div className="flex flex-wrap items-center gap-1.5" data-testid="issue-map-filters">
            <b className="mr-1 text-maestro-muted">Filters</b>
            <IssueMapFilterMenu
              name="Who takes it"
              options={kindOptions}
              off={kindOff}
              onChange={setKindOff}
              {...menuProps("kind")}
            />
            <IssueMapFilterMenu
              name="Progress"
              options={statusOptions}
              off={statusOff}
              onChange={setStatusOff}
              {...menuProps("status")}
            />
            <IssueMapFilterMenu
              name="Assignee"
              options={whoOptions}
              off={whoOff}
              onChange={setWhoOff}
              {...menuProps("who")}
            />
            <IssueMapFilterMenu
              name="Labels"
              options={labelOptions}
              off={labelOff}
              onChange={setLabelOff}
              searchable
              note={LABELS_NOTE}
              {...menuProps("label")}
            />
            <span className="ml-1 font-bold text-maestro-text">
              Showing {visible.size} of {map.nodes.length} issues
            </span>
            <button
              type="button"
              onClick={showAll}
              className="text-[11px] text-maestro-blue hover:underline"
            >
              show all
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Canvas */}
          <div
            ref={wrapRef}
            data-testid="issue-map-canvas"
            className={`relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden ${
              dragging ? "cursor-grabbing" : "cursor-grab"
            }`}
            onPointerDown={onPointerDown}
            onClickCapture={onClickCapture}
          >
            <div
              data-zoom-controls
              className="absolute top-3 right-4 z-10 flex items-center gap-1.5 rounded-lg border border-maestro-border bg-maestro-surface px-2 py-1 shadow-xl"
            >
              <button
                type="button"
                onClick={() => zoomMid(ZOOM_STEP)}
                title="Zoom in"
                aria-label="Zoom in"
                className={toolbarButton}
              >
                <Plus size={11} />
              </button>
              <button
                type="button"
                onClick={() => zoomMid(1 / ZOOM_STEP)}
                title="Zoom out"
                aria-label="Zoom out"
                className={toolbarButton}
              >
                <Minus size={11} />
              </button>
              <button
                type="button"
                onClick={() => fitMap(true)}
                title="Fit the whole map"
                className={toolbarButton}
              >
                Fit
              </button>
              <button
                type="button"
                onClick={() => zoomMid(1 / view.z)}
                title="Actual size"
                className={toolbarButton}
              >
                100%
              </button>
              <span
                data-testid="issue-map-zoom"
                className="min-w-[40px] text-right text-[11px] text-maestro-muted"
              >
                {Math.round(view.z * 100)}%
              </span>
            </div>
            {body}
          </div>
          {problemsOpen && map.nodes.length > 0 && (
            <aside
              aria-label="Data problems"
              data-testid="issue-map-problems"
              className="flex w-[380px] shrink-0 flex-col border-l border-maestro-border bg-maestro-surface"
            >
              <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-maestro-border pr-1.5 pl-3 text-[13px] font-semibold text-maestro-text">
                {problemCount > 0 ? (
                  <AlertTriangle size={14} className="shrink-0 text-maestro-yellow" />
                ) : (
                  <Check size={14} className="shrink-0 text-maestro-green" />
                )}
                {problemsTitle}
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => setProblemsPick(false)}
                  aria-label="Hide data problems"
                  title="Hide"
                  className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
                >
                  <X size={14} />
                </button>
              </div>
              {problemCount === 0 ? (
                <p className="m-0 px-3 py-4 text-[12px] text-maestro-muted">
                  Every "blocked by" link was drawn and no two sources disagree.
                </p>
              ) : (
                <>
                  <p className="m-0 shrink-0 border-b border-maestro-border px-3 py-2 text-[11px] text-maestro-muted">
                    {PROBLEMS_EXPLANATION.charAt(0).toUpperCase()}
                    {PROBLEMS_EXPLANATION.slice(1)}
                  </p>
                  <ul className="m-0 min-h-0 flex-1 list-none overflow-auto px-2.5 py-2">
                    {map.problems.map((p) => {
                      const { headline, effect, fix } = explainProblem(p, titleOf);
                      return (
                        <li
                          key={headline}
                          className="mb-2 rounded-md border border-l-[3px] border-maestro-border border-l-maestro-yellow bg-maestro-card px-2.5 py-2 text-[12px]"
                        >
                          <div className="font-semibold text-maestro-text">{headline}</div>
                          <div className="mt-[3px] text-maestro-muted">{effect}</div>
                          <div className="mt-1 text-maestro-muted">
                            <b className="text-maestro-text">Fix:</b> {fix}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </aside>
          )}
        </div>
      </main>

      {/* Tooltip */}
      {focusNode && !tipHidden && (
        <div
          ref={tipRef}
          role="tooltip"
          data-testid="issue-map-tip"
          className="fixed z-[60] max-w-[480px] rounded-[10px] border border-maestro-border bg-maestro-surface px-3.5 py-2.5 text-[13px] text-maestro-text shadow-xl"
          style={{ left: tipAt.x + 16, top: tipAt.y + 16 }}
        >
          <div
            data-testid="issue-map-tip-handle"
            title="Drag to move this card"
            className="-mx-1 mb-1 flex cursor-grab touch-none select-none items-start gap-1.5 rounded px-1 hover:bg-maestro-card active:cursor-grabbing"
            onPointerDown={onTipGrab}
          >
            <GripHorizontal size={14} className="mt-[3px] shrink-0 text-maestro-muted" />
            <h3 className="text-[14px] font-bold">
              #{focusNode.number} {focusNode.title}
            </h3>
          </div>
          <div className="my-0.5">
            <b>Progress</b>{" "}
            <span
              data-testid="issue-map-tip-progress"
              className="inline-block rounded-full border-[3px] border-maestro-border px-2 font-bold"
            >
              {STATUS_META[focusNode.status].icon} {STATUS_META[focusNode.status].name}
            </span>{" "}
            <span className="text-maestro-muted">{STATUS_META[focusNode.status].meaning}</span>
          </div>
          <div className="my-0.5">
            <b>Who takes it</b>{" "}
            <span
              data-testid="issue-map-tip-kind"
              className="inline-block rounded-full border-[3px] border-maestro-border px-2 font-bold"
              style={{ background: kindFill(focusNode.kind) }}
            >
              {KIND_META[focusNode.kind].name}
            </span>{" "}
            <span className="text-maestro-muted">{KIND_META[focusNode.kind].meaning}</span>
          </div>
          <span className="text-maestro-muted">
            {focusNode.kind === "epic" ? EPICS_COLUMN : `Level ${focusNode.level}`} · GitHub state:{" "}
            {focusNode.state}
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
          {focusNode.kind === "epic" ? (
            <>
              <div className="mt-1.5" data-testid="issue-map-tip-stories">
                <b>Stories:</b> {focusNode.stories.length === 0 && "none linked as sub-issues"}
              </div>
              {focusNode.stories.length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {focusNode.stories.map((k) => (
                    <li
                      key={k.number}
                      className={k.state === "CLOSED" ? "text-maestro-muted line-through" : ""}
                    >
                      #{k.number} {k.title} ({k.state.toLowerCase()})
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              {focusNode.parent !== null && (
                <div className="my-0.5" data-testid="issue-map-tip-epic">
                  <b>Epic</b> #{focusNode.parent} {byNumber.get(focusNode.parent)?.title}
                </div>
              )}
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
            </>
          )}
          <AssignSection node={focusNode} repoAssignees={assignees} setAssignees={setAssignees} />
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={() => openOnGitHub(focusNode)} className={toolbarButton}>
              Open on GitHub
            </button>
            <button
              type="button"
              onClick={() => onSelectIssue(focusNode.number)}
              className={toolbarButton}
            >
              Show in sidebar
            </button>
            <span className="text-[12px] text-maestro-muted">
              Click the box again to clear · double-click opens it on GitHub · drag the title to
              move this card
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
