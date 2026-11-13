import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bird, LayoutGrid, Minus, Plus, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ProjectsPill } from "@/components/projects-pill/ProjectsPill";
import { ScratchSection } from "@/components/scratch/ScratchSection";
import { MAX_SESSIONS } from "@/components/terminal/splitTree";
import { isMac } from "@/lib/platform";
import { altLabel, modLabel, titleWithShortcut } from "@/lib/shortcuts";
import { GitHubWatchdogBadge } from "./GitHubWatchdogBadge";
import { ParkedRunsBadge } from "./ParkedRunsBadge";

/** One entry of the eagle-view "add terminal" project dropdown. */
export interface EagleProjectOption {
  tabId: string;
  name: string;
  color: string;
  /** Project already has the maximum number of session slots. */
  atMax: boolean;
}

interface TopBarProps {
  /** When true, hides window controls (minimize/maximize/close) - use when ProjectTabs provides them */
  hideWindowControls?: boolean;
  /** Whether a project is open and active — the plus button shows whenever
   *  there is a project to add a terminal to, idle or not. */
  hasActiveProject?: boolean;
  /** Slots in the active project that count against maxSessions (parked samurai
   *  terminal-state tiles excluded, as in TerminalGrid's addSession) */
  slotCount?: number;
  /** Maximum number of sessions allowed */
  maxSessions?: number;
  onAddSession?: () => void;
  /** Tidy up: the terminals in one row of full-height columns (project or eagle view). */
  onTidyLayout?: () => void;
  /** Whether eagle view (all projects' terminals at once) is active */
  eagleView?: boolean;
  onToggleEagleView?: () => void;
  /** Eagle view: projects offered in the add-terminal dropdown. */
  eagleProjects?: EagleProjectOption[];
  /** Eagle view: add a terminal to the given project (opens its pre-launch card). */
  onAddSessionToProject?: (tabId: string) => void;
  /** Eagle view: add a terminal to the scratch project at this path, opening its tab first. */
  onOpenScratch?: (path: string) => void;
  /** GitHub watchdog badge: navigate to the git panel with the matching
   *  tab + search filter. Badge hides itself when totals are zero. */
  onWatchdogNavigate?: (kind: "prs" | "issues") => void;
  /** Parked-runs badge: select the project whose Samurai run is parked. */
  onParkNavigate?: (projectPath: string) => void;
}

export function TopBar({
  hideWindowControls = false,
  hasActiveProject = false,
  slotCount = 0,
  maxSessions = MAX_SESSIONS,
  onAddSession,
  onTidyLayout,
  eagleView = false,
  onToggleEagleView,
  eagleProjects = [],
  onAddSessionToProject,
  onOpenScratch,
  onWatchdogNavigate,
  onParkNavigate,
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
      {/* Left: inset from CSS var for macOS traffic lights. Panels open from the left icon strip. */}
      <div
        className="flex items-center gap-2 pr-2"
        style={{ paddingLeft: "max(var(--mac-title-bar-inset, 0px), 8px)" }}
      />

      {/* Center: drag region */}
      <div data-tauri-drag-region className="flex-1" />

      {/* Right: action icons */}
      <div className="flex items-center gap-0.5 mr-1">
        {/* Tidy up: one row of full-height columns — the project grid,
            or in eagle view every tile. */}
        {(hasActiveProject || eagleView) && onTidyLayout && (
          <button
            type="button"
            onClick={onTidyLayout}
            className="rounded p-1.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
            aria-label="Tidy up terminals"
            title={titleWithShortcut(
              "Tidy up: every terminal side by side, one row of full-height columns",
              altLabel(),
              "T",
            )}
          >
            <LayoutGrid size={14} />
          </button>
        )}
        {/* Allowance-parked Samurai runs — the one park surface that shows in
            every view. Hides itself when nothing is parked. */}
        <ParkedRunsBadge onNavigate={onParkNavigate} />
        {/* GitHub watchdog totals (review requests / assigned issues) */}
        {onWatchdogNavigate && <GitHubWatchdogBadge onNavigate={onWatchdogNavigate} />}
        <ProjectsPill />
        {/* Active project: adds a pre-launch slot to its grid (mounting the
            grid first when the project is still on its idle landing). */}
        {hasActiveProject && !eagleView && (
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
            stays in eagle view and tiles a normal pre-launch card into the grid. */}
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
                {onOpenScratch && (
                  <ScratchSection
                    onOpen={(path) => {
                      setAddMenuOpen(false);
                      onOpenScratch(path);
                    }}
                  />
                )}
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
      </div>

      {/* Window controls - hidden on macOS (custom traffic lights in row) or when hideWindowControls */}
      {!hideWindowControls && !isMac() && (
        <div className="flex items-center border-l border-maestro-border">
          <button
            type="button"
            onClick={() => appWindow.minimize()}
            className="flex h-8 w-9 items-center justify-center text-maestro-muted transition-colors hover:bg-maestro-muted/10 hover:text-maestro-text"
            aria-label="Minimize"
            title="Minimize"
          >
            <Minus size={12} />
          </button>
          <button
            type="button"
            onClick={() => appWindow.toggleMaximize()}
            className="flex h-8 w-9 items-center justify-center text-maestro-muted transition-colors hover:bg-maestro-muted/10 hover:text-maestro-text"
            aria-label="Maximize"
            title="Maximize or restore"
          >
            <Square size={10} />
          </button>
          <button
            type="button"
            onClick={() => appWindow.close()}
            className="flex h-8 w-9 items-center justify-center text-maestro-muted transition-colors hover:bg-maestro-red/80 hover:text-white"
            aria-label="Close"
            title={titleWithShortcut("Close Maestro", "Alt", "F4")}
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
