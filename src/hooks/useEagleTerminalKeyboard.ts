import { useEffect } from "react";

import { isMac } from "@/lib/platform";

interface UseEagleTerminalKeyboardOptions {
  /** Whether the handler is listening (eagle view is showing). */
  enabled: boolean;
  /**
   * Cmd/Ctrl+1 inside a pane: toggle eagle zoom on it. Returns true when the
   * slot belongs to the caller — every project's grid listens in eagle view,
   * so a grid must decline panes it does not own.
   */
  onToggleZoom: (slotId: string) => boolean;
  /** Alt+P inside a pane: park it. Same ownership contract as `onToggleZoom`. */
  onPark: (slotId: string) => boolean;
}

/** The pane (slot) that owns a keyboard event's target, if any. */
function targetSlotId(event: KeyboardEvent): string | null {
  if (!(event.target instanceof Element)) return null;
  const host = event.target.closest<HTMLElement>("[data-slot-id]");
  return host?.dataset.slotId ?? null;
}

/**
 * Eagle view's Cmd/Ctrl+1 (zoom) and Alt+P (park). Per-project grids get
 * these from `useTerminalKeyboard`, which is off in eagle view because every
 * project's grid is on screen at once and each would act on its own focused
 * pane. Here the target is the pane the keyboard focus is actually in.
 *
 * Capture phase for the same reason as `useTerminalKeyboard`: xterm stops
 * propagation of keys it handles (Alt+P would otherwise reach the shell).
 */
export function useEagleTerminalKeyboard({
  enabled,
  onToggleZoom,
  onPark,
}: UseEagleTerminalKeyboardOptions): void {
  useEffect(() => {
    if (!enabled) return;

    function handleCapture(event: KeyboardEvent) {
      const modifierKey = isMac() ? event.metaKey : event.ctrlKey;
      const isZoom =
        modifierKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.code === "Digit1" || event.code === "Numpad1");
      const isPark =
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.code === "KeyP";
      if (!isZoom && !isPark) return;

      const slotId = targetSlotId(event);
      if (!slotId) return;
      const handled = isZoom ? onToggleZoom(slotId) : onPark(slotId);
      if (!handled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    window.addEventListener("keydown", handleCapture, { capture: true });
    return () => window.removeEventListener("keydown", handleCapture, { capture: true });
  }, [enabled, onToggleZoom, onPark]);
}
