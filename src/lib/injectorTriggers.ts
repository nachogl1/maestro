/**
 * Injector triggers: watch some terminals' context usage and send a message
 * automatically when one of them reaches a chosen percent.
 */
import type { InjectorRunResult } from "@/lib/injector";
import {
  isContextAlert,
  MAX_CONTEXT_ALERT_THRESHOLD,
  MIN_CONTEXT_ALERT_THRESHOLD,
} from "@/stores/useContextAlertStore";

/**
 * Who receives a trigger's message when it fires: "reached" is only the
 * terminal(s) that reached the percent, "all" every terminal it watches.
 */
export type InjectorTriggerTarget = "all" | "reached";

/**
 * Which terminals a trigger watches: "all" is every terminal, also ones opened
 * after the trigger was made; "ticked" is the ones ticked in the Injector when
 * it was saved (`watchIds`).
 */
export type InjectorTriggerWatch = "all" | "ticked";

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
  /** What the person called it; empty means "use the message's first words" (`triggerLabel`). */
  name: string;
  watch: InjectorTriggerWatch;
  /** Session ids whose context usage is watched when `watch` is "ticked". */
  watchIds: number[];
  /** Whole percent (1-100) that fires the trigger. */
  threshold: number;
  message: string;
  target: InjectorTriggerTarget;
  /**
   * Watched terminals that already fired and are still at or over the
   * threshold. A terminal leaves this list when its context drops below it
   * (e.g. after /clear or a compact), which re-arms the trigger for it.
   */
  firedIds: number[];
  lastFire: InjectorTriggerFire | null;
}

/** How many of the message's words name a trigger that has no name. */
export const TRIGGER_LABEL_WORDS = 4;

/** The name a trigger is shown by: its own name, else its message's first words. */
export function triggerLabel(trigger: Pick<InjectorTrigger, "name" | "message">): string {
  const name = trigger.name.trim();
  if (name) return name;
  const words = trigger.message.trim().split(/\s+/);
  const head = words.slice(0, TRIGGER_LABEL_WORDS).join(" ");
  return words.length > TRIGGER_LABEL_WORDS ? `${head}…` : head;
}

/** The open terminals (of `liveIds`) a trigger watches right now. */
export function watchedIds(
  trigger: Pick<InjectorTrigger, "watch" | "watchIds">,
  liveIds: number[],
): number[] {
  if (trigger.watch === "all") return liveIds;
  return liveIds.filter((id) => trigger.watchIds.includes(id));
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
  const liveIds = sessions.map((s) => s.id);
  for (const trigger of triggers) {
    const watched = watchedIds(trigger, liveIds);
    const nextFired: number[] = [];
    const reachedIds: number[] = [];
    for (const session of sessions) {
      if (!watched.includes(session.id)) continue;
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
  return watchedIds(trigger, liveIds);
}

/**
 * What is saved to disk for one trigger. Terminal ids are left out on
 * purpose: terminals never survive a restart and their numbers start again
 * from 1, so a saved id would point at an unrelated new terminal.
 */
export interface SavedInjectorTrigger {
  id: string;
  name: string;
  watch: InjectorTriggerWatch;
  threshold: number;
  message: string;
  target: InjectorTriggerTarget;
}

export function toSavedTrigger(trigger: InjectorTrigger): SavedInjectorTrigger {
  const { id, name, watch, threshold, message, target } = trigger;
  return { id, name, watch, threshold, message, target };
}

/**
 * Reads triggers back from the saved file, which may be missing, damaged, from
 * an older version or edited by hand. Entries without a usable id, message or
 * threshold are skipped, a repeated id keeps its first entry, and unknown
 * choices fall back to the safe ones (watch the ticked terminals, send only to
 * the terminal that reached the percent). Every loaded trigger is re-armed and
 * watches no terminal of an earlier launch.
 */
export function parseSavedTriggers(raw: unknown): InjectorTrigger[] {
  if (!Array.isArray(raw)) return [];
  const triggers: InjectorTrigger[] = [];
  for (const entry of raw) {
    const trigger = parseSavedTrigger(entry);
    if (trigger && !triggers.some((t) => t.id === trigger.id)) triggers.push(trigger);
  }
  return triggers;
}

function parseSavedTrigger(entry: unknown): InjectorTrigger | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const { id, name, watch, threshold, message, target } = entry as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (typeof message !== "string" || message.trim() === "") return null;
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) return null;
  return {
    id,
    name: typeof name === "string" ? name : "",
    watch: watch === "all" ? "all" : "ticked",
    watchIds: [],
    threshold: Math.min(
      MAX_CONTEXT_ALERT_THRESHOLD,
      Math.max(MIN_CONTEXT_ALERT_THRESHOLD, Math.round(threshold)),
    ),
    message,
    target: target === "all" ? "all" : "reached",
    firedIds: [],
    lastFire: null,
  };
}
