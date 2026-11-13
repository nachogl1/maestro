import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Every panel the left icon strip can open, in strip order (PRD §4.4). A new
 * panel adds its id here and its icon to `src/components/panels/panels.ts`.
 */
export const PANEL_IDS = [
  "history",
  "git",
  "notes",
  "workjournal",
  "inject",
  "launch",
  "secondbrain",
  "workshop",
  "infra",
  "settings",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

/** A panel is resized by its right edge, held between these widths. */
export const PANEL_MIN_WIDTH = 240;
export const PANEL_MAX_WIDTH = 640;
export const PANEL_DEFAULT_WIDTH = 320;

/** What a request to open or toggle a panel did. */
export type PanelToggleResult = "opened" | "closed" | "refused";

/** The last panel that did not fit; `seq` changes on every refusal so it can shake again. */
export interface PanelRefusal {
  id: PanelId;
  seq: number;
}

interface PanelStripState {
  /** Open panels in the order they were opened (the last one closes first). */
  openPanels: PanelId[];
  /** Widths the person chose; a panel never resized uses PANEL_DEFAULT_WIDTH. */
  widths: Partial<Record<PanelId, number>>;
  refusal: PanelRefusal | null;
  /** Opens a closed panel or closes an open one. `room` is the width all panels may share. */
  togglePanel: (id: PanelId, room: number) => PanelToggleResult;
  /** Opens a panel if it fits; an open panel stays open. */
  openPanel: (id: PanelId, room: number) => PanelToggleResult;
  closePanel: (id: PanelId) => void;
  setPanelWidth: (id: PanelId, width: number) => void;
  /** Closes the most recently opened panels until the rest fit in `room`; returns the closed ids. */
  closeToFit: (room: number) => PanelId[];
}

const PERSIST_KEY = "maestro-panel-strip";

export function clampPanelWidth(width: number): number {
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(width)));
}

export function panelWidthOf(widths: Partial<Record<PanelId, number>>, id: PanelId): number {
  return widths[id] ?? PANEL_DEFAULT_WIDTH;
}

function totalWidth(open: PanelId[], widths: Partial<Record<PanelId, number>>): number {
  return open.reduce((sum, id) => sum + panelWidthOf(widths, id), 0);
}

function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && (PANEL_IDS as readonly string[]).includes(value);
}

/** Keeps only known, distinct panel ids and valid widths from a saved (untrusted) value. */
export function sanitizePanelStrip(saved: unknown): {
  openPanels: PanelId[];
  widths: Partial<Record<PanelId, number>>;
} {
  const value = (saved ?? {}) as { openPanels?: unknown; widths?: unknown };
  const openPanels = Array.isArray(value.openPanels)
    ? value.openPanels.filter(
        (id, index, all): id is PanelId => isPanelId(id) && all.indexOf(id) === index,
      )
    : [];
  const widths: Partial<Record<PanelId, number>> = {};
  if (value.widths && typeof value.widths === "object") {
    for (const [id, width] of Object.entries(value.widths as Record<string, unknown>)) {
      if (isPanelId(id) && typeof width === "number" && Number.isFinite(width)) {
        widths[id] = clampPanelWidth(width);
      }
    }
  }
  return { openPanels, widths };
}

export const usePanelStripStore = create<PanelStripState>()(
  persist(
    (set, get) => {
      const open = (id: PanelId, room: number): PanelToggleResult => {
        const { openPanels, widths, refusal } = get();
        if (openPanels.includes(id)) return "opened";
        if (totalWidth([...openPanels, id], widths) > room) {
          set({ refusal: { id, seq: (refusal?.seq ?? 0) + 1 } });
          return "refused";
        }
        set({ openPanels: [...openPanels, id] });
        return "opened";
      };
      return {
        openPanels: ["history"],
        widths: {},
        refusal: null,
        togglePanel: (id, room) => {
          if (get().openPanels.includes(id)) {
            get().closePanel(id);
            return "closed";
          }
          return open(id, room);
        },
        openPanel: open,
        closePanel: (id) => set((s) => ({ openPanels: s.openPanels.filter((p) => p !== id) })),
        setPanelWidth: (id, width) =>
          set((s) => ({ widths: { ...s.widths, [id]: clampPanelWidth(width) } })),
        closeToFit: (room) => {
          const { openPanels, widths } = get();
          const kept = [...openPanels];
          const closed: PanelId[] = [];
          while (kept.length > 0 && totalWidth(kept, widths) > room) {
            closed.push(kept.pop() as PanelId);
          }
          if (closed.length > 0) set({ openPanels: kept });
          return closed;
        },
      };
    },
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ openPanels: s.openPanels, widths: s.widths }),
      // Nothing saved yet (first start) keeps the defaults.
      merge: (saved, current) => (saved ? { ...current, ...sanitizePanelStrip(saved) } : current),
    },
  ),
);
