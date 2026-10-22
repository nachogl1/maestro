/**
 * Injector triggers: watch some terminals' context usage and send a message
 * automatically when one of them reaches a chosen percent.
 */
import type { InjectorRunResult } from "@/lib/injector";
import { isContextAlert } from "@/stores/useContextAlertStore";

/** Who receives a trigger's message when it fires. */
export type InjectorTriggerTarget = "all" | "reached";

/** What a trigger's last firing did, shown on its row. */
export interface InjectorTriggerFire {
  /** Epoch ms of the firing. */
  at: number;
  /** Names of the watched terminals that reached the threshold. */
  reachedNames: string[];
  result: InjectorRunResult;
}

export interface InjectorTrigger {
  id: string;
  /** Session ids whose context usage is watched. */
  watchIds: number[];
  /** Whole percent (1-100) that fires the trigger. */
  threshold: number;
  message: string;
  /** "all": every watched terminal gets the message; "reached": only the one(s) that hit it. */
  target: InjectorTriggerTarget;
  /**
   * Watched terminals that already fired and are still at or over the
   * threshold. A terminal leaves this list when its context drops below it
   * (e.g. after /clear or a compact), which re-arms the trigger for it.
   */
  firedIds: number[];
  lastFire: InjectorTriggerFire | null;
}

/** The context usage the evaluation needs from a session. */
export interface TriggerSessionView {
  id: number;
  contextPercent?: number;
}

/** One trigger firing: the watched terminals that just reached its threshold. */
export interface TriggerFiring {
  triggerId: string;
  reachedIds: number[];
}

export interface TriggerEvaluation {
  /** New `firedIds` per trigger, only for triggers whose list changed. */
  firedIds: Map<string, number[]>;
  firings: TriggerFiring[];
}

/**
 * Works out which triggers fire now. A watched terminal fires once when its
 * context reaches the threshold (already being over it when the trigger is
 * made counts), then stays quiet until its context drops below it again.
 * Closed terminals are forgotten.
 */
export function evaluateTriggers(
  triggers: InjectorTrigger[],
  sessions: TriggerSessionView[],
): TriggerEvaluation {
  const firedIds = new Map<string, number[]>();
  const firings: TriggerFiring[] = [];
  for (const trigger of triggers) {
    const nextFired: number[] = [];
    const reachedIds: number[] = [];
    for (const session of sessions) {
      if (!trigger.watchIds.includes(session.id)) continue;
      if (!isContextAlert(session.contextPercent, trigger.threshold)) continue;
      nextFired.push(session.id);
      if (!trigger.firedIds.includes(session.id)) reachedIds.push(session.id);
    }
    const unchanged =
      nextFired.length === trigger.firedIds.length &&
      nextFired.every((id) => trigger.firedIds.includes(id));
    if (!unchanged) firedIds.set(trigger.id, nextFired);
    if (reachedIds.length > 0) firings.push({ triggerId: trigger.id, reachedIds });
  }
  return { firedIds, firings };
}

/** Session ids that receive the message for one firing. */
export function triggerRecipients(
  trigger: InjectorTrigger,
  reachedIds: number[],
  liveIds: number[],
): number[] {
  if (trigger.target === "reached") return reachedIds;
  return liveIds.filter((id) => trigger.watchIds.includes(id));
}
