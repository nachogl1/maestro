import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

import { useShallow } from "zustand/react/shallow";
import { QuickActionsManager } from "@/components/quickactions/QuickActionsManager";
import { ActivityFeed } from "@/components/session/ActivityFeed";
import { AgentGraph } from "@/components/session/AgentGraph";
import { useBranchPullRequest } from "@/hooks/useBranchPullRequest";
import { useSessionBranch } from "@/hooks/useSessionBranch";
import { buildFontFamily, waitForFont } from "@/lib/fonts";
import { isGitWorktree } from "@/lib/git";
import { describeSessionContext } from "@/lib/sessionContext";
import {
  type BackendInfo,
  getBackendInfo,
  killSession,
  onPtyOutput,
  resizePty,
  savePastedImage,
  signalTerminalReady,
  writeStdin,
} from "@/lib/terminal";
import { DEFAULT_THEME, LIGHT_THEME, toXtermTheme } from "@/lib/terminalTheme";
import { useActivityStore } from "@/stores/useActivityStore";
import { type AiMode, type BackendSessionStatus, useSessionStore } from "@/stores/useSessionStore";
import { DEFAULT_SCROLLBACK, useTerminalSettingsStore } from "@/stores/useTerminalSettingsStore";
import type { ClaudeEvent } from "@/types/claude-events";
import { QuickActionPills } from "./QuickActionPills";
import { SamuraiHandoffBanner } from "./SamuraiHandoffBanner";
import { type AIProvider, type SessionStatus, TerminalHeader } from "./TerminalHeader";

/**
 * Props for {@link TerminalView}.
 * @property sessionId - Backend PTY session ID used to route stdin/stdout and resize events.
 * @property status - Fallback status used only when the session store has no entry yet.
 * @property isFocused - Whether this terminal is currently focused (shows accent ring).
 * @property isActive - Whether this terminal is in the active project tab (throttles background polling).
 * @property onFocus - Callback when the terminal is clicked/focused.
 * @property onKill - Callback invoked after the backend kill IPC completes (or fails).
 */
interface TerminalViewProps {
  sessionId: number;
  status?: SessionStatus;
  isFocused?: boolean;
  isActive?: boolean;
  onFocus?: () => void;
  onKill: (sessionId: number) => void;
  terminalCount?: number;
  isZoomed?: boolean;
  onToggleZoom?: () => void;
  /** Park this terminal: hide its pane without stopping the session (owned by TerminalGrid). */
  onPark?: () => void;
  /** Pin this terminal so it keeps showing from every project (owned by TerminalGrid). */
  onTogglePin?: () => void;
  /** This terminal is pinned. */
  isPinned?: boolean;
  /** Opens a native file picker and inserts the chosen paths like a drag-drop (owned by TerminalGrid). */
  onAttachFiles?: () => void;
  /** Project name shown in bold before the session label (eagle view). */
  projectLabel?: string;
  /** Color for the project label — matches the tile border color. */
  projectColor?: string;
  /** Reserve header space for the pane's drag handle overlay. */
  hasMoveHandle?: boolean;
  /** Whether header tooltips advertise keyboard shortcuts (off in eagle view). */
  showShortcutHints?: boolean;
}

/**
 * Writes text to the system clipboard reliably.
 *
 * Prefers the Tauri clipboard plugin (writes from the Rust side, so it works
 * even when invoked outside a direct user gesture — e.g. from an OSC 52 escape
 * sequence that arrives asynchronously via the PTY). Falls back to the browser
 * Clipboard API if the plugin call fails.
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeClipboardText(text);
  } catch (err) {
    console.warn("Tauri clipboard write failed, falling back to navigator.clipboard:", err);
    await navigator.clipboard.writeText(text);
  }
}

/**
 * Decodes a base64 string (as carried by an OSC 52 clipboard sequence) into a
 * UTF-8 string. `atob` only yields a binary string, so we re-decode the bytes
 * to preserve multi-byte characters.
 */
function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Map backend AiMode to frontend AIProvider */
function mapAiMode(mode: AiMode): AIProvider {
  const map: Record<AiMode, AIProvider> = {
    Claude: "claude",
    Gemini: "gemini",
    Codex: "codex",
    OpenCode: "opencode",
    Plain: "plain",
  };
  const provider = map[mode];
  if (!provider) {
    console.warn("Unknown AiMode:", mode);
    return "claude";
  }
  return provider;
}

/** Map backend SessionStatus to frontend SessionStatus */
function mapStatus(status: BackendSessionStatus): SessionStatus {
  const map: Record<BackendSessionStatus, SessionStatus> = {
    Starting: "starting",
    Idle: "idle",
    Working: "working",
    NeedsInput: "needs-input",
    Done: "done",
    Error: "error",
    Timeout: "timeout",
  };
  const mapped = map[status];
  if (!mapped) {
    console.warn("Unknown backend session status:", status);
    return "idle";
  }
  return mapped;
}

/** Stable empties for sessions with no recorded activity yet (see below). */
const NO_EVENTS: ClaudeEvent[] = [];
const NO_FILES: string[] = [];

/** Map session status to CSS class for border/glow */
function cellStatusClass(status: SessionStatus): string {
  switch (status) {
    case "starting":
      return "terminal-cell-starting";
    case "working":
      return "terminal-cell-working";
    case "needs-input":
      return "terminal-cell-needs-input";
    case "done":
      return "terminal-cell-done";
    case "error":
      return "terminal-cell-error";
    default:
      return "terminal-cell-idle";
  }
}

/**
 * Renders a single xterm.js terminal bound to a backend PTY session.
 *
 * On mount: creates a Terminal instance with FitAddon (auto-resize) and WebLinksAddon
 * (clickable URLs), subscribes to the Tauri `pty-output-{sessionId}` event, and wires
 * xterm onData/onResize to the corresponding backend IPC calls. A ResizeObserver keeps
 * the terminal dimensions in sync when the container layout changes.
 *
 * On unmount: sets a `disposed` flag to prevent late PTY writes, disconnects the
 * ResizeObserver, disposes xterm listeners, unsubscribes the Tauri event listener
 * (even if the listener promise hasn't resolved yet), and destroys the Terminal.
 */
export const TerminalView = memo(function TerminalView({
  sessionId,
  status = "idle",
  isFocused = false,
  isActive = true,
  onFocus,
  onKill,
  terminalCount = 1,
  isZoomed = false,
  onToggleZoom,
  onPark,
  onTogglePin,
  isPinned = false,
  onAttachFiles,
  projectLabel,
  projectColor,
  hasMoveHandle = false,
  showShortcutHints = true,
}: TerminalViewProps) {
  const sessionData = useSessionStore(
    useShallow((s) => {
      const sess = s.sessions.find((x) => x.id === sessionId);
      if (!sess) return null;
      return {
        status: sess.status,
        mode: sess.mode,
        name: sess.name,
        projectPath: sess.project_path,
        workingDirectory: sess.working_directory,
        worktreePath: sess.worktree_path,
        branch: sess.branch,
        statusMessage: sess.statusMessage,
        needsInputPrompt: sess.needsInputPrompt,
      };
    }),
  );
  const effectiveStatus = sessionData ? mapStatus(sessionData.status) : status;
  const effectiveProvider = sessionData ? mapAiMode(sessionData.mode) : "claude";

  // Warning flag: user-toggled yellow chrome (header + tab strip), synced via
  // the session store so it shows in every view.
  const isFlagged = useSessionStore((s) => s.flaggedSessionIds.includes(sessionId));
  // Attention highlight: auto-unparked because the agent asked for input —
  // same yellow chrome, cleared when the user selects the session.
  const hasAttention = useSessionStore((s) => s.attentionSessionIds.includes(sessionId));
  const toggleSessionFlag = useSessionStore((s) => s.toggleSessionFlag);
  // Attention-first click semantics: while the session carries the attention
  // highlight, the first click on the header/tab strip only acknowledges it —
  // it must not also toggle the warning flag (the chrome would stay yellow
  // and the user would have flagged the session without knowing). Subsequent
  // clicks toggle the flag as before.
  const handleToggleFlag = useCallback(() => {
    const store = useSessionStore.getState();
    if (store.attentionSessionIds.includes(sessionId)) {
      store.clearSessionAttention(sessionId);
      return;
    }
    toggleSessionFlag(sessionId);
  }, [toggleSessionFlag, sessionId]);
  const hasSessionWorktree = Boolean(sessionData?.worktreePath);
  const projectPath = sessionData?.workingDirectory ?? sessionData?.projectPath ?? "";

  // One line saying what this terminal is about, recomputed from the session's
  // own transcript + status so a terminal left alone for an hour still says
  // what it was for. Derived INSIDE the selector on purpose: it returns a
  // string, so an event batch that doesn't change the wording re-renders
  // nothing — subscribing to the events array itself would re-render this
  // (xterm-hosting) component on every 16 ms batch.
  const contextLine = useActivityStore((s) => {
    const activity = s.sessions[sessionId];
    return describeSessionContext({
      statusMessage: sessionData?.statusMessage,
      needsInputPrompt: sessionData?.needsInputPrompt,
      events: activity?.events ?? NO_EVENTS,
      filesModified: activity?.filesModified ?? NO_FILES,
    });
  });

  // Detect if the project path itself is a git worktree (not the main working tree).
  // This handles the case where the user opens a worktree directory as their project.
  const [isProjectWorktree, setIsProjectWorktree] = useState(false);
  useEffect(() => {
    if (hasSessionWorktree || !projectPath) return;
    isGitWorktree(projectPath)
      .then((result) => setIsProjectWorktree(result))
      .catch(() => setIsProjectWorktree(false));
  }, [projectPath, hasSessionWorktree]);

  // For useSessionBranch: only Maestro-created worktrees have a locked branch.
  // Project-level worktrees still need polling to discover their branch.
  const liveBranch = useSessionBranch(
    projectPath,
    hasSessionWorktree,
    sessionData?.branch ?? null,
    isActive,
  );
  const effectiveBranch = liveBranch ?? "...";
  // For the UI badge: show "worktree" if either Maestro created one or the project itself is a worktree.
  const isWorktree = hasSessionWorktree || isProjectWorktree;
  // The branch's PR, so the header can hand the user straight to GitHub.
  const pullRequest = useBranchPullRequest(projectPath, liveBranch, isActive);

  // Get terminal settings from store (select individual primitives for granular updates)
  const fontSize = useTerminalSettingsStore((s) => s.settings.fontSize);
  const fontFamily = useTerminalSettingsStore((s) => s.settings.fontFamily);
  const lineHeight = useTerminalSettingsStore((s) => s.settings.lineHeight);
  const zoomLevel = useTerminalSettingsStore((s) => s.settings.zoomLevel);
  const getEffectiveFontFamily = useTerminalSettingsStore((s) => s.getEffectiveFontFamily);
  const getEffectiveFontSize = useTerminalSettingsStore((s) => s.getEffectiveFontSize);
  const setZoomLevel = useTerminalSettingsStore((s) => s.setZoomLevel);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Mirror isFocused into a ref: the async init reads it AFTER awaiting the
  // font load, and the mount-time closure value goes stale if the user
  // clicks this pane during that window (typing would then keep going to
  // the previously focused terminal).
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;

  // Quick actions manager modal state
  const [showQuickActionsManager, setShowQuickActionsManager] = useState(false);
  const [activeTab, setActiveTab] = useState<"terminal" | "activity" | "graph">("terminal");
  const handleManageClick = useCallback(() => setShowQuickActionsManager(true), []);

  // Backend capabilities (for future enhanced features like terminal state queries)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_backendInfo, setBackendInfo] = useState<BackendInfo | null>(null);

  // Track app theme (dark/light) for terminal theming
  const [appTheme, setAppTheme] = useState<"dark" | "light">(() => {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  });

  // Fetch backend info on mount (cached after first call)
  useEffect(() => {
    getBackendInfo()
      .then(setBackendInfo)
      .catch((err) => console.warn("Failed to get backend info:", err));
  }, []);

  // Watch for theme changes via MutationObserver
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === "data-theme") {
          const newTheme = document.documentElement.getAttribute("data-theme");
          setAppTheme(newTheme === "light" ? "light" : "dark");
        }
      }
    });

    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);

  // Update terminal theme when appTheme changes
  useEffect(() => {
    if (termRef.current) {
      const theme = appTheme === "light" ? LIGHT_THEME : DEFAULT_THEME;
      termRef.current.options.theme = toXtermTheme(theme);
    }
  }, [appTheme]);

  // Update terminal font settings when they change
  // biome-ignore lint/correctness/useExhaustiveDependencies: fontSize/fontFamily/zoomLevel aren't read directly (the getEffectiveFont* getters read them internally) but are the intended triggers — those getter references are stable across store updates, so this effect needs the raw values to know when to refit.
  useEffect(() => {
    if (termRef.current && fitAddonRef.current) {
      const effectiveFont = getEffectiveFontFamily();
      const builtFontFamily = buildFontFamily(effectiveFont);

      termRef.current.options.fontSize = getEffectiveFontSize();
      termRef.current.options.fontFamily = builtFontFamily;
      termRef.current.options.lineHeight = lineHeight;

      // Refit terminal to recalculate cell dimensions
      requestAnimationFrame(() => {
        try {
          fitAddonRef.current?.fit();
        } catch {
          // Ignore fit errors during transition
        }
      });
    }
  }, [fontSize, fontFamily, lineHeight, zoomLevel, getEffectiveFontFamily, getEffectiveFontSize]);

  /**
   * Confirms with the user first,
   * then immediately removes the terminal from UI (optimistic update) and
   * kills the backend session in the background.
   */
  const handleKill = useCallback(
    (id: number) => {
      ask("Are you sure you want to close this session?", {
        title: "Close Session",
        kind: "warning",
      })
        .then((confirmed) => {
          if (!confirmed) return;
          // Update UI immediately (optimistic)
          onKill(id);
          // Kill session in background - don't await
          killSession(id).catch((err) => {
            console.error("Failed to kill session:", err);
          });
        })
        .catch(console.error);
    },
    [onKill],
  );

  const handleRename = useCallback((id: number, name: string | null) => {
    useSessionStore.getState().renameSession(id, name);
  }, []);

  /**
   * Handles quick action button clicks: pastes the prompt into the agent's
   * input (without auto-submitting) and refocuses the xterm so the next
   * Enter the user types runs the command. Without the refocus, the
   * pill button keeps focus and Enter triggers it again, duplicating
   * the prompt instead of submitting it.
   */
  const handleQuickAction = useCallback(
    (prompt: string) => {
      writeStdin(sessionId, prompt).catch(console.error);
      // Refocus the terminal on the next tick — after the click handler
      // releases focus from the pill button.
      requestAnimationFrame(() => {
        termRef.current?.focus();
      });
    },
    [sessionId],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Get current settings at initialization time (not reactive)
    const currentSettings = useTerminalSettingsStore.getState();
    const effectiveFont = currentSettings.getEffectiveFontFamily();
    const fontFamily = buildFontFamily(effectiveFont);

    let disposed = false;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let unlisten: (() => void) | null = null;
    // === PTY Output Batching (reduces xterm.js render overhead) ===
    let writeBuffer: string[] = [];
    let rafId: number | null = null;
    let fallbackTimerId: ReturnType<typeof setTimeout> | null = null;

    // === Activity-based status detection ===
    let activityWorkingTimer: ReturnType<typeof setTimeout> | null = null;
    let activityIdleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastHeuristicStatus: string | null = null;

    const MCP_GRACE_PERIOD_MS = 10_000; // Defer to MCP for 10s after last MCP update
    const WORKING_DEBOUNCE_MS = 500; // Sustained output before marking "Working"
    const IDLE_TIMEOUT_MS = 5_000; // No output before marking "Idle"
    // Only overwrite "safe" states — never revert terminal states like Done/Error/NeedsInput/Timeout
    const SAFE_TO_OVERRIDE: BackendSessionStatus[] = ["Working", "Idle", "Starting"];

    const MAX_BUFFER_CHUNKS = 100; // Force flush at ~400KB (100 × 4KB chunks)
    const FALLBACK_FLUSH_MS = 50; // 20fps floor for backgrounded tabs

    const cancelPendingFlush = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (fallbackTimerId !== null) {
        clearTimeout(fallbackTimerId);
        fallbackTimerId = null;
      }
    };

    const flushBuffer = () => {
      cancelPendingFlush();
      if (disposed || !term || writeBuffer.length === 0) {
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

    const scheduleFlush = () => {
      if (rafId !== null) return; // Already scheduled
      rafId = requestAnimationFrame(flushBuffer);
      if (fallbackTimerId === null) {
        fallbackTimerId = setTimeout(flushBuffer, FALLBACK_FLUSH_MS);
      }
    };

    let dataDisposable: { dispose: () => void } | null = null;
    let resizeDisposable: { dispose: () => void } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let pasteHandler: ((e: Event) => void) | null = null;
    // Cancels any pending debounced resize work scheduled by the ResizeObserver
    // (set inside initTerminal once the observer is wired up).
    let pendingResizeRafRef: (() => void) | null = null;

    // Wait for font to load before initializing terminal
    const initTerminal = async () => {
      await waitForFont(fontFamily, 2000);

      if (disposed) return;

      const initialTheme =
        document.documentElement.getAttribute("data-theme") === "light"
          ? LIGHT_THEME
          : DEFAULT_THEME;
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
      term = new Terminal({
        cursorBlink: true,
        fontSize: currentSettings.getEffectiveFontSize(),
        fontFamily: fontFamily,
        lineHeight: currentSettings.settings.lineHeight,
        theme: toXtermTheme(initialTheme),
        allowProposedApi: true,
        scrollback,
        tabStopWidth: 8,
      });

      fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon((_event, uri) => {
        openUrl(uri);
      });

      const unicode11Addon = new Unicode11Addon();
      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.loadAddon(unicode11Addon);
      term.unicode.activeVersion = "11";
      term.open(container);
      // Mounted as the focused pane (e.g. the zoom branch remounts this view
      // with isFocused already true) OR focused while the font was still
      // loading: grab keyboard focus now. The parent's focusSlotTextarea
      // helper can fire before the async init creates the xterm textarea,
      // and the isFocused effect ran while termRef was null — the ref is the
      // current value, not the mount-time closure's.
      if (isFocusedRef.current) term.focus();

      // GPU-accelerated rendering (must be loaded after open())
      // Try WebGL first, fall back to Canvas2D (much faster than DOM on Linux)
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
          try {
            term?.loadAddon(new CanvasAddon());
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

      // Handle OSC 52 clipboard escape sequences. TUI apps like Claude Code copy
      // selected text by emitting OSC 52 ("\x1b]52;c;<base64>\x07") rather than
      // relying on xterm's own selection. xterm.js does NOT write to the system
      // clipboard on its own, so without this handler the app prints "Copied to
      // clipboard" but nothing actually lands on the clipboard. The payload is
      // "<targets>;<base64data>"; a "?" payload is a paste/read request, which
      // we don't support (returning false leaves it unhandled).
      term.parser.registerOscHandler(52, (payload) => {
        const sep = payload.indexOf(";");
        if (sep === -1) return false;
        const b64 = payload.slice(sep + 1);
        if (b64 === "?" || b64.length === 0) return false;
        try {
          copyToClipboard(decodeBase64Utf8(b64)).catch((err) =>
            console.error("OSC 52 clipboard write failed:", err),
          );
        } catch (err) {
          console.error("OSC 52 decode failed:", err);
          return false;
        }
        return true; // handled — suppress xterm's default (no-op) handling
      });

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      requestAnimationFrame(() => {
        try {
          fitAddon?.fit();
        } catch {
          // Container may not be sized yet
        }
      });

      // Workaround for xterm.js CompositionHelper bug on WebKit (Tauri/WKWebView):
      // The hidden textarea accumulates text across compositions, but CompositionHelper
      // uses textarea.value.length at compositionstart as the extraction offset. When
      // prior text remains in the textarea, it extracts the wrong substring — e.g.
      // sending "測試" instead of "這是". We capture the correct text from the
      // compositionend event and replace whatever xterm sends via onData.
      // term.open() above always creates the hidden textarea synchronously.
      const textarea = term.textarea;
      if (!textarea) throw new Error("expected xterm to have created its textarea on open()");
      let pendingCompositionData: string | null = null;

      textarea.addEventListener("compositionend", (e) => {
        pendingCompositionData = (e as CompositionEvent).data;
      });

      // Intercept paste events to handle images from the clipboard.
      // xterm.js only pastes text; images are silently dropped. We detect image
      // data, save it to a temp file via the backend, and write the file path
      // into the terminal so the AI CLI can read it.
      pasteHandler = (e: Event) => {
        const clipboardEvent = e as ClipboardEvent;
        const items = clipboardEvent.clipboardData?.items;
        if (!items) return;

        let imageItem: DataTransferItem | null = null;
        for (const item of Array.from(items)) {
          if (item.type.startsWith("image/")) {
            imageItem = item;
            break;
          }
        }

        if (!imageItem) return; // No image — let xterm handle text paste

        // Block xterm.js from processing this paste event
        e.preventDefault();
        e.stopPropagation();

        const blob = imageItem.getAsFile();
        if (!blob) return;

        const mediaType = imageItem.type;
        const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50 MB
        // Save image async, then write the path to stdin
        blob
          .arrayBuffer()
          .then(async (arrayBuffer) => {
            if (arrayBuffer.byteLength > MAX_IMAGE_SIZE) {
              console.error("[TerminalView] Image too large to paste");
              return;
            }
            // Hand the view straight to the IPC layer — building a JS array with
            // one element per image byte first is what made large pastes freeze.
            const filePath = await savePastedImage(new Uint8Array(arrayBuffer), mediaType);
            await writeStdin(sessionId, filePath);
          })
          .catch((err) => {
            console.error("[TerminalView] Failed to paste image:", err);
          });
      };
      container.addEventListener("paste", pasteHandler, { capture: true });

      // NOTE: Drag-and-drop is intentionally NOT handled here per-terminal.
      // Tauri's onDragDropEvent is webview-global — registering a listener in
      // every TerminalView meant a single drop fired *every* listener, so the
      // dropped path ended up written to every session's PTY. Drag-drop is
      // owned by TerminalGrid + useTerminalDragDrop, which does proper
      // coordinate hit-testing against the [data-slot-id] DOM elements and
      // routes the path to exactly one session.

      dataDisposable = term.onData((data) => {
        if (pendingCompositionData !== null) {
          const correctData = pendingCompositionData;
          pendingCompositionData = null;
          // Clear textarea to prevent accumulation that corrupts future compositions
          textarea.value = "";
          if (correctData.length > 0) {
            writeStdin(sessionId, correctData).catch(console.error);
          }
          return;
        }
        // Enter while the agent awaits a reply: the user is responding, so
        // flip the indicator back to Working before output resumes. Only the
        // bare Enter key emits exactly "\r" — pastes and escape sequences
        // never match, so they can't clear the needs-input flag.
        if (data === "\r") {
          const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
          if (current?.status === "NeedsInput") {
            lastHeuristicStatus = "Working";
            useSessionStore.getState().updateSession(sessionId, {
              status: "Working",
              statusMessage: undefined,
              needsInputPrompt: undefined,
            });
            // Answering the prompt also clears the auto-unpark attention
            // highlight — the pane can gain focus without a click (keyboard
            // nav, file drop), so replying may be the acknowledging gesture.
            useSessionStore.getState().clearSessionAttention(sessionId);
          }
        }
        writeStdin(sessionId, data).catch(console.error);
      });

      resizeDisposable = term.onResize(({ rows, cols }) => {
        resizePty(sessionId, rows, cols).catch(console.error);
      });

      // Handle special keyboard shortcuts
      term.attachCustomKeyEventHandler((event) => {
        // Shift+Enter: send Kitty keyboard protocol sequence for Shift+Enter
        // so Claude Code inserts a newline in its input buffer instead of executing.
        // Raw "\n" would be treated as a command terminator by the CLI.
        // Block all event types (keydown, keypress, keyup) to prevent xterm.js
        // from also sending "\r" on the keypress event.
        if (event.key === "Enter" && event.shiftKey) {
          if (event.type === "keydown") {
            writeStdin(sessionId, "\x1b[13;2u").catch(console.error);
          }
          return false;
        }

        // Cmd+C (Mac) or Ctrl+C (Linux/Windows): copy selection to clipboard
        // Only intercept if there's a selection, otherwise let SIGINT go through
        const isCopy =
          event.key === "c" && (event.metaKey || event.ctrlKey) && event.type === "keydown";
        if (isCopy && term?.hasSelection()) {
          const selection = term.getSelection();
          copyToClipboard(selection).catch(console.error);
          return false; // Don't send to PTY
        }

        // Cmd/Ctrl+T: add new session — block xterm so 't' isn't sent to PTY.
        // The DOM event still bubbles to window where useAppKeyboard handles it.
        if (
          event.key === "t" &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.type === "keydown"
        ) {
          return false;
        }

        // Cmd/Ctrl+1 (toggle maximize) and Cmd/Ctrl+2 (toggle git panel):
        // block xterm so it doesn't send the corresponding control byte (NUL/SOH) to PTY.
        // Use event.code for layout independence; event.key may differ on AZERTY etc.
        if (
          (event.code === "Digit1" ||
            event.code === "Digit2" ||
            event.code === "Numpad1" ||
            event.code === "Numpad2") &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.type === "keydown"
        ) {
          return false;
        }

        // Cmd+K (Mac) or Ctrl+K (Linux/Windows): clear terminal scrollback + viewport
        if (
          event.key === "k" &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.type === "keydown"
        ) {
          term?.clear();
          return false;
        }

        // Cmd+Left/Right (Mac): jump to beginning/end of line
        // Cmd+Delete (Mac): delete from cursor to beginning of line
        // WebView intercepts Cmd+key by default, so we manually send the escape sequences
        if (event.metaKey && event.type === "keydown") {
          if (event.key === "ArrowLeft") {
            writeStdin(sessionId, "\x01").catch(console.error); // Ctrl+A: beginning of line
            return false;
          }
          if (event.key === "ArrowRight") {
            writeStdin(sessionId, "\x05").catch(console.error); // Ctrl+E: end of line
            return false;
          }
          if (event.key === "Backspace") {
            writeStdin(sessionId, "\x15").catch(console.error); // Ctrl+U: delete to beginning of line
            return false;
          }
        }

        return true; // Let xterm handle all other keys
      });

      const listenerReady = onPtyOutput(sessionId, (data) => {
        if (disposed || !term) return;
        writeBuffer.push(data);
        if (writeBuffer.length >= MAX_BUFFER_CHUNKS) {
          flushBuffer(); // Backpressure: immediate flush if buffer full
        } else {
          scheduleFlush();
        }

        // --- Activity-based status detection ---
        const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
        if (!session) return; // Session was removed, skip heuristic

        const lastMcp = session.lastMcpUpdateTime ?? 0;
        const mcpIsActive = Date.now() - lastMcp < MCP_GRACE_PERIOD_MS;

        if (!mcpIsActive) {
          // Debounce: set "Working" after sustained output
          if (!activityWorkingTimer && lastHeuristicStatus !== "Working") {
            activityWorkingTimer = setTimeout(() => {
              if (disposed) return;
              activityWorkingTimer = null;
              const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
              if (!current || !SAFE_TO_OVERRIDE.includes(current.status)) return;
              lastHeuristicStatus = "Working";
              useSessionStore.getState().updateSession(sessionId, {
                status: "Working" as BackendSessionStatus,
              });
            }, WORKING_DEBOUNCE_MS);
          }

          // Reset idle timer on every output chunk
          if (activityIdleTimer) clearTimeout(activityIdleTimer);
          activityIdleTimer = setTimeout(() => {
            if (disposed) return;
            activityIdleTimer = null;
            if (lastHeuristicStatus === "Working") {
              const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
              if (!current || !SAFE_TO_OVERRIDE.includes(current.status)) return;
              lastHeuristicStatus = "Idle";
              useSessionStore.getState().updateSession(sessionId, {
                status: "Idle" as BackendSessionStatus,
              });
            }
          }, IDLE_TIMEOUT_MS);
        }
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

      // Debounce ResizeObserver fits. Rapid window-drag resizes fire dozens of
      // events per second; running fitAddon.fit() on every tick produces a flood
      // of term.resize() → resizePty IPC calls that can race with in-flight PTY
      // output, leaving the terminal buffer reflowed at one size while text is
      // being written for another. The visible symptom is "mangled output" and
      // a corrupted scrollback that the user can't recover by scrolling up.
      //
      // We do a leading-edge fit (so the first resize lands immediately) plus
      // a trailing fit when the user stops dragging. Between those we only
      // re-fit when the computed (cols, rows) actually changed, which avoids
      // sending no-op resize IPC calls and avoids re-reflowing the xterm buffer
      // unnecessarily.
      const RESIZE_DEBOUNCE_MS = 120;
      // `resize_pty` rejects anything above this (see commands/terminal.rs).
      // Fitting past it would reflow xterm to a geometry the PTY never adopts
      // — the classic mangled-output symptom — while the rejection is only
      // logged. Zooming out on a wide pane reaches it: the 10px font floor
      // gives a ~3px cell, so ~1500 CSS px is already over 500 columns.
      const MAX_PTY_DIM = 500;
      let resizeRafId: number | null = null;
      let resizeTimerId: ReturnType<typeof setTimeout> | null = null;
      let lastFitCols = -1;
      let lastFitRows = -1;

      const runFit = () => {
        if (disposed || !fitAddon || !term) return;
        try {
          // Flush any buffered PTY output first so reflow operates on the
          // final buffer state, not a half-written one.
          if (writeBuffer.length > 0) flushBuffer();
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

      resizeObserver = new ResizeObserver(() => {
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

      // Expose debounce handles so the cleanup function can cancel them.
      pendingResizeRafRef = () => {
        if (resizeRafId !== null) {
          cancelAnimationFrame(resizeRafId);
          resizeRafId = null;
        }
        if (resizeTimerId !== null) {
          clearTimeout(resizeTimerId);
          resizeTimerId = null;
        }
      };
    };

    initTerminal().catch((err) => {
      if (!disposed) {
        console.error("Failed to initialize terminal:", err);
      }
    });

    return () => {
      disposed = true;
      cancelPendingFlush();
      pendingResizeRafRef?.();
      if (activityWorkingTimer) clearTimeout(activityWorkingTimer);
      if (activityIdleTimer) clearTimeout(activityIdleTimer);
      // Flush remaining buffered output before disposal
      if (term && writeBuffer.length > 0) {
        try {
          term.write(writeBuffer.join(""));
        } catch {
          /* ignore errors during cleanup */
        }
      }
      writeBuffer = [];
      resizeObserver?.disconnect();
      if (pasteHandler) container.removeEventListener("paste", pasteHandler, { capture: true });
      dataDisposable?.dispose();
      resizeDisposable?.dispose();
      if (unlisten) unlisten();
      term?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Font settings are read once at init, dynamic updates via separate effect
  }, [sessionId]);

  // Focus the terminal when isFocused becomes true
  useEffect(() => {
    if (isFocused && termRef.current) {
      termRef.current.focus();
    }
  }, [isFocused]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: background click-to-focus on a panel full of nested interactive controls (header buttons, tab bar, terminal itself) — not a discrete focusable widget, so there's no sensible single keyboard equivalent.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see noStaticElementInteractions above.
    <div
      className={`terminal-cell flex h-full flex-col bg-maestro-bg ${cellStatusClass(effectiveStatus)} ${isFocused ? "terminal-cell-focused" : ""}`}
      // The border is always the project's color, in every view — that is what
      // it means. Status is not carried by the border any more: the status
      // classes still supply the colored glow, and the three-dot indicator in
      // the header says whether the terminal is working or waiting on you.
      // (Previously this was eagle-only and stepped aside for needs-input and
      // error, so the same terminal changed identity depending on its state.)
      style={projectColor ? { borderColor: projectColor } : undefined}
      onClick={onFocus}
    >
      {/* Rich header bar */}
      <TerminalHeader
        sessionId={sessionId}
        status={effectiveStatus}
        provider={effectiveProvider}
        sessionName={sessionData?.name}
        branchName={effectiveBranch}
        pullRequest={pullRequest}
        isWorktree={isWorktree}
        onKill={handleKill}
        onRename={handleRename}
        terminalCount={terminalCount}
        isZoomed={isZoomed}
        onToggleZoom={onToggleZoom}
        onPark={onPark}
        onTogglePin={onTogglePin}
        isPinned={isPinned}
        zoomLevel={zoomLevel}
        onSetZoomLevel={setZoomLevel}
        projectLabel={projectLabel}
        projectColor={projectColor}
        hasMoveHandle={hasMoveHandle}
        isFlagged={isFlagged}
        hasAttention={hasAttention}
        onToggleFlag={handleToggleFlag}
        showShortcutHints={showShortcutHints}
      />

      {/* Can't-miss attention strip: Maestro is about to hand off or park
          this agent. Renders nothing outside those states. */}
      <SamuraiHandoffBanner sessionId={sessionId} />

      {/* What this terminal is about, in one line. Rendered only when the
          session has produced something to say, so an empty shell keeps its
          full height. */}
      {contextLine && (
        <div
          className="flex h-5 shrink-0 items-center border-b border-maestro-border/50 bg-maestro-surface/40 px-2"
          title={contextLine}
        >
          <span className="truncate text-[10px] leading-none text-maestro-muted">
            {contextLine}
          </span>
        </div>
      )}

      {/* Tab bar — clicking its background or the already-active tab toggles
          the warning flag (yellow), in sync with the header above. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: background click-to-flag on a row full of nested interactive tab buttons — not a discrete focusable widget, so there's no sensible single keyboard equivalent. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: see noStaticElementInteractions above. */}
      <div
        className={`flex shrink-0 cursor-pointer items-center gap-0.5 border-b border-neutral-800 ${isFlagged || hasAttention ? "warning-flag" : "bg-neutral-900/50"} px-2`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          handleToggleFlag();
        }}
        title={
          hasAttention
            ? "Needs input — click to clear the attention highlight"
            : isFlagged
              ? "Click to clear warning flag"
              : "Click to flag as warning"
        }
      >
        <button
          type="button"
          className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
            activeTab === "terminal"
              ? "border-b-2 border-blue-500 text-neutral-200"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
          onClick={() => (activeTab === "terminal" ? handleToggleFlag() : setActiveTab("terminal"))}
        >
          Terminal
        </button>
        <button
          type="button"
          className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
            activeTab === "activity"
              ? "border-b-2 border-blue-500 text-neutral-200"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
          onClick={() => (activeTab === "activity" ? handleToggleFlag() : setActiveTab("activity"))}
        >
          Activity
        </button>
        <button
          type="button"
          className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
            activeTab === "graph"
              ? "border-b-2 border-blue-500 text-neutral-200"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
          onClick={() => (activeTab === "graph" ? handleToggleFlag() : setActiveTab("graph"))}
        >
          Graph
        </button>
      </div>

      {/* xterm.js container - always mounted but hidden when activity tab is active */}
      <div
        ref={containerRef}
        className={`flex-1 overflow-hidden ${activeTab !== "terminal" ? "hidden" : ""}`}
      />

      {/* Activity feed - shown when activity tab is active */}
      {activeTab === "activity" && (
        <div className="flex-1 overflow-hidden">
          <ActivityFeed sessionId={sessionId} maxHeight="100%" />
        </div>
      )}

      {/* Agent orchestration graph - shown when graph tab is active */}
      {activeTab === "graph" && (
        <div className="flex-1 overflow-hidden">
          <AgentGraph sessionId={sessionId} />
        </div>
      )}

      {/* Quick action pills - only show on terminal tab */}
      {activeTab === "terminal" && (
        <QuickActionPills
          onAction={handleQuickAction}
          onManageClick={handleManageClick}
          onAttachClick={onAttachFiles}
        />
      )}

      {/* Quick actions manager modal */}
      {showQuickActionsManager && (
        <QuickActionsManager onClose={() => setShowQuickActionsManager(false)} />
      )}
    </div>
  );
});
