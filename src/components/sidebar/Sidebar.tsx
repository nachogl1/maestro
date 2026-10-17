import { ask } from "@tauri-apps/plugin-dialog";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  History,
  Info,
  Keyboard,
  Moon,
  Package,
  ScrollText,
  Settings,
  Square,
  Sun,
  Wrench,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChangelogModal, MaestroSettingsModal, ShortcutsModal } from "@/components/settings";
import { CliSettingsModal } from "@/components/terminal/CliSettingsModal";
import { SamuraiScheduleChip } from "@/components/terminal/SamuraiScheduleChip";
import { TerminalSettingsModal } from "@/components/terminal/TerminalSettingsModal";
import { sessionsForTab } from "@/hooks/useProjectStatus";
import { samePath } from "@/lib/path";
import { projectColorFor } from "@/lib/projectColor";
import { isParkEntry } from "@/lib/samurai";
import { sessionDisplayName } from "@/lib/sessionDisplayName";
import { altLabel, titleWithShortcut } from "@/lib/shortcuts";
import { useProjectColors } from "@/lib/useProjectColors";
import { type SubagentInfo, useAgentStore } from "@/stores/useAgentStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { ContextAlertSection } from "./ContextAlertSection";
import { HistorySection } from "./HistorySection";
import { InfraTab } from "./InfraTab";
import { NotificationsSettingsSection } from "./NotificationsSettingsSection";
import {
  badgeBaseClass,
  cardClass,
  divider,
  SESSION_STATUS_BADGES,
  SectionHeader,
} from "./sectionChrome";

interface SidebarProps {
  collapsed?: boolean;
  onCollapse?: () => void;
  /** Active sidebar tab — lifted to App so Alt+1-4 shortcuts can drive it. */
  activeTab: SidebarTabId;
  /** Select a sidebar tab (App persists the choice). */
  onSelectTab: (tab: SidebarTabId) => void;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  /** Number of running sessions in the active project (drives Stop All visibility). */
  launchedCount?: number;
  /** Whether Stop All is currently running. */
  isStoppingAll?: boolean;
  /** Stop all running sessions in the active project. */
  onStopAll?: () => void;
  /** Agents section: zoom into a terminal (focused single-terminal view + keyboard focus). */
  onAgentNavigate?: (tabId: string, sessionId: number) => void;
  /** Agents section: kill one terminal (PTY + pane cleanup). */
  onAgentKill?: (tabId: string, sessionId: number) => void;
  /** History section: a recovery launch was queued — reveal the project's grid. */
  onHistoryLaunch?: (tabId: string) => void;
}

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_COLLAPSE_THRESHOLD = 60;
const SIDEBAR_WIDTH_STEP = 4;
const SIDEBAR_WIDTH_STORAGE_KEY = "maestro-sidebar-width";

function loadSavedWidth(): number {
  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  return Number.isFinite(saved) && saved >= SIDEBAR_MIN_WIDTH && saved <= SIDEBAR_MAX_WIDTH
    ? saved
    : SIDEBAR_DEFAULT_WIDTH;
}

/* ================================================================ */
/*  SIDEBAR ROOT                                                     */
/* ================================================================ */

export function Sidebar({
  collapsed,
  onCollapse,
  activeTab,
  onSelectTab,
  theme,
  onToggleTheme,
  launchedCount = 0,
  isStoppingAll = false,
  onStopAll,
  onAgentNavigate,
  onAgentKill,
  onHistoryLaunch,
}: SidebarProps) {
  const [width, setWidth] = useState(loadSavedWidth);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  }, [width]);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = { x: e.clientX, w: width };
    },
    [width],
  );

  const clampWidth = useCallback((value: number) => {
    const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
    const snapped = Math.round(clamped / SIDEBAR_WIDTH_STEP) * SIDEBAR_WIDTH_STEP;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, snapped));
  }, []);

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let next = width;
      const smallStep = 8;
      const largeStep = 24;

      switch (e.key) {
        case "ArrowLeft":
          next = width - smallStep;
          break;
        case "ArrowRight":
          next = width + smallStep;
          break;
        case "PageDown":
          next = width - largeStep;
          break;
        case "PageUp":
          next = width + largeStep;
          break;
        case "Home":
          next = SIDEBAR_MIN_WIDTH;
          break;
        case "End":
          next = SIDEBAR_MAX_WIDTH;
          break;
        default:
          return;
      }

      e.preventDefault();
      if (next < SIDEBAR_COLLAPSE_THRESHOLD) {
        onCollapse?.();
        return;
      }
      setWidth(clampWidth(next));
    },
    [width, onCollapse, clampWidth],
  );

  useEffect(() => {
    if (!isDragging) return;

    const onMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const raw = dragStartRef.current.w + (e.clientX - dragStartRef.current.x);
      if (raw < SIDEBAR_COLLAPSE_THRESHOLD) {
        setIsDragging(false);
        onCollapse?.();
        return;
      }
      setWidth(clampWidth(raw));
    };

    const onUp = () => setIsDragging(false);

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [isDragging, onCollapse, clampWidth]);

  return (
    // min-w-0 + shrink-0 pin the pane to the chosen width: without them a
    // flex item's min-width:auto lets wide tab content push the pane wider,
    // so switching tabs used to change the sidebar width.
    <aside
      style={{ width: collapsed ? 0 : width }}
      className={`theme-transition no-select relative flex h-full min-w-0 shrink-0 flex-col border-r border-maestro-border bg-maestro-surface ${
        isDragging ? "" : "transition-all duration-200 ease-out"
      } ${collapsed ? "overflow-hidden border-r-0 opacity-0" : "opacity-100"}`}
    >
      {/* Tab bar */}
      <SidebarTabBar active={activeTab} onSelect={onSelectTab} />

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-3">
        <ConfigTab
          activeSidebarTab={activeTab}
          theme={theme}
          onToggleTheme={onToggleTheme}
          launchedCount={launchedCount}
          isStoppingAll={isStoppingAll}
          onStopAll={onStopAll}
          onAgentNavigate={onAgentNavigate}
          onAgentKill={onAgentKill}
          onHistoryLaunch={onHistoryLaunch}
        />
      </div>

      {/* Drag handle */}
      {!collapsed && (
        // biome-ignore lint/a11y/useSemanticElements: Vertical resizer requires interactive div for pointer/keyboard handling.
        <div
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={Math.round(width)}
          aria-valuetext={`${Math.round(width)} pixels`}
          tabIndex={0}
          aria-label="Resize sidebar"
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-maestro-accent/30 active:bg-maestro-accent/40"
          onMouseDown={handleDragStart}
          onKeyDown={handleResizeKeyDown}
        />
      )}
    </aside>
  );
}

/* ================================================================ */
/*  TAB BAR                                                          */
/* ================================================================ */

export type SidebarTabId = "history" | "infra" | "settings";

export const SIDEBAR_TABS: { id: SidebarTabId; label: string; icon: React.ElementType }[] = [
  { id: "history", label: "History", icon: History },
  { id: "infra", label: "Infra", icon: Package },
  { id: "settings", label: "Settings", icon: Settings },
];

const SIDEBAR_TAB_STORAGE_KEY = "maestro-sidebar-tab";

export function loadSavedSidebarTab(): SidebarTabId {
  const saved = localStorage.getItem(SIDEBAR_TAB_STORAGE_KEY);
  return SIDEBAR_TABS.some((t) => t.id === saved) ? (saved as SidebarTabId) : "history";
}

export function saveSidebarTab(tab: SidebarTabId): void {
  localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, tab);
}

/**
 * State transition for the Alt+1-3 sidebar shortcuts: closed → open on that
 * tab; open on that tab already → close; open on another tab → switch.
 * Returns null when the index doesn't name a tab.
 */
export function sidebarTabShortcutTransition(
  open: boolean,
  activeTab: SidebarTabId,
  index: number,
): { open: boolean; tab: SidebarTabId } | null {
  const tab = SIDEBAR_TABS[index - 1]?.id;
  if (!tab) return null;
  if (!open) return { open: true, tab };
  if (activeTab === tab) return { open: false, tab: activeTab };
  return { open: true, tab };
}

function SidebarTabBar({
  active,
  onSelect,
}: {
  active: SidebarTabId;
  onSelect: (tab: SidebarTabId) => void;
}) {
  return (
    // Equal-width columns (auto-cols-fr): every tab gets the same width
    // regardless of its label, sized by the available space, with a small
    // gap between tab names.
    <div className="grid shrink-0 auto-cols-fr grid-flow-col gap-1 border-b border-maestro-border/60 px-1">
      {SIDEBAR_TABS.map(({ id, label, icon: Icon }, index) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(id)}
          title={titleWithShortcut(label, altLabel(), String(index + 1))}
          className={`flex min-w-0 flex-col items-center gap-0.5 border-b-2 px-0.5 py-1.5 text-[9px] font-semibold uppercase tracking-wide transition-colors ${
            active === id
              ? "border-maestro-accent text-maestro-accent"
              : "border-transparent text-maestro-muted hover:text-maestro-text"
          }`}
        >
          <Icon size={14} />
          <span className="truncate">{label}</span>
        </button>
      ))}
    </div>
  );
}

/* ================================================================ */
/*  CONFIG TAB                                                       */
/* ================================================================ */

function ConfigTab({
  activeSidebarTab,
  theme,
  onToggleTheme,
  launchedCount = 0,
  isStoppingAll = false,
  onStopAll,
  onAgentNavigate,
  onAgentKill,
  onHistoryLaunch,
}: {
  activeSidebarTab: SidebarTabId;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  launchedCount?: number;
  isStoppingAll?: boolean;
  onStopAll?: () => void;
  onAgentNavigate?: (tabId: string, sessionId: number) => void;
  onAgentKill?: (tabId: string, sessionId: number) => void;
  onHistoryLaunch?: (tabId: string) => void;
}) {
  switch (activeSidebarTab) {
    case "history":
      // onAgentNavigate is the same sidebar→terminal route the Agents section
      // takes: History reuses it to reach a conversation that is already
      // running, instead of dropping it from the list.
      return <HistorySection onLaunch={onHistoryLaunch} onNavigate={onAgentNavigate} />;
    case "infra":
      return <InfraTab />;
    case "settings":
      return (
        <>
          <AppearanceSection
            theme={theme}
            onToggle={onToggleTheme}
            launchedCount={launchedCount}
            isStoppingAll={isStoppingAll}
            onStopAll={onStopAll}
          />
          {divider}
          <NotificationsSettingsSection />
          {divider}
          <ContextAlertSection />
          {divider}
          <AgentsSection onNavigate={onAgentNavigate} onKill={onAgentKill} />
        </>
      );
  }
}

/* ── 0. Agents ── */

/**
 * Live hierarchical view of every running agent across all open projects:
 * Project → Terminal (session) → Subagents (Task tool invocations).
 * Terminals can be killed or zoomed into (click); subagents are
 * display-only — they live inside the parent Claude process.
 */
function AgentsSection({
  onNavigate,
  onKill,
}: {
  onNavigate?: (tabId: string, sessionId: number) => void;
  onKill?: (tabId: string, sessionId: number) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const sessions = useSessionStore((s) => s.sessions);
  const samuraiSchedule = useSessionStore((s) => s.samuraiSchedule);
  const agents = useAgentStore((s) => s.agents);
  const projectColors = useProjectColors();

  const projects = useMemo(
    () =>
      tabs
        .map((tab) => ({ tab, sessions: sessionsForTab(tab, sessions) }))
        // A fully-parked project has NO sessions (parked tiles auto-close;
        // PRD decision #6) but must keep its row — that row carries the
        // park-countdown chip (issue #61).
        .filter(
          (p) =>
            p.sessions.length > 0 ||
            // Park timers only: a scheduled launch (issue #129) is a run that
            // does not exist yet, so it must not keep an empty Agents row
            // alive with a chip that renders nothing.
            samuraiSchedule.some(
              (e) => isParkEntry(e) && samePath(e.project_path, p.tab.projectPath),
            ),
        ),
    [tabs, sessions, samuraiSchedule],
  );

  // Group agents by session and count running ones in a single pass instead
  // of re-filtering the agents array inside the per-session render loop.
  const { agentsBySession, runningAgentCount } = useMemo(() => {
    const bySession = new Map<number, SubagentInfo[]>();
    let running = 0;
    for (const agent of agents) {
      const list = bySession.get(agent.sessionId);
      if (list) {
        list.push(agent);
      } else {
        bySession.set(agent.sessionId, [agent]);
      }
      if (agent.completedAt === null) running += 1;
    }
    return { agentsBySession: bySession, runningAgentCount: running };
  }, [agents]);

  const terminalCount = projects.reduce((n, p) => n + p.sessions.length, 0);

  // Guards double-clicks on the kill button: one confirm dialog per session.
  const pendingKillIds = useRef(new Set<number>());
  const handleKillClick = useCallback(
    async (tabId: string, sessionId: number, name: string) => {
      if (pendingKillIds.current.has(sessionId)) return;
      pendingKillIds.current.add(sessionId);
      try {
        const confirmed = await ask(`Kill "${name}" and everything running inside it?`, {
          title: "Kill Terminal",
          kind: "warning",
        }).catch(() => false);
        if (confirmed) onKill?.(tabId, sessionId);
      } finally {
        pendingKillIds.current.delete(sessionId);
      }
    },
    [onKill],
  );

  return (
    <div className={cardClass}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="block w-full text-left"
      >
        <SectionHeader
          icon={Bot}
          label="Agents"
          breathe={runningAgentCount > 0}
          badge={
            terminalCount > 0 ? (
              <span
                className="rounded-full bg-maestro-accent/20 px-1.5 text-[10px] font-bold text-maestro-accent"
                title={`${terminalCount} terminal${terminalCount === 1 ? "" : "s"}`}
              >
                {terminalCount}
              </span>
            ) : undefined
          }
          right={
            expanded ? (
              <ChevronDown size={12} className="text-maestro-muted" />
            ) : (
              <ChevronRight size={12} className="text-maestro-muted" />
            )
          }
        />
      </button>

      {expanded &&
        (projects.length === 0 ? (
          <p className="px-1 py-0.5 text-[11px] text-maestro-muted">No running agents</p>
        ) : (
          projects.map(({ tab, sessions: projectSessions }) => {
            const color = projectColors.get(tab.name) ?? projectColorFor(tab.name);
            return (
              <div key={tab.id} className="mt-1">
                {/* Project row */}
                <div className="flex items-center gap-1.5 px-1 text-[11px] font-semibold">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span className="truncate" style={{ color }}>
                    {tab.name}
                  </span>
                  {/* Park countdown (issue #61) — nothing without a pending timer. */}
                  <SamuraiScheduleChip projectPath={tab.projectPath} />
                </div>

                {/* Terminal rows */}
                {projectSessions.map((session) => {
                  const badge = SESSION_STATUS_BADGES[session.status] ?? SESSION_STATUS_BADGES.Idle;
                  const name = sessionDisplayName(session);
                  const sessionAgents = agentsBySession.get(session.id) ?? [];
                  return (
                    <div key={session.id} className="ml-2">
                      {/* biome-ignore lint/a11y/useSemanticElements: can't be a real <button> — it wraps a nested "Kill" <button>, and nested buttons are invalid HTML that breaks click handling. */}
                      <div
                        className="group flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-maestro-border/30"
                        onClick={() => onNavigate?.(tab.id, session.id)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          onNavigate?.(tab.id, session.id);
                        }}
                        role="button"
                        tabIndex={0}
                        title={`${name} — click to zoom into this terminal`}
                      >
                        <span className="flex-1 truncate text-xs text-maestro-text">{name}</span>
                        <span className={`${badgeBaseClass} ${badge.cls}`}>{badge.label}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleKillClick(tab.id, session.id, name);
                          }}
                          className="shrink-0 rounded p-0.5 text-maestro-muted opacity-0 transition-opacity hover:bg-red-500/15 hover:text-red-400 group-hover:opacity-100"
                          title="Kill this terminal"
                          aria-label={`Kill ${name}`}
                        >
                          <Square size={10} />
                        </button>
                      </div>

                      {/* Subagent rows */}
                      {sessionAgents.length > 0 && (
                        <div className="ml-2 border-l border-maestro-border/40 pl-2">
                          {sessionAgents.map((agent) => {
                            const agentBadge =
                              agent.completedAt === null
                                ? {
                                    label: "RUNNING",
                                    cls: "bg-maestro-accent/15 text-maestro-accent animate-pulse",
                                  }
                                : agent.success === false
                                  ? { label: "FAILED", cls: "bg-red-500/15 text-red-400" }
                                  : {
                                      label: "DONE",
                                      cls: "bg-maestro-green/15 text-maestro-green",
                                    };
                            return (
                              <div
                                key={agent.agentId}
                                className="flex items-center gap-1.5 py-0.5 text-[11px]"
                                title={agent.description || agent.agentType}
                              >
                                <span className="flex-1 truncate text-maestro-muted">
                                  <span className="text-maestro-text/80">{agent.agentType}</span>
                                  {agent.description ? ` — ${agent.description}` : ""}
                                </span>
                                <span className={`${badgeBaseClass} ${agentBadge.cls}`}>
                                  {agentBadge.label}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })
        ))}
    </div>
  );
}

/* ── 7. Settings ── */

function AppearanceSection({
  theme,
  onToggle,
  launchedCount = 0,
  isStoppingAll = false,
  onStopAll,
}: {
  theme?: "dark" | "light";
  onToggle?: () => void;
  launchedCount?: number;
  isStoppingAll?: boolean;
  onStopAll?: () => void;
}) {
  const isDark = theme !== "light";
  const [showTerminalSettings, setShowTerminalSettings] = useState(false);
  const [showCliSettings, setShowCliSettings] = useState(false);
  const [showMaestroSettings, setShowMaestroSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const hasRunningSessions = launchedCount > 0;

  return (
    <>
      <div className={cardClass}>
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
          <Settings size={13} />
          Settings
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border/40"
        >
          {isDark ? (
            <Sun size={14} className="text-maestro-orange" />
          ) : (
            <Moon size={14} className="text-maestro-accent" />
          )}
          <span>{isDark ? "Switch to Light" : "Switch to Dark"}</span>
        </button>
        <button
          type="button"
          onClick={() => setShowTerminalSettings(true)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border/40"
        >
          <Wrench size={14} className="text-maestro-muted" />
          <span>Terminal Settings</span>
        </button>
        <button
          type="button"
          onClick={() => setShowCliSettings(true)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border/40"
        >
          <Zap size={14} className="text-maestro-accent" />
          <span>CLI Settings</span>
        </button>
        <button
          type="button"
          onClick={() => setShowMaestroSettings(true)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border/40"
        >
          <Info size={14} className="text-maestro-accent" />
          <span>Maestro Settings</span>
        </button>
        <button
          type="button"
          onClick={() => setShowShortcuts(true)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border/40"
        >
          <Keyboard size={14} className="text-maestro-muted" />
          <span>Keyboard Shortcuts</span>
        </button>
        <button
          type="button"
          onClick={() => setShowChangelog(true)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border/40"
        >
          <ScrollText size={14} className="text-maestro-muted" />
          <span>Changelog</span>
        </button>
        {hasRunningSessions && onStopAll && (
          <button
            type="button"
            onClick={isStoppingAll ? undefined : onStopAll}
            disabled={isStoppingAll}
            className="mt-1 flex w-full items-center gap-2.5 rounded-md border border-maestro-red/40 bg-maestro-red/10 px-2 py-1.5 text-xs font-medium text-maestro-red transition-colors hover:bg-maestro-red/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Square size={14} />
            <span>{isStoppingAll ? "Stopping..." : `Stop All (${launchedCount})`}</span>
          </button>
        )}
      </div>

      {showTerminalSettings && (
        <TerminalSettingsModal onClose={() => setShowTerminalSettings(false)} />
      )}
      {showCliSettings && <CliSettingsModal onClose={() => setShowCliSettings(false)} />}
      {showMaestroSettings && (
        <MaestroSettingsModal onClose={() => setShowMaestroSettings(false)} />
      )}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      {showChangelog && <ChangelogModal onClose={() => setShowChangelog(false)} />}
    </>
  );
}
