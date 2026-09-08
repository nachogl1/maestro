import { Pause, PinOff } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { type ParkedPin, parkedPinKey, terminalPinLabel } from "@/lib/parkedPins";
import { formatCountdown, formatResumeAt, useCountdownNow } from "@/lib/parkTime";
import { normalizePath } from "@/lib/path";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import {
  type BackendSessionStatus,
  type SamuraiParkAlert,
  type SessionConfig,
  useSessionStore,
} from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/** Chip status dot colors — same palette as the parked shelf's chips. */
const STATUS_DOT: Record<BackendSessionStatus, string> = {
  Starting: "bg-orange-400",
  Idle: "bg-maestro-muted",
  Working: "bg-maestro-blue",
  NeedsInput: "bg-maestro-accent",
  Done: "bg-maestro-green",
  Error: "bg-red-500",
  Timeout: "bg-red-500",
};

/** Last path segment — the project name the tab strip shows. */
function projectName(projectPath: string): string {
  const segments = projectPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

/**
 * A pin matched back to the live item it points at. A pin with no match
 * renders nothing at all — after a restart the terminal may not exist and the
 * run may not be parked, and a chip for something that is not parked would be
 * a lie. The pin itself is kept: the item usually comes back.
 */
export type ResolvedPin =
  | { pin: ParkedPin; kind: "terminal"; session: SessionConfig }
  | { pin: ParkedPin; kind: "samurai"; alert: SamuraiParkAlert };

/**
 * Matches each pin to a live parked terminal or a live park alert, in pin
 * order. Matching goes through `parkedPinKey` on both sides, so the project
 * path's spelling and the epic's punctuation cannot break a pin — and a
 * session id is never involved, because ids are reassigned each app launch.
 *
 * The Samurai side reads `samuraiParkAlerts`, which is already `isParkEntry`-
 * filtered upstream: a scheduled launch (issue #129) is a run that does not
 * exist yet and must never surface here as "parked".
 */
export function resolvePins(
  pins: ParkedPin[],
  parkedSessions: SessionConfig[],
  alerts: SamuraiParkAlert[],
): ResolvedPin[] {
  const sessionByKey = new Map(
    parkedSessions.map((sess) => [
      parkedPinKey({
        kind: "terminal",
        project: sess.project_path,
        label: terminalPinLabel(sess.name, sess.id),
      }),
      sess,
    ]),
  );
  const alertByKey = new Map(
    alerts.map((alert) => [
      parkedPinKey({ kind: "samurai", project: alert.project, label: alert.epic }),
      alert,
    ]),
  );

  const resolved: ResolvedPin[] = [];
  for (const pin of pins) {
    const key = parkedPinKey(pin);
    if (pin.kind === "terminal") {
      const session = sessionByKey.get(key);
      if (session) resolved.push({ pin, kind: "terminal", session });
    } else {
      const alert = alertByKey.get(key);
      if (alert) resolved.push({ pin, kind: "samurai", alert });
    }
  }
  return resolved;
}

interface PinnedParkedRailProps {
  /**
   * Takes the user to the pinned item: selects its project (leaving eagle or
   * landscape), and for a terminal pin restores and focuses that terminal.
   */
  onNavigate: (projectPath: string, sessionId?: number) => void;
}

/**
 * Always-mounted strip of the parked items the user pinned — parked terminals
 * and allowance-parked Samurai runs — sitting directly under the project tabs.
 *
 * It exists because every other park surface is view-local: the parked shelf
 * belongs to one grid (or to eagle), and the project chip to one project. Leave
 * that view and the parked item is gone. A pin is the user saying "this one
 * follows me", so the rail is mounted next to the tab strip, above the view
 * switch, and shows in the per-project grid, eagle and landscape alike.
 *
 * Renders nothing while no pin resolves to a live parked item, so an app with
 * no pins looks exactly as it did.
 */
export function PinnedParkedRail({ onNavigate }: PinnedParkedRailProps) {
  const pinnedParked = useWorkspaceStore((s) => s.pinnedParked);
  const togglePinnedParked = useWorkspaceStore((s) => s.togglePinnedParked);
  const parkedSessions = useSessionStore(
    useShallow((s) => s.sessions.filter((sess) => s.parkedSessionIds.includes(sess.id))),
  );
  const alerts = useSessionStore((s) => s.samuraiParkAlerts);
  const acknowledgeParks = useSessionStore((s) => s.acknowledgeSamuraiParks);
  const projectColors = useProjectColors();

  const resolved = useMemo(
    () => resolvePins(pinnedParked, parkedSessions, alerts),
    [pinnedParked, parkedSessions, alerts],
  );
  // Hooks run unconditionally; the tick only arms while a countdown is shown.
  const now = useCountdownNow(resolved.some((r) => r.kind === "samurai"));

  if (resolved.length === 0) return null;

  return (
    <div className="theme-transition no-select flex h-7 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-maestro-border bg-maestro-surface px-2">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-maestro-muted">
        Pinned
      </span>
      {resolved.map((item) => {
        const project = projectName(item.pin.project);
        const projectColor = projectColors.get(project) ?? projectColorFor(project);
        // A pinned park that is still unacknowledged wears the SAME shine the
        // shelf and the top-bar badge use — one treatment, not a second one
        // competing with it.
        const shining =
          item.kind === "samurai"
            ? !item.alert.acknowledged
            : alerts.some(
                (a) =>
                  !a.acknowledged &&
                  normalizePath(a.project) === normalizePath(item.session.project_path),
              );
        return (
          <div
            key={parkedPinKey(item.pin)}
            className="group relative flex shrink-0 items-center"
            title={
              item.kind === "samurai"
                ? `${project} · ${item.alert.epic} — parked on token allowance, resumes ${
                    formatResumeAt(item.alert.fireAt, now) ?? item.alert.fireAt
                  }`
                : `${project} · parked terminal — click to restore it`
            }
          >
            <button
              type="button"
              onClick={() => {
                if (item.kind === "samurai") {
                  acknowledgeParks(item.alert.project);
                  onNavigate(item.alert.project);
                  return;
                }
                acknowledgeParks(item.session.project_path);
                onNavigate(item.session.project_path, item.session.id);
              }}
              style={shining ? undefined : { borderColor: projectColor }}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border bg-maestro-card py-0.5 pl-2 pr-7 text-[11px] text-maestro-text transition-colors hover:border-maestro-accent ${
                shining ? "samurai-park-shine" : ""
              }`}
            >
              {item.kind === "samurai" ? (
                <Pause size={9} className="shrink-0 text-maestro-orange" aria-hidden="true" />
              ) : (
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    STATUS_DOT[item.session.status] ?? STATUS_DOT.Idle
                  }`}
                />
              )}
              <span className="font-bold" style={{ color: projectColor }}>
                {project}
              </span>
              <span className="max-w-[140px] truncate">
                {item.kind === "samurai" ? item.alert.epic : item.pin.label}
              </span>
              {item.kind === "samurai" && (
                // Never a bare HH:MM — a park can be governed by the 7-day
                // allowance window (see lib/parkTime).
                <span className="shrink-0 text-maestro-orange">
                  {formatCountdown(item.alert.fireAt, now) ?? "parked"}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => togglePinnedParked(item.pin)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-maestro-muted opacity-0 transition-opacity hover:text-maestro-accent focus-visible:opacity-100 group-hover:opacity-100"
              aria-label={`Unpin ${item.pin.label}`}
              title="Unpin — drops it from this rail"
            >
              <PinOff size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
