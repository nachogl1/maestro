import { create } from "zustand";
import type { InjectorRunResult } from "@/lib/injector";
import { useSessionStore } from "@/stores/useSessionStore";

/**
 * Notices for messages the Injector panel or a trigger typed into a terminal
 * (issue #554): the terminal header shows an amber icon until the person
 * clicks it. Other deliveries (Samurai instructions, the Journal harvest
 * prompt, launch prompts) never record here.
 *
 * In memory only, never persisted: terminal numbers start again from 1 on
 * every launch, so a saved notice could land on the wrong terminal.
 */

/** Sender label for a message sent from the Injector panel. */
export const INJECTOR_SENDER = "Injector";

/** Sender label for a trigger's message (triggers have no name of their own). */
export function triggerSender(threshold: number): string {
  return `Trigger at ${threshold}%`;
}

/** One message that reached a terminal. */
export interface InjectedMessage {
  sender: string;
  /** Epoch ms of the send. */
  at: number;
  text: string;
}

interface InjectedMessageState {
  /** Each terminal's notices, newest first; a terminal with none has no key. */
  bySession: Record<number, InjectedMessage[]>;
  record: (sessionIds: number[], sender: string, text: string, at?: number) => void;
  /** Clears every notice of one terminal. */
  clear: (sessionId: number) => void;
}

export const useInjectedMessageStore = create<InjectedMessageState>((set) => ({
  bySession: {},
  record: (sessionIds, sender, text, at = Date.now()) =>
    set((state) => {
      if (sessionIds.length === 0) return state;
      const bySession = { ...state.bySession };
      for (const id of sessionIds) {
        bySession[id] = [{ sender, at, text }, ...(bySession[id] ?? [])];
      }
      return { bySession };
    }),
  clear: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.bySession)) return state;
      const { [sessionId]: _cleared, ...rest } = state.bySession;
      return { bySession: rest };
    }),
}));

/**
 * Records one notice on every terminal an injector run reached; the
 * terminals it failed for get none (the sender already shows the failure).
 */
export function recordInjectorRun(
  targets: { sessionId: number }[],
  result: InjectorRunResult,
  sender: string,
  text: string,
): void {
  const failedIds = new Set(result.failures.map((f) => f.sessionId));
  const reachedIds = targets.map((t) => t.sessionId).filter((id) => !failedIds.has(id));
  useInjectedMessageStore.getState().record(reachedIds, sender, text);
}

// A closed terminal's notices go with it, so a later terminal given the same
// number never inherits them (the same rule the session store applies to its
// parked and pinned ids).
useSessionStore.subscribe((sessionState) => {
  const { bySession } = useInjectedMessageStore.getState();
  const ids = Object.keys(bySession).map(Number);
  if (ids.length === 0) return;
  const closedIds = ids.filter((id) => !sessionState.sessions.some((s) => s.id === id));
  if (closedIds.length === 0) return;
  const rest = { ...bySession };
  for (const id of closedIds) delete rest[id];
  useInjectedMessageStore.setState({ bySession: rest });
});
