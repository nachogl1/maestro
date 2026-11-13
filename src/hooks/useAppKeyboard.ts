import { useEffect } from "react";
import { panelForShortcut } from "@/components/panels/panels";
import type { PanelId } from "@/stores/usePanelStripStore";

interface UseAppKeyboardOptions {
  /** Callback to add a new terminal (Cmd/Ctrl+T) — context-aware (grid/zoom/eagle) */
  onAddSession: () => void;
  /** Whether adding a session is currently allowed */
  canAddSession: boolean;
  /** Alt+1-4 and Cmd/Ctrl+2 / +5: toggle the left-strip panel the shortcut names */
  onTogglePanel?: (panel: PanelId) => void;
  /** Callback to toggle the eagle all-projects terminals view (Cmd/Ctrl+G) */
  onToggleEagleView?: () => void;
  /** Ctrl+Tab (all platforms): switch to the next project tab */
  onNextProject?: () => void;
  /** Ctrl+Shift+Tab (all platforms): switch to the previous project tab */
  onPrevProject?: () => void;
  /** Alt+M: open the issue map for the focused project */
  onOpenIssueMap?: () => void;
}

/**
 * Detect whether the current platform uses Cmd (Mac) or Ctrl (Windows/Linux) as the modifier key.
 */
function isMac(): boolean {
  return navigator.platform.toLowerCase().includes("mac");
}

/**
 * App-level keyboard shortcut handler.
 *
 * Shortcuts:
 * - Alt+1-4: Toggle the History / Infra / Settings / Injector panel
 * - Alt+M: Open the issue map for the focused project
 * - Cmd/Ctrl+2: Toggle the Git panel
 * - Cmd/Ctrl+5: Toggle the Notes panel
 * - Cmd/Ctrl+T: Add a new terminal (project picker in eagle view)
 * - Cmd/Ctrl+G: Toggle the eagle all-projects terminals view
 * - Ctrl+Tab / Ctrl+Shift+Tab (all platforms): Next / previous project tab
 */
export function useAppKeyboard({
  onAddSession,
  canAddSession,
  onTogglePanel,
  onToggleEagleView,
  onNextProject,
  onPrevProject,
  onOpenIssueMap,
}: UseAppKeyboardOptions): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Alt-based shortcuts (no Cmd/Ctrl, no Shift)
      // Use event.code so the bindings are layout-independent (AZERTY etc.).
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        // Alt+digit: the panel it names. Top-row digits only — Alt+numpad
        // digits must stay free for Windows Alt-code entry (e.g. Alt+164 → ñ
        // typed into a terminal).
        const altDigit = /^Digit(\d)$/.exec(event.code);
        const altPanel = altDigit ? panelForShortcut("alt", altDigit[1]) : undefined;
        if (altPanel && onTogglePanel) {
          event.preventDefault();
          event.stopImmediatePropagation();
          onTogglePanel(altPanel);
          return;
        }
        // Alt+M: the issue map window for the focused project.
        if (event.code === "KeyM" && onOpenIssueMap) {
          event.preventDefault();
          event.stopImmediatePropagation();
          onOpenIssueMap();
        }
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: cycle project tabs. Ctrl on EVERY platform
      // (browser/VS Code convention) — macOS reserves Cmd+Tab for the system
      // app switcher, so a Cmd binding could never fire there.
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) {
          onPrevProject?.();
        } else {
          onNextProject?.();
        }
        return;
      }

      const modifierKey = isMac() ? event.metaKey : event.ctrlKey;
      if (!modifierKey) return;

      // Don't interfere with other modifier combinations
      if (event.altKey || event.shiftKey) return;

      // Cmd/Ctrl+digit (top row or numpad): Git (2) and Notes (5).
      // Use event.code so this still triggers on layouts where Ctrl+2 produces a non-"2" event.key.
      const modDigit = /^(?:Digit|Numpad)(\d)$/.exec(event.code);
      const modPanel = modDigit ? panelForShortcut("mod", modDigit[1]) : undefined;
      if (modPanel && onTogglePanel) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onTogglePanel(modPanel);
        return;
      }

      if (event.code === "KeyT") {
        // Always prevent default to block WebView's new-tab behavior
        event.preventDefault();
        if (canAddSession) {
          onAddSession();
        }
        return;
      }

      // Cmd/Ctrl+G: toggle the eagle all-projects terminals view.
      if (event.code === "KeyG" && onToggleEagleView) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onToggleEagleView();
      }
    }

    // Register in the capture phase so the App-level shortcuts (especially Cmd/Ctrl+2
    // which competes with browser tab-switching defaults) win against any descendant
    // bubble-phase listener — including xterm's textarea and other modal handlers.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [
    onAddSession,
    canAddSession,
    onTogglePanel,
    onToggleEagleView,
    onNextProject,
    onPrevProject,
    onOpenIssueMap,
  ]);
}
