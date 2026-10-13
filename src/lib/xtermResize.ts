/**
 * Debounced container-resize → xterm/PTY fit for one terminal. Extracted
 * verbatim from TerminalView's mount effect.
 *
 * Rapid window-drag resizes fire dozens of events per second; running
 * fitAddon.fit() on every tick produces a flood of term.resize() → resizePty
 * IPC calls that can race with in-flight PTY output, leaving the terminal
 * buffer reflowed at one size while text is being written for another. The
 * visible symptom is "mangled output" and a corrupted scrollback that the user
 * can't recover by scrolling up.
 *
 * We do a leading-edge fit (so the first resize lands immediately) plus a
 * trailing fit when the user stops dragging. Between those we only re-fit when
 * the computed (cols, rows) actually changed, which avoids sending no-op resize
 * IPC calls and avoids re-reflowing the xterm buffer unnecessarily.
 */
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

const RESIZE_DEBOUNCE_MS = 120;
// `resize_pty` rejects anything above this (see commands/terminal.rs).
// Fitting past it would reflow xterm to a geometry the PTY never adopts
// — the classic mangled-output symptom — while the rejection is only
// logged. Zooming out on a wide pane reaches it: the 10px font floor
// gives a ~3px cell, so ~1500 CSS px is already over 500 columns.
const MAX_PTY_DIM = 500;

export interface ContainerResizeFit {
  /** Cancels any pending debounced fit (rAF + trailing timer). */
  cancelPending: () => void;
  /** Stops observing the container. */
  disconnect: () => void;
}

/**
 * Observes `container` and refits `term` to it, debounced.
 * @param flushPendingOutput - Writes buffered PTY output before reflowing.
 * @param isDisposed - True once the owning view has unmounted.
 */
export function observeContainerResize(
  container: HTMLElement,
  term: Terminal,
  fitAddon: FitAddon,
  flushPendingOutput: () => void,
  isDisposed: () => boolean,
): ContainerResizeFit {
  let resizeRafId: number | null = null;
  let resizeTimerId: ReturnType<typeof setTimeout> | null = null;
  let lastFitCols = -1;
  let lastFitRows = -1;

  const runFit = (): void => {
    if (isDisposed()) return;
    try {
      // Flush any buffered PTY output first so reflow operates on the
      // final buffer state, not a half-written one.
      flushPendingOutput();
      const dims = fitAddon.proposeDimensions();
      if (!dims || dims.cols <= 0 || dims.rows <= 0) return;
      // Resize to the clamped size rather than calling fit(), so xterm and
      // the PTY always agree on the geometry.
      const cols = Math.min(dims.cols, MAX_PTY_DIM);
      const rows = Math.min(dims.rows, MAX_PTY_DIM);
      if (cols === lastFitCols && rows === lastFitRows) return;
      lastFitCols = cols;
      lastFitRows = rows;
      term.resize(cols, rows);
    } catch {
      // Container may have zero dimensions during layout transitions
    }
  };

  const resizeObserver = new ResizeObserver(() => {
    // Leading edge: if no debounce in flight, fit immediately on the next
    // animation frame so static layout changes feel responsive.
    if (resizeTimerId === null && resizeRafId === null) {
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;
        runFit();
      });
    }
    // Trailing edge: always reschedule the trailing fit so the FINAL
    // dimensions after a drag are applied once.
    if (resizeTimerId !== null) clearTimeout(resizeTimerId);
    resizeTimerId = setTimeout(() => {
      resizeTimerId = null;
      runFit();
    }, RESIZE_DEBOUNCE_MS);
  });
  resizeObserver.observe(container);

  return {
    cancelPending: () => {
      if (resizeRafId !== null) {
        cancelAnimationFrame(resizeRafId);
        resizeRafId = null;
      }
      if (resizeTimerId !== null) {
        clearTimeout(resizeTimerId);
        resizeTimerId = null;
      }
    },
    disconnect: () => resizeObserver.disconnect(),
  };
}
