/**
 * PTY output batching for one xterm.js terminal: chunks arriving from the
 * backend are buffered and written once per animation frame, which cuts
 * xterm.js render overhead. Extracted verbatim from TerminalView's mount effect.
 */

/** The only part of the xterm `Terminal` the batcher touches. */
interface WritableTerminal {
  write: (data: string) => void;
}

/** Force flush at ~400KB (100 × 4KB chunks). */
const MAX_BUFFER_CHUNKS = 100;
/** 20fps floor for backgrounded tabs (rAF is throttled there). */
const FALLBACK_FLUSH_MS = 50;

export interface PtyOutputBatcher {
  /** Buffers a chunk; flushes immediately when the buffer is full, else schedules a flush. */
  push: (data: string) => void;
  /** Writes everything buffered so far to the terminal now. */
  flush: () => void;
  /** Whether any output is still waiting to be written. */
  hasPending: () => boolean;
  /** Cancels the scheduled rAF / fallback-timer flush, if any. */
  cancelPendingFlush: () => void;
  /** Cleanup: writes any remaining output (ignoring errors) and empties the buffer. */
  drain: () => void;
}

/**
 * Creates a batcher bound to a terminal that may not exist yet.
 * @param getTerm - Returns the terminal, or null before it is created.
 * @param isDisposed - True once the owning view has unmounted.
 */
export function createPtyOutputBatcher(
  getTerm: () => WritableTerminal | null,
  isDisposed: () => boolean,
): PtyOutputBatcher {
  let writeBuffer: string[] = [];
  let rafId: number | null = null;
  let fallbackTimerId: ReturnType<typeof setTimeout> | null = null;

  const cancelPendingFlush = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (fallbackTimerId !== null) {
      clearTimeout(fallbackTimerId);
      fallbackTimerId = null;
    }
  };

  const flush = (): void => {
    cancelPendingFlush();
    const term = getTerm();
    if (isDisposed() || !term || writeBuffer.length === 0) {
      writeBuffer = [];
      return;
    }
    const data = writeBuffer.join("");
    writeBuffer = []; // Clear BEFORE write to prevent duplicates on error
    try {
      term.write(data);
    } catch (e) {
      console.error("[TerminalView] write error:", e);
    }
  };

  const scheduleFlush = (): void => {
    if (rafId !== null) return; // Already scheduled
    rafId = requestAnimationFrame(flush);
    if (fallbackTimerId === null) {
      fallbackTimerId = setTimeout(flush, FALLBACK_FLUSH_MS);
    }
  };

  const push = (data: string): void => {
    writeBuffer.push(data);
    if (writeBuffer.length >= MAX_BUFFER_CHUNKS) {
      flush(); // Backpressure: immediate flush if buffer full
    } else {
      scheduleFlush();
    }
  };

  const drain = (): void => {
    // Flush remaining buffered output before disposal
    const term = getTerm();
    if (term && writeBuffer.length > 0) {
      try {
        term.write(writeBuffer.join(""));
      } catch {
        /* ignore errors during cleanup */
      }
    }
    writeBuffer = [];
  };

  return {
    push,
    flush,
    hasPending: () => writeBuffer.length > 0,
    cancelPendingFlush,
    drain,
  };
}
