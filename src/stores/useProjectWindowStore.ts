import { create } from "zustand";
import type { GridSnapshot } from "@/lib/projectWindow";

/**
 * Main-window bookkeeping for project tabs living in pop-out windows.
 *
 * Runtime-only (never persisted): pop-outs don't reopen on relaunch, so every
 * tab starts docked in the main window again.
 */
interface ProjectWindowState {
  /** Tab ids currently shown in a pop-out window. */
  poppedOut: Record<string, true>;
  /** Latest grid reported by each pop-out; seeds the grid when the tab docks. */
  latestGrids: Record<string, GridSnapshot | null>;
  /** Grids to seed docked tabs with, consumed once the grid has mounted. */
  dockSeeds: Record<string, GridSnapshot>;
  /** Record a tab as moved to a pop-out, with the grid it left with. */
  markPoppedOut: (tabId: string, grid: GridSnapshot | null) => void;
  /** Store the latest grid reported by a pop-out. Ignored once docked. */
  setLatestGrid: (tabId: string, grid: GridSnapshot | null) => void;
  /** Bring a tab back to the main window, seeding its grid from the pop-out. */
  dock: (tabId: string) => void;
  /** Drop a dock seed once the docked grid has been built from it. */
  consumeDockSeed: (tabId: string) => void;
  /** Pop-out window: seed its grid with the layout handed over by the main window. */
  seedGrid: (tabId: string, grid: GridSnapshot) => void;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export const useProjectWindowStore = create<ProjectWindowState>((set) => ({
  poppedOut: {},
  latestGrids: {},
  dockSeeds: {},

  markPoppedOut: (tabId, grid) =>
    set((state) => ({
      poppedOut: { ...state.poppedOut, [tabId]: true },
      latestGrids: { ...state.latestGrids, [tabId]: grid },
      dockSeeds: without(state.dockSeeds, tabId),
    })),

  setLatestGrid: (tabId, grid) =>
    set((state) =>
      state.poppedOut[tabId] ? { latestGrids: { ...state.latestGrids, [tabId]: grid } } : state,
    ),

  dock: (tabId) =>
    set((state) => {
      if (!state.poppedOut[tabId]) return state;
      const grid = state.latestGrids[tabId];
      return {
        poppedOut: without(state.poppedOut, tabId),
        latestGrids: without(state.latestGrids, tabId),
        dockSeeds: grid ? { ...state.dockSeeds, [tabId]: grid } : state.dockSeeds,
      };
    }),

  seedGrid: (tabId, grid) => set((state) => ({ dockSeeds: { ...state.dockSeeds, [tabId]: grid } })),

  consumeDockSeed: (tabId) =>
    set((state) =>
      state.dockSeeds[tabId] ? { dockSeeds: without(state.dockSeeds, tabId) } : state,
    ),
}));
