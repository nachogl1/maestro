import { ask } from "@tauri-apps/plugin-dialog";
import { Bot, ChevronDown, ChevronRight, Settings, SlidersHorizontal, Square } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { SettingsDialog } from "@/components/settings";
import { SamuraiScheduleChip } from "@/components/terminal/SamuraiScheduleChip";
import { sessionsForTab } from "@/hooks/useProjectStatus";
import { samePath } from "@/lib/path";
import { projectColorFor } from "@/lib/projectColor";
import { isParkEntry } from "@/lib/samurai";
import { sessionDisplayName } from "@/lib/sessionDisplayName";
import { useProjectColors } from "@/lib/useProjectColors";
import { type SubagentInfo, useAgentStore } from "@/stores/useAgentStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import {
  badgeBaseClass,
  cardClass,
  divider,
  SESSION_STATUS_BADGES,
  SectionHeader,
} from "./sectionChrome";

/* ================================================================ */
/*  SETTINGS PANEL                                                   */
/* ================================================================ */

interface SettingsPanelContentProps {
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
}

/**
 * What the Settings panel of the left icon strip holds: the button to the
 * Settings dialog, the Agents list and Stop All (formerly the sidebar's
 * Settings tab).
 */
export function SettingsPanelContent({
  theme,
  onToggleTheme,
  launchedCount = 0,
  isStoppingAll = false,
  onStopAll,
  onAgentNavigate,
  onAgentKill,
}: SettingsPanelContentProps) {
  return (
    <>
      <SettingsLauncherSection theme={theme} onToggleTheme={onToggleTheme} />
      {divider}
      <AgentsSection onNavigate={onAgentNavigate} onKill={onAgentKill} />
      {/* Last in the panel, away from Open Settings, so it is never hit by mistake. */}
      <StopAllSection
        launchedCount={launchedCount}
        isStoppingAll={isStoppingAll}
        onStopAll={onStopAll}
      />
    </>
  );
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

function SettingsLauncherSection({
  theme,
  onToggleTheme,
}: {
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
}) {
  const [showSettings, setShowSettings] = useState(false);

  return (
    <>
      <div className={cardClass}>
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
          <Settings size={13} />
          Settings
        </div>
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border/40"
        >
          <SlidersHorizontal size={14} className="text-maestro-accent" />
          <span>Open Settings</span>
        </button>
      </div>

      {showSettings && (
        <SettingsDialog
          theme={theme}
          onToggleTheme={onToggleTheme}
          onClose={() => setShowSettings(false)}
        />
      )}
    </>
  );
}

/* ── 8. Stop All ── */

function StopAllSection({
  launchedCount = 0,
  isStoppingAll = false,
  onStopAll,
}: {
  launchedCount?: number;
  isStoppingAll?: boolean;
  onStopAll?: () => void;
}) {
  if (launchedCount === 0 || !onStopAll) return null;

  return (
    <>
      {divider}
      <button
        type="button"
        onClick={isStoppingAll ? undefined : onStopAll}
        disabled={isStoppingAll}
        className="flex w-full items-center gap-2.5 rounded-md border border-maestro-red/40 bg-maestro-red/10 px-2 py-1.5 text-xs font-medium text-maestro-red transition-colors hover:bg-maestro-red/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Square size={14} />
        <span>{isStoppingAll ? "Stopping..." : `Stop All (${launchedCount})`}</span>
      </button>
    </>
  );
}
