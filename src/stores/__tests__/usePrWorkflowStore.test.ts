import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * In-memory double of the Tauri store plugin file, so the persist round-trip
 * (write on setGraph, read on rehydrate) is observable without a backend.
 */
const backing = vi.hoisted(() => new Map<string, string>());

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get(key: string) {
      return backing.get(key);
    }
    async set(key: string, value: string) {
      backing.set(key, value);
    }
    async save() {}
    async delete(key: string) {
      backing.delete(key);
    }
  },
}));

import type { WorkflowGraph } from "@/lib/workflowGraphTypes";
import { prWorkflowGraphForLaunch, usePrWorkflowStore } from "../usePrWorkflowStore";

const STORAGE_KEY = "maestro-pr-workflow";

function graph(): WorkflowGraph {
  return {
    nodes: [
      { id: "check", text: "Check status", label: "Check" },
      { id: "review", text: "Review the diff", label: "Review" },
    ],
    edges: [{ from: "check", to: "review" }],
    start: "check",
  };
}

describe("usePrWorkflowStore persistence", () => {
  beforeEach(() => {
    backing.clear();
    usePrWorkflowStore.setState({ graph: null });
  });

  it("starts with no graph — DEFAULT_PR_WORKFLOW governs untouched actions", () => {
    expect(usePrWorkflowStore.getState().graph).toBeNull();
  });

  it("setGraph writes the graph through the Tauri store plugin", async () => {
    usePrWorkflowStore.getState().setGraph(graph());

    await vi.waitFor(() => expect(backing.has(STORAGE_KEY)).toBe(true));
    const raw = backing.get(STORAGE_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string).state.graph).toEqual(graph());
  });

  it("prWorkflowGraphForLaunch waits for hydration before reporting the graph", async () => {
    const persisted = { ...graph(), start: "review" };
    backing.set(STORAGE_KEY, JSON.stringify({ state: { graph: persisted }, version: 0 }));

    const hydration = usePrWorkflowStore.persist.rehydrate();
    const read = prWorkflowGraphForLaunch();

    expect(await read).toEqual(persisted);
    await hydration;
  });

  it("a corrupt persisted graph degrades to the default instead of hanging the action", async () => {
    // zustand's persist marks only a SUCCESSFUL hydration as finished, so an
    // unparseable file used to leave every gated PR action waiting forever.
    backing.set(STORAGE_KEY, "{ this is not json");

    await usePrWorkflowStore.persist.rehydrate();

    const settled = await Promise.race([
      prWorkflowGraphForLaunch().then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
    ]);
    expect(settled).toBe("settled");
    expect(usePrWorkflowStore.getState().graph).toBeNull();
  });
});
