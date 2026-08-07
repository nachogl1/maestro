import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  Bird,
  Brain,
  BrainCircuit,
  GitMerge,
  Minus,
  Network,
  PanelLeft,
  Plus,
  Rocket,
  Sparkles,
  Square,
  StickyNote,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isMac } from "@/lib/platform";
import { modLabel, titleWithShortcut } from "@/lib/shortcuts";
import { MAX_SESSIONS } from "@/components/terminal/splitTree";
import { GitHubWatchdogBadge } from "./GitHubWatchdogBadge";
import { HealthAttentionBadge } from "./HealthAttentionBadge";

/** One entry of the eagle-view "add terminal" project dropdown. */
export interface EagleProjectOption {
  tabId: string;
  name: string;
  color: string;
  /** Project already has the maximum number of session slots. */
  atMax: boolean;
}

interface TopBarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onToggleGitPanel?: () => void;
  gitPanelOpen?: boolean;
  /** When true, hides window controls (minimize/maximize/close) - use when ProjectTabs provides them */
  hideWindowControls?: boolean;
  /** Whether sessions have been launched for the active project (grid view) */
  inGridView?: boolean;
  /** Number of session slots in the active project */
  slotCount?: number;
  /** Maximum number of sessions allowed */
  maxSessions?: number;
  onAddSession?: () => void;
  /** Whether eagle view (all projects' terminals at once) is active */
  eagleView?: boolean;
  onToggleEagleView?: () => void;
  /** Eagle view: projects offered in the add-terminal dropdown. */
  eagleProjects?: EagleProjectOption[];
  /** Eagle view: add a terminal to the given project (opens its pre-launch card). */
  onAddSessionToProject?: (tabId: string) => void;
  /** Landscape view: every project, terminal and subagent on one canvas */
  landscapeView?: boolean;
  onToggleLandscapeView?: () => void;
  /** A terminal somewhere is waiting for input — marks the landscape button. */
  landscapeAttention?: boolean;
  /** Right-side Memory panel */
  memoryPanelOpen?: boolean;
  onToggleMemoryPanel?: () => void;
  /** Right-side Processes panel */
  processesPanelOpen?: boolean;
  onToggleProcessesPanel?: () => void;
  /** Right-side Notes panel */
  notesPanelOpen?: boolean;
  onToggleNotesPanel?: () => void;
  /** Right-side AI panel (Report / Plan / Catalog tabs) */
  aiPanelOpen?: boolean;
  onToggleAiPanel?: () => void;
  /** Right-side Samurai Second Brain panel — audit stream + files (issue #66) */
  secondBrainPanelOpen?: boolean;
  onToggleSecondBrainPanel?: () => void;
  /** Right-side Samurai run launcher panel (issue #63) */
  launchPanelOpen?: boolean;
  onToggleLaunchPanel?: () => void;
  /** GitHub watchdog badge: navigate to the git panel with the matching
   *  tab + search filter. Badge hides itself when totals are zero. */
  onWatchdogNavigate?: (kind: "prs" | "issues") => void;
}

export function TopBar({
  sidebarOpen,
  onToggleSidebar,
  onToggleGitPanel,
  gitPanelOpen,
  hideWindowControls = false,
  inGridView = false,
  slotCount = 0,
  maxSessions = MAX_SESSIONS,
  onAddSession,
  eagleView = false,
  onToggleEagleView,
  eagleProjects = [],
  onAddSessionToProject,
  landscapeView = false,
  onToggleLandscapeView,
  landscapeAttention = false,
  memoryPanelOpen = false,
  onToggleMemoryPanel,
  processesPanelOpen = false,
  onToggleProcessesPanel,
  notesPanelOpen = false,
  onToggleNotesPanel,
  aiPanelOpen = false,
  onToggleAiPanel,
  secondBrainPanelOpen = false,
  onToggleSecondBrainPanel,
  launchPanelOpen = false,
  onToggleLaunchPanel,
  onWatchdogNavigate,
}: TopBarProps) {
  const appWindow = useMemo(() => getCurrentWindow(), []);

  // Eagle view add-terminal dropdown (pick which project gets the new terminal)
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  // Close the dropdown on any outside click.
  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [addMenuOpen]);

  // Leaving eagle view (or losing all projects) drops the menu.
  useEffect(() => {
    if (!eagleView) setAddMenuOpen(false);
  }, [eagleView]);

  return (
    <div data-tauri-drag-region className="no-select flex h-10 flex-1 items-center bg-maestro-bg">
      {/* Left: collapse toggle + branch area (inset from CSS var for macOS traffic lights) */}
      <div
        className="flex items-center gap-2 pr-2"
        style={{ paddingLeft: "max(var(--mac-title-bar-inset, 0px), 8px)" }}
      >
        {/* Sidebar toggle - only shown when ProjectTabs isn't providing it */}
        {!hideWindowControls && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className={`rounded-md border px-1.5 py-1 shadow-sm transition-all active:translate-y-px active:shadow-none ${
              sidebarOpen
                ? "border-maestro-accent/30 bg-maestro-accent/10 text-maestro-accent hover:bg-maestro-accent/15"
                : "border-maestro-border bg-maestro-card text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text hover:shadow"
            }`}
            aria-label="Toggle sidebar"
          >
            <PanelLeft size={15} />
          </button>
        )}
      </div>

      {/* Center: drag region */}
      <div data-tauri-drag-region className="flex-1" />

      {/* Right: action icons */}
      <div className="flex items-center gap-0.5 mr-1">
        {/* GitHub watchdog totals (review requests / assigned issues) */}
        {onWatchdogNavigate && <GitHubWatchdogBadge onNavigate={onWatchdogNavigate} />}
        {/* Active project: adds a pre-launch slot to its grid. */}
        {inGridView && !eagleView && (
          <button
            type="button"
            onClick={onAddSession}
            disabled={slotCount >= maxSessions}
            className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Add session"
            title={titleWithShortcut("New terminal", modLabel(), "T")}
          >
            <Plus size={14} />
          </button>
        )}
        {/* Eagle view: the plus becomes a project dropdown; picking a project
            leaves eagle view and opens a normal pre-launch card there. */}
        {eagleView && onAddSessionToProject && eagleProjects.length > 0 && (
          <div className="relative" ref={addMenuRef}>
            <button
              type="button"
              onClick={() => setAddMenuOpen((v) => !v)}
              className={`rounded p-1.5 transition-colors ${
                addMenuOpen
                  ? "bg-maestro-card text-maestro-text"
                  : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
              }`}
              aria-label="Add terminal to project"
              title={titleWithShortcut("New terminal — pick a project", modLabel(), "T")}
            >
              <Plus size={14} />
            </button>
            {addMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 min-w-[180px] rounded-md border border-maestro-border bg-maestro-surface py-1 shadow-lg">
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-maestro-muted">
                  Add terminal to…
                </div>
                {eagleProjects.map((project) => (
                  <button
                    key={project.tabId}
                    type="button"
                    disabled={project.atMax}
                    onClick={() => {
                      setAddMenuOpen(false);
                      onAddSessionToProject(project.tabId);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-maestro-text transition-colors hover:bg-maestro-card disabled:cursor-not-allowed disabled:opacity-50"
                    title={
                      project.atMax
                        ? `${project.name} already has the maximum number of terminals`
                        : `Add a terminal in ${project.name}`
                    }
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: project.color }}
                    />
                    <span className="truncate">{project.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {onToggleEagleView && (
          <button
            type="button"
            onClick={onToggleEagleView}
            className={`rounded p-1.5 transition-colors ${
              eagleView
                ? "text-maestro-accent hover:bg-maestro-accent/10"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
            aria-label="Eagle view"
            title={titleWithShortcut("Eagle view", modLabel(), "G")}
          >
            <Bird size={14} />
          </button>
        )}
        {onToggleLandscapeView && (
          <button
            type="button"
            onClick={onToggleLandscapeView}
            className={`relative rounded p-1.5 transition-colors ${
              landscapeView
                ? "text-maestro-accent hover:bg-maestro-accent/10"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
            aria-label="Landscape view"
            title="Landscape — every project, terminal and subagent on one canvas"
          >
            <Network size={14} />
            {landscapeAttention && !landscapeView && (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-maestro-accent"
              />
            )}
          </button>
        )}
        {onToggleMemoryPanel && (
          <button
            type="button"
            onClick={onToggleMemoryPanel}
            className={`relative rounded p-1.5 transition-colors ${
              memoryPanelOpen
                ? "text-maestro-accent hover:bg-maestro-accent/10"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
            aria-label="Memory"
            title={titleWithShortcut("Memory", modLabel(), "3")}
          >
            <Brain size={14} />
            <HealthAttentionBadge area="memory" />
          </button>
        )}
        {onToggleProcessesPanel && (
          <button
            type="button"
            onClick={onToggleProcessesPanel}
            className={`relative rounded p-1.5 transition-colors ${
              processesPanelOpen
                ? "text-maestro-accent hover:bg-maestro-accent/10"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
            aria-label="Processes"
            title={titleWithShortcut("Processes", modLabel(), "4")}
          >
            <Activity size={14} />
            <HealthAttentionBadge area="processes" />
          </button>
        )}
        {onToggleNotesPanel && (
          <button
            type="button"
            onClick={onToggleNotesPanel}
            className={`rounded p-1.5 transition-colors ${
              notesPanelOpen
                ? "text-maestro-accent hover:bg-maestro-accent/10"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
            aria-label="Notes"
            title={titleWithShortcut("Notes", modLabel(), "5")}
          >
            <StickyNote size={14} />
          </button>
        )}
        {onToggleAiPanel && (
          <button
            type="button"
            onClick={onToggleAiPanel}
            className={`rounded p-1.5 transition-colors ${
              aiPanelOpen
                ? "text-maestro-accent hover:bg-maestro-accent/10"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
            aria-label="AI"
            title={titleWithShortcut("AI — daily report and plan", modLabel(), "6")}
          >
            <Sparkles size={14} />
          </button>
        )}
        {onToggleSecondBrainPanel && (
          <button
            type="button"
            onClick={onToggleSecondBrainPanel}
            className={`rounded p-1.5 transition-colors ${
              secondBrainPanelOpen
                ? "text-maestro-accent hover:bg-maestro-accent/10"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
            aria-label="Second Brain"
            title="Samurai Second Brain — audit stream and managed files"
          >
            <BrainCircuit size={14} />
          </button>
        )}
        {onToggleLaunchPanel && (
          <button
            type="button"
            onClick={onToggleLaunchPanel}
            className={`rounded p-1.5 transition-colors ${
              launchPanelOpen
                ? "text-maestro-accent hover:bg-maestro-accent/10"
                : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            }`}
            aria-label="Launch"
            title="Samurai launch — start and clean up autonomous epic runs"
          >
            <Rocket size={14} />
          </button>
        )}
        {/* Git panel — in eagle view it becomes a per-project carousel
            (swipe between one git card per open project). */}
        <button
          type="button"
          onClick={onToggleGitPanel}
          className={`rounded p-1.5 transition-colors ${
            gitPanelOpen
              ? "text-maestro-accent hover:bg-maestro-accent/10"
              : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
          }`}
          aria-label="Git"
          title={titleWithShortcut("Git", modLabel(), "2")}
        >
          <GitMerge size={14} />
        </button>
      </div>

      {/* Window controls - hidden on macOS (custom traffic lights in row) or when hideWindowControls */}
      {!hideWindowControls && !isMac() && (
        <div className="flex items-center border-l border-maestro-border">
          <button
            type="button"
            onClick={() => appWindow.minimize()}
            className="flex h-8 w-9 items-center justify-center text-maestro-muted transition-colors hover:bg-maestro-muted/10 hover:text-maestro-text"
            aria-label="Minimize"
          >
            <Minus size={12} />
          </button>
          <button
            type="button"
            onClick={() => appWindow.toggleMaximize()}
            className="flex h-8 w-9 items-center justify-center text-maestro-muted transition-colors hover:bg-maestro-muted/10 hover:text-maestro-text"
            aria-label="Maximize"
          >
            <Square size={10} />
          </button>
          <button
            type="button"
            onClick={() => appWindow.close()}
            className="flex h-8 w-9 items-center justify-center text-maestro-muted transition-colors hover:bg-maestro-red/80 hover:text-white"
            aria-label="Close"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
