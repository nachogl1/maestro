import {
  Background,
  BackgroundVariant,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  type NodeMouseHandler,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import { LayoutGrid, RefreshCw, X } from "lucide-react";
import { buildIssueGraph, layoutIssueGraph, type XY } from "@/lib/issueGraph";
import type { IssueInfo, PrLabel } from "@/stores/useGitHubStore";
import {
  type IssueHierarchyActions,
  IssueHierarchyActionsProvider,
  type IssueNodeData,
  issueHierarchyNodeTypes,
} from "./IssueHierarchyNode";
import { useIssueHierarchy } from "./useIssueHierarchy";

interface IssueHierarchyModalProps {
  repoPath: string;
  /** The sidebar's search query, so quick chips like `assignee:@me` still apply. */
  search: string;
  onSelectIssue: (issueNumber: number) => void;
  onClose: () => void;
}

type StateFilter = "open" | "closed" | "all";
type LabelMode = "include" | "exclude";

const STATE_FILTERS: Array<{ value: StateFilter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

/** Assignee chip key for "no assignee at all". */
const UNASSIGNED = "\u0000unassigned";

const EDGE_STROKE = "rgb(var(--maestro-muted))";
const BACK_EDGE_STROKE = "rgb(var(--maestro-red))";

const toolbarButton =
  "flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-maestro-border bg-maestro-card px-1.5 py-1 text-[11px] text-maestro-muted transition-colors hover:text-maestro-text disabled:opacity-40";

/** Client-side filtering over the fetched superset, applied before the graph is built. */
function filterIssues(
  issues: IssueInfo[],
  state: StateFilter,
  labelModes: Record<string, LabelMode>,
  assigneeFilter: Set<string>,
): IssueInfo[] {
  const included = Object.keys(labelModes).filter((name) => labelModes[name] === "include");
  const excluded = Object.keys(labelModes).filter((name) => labelModes[name] === "exclude");
  return issues.filter((issue) => {
    const issueState = issue.state.toUpperCase();
    if (state === "open" && issueState !== "OPEN") return false;
    if (state === "closed" && issueState === "OPEN") return false;
    const names = new Set(issue.labels.map((l) => l.name));
    if (!included.every((name) => names.has(name))) return false;
    if (excluded.some((name) => names.has(name))) return false;
    if (assigneeFilter.size > 0) {
      const assignees = issue.assignees ?? [];
      const hit =
        (assignees.length === 0 && assigneeFilter.has(UNASSIGNED)) ||
        assignees.some((a) => assigneeFilter.has(a.login));
      if (!hit) return false;
    }
    return true;
  });
}

function edgeFor(edge: ReturnType<typeof buildIssueGraph>["edges"][number]): Edge {
  const stroke = edge.backEdge ? BACK_EDGE_STROKE : EDGE_STROKE;
  let dash: string | undefined;
  if (edge.inferred) dash = "6 4";
  else if (edge.kind === "parent") dash = "2 4";
  return {
    id: edge.id,
    source: String(edge.source),
    target: String(edge.target),
    markerEnd: edge.kind === "blocks" ? { type: MarkerType.ArrowClosed, color: stroke } : undefined,
    style: {
      stroke,
      strokeWidth: 1.5,
      strokeDasharray: dash,
      opacity: edge.inferred ? 0.55 : 0.9,
    },
  };
}

function nextLabelMode(mode: LabelMode | undefined): LabelMode | undefined {
  if (mode === undefined) return "include";
  if (mode === "include") return "exclude";
  return undefined;
}

function IssueHierarchyCanvas({
  repoPath,
  search,
  onSelectIssue,
  onClose,
}: IssueHierarchyModalProps) {
  const { issues, links, assignees, isLoading, error, reload, setAssignees } = useIssueHierarchy(
    repoPath,
    search,
  );
  const { fitView } = useReactFlow();

  const [stateFilter, setStateFilter] = useState<StateFilter>("open");
  const [labelModes, setLabelModes] = useState<Record<string, LabelMode>>({});
  const [assigneeFilter, setAssigneeFilter] = useState<Set<string>>(new Set());
  const [manualPositions, setManualPositions] = useState<Record<number, XY>>({});
  const [assignOpenFor, setAssignOpenFor] = useState<number | null>(null);

  /* ── Filter chips come from the fetched superset ── */
  const allLabels = useMemo<PrLabel[]>(() => {
    const byName = new Map<string, PrLabel>();
    for (const issue of issues) for (const l of issue.labels) byName.set(l.name, l);
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [issues]);

  const allLogins = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const issue of issues) for (const a of issue.assignees ?? []) set.add(a.login);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [issues]);

  /* ── Graph ── */
  const visibleIssues = useMemo(
    () => filterIssues(issues, stateFilter, labelModes, assigneeFilter),
    [issues, stateFilter, labelModes, assigneeFilter],
  );
  const graph = useMemo(() => buildIssueGraph(visibleIssues, links), [visibleIssues, links]);
  const layout = useMemo(() => layoutIssueGraph(graph), [graph]);

  const model = useMemo(() => {
    const nodes: Node[] = graph.nodes.map((n) => {
      const data: IssueNodeData = { ...n };
      return {
        id: String(n.number),
        type: "issue",
        position: manualPositions[n.number] ?? layout.get(n.number) ?? { x: 0, y: 0 },
        data,
        // Lift the node whose assign popover is open above its neighbours.
        zIndex: assignOpenFor === n.number ? 1000 : undefined,
      };
    });
    return { nodes, edges: graph.edges.map(edgeFor) };
  }, [graph, layout, manualPositions, assignOpenFor]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Keep what React Flow already measured on a node (merge, don't replace).
  useEffect(() => {
    setNodes((previous) => {
      const byId = new Map(previous.map((n) => [n.id, n]));
      return model.nodes.map((node) => {
        const existing = byId.get(node.id);
        return existing ? { ...existing, ...node } : node;
      });
    });
  }, [model.nodes, setNodes]);

  useEffect(() => {
    setEdges(model.edges);
  }, [model.edges, setEdges]);

  /* ── Camera ── */
  const fitAll = useCallback(() => {
    fitView({ duration: 300, padding: 0.12 });
  }, [fitView]);

  // Fit once after the first load, and only after React Flow measured the nodes.
  const nodesInitialized = useNodesInitialized();
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || !nodesInitialized || isLoading) return;
    fittedRef.current = true;
    fitView({ padding: 0.12 });
  }, [nodesInitialized, isLoading, fitView]);

  const handleReorganize = useCallback(() => {
    setManualPositions({});
    requestAnimationFrame(fitAll);
  }, [fitAll]);

  /* ── Interaction ── */
  const handleNodeClick = useCallback<NodeMouseHandler>(
    (_, node) => {
      onSelectIssue(Number(node.id));
      onClose();
    },
    [onSelectIssue, onClose],
  );

  // Esc backs out one level: close the assign popover, else the modal.
  // Capture phase, because a terminal underneath still holds DOM focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (assignOpenFor !== null) setAssignOpenFor(null);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [assignOpenFor, onClose]);

  const actions = useMemo<IssueHierarchyActions>(
    () => ({ repoAssignees: assignees, assignOpenFor, setAssignOpenFor, setAssignees }),
    [assignees, assignOpenFor, setAssignees],
  );

  const toggleLabel = (name: string) => {
    setLabelModes((current) => {
      const next = { ...current };
      const mode = nextLabelMode(current[name]);
      if (mode) next[name] = mode;
      else delete next[name];
      return next;
    });
  };

  const toggleAssignee = (key: string) => {
    setAssigneeFilter((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const issueCount = graph.nodes.filter((n) => !n.stub).length;
  const linkCount = graph.edges.length;

  let canvasBody: React.ReactNode;
  if (error) {
    canvasBody = (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-maestro-red">
        <div>
          <p>Failed to load issues</p>
          <p className="mt-1 text-xs text-maestro-muted">{error}</p>
        </div>
      </div>
    );
  } else if (isLoading && issues.length === 0) {
    canvasBody = (
      <div className="flex h-full items-center justify-center text-sm text-maestro-muted">
        Loading issues...
      </div>
    );
  } else if (graph.nodes.length === 0) {
    canvasBody = (
      <div className="flex h-full items-center justify-center text-xs text-maestro-muted">
        No issues match the current filters.
      </div>
    );
  } else {
    canvasBody = (
      <IssueHierarchyActionsProvider value={actions}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={issueHierarchyNodeTypes}
          onNodeClick={handleNodeClick}
          onNodeDragStop={(_, node) =>
            setManualPositions((current) => ({ ...current, [Number(node.id)]: node.position }))
          }
          onPaneClick={() => setAssignOpenFor(null)}
          nodesConnectable={false}
          edgesFocusable={false}
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={26}
            size={1}
            color="rgb(var(--maestro-border))"
          />
          <MiniMap
            pannable
            zoomable
            ariaLabel="Issue hierarchy minimap"
            bgColor="rgb(var(--maestro-surface))"
            maskColor="rgb(var(--maestro-bg) / 0.7)"
            nodeColor={(node) => {
              const data = node.data as IssueNodeData;
              if (data.stub) return "rgb(var(--maestro-muted))";
              return data.state.toUpperCase() === "OPEN"
                ? "rgb(var(--maestro-green))"
                : "rgb(var(--maestro-purple))";
            }}
            className="!bottom-3 !right-3 rounded border border-maestro-border"
          />
        </ReactFlow>
      </IssueHierarchyActionsProvider>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        role="dialog"
        aria-label="Issue hierarchy"
        className="flex h-[94vh] w-[96vw] flex-col overflow-hidden rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl"
      >
        {/* Header */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-maestro-border px-3">
          <h2 className="text-sm font-semibold text-maestro-text">Issue hierarchy</h2>
          <span className="text-[11px] text-maestro-muted">
            {issueCount} issue{issueCount === 1 ? "" : "s"} · {linkCount} link
            {linkCount === 1 ? "" : "s"}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void reload()}
            disabled={isLoading}
            title="Reload issues and links"
            className={toolbarButton}
          >
            <RefreshCw size={11} className={isLoading ? "animate-spin" : ""} />
            Reload
          </button>
          <button
            type="button"
            onClick={handleReorganize}
            title="Undo every drag — re-run the tidy layout"
            className={toolbarButton}
          >
            <LayoutGrid size={11} />
            Reorganize
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close issue hierarchy"
            title="Close (Esc)"
            className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          >
            <X size={14} />
          </button>
        </div>

        {/* Toolbar: filters */}
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-maestro-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-1">
            {STATE_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={stateFilter === f.value}
                onClick={() => setStateFilter(f.value)}
                className={`rounded-full px-2 py-0.5 text-xs transition-colors ${
                  stateFilter === f.value
                    ? "bg-maestro-accent text-white"
                    : "bg-maestro-card text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
                }`}
              >
                {f.label}
              </button>
            ))}
            {allLabels.length > 0 && <span className="mx-1 h-4 w-px bg-maestro-border" />}
            {allLabels.map((label) => {
              const mode = labelModes[label.name];
              let style: React.CSSProperties = {
                backgroundColor: `#${label.color}20`,
                color: `#${label.color}`,
              };
              if (mode === "include") {
                style = { backgroundColor: `#${label.color}`, color: "#fff" };
              }
              return (
                <button
                  key={label.name}
                  type="button"
                  data-mode={mode ?? "neutral"}
                  title={`Label ${label.name}: click to include, again to exclude, again to clear`}
                  onClick={() => toggleLabel(label.name)}
                  style={mode === "exclude" ? undefined : style}
                  className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                    mode === "exclude"
                      ? "border border-maestro-red text-maestro-red line-through"
                      : "border border-transparent"
                  }`}
                >
                  {label.name}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[10px] text-maestro-muted">Assignee:</span>
            {[
              { key: UNASSIGNED, label: "Unassigned" },
              ...allLogins.map((l) => ({ key: l, label: l })),
            ].map((chip) => (
              <button
                key={chip.key}
                type="button"
                aria-pressed={assigneeFilter.has(chip.key)}
                onClick={() => toggleAssignee(chip.key)}
                className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                  assigneeFilter.has(chip.key)
                    ? "bg-maestro-purple/20 text-maestro-purple"
                    : "bg-maestro-card/60 text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-3 text-[10px] text-maestro-muted">
            <LegendLine dash={undefined} label="blocks" />
            <LegendLine dash="2 4" label="epic / child" />
            <LegendLine dash="6 4" label="inferred from text" />
            <LegendLine dash={undefined} label="cycle" stroke={BACK_EDGE_STROKE} />
            <span className="flex items-center gap-1">
              <span className="h-2.5 w-4 rounded-sm border border-dashed border-maestro-border bg-maestro-card/40" />
              outside filter
            </span>
          </div>
        </div>

        {/* Canvas */}
        <div className="relative min-h-0 flex-1">{canvasBody}</div>
      </div>
    </div>
  );
}

interface LegendLineProps {
  dash: string | undefined;
  label: string;
  stroke?: string;
}

function LegendLine({ dash, label, stroke = EDGE_STROKE }: LegendLineProps) {
  return (
    <span className="flex items-center gap-1">
      <svg width="24" height="6" aria-hidden="true">
        <line
          x1="0"
          y1="3"
          x2="24"
          y2="3"
          stroke={stroke}
          strokeWidth="1.5"
          strokeDasharray={dash}
        />
      </svg>
      {label}
    </span>
  );
}

/**
 * Full-screen graph of how the repo's issues relate: blockers, epics and their
 * children, and links inferred from issue text. React Flow's camera API needs
 * a provider above the component that uses it.
 */
export function IssueHierarchyModal(props: IssueHierarchyModalProps) {
  return (
    <ReactFlowProvider>
      <IssueHierarchyCanvas {...props} />
    </ReactFlowProvider>
  );
}
