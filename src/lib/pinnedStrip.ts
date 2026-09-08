import type { CSSProperties } from "react";

/**
 * The pinned strip: a row along the bottom of the terminal area that keeps
 * pinned terminals from OTHER projects on screen while you work in this one.
 *
 * Nothing here moves a terminal in the DOM — that would remount its xterm and
 * lose the scrollback. A pinned terminal stays inside its own project's grid;
 * the grid flattens (`display: contents`, exactly as in eagle view) and the
 * tile is absolutely positioned into the strip, which resolves against the
 * content container. See `TerminalGrid`'s `pinnedTileStyles`.
 */
export const PIN_STRIP_HEIGHT = 200;
/** Height of the strip's "PINNED" caption row, above the tiles. */
export const PIN_STRIP_LABEL = 18;
export const PIN_STRIP_PAD = 8;
export const PIN_STRIP_GAP = 8;

/** The slice of a workspace tab the strip layout needs. */
export interface PinnedStripTab {
  id: string;
  active: boolean;
  sessionsLaunched: boolean;
  sessionIds: number[];
}

/**
 * Placement for every pinned terminal that belongs to a project other than the
 * active one, grouped by the tab that owns it — `null` when the strip should
 * not show at all (nothing pinned, or every pin is in the active project,
 * parked, or in a project with no grid mounted).
 *
 * Deliberately excludes the ACTIVE project's own pins: those terminals are
 * already on screen in their normal grid, and lifting them into the strip
 * would shrink the very pane the user is working in.
 *
 * Cells are sized in `calc()` off the container's own width so the strip needs
 * no measurement pass and reflows with the window for free.
 */
export function pinnedStripLayout(
  tabs: readonly PinnedStripTab[],
  pinnedSessionIds: readonly number[],
  parkedSessionIds: readonly number[],
): Map<string, Map<number, CSSProperties>> | null {
  if (pinnedSessionIds.length === 0) return null;
  const activeTabId = tabs.find((t) => t.active)?.id;
  const entries: { tabId: string; sessionId: number }[] = [];
  for (const tab of tabs) {
    if (tab.id === activeTabId || !tab.sessionsLaunched) continue;
    for (const sessionId of tab.sessionIds) {
      if (!pinnedSessionIds.includes(sessionId)) continue;
      // A parked pane is hidden by design — it must not claim a strip cell.
      if (parkedSessionIds.includes(sessionId)) continue;
      entries.push({ tabId: tab.id, sessionId });
    }
  }
  if (entries.length === 0) return null;

  const count = entries.length;
  // Width left for the tiles once the outer padding and the gaps between them
  // are taken out.
  const inner = `(100% - ${2 * PIN_STRIP_PAD + (count - 1) * PIN_STRIP_GAP}px)`;
  const byTab = new Map<string, Map<number, CSSProperties>>();
  entries.forEach(({ tabId, sessionId }, index) => {
    const style: CSSProperties = {
      bottom: PIN_STRIP_PAD,
      height: PIN_STRIP_HEIGHT - PIN_STRIP_LABEL - PIN_STRIP_PAD,
      width: `calc(${inner} / ${count})`,
      left: `calc(${inner} / ${count} * ${index} + ${PIN_STRIP_PAD + index * PIN_STRIP_GAP}px)`,
    };
    const forTab = byTab.get(tabId) ?? new Map<number, CSSProperties>();
    forTab.set(sessionId, style);
    byTab.set(tabId, forTab);
  });
  return byTab;
}
