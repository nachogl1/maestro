import { Pin, PinOff } from "lucide-react";
import { useMemo } from "react";

import { isParkedPinned, terminalPinLabel } from "@/lib/parkedPins";
import { samePath } from "@/lib/path";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import {
  type BackendSessionStatus,
  type SamuraiParkAlert,
  type SamuraiSupervisorState,
  type SessionConfig,
  useSessionStore,
} from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { ThinkingIndicator } from "./ThinkingIndicator";

/** Chip status dot colors — mirrors the sidebar's SESSION_STATUS_BADGES palette. */
const STATUS_DOT: Record<BackendSessionStatus, string> = {
  Starting: "bg-orange-400",
  Idle: "bg-maestro-muted",
  Working: "bg-maestro-blue",
  NeedsInput: "bg-maestro-accent",
  Done: "bg-maestro-green",
  Error: "bg-red-500",
  Timeout: "bg-red-500",
};

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
 * impossible to miss, and the terminal Error/Done states, which the dots read
 * as plain "idle".
 */
function chipAttentionClass(status: BackendSessionStatus): string {
  switch (status) {
    case "NeedsInput":
      return "parked-chip-attention";
    case "Error":
    case "Timeout":
      return "border-maestro-red";
    case "Done":
      return "border-maestro-green";
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

interface ParkedShelfProps {
  /** When given, only parked sessions of this project are shown (per-project grid). */
  projectPath?: string;
  onUnpark: (sessionId: number) => void;
  /** Eagle view: prefix each chip with its project name (color-coded). */
  showProjectLabels?: boolean;
}

/**
 * Thin strip at the bottom edge of the terminal grid listing parked
 * terminals as chips (name + live status dot). Clicking a chip restores
 * the terminal to the grid. Renders nothing while no terminal is parked.
 */
export function ParkedShelf({
  projectPath,
  onUnpark,
  showProjectLabels = false,
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
  const pinnedParked = useWorkspaceStore((s) => s.pinnedParked);
  const togglePinnedParked = useWorkspaceStore((s) => s.togglePinnedParked);
  // Clash-resolved colors, so a parked chip matches the project's terminals
  // rather than showing that project's raw (possibly re-seated) hash color.
  const projectColors = useProjectColors();

  const parkedSessions = useMemo(
    () =>
      sessions.filter(
        (sess) =>
          parkedIds.includes(sess.id) &&
          (projectPath === undefined || samePath(sess.project_path, projectPath)),
      ),
    [sessions, parkedIds, projectPath],
  );

  if (parkedSessions.length === 0) return null;

  const hasAttention = parkedSessions.some(
    (sess) =>
      ATTENTION_STATUSES.includes(sess.status) ||
      isUnacknowledgedPark(sess, samuraiBySessionId[sess.id]?.state, parkAlerts) ||
      runFatalIds.includes(sess.id),
  );

  return (
    <div
      className={`flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto border-t bg-maestro-surface px-2 ${
        hasAttention ? "border-maestro-accent/60" : "border-maestro-border"
      }`}
    >
      <span
        className={`shrink-0 text-[10px] font-medium uppercase tracking-wider ${
          hasAttention ? "text-maestro-accent" : "text-maestro-muted"
        }`}
      >
        Parked
      </span>
      {parkedSessions.map((sess) => {
        const project = basenameOf(sess.project_path);
        const projectColor = projectColors.get(project) ?? projectColorFor(project);
        // An unacknowledged allowance park outranks the status classes: the
        // tile is done running (every wake-up is a fresh spawn), so its last
        // status has nothing left to say, while the park does.
        const parked = isUnacknowledgedPark(sess, samuraiBySessionId[sess.id]?.state, parkAlerts);
        // A run-fatal badge outranks even the allowance shine: "resumes at
        // HH:MM" is simply wrong for a run the circuit breaker killed, and
        // the existing NeedsInput treatment already reads as "come look now".
        const runFatal = runFatalIds.includes(sess.id);
        const attention = runFatal
          ? "parked-chip-attention"
          : parked
            ? "samurai-park-shine"
            : chipAttentionClass(sess.status);
        const pin = {
          kind: "terminal" as const,
          project: sess.project_path,
          label: terminalPinLabel(sess.name, sess.id),
        };
        const pinned = isParkedPinned(pinnedParked, pin);
        return (
          // The pin control rides ON the chip (absolute) rather than beside it,
          // so a pinned, shining, project-colored chip still reads as one thing.
          <div key={sess.id} className="group relative flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => {
                // Restoring the run IS the acknowledgement.
                if (parked) acknowledgeParks(sess.project_path);
                onUnpark(sess.id);
              }}
              // The chip's border is its project's color, matching that project's
              // terminals in the grid; the attention classes above override it
              // for the few states the dots can't show.
              style={attention ? undefined : { borderColor: projectColor }}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border bg-maestro-card py-0.5 pl-2.5 pr-7 text-xs text-maestro-text transition-colors hover:border-maestro-accent ${attention}`}
              title={
                runFatal
                  ? "Samurai run died — restore terminal"
                  : parked
                    ? "Parked on token allowance — restore terminal"
                    : "Restore terminal"
              }
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[sess.status] ?? STATUS_DOT.Idle}`}
              />
              <ThinkingIndicator sessionId={sess.id} size={3} />
              {showProjectLabels && (
                <span className="font-bold" style={{ color: projectColor }}>
                  {project}
                </span>
              )}
              <span className="max-w-[140px] truncate">
                {sess.name?.trim() || `Session #${sess.id}`}
              </span>
            </button>
            <button
              type="button"
              onClick={() => togglePinnedParked(pin)}
              className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 transition-opacity hover:text-maestro-accent ${
                pinned
                  ? "text-maestro-accent"
                  : "text-maestro-muted opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
              }`}
              aria-label={`${pinned ? "Unpin" : "Pin"} ${pin.label}`}
              title={
                pinned
                  ? "Unpin — drops it from the always-visible parked rail"
                  : "Pin — keeps it visible in every view, not just this one"
              }
            >
              {pinned ? <PinOff size={10} /> : <Pin size={10} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
