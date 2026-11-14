import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The persisted workflow store hydrates through the Tauri store plugin at
// import time; happy-dom has no Tauri backend, so stub it out.
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

import { DEFAULT_PR_WORKFLOW, prWorkflowStepsInOrder } from "@/lib/prWorkflow";
import type { WorkflowGraph } from "@/lib/workflowGraphTypes";
import { usePrWorkflowStore } from "@/stores/usePrWorkflowStore";
import {
  addWorkflowNode,
  connectWorkflow,
  removeWorkflowEdge,
  removeWorkflowNode,
  setWorkflowNodeLabel,
  setWorkflowStart,
  WorkflowsView,
  workflowWalkOrder,
} from "../WorkflowsView";

/**
 * React Flow measures its container and nodes through browser APIs happy-dom
 * doesn't implement. These are the stubs React Flow's own docs prescribe for
 * a jsdom/happy-dom test environment (same block the old LandscapeView test used).
 */
beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22 = 1;
    },
  );
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 800,
      toJSON: () => {},
    }),
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });
});

/** A tiny 3-step chain for focused pure-function cases. */
function chain(): WorkflowGraph {
  return {
    nodes: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
      { id: "c", text: "C" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
    start: "a",
  };
}

function storedGraph(): WorkflowGraph {
  const graph = usePrWorkflowStore.getState().graph;
  if (!graph) throw new Error("expected an edited graph in the store");
  return graph;
}

describe("WorkflowsView — the PR review workflow", () => {
  beforeEach(() => {
    usePrWorkflowStore.setState({ graph: null });
  });

  it("renders the PR default, labels and all, with compiled step numbers", async () => {
    render(<WorkflowsView onClose={() => {}} />);

    for (const [id, label] of [
      ["check", "Check status"],
      ["review", "Review & post"],
      ["fix", "Fix issues"],
      ["merge", "Merge if green"],
    ]) {
      expect(await screen.findByLabelText(`Edit step ${id} label`)).toHaveValue(label);
    }
    // All four boxes are on the walk, numbered in walk order.
    for (let step = 1; step <= 4; step++) {
      expect(screen.getByText(`Step ${step}`)).toBeInTheDocument();
    }
    expect(screen.queryByText("Step 5")).not.toBeInTheDocument();
    expect(screen.queryByText("Not in run")).not.toBeInTheDocument();
    // Untouched: nothing lands in the store until the user edits.
    expect(usePrWorkflowStore.getState().graph).toBeNull();
  });

  it("has no Samurai mode to switch to", async () => {
    render(<WorkflowsView onClose={() => {}} />);
    await screen.findByLabelText("Edit step check label");

    expect(screen.queryByRole("tab", { name: "Samurai" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Samurai/)).not.toBeInTheDocument();
  });

  it("editing a box's text lands in the persisted store", async () => {
    render(<WorkflowsView onClose={() => {}} />);
    const box = await screen.findByLabelText("Edit step check");

    fireEvent.change(box, { target: { value: "Check it MY way." } });

    const graph = storedGraph();
    expect(graph.nodes.find((n) => n.id === "check")?.text).toBe("Check it MY way.");
    // Everything else is carried over untouched from the default.
    expect(graph.nodes).toHaveLength(4);
    expect(screen.getByDisplayValue("Check it MY way.")).toBeInTheDocument();
  });

  it("editing a label lands in the store and renames the checkbox", async () => {
    render(<WorkflowsView onClose={() => {}} />);

    fireEvent.change(await screen.findByLabelText("Edit step check label"), {
      target: { value: "Status check" },
    });

    const graph = storedGraph();
    expect(graph.nodes.find((n) => n.id === "check")?.label).toBe("Status check");
    // The text is carried over untouched.
    expect(graph.nodes.find((n) => n.id === "check")?.text).toBe(DEFAULT_PR_WORKFLOW.nodes[0].text);
    // What the PR dropdown renders follows the edit.
    expect(prWorkflowStepsInOrder(graph).map((s) => s.label)).toEqual([
      "Status check",
      "Review & post",
      "Fix issues",
      "Merge if green",
    ]);
  });

  it("deleting a box auto-bridges prev → next, skipping the step instead of truncating", async () => {
    render(<WorkflowsView onClose={() => {}} />);
    await screen.findByLabelText("Edit step review label");

    fireEvent.click(screen.getByRole("button", { name: "Remove step review" }));

    const graph = storedGraph();
    expect(graph.nodes.some((n) => n.id === "review")).toBe(false);
    // The bridge: check now feeds fix directly…
    expect(graph.edges).toContainEqual({ from: "check", to: "fix" });
    expect(graph.edges.some((e) => e.from === "review" || e.to === "review")).toBe(false);
    // …so the walk still reaches the end (3 steps, nothing orphaned).
    expect(workflowWalkOrder(graph)).toEqual(["check", "fix", "merge"]);
    expect(screen.queryByLabelText("Edit step review label")).not.toBeInTheDocument();
    expect(screen.queryByText("Not in run")).not.toBeInTheDocument();
    expect(screen.getByText("Step 3")).toBeInTheDocument();
    expect(screen.queryByText("Step 4")).not.toBeInTheDocument();
  });

  it("deleting a connection truncates: downstream boxes stay visible but leave the run", async () => {
    render(<WorkflowsView onClose={() => {}} />);
    await screen.findByLabelText("Edit step review label");

    fireEvent.click(screen.getByRole("button", { name: "Disconnect review from fix" }));

    const graph = storedGraph();
    expect(graph.edges).not.toContainEqual({ from: "review", to: "fix" });
    // All four boxes are still on the canvas…
    expect(graph.nodes).toHaveLength(4);
    expect(screen.getByLabelText("Edit step fix label")).toBeInTheDocument();
    // …but the two past the cut are visibly excluded from the run.
    expect(screen.getAllByText("Not in run")).toHaveLength(2);
    expect(screen.getByText("Step 2")).toBeInTheDocument();
    expect(screen.queryByText("Step 3")).not.toBeInTheDocument();
    expect(workflowWalkOrder(graph)).toEqual(["check", "review"]);
  });

  it("reset returns the store to null-means-default instead of pinning a copy", async () => {
    render(<WorkflowsView onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Edit step check"), {
      target: { value: "Edited away." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove step fix" }));
    expect(storedGraph().nodes).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    // The store returns to "never edited": the default GOVERNS again —
    // including future changes to it. A materialized copy would silently pin
    // today's default forever.
    await waitFor(() => expect(usePrWorkflowStore.getState().graph).toBeNull());
    // The editor still renders the default for display.
    expect(await screen.findByLabelText("Edit step fix label")).toHaveValue("Fix issues");
    expect(screen.getByLabelText("Edit step check")).toHaveValue(DEFAULT_PR_WORKFLOW.nodes[0].text);
  });

  it("a box added arrives labelled, wired from the end of the walk, and becomes another checkbox", async () => {
    render(<WorkflowsView onClose={() => {}} />);
    await screen.findByLabelText("Edit step merge label");

    fireEvent.click(screen.getByRole("button", { name: "Add step" }));

    const graph = storedGraph();
    expect(graph.nodes).toHaveLength(5);
    expect(graph.edges).toContainEqual({ from: "merge", to: "step-1" });
    expect(await screen.findByLabelText("Edit step step-1 label")).toHaveValue("New step");
    // Reachable (it joined the walk) but empty — compile emits no step yet.
    expect(screen.getByText("Empty — skipped")).toBeInTheDocument();
    expect(screen.queryByText("Not in run")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Edit step step-1")).toHaveValue("");
    // The dropdown's checkbox list is derived from the graph, so it grew too.
    expect(prWorkflowStepsInOrder(graph).map((s) => s.id)).toEqual([
      "check",
      "review",
      "fix",
      "merge",
      "step-1",
    ]);
  });

  it("the close button and Escape both call onClose", async () => {
    const onClose = vi.fn();
    render(<WorkflowsView onClose={onClose} />);
    await screen.findByLabelText("Edit step check label");

    fireEvent.click(screen.getByRole("button", { name: "Close workflow editor" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("workflow graph edits (pure rules)", () => {
  it("setWorkflowNodeLabel replaces one node's label and nothing else", () => {
    const next = setWorkflowNodeLabel(chain(), "b", "Bee");
    expect(next.nodes).toEqual([
      { id: "a", text: "A" },
      { id: "b", text: "B", label: "Bee" },
      { id: "c", text: "C" },
    ]);
    expect(next.edges).toEqual(chain().edges);
  });

  it("added boxes only carry a label when one is asked for", () => {
    expect(addWorkflowNode(chain()).nodes[3]).toEqual({ id: "step-1", text: "" });
    expect(addWorkflowNode(chain(), "New step").nodes[3]).toEqual({
      id: "step-1",
      text: "",
      label: "New step",
    });
  });

  it("walk order follows the first outgoing edge and guards against cycles", () => {
    const graph: WorkflowGraph = {
      ...chain(),
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" }, // branch: never followed (a→b is listed first)
        { from: "b", to: "a" }, // cycle: walk stops before revisiting a
      ],
    };
    expect(workflowWalkOrder(graph)).toEqual(["a", "b"]);
  });

  it("removing the start node hands start to its bridge target", () => {
    const next = removeWorkflowNode(chain(), "a");
    expect(next.start).toBe("b");
    expect(next.nodes.map((n) => n.id)).toEqual(["b", "c"]);
    expect(next.edges).toEqual([{ from: "b", to: "c" }]);
  });

  it("removing a tail node drops its incoming edge (nothing to bridge to)", () => {
    const next = removeWorkflowNode(chain(), "c");
    expect(next.edges).toEqual([{ from: "a", to: "b" }]);
    expect(workflowWalkOrder(next)).toEqual(["a", "b"]);
  });

  it("a bridge that would self-loop or duplicate an existing edge is dropped", () => {
    // a→b, b→a: removing b would bridge a→a — dropped, not created.
    const loop: WorkflowGraph = {
      nodes: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
      start: "a",
    };
    expect(removeWorkflowNode(loop, "b").edges).toEqual([]);

    // a→b, a→c, b→c: removing b bridges a→c, which already exists — kept once,
    // in the removed edge's slot so it stays a's FIRST outgoing edge.
    const diamond: WorkflowGraph = {
      ...chain(),
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ],
    };
    expect(removeWorkflowNode(diamond, "b").edges).toEqual([{ from: "a", to: "c" }]);
  });

  it("connecting a box replaces its previous outgoing edge (rewire, not branch)", () => {
    const next = connectWorkflow(chain(), "a", "c");
    expect(next.edges).toEqual([
      { from: "b", to: "c" },
      { from: "a", to: "c" },
    ]);
    expect(workflowWalkOrder(next)).toEqual(["a", "c"]);
    // Self-connections are refused outright.
    expect(connectWorkflow(chain(), "a", "a")).toEqual(chain());
  });

  it("rewiring the START pill just repoints the walk's entry", () => {
    const next = setWorkflowStart(chain(), "b");
    expect(next.start).toBe("b");
    expect(workflowWalkOrder(next)).toEqual(["b", "c"]);
    expect(next.nodes).toEqual(chain().nodes);
  });

  it("added boxes get fresh step-N ids that never collide", () => {
    const once = addWorkflowNode(chain());
    const twice = addWorkflowNode(once);
    expect(once.nodes[once.nodes.length - 1]?.id).toBe("step-1");
    expect(twice.nodes[twice.nodes.length - 1]?.id).toBe("step-2");
    expect(workflowWalkOrder(twice)).toEqual(["a", "b", "c", "step-1", "step-2"]);
  });

  it("the last remaining box cannot be removed", async () => {
    // An empty graph persists as {nodes: [], edges: [], start: ""}, which
    // compiles to nothing: the PR action menu would offer no step at all and
    // only an empty canvas would show for it.
    usePrWorkflowStore.setState({ graph: null });
    render(<WorkflowsView onClose={() => {}} />);
    await screen.findByLabelText("Edit step check label");
    for (const id of ["review", "fix", "merge"]) {
      fireEvent.click(screen.getByRole("button", { name: `Remove step ${id}` }));
    }
    await waitFor(() => expect(usePrWorkflowStore.getState().graph?.nodes).toHaveLength(1));

    // The button says so instead of silently ignoring the click.
    const lastDelete = screen.getByRole("button", { name: "Remove step check" });
    expect(lastDelete).toBeDisabled();
    expect(lastDelete).toHaveAttribute("title", "The last step cannot be removed");
    fireEvent.click(lastDelete);

    expect(usePrWorkflowStore.getState().graph?.nodes).toHaveLength(1);
  });

  it("removing a missing edge is a no-op", () => {
    expect(removeWorkflowEdge(chain(), "a", "c")).toEqual(chain());
  });

  it("an added box joins the run even when the walk ended on a cycle", () => {
    // The walk stops at a revisit, so its tail can already HAVE an outgoing
    // edge. Appending a second edge from that tail left the new box off the
    // walk entirely — "Not in run" the moment it was created.
    const cyclic: WorkflowGraph = {
      ...chain(),
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
      ],
    };
    expect(workflowWalkOrder(cyclic)).toEqual(["a", "b", "c"]);

    const next = addWorkflowNode(cyclic);

    expect(workflowWalkOrder(next)).toEqual(["a", "b", "c", "step-1"]);
    expect(next.edges.filter((e) => e.from === "c")).toEqual([{ from: "c", to: "step-1" }]);
  });
});
