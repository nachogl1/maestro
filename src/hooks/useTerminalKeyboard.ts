import { useEffect } from "react";

interface UseTerminalKeyboardOptions {
  /** Total number of launched terminals */
  terminalCount: number;
  /** Currently focused terminal index (0-based), or null if none focused */
  focusedIndex: number | null;
  /** Callback to focus a specific terminal by index */
  onFocusTerminal: (index: number) => void;
  /** Callback to cycle to the next terminal */
  onCycleNext: () => void;
  /** Callback to cycle to the previous terminal */
  onCyclePrevious: () => void;
  /** Callback to split the focused terminal vertically (Cmd+D) */
  onSplitVertical?: () => void;
  /** Callback to split the focused terminal horizontally (Cmd+Shift+D) */
  onSplitHorizontal?: () => void;
  /** Callback to close the focused pane (Cmd+W) */
  onClosePane?: () => void;
  /** Callback to toggle maximize on the focused terminal (Cmd/Ctrl+1) */
  onToggleZoomFocused?: () => void;
  /** Callback when Alt+ArrowRight is pressed (used to cycle zoomed terminal forward) */
  onZoomedNext?: () => void;
  /** Callback when Alt+ArrowLeft is pressed (used to cycle zoomed terminal backward) */
  onZoomedPrev?: () => void;
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
 * - Cmd/Ctrl+1-9,0: Jump to terminal N (1-9 for terminals 1-9, 0 for terminal 10)
 * - Cmd/Ctrl+[: Cycle to previous terminal
 * - Cmd/Ctrl+]: Cycle to next terminal
 */
export function useTerminalKeyboard({
  terminalCount,
  focusedIndex,
  onFocusTerminal,
  onCycleNext,
  onCyclePrevious,
  onSplitVertical,
  onSplitHorizontal,
  onClosePane,
  onToggleZoomFocused,
  onZoomedNext,
  onZoomedPrev,
  isZoomed = false,
  enabled = true,
}: UseTerminalKeyboardOptions): void {
  // Alt+Arrow needs CAPTURE-phase handling. xterm.js's key handler calls
  // event.stopPropagation() for keys it processes, which kills any later
  // bubble-phase listener — so a bubble-phase Alt+Arrow shortcut never fires
  // while a terminal has focus. By registering in capture we win the race
  // before xterm sees the event.
  //
  // We only consume Alt+Arrow when a terminal is currently zoomed, so users
  // still get default Alt+Arrow word-movement inside the terminal in normal
  // split-pane mode.
  useEffect(() => {
    if (!enabled || !isZoomed) return;

    function handleAltArrowCapture(event: KeyboardEvent) {
      if (event.type !== "keydown") return;
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
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

    window.addEventListener("keydown", handleAltArrowCapture, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleAltArrowCapture, { capture: true });
  }, [enabled, isZoomed, onZoomedNext, onZoomedPrev]);

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      const modifierKey = isMac() ? event.metaKey : event.ctrlKey;
      if (!modifierKey) return;

      // Cmd/Ctrl+D: split pane (Shift = horizontal, no Shift = vertical)
      // Works even with 0 launched terminals (splits pre-launch cards too)
      if (event.key === "d" && !event.altKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) {
          onSplitHorizontal?.();
        } else {
          onSplitVertical?.();
        }
        return;
      }

      // Cmd/Ctrl+W: close the focused pane
      if (event.key === "w" && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClosePane?.();
        return;
      }

      // Cmd/Ctrl+1: toggle maximize/zoom on the focused terminal.
      // Overrides the legacy "focus terminal 1" mapping at the user's request.
      // Use event.code so this is layout-independent.
      if (
        (event.code === "Digit1" || event.code === "Numpad1") &&
        !event.altKey &&
        !event.shiftKey &&
        onToggleZoomFocused
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onToggleZoomFocused();
        return;
      }

      // Navigation shortcuts only apply when terminals exist
      if (terminalCount === 0) return;

      // Don't interfere with other modifier combinations
      if (event.altKey || event.shiftKey) return;

      // Handle number keys 2-9 and 0 for terminal jumping.
      // "1" is reserved for toggle-zoom (handled above);
      // "2" is reserved for the git panel (handled at the App level).
      if (event.key >= "3" && event.key <= "9") {
        const targetIndex = parseInt(event.key, 10) - 1;
        if (targetIndex < terminalCount) {
          event.preventDefault();
          onFocusTerminal(targetIndex);
        }
        return;
      }

      if (event.key === "0") {
        // 0 maps to terminal 10 (index 9)
        const targetIndex = 9;
        if (targetIndex < terminalCount) {
          event.preventDefault();
          onFocusTerminal(targetIndex);
        }
        return;
      }

      // Handle bracket keys for cycling
      if (event.key === "]") {
        event.preventDefault();
        onCycleNext();
        return;
      }

      if (event.key === "[") {
        event.preventDefault();
        onCyclePrevious();
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, terminalCount, focusedIndex, onFocusTerminal, onCycleNext, onCyclePrevious, onSplitVertical, onSplitHorizontal, onClosePane, onToggleZoomFocused]);
}
