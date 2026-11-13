import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { rectSwappingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

import { samePath } from "@/lib/path";
import { projectColorFor } from "@/lib/projectColor";
import { sessionDisplayName } from "@/lib/sessionDisplayName";
import { altLabel, titleWithShortcut } from "@/lib/shortcuts";
import { useProjectColors } from "@/lib/useProjectColors";
import {
  describeContextAlert,
  isContextAlert,
  useContextAlertStore,
} from "@/stores/useContextAlertStore";
import { sortByParkedOrder, useParkedOrderStore } from "@/stores/useParkedOrderStore";
import {
  type BackendSessionStatus,
  type SamuraiParkAlert,
  type SamuraiSupervisorState,
  type SessionConfig,
  useSessionStore,
} from "@/stores/useSessionStore";
import { sessionDotColor } from "./ThinkingIndicator";

/** Last path segment, used as the project label in the eagle shelf. */
function basenameOf(path: string): string {
  const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/**
 * Extra chip treatment for states the thinking dots can't express.
 *
 * The border itself is the project's color (see below), so status lives in the
 * dots — except for the pulse that makes a parked terminal wanting the user
 * impossible to miss, and the Error state, which the red dot shares with every
 * other "waiting on you" state. Done gets no border: green means working.
 */
function chipAttentionClass(status: BackendSessionStatus): string {
  switch (status) {
    case "NeedsInput":
      return "parked-chip-attention";
    case "Error":
    case "Timeout":
      return "border-maestro-red";
    default:
      return "";
  }
}

/** Statuses that make the shelf itself call for the user's eye. */
const ATTENTION_STATUSES: BackendSessionStatus[] = ["NeedsInput", "Error", "Timeout"];

/**
 * Whether this parked terminal is a Samurai run the token allowance parked
 * and the user has not acknowledged yet — the chips that must still be
 * obvious hours later.
 *
 * Matched on the PROJECT, not the epic: the alert's epic comes from the
 * resume timer and the supervisor's from the session snapshot, and the two
 * spell the same epic differently often enough (`#37` vs `epic-37`) that a
 * string compare would silently drop the shine.
 */
function isUnacknowledgedPark(
  session: SessionConfig,
  samuraiState: SamuraiSupervisorState | undefined,
  parkAlerts: SamuraiParkAlert[],
): boolean {
  if (samuraiState !== "PARKED") return false;
  return parkAlerts.some((a) => !a.acknowledged && samePath(a.project, session.project_path));
}

/** How far the pointer must travel before a press on a chip becomes a drag, not a click. */
const DRAG_START_DISTANCE_PX = 5;

/** What a screen reader announces for a chip: how to move it and how to restore it. */
const DRAG_INSTRUCTIONS =
  "Drag with the mouse to move this terminal along the parked strip. Press Enter to restore it.";

/** Alt+U: enter the shelf, or leave it when already inside. event.code, so layout-independent. */
function isFocusShelfKey(event: globalThis.KeyboardEvent): boolean {
  return (
    event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "KeyU"
  );
}

/** Passed with a restore made from inside the shelf by keyboard. */
export interface ParkedShelfUnparkOptions {
  /** Leave keyboard focus in the shelf; do not move it into the restored terminal. */
  keepFocus: boolean;
}

interface ParkedShelfProps {
  /** When given, only parked sessions of this project are shown (per-project grid). */
  projectPath?: string;
  onUnpark: (sessionId: number, options?: ParkedShelfUnparkOptions) => void;
  /** Eagle view: prefix each chip with its project name (color-coded). */
  showProjectLabels?: boolean;
  /**
   * Whether Alt+U enters and leaves this shelf. Only the visible shelf may answer it:
   * the active project's grid, or the eagle view's shared shelf.
   */
  keyboardEnabled?: boolean;
}

interface ParkedChipProps {
  sessionId: number;
  /** Project color: the chip's border, unless an attention class takes it over. */
  projectColor: string;
  /** Attention class for the states the status dot cannot show ("" for none). */
  attention: string;
  title: string;
  onRestore: () => void;
  children: ReactNode;
}

/** One parked terminal: a button that restores it on click and can be dragged along the row. */
function ParkedChip({
  sessionId,
  projectColor,
  attention,
  title,
  onRestore,
  children,
}: ParkedChipProps) {
  // Pointer drags only: the keyboard keeps the shelf's own arrow, Enter and Esc keys.
  // dnd-kit swallows the click that ends a drag, so a drop never restores the terminal.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(sessionId),
  });
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      type="button"
      onClick={onRestore}
      // The chip's border is its project's color, matching that project's
      // terminals in the grid; the attention classes override it
      // for the few states the dots can't show. --chip-color tints the
      // liquid fill shown while the chip has keyboard focus.
      style={
        {
          "--chip-color": projectColor,
          ...(attention ? {} : { borderColor: projectColor }),
          transform: CSS.Transform.toString(transform),
          transition,
          opacity: isDragging ? 0.5 : 1,
        } as CSSProperties
      }
      // Anchor for the park/resume particle effects (ParticleEffectsLayer).
      data-parked-session-id={sessionId}
      className={`parked-chip flex shrink-0 items-center gap-1.5 rounded-full border bg-maestro-card px-2.5 py-0.5 text-xs text-maestro-text transition-colors hover:border-maestro-accent ${attention}`}
      title={title}
    >
      {children}
    </button>
  );
}

/**
 * Thin strip at the bottom edge of the terminal grid listing parked
 * terminals as chips (name + live status dot). Clicking a chip restores
 * the terminal to the grid; dragging one moves it along the row (issue #495).
 * Renders nothing while no terminal is parked.
 */
export function ParkedShelf({
  projectPath,
  onUnpark,
  showProjectLabels = false,
  keyboardEnabled = false,
}: ParkedShelfProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const parkedIds = useSessionStore((s) => s.parkedSessionIds);
  const samuraiBySessionId = useSessionStore((s) => s.samuraiBySessionId);
  const parkAlerts = useSessionStore((s) => s.samuraiParkAlerts);
  // Run-fatal badges (issue #174) that survived the auto-park — see
  // `parkSession` in useSessionStore.ts. Read separately from the general
  // `attentionSessionIds` so this chip only shines for a dead run, never for
  // an ordinary user-initiated park.
  const runFatalIds = useSessionStore((s) => s.runFatalSessionIds);
  const acknowledgeParks = useSessionStore((s) => s.acknowledgeSamuraiParks);
  // Context alert (Settings): a parked terminal past the threshold blinks its
  // chip red, the same way its hidden frame would.
  const contextAlertThreshold = useContextAlertStore((s) => s.threshold);
  // Clash-resolved colors, so a parked chip matches the project's terminals
  // rather than showing that project's raw (possibly re-seated) hash color.
  const projectColors = useProjectColors();
  // The order the user dragged the chips into, shared by every shelf.
  const parkedOrder = useParkedOrderStore((s) => s.order);
  const moveParked = useParkedOrderStore((s) => s.move);
  const syncParkedOrder = useParkedOrderStore((s) => s.syncParked);

  useEffect(() => {
    syncParkedOrder(parkedIds);
  }, [parkedIds, syncParkedOrder]);

  const parkedSessions = useMemo(
    () =>
      sortByParkedOrder(
        sessions.filter(
          (sess) =>
            parkedIds.includes(sess.id) &&
            (projectPath === undefined || samePath(sess.project_path, projectPath)),
        ),
        parkedOrder,
      ),
    [sessions, parkedIds, projectPath, parkedOrder],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_START_DISTANCE_PX } }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    moveParked(
      parkedSessions.map((sess) => sess.id),
      Number(active.id),
      Number(over.id),
      sessions.filter((sess) => parkedIds.includes(sess.id)).map((sess) => sess.id),
    );
  };

  const shelfRef = useRef<HTMLDivElement>(null);
  // Where leaving the shelf sends focus back to: whatever held it before Alt+U
  // (usually a terminal), so leaving drops the user where they were.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // The terminal last restored with Enter since entering the shelf.
  const lastRestoredIdRef = useRef<number | null>(null);
  const hasParked = parkedSessions.length > 0;

  const leaveShelf = useCallback(() => {
    const target = returnFocusRef.current;
    const restoredId = lastRestoredIdRef.current;
    returnFocusRef.current = null;
    lastRestoredIdRef.current = null;
    if (target?.isConnected) target.focus();
    if (target && document.activeElement === target) return;
    if (restoredId !== null) {
      // The pane Alt+U came from cannot take focus: a terminal restored while
      // zoomed took over the zoom and hid it. Land in that terminal instead;
      // unparking a terminal that is already back only brings it forward.
      onUnpark(restoredId);
    } else if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, [onUnpark]);

  // Alt+U enters the shelf on its first chip; pressed again inside, it leaves.
  // Capture phase, like the terminal shortcuts: xterm stops the events it
  // handles, so a bubble listener never fires while a terminal has focus.
  useEffect(() => {
    if (!keyboardEnabled || !hasParked) return;
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (!isFocusShelfKey(event)) return;
      const shelf = shelfRef.current;
      const firstChip = shelf?.querySelector<HTMLElement>("[data-parked-session-id]");
      if (!shelf || !firstChip) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const active = document.activeElement;
      if (shelf.contains(active)) {
        leaveShelf();
        return;
      }
      returnFocusRef.current = active instanceof HTMLElement ? active : null;
      lastRestoredIdRef.current = null;
      firstChip.focus();
    }
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [keyboardEnabled, hasParked, leaveShelf]);

  const restore = (sess: SessionConfig, options?: ParkedShelfUnparkOptions) => {
    // Restoring the run IS the acknowledgement.
    if (isUnacknowledgedPark(sess, samuraiBySessionId[sess.id]?.state, parkAlerts)) {
      acknowledgeParks(sess.project_path);
    }
    if (options) {
      onUnpark(sess.id, options);
    } else {
      onUnpark(sess.id);
    }
  };

  // Inside the shelf: Left/Right move between chips (wrapping), Enter restores
  // the focused one and stays in the shelf on the next chip, Esc goes back.
  const handleShelfKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const chips = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-parked-session-id]"),
    );
    const index = chips.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const step = event.key === "ArrowRight" ? 1 : -1;
      chips[(index + step + chips.length) % chips.length].focus();
    } else if (event.key === "Enter") {
      const sess = parkedSessions.find(
        (s) => String(s.id) === chips[index].dataset.parkedSessionId,
      );
      if (!sess) return;
      // Focus moves before the chip disappears: to the next chip, or the one
      // before it at the end of the row. With no chip left the shelf is done:
      // a plain restore puts the cursor in the restored terminal.
      const nextChip = chips[index + 1] ?? chips[index - 1];
      if (!nextChip) {
        returnFocusRef.current = null;
        lastRestoredIdRef.current = null;
        restore(sess);
      } else {
        nextChip.focus();
        lastRestoredIdRef.current = sess.id;
        restore(sess, { keepFocus: true });
      }
    } else if (event.key === "Escape") {
      leaveShelf();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  if (!hasParked) return null;

  const hasAttention = parkedSessions.some(
    (sess) =>
      ATTENTION_STATUSES.includes(sess.status) ||
      isUnacknowledgedPark(sess, samuraiBySessionId[sess.id]?.state, parkAlerts) ||
      runFatalIds.includes(sess.id),
  );

  return (
    <div
      ref={shelfRef}
      // A toolbar: one strip of buttons the arrow keys walk through.
      role="toolbar"
      aria-label="Parked terminals"
      onKeyDown={handleShelfKeyDown}
      className={`scrollbar-none flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto border-t bg-maestro-surface px-2 ${
        hasAttention ? "border-maestro-accent/60" : "border-maestro-border"
      }`}
    >
      <span
        className={`shrink-0 text-[10px] font-medium uppercase tracking-wider ${
          hasAttention ? "text-maestro-accent" : "text-maestro-muted"
        }`}
        title={titleWithShortcut("Pick a parked terminal from the keyboard", altLabel(), "U")}
      >
        Parked
      </span>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis]}
        onDragEnd={handleDragEnd}
        // dnd-kit's default text describes keyboard dragging, which this strip does not offer.
        accessibility={{ screenReaderInstructions: { draggable: DRAG_INSTRUCTIONS } }}
      >
        <SortableContext
          items={parkedSessions.map((sess) => String(sess.id))}
          strategy={rectSwappingStrategy}
        >
          {parkedSessions.map((sess) => {
            const project = basenameOf(sess.project_path);
            const projectColor = projectColors.get(project) ?? projectColorFor(project);
            // An unacknowledged allowance park outranks the status classes: the
            // tile is done running (every wake-up is a fresh spawn), so its last
            // status has nothing left to say, while the park does.
            const parked = isUnacknowledgedPark(
              sess,
              samuraiBySessionId[sess.id]?.state,
              parkAlerts,
            );
            // A run-fatal badge outranks even the allowance shine: "resumes at
            // HH:MM" is simply wrong for a run the circuit breaker killed, and
            // the existing NeedsInput treatment already reads as "come look now".
            const runFatal = runFatalIds.includes(sess.id);
            // The context alert outranks everything: the terminal is about to run
            // out of room whatever else it is doing, and the frame it stands in
            // for would be blinking red too.
            const contextAlert = isContextAlert(sess.contextPercent, contextAlertThreshold);
            const attention = contextAlert
              ? "parked-chip-context-alert"
              : runFatal
                ? "parked-chip-attention"
                : parked
                  ? "samurai-park-shine"
                  : chipAttentionClass(sess.status);
            const restoreTitle = runFatal
              ? "Samurai run died — restore terminal"
              : parked
                ? "Parked on token allowance — restore terminal"
                : "Restore terminal";
            return (
              <ParkedChip
                key={sess.id}
                sessionId={sess.id}
                projectColor={projectColor}
                attention={attention}
                onRestore={() => restore(sess)}
                title={
                  contextAlert &&
                  sess.contextPercent !== undefined &&
                  contextAlertThreshold !== null
                    ? `${describeContextAlert(sess.contextPercent, contextAlertThreshold)} — ${restoreTitle}`
                    : restoreTitle
                }
              >
                <span className={`h-1.5 w-1.5 rounded-full ${sessionDotColor(sess.status)}`} />
                {showProjectLabels && (
                  <span className="font-bold" style={{ color: projectColor }}>
                    {project}
                  </span>
                )}
                <span className="max-w-[140px] truncate">{sessionDisplayName(sess)}</span>
              </ParkedChip>
            );
          })}
        </SortableContext>
      </DndContext>
    </div>
  );
}
