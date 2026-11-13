import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/terminal", () => ({
  killSession: vi.fn().mockResolvedValue(undefined),
}));

import { swapIds } from "@/lib/dragSwap";
import { compareRowMajor, rowOfColumns, swapTiles } from "@/lib/eagleLayout";
import { sortByParkedOrder, useParkedOrderStore } from "@/stores/useParkedOrderStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

const LETTERS = ["A", "B", "C", "D", "E"];
/** The eagle strip and the parked shelf key their tabs by session id. */
const idOf = (letter: string): number => LETTERS.indexOf(letter) + 1;
const letterOf = (id: number): string => LETTERS[id - 1];

function projectTabsDrop(order: string[], dragged: string, target: string): string[] {
  useWorkspaceStore.setState({
    tabs: order.map((id) => ({
      id,
      name: id,
      active: false,
      projectPath: `/path/${id}`,
      sessionIds: [],
      sessionsLaunched: false,
      workspaceType: "single-repo" as const,
      repositories: [],
      selectedRepoPath: null,
      worktreeBasePath: null,
    })),
  });
  useWorkspaceStore.getState().reorderTabs(dragged, target);
  return useWorkspaceStore.getState().tabs.map((tab) => tab.id);
}

function zoomViewDrop(order: string[], dragged: string, target: string): string[] {
  return swapIds(order, dragged, target) ?? order;
}

function eagleStripDrop(order: string[], dragged: string, target: string): string[] {
  const tiles = rowOfColumns(order.map(idOf));
  if (!tiles) throw new Error("no layout");
  const swapped = swapTiles(tiles, idOf(dragged), idOf(target)) ?? tiles;
  return [...swapped].sort(([, a], [, b]) => compareRowMajor(a, b)).map(([id]) => letterOf(id));
}

function parkedShelfDrop(order: string[], dragged: string, target: string): string[] {
  const ids = order.map(idOf);
  useParkedOrderStore.getState().move(ids, idOf(dragged), idOf(target), ids);
  const pills = sortByParkedOrder(
    ids.map((id) => ({ id })),
    useParkedOrderStore.getState().order,
  );
  return pills.map((pill) => letterOf(pill.id));
}

describe("dropping a tab onto another swaps just those two, in every drag row", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ tabs: [], zoomTabOrders: {} });
    useParkedOrderStore.setState({ order: [] });
  });

  const rows = [
    ["project tabs", projectTabsDrop],
    ["zoom view tabs", zoomViewDrop],
    ["eagle zoom strip", eagleStripDrop],
    ["parked shelf pills", parkedShelfDrop],
  ] as const;
  const drops = [
    { dragged: "B", target: "D" },
    { dragged: "D", target: "B" },
  ];

  it.each(
    rows.flatMap(([row, drop]) =>
      drops.map(({ dragged, target }) => ({ row, drop, dragged, target })),
    ),
  )("$row: $dragged dropped on $target gives A D C B E", ({ drop, dragged, target }) => {
    expect(drop(LETTERS, dragged, target)).toEqual(["A", "D", "C", "B", "E"]);
  });
});

describe("swapIds", () => {
  it("keeps the zoom view's hidden (parked) slots where they were", () => {
    const stored = ["a", "parked-1", "b", "c", "parked-2", "d"];

    expect(swapIds(stored, "b", "d")).toEqual(["a", "parked-1", "d", "c", "parked-2", "b"]);
  });

  it("ignores a drop on itself or on an id the list does not hold", () => {
    expect(swapIds(["a", "b"], "a", "a")).toBeNull();
    expect(swapIds(["a", "b"], "a", "z")).toBeNull();
  });
});
