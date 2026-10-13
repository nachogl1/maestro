import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri plugin-store must be mocked before importing the store module.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

import type { QuickAction } from "@/types/quickAction";
import { useQuickActionStore } from "../useQuickActionStore";

function newAction(name: string, isEnabled = true) {
  return { name, icon: "Star", colorHex: "#34C759", prompt: `do ${name}`, isEnabled };
}

function names(actions: QuickAction[]): string[] {
  return actions.map((a) => a.name);
}

describe("useQuickActionStore", () => {
  beforeEach(() => {
    useQuickActionStore.setState({ actions: [], hasInitialized: true });
  });

  it("addAction assigns an id, timestamp and the next sort order", () => {
    useQuickActionStore.getState().addAction(newAction("A"));
    useQuickActionStore.getState().addAction(newAction("B"));
    const [a, b] = useQuickActionStore.getState().actions;
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
    expect(Number.isNaN(Date.parse(a.createdAt))).toBe(false);
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
  });

  it("addAction continues after the highest existing sort order", () => {
    useQuickActionStore.getState().addAction(newAction("A"));
    const id = useQuickActionStore.getState().actions[0].id;
    useQuickActionStore.getState().updateAction(id, { sortOrder: 7 });
    useQuickActionStore.getState().addAction(newAction("B"));
    expect(useQuickActionStore.getState().actions[1].sortOrder).toBe(8);
  });

  it("updateAction merges fields into the matching action only", () => {
    useQuickActionStore.getState().addAction(newAction("A"));
    useQuickActionStore.getState().addAction(newAction("B"));
    const id = useQuickActionStore.getState().actions[0].id;

    useQuickActionStore.getState().updateAction(id, { name: "A2", isEnabled: false });

    const [a, b] = useQuickActionStore.getState().actions;
    expect(a).toMatchObject({ id, name: "A2", isEnabled: false, prompt: "do A" });
    expect(b.name).toBe("B");
  });

  it("deleteAction removes the action and re-normalizes sort orders", () => {
    for (const n of ["A", "B", "C"]) useQuickActionStore.getState().addAction(newAction(n));
    const idB = useQuickActionStore.getState().actions[1].id;

    useQuickActionStore.getState().deleteAction(idB);

    const actions = useQuickActionStore.getState().actions;
    expect(names(actions)).toEqual(["A", "C"]);
    expect(actions.map((a) => a.sortOrder)).toEqual([0, 1]);
  });

  it("getSortedActions returns only enabled actions in sort order", () => {
    for (const n of ["A", "B", "C"]) useQuickActionStore.getState().addAction(newAction(n));
    const [a, b, c] = useQuickActionStore.getState().actions;
    useQuickActionStore.getState().updateAction(a.id, { sortOrder: 5 });
    useQuickActionStore.getState().updateAction(b.id, { isEnabled: false });

    const sorted = useQuickActionStore.getState().getSortedActions();

    expect(names(sorted)).toEqual(["C", "A"]);
    expect(sorted[0].id).toBe(c.id);
  });

  it("resetToDefaults installs the four built-in actions and marks initialized", () => {
    useQuickActionStore.setState({ actions: [], hasInitialized: false });

    useQuickActionStore.getState().resetToDefaults();

    const state = useQuickActionStore.getState();
    expect(names(state.actions)).toEqual([
      "Run App",
      "Commit & Push",
      "Fix Errors",
      "Lint & Format",
    ]);
    expect(state.actions.map((a) => a.sortOrder)).toEqual([0, 1, 2, 3]);
    expect(state.hasInitialized).toBe(true);
  });

  it("rehydrating with nothing stored seeds the defaults on first launch", async () => {
    useQuickActionStore.setState({ actions: [], hasInitialized: false });

    await useQuickActionStore.persist.rehydrate();

    const state = useQuickActionStore.getState();
    expect(state.hasInitialized).toBe(true);
    expect(state.actions).toHaveLength(4);
  });

  it("rehydrating after initialization does not re-seed the defaults", async () => {
    useQuickActionStore.setState({ actions: [], hasInitialized: true });

    await useQuickActionStore.persist.rehydrate();

    expect(useQuickActionStore.getState().actions).toEqual([]);
  });
});
