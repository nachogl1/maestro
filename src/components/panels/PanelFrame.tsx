import { X } from "lucide-react";
import type { ReactNode } from "react";
import { PanelResizeHandle } from "@/components/shared/PanelResizeHandle";
import { PANEL_MIN_WIDTH } from "@/stores/usePanelStripStore";
import { shortcutTitle } from "./IconStrip";
import type { PanelDefinition } from "./panels";

interface PanelFrameProps {
  definition: PanelDefinition;
  width: number;
  /** The widest this panel may grow without squeezing the terminals. */
  maxWidth: number;
  /** A kept-mounted panel stays in the page but hidden while closed. */
  hidden?: boolean;
  onResize: (width: number) => void;
  onClose: () => void;
  headerExtra?: ReactNode;
  children: ReactNode;
}

/** One open panel: header with title and close button, body, and a right-edge resize handle. */
export function PanelFrame({
  definition,
  width,
  maxWidth,
  hidden = false,
  onResize,
  onClose,
  headerExtra,
  children,
}: PanelFrameProps) {
  const { title, icon: Icon } = definition;
  return (
    <section
      aria-label={`${title} panel`}
      aria-hidden={hidden || undefined}
      {...(hidden ? ({ inert: "" } as { inert: "" }) : {})}
      style={{ width }}
      className={`${
        hidden ? "hidden" : "flex"
      } relative h-full min-w-0 shrink-0 flex-col border-r border-maestro-border bg-maestro-surface`}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-maestro-border/60 pl-3 pr-2">
        <Icon size={14} className="shrink-0 text-maestro-accent" />
        <span className="shrink-0 text-sm font-medium text-maestro-text">{title}</span>
        <div className="flex min-w-0 flex-1 items-center gap-2">{headerExtra}</div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          aria-label={`Close ${title} panel`}
          title={shortcutTitle(`Close ${title} panel`, definition)}
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {!hidden && (
        <PanelResizeHandle
          edge="right"
          width={width}
          min={PANEL_MIN_WIDTH}
          max={Math.max(PANEL_MIN_WIDTH, maxWidth)}
          onResize={onResize}
          label={`Resize ${title} panel`}
        />
      )}
    </section>
  );
}
