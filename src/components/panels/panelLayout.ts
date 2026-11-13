import {
  type PanelId,
  type PanelToggleResult,
  usePanelStripStore,
} from "@/stores/usePanelStripStore";

/** Width of the icon strip on the far left. */
export const ICON_STRIP_WIDTH = 44;
/** The terminals always keep at least this much of the window. */
export const TERMINALS_MIN_WIDTH = 520;

/** Width every open panel may share in the current window. */
export function panelRoom(): number {
  return window.innerWidth - ICON_STRIP_WIDTH - TERMINALS_MIN_WIDTH;
}

/** Opens or closes a panel; a panel that would squeeze the terminals is refused. */
export function togglePanelInWindow(id: PanelId): PanelToggleResult {
  return usePanelStripStore.getState().togglePanel(id, panelRoom());
}

/** Opens a panel (leaving it open if it already is); refused when it does not fit. */
export function openPanelInWindow(id: PanelId): PanelToggleResult {
  return usePanelStripStore.getState().openPanel(id, panelRoom());
}
