import { useEffect } from "react";

import type { MoveDirection } from "@/lib/paneMoves";

interface UseTerminalKeyboardOptions {
  /** Total number of launched terminals */
  terminalCount: number;
  /** Callback to cycle focus to the next terminal (Cmd/Ctrl+Alt+Right) */
  onCycleNext: () => void;
  /** Callback to cycle focus to the previous terminal (Cmd/Ctrl+Alt+Left) */
  onCyclePrevious: () => void;
  /** Callback to toggle maximize on the focused terminal (Cmd/Ctrl+1) */
  onToggleZoomFocused?: () => void;
  /** Callback when Alt+ArrowRight is pressed (used to cycle zoomed terminal forward) */
  onZoomedNext?: () => void;
  /** Callback when Alt+ArrowLeft is pressed (used to cycle zoomed terminal backward) */
  onZoomedPrev?: () => void;
  /** Callback to park the focused terminal (Alt+P) */
  onParkFocused?: () => void;
  /** Callback to move the focused terminal one pane in a direction (Alt+Shift+Arrow) */
  onMoveFocused?: (direction: MoveDirection) => void;
  /** Callback to give every terminal an even share of the layout (Alt+T) */
  onTidyLayout?: () => void;
  /**
   * Whether a single terminal is currently zoomed/maximized. When true, the
   * tab strip is visible and Alt+Left/Alt+Right cycle between tabs. When
   * false, those keys must fall through to xterm.js so Alt+Arrow keeps its
   * default meaning (word-movement inside the terminal).
   */
  isZoomed?: boolean;
  /** Whether this keyboard handler is active (e.g. only for the active project tab) */
  enabled?: boolean;
}

/** Arrow key → move direction for Alt+Shift+Arrow. */
const ARROW_DIRECTIONS: Record<string, MoveDirection | undefined> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * Detect whether the current platform uses Cmd (Mac) or Ctrl (Windows/Linux) as the modifier key.
 */
function isMac(): boolean {
  return navigator.platform.toLowerCase().includes("mac");
}

/**
 * Global keyboard shortcut handler for terminal navigation.
 *
 * Shortcuts:
 * - Cmd/Ctrl+1: Toggle maximize/zoom on the focused terminal
 * - Cmd/Ctrl+Alt+Left/Right: Cycle focus to the previous/next terminal
 * - Alt+Left/Right: Previous/next terminal tab while zoomed
 * - Alt+P: Park the focused terminal
 * - Alt+T: Tidy up — give every terminal an even share of the layout
 * - Alt+Shift+Arrow: Move the focused terminal one pane in that direction
 */
export function useTerminalKeyboard({
  terminalCount,
  onCycleNext,
  onCyclePrevious,
  onToggleZoomFocused,
  onZoomedNext,
  onZoomedPrev,
  onParkFocused,
  onMoveFocused,
  onTidyLayout,
  isZoomed = false,
  enabled = true,
}: UseTerminalKeyboardOptions): void {
  // Alt+Arrow, Cmd/Ctrl+Alt+Arrow and Alt+P need CAPTURE-phase handling.
  // xterm.js's key handler calls event.stopPropagation() for keys it
  // processes, which kills any later bubble-phase listener — so a
  // bubble-phase shortcut never fires while a terminal has focus. By
  // registering in capture we win the race before xterm sees the event.
  //
  // We only consume bare Alt+Arrow when a terminal is currently zoomed, so
  // users still get default Alt+Arrow word-movement inside the terminal in
  // normal split-pane mode.
  useEffect(() => {
    if (!enabled) return;

    function handleCapture(event: KeyboardEvent) {
      if (event.type !== "keydown") return;

      const modifierKey = isMac() ? event.metaKey : event.ctrlKey;

      // Cmd/Ctrl+Alt+Left/Right: cycle terminal focus.
      if (modifierKey && event.altKey && !event.shiftKey) {
        if (terminalCount === 0) return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          event.stopImmediatePropagation();
          onCycleNext();
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          event.stopImmediatePropagation();
          onCyclePrevious();
          return;
        }
        return;
      }

      // Alt+Shift+Arrow: move the focused pane (swap with its neighbour).
      if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
        const direction = ARROW_DIRECTIONS[event.key];
        if (direction && onMoveFocused) {
          event.preventDefault();
          event.stopImmediatePropagation();
          onMoveFocused(direction);
        }
        return;
      }

      // Alt-only shortcuts (no Cmd/Ctrl, no Shift)
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

      // Alt+P: park the focused terminal. event.code for layout independence.
      if (event.code === "KeyP" && onParkFocused) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onParkFocused();
        return;
      }

      // Alt+T: tidy up the layout. event.code for layout independence.
      if (event.code === "KeyT" && onTidyLayout) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onTidyLayout();
        return;
      }

      // Alt+Left/Right: cycle zoom tabs — only while zoomed.
      if (!isZoomed) return;
      if (event.key === "ArrowRight" && onZoomedNext) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onZoomedNext();
        return;
      }
      if (event.key === "ArrowLeft" && onZoomedPrev) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onZoomedPrev();
        return;
      }
    }

    window.addEventListener("keydown", handleCapture, { capture: true });
    return () => window.removeEventListener("keydown", handleCapture, { capture: true });
  }, [
    enabled,
    isZoomed,
    terminalCount,
    onCycleNext,
    onCyclePrevious,
    onZoomedNext,
    onZoomedPrev,
    onParkFocused,
    onMoveFocused,
    onTidyLayout,
  ]);

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      const modifierKey = isMac() ? event.metaKey : event.ctrlKey;
      if (!modifierKey) return;

      // Don't interfere with other modifier combinations
      if (event.altKey || event.shiftKey) return;

      // Cmd/Ctrl+1: toggle maximize/zoom on the focused terminal.
      // Use event.code so this is layout-independent.
      if ((event.code === "Digit1" || event.code === "Numpad1") && onToggleZoomFocused) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onToggleZoomFocused();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onToggleZoomFocused]);
}
