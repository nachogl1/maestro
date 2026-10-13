import {
  Background,
  BackgroundVariant,
  BaseEdge,
  type Connection,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Loader2,
  Maximize2,
  Plus,
  RotateCcw,
  Trash2,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_PR_WORKFLOW } from "@/lib/prWorkflow";
import { type SamuraiWorkflowGraph, samuraiDefaultWorkflow } from "@/lib/samurai";
import {
  addWorkflowNode,
  connectWorkflow,
  removeWorkflowEdge,
  removeWorkflowNode,
  setWorkflowNodeLabel,
  setWorkflowNodeText,
  setWorkflowStart,
  workflowWalkOrder,
} from "@/lib/workflowGraph";
import { usePrWorkflowStore } from "@/stores/usePrWorkflowStore";
import { useSamuraiWorkflowStore } from "@/stores/useSamuraiWorkflowStore";

/**
 * Full-screen editor for the workflow graphs (issue #91 Part B, promoted out
 * of the Launch tab's sidebar card to its own overlay). Step text is edited
 * in place; steps can be added, removed and rewired. Opened from
 * `LaunchSection` via `useWorkflowsViewStore`, rendered by `App` next to
 * the old landscape graph — same overlay shell (`absolute inset-0 z-50`), same
 * "toolbar + React Flow canvas" shape.
 *
 * The same canvas edits TWO workflows, chosen by the mode toggle in the
 * toolbar:
 *  - Samurai — the run workflow the backend compiles into every brief; the
 *    edited graph persists (`useSamuraiWorkflowStore`) and the launch sends
 *    it verbatim;
 *  - PR review — a frontend-only workflow (`usePrWorkflowStore`) whose steps
 *    are the checkboxes in the PR monitor's action menu. Its boxes carry a
 *    short label as well as the instruction text, because a checkbox needs a
 *    one-line handle. Adding a box there adds a checkbox, no code change.
 *
 * The graph mutations live in `@/lib/workflowGraph` and mirror the backend
 * compile rule (`src-tauri/src/core/samurai_workflow.rs`); they are
 * re-exported below so this module stays the one import site for them.
 */

/* ── Pure graph edits (exported for tests) ───────────────────────────── */

export {
  addWorkflowNode,
  connectWorkflow,
  removeWorkflowEdge,
  removeWorkflowNode,
  setWorkflowNodeLabel,
  setWorkflowNodeText,
  setWorkflowStart,
  workflowWalkOrder,
} from "@/lib/workflowGraph";

/* ── React Flow scaffolding ──────────────────────────────────────────── */

/** Pseudo-node: where the walk enters. Not part of the wire graph. */
const START_ID = "__workflow_start__";

const NODE_W = 320;
const NODE_H = 190;
/** Taller box for the PR review mode — it also carries the label input. */
const NODE_H_LABELLED = 226;
const V_GAP = 48;
const START_W = 100;
const START_H = 36;
const PAD = 40;

interface WorkflowActions {
  setText: (id: string, text: string) => void;
  setLabel: (id: string, label: string) => void;
  removeNode: (id: string) => void;
  removeEdge: (from: string, to: string) => void;
}

const noop = () => {};
const WorkflowActionsContext = createContext<WorkflowActions>({
  setText: noop,
  setLabel: noop,
  removeNode: noop,
  removeEdge: noop,
});

type StepData = {
  text: string;
  /** The PR step's short label; null in Samurai mode, which has no labels. */
  label: string | null;
  /** Compiled step number; null when the compile emits no step for it. */
  step: number | null;
  /** On the walk from START. Off-walk boxes are excluded from the run. */
  reachable: boolean;
  /** Box height for the current mode — labelled boxes are taller. */
  height: number;
};

const handleClass =
  "!h-2.5 !w-2.5 !rounded-full !border !border-maestro-border !bg-maestro-accent/70";

/** The walk's entry point — drag from its handle to choose the first step. */
function StartNode(_: NodeProps) {
  return (
    <div
      title="Where the workflow starts. Drag from the dot to make another step the first one."
      className="flex items-center justify-center rounded-full border border-maestro-accent/60 bg-maestro-accent/15 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-maestro-accent"
    >
      Start
      <Handle type="source" position={Position.Bottom} className={handleClass} />
    </div>
  );
}

/**
 * One workflow step card: a status badge (doubling as the card's title), an
 * editable instruction body, and a clearly-labelled delete action. PR review
 * steps additionally carry a short label — the text their checkbox shows.
 */
function StepNode({ id, data }: NodeProps) {
  const d = data as StepData;
  const { setText, setLabel, removeNode } = useContext(WorkflowActionsContext);
  return (
    <div
      style={{ width: NODE_W, height: d.height }}
      className={`flex flex-col rounded-lg border bg-maestro-card p-3 shadow-[0_1px_4px_rgb(0_0_0/0.15),0_0_0_1px_rgb(255_255_255/0.03)_inset] transition-opacity ${
        d.reachable ? "border-maestro-border" : "border-maestro-border/40 opacity-40"
      }`}
    >
      <Handle type="target" position={Position.Top} className={handleClass} />
      <div className="mb-2 flex items-center gap-2">
        {d.step !== null ? (
          <span className="rounded bg-maestro-accent/20 px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-maestro-accent">
            Step {d.step}
          </span>
        ) : d.reachable ? (
          <span
            className="rounded bg-maestro-surface px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-maestro-muted"
            title="Empty text contributes no step — type an instruction to include it."
          >
            Empty — skipped
          </span>
        ) : (
          <span
            className="rounded bg-maestro-surface px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-maestro-muted"
            title="No connection from Start reaches this box, so the run excludes it. Reconnect it or remove it."
          >
            Not in run
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => removeNode(id)}
          aria-label={`Remove step ${id}`}
          title="Remove this step — its neighbours are re-connected around it"
          className="nodrag flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-red"
        >
          <Trash2 size={13} />
          Delete
        </button>
      </div>
      {d.label !== null && (
        <input
          value={d.label}
          onChange={(e) => setLabel(id, e.target.value)}
          aria-label={`Edit step ${id} label`}
          placeholder="Short label…"
          title="The name this step shows as in the PR action's checkbox list"
          className="nodrag mb-2 w-full rounded border border-maestro-border/40 bg-maestro-surface px-2.5 py-1.5 text-[12px] font-semibold text-maestro-text placeholder:text-maestro-muted/60 focus:border-maestro-accent focus:outline-none"
        />
      )}
      <textarea
        value={d.text}
        onChange={(e) => setText(id, e.target.value)}
        rows={6}
        aria-label={`Edit step ${id}`}
        placeholder="Describe this step's instructions…"
        className="nodrag nowheel w-full flex-1 resize-none rounded border border-maestro-border/40 bg-maestro-surface px-2.5 py-2 text-[13px] leading-snug text-maestro-text placeholder:text-maestro-muted/60 focus:border-maestro-accent focus:outline-none"
      />
      <Handle type="source" position={Position.Bottom} className={handleClass} />
    </div>
  );
}

/**
 * An edge with a mid-point delete button. The START pill's edge carries
 * `fixed` and gets no button — the walk must enter somewhere; rewire it by
 * dragging from the pill instead.
 */
function WorkflowEdgeView({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const { removeEdge } = useContext(WorkflowActionsContext);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {!data?.fixed && (
        <EdgeLabelRenderer>
          <button
            type="button"
            onClick={() => removeEdge(source, target)}
            aria-label={`Disconnect ${source} from ${target}`}
            title="Remove this connection — the run then stops before the disconnected steps"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className="nodrag nopan pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded-full border border-maestro-border bg-maestro-bg text-maestro-muted transition-colors hover:border-maestro-red hover:text-maestro-red"
          >
            <X size={11} />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { start: StartNode, step: StepNode };
const edgeTypes = { workflow: WorkflowEdgeView };

interface WorkflowsViewProps {
  onClose: () => void;
}

/** Which workflow the canvas is editing. */
type WorkflowMode = "samurai" | "pr";

const MODES: { id: WorkflowMode; label: string }[] = [
  { id: "samurai", label: "Samurai" },
  { id: "pr", label: "PR review" },
];

/** Derived React Flow model for one graph, laid out as a single column. */
function buildModel(graph: SamuraiWorkflowGraph, pr: boolean): { nodes: Node[]; edges: Edge[] } {
  const nodeH = pr ? NODE_H_LABELLED : NODE_H;
  const order = workflowWalkOrder(graph);
  const reachable = new Set(order);
  const rest = graph.nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  let step = 0;
  const stepOf = new Map<string, number | null>();
  for (const id of order) {
    const hasText = (byId.get(id)?.text ?? "").trim().length > 0;
    stepOf.set(id, hasText ? ++step : null);
  }

  const nodes: Node[] = [
    {
      id: START_ID,
      type: "start",
      position: { x: PAD + NODE_W / 2 - START_W / 2, y: PAD },
      data: {},
      deletable: false,
      width: START_W,
      height: START_H,
      handles: [{ type: "source", position: Position.Bottom, x: START_W / 2, y: START_H }],
    },
    ...[...order, ...rest].map(
      (id, index): Node => ({
        id,
        type: "step",
        position: { x: PAD, y: PAD + START_H + V_GAP + index * (nodeH + V_GAP) },
        data: {
          text: byId.get(id)?.text ?? "",
          // Only the PR workflow has labels — null keeps the input off the
          // Samurai boxes entirely.
          label: pr ? (byId.get(id)?.label ?? "") : null,
          step: stepOf.get(id) ?? null,
          reachable: reachable.has(id),
          height: nodeH,
        } satisfies StepData,
        deletable: false,
        width: NODE_W,
        height: nodeH,
        handles: [
          { type: "target", position: Position.Top, x: NODE_W / 2, y: 0 },
          { type: "source", position: Position.Bottom, x: NODE_W / 2, y: nodeH },
        ],
      }),
    ),
  ];

  // The traversed pairs — only these edges carry the run.
  const walked = new Set(order.slice(0, -1).map((id, i) => `${id}\0${order[i + 1]}`));
  const edges: Edge[] = graph.edges.map((edge, index) => {
    const active = walked.has(`${edge.from}\0${edge.to}`);
    return {
      id: `e${index}:${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      type: "workflow",
      data: { fixed: false },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: { strokeWidth: 1.5, opacity: active ? 0.9 : 0.3 },
    };
  });
  if (byId.has(graph.start)) {
    edges.unshift({
      id: `e:start->${graph.start}`,
      source: START_ID,
      target: graph.start,
      type: "workflow",
      data: { fixed: true },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: { strokeWidth: 1.5, opacity: 0.9 },
    });
  }

  return { nodes, edges };
}

const toolbarButton =
  "flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-maestro-border bg-maestro-card px-2 py-1 text-[11px] text-maestro-muted transition-colors hover:text-maestro-text disabled:opacity-40";

function WorkflowsCanvas({ onClose }: WorkflowsViewProps) {
  const stored = useSamuraiWorkflowStore((s) => s.graph);
  const setSamuraiGraph = useSamuraiWorkflowStore((s) => s.setGraph);
  const resetSamuraiGraph = useSamuraiWorkflowStore((s) => s.resetGraph);
  const prStored = usePrWorkflowStore((s) => s.graph);
  const setPrGraph = usePrWorkflowStore((s) => s.setGraph);
  const resetPrGraph = usePrWorkflowStore((s) => s.resetGraph);
  const [mode, setMode] = useState<WorkflowMode>("samurai");
  // The backend default template, fetched only while nothing is stored —
  // it is the display fallback AND what the first edit is applied to.
  const [fallback, setFallback] = useState<SamuraiWorkflowGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bumped to re-run the fetch below. Without it a single failed fetch was
  // terminal: `stored` is already null, so the effect never re-ran, and the
  // canvas showed "Loading workflow…" forever with no way to edit the
  // Samurai workflow until the overlay was remounted.
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is not read in the body but is the intended trigger — bumping it is the only way to retry a failed fetch, since `stored` is already null when the fetch fails.
  useEffect(() => {
    if (stored !== null) return;
    let disposed = false;
    samuraiDefaultWorkflow()
      .then((graph) => {
        if (disposed) return;
        setFallback(graph);
        setError(null);
      })
      .catch((err) => {
        if (!disposed) setError(String(err));
      });
    return () => {
      disposed = true;
    };
  }, [stored, reloadKey]);

  const pr = mode === "pr";
  // Same fallback rule in both modes ("null means the default governs"); the
  // PR default is a frontend constant because no backend compiles that graph.
  const graph = pr ? (prStored ?? DEFAULT_PR_WORKFLOW) : (stored ?? fallback);
  const setGraph = pr ? setPrGraph : setSamuraiGraph;

  // Every edit lands in the persisted store, whichever graph it started from.
  const actions = useMemo<WorkflowActions>(
    () => ({
      setText: (id, text) => graph && setGraph(setWorkflowNodeText(graph, id, text)),
      setLabel: (id, label) => graph && setGraph(setWorkflowNodeLabel(graph, id, label)),
      // The LAST box never goes: an empty graph persists as
      // `{nodes: [], edges: [], start: ""}`, which compiles to nothing — the
      // run would then launch with no WORKFLOW section at all, and the only
      // hint would be an empty canvas.
      removeNode: (id) =>
        graph && graph.nodes.length > 1 && setGraph(removeWorkflowNode(graph, id)),
      removeEdge: (from, to) => graph && setGraph(removeWorkflowEdge(graph, from, to)),
    }),
    [graph, setGraph],
  );

  const handleConnect = (connection: Connection) => {
    if (!graph || !connection.source || !connection.target) return;
    if (connection.target === START_ID) return;
    setGraph(
      connection.source === START_ID
        ? setWorkflowStart(graph, connection.target)
        : connectWorkflow(graph, connection.source, connection.target),
    );
  };

  const handleAdd = () => {
    // A new PR step arrives with a placeholder label so it is identifiable in
    // the checkbox list before the user renames it.
    if (graph) setGraph(addWorkflowNode(graph, pr ? "New step" : undefined));
  };

  const handleReset = () => {
    // Reset returns to "never edited" (null): the default GOVERNS again — for
    // Samurai the launch sends `workflow: null` and future changes to the
    // backend template apply. Storing a materialized copy of today's default
    // would silently pin the user to it forever. The effect above refetches
    // it for display the moment `stored` flips back to null.
    setError(null);
    if (pr) resetPrGraph();
    else resetSamuraiGraph();
    // Refetch, not just clear the message: when `stored` is already null the
    // effect above has no dependency change to react to.
    setReloadKey((key) => key + 1);
  };

  // Walk order first (the run's actual sequence), then the disconnected
  // boxes. Positions are only the STARTING point for a fresh node — see the
  // sync effects below, which preserve wherever the user has dragged a node.
  const model = useMemo(() => (graph ? buildModel(graph, pr) : null), [graph, pr]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Re-derive nodes from the store on every edit, but never yank a node the
  // user already positioned: an existing node keeps its current (possibly
  // dragged) position, only its `data` is refreshed. Only a brand-new node
  // (added via "Add step") gets the computed layout position. Switching mode
  // is the exception — the two graphs share step ids, so carrying positions
  // across would drop the other workflow's boxes into stale slots.
  const positionsMode = useRef(mode);
  useEffect(() => {
    if (!model) return;
    const modeChanged = positionsMode.current !== mode;
    positionsMode.current = mode;
    setNodes((previous) => {
      if (modeChanged) return model.nodes;
      const byId = new Map(previous.map((n) => [n.id, n]));
      return model.nodes.map((node) => {
        const existing = byId.get(node.id);
        return existing ? { ...node, position: existing.position } : node;
      });
    });
  }, [model, mode, setNodes]);

  useEffect(() => {
    if (!model) return;
    setEdges(model.edges);
  }, [model, setEdges]);

  const { fitView, zoomIn, zoomOut } = useReactFlow();

  // Fit once per mode, and only after React Flow has measured the nodes —
  // fitting before that leaves the graph at zoom 1 with steps off-screen.
  const nodesInitialized = useNodesInitialized();
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || !nodesInitialized) return;
    fittedRef.current = true;
    fitView({ padding: 0.2 });
  }, [nodesInitialized, fitView]);

  // Esc closes the overlay (same convention as the old LandscapeView). Capture
  // phase, because a focused textarea inside a step card would otherwise
  // absorb the key first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [onClose]);

  return (
    // z-50: the one full-screen overlay App can show; the zoomed eagle pane is z-40.
    <div className="absolute inset-0 z-50 flex flex-col bg-maestro-bg">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-maestro-border px-2">
        <Workflow size={13} className="shrink-0 text-maestro-accent" />
        <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
          Workflow Editor
        </span>

        <div role="tablist" aria-label="Workflow to edit" className="flex shrink-0 gap-0.5">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              onClick={() => {
                setMode(m.id);
                // The other graph is a different shape; re-fit once it lands.
                fittedRef.current = false;
              }}
              className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                mode === m.id
                  ? "bg-maestro-accent/15 text-maestro-accent"
                  : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <span className="min-w-0 flex-1 truncate text-[11px] text-maestro-muted">
          {pr
            ? "The steps a PR review runs. Each box is one checkbox in the PR monitor's action menu — add a box here and the checkbox appears there."
            : "The step-by-step process every run follows, compiled into each orchestrator brief. Removing a step re-connects its neighbours; removing an arrow cuts the run short."}
        </span>

        {/* Only the Samurai default is fetched from the backend, so its error
            belongs to that mode alone. */}
        {!pr && error && (
          <span className="flex shrink-0 items-center gap-1">
            <span className="max-w-[220px] truncate text-[10px] text-maestro-red" title={error}>
              {error}
            </span>
            <button
              type="button"
              onClick={() => setReloadKey((key) => key + 1)}
              className="rounded border border-maestro-border px-1.5 py-0.5 text-[10px] text-maestro-muted hover:text-maestro-text"
            >
              Retry
            </button>
          </span>
        )}

        <button
          type="button"
          onClick={handleAdd}
          disabled={!graph}
          title={`Add an empty step box at the end of the ${pr ? "PR review" : "run"}`}
          className={toolbarButton}
        >
          <Plus size={12} />
          Add step
        </button>
        <button
          type="button"
          onClick={handleReset}
          title="Throw away every edit and restore the default workflow"
          className={toolbarButton}
        >
          <RotateCcw size={12} />
          Reset
        </button>
        <button
          type="button"
          onClick={() => zoomOut({ duration: 200 })}
          aria-label="Zoom out"
          title="Zoom out"
          className={toolbarButton}
        >
          <ZoomOut size={12} />
        </button>
        <button
          type="button"
          onClick={() => zoomIn({ duration: 200 })}
          aria-label="Zoom in"
          title="Zoom in"
          className={toolbarButton}
        >
          <ZoomIn size={12} />
        </button>
        <button
          type="button"
          onClick={() => fitView({ duration: 200, padding: 0.2 })}
          title="Zoom to fit every step"
          className={toolbarButton}
        >
          <Maximize2 size={12} />
          Fit view
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close workflow editor"
          title="Close (Esc)"
          className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
        >
          <X size={14} />
        </button>
      </div>

      {/* Canvas */}
      <div className="relative min-h-0 flex-1">
        {model === null ? (
          !error && (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-maestro-muted">
              <Loader2 size={14} className="animate-spin" />
              Loading workflow…
            </div>
          )
        ) : (
          <WorkflowActionsContext.Provider value={actions}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={handleConnect}
              nodesConnectable
              edgesFocusable={false}
              deleteKeyCode={null}
              minZoom={0.25}
              maxZoom={1.5}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={26}
                size={1}
                color="rgb(var(--maestro-border))"
              />
            </ReactFlow>
          </WorkflowActionsContext.Provider>
        )}
      </div>
    </div>
  );
}

/** React Flow's camera API needs a provider above the component that uses it. */
export function WorkflowsView(props: WorkflowsViewProps) {
  return (
    <ReactFlowProvider>
      <WorkflowsCanvas {...props} />
    </ReactFlowProvider>
  );
}
