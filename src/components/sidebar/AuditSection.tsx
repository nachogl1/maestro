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
 * One plain-language sentence per ALERT sub-kind (`details.kind`), covering
 * every kind the backend emits as of issue #123 (grepped from `src-tauri`:
 * `supervisor.rs`, `allowance_watcher.rs`, `samurai_injector.rs`,
 * `samurai_reconciler.rs`, `samurai_parker.rs`, `samurai_resumer.rs`,
 * `samurai_progress.rs`, `samurai_replicator.rs`, `samurai_completion.rs`).
 * An unlisted (future) sub-kind falls through to the raw key=value summary —
 * never a blank row.
 */
const ALERT_SENTENCES: Record<string, (d: Record<string, unknown>) => string> = {
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
};

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

/** One run's cluster of audit rows, newest-first (see {@link groupByRun}). */
interface AuditRunGroup {
  /** The raw epic string; empty for account-wide rows (e.g. allowance ALERTs). */
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
    label: key || "Account-wide",
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
export function AuditSection() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  const projectPath = activeTab?.projectPath ?? "";

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
      setEvents(result.events.slice().reverse());
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
      "Delete this project's Samurai audit log? It is your oversight record of supervised runs and cannot be recovered.",
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

  return (
    <div className={cardClass}>
      <SectionHeader
        icon={ScrollText}
        label="Samurai Audit"
        iconColor="text-maestro-accent"
        badge={
          events && events.length > 0 ? (
            <span className="rounded-full bg-maestro-accent/20 px-1.5 text-[10px] font-bold text-maestro-accent">
              {events.length}
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
        Supervisor events for this project, newest first.
        {fileSizeBytes > 0 ? ` ${Math.max(1, Math.round(fileSizeBytes / 1024))} KB on disk.` : ""}
      </p>
      {error && <p className="mb-2 text-[11px] text-maestro-red">{error}</p>}
      {events === null ? (
        <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-maestro-muted">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : events.length === 0 ? (
        <p className="px-1 py-2 text-[11px] italic text-maestro-muted">
          No audit events for this project.
        </p>
      ) : (
        // Bounded + scrollable (issue #123): without this, a long-running
        // project's audit rows push the Files card ever further down the
        // Second Brain panel instead of scrolling in place.
        <div data-testid="audit-events" className="max-h-[40vh] space-y-2 overflow-y-auto">
          {groupByRun(events).map((run) => (
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
