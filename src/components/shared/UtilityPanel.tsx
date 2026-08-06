import { Suspense, lazy } from "react";
import { Activity, Brain, ScrollText, Sparkles, StickyNote, X } from "lucide-react";
import {
  PanelResizeHandle,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
} from "@/components/shared/PanelResizeHandle";
import { AiPanel } from "@/components/ai/AiPanel";
import { AuditSection } from "@/components/sidebar/AuditSection";
import { MemorySection } from "@/components/sidebar/MemorySection";
import { ProcessesSection } from "@/components/sidebar/ProcessesSection";

// NotepadPanel drags in TipTap + ProseMirror, which are only needed once the
// user opens the Notes panel; a static import parses them all at startup.
const NotepadPanel = lazy(() =>
  import("@/components/notepad/NotepadPanel").then((m) => ({
    default: m.NotepadPanel,
  })),
);

export type UtilityPanelKind = "memory" | "processes" | "notes" | "ai" | "audit";

const PANEL_META: Record<UtilityPanelKind, { title: string; icon: React.ElementType }> = {
  memory: { title: "Memory", icon: Brain },
  processes: { title: "Processes", icon: Activity },
  notes: { title: "Notes", icon: StickyNote },
  ai: { title: "AI", icon: Sparkles },
  // Minimal Samurai audit stream (issue #46) — absorbed into the Second
  // Brain panel in Phase 4 (PRD §5.11).
  audit: { title: "Audit", icon: ScrollText },
};

/**
 * Right-side panel for the Memory, Processes and Notes views, opened from the
 * top-bar buttons. Reuses the same section components the sidebar tabs used
 * to render, just docked on the right instead of the left.
 */
export function UtilityPanel({
  panel,
  width,
  onResize,
  onClose,
}: {
  panel: UtilityPanelKind;
  /** Width shared with the other right-docked panels (see App). */
  width: number;
  onResize: (width: number) => void;
  onClose: () => void;
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
          {panel === "memory" ? (
            <MemorySection />
          ) : panel === "processes" ? (
            <ProcessesSection />
          ) : panel === "audit" ? (
            <AuditSection />
          ) : (
            <AiPanel />
          )}
        </div>
      )}
    </aside>
  );
}
