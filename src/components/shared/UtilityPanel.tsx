import { BrainCircuit, Rocket, StickyNote, X } from "lucide-react";
import { lazy, Suspense } from "react";
import {
  PanelResizeHandle,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
} from "@/components/shared/PanelResizeHandle";
import { LaunchSection } from "@/components/sidebar/LaunchSection";
import { SecondBrainSection } from "@/components/sidebar/SecondBrainSection";

// NotepadPanel drags in TipTap + ProseMirror, which are only needed once the
// user opens the Notes panel; a static import parses them all at startup.
const NotepadPanel = lazy(() =>
  import("@/components/notepad/NotepadPanel").then((m) => ({
    default: m.NotepadPanel,
  })),
);

export type UtilityPanelKind = "notes" | "secondbrain" | "launch";

const PANEL_META: Record<UtilityPanelKind, { title: string; icon: React.ElementType }> = {
  notes: { title: "Notes", icon: StickyNote },
  // Samurai Second Brain (issue #66, PRD §5.11): the Phase 1 audit stream
  // plus the managed-file inventory, absorbed from the old audit panel.
  secondbrain: { title: "Second Brain", icon: BrainCircuit },
  // Samurai run launcher + active runs (issue #63, PRD §5.8/§9).
  launch: { title: "Launch", icon: Rocket },
};

/**
 * Right-side panel for the Notes, Second Brain and Launch views, opened from
 * the top-bar buttons. Docked on the right, one panel at a time.
 */
export function UtilityPanel({
  panel,
  width,
  onResize,
  onClose,
  onNavigateToSession,
}: {
  panel: UtilityPanelKind;
  /** Width shared with the other right-docked panels (see App). */
  width: number;
  onResize: (width: number) => void;
  onClose: () => void;
  /** Jump to a session's terminal — the Launch panel's per-run open button. */
  onNavigateToSession?: (tabId: string, sessionId: number) => void;
}) {
  const { title, icon: Icon } = PANEL_META[panel];
  return (
    <aside
      style={{ width }}
      className="relative flex h-full min-w-0 shrink-0 flex-col border-l border-maestro-border bg-maestro-surface"
    >
      <PanelResizeHandle
        edge="left"
        width={width}
        min={RIGHT_PANEL_MIN_WIDTH}
        max={RIGHT_PANEL_MAX_WIDTH}
        onResize={onResize}
        label={`Resize ${title} panel`}
      />
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-maestro-border/60 px-3">
        <Icon size={14} className="text-maestro-accent" />
        <span className="flex-1 text-sm font-medium text-maestro-text">{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          aria-label={`Close ${title} panel`}
        >
          <X size={14} />
        </button>
      </div>
      {panel === "notes" ? (
        // NotepadPanel lays itself out (tab strip + editor) edge-to-edge and
        // scrolls internally, so it skips the padded scroll wrapper.
        <Suspense fallback={<div className="flex-1" />}>
          <NotepadPanel />
        </Suspense>
      ) : (
        <div className="flex-1 overflow-y-auto px-2.5 py-3">
          {panel === "secondbrain" ? (
            <SecondBrainSection />
          ) : (
            <LaunchSection onNavigate={onNavigateToSession} />
          )}
        </div>
      )}
    </aside>
  );
}
