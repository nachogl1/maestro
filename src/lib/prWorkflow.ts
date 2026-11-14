import { workflowWalkOrder } from "@/lib/workflowGraph";
import type { WorkflowGraph } from "@/lib/workflowGraphTypes";

/**
 * The PR review workflow: the same graph shape as the Samurai run workflow,
 * but frontend-only — the Rust side never parses it. Its steps ARE the
 * checkboxes in the PR monitor's action dropdown: the list is derived from
 * the graph at render time ({@link prWorkflowStepsInOrder}), so a step the
 * user adds in the workflow editor shows up as one more checkbox with no
 * code change here.
 *
 * The walk rule (start node, first outgoing edge, stop on revisit) comes from
 * `@/lib/workflowGraph` rather than being restated here, so it stays identical
 * to what the canvas draws — and importing it costs the PR panel nothing,
 * since that module carries no React Flow dependency.
 */

/** One checkbox in the PR dropdown: the node, plus the text to show for it. */
export interface PrWorkflowStep {
  id: string;
  /** Display label — `node.label` when set, else a prefix of the text. */
  label: string;
  /** The full instruction text this step contributes to the prompt. */
  text: string;
}

/** How many characters of the text stand in for a missing label. */
const LABEL_FALLBACK_CHARS = 30;

/** Collapses newlines and runs of spaces so a step is one prompt line. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `node.label` when it has content, else the first ~30 chars of the text. */
function displayLabel(label: string | undefined, text: string): string {
  const explicit = (label ?? "").trim();
  if (explicit.length > 0) return explicit;
  const flat = normalizeWhitespace(text);
  if (flat.length === 0) return "Untitled step";
  if (flat.length <= LABEL_FALLBACK_CHARS) return flat;
  return `${flat.slice(0, LABEL_FALLBACK_CHARS).trimEnd()}…`;
}

/**
 * The default PR review workflow — a linear chain
 * check → review → fix → merge. Used until the user edits the graph
 * (`usePrWorkflowStore` holds `null` until then), the same "null means
 * default" rule the Samurai workflow uses. Frontend-owned, because no Rust
 * command compiles this graph.
 */
export const DEFAULT_PR_WORKFLOW: WorkflowGraph = {
  nodes: [
    {
      id: "check",
      label: "Check status",
      text: "Gather the full picture of the PR: run gh pr view <PR> --json state,title,author,baseRefName,headRefName,mergeable,reviewDecision,statusCheckRollup,comments,reviews,url and gh pr checks <PR>. Read EVERY comment and review thread so nothing already raised is missed. Determine whether the PR is stacked (its base branch is not the repository default branch). Report a concise status verdict: checks green/red/pending, review decision, unresolved concerns, mergeable state, stacked or not.",
    },
    {
      id: "review",
      label: "Review & post",
      text: "Review the full diff with gh pr diff <PR>, cross-checking every existing comment and review thread so you do not repeat or miss anything already raised. If the PR is stacked, review ONLY the changes relative to its true base branch, never the accumulated stack. Post the review with gh pr review <PR> using --comment or --request-changes with concrete, actionable feedback; use --approve only if you found no blocking issues.",
    },
    {
      id: "fix",
      label: "Fix issues",
      text: "If the review found concrete fixable issues: create a temporary git worktree checked out on the PR head branch (never switch branches in the main checkout), apply the smallest fixes that resolve the findings, run the project's tests to verify, commit with Conventional Commits referencing the PR, push to the PR head branch, then remove the temporary worktree.",
    },
    {
      id: "merge",
      label: "Merge if green",
      text: "Merge the PR with gh pr merge ONLY if every condition holds: all status checks green, review approved, no unresolved review comments, and the base branch is the repository default branch. NEVER merge a stacked PR (base is another feature branch) - refuse and report why instead. If any condition fails, report exactly what is missing.",
    },
  ],
  edges: [
    { from: "check", to: "review" },
    { from: "review", to: "fix" },
    { from: "fix", to: "merge" },
  ],
  start: "check",
};

/**
 * The steps the PR dropdown renders one checkbox for, in graph walk order.
 * Off-walk boxes are excluded — exactly like the run compile — so a box the
 * user disconnected on the canvas disappears from the dropdown too.
 */
export function prWorkflowStepsInOrder(graph: WorkflowGraph): PrWorkflowStep[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const steps: PrWorkflowStep[] = [];
  for (const id of workflowWalkOrder(graph)) {
    const node = byId.get(id);
    if (!node) continue;
    steps.push({ id: node.id, label: displayLabel(node.label, node.text), text: node.text });
  }
  return steps;
}

/**
 * Compiles the ticked steps into the prompt fragment the PR action sends:
 * walk order, selected ids only, renumbered `Step 1: … Step 2: …` over the
 * KEPT steps (so unticking step 2 renumbers what follows), each text
 * whitespace-normalized onto a single line. A selected step with no text
 * contributes nothing — the same "empty text emits no step" rule the run
 * compile uses. An empty selection compiles to an empty string.
 */
export function compilePrWorkflow(graph: WorkflowGraph, selectedIds: string[]): string {
  const wanted = new Set(selectedIds);
  const parts: string[] = [];
  for (const step of prWorkflowStepsInOrder(graph)) {
    if (!wanted.has(step.id)) continue;
    const text = normalizeWhitespace(step.text);
    if (text.length === 0) continue;
    parts.push(`Step ${parts.length + 1}: ${text}`);
  }
  return parts.join(" ");
}

/**
 * Steps that WRITE (they need a checkout to work in). Whole words only:
 * `mergeable` — which the read-only status step asks `gh` for — must not
 * read as "merge".
 */
const WRITE_STEP = /\b(fix|merge|push|commit)\b/i;

/**
 * Whether the selected steps need a temporary worktree.
 *
 * Deliberately a simple, visible heuristic rather than a stored per-node
 * flag: a step is treated as write-access when its id, its display label
 * (so `node.label`, or the text prefix that stands in for a missing one) or
 * its INSTRUCTION TEXT matches {@link WRITE_STEP}. The text counts because
 * it is what actually reaches the agent — a step labelled "Apply patches"
 * whose text orders a push otherwise compiled into the prompt with no
 * worktree and alongside the READ-ONLY workspace rule. Read-only selections
 * (check, review) still run in place.
 */
export function prWorkflowNeedsWorktree(selectedIds: string[], graph: WorkflowGraph): boolean {
  const wanted = new Set(selectedIds);
  return prWorkflowStepsInOrder(graph).some(
    (step) =>
      wanted.has(step.id) &&
      (WRITE_STEP.test(step.id) || WRITE_STEP.test(step.label) || WRITE_STEP.test(step.text)),
  );
}
