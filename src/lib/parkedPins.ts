import { normalizePath } from "@/lib/path";
import { epicSlug } from "@/lib/samurai";

/**
 * Identity of a PINNED parked item — a parked terminal, or an allowance-parked
 * Samurai run — so it can be shown in the always-mounted rail from any view.
 *
 * The whole design turns on one question: what is stable enough to persist?
 *
 * - NOT a session id. Session ids are reassigned every app launch (see the
 *   `parkedSessionIds` comment in `useSessionStore`), so a pin keyed on one
 *   would come back after a restart pointing at an unrelated new terminal.
 * - NOT a park's fire time. `SamuraiParkAlert.key` includes it because it
 *   de-dupes one emission of the timer list against the next; the fire time
 *   changes every time the timer re-arms, so it cannot carry a user's pin.
 *
 * What survives is what the user actually pointed at: the project the item
 * lives in, plus the item's own name (terminal) or epic (Samurai run).
 */
export type ParkedPinKind = "terminal" | "samurai";

export interface ParkedPin {
  kind: ParkedPinKind;
  /** Project path as the pinning surface knew it (compared via `normalizePath`). */
  project: string;
  /** Terminal name, or the run's epic label — the pin's stable second half. */
  label: string;
}

/**
 * Canonical string form of a pin, used for both storage de-dupe and matching a
 * pin back to a live item.
 *
 * Paths are normalized (the Windows `\\?\` prefix and separator/case spellings
 * of one directory must be one pin, matching `samePath`). Samurai labels go
 * through `epicSlug` because the same epic reaches different surfaces spelled
 * differently (`#37` from the run config, `epic-37` from the resume timer) —
 * a raw string compare would silently fail to match a pin to its own run.
 */
export function parkedPinKey(pin: ParkedPin): string {
  const label = pin.kind === "samurai" ? epicSlug(pin.label) : pin.label.trim().toLowerCase();
  return `${pin.kind}|${normalizePath(pin.project)}|${label}`;
}

/** Whether `pin` is already in `pins` (key equality, not object identity). */
export function isParkedPinned(pins: ParkedPin[], pin: ParkedPin): boolean {
  const key = parkedPinKey(pin);
  return pins.some((p) => parkedPinKey(p) === key);
}

/**
 * The label a parked terminal pins under. An unnamed session has no stable
 * name to persist, so it falls back to its id: that pin is honest for the
 * current app run and simply matches nothing after a restart (the rail only
 * renders pins it can resolve to a live parked item), rather than resolving to
 * whichever terminal inherits the number.
 */
export function terminalPinLabel(name: string | null | undefined, sessionId: number): string {
  return name?.trim() || `Session #${sessionId}`;
}
