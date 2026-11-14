import { describe, expect, it, vi } from "vitest";

// prWorkflow shares the walk rule with the workflow editor, so importing it
// pulls the editor's persisted stores in. happy-dom has no Tauri backend.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));

import type { WorkflowGraph } from "@/lib/workflowGraphTypes";
import {
  compilePrWorkflow,
  DEFAULT_PR_WORKFLOW,
  prWorkflowNeedsWorktree,
  prWorkflowStepsInOrder,
} from "../prWorkflow";

/** A tiny labelled chain — the shape the PR dropdown reads. */
function chain(): WorkflowGraph {
  return {
    nodes: [
      { id: "one", label: "First", text: "Do   one\nthing." },
      { id: "two", label: "Second", text: "Do two things." },
      { id: "three", label: "Third", text: "Do three things." },
    ],
    edges: [
      { from: "one", to: "two" },
      { from: "two", to: "three" },
    ],
    start: "one",
  };
}

const ALL = (graph: WorkflowGraph) => graph.nodes.map((n) => n.id);

describe("DEFAULT_PR_WORKFLOW", () => {
  it("is a linear check → review → fix → merge chain", () => {
    expect(prWorkflowStepsInOrder(DEFAULT_PR_WORKFLOW).map((s) => s.id)).toEqual([
      "check",
      "review",
      "fix",
      "merge",
    ]);
    expect(prWorkflowStepsInOrder(DEFAULT_PR_WORKFLOW).map((s) => s.label)).toEqual([
      "Check status",
      "Review & post",
      "Fix issues",
      "Merge if green",
    ]);
  });

  it("compiles every step into one renumbered single-line fragment", () => {
    const prompt = compilePrWorkflow(DEFAULT_PR_WORKFLOW, ALL(DEFAULT_PR_WORKFLOW));
    expect(prompt).toContain("Step 1: Gather the full picture of the PR");
    expect(prompt).toContain("Step 2: Review the full diff");
    expect(prompt).toContain("Step 3: If the review found concrete fixable issues");
    expect(prompt).toContain("Step 4: Merge the PR with gh pr merge ONLY if");
    expect(prompt).not.toContain("\n");
  });
});

describe("prWorkflowStepsInOrder", () => {
  it("follows the graph walk, so added boxes become extra checkboxes", () => {
    const graph = chain();
    graph.nodes.push({ id: "four", label: "Fourth", text: "Do four things." });
    graph.edges.push({ from: "three", to: "four" });

    expect(prWorkflowStepsInOrder(graph).map((s) => s.id)).toEqual(["one", "two", "three", "four"]);
  });

  it("excludes boxes the walk cannot reach (a cut arrow drops its checkbox)", () => {
    const graph = chain();
    graph.edges = [{ from: "one", to: "two" }];
    expect(prWorkflowStepsInOrder(graph).map((s) => s.id)).toEqual(["one", "two"]);
  });

  it("falls back to a text prefix when a box has no label", () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "long", text: "Check that absolutely everything about the PR is in order." },
        { id: "short", text: "  Short   one.  " },
        { id: "blank", label: "   ", text: "" },
      ],
      edges: [
        { from: "long", to: "short" },
        { from: "short", to: "blank" },
      ],
      start: "long",
    };
    expect(prWorkflowStepsInOrder(graph).map((s) => s.label)).toEqual([
      "Check that absolutely everythi…",
      "Short one.",
      "Untitled step",
    ]);
  });
});

describe("compilePrWorkflow", () => {
  it("keeps only the ticked steps and renumbers over what is kept", () => {
    expect(compilePrWorkflow(chain(), ["one", "three"])).toBe(
      "Step 1: Do one thing. Step 2: Do three things.",
    );
  });

  it("emits walk order regardless of the order the ids were ticked in", () => {
    expect(compilePrWorkflow(chain(), ["three", "one"])).toBe(
      compilePrWorkflow(chain(), ["one", "three"]),
    );
  });

  it("normalizes whitespace so each step is one line", () => {
    const graph: WorkflowGraph = {
      nodes: [{ id: "one", text: "  Run\n\n  the   thing.\t\nThen stop.  " }],
      edges: [],
      start: "one",
    };
    expect(compilePrWorkflow(graph, ["one"])).toBe("Step 1: Run the thing. Then stop.");
  });

  it("compiles an empty selection to an empty string", () => {
    expect(compilePrWorkflow(chain(), [])).toBe("");
  });

  it("ignores unknown ids and text-less steps", () => {
    const graph = chain();
    graph.nodes[1] = { id: "two", label: "Second", text: "   " };
    expect(compilePrWorkflow(graph, ["one", "two", "nope"])).toBe("Step 1: Do one thing.");
  });
});

describe("prWorkflowNeedsWorktree", () => {
  it("is false for read-only selections", () => {
    expect(prWorkflowNeedsWorktree(["check", "review"], DEFAULT_PR_WORKFLOW)).toBe(false);
    expect(prWorkflowNeedsWorktree([], DEFAULT_PR_WORKFLOW)).toBe(false);
  });

  it("is true as soon as a writing step is ticked", () => {
    expect(prWorkflowNeedsWorktree(["check", "fix"], DEFAULT_PR_WORKFLOW)).toBe(true);
    expect(prWorkflowNeedsWorktree(["merge"], DEFAULT_PR_WORKFLOW)).toBe(true);
  });

  it("matches on the label as well as the id", () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "step-1", label: "Push the branch", text: "git push" },
        { id: "step-2", label: "Look around", text: "read things" },
      ],
      edges: [{ from: "step-1", to: "step-2" }],
      start: "step-1",
    };
    expect(prWorkflowNeedsWorktree(["step-2"], graph)).toBe(false);
    expect(prWorkflowNeedsWorktree(["step-1"], graph)).toBe(true);
  });

  it("matches on the instruction text, not just the id and label", () => {
    // The text is what actually reaches the agent. A neutrally-named step
    // that orders a commit used to compile into the prompt alongside the
    // READ-ONLY workspace rule — contradictory orders, and no worktree.
    const graph: WorkflowGraph = {
      nodes: [
        { id: "step-1", label: "Apply patches", text: "commit and push the fix" },
        { id: "step-2", label: "Look around", text: "read things" },
      ],
      edges: [{ from: "step-1", to: "step-2" }],
      start: "step-1",
    };
    expect(prWorkflowNeedsWorktree(["step-1"], graph)).toBe(true);
    expect(prWorkflowNeedsWorktree(["step-2"], graph)).toBe(false);
  });

  it("does not treat a read-only step as writing because of a substring", () => {
    // `mergeable` contains "merge" — matching it would send every plain
    // status check through a pointless worktree checkout.
    expect(prWorkflowNeedsWorktree(["check"], DEFAULT_PR_WORKFLOW)).toBe(false);
    expect(prWorkflowNeedsWorktree(["review"], DEFAULT_PR_WORKFLOW)).toBe(false);
  });
});
