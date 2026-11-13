import type { WorkJournalEntrySource } from "@/lib/workJournalEntry";
import { WORK_JOURNAL_SOURCE_LABELS } from "@/stores/useWorkJournalCandidatesStore";

const GIT_TAG_COLOR = "border-maestro-orange/50 text-maestro-orange";

/** Source tag colours: one per source, one shared by the whole git family. */
const SOURCE_TAG_COLORS: Record<WorkJournalEntrySource, string> = {
  github: GIT_TAG_COLOR,
  git: GIT_TAG_COLOR,
  pr: GIT_TAG_COLOR,
  issue: GIT_TAG_COLOR,
  claude: "border-maestro-blue/50 text-maestro-blue",
  terminal: "border-maestro-green/50 text-maestro-green",
  granola: "border-maestro-purple/50 text-maestro-purple",
  typed: "border-maestro-border text-maestro-muted",
};

/** For a source tag this build does not know. */
const DEFAULT_TAG_COLOR = "border-maestro-border text-maestro-muted";

/** The tag text per source; a hand-made card says `Typed`. */
const SOURCE_TAG_LABELS: Record<WorkJournalEntrySource, string> = {
  ...WORK_JOURNAL_SOURCE_LABELS,
  typed: "Typed",
};

const KNOWN_SOURCES = new Set<string>(Object.keys(SOURCE_TAG_LABELS));

interface WorkJournalSourceTagProps {
  /** A known source, or any other text (shown as written, in grey). */
  source: string;
  title?: string;
}

/**
 * The small tag saying where an entry came from (Git · commit, Claude,
 * Typed, ...), coloured per source; used by the suggestions box and the
 * entry cards so both read the same.
 */
export function WorkJournalSourceTag({ source, title }: WorkJournalSourceTagProps) {
  const known = KNOWN_SOURCES.has(source) ? (source as WorkJournalEntrySource) : null;
  return (
    <span
      title={title}
      className={`shrink-0 rounded border px-1 text-[10px] ${
        known ? SOURCE_TAG_COLORS[known] : DEFAULT_TAG_COLOR
      }`}
    >
      {known ? SOURCE_TAG_LABELS[known] : source}
    </span>
  );
}
