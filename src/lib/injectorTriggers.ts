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

// --- History: every firing and the follow-up line when context drops again ---

/** How long the History keeps an entry: one week (the backend prunes the same). */
export const TRIGGER_HISTORY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Longest message excerpt a history entry keeps, in characters. */
export const HISTORY_EXCERPT_CHARS = 80;

/** One recipient of a firing; "delivered" means the text reached its terminal. */
export interface TriggerHistoryRecipient {
  name: string;
  delivered: boolean;
  /** Why the send failed; only set when not delivered. */
  error?: string;
}

/** One firing, with every name as it was at firing time. */
export interface TriggerFiringEntry {
  kind: "firing";
  id: string;
  /** Epoch ms. */
  at: number;
  triggerId: string;
  triggerName: string;
  /** The terminal that reached the threshold, and its project. */
  terminal: string;
  project: string;
  /** That terminal's whole context percent when it fired. */
  percent: number;
  excerpt: string;
  recipients: TriggerHistoryRecipient[];
}

/** A recipient's context dropped below the threshold after a firing. */
export interface TriggerFollowUpEntry {
  kind: "follow_up";
  id: string;
  /** Epoch ms. */
  at: number;
  triggerId: string;
  triggerName: string;
  /** The recipient whose context dropped, and its project. */
  terminal: string;
  project: string;
  /** Its whole context percent after the drop. */
  percent: number;
  firingId: string;
  firingAt: number;
  /** The terminal that reached the threshold in that firing. */
  firedBy: string;
}

export type TriggerHistoryEntry = TriggerFiringEntry | TriggerFollowUpEntry;

/** A terminal as a firing saw it. */
export interface HistoryTerminal {
  id: number;
  name: string;
  project: string;
  contextPercent?: number;
}

/**
 * A delivered recipient waiting for its follow-up line. Kept in memory only:
 * terminals never survive a restart.
 */
export interface PendingFollowUp {
  triggerId: string;
  triggerName: string;
  sessionId: number;
  terminal: string;
  project: string;
  threshold: number;
  /**
   * Its context percent when the message arrived (`null` until known). The
   * line is written once its context is below both this and the threshold:
   * for the terminal that reached the threshold that is the re-arm; for
   * another recipient it is a drop from where it was.
   */
  baseline: number | null;
  firingId: string;
  firingAt: number;
  firedBy: string;
}

/** The message's first characters, on one line. */
export function messageExcerpt(message: string): string {
  const flat = message.trim().replace(/\s+/g, " ");
  if (flat.length <= HISTORY_EXCERPT_CHARS) return flat;
  return `${flat.slice(0, HISTORY_EXCERPT_CHARS - 1)}…`;
}

function wholePercent(percent: number | undefined): number {
  return Math.round(percent ?? 0);
}

/**
 * The history entries of one firing (one per terminal that reached the
 * threshold) and the recipients now waiting for a follow-up line (the
 * delivered ones). A recipient's follow-up belongs to its own firing when it
 * reached the threshold itself, else to the first one.
 */
export function firingHistory(input: {
  trigger: Pick<InjectorTrigger, "id" | "name" | "message" | "threshold">;
  reached: HistoryTerminal[];
  recipients: HistoryTerminal[];
  result: InjectorRunResult;
  at: number;
  newId: () => string;
}): { entries: TriggerFiringEntry[]; pending: PendingFollowUp[] } {
  const { trigger, reached, recipients, result, at, newId } = input;
  const triggerName = triggerLabel(trigger);
  const failureOf = (id: number) => result.failures.find((f) => f.sessionId === id);
  const historyRecipients = recipients.map((r): TriggerHistoryRecipient => {
    const failure = failureOf(r.id);
    return failure
      ? { name: r.name, delivered: false, error: failure.error }
      : { name: r.name, delivered: true };
  });
  const entries = reached.map(
    (terminal): TriggerFiringEntry => ({
      kind: "firing",
      id: newId(),
      at,
      triggerId: trigger.id,
      triggerName,
      terminal: terminal.name,
      project: terminal.project,
      percent: wholePercent(terminal.contextPercent),
      excerpt: messageExcerpt(trigger.message),
      recipients: historyRecipients,
    }),
  );
  if (entries.length === 0) return { entries, pending: [] };
  const pending = recipients
    .filter((r) => !failureOf(r.id))
    .map((r): PendingFollowUp => {
      const ownIndex = reached.findIndex((t) => t.id === r.id);
      const firing = entries[Math.max(0, ownIndex)];
      return {
        triggerId: trigger.id,
        triggerName,
        sessionId: r.id,
        terminal: r.name,
        project: r.project,
        threshold: trigger.threshold,
        baseline: r.contextPercent === undefined ? null : wholePercent(r.contextPercent),
        firingId: firing.id,
        firingAt: at,
        firedBy: firing.terminal,
      };
    });
  return { entries, pending };
}

/**
 * Writes a follow-up line for every waiting recipient whose context dropped
 * below the threshold (and below where it was when the message arrived).
 * A closed terminal stops waiting; one with no usage yet keeps waiting.
 */
export function evaluateFollowUps(
  pending: PendingFollowUp[],
  sessions: TriggerSessionView[],
  at: number,
  newId: () => string,
): { entries: TriggerFollowUpEntry[]; pending: PendingFollowUp[]; changed: boolean } {
  const entries: TriggerFollowUpEntry[] = [];
  const remaining: PendingFollowUp[] = [];
  let changed = false;
  for (const p of pending) {
    const session = sessions.find((s) => s.id === p.sessionId);
    if (!session) {
      changed = true;
      continue;
    }
    if (session.contextPercent === undefined) {
      remaining.push(p);
      continue;
    }
    const percent = wholePercent(session.contextPercent);
    if (p.baseline === null) {
      remaining.push({ ...p, baseline: percent });
      changed = true;
      continue;
    }
    if (percent >= Math.min(p.threshold, p.baseline)) {
      remaining.push(p);
      continue;
    }
    changed = true;
    entries.push({
      kind: "follow_up",
      id: newId(),
      at,
      triggerId: p.triggerId,
      triggerName: p.triggerName,
      terminal: p.terminal,
      project: p.project,
      percent,
      firingId: p.firingId,
      firingAt: p.firingAt,
      firedBy: p.firedBy,
    });
  }
  return { entries, pending: remaining, changed };
}

/** One terminal's lines on one day of the History list. */
export interface TriggerHistoryGroup {
  terminal: string;
  project: string;
  /** Oldest first, so a follow-up line reads under its firing. */
  entries: TriggerHistoryEntry[];
}

/** One day of the History list. */
export interface TriggerHistoryDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  key: string;
  /** Epoch ms of the day's newest entry, for its heading. */
  at: number;
  /** The terminal with the newest line first. */
  groups: TriggerHistoryGroup[];
}

function localDayKey(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The History list: the last week's entries (of one trigger, or of all when
 * `triggerId` is null), grouped by day, newest first, then by the terminal
 * the line is about (with its project), the terminal with the newest line
 * first.
 */
export function groupTriggerHistory(
  entries: TriggerHistoryEntry[],
  options: { now: number; triggerId: string | null },
): TriggerHistoryDay[] {
  const kept = entries
    .filter((e) => e.at >= options.now - TRIGGER_HISTORY_KEEP_MS)
    .filter((e) => options.triggerId === null || e.triggerId === options.triggerId)
    .sort((a, b) => b.at - a.at);
  const days: TriggerHistoryDay[] = [];
  for (const entry of kept) {
    const key = localDayKey(entry.at);
    let day = days.find((d) => d.key === key);
    if (!day) {
      day = { key, at: entry.at, groups: [] };
      days.push(day);
    }
    let group = day.groups.find(
      (g) => g.terminal === entry.terminal && g.project === entry.project,
    );
    if (!group) {
      group = { terminal: entry.terminal, project: entry.project, entries: [] };
      day.groups.push(group);
    }
    group.entries.unshift(entry);
  }
  return days;
}

/** Reads the history the backend returned; anything not shaped like an entry is left out. */
export function parseTriggerHistory(raw: unknown): TriggerHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is TriggerHistoryEntry => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    const shaped =
      typeof e.id === "string" &&
      typeof e.at === "number" &&
      typeof e.triggerId === "string" &&
      typeof e.terminal === "string" &&
      typeof e.project === "string";
    if (e.kind === "follow_up") return shaped;
    return (
      shaped &&
      e.kind === "firing" &&
      Array.isArray(e.recipients) &&
      e.recipients.every((r) => typeof r === "object" && r !== null && typeof r.name === "string")
    );
  });
}
