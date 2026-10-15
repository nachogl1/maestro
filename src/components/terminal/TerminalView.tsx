import { ask } from "@tauri-apps/plugin-dialog";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

import { useShallow } from "zustand/react/shallow";
import { QuickActionsManager } from "@/components/quickactions/QuickActionsManager";
import { ActivityFeed } from "@/components/session/ActivityFeed";
import { AgentGraph } from "@/components/session/AgentGraph";
import { useSessionBranch } from "@/hooks/useSessionBranch";
import { useXtermSession } from "@/hooks/useXtermSession";
import { renameAgent, sanitizeAgentName } from "@/lib/agentName";
import { buildFontFamily } from "@/lib/fonts";
import { isGitWorktree } from "@/lib/git";
import { describeSessionContext } from "@/lib/sessionContext";
import { killSession, writeStdin } from "@/lib/terminal";
import { DEFAULT_THEME, LIGHT_THEME, toXtermTheme } from "@/lib/terminalTheme";
import { useActivityStore } from "@/stores/useActivityStore";
import { isContextAlert, useContextAlertStore } from "@/stores/useContextAlertStore";
import { type AiMode, type BackendSessionStatus, useSessionStore } from "@/stores/useSessionStore";
import { useTerminalSettingsStore } from "@/stores/useTerminalSettingsStore";
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
  /** Eagle view: cycle the tile size (see TerminalHeader). */
  onCycleTileSize?: () => void;
  /** Eagle view: current tile size label, e.g. "2×1". */
  tileSizeLabel?: string;
  /** Whether header tooltips advertise keyboard shortcuts (off in eagle view). */
  showShortcutHints?: boolean;
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
 * The Terminal's lifetime (creation, PTY wiring, output batching, activity-based
 * status, resize, cleanup) is owned by {@link useXtermSession}; this component
 * adds the header, tabs, theme/font sync and focus handling around it.
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
  onCycleTileSize,
  tileSizeLabel,
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
        contextPercent: sess.contextPercent,
      };
    }),
  );
  const effectiveStatus = sessionData ? mapStatus(sessionData.status) : status;
  // Context alert: the frame blinks red once the conversation's context usage
  // reaches the threshold picked in Settings (null = off).
  const contextAlertThreshold = useContextAlertStore((s) => s.threshold);
  const contextAlert = isContextAlert(sessionData?.contextPercent, contextAlertThreshold);
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
  // For the branch tooltip: "worktree" if either Maestro created one or the project itself is a worktree.
  const isWorktree = hasSessionWorktree || isProjectWorktree;

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

  // Track app theme (dark/light) for terminal theming
  const [appTheme, setAppTheme] = useState<"dark" | "light">(() => {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  });

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

  // A Claude terminal's title IS its agent name (the name other agents
  // message it by): a title edit becomes a valid agent name and is also
  // typed into the agent as `/rename`. Agent names cannot be cleared, so an
  // emptied title keeps the current name. Other CLIs keep free-text titles.
  const isClaudeSession = sessionData?.mode === "Claude";
  const handleRename = useCallback(
    (id: number, name: string | null) => {
      if (!isClaudeSession) {
        useSessionStore.getState().renameSession(id, name);
        return;
      }
      const agentName = name ? sanitizeAgentName(name) : null;
      if (!agentName) return;
      useSessionStore.getState().renameSession(id, agentName);
      renameAgent(id, agentName).catch((err) => {
        console.error("Failed to rename agent:", err);
      });
    },
    [isClaudeSession],
  );

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

  useXtermSession({ sessionId, containerRef, termRef, fitAddonRef, isFocusedRef });

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
      className={`terminal-cell flex h-full flex-col bg-maestro-bg ${cellStatusClass(effectiveStatus)} ${isFocused ? "terminal-cell-focused" : ""} ${contextAlert ? "terminal-cell-context-alert" : ""}`}
      // The border is always the project's color, in every view — that is what
      // it means. Status is not carried by the border any more: the status
      // classes still supply the colored glow, and the three-dot indicator in
      // the header says whether the terminal is working or waiting on you.
      // (Previously this was eagle-only and stepped aside for needs-input and
      // error, so the same terminal changed identity depending on its state.)
      // The one exception is the context alert: a blinking red frame that
      // takes over the border until the user compacts or hands off.
      style={projectColor && !contextAlert ? { borderColor: projectColor } : undefined}
      data-context-alert={contextAlert ? "true" : undefined}
      onClick={onFocus}
    >
      {/* Rich header bar */}
      <TerminalHeader
        sessionId={sessionId}
        status={effectiveStatus}
        provider={effectiveProvider}
        sessionName={sessionData?.name}
        branchName={effectiveBranch}
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
        onCycleTileSize={onCycleTileSize}
        tileSizeLabel={tileSizeLabel}
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
