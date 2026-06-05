import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  GitMerge,
  Minus,
  PanelLeft,
  Square,
  X,
} from "lucide-react";
import { useMemo } from "react";
import { isMac } from "@/lib/platform";

interface TopBarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onToggleGitPanel?: () => void;
  gitPanelOpen?: boolean;
  /** When true, hides window controls (minimize/maximize/close) - use when ProjectTabs provides them */
  hideWindowControls?: boolean;
}

export function TopBar({
  sidebarOpen,
  onToggleSidebar,
  onToggleGitPanel,
  gitPanelOpen,
  hideWindowControls = false,
}: TopBarProps) {
  const appWindow = useMemo(() => getCurrentWindow(), []);

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
        <button
          type="button"
          onClick={onToggleGitPanel}
          className={`rounded p-1.5 transition-colors ${
            gitPanelOpen
              ? "text-maestro-accent hover:bg-maestro-accent/10"
              : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
          }`}
          aria-label="Git graph"
          title="Git Graph"
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
