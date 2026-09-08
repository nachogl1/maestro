import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { ChevronRight, Loader2, RefreshCw, ScrollText, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { samePath } from "@/lib/path";
import {
  type SamuraiAuditEvent,
  type SamuraiAuditEventKind,
  type SamuraiAuditEventPayload,
  samuraiAuditClear,
  samuraiAuditRead,
} from "@/lib/samurai";
import { SAMURAI_ACCOUNT_PROJECT, SAMURAI_ACCOUNT_RUN } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { cardClass, SectionHeader } from "./sectionChrome";

/** How many rows to load/keep — matches the "existing lists" bar (no virtualization). */
const AUDIT_TAIL = 200;

/** Badge tint per audit event kind (sidebar badge palette). */
const KIND_BADGES: Record<SamuraiAuditEventKind, string> = {
  SPAWN: "bg-maestro-green/20 text-maestro-green",
  HANDOFF: "bg-maestro-blue/15 text-maestro-blue",
  PARK: "bg-maestro-purple/20 text-maestro-purple",
  RESUME: "bg-maestro-accent/20 text-maestro-accent",
  COMPLETE: "bg-maestro-green/20 text-maestro-green",
  ALERT: "bg-red-500/15 text-red-400",
  INJECT: "bg-maestro-orange/20 text-maestro-orange",
  KILL: "bg-maestro-red/20 text-maestro-red",
};

/**
 * `kind=allowance_threshold window=5h …` — flat scalars only, zero polish.
 * The instruction excerpt (issue #101) is excluded here: it is a long text
 * block that would drown the one-line summary — the expanded row shows it.
 * Used as the fallback when {@link describeAuditEvent} does not recognize the
 * row's shape (issue #123): every row still shows *something* readable.
 */
function summarizeDetails(details: unknown): string {
  if (details === null || details === undefined) return "";
  if (typeof details === "string") return details;
  if (typeof details === "object") {
    return Object.entries(details as Record<string, unknown>)
      .filter(([k, v]) => v !== null && v !== undefined && typeof v !== "object" && k !== "excerpt")
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
  }
  return String(details);
}

/** Reads a string field off a details object, `null` if absent/wrong type. */
function strField(details: Record<string, unknown>, key: string): string | null {
  const v = details[key];
  return typeof v === "string" ? v : null;
}

/** Reads a number field off a details object, `null` if absent/wrong type. */
function numField(details: Record<string, unknown>, key: string): number | null {
  const v = details[key];
  return typeof v === "number" ? v : null;
}

/** `"2026-08-06T01:20:00Z"` → `"01:20 UTC"`; `null` if unparseable/absent. */
function formatUtcTime(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(11, 16)} UTC`;
}

/**
 * One plain-language sentence per ALERT sub-kind (`details.kind`).
 *
 * The completeness claim is not prose: `AuditSection.test.tsx` holds the
 * grepped list of every kind `src-tauri` emits and asserts each one has an
 * entry here, so adding a kind backend-side fails that test instead of
 * silently shipping a `kind=…` row. An unlisted (future) sub-kind still
 * falls through to the raw key=value summary — never a blank row.
 */
export const ALERT_SENTENCES: Record<string, (d: Record<string, unknown>) => string> = {
  allowance_threshold: (d) => {
    const window = strField(d, "window");
    const value = numField(d, "value");
    const thresholdKind = strField(d, "threshold_kind");
    const resets = formatUtcTime(strField(d, "resets_at"));
    const subject = window ? `${window} usage` : "Usage";
    const valuePart = value !== null ? `hit ${value}%` : "crossed a threshold";
    const thresholdPart = thresholdKind ? ` — ${thresholdKind} wind-down threshold` : "";
    const resetPart = resets ? `; resets ${resets}` : "";
    return `${subject} ${valuePart}${thresholdPart}${resetPart}`;
  },
  no_governing_window: () => "No 5h/7d usage window is reported — nothing to park on",
  allowance_serialize_error: () => "Failed to record a usage reading",
  illegal_transition: (d) => {
    const from = strField(d, "from");
    const to = strField(d, "to");
    const reason = strField(d, "reason");
    const move = from && to ? ` (${from} → ${to})` : "";
    return `Rejected an illegal state transition${move}${reason ? `: ${reason}` : ""}`;
  },
  unexpected_transition_to_working: (d) => {
    const from = strField(d, "from");
    return `Unexpected transition to WORKING${from ? ` from ${from}` : ""}`;
  },
  ack_timeout: () => "Instruction acknowledgement timed out",
  delivery_failed: () => "Instruction delivery failed",
  context_blind: (d) => {
    const ticks = numField(d, "ticks");
    return `Agent appears context-blind${ticks !== null ? ` after ${ticks} ticks` : ""}`;
  },
  reconcile_orphan: () => "Reconciler found an orphaned run",
  reconcile_gh_auth: () => "Reconciler blocked: GitHub authentication issue",
  reconcile_unstartable: (d) => `Reconciler could not start ${strField(d, "epic") ?? "this epic"}`,
  park_no_reset_time: (d) =>
    `Park skipped for ${strField(d, "epic") ?? "this epic"} — no reset time known`,
  resume_run_not_active: () => "Resume skipped — the run is no longer active",
  resume_no_handoff: (d) =>
    `Resume skipped for ${strField(d, "epic") ?? "this epic"} — no handoff file found`,
  handoff_churn: () => "Handoff churn detected",
  circuit_breaker: () => "Circuit breaker tripped",
  successor_spawn_failed: () => "Failed to spawn the successor session",
  spawn_dropped: () => "Spawn dropped",
  successor_no_start: () => "Successor session failed to start",
  submit_retry: () => "Instruction submission retried",
  submit_unconfirmed: () => "Instruction submission unconfirmed",
  launch_test_gate: () => "Launch blocked by the test gate",
  scheduled_launch_gave_up: (d) => {
    const attempts = numField(d, "attempts");
    const error = strField(d, "error");
    return `Scheduled launch gave up${
      attempts !== null ? ` after ${attempts} attempt${attempts === 1 ? "" : "s"}` : ""
    } — held for launch-or-discard${error ? `: ${error}` : ""}`;
  },
  completion_declaration_invalid: (d) => {
    const error = strField(d, "error");
    return `Malformed completion declaration${error ? `: ${error}` : ""}`;
  },
  completion_verification_failed: (d) => {
    const failures = Array.isArray(d.failures) ? d.failures.length : null;
    return `Completion verification failed${
      failures !== null ? ` (${failures} issue${failures === 1 ? "" : "s"})` : ""
    }`;
  },
  order_deviation: () => "Execution order deviation flagged",
  // The highest-signal alert there is: corporate SSO tokens expire mid-run, so
  // every supervised run parks at once and NO resume timer is armed (the
  // condition has no reset time — a human fixes auth and resumes). Carries no
  // fields beyond `kind` (samurai_auth_watch.rs / samurai_parker.rs).
  gh_auth_lost: () =>
    "GitHub authentication was lost — every run parked, and none will resume until you fix `gh auth` and restart them",
  // Reconciler, at app start: the run was interrupted (no live process, no
  // usable handoff) and needs a manual restart.
  reconcile_interrupted: (d) => {
    const epic = strField(d, "epic");
    const prior = numField(d, "prior_generation");
    return `Run ${epic ?? "(unknown)"} was interrupted${
      prior !== null ? ` after gen-${prior}` : ""
    } — resume it manually`;
  },
  // A resume timer fired for a run whose agent did not survive the restart.
  resume_interrupted_restart: (d) =>
    `Resume found run ${strField(d, "epic") ?? "(unknown)"} interrupted by a restart — resume it manually`,
  // Injector: the corrective re-instruction round was exhausted and the
  // instruction's own validation still fails. `failure` names the check.
  handoff_invalid: (d) => invalidInstruction("handoff", d),
  park_invalid: (d) => invalidInstruction("park", d),
  soft_winddown_invalid: (d) => invalidInstruction("soft wind-down", d),
  winddown_allclear_invalid: (d) => invalidInstruction("wind-down all-clear", d),
};

/** Shared wording for the injector's four `*_invalid` ALERTs. */
function invalidInstruction(what: string, d: Record<string, unknown>): string {
  const failure = strField(d, "failure");
  return `The ${what} instruction is still invalid after the corrective round${
    failure ? `: ${failure}` : ""
  }`;
}

/** SPAWN: always renders — a session registering always carries a generation. */
function describeSpawn(event: SamuraiAuditEvent, d: Record<string, unknown>): string {
  const predSession = numField(d, "predecessor_session_id");
  const predGeneration = numField(d, "predecessor_generation");
  const succession =
    predSession !== null || predGeneration !== null
      ? `, successor to session ${predSession ?? "?"} (generation ${predGeneration ?? "?"})`
      : "";
  return `Session spawned — generation ${event.generation}${succession}`;
}

/** HANDOFF: `null` (falls back to raw kv) when `phase` isn't the expected shape. */
function describeHandoff(d: Record<string, unknown>): string | null {
  const phase = strField(d, "phase");
  const from = strField(d, "from");
  if (phase === "requested") return `Handoff requested${from ? ` (leaving ${from})` : ""}`;
  if (phase === "written") {
    const file = strField(d, "handoff_file");
    return `Handoff written${file ? ` — ${file}` : ""}`;
  }
  return null;
}

/** PARK: `null` (falls back to raw kv) when `phase` isn't the expected shape. */
function describePark(d: Record<string, unknown>): string | null {
  const phase = strField(d, "phase");
  const from = strField(d, "from");
  if (phase === "requested") return `Park requested${from ? ` (leaving ${from})` : ""}`;
  if (phase === "parked") return "Session parked";
  return null;
}

/** RESUME: `null` (falls back to raw kv) when there is no recognized trigger. */
function describeResume(d: Record<string, unknown>): string | null {
  const trigger = strField(d, "trigger");
  const predGeneration = numField(d, "predecessor_generation");
  if (trigger === "resume_timer") {
    return `Scheduled resume fired${
      predGeneration !== null ? ` — resuming after generation ${predGeneration}` : ""
    }`;
  }
  return trigger ? `Resumed via ${trigger}` : null;
}

/** COMPLETE: always renders — a run either declares verified or just "completed". */
function describeComplete(d: Record<string, unknown>): string {
  const trigger = strField(d, "trigger");
  if (trigger !== "declared_verified") return "Run completed";
  const issues = Array.isArray(d.issues) ? d.issues.join(", ") : null;
  const pr = d.pr;
  const parts = [
    issues ? `issues ${issues}` : null,
    pr !== undefined && pr !== null ? `PR #${pr}` : null,
  ].filter((p): p is string => p !== null);
  return `Run verified complete${parts.length > 0 ? ` — ${parts.join(", ")}` : ""}`;
}

/** KILL: always renders — every death path names a cause, or falls back generically. */
function describeKill(d: Record<string, unknown>): string {
  const cause = strField(d, "cause");
  switch (cause) {
    case "handoff":
      return "Session ended — handoff completed";
    case "process_died":
      return "Session process died unexpectedly";
    case "user_kill":
      return "Session killed by the user";
    case "run_complete":
      return "Session ended — run complete";
    default:
      return strField(d, "phase") === "killed" ? "Session killed" : "Session ended";
  }
}

/** INJECT: `null` (falls back to raw kv) when `phase` isn't the expected shape. */
function describeInject(d: Record<string, unknown>): string | null {
  const phase = strField(d, "phase");
  const instruction = strField(d, "instruction") ?? "instruction";
  const attempt = numField(d, "attempt");
  if (phase === "delivered") {
    const corrective = d.corrective === true;
    const attemptPart = attempt !== null && attempt > 1 ? ` (attempt ${attempt})` : "";
    return `${corrective ? "Corrective instruction" : "Instruction"} delivered — ${instruction}${attemptPart}`;
  }
  if (phase === "acked") return `Instruction acknowledged — ${instruction}`;
  return null;
}

/**
 * One plain-language sentence per audit row (issue #123): the reader should
 * never have to parse `kind=… window=… threshold_kind=…` to know what
 * happened. Falls back to the raw key=value summary for any row shape this
 * doesn't recognize (older rows, or a future backend addition) so nothing
 * ever renders blank.
 */
function describeAuditEvent(event: SamuraiAuditEvent): string {
  const details =
    event.details && typeof event.details === "object" && !Array.isArray(event.details)
      ? (event.details as Record<string, unknown>)
      : null;
  const d = details ?? {};
  let sentence: string | null;
  switch (event.event) {
    case "SPAWN":
      sentence = describeSpawn(event, d);
      break;
    case "HANDOFF":
      sentence = describeHandoff(d);
      break;
    case "PARK":
      sentence = describePark(d);
      break;
    case "RESUME":
      sentence = describeResume(d);
      break;
    case "COMPLETE":
      sentence = describeComplete(d);
      break;
    case "KILL":
      sentence = describeKill(d);
      break;
    case "INJECT":
      sentence = describeInject(d);
      break;
    case "ALERT": {
      const kind = strField(d, "kind");
      sentence = kind ? (ALERT_SENTENCES[kind]?.(d) ?? null) : null;
      break;
    }
    default:
      sentence = null;
  }
  return sentence ?? summarizeDetails(event.details);
}

/** Time for today's rows, date + time for older ones. */
function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString()
    : d.toLocaleString();
}

/**
 * Expanded replay details for one row (issue #101): every scalar detail as a
 * labelled line, the bounded instruction excerpt as a wrapped block, and the
 * row's identity (full timestamp, epic, generation, session). Old rows
 * without the new fields render whatever they do carry — every field is
 * optional by construction.
 */
function AuditRowDetails({ event }: { event: SamuraiAuditEvent }) {
  const details =
    event.details && typeof event.details === "object" && !Array.isArray(event.details)
      ? (event.details as Record<string, unknown>)
      : null;
  const excerpt = details && typeof details.excerpt === "string" ? details.excerpt : null;
  const totalChars =
    details && typeof details.total_chars === "number" ? details.total_chars : null;
  const excerptChars = excerpt === null ? 0 : [...excerpt].length;
  // The excerpt gets its own block below; total_chars rides in its label.
  const lines = details
    ? Object.entries(details).filter(
        ([key, value]) =>
          key !== "excerpt" && key !== "total_chars" && value !== null && value !== undefined,
      )
    : [];
  return (
    <div className="mb-0.5 ml-3 space-y-1 rounded border-l-2 border-maestro-border bg-maestro-surface/50 px-2 py-1.5 text-[10px]">
      <p className="break-words text-maestro-muted/80">
        {event.ts}
        {event.epic ? ` · epic ${event.epic}` : ""} · gen-{event.generation} · session{" "}
        {event.session_id}
      </p>
      {lines.length > 0 && (
        <dl className="space-y-px">
          {lines.map(([key, value]) => (
            <div key={key} className="flex gap-1.5">
              <dt className="shrink-0 font-semibold text-maestro-muted">{key}</dt>
              <dd className="min-w-0 break-words text-maestro-text">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {details === null && event.details !== null && event.details !== undefined && (
        <p className="break-words text-maestro-text">{JSON.stringify(event.details)}</p>
      )}
      {excerpt !== null && (
        <div>
          <p className="font-semibold text-maestro-muted">
            instruction excerpt
            {totalChars !== null && totalChars > excerptChars
              ? ` (first ${excerptChars} of ${totalChars} chars)`
              : ""}
          </p>
          <p className="whitespace-pre-wrap break-words rounded bg-maestro-bg px-1.5 py-1 font-mono text-maestro-text">
            {excerpt}
          </p>
        </div>
      )}
    </div>
  );
}

function AuditRow({ event }: { event: SamuraiAuditEvent }) {
  const [expanded, setExpanded] = useState(false);
  const badgeCls = KIND_BADGES[event.event] ?? "bg-maestro-muted/15 text-maestro-muted";
  const summary = describeAuditEvent(event);
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] hover:bg-maestro-surface"
        title={`${event.ts}${event.epic ? `\nepic: ${event.epic}` : ""}\n${JSON.stringify(
          event.details ?? {},
          null,
          2,
        )}`}
      >
        <ChevronRight
          size={10}
          className={`shrink-0 text-maestro-muted transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span
          className={`shrink-0 whitespace-nowrap rounded px-1 py-px text-[9px] font-bold tracking-wide ${badgeCls}`}
        >
          {event.event}
        </span>
        <span className="shrink-0 text-maestro-muted">gen-{event.generation}</span>
        <span className="min-w-0 flex-1 truncate text-maestro-text">{summary}</span>
        <span className="shrink-0 text-[10px] text-maestro-muted/70">{formatTs(event.ts)}</span>
      </button>
      {expanded && <AuditRowDetails event={event} />}
    </div>
  );
}

/**
 * The account-wide pseudo-project and pseudo-run (allowance crossings,
 * dropped scheduled launches, written when nothing is supervised) — mirrors
 * `ACCOUNT_PROJECT` / `ACCOUNT_RUN` in
 * `src-tauri/src/core/allowance_watcher.rs`, defined once in the session
 * store and re-exported here, where the audit surfaces consume them. Since
 * issue #139 no audit row is ever written with an empty `epic`; rows
 * predating that still are, and both spellings cluster under the same header.
 */
export { SAMURAI_ACCOUNT_PROJECT, SAMURAI_ACCOUNT_RUN };

/* ── The backend's audit grouping key, mirrored (issue #136 review C5) ── */

/** Longest readable head `bound_slug` keeps — `PROSE_SLUG_MAX` in Rust. */
const SLUG_HEAD_MAX = 24;
/** Longest slug left unhashed — `SLUG_MAX` (head + `-` + 8 hex) in Rust. */
const SLUG_MAX = SLUG_HEAD_MAX + 9;

/**
 * FNV-1a (64-bit), truncated to its low 32 bits as 8 hex digits — byte-for-byte
 * what `samurai_prompts::bound_slug` appends (`fnv1a_64(slug) as u32`, `{:08x}`).
 * Slugs are ASCII by construction, so char codes are the bytes Rust hashes.
 */
function fnv1a32Hex(input: string): string {
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash ^ BigInt(input.charCodeAt(i))) * prime) & mask;
  }
  return (hash & 0xffffffffn).toString(16).padStart(8, "0");
}

/**
 * The group key an audit row's `epic` resolves to — the TS mirror of
 * `samurai_files::audit_key` (`core/samurai_files.rs`), which is what
 * `SamuraiFileGroup.audit_key` and therefore `audit_rows` are counted on.
 *
 * Filtering had compared the RAW `epic` string instead, so the two spellings
 * of one run (`#38` and `38`) never met: a card claimed "37 rows" and then
 * showed none. A PR review's id is already the key; everything else is a run
 * identity string put through the same slug every samurai surface uses —
 * ASCII alphanumerics kept and lowercased, every other run of characters
 * collapsed to one dash, and the result length-bounded with a hash tail so
 * long identities stay inside Windows path limits.
 */
export function samuraiAuditKey(epic: string): string {
  if (epic.startsWith("pr:")) return epic;
  // ASCII-only classes on purpose: Rust keeps `is_ascii_alphanumeric` and
  // treats every other character — accented letters included — as a separator,
  // so case-folding must come AFTER the filter, never before it.
  const slug =
    epic
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "epic";
  if (slug.length <= SLUG_MAX) return slug;
  return `${slug.slice(0, SLUG_HEAD_MAX).replace(/-+$/, "")}-${fnv1a32Hex(slug)}`;
}

/** One run's cluster of audit rows, newest-first (see {@link groupByRun}). */
interface AuditRunGroup {
  /** The raw epic string; empty for pre-#139 account-wide rows. */
  key: string;
  /** Cluster header text. */
  label: string;
  events: SamuraiAuditEvent[];
}

/**
 * Clusters events by run (their `epic` string) so interleaved runs read as
 * separate timelines (issue #123) instead of one shuffled feed. `events` is
 * already newest-first, so a single pass that appends to each key's bucket
 * both preserves newest-first *within* a run and puts the run holding the
 * newest event first *across* runs — no separate sort needed. Rows with no
 * epic (account-wide, e.g. allowance ALERTs) cluster under "Account-wide".
 */
function groupByRun(events: SamuraiAuditEvent[]): AuditRunGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, SamuraiAuditEvent[]>();
  for (const event of events) {
    const key = event.epic || "";
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(event);
  }
  return order.map((key) => ({
    key,
    label: key && key !== SAMURAI_ACCOUNT_RUN ? key : "Account-wide",
    events: buckets.get(key) ?? [],
  }));
}

/**
 * Minimal Samurai audit stream (issue #46, Phase 1): the active project's
 * audit rows newest-first, live-appended from `samurai-audit-event`, with the
 * manual clear (PRD §5.10: the user deletes audit records — human oversight).
 * Issue #101 adds expandable rows: clicking one opens its replay details
 * (instruction excerpts, ACK results, handoff file + WIP commit, spawn
 * triggers) as a readable timeline; the raw JSON stays on the row tooltip.
 * Issue #123 makes the stream readable at a glance: each row's one-line
 * summary is a plain-language sentence (`describeAuditEvent`) rather than raw
 * `key=value` scalars — the raw shape is still one click away in the
 * expander. Rows cluster by run (`groupByRun`), newest run first, so
 * interleaved runs no longer shuffle together, and the row list scrolls in a
 * bounded box instead of pushing the rest of the panel down. Deliberately
 * zero polish otherwise — no filters, no virtualization.
 */
/** Identity of an audit row for de-duplication across the read/stream race. */
function auditRowKey(row: SamuraiAuditEvent): string {
  return `${row.ts} ${row.event} ${row.session_id} ${row.generation} ${row.epic}`;
}

/**
 * The read's rows plus any streamed row the read did not yet contain,
 * newest-first and capped like the read itself.
 */
function mergeAuditRows(
  read: SamuraiAuditEvent[],
  streamed: SamuraiAuditEvent[] | null,
): SamuraiAuditEvent[] {
  if (!streamed || streamed.length === 0) return read;
  const seen = new Set(read.map(auditRowKey));
  const extra = streamed.filter((row) => !seen.has(auditRowKey(row)));
  if (extra.length === 0) return read;
  return [...extra, ...read].slice(0, AUDIT_TAIL);
}

/**
 * Whether a row belongs to the focused group. Rows carry that identity in
 * their `epic`, in whatever spelling their writer used, so both sides go
 * through the backend's own key (finding C5) — except the pre-#139 rows that
 * carry an EMPTY epic and name nothing: those are account-wide by definition
 * (the account log's oldest allowance ALERTs are exactly that shape), and
 * `groupByRun` already headers both spellings as "Account-wide".
 */
function matchesFilter(row: SamuraiAuditEvent, filter: AuditRunFilter): boolean {
  if (row.epic === "") return filter.runId === SAMURAI_ACCOUNT_RUN;
  return samuraiAuditKey(row.epic) === filter.runId;
}

/**
 * A group's slice of the audit stream (issue #140): the Second Brain's per-run
 * / per-PR-review audit row focuses this view instead of opening a second one.
 * `runId` is the group's `audit_key` — the exact key the backend counted its
 * `audit_rows` on: a run's epic SLUG (`38`, never `#38`), or the
 * `pr:<owner/repo>#<number>` id a PR review's rows are stamped with. Rows are
 * matched by putting their own `epic` through {@link samuraiAuditKey}.
 */
export interface AuditRunFilter {
  /** The group's `SamuraiFileGroup.audit_key`, never a raw epic string. */
  runId: string;
  /** The group's label, for the "showing … only" line. */
  label: string;
  /**
   * Which project's audit log holds the group's rows; omitted (the default)
   * reads the active tab's, as this view always did.
   *
   * The override exists because not every group's rows live in the active
   * project's file: the account-wide scope
   * ({@link SAMURAI_ACCOUNT_PROJECT}) has its own, and the allowance ALERTs
   * written there while nothing is supervised had no viewer anywhere — the
   * stream read the active project and dropped every streamed row whose
   * project did not match it, so the rows sat on disk unreachable.
   */
  projectPath?: string;
}

export function AuditSection({
  filter = null,
  onClearFilter,
}: {
  /** Show only this group's rows; null (the default) shows every row. */
  filter?: AuditRunFilter | null;
  onClearFilter?: () => void;
} = {}) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  // The filter's project wins when it names one — the account-wide scope
  // reads its own file, not the active tab's. Reads, the live stream filter
  // and the clear action all key off this one value, so the view can never
  // show one project's rows while clearing another's.
  const projectPath = filter?.projectPath ?? activeTab?.projectPath ?? "";

  // null = loading; rows are kept newest-first.
  const [events, setEvents] = useState<SamuraiAuditEvent[] | null>(null);
  const [fileSizeBytes, setFileSizeBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectPath) {
      setEvents([]);
      setFileSizeBytes(0);
      return;
    }
    try {
      const result = await samuraiAuditRead(projectPath, AUDIT_TAIL);
      const read = result.events.slice().reverse();
      // MERGE, not replace: the live listener attaches before this read
      // resolves, so a row that streamed in meanwhile was overwritten and
      // stayed invisible until a manual refresh — the "live stream, no
      // polling" surface silently dropping a SPAWN or an ALERT.
      setEvents((prev) => mergeAuditRows(read, prev));
      setFileSizeBytes(result.file_size_bytes);
      setError(null);
    } catch (err) {
      setError(String(err));
      setEvents([]);
    }
  }, [projectPath]);

  useEffect(() => {
    setEvents(null);
    refresh();
  }, [refresh]);

  // Live stream: the backend mirrors every appended row to this channel, so
  // no polling. Rows for other projects (and the account-wide pseudo-project
  // when nothing is supervised) are skipped.
  useEffect(() => {
    if (!projectPath) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    listen<SamuraiAuditEventPayload>("samurai-audit-event", (e) => {
      if (!samePath(e.payload.project, projectPath)) return;
      setEvents((prev) => [e.payload.event, ...(prev ?? [])].slice(0, AUDIT_TAIL));
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        // Event system unavailable (tests) — the list still renders from reads.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [projectPath]);

  const handleClear = async () => {
    const confirmed = await ask(
      `Delete the Samurai audit log for ${filter?.projectPath ? filter.label : "this project"}? It is your oversight record of supervised runs and cannot be recovered.`,
      { title: "Clear Audit Log", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    try {
      await samuraiAuditClear(projectPath);
      setEvents([]);
      setFileSizeBytes(0);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  // Issue #140: the Second Brain's per-group audit row focuses this stream on
  // one run / PR review rather than opening a second audit surface
  // (`matchesFilter` decides what belongs to the group).
  const visible =
    events === null || filter === null ? events : events.filter((e) => matchesFilter(e, filter));

  return (
    <div className={cardClass}>
      <SectionHeader
        icon={ScrollText}
        label="Samurai Audit"
        iconColor="text-maestro-accent"
        badge={
          visible && visible.length > 0 ? (
            <span className="rounded-full bg-maestro-accent/20 px-1.5 text-[10px] font-bold text-maestro-accent">
              {visible.length}
            </span>
          ) : undefined
        }
        right={
          <span className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={refresh}
              className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
              aria-label="Refresh audit log"
              title="Reload the audit log"
            >
              <RefreshCw size={12} />
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={!projectPath || !events || events.length === 0}
              className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-red disabled:opacity-40"
              aria-label="Clear audit log"
              title="Delete this project's audit log (asks first)"
            >
              <Trash2 size={12} />
            </button>
          </span>
        }
      />
      <p className="mb-2 text-[11px] text-maestro-muted">
        {filter?.projectPath
          ? `Supervisor events for ${filter.label}, newest first.`
          : "Supervisor events for this project, newest first."}
        {fileSizeBytes > 0 ? ` ${Math.max(1, Math.round(fileSizeBytes / 1024))} KB on disk.` : ""}
      </p>
      {error && <p className="mb-2 text-[11px] text-maestro-red">{error}</p>}
      {filter && (
        <div className="mb-2 flex items-center gap-1.5 text-[11px]">
          <span className="min-w-0 flex-1 truncate text-maestro-accent">
            Showing {filter.label} only
          </span>
          <button
            type="button"
            onClick={onClearFilter}
            aria-label="Clear audit filter"
            className="shrink-0 rounded px-1 py-px text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
          >
            Clear
          </button>
        </div>
      )}
      {visible === null ? (
        <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-maestro-muted">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : visible.length === 0 ? (
        <p className="px-1 py-2 text-[11px] italic text-maestro-muted">
          {filter ? `No audit rows for ${filter.label}.` : "No audit events for this project."}
        </p>
      ) : (
        // Bounded + scrollable (issue #123): without this, a long-running
        // project's audit rows push the Files card ever further down the
        // Second Brain panel instead of scrolling in place.
        <div data-testid="audit-events" className="max-h-[40vh] space-y-2 overflow-y-auto">
          {groupByRun(visible).map((run) => (
            <div key={run.key}>
              <div className="mb-0.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-maestro-muted">
                {run.label}
              </div>
              <div className="space-y-0.5">
                {run.events.map((event, i) => (
                  <AuditRow key={`${event.ts}-${event.session_id}-${i}`} event={event} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
