import { type MutableRefObject, useEffect, useRef } from "react";
import type { SessionSlot } from "@/components/terminal/PreLaunchCard";
import { killSession } from "@/lib/terminal";
import { SAMURAI_TERMINAL_STATES, useSessionStore } from "@/stores/useSessionStore";

/**
 * How many parked samurai transcripts one grid keeps mounted (issue #122).
 *
 * A parked tile stays MOUNTED — it renders `display: none`, so its
 * TerminalView and xterm scrollback live on — and since the cap no longer
 * bounds them (see `occupiedSlotCount`) nothing else reaps them: an overnight
 * run at 30-minute handoffs would accrue ~48 of them plus a shelf chip each.
 * The newest few are what anyone actually reads back, so the rest are
 * disposed (PR #131 review M5).
 */
export const MAX_RETAINED_PARKED_SAMURAI_TILES = 3;

/** The parked samurai terminal-state session ids among these slots, oldest
 *  first — session ids are assigned in launch order and never reused. */
function parkedSamuraiSessionIds(slots: SessionSlot[]): number[] {
  const { samuraiBySessionId, parkedSessionIds } = useSessionStore.getState();
  return slots
    .flatMap((slot) => (slot.sessionId === null ? [] : [slot.sessionId]))
    .filter((sessionId) => {
      const info = samuraiBySessionId[sessionId];
      return (
        info !== undefined &&
        SAMURAI_TERMINAL_STATES.has(info.state) &&
        parkedSessionIds.includes(sessionId)
      );
    })
    .sort((a, b) => a - b);
}

interface UseSamuraiAutoParkOptions {
  slotsRef: MutableRefObject<SessionSlot[]>;
  parkedSet: Set<number>;
  handlePark: (slotId: string) => void;
  handleKill: (sessionId: number, opts?: { keepDirArtifacts?: boolean }) => void;
}

/**
 * Parks (and, unless already DEAD, kills) every tile whose samurai session
 * reached a terminal supervisor state, then disposes parked samurai tiles
 * past `MAX_RETAINED_PARKED_SAMURAI_TILES`.
 */
export function useSamuraiAutoPark({
  slotsRef,
  parkedSet,
  handlePark,
  handleKill,
}: UseSamuraiAutoParkOptions): void {
  // Samurai kills (issue #55), parks (issue #60) and deaths (issue #44):
  // once a session reaches a terminal supervisor state (KILLED/PARKED/DEAD,
  // `SAMURAI_TERMINAL_STATES`) the session is announced on the
  // samurai-supervisor-event channel. No PTY-exit event exists and terminal
  // teardown is otherwise always frontend-initiated, so without this the
  // tile would linger, live, forever. Per issue #122's decided policy this
  // reuses the EXISTING park mechanism (`handlePark`, the same one the P
  // button drives) rather than closing the tile: the terminal moves into the
  // footer parking tray, and its transcript stays reachable by unparking it
  // — resuming is always a fresh spawn either way, so nothing is lost by
  // keeping the old terminal around instead of destroying it.
  //
  // Deliberately placed AFTER the pending-launch consume/launch effects
  // (fresh-eyes finding A): effects run in definition order, so when a
  // KILLED update and the successor's queued launch land in the same commit,
  // the consume effect claims and appends the successor slot first.
  const samuraiBySessionId = useSessionStore((s) => s.samuraiBySessionId);
  // One-shot guard (PR #131 review H2): the effect re-runs whenever
  // `parkedSet` changes, and the samurai entry keeps its terminal state
  // forever — so a user unpark from the tray would immediately re-trigger
  // the park (and a redundant re-kill) without this. Session ids are never
  // reused (resume is always a fresh spawn), so once handled is handled.
  const samuraiAutoParkedSessionIdsRef = useRef<Set<number>>(new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs and state setters are passed in from TerminalGrid, where they are stable (useRef/useState); deps are kept identical to the pre-extraction inline version so behaviour does not change
  useEffect(() => {
    for (const slot of slotsRef.current) {
      if (slot.sessionId === null) continue;
      if (samuraiAutoParkedSessionIdsRef.current.has(slot.sessionId)) continue;
      const info = samuraiBySessionId[slot.sessionId];
      if (info && SAMURAI_TERMINAL_STATES.has(info.state)) {
        samuraiAutoParkedSessionIdsRef.current.add(slot.sessionId);
        // The replicator/parker paths already tore the PTY down, and a DEAD
        // session's process is already gone by definition — but the Phase-2
        // circuit breaker (samurai_progress.rs) only transitions to PARKED,
        // leaving the PTY running. Kill it there so no path can orphan a
        // live agent running with --dangerously-skip-permissions; skip the
        // redundant IPC call for DEAD, whose process is confirmed gone.
        //
        // The kill is decided by the SUPERVISOR STATE alone, never by
        // `parkedSet` (PR #131 review H1): a tile the user already parked
        // with the P button still has a LIVE PTY — park is CSS-only — so
        // skipping it there is exactly the case that orphans an agent.
        // The one-shot ref above is what stops a redundant re-kill.
        if (info.state !== "DEAD") {
          killSession(slot.sessionId).catch(console.error);
        }
        // Only the tile move is conditional: parking an already-parked tile
        // would steal zoom/focus from wherever the user moved them.
        if (!parkedSet.has(slot.sessionId)) {
          handlePark(slot.id);
        }
      }
    }
    // Dispose everything past the retention cap, oldest first: a parked tile
    // is still mounted, so an unbounded run would hoard a TerminalView + xterm
    // buffer per generation. `keepDirArtifacts` is essential — the worktree,
    // MCP and hooks config belong to the RUN, which the next generation is
    // still working in.
    const retired = parkedSamuraiSessionIds(slotsRef.current);
    const excess = retired.length - MAX_RETAINED_PARKED_SAMURAI_TILES;
    for (const sessionId of retired.slice(0, Math.max(0, excess))) {
      handleKill(sessionId, { keepDirArtifacts: true });
    }
  }, [samuraiBySessionId, parkedSet, handlePark, handleKill]);
}
