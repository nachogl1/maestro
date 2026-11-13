import type { WorkJournalCandidateSource } from "@/stores/useWorkJournalCandidatesStore";

/**
 * Where a Work Journal entry card came from: a suggestion's source, or
 * `typed` for a card made by hand with "+ Add entry".
 */
export type WorkJournalEntrySource = WorkJournalCandidateSource | "typed";

/** The source of a card made by hand. */
export const TYPED_ENTRY_SOURCE = "typed";

/**
 * What a new entry card holds: its time (`HH:MM`, or null for an untimed
 * meeting), project (folder name, or null for none), source and text.
 */
export interface WorkJournalEntryDraft {
  time: string | null;
  project: string | null;
  source: WorkJournalEntrySource;
  text: string;
}

/** `H:MM` or `HH:MM` on a 24-hour clock. */
const ENTRY_TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * A typed time as `HH:MM` (`9:05` becomes `09:05`), null for a blank one
 * (an untimed entry), or undefined when it is not a time.
 */
export function normalizeEntryTime(raw: string): string | null | undefined {
  const value = raw.trim();
  if (value === "") return null;
  const match = ENTRY_TIME_PATTERN.exec(value);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : undefined;
}

/** The local time of `now` as `HH:MM`. */
export function entryTimeOf(now: Date): string {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/**
 * The entry card an update suggestion rewrites, as it read when the
 * suggestion was made: its time (`HH:MM`, or null), project and text.
 */
export interface WorkJournalEntryTarget {
  time: string | null;
  project: string;
  text: string;
}

/** Text folded to one line, the way the backend reads a card. */
export function oneLine(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}
