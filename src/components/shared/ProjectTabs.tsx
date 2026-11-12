import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppWindow, Minus, PanelLeft, Plus, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAttentionBlink } from "@/hooks/useAttentionBlink";
import { STATUS_COLORS, useProjectStatus } from "@/hooks/useProjectStatus";
import { isMac } from "@/lib/platform";
import type { ScreenPoint } from "@/lib/projectWindow";
import { altLabel, titleWithShortcut } from "@/lib/shortcuts";

export type ProjectTab = {
  id: string;
  name: string;
  active: boolean;
  /** Project accent color (name-derived, matches the eagle view's tile borders). */
  color?: string;
};

interface ProjectTabsProps {
  tabs: ProjectTab[];
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Open another project. Omitted: no "+" button (pop-out windows hold one project). */
  onNewTab?: () => void;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  onReorderTab: (activeId: string, overId: string) => void;
  onMoveTab: (tabId: string, direction: "left" | "right") => void;
  /**
   * Move a project into its own window, at `position` when the tab was
   * dragged out of this window. Omitted: the action isn't offered.
   */
  onPopOutTab?: (id: string, position?: ScreenPoint) => void;
  /**
   * A tab was dragged out of this window and dropped at `point` (a pop-out
   * window uses it to dock the project back). Omitted: nothing happens.
   */
  onDropTabOutside?: (id: string, point: ScreenPoint) => void;
}

/** Where the pointer was last seen during a tab drag. */
type DragPointer = { clientX: number; clientY: number; screenX: number; screenY: number };

/** How far the new window's corner sits up and left of the drop point, so the cursor lands on its title bar. */
const DROP_WINDOW_OFFSET = { x: 80, y: 12 };

/**
 * Screen point where a tab drag ended outside this window (e.g. on another
 * monitor or another Maestro window), or null when it ended inside it.
 */
export function outsideDropPoint(
  pointer: DragPointer,
  viewport: { width: number; height: number },
): ScreenPoint | null {
  const inside =
    pointer.clientX >= 0 &&
    pointer.clientY >= 0 &&
    pointer.clientX <= viewport.width &&
    pointer.clientY <= viewport.height;
  return inside ? null : { x: pointer.screenX, y: pointer.screenY };
}

/**
 * Screen position for a pop-out when a tab drag ended outside this window
 * (e.g. on another monitor), or null when it ended inside it (a reorder).
 */
export function tearOffPosition(
  pointer: DragPointer,
  viewport: { width: number; height: number },
): ScreenPoint | null {
  const point = outsideDropPoint(pointer, viewport);
  if (!point) return null;
  return { x: point.x - DROP_WINDOW_OFFSET.x, y: point.y - DROP_WINDOW_OFFSET.y };
}

/** Right-click menu position and the tab it was opened on. */
type TabMenuState = { tabId: string; x: number; y: number };

/**
 * Individual tab component that uses the useProjectStatus hook.
 */
function TabItem({
  tab,
  onSelect,
  onClose,
  onPopOut,
  onContextMenu,
  onKeyDown,
  tabRefCallback,
}: {
  tab: ProjectTab;
  onSelect: () => void;
  onClose: () => void;
  onPopOut?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  tabRefCallback: (node: HTMLElement | null) => void;
}) {
  const { status, sessionCount, contextAlert, hasAttention } = useProjectStatus(tab.id);
  const shouldPulse = status === "working" || status === "needs-input";
  // Blinks with the session tab of the terminal that needs the user (issue
  // #496), on the same clock; the red context alert outranks it.
  const attentionBlinking = hasAttention && !contextAlert;
  const attentionBlinkStyle = useAttentionBlink(attentionBlinking);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });

  const combinedRef = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      tabRefCallback(node);
    },
    [setNodeRef, tabRefCallback],
  );

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    // Project accent as a 2px underline (inset shadow avoids affecting layout).
    // Dimmed on inactive tabs so the active tab stays the focal point.
    // color-mix (not a hex alpha suffix) because the accents are hsl() strings.
    ...(tab.color
      ? {
          boxShadow: `inset 0 -2px 0 0 ${
            tab.active ? tab.color : `color-mix(in srgb, ${tab.color} 50%, transparent)`
          }`,
        }
      : {}),
    ...attentionBlinkStyle,
  };

  return (
    <div
      ref={combinedRef}
      style={style}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={tab.active}
      tabIndex={tab.active ? 0 : -1}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      data-context-alert={contextAlert ? "true" : undefined}
      data-attention={attentionBlinking ? "true" : undefined}
      title={
        contextAlert
          ? "A terminal in this project reached the context alert"
          : attentionBlinking
            ? "A terminal in this project needs you"
            : undefined
      }
      className={`group flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t px-2 py-1.5 text-xs font-medium cursor-pointer ${
        tab.active
          ? "bg-maestro-bg text-maestro-text"
          : "text-maestro-muted hover:text-maestro-text"
      } ${contextAlert ? "project-tab-context-alert" : attentionBlinking ? "attention-blink" : ""}`}
    >
      <span className="flex items-center gap-1.5">
        <span
          className={`h-2 w-2 rounded-full ${STATUS_COLORS[status]} ${
            shouldPulse ? "animate-pulse" : ""
          }`}
        />
        <span>{tab.name}</span>
        {sessionCount > 0 && (
          <span
            className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
              status === "needs-input"
                ? "bg-maestro-accent/20 text-maestro-accent"
                : status === "working"
                  ? "bg-maestro-blue/20 text-maestro-blue"
                  : "bg-maestro-muted/20 text-maestro-muted"
            }`}
          >
            {sessionCount}
          </span>
        )}
      </span>
      {onPopOut && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPopOut();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className={`ml-1 rounded p-0.5 hover:bg-maestro-border focus-visible:opacity-100 group-hover:opacity-100 ${
            tab.active ? "opacity-100" : "opacity-0"
          }`}
          aria-label={`Move ${tab.name} to a new window`}
          title="Move to new window"
        >
          <AppWindow size={10} />
        </button>
      )}
      {/* Stops pointerdown so dnd-kit's PointerSensor never claims the
          press — a click on the close button must not start a tab drag. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="rounded p-0.5 hover:bg-maestro-border"
        aria-label={`Close ${tab.name}`}
        title={`Close project ${tab.name}`}
      >
        <X size={10} />
      </button>
    </div>
  );
}

export function ProjectTabs({
  tabs,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onToggleSidebar,
  sidebarOpen,
  onReorderTab,
  onMoveTab,
  onPopOutTab,
  onDropTabOutside,
}: ProjectTabsProps) {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);

  // Dismiss the tab menu on any outside click, Escape, or window blur.
  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [tabMenu]);

  // Ref map for focus management (WAI-ARIA tablist keyboard navigation)
  const tabRefs = useRef(new Map<string, HTMLElement>());
  const setTabRef = useCallback(
    (id: string) => (node: HTMLElement | null) => {
      if (node) {
        tabRefs.current.set(id, node);
      } else {
        tabRefs.current.delete(id);
      }
    },
    [],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  // Last pointer position of the current tab drag. Tracked by hand because
  // dnd-kit's own delta is clamped to the tab strip (horizontal-axis modifier).
  const dragPointer = useRef<DragPointer | null>(null);
  const stopTrackingPointer = useRef<(() => void) | null>(null);

  const trackPointer = useCallback((e: PointerEvent) => {
    dragPointer.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
    };
  }, []);

  const handleDragStart = useCallback(
    (_event: DragStartEvent) => {
      dragPointer.current = null;
      window.addEventListener("pointermove", trackPointer);
      stopTrackingPointer.current = () => window.removeEventListener("pointermove", trackPointer);
    },
    [trackPointer],
  );

  const endPointerTracking = useCallback(() => {
    stopTrackingPointer.current?.();
    stopTrackingPointer.current = null;
    const pointer = dragPointer.current;
    dragPointer.current = null;
    return pointer;
  }, []);

  useEffect(() => () => stopTrackingPointer.current?.(), []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const pointer = endPointerTracking();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      // Dropped outside this window (another monitor, the desktop): the
      // project moves to its own window where it was dropped.
      if (pointer && onPopOutTab) {
        const position = tearOffPosition(pointer, viewport);
        if (position) {
          onPopOutTab(active.id as string, position);
          return;
        }
      }
      const outsidePoint = pointer && outsideDropPoint(pointer, viewport);
      if (outsidePoint && onDropTabOutside) {
        onDropTabOutside(active.id as string, outsidePoint);
        return;
      }
      if (over && active.id !== over.id) {
        onReorderTab(active.id as string, over.id as string);
      }
    },
    [onReorderTab, onPopOutTab, onDropTabOutside, endPointerTracking],
  );

  // Keep the selected tab visible when the strip is wider than the window.
  const activeTabId = tabs.find((t) => t.active)?.id;
  useEffect(() => {
    if (!activeTabId) return;
    tabRefs.current.get(activeTabId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  // A plain mouse wheel has no horizontal axis; map it onto the strip's scroll.
  const handleTabListWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaX !== 0 || e.deltaY === 0) return;
    e.currentTarget.scrollLeft += e.deltaY;
  }, []);

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent, tab: ProjectTab) => {
      const isMeta = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl+Shift+N: move the project to a new window
      if (isMeta && e.shiftKey && e.key.toLowerCase() === "n" && onPopOutTab) {
        e.preventDefault();
        onPopOutTab(tab.id);
        return;
      }

      // Cmd/Ctrl+Shift+Arrow: move tab position
      if (isMeta && e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        onMoveTab(tab.id, e.key === "ArrowLeft" ? "left" : "right");
        return;
      }

      // Arrow keys: switch tab focus
      if (e.key === "ArrowRight") {
        const idx = tabs.findIndex((t) => t.id === tab.id);
        const next = tabs[(idx + 1) % tabs.length];
        if (next) {
          onSelectTab(next.id);
          tabRefs.current.get(next.id)?.focus();
        }
      } else if (e.key === "ArrowLeft") {
        const idx = tabs.findIndex((t) => t.id === tab.id);
        const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
        if (prev) {
          onSelectTab(prev.id);
          tabRefs.current.get(prev.id)?.focus();
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelectTab(tab.id);
      }
    },
    [tabs, onSelectTab, onMoveTab, onPopOutTab],
  );

  return (
    <div
      data-tauri-drag-region
      className="theme-transition no-select flex h-9 items-center border-b border-maestro-border bg-maestro-surface"
    >
      {/* Left: sidebar toggle + tabs (inset from CSS var for macOS traffic lights) */}
      <div
        className="flex min-w-0 items-center gap-0.5 pr-1.5"
        style={{ paddingLeft: "max(var(--mac-title-bar-inset, 0px), 6px)" }}
      >
        <button
          type="button"
          onClick={onToggleSidebar}
          className={`shrink-0 rounded p-1.5 transition-colors ${
            sidebarOpen
              ? "text-maestro-accent hover:bg-maestro-accent/10"
              : "text-maestro-muted hover:bg-maestro-border hover:text-maestro-text"
          }`}
          aria-label="Toggle sidebar"
          title={titleWithShortcut("Toggle sidebar", altLabel(), "1–3")}
        >
          <PanelLeft size={14} />
        </button>

        <div className="mx-1 h-4 w-px shrink-0 bg-maestro-border" />

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis]}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={endPointerTracking}
        >
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            <div
              role="tablist"
              aria-label="Open projects"
              onWheel={handleTabListWheel}
              className="scrollbar-none flex min-w-0 items-center gap-0.5 overflow-x-auto"
            >
              {tabs.length === 0 ? (
                <span className="px-2 text-xs text-maestro-muted">No projects</span>
              ) : (
                tabs.map((tab) => (
                  <TabItem
                    key={tab.id}
                    tab={tab}
                    onSelect={() => onSelectTab(tab.id)}
                    onClose={() => onCloseTab(tab.id)}
                    onPopOut={onPopOutTab ? () => onPopOutTab(tab.id) : undefined}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setTabMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
                    }}
                    onKeyDown={(e) => handleTabKeyDown(e, tab)}
                    tabRefCallback={setTabRef(tab.id)}
                  />
                ))
              )}
            </div>
          </SortableContext>
        </DndContext>

        {onNewTab && (
          <button
            type="button"
            onClick={onNewTab}
            className="shrink-0 rounded p-1 text-maestro-muted hover:bg-maestro-border hover:text-maestro-text"
            aria-label="Open new project"
            title="Open a project"
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      {tabMenu && (
        <div
          role="menu"
          aria-label="Project tab actions"
          className="fixed z-50 min-w-44 rounded-md border border-maestro-border bg-maestro-card py-1 text-xs text-maestro-text shadow-lg"
          style={{ left: tabMenu.x, top: tabMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {onPopOutTab && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-maestro-border"
              onClick={() => {
                setTabMenu(null);
                onPopOutTab(tabMenu.tabId);
              }}
            >
              <AppWindow size={12} />
              Move to new window
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-maestro-border"
            onClick={() => {
              setTabMenu(null);
              onCloseTab(tabMenu.tabId);
            }}
          >
            <X size={12} />
            Close project
          </button>
        </div>
      )}

      {/* Center: drag region fills remaining space */}
      <div data-tauri-drag-region className="flex-1" />

      {/* Right: window controls (hidden on macOS — custom traffic lights in row instead) */}
      {!isMac() && (
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => appWindow.minimize()}
            className="flex h-9 w-11 items-center justify-center text-maestro-muted transition-colors hover:bg-maestro-muted/10 hover:text-maestro-text"
            aria-label="Minimize"
            title="Minimize"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            onClick={() => appWindow.toggleMaximize()}
            className="flex h-9 w-11 items-center justify-center text-maestro-muted transition-colors hover:bg-maestro-muted/10 hover:text-maestro-text"
            aria-label="Maximize"
            title="Maximize or restore"
          >
            <Square size={12} />
          </button>
          <button
            type="button"
            onClick={() => appWindow.close()}
            className="flex h-9 w-11 items-center justify-center text-maestro-muted transition-colors hover:bg-maestro-red/80 hover:text-white"
            aria-label="Close"
            title={titleWithShortcut("Close Maestro", "Alt", "F4")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
