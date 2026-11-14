/**
 * The workflow graph shape shared by the PR review workflow and the Samurai
 * run workflow. Kept apart from both so the PR workflow stands on its own.
 */

/**
 * One workflow step box — mirrors the Rust `WorkflowNode`
 * (`core/samurai_workflow.rs`). `id` is the stable identity edits preserve;
 * step numbers are assigned at compile time, never stored.
 */
export interface WorkflowNode {
  id: string;
  /** The step's instruction text (editable in the workflow editor). */
  text: string;
  /**
   * Optional short display name, used where a step needs a one-line handle
   * instead of its full text — the PR review workflow's checkboxes. Absent on
   * Samurai run graphs; Rust's serde ignores the unknown field, so a graph
   * carrying one still deserializes into `WorkflowNode`.
   */
  label?: string;
}

/** One directed edge between two node ids — mirrors the Rust `WorkflowEdge`. */
export interface WorkflowEdge {
  from: string;
  to: string;
}

/**
 * A workflow graph (issue #91) — mirrors the Rust `WorkflowGraph`.
 * The walk starts at `start`, follows the FIRST outgoing edge per node, in
 * edge-list order; cycles stop before a repeat; unreachable nodes are
 * excluded (`workflowWalkOrder` in `src/lib/workflowGraph.ts`).
 */
export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Node id the walk starts from. */
  start: string;
}
