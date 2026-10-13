import { openUrl } from "@tauri-apps/plugin-opener";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { MutableRefObject, RefObject } from "react";
import { useEffect } from "react";

import { createActivityStatusTracker } from "@/lib/activityStatusTracker";
import { buildFontFamily, waitForFont } from "@/lib/fonts";
import { createPtyOutputBatcher } from "@/lib/ptyOutputBatcher";
import { onPtyOutput, signalTerminalReady } from "@/lib/terminal";
import { DEFAULT_THEME, LIGHT_THEME, toXtermTheme } from "@/lib/terminalTheme";
import { attachXtermInput, registerOsc52Clipboard } from "@/lib/xtermInput";
import { type ContainerResizeFit, observeContainerResize } from "@/lib/xtermResize";
import { DEFAULT_SCROLLBACK, useTerminalSettingsStore } from "@/stores/useTerminalSettingsStore";

/** Refs shared between {@link useXtermSession} and the view that hosts the terminal. */
interface UseXtermSessionOptions {
  sessionId: number;
  containerRef: RefObject<HTMLDivElement | null>;
  /** Set to the live Terminal once created, null after unmount. */
  termRef: MutableRefObject<Terminal | null>;
  /** Set to the live FitAddon once created, null after unmount. */
  fitAddonRef: MutableRefObject<FitAddon | null>;
  /** Current isFocused prop (read after the async font wait, so must be a ref). */
  isFocusedRef: MutableRefObject<boolean>;
}

/**
 * Creates the xterm.js Terminal in `container` with its addons and renderer
 * (WebGL → Canvas2D → DOM fallback), using the settings read at init time.
 */
function createXterm(
  container: HTMLElement,
  fontFamily: string,
  currentSettings: ReturnType<typeof useTerminalSettingsStore.getState>,
): { term: Terminal; fitAddon: FitAddon } {
  const initialTheme =
    document.documentElement.getAttribute("data-theme") === "light" ? LIGHT_THEME : DEFAULT_THEME;
  // Scrollback is user-configurable: every retained line costs cols × 3
  // 32-bit cells for the life of the Terminal, and every open project keeps
  // its terminals mounted, so this dominates renderer memory.
  // Reduce scrollback on Linux where the DOM renderer is slow in WebKitGTK.
  // Deep scrollback with the DOM renderer causes severe lag — but only
  // while the setting is untouched; an explicit user value wins.
  const isLinux = navigator.userAgent.toLowerCase().includes("linux");
  const configuredScrollback = currentSettings.settings.scrollback;
  const scrollback =
    isLinux && configuredScrollback === DEFAULT_SCROLLBACK ? 2000 : configuredScrollback;
  const term = new Terminal({
    cursorBlink: true,
    fontSize: currentSettings.getEffectiveFontSize(),
    fontFamily: fontFamily,
    lineHeight: currentSettings.settings.lineHeight,
    theme: toXtermTheme(initialTheme),
    allowProposedApi: true,
    scrollback,
    tabStopWidth: 8,
  });

  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon((_event, uri) => {
    openUrl(uri);
  });

  const unicode11Addon = new Unicode11Addon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);
  term.loadAddon(unicode11Addon);
  term.unicode.activeVersion = "11";
  term.open(container);
  return { term, fitAddon };
}

/**
 * GPU-accelerated rendering (must be loaded after open()).
 * Try WebGL first, fall back to Canvas2D (much faster than DOM on Linux).
 */
function loadRenderer(term: Terminal): void {
  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
      try {
        term.loadAddon(new CanvasAddon());
      } catch {
        /* DOM renderer as final fallback */
      }
    });
    term.loadAddon(webglAddon);
  } catch {
    // WebGL not available — use Canvas2D renderer
    try {
      term.loadAddon(new CanvasAddon());
    } catch {
      /* DOM renderer as final fallback */
    }
  }
}

/**
 * Owns the lifetime of one xterm.js terminal bound to a backend PTY session.
 *
 * On mount (and on sessionId change): waits for the font, creates the Terminal
 * in `containerRef`, wires input/clipboard/resize to the PTY, subscribes to
 * `pty-output-{sessionId}` (batched writes + activity-based status detection),
 * and signals the backend that the terminal is ready.
 *
 * On unmount: sets a `disposed` flag to prevent late PTY writes, cancels
 * pending flushes/fits/status timers, writes any remaining buffered output,
 * disconnects the ResizeObserver, disposes xterm listeners, unsubscribes the
 * Tauri event listener (even if the listener promise hasn't resolved yet), and
 * destroys the Terminal.
 */
export function useXtermSession({
  sessionId,
  containerRef,
  termRef,
  fitAddonRef,
  isFocusedRef,
}: UseXtermSessionOptions): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Get current settings at initialization time (not reactive)
    const currentSettings = useTerminalSettingsStore.getState();
    const effectiveFont = currentSettings.getEffectiveFontFamily();
    const fontFamily = buildFontFamily(effectiveFont);

    let disposed = false;
    const isDisposed = (): boolean => disposed;
    let term: Terminal | null = null;
    let unlisten: (() => void) | null = null;
    const output = createPtyOutputBatcher(() => term, isDisposed);
    const activity = createActivityStatusTracker(sessionId, isDisposed);
    let detachInput: (() => void) | null = null;
    let resizeFit: ContainerResizeFit | null = null;

    // Wait for font to load before initializing terminal
    const initTerminal = async (): Promise<void> => {
      await waitForFont(fontFamily, 2000);

      if (disposed) return;

      const created = createXterm(container, fontFamily, currentSettings);
      term = created.term;
      const { fitAddon } = created;
      // Mounted as the focused pane (e.g. the zoom branch remounts this view
      // with isFocused already true) OR focused while the font was still
      // loading: grab keyboard focus now. The parent's focusSlotTextarea
      // helper can fire before the async init creates the xterm textarea,
      // and the isFocused effect ran while termRef was null — the ref is the
      // current value, not the mount-time closure's.
      if (isFocusedRef.current) term.focus();

      loadRenderer(term);
      registerOsc52Clipboard(term);

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
        } catch {
          // Container may not be sized yet
        }
      });

      detachInput = attachXtermInput(term, container, sessionId, activity.markWorking);

      const listenerReady = onPtyOutput(sessionId, (data) => {
        if (disposed || !term) return;
        output.push(data);
        // --- Activity-based status detection ---
        activity.onOutput();
      });
      listenerReady
        .then((fn) => {
          if (disposed) {
            fn();
          } else {
            unlisten = fn;
            // Signal that the terminal is ready to receive PTY output
            // This allows TerminalGrid to know it can now send CLI commands
            signalTerminalReady(sessionId);
          }
        })
        .catch((err) => {
          if (!disposed) {
            console.error("PTY listener failed:", err);
          }
        });

      resizeFit = observeContainerResize(
        container,
        term,
        fitAddon,
        () => {
          if (output.hasPending()) output.flush();
        },
        isDisposed,
      );
    };

    initTerminal().catch((err) => {
      if (!disposed) {
        console.error("Failed to initialize terminal:", err);
      }
    });

    return () => {
      disposed = true;
      output.cancelPendingFlush();
      resizeFit?.cancelPending();
      activity.dispose();
      output.drain();
      resizeFit?.disconnect();
      detachInput?.();
      if (unlisten) unlisten();
      term?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
    // Font settings are read once at init; dynamic updates live in a separate effect.
    // The refs are stable objects, listed only to satisfy the exhaustive-deps lint.
  }, [sessionId, containerRef, termRef, fitAddonRef, isFocusedRef]);
}
