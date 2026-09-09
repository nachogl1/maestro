import { ask } from "@tauri-apps/plugin-dialog";
import {
  ChevronRight,
  Eraser,
  Eye,
  Files,
  FileText,
  Loader2,
  RefreshCw,
  ScrollText,
  TimerOff,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MarkdownBody } from "@/components/git/shared/MarkdownBody";
import { HealthReasonLines } from "@/components/shared/HealthReasonLines";
import type { HealthFlag } from "@/lib/healthRules";
import { formatResumeAt, useCountdownNow } from "@/lib/parkTime";
import { samePath } from "@/lib/path";
import {
  isSamuraiInUseError,
  type SamuraiFileEntry,
  type SamuraiFileGroup,
  type SamuraiFileKind,
  type SamuraiFilesListing,
  samuraiCleanupEpic,
  samuraiFileDelete,
  samuraiFileRead,
  samuraiFilesList,
  samuraiHarvestRead,
  samuraiTimerCancel,
} from "@/lib/samurai";
import { resumeRunNow } from "@/lib/samuraiResume";
import { flagsByRow, useHealthStore } from "@/stores/useHealthStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { type AuditRunFilter, AuditSection, SAMURAI_ACCOUNT_PROJECT } from "./AuditSection";
import { JournalSection } from "./JournalSection";
import { cardClass, SectionHeader } from "./sectionChrome";

/**
 * What a row IS, as a small per-row tag (issue #140). Deliberately never a
 * section header: rows group by the run or PR review they belong to, and a
 * kind header would put the plumbing back above the work.
 */
const KIND_TAGS: Record<SamuraiFileKind, string> = {
  BRIEF: "brief",
  HANDOFF: "handoff",
  RUN_CONFIG: "config",
  PR_REVIEW_RUN: "record",
  TIMER: "timer",
  AUDIT_LOG: "audit",
  JOURNAL: "journal",
  HARVEST_REPORT: "harvest",
};

/**
 * The row's kind tag. Falls back to the kind itself, readably spaced, for any
 * kind added backend-side after this map (issue #136 review C8): the tag is
 * the only "what is this" signal a row carries, so it must never be blank.
 */
function kindTag(kind: SamuraiFileKind): string {
  const tag: string | undefined = KIND_TAGS[kind];
  return tag ?? kind.toLowerCase().replace(/_/g, " ");
}

/**
 * Kinds whose row is a per-group SLICE of one file every card shares — the
 * project audit log, the ops journal, and the single pending-timer schedule.
 * Their `size_bytes` is the WHOLE file's, and deleting one would destroy
 * every other group's rows, so they are excluded from both the header's size
 * and the row delete action (issue #136 review C2, C3).
 */
const SHARED_FILE_KINDS: ReadonlySet<SamuraiFileKind> = new Set<SamuraiFileKind>([
  "AUDIT_LOG",
  "JOURNAL",
  "TIMER",
]);

/** Last path segment, for compact file/project display. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Row display name. TIMER rows all share `schedule.json` as their path and
 * RUN_CONFIG filenames are slugs, so those show the epic; everything else
 * shows the basename (handoff names already carry epic + generation).
 */
function rowLabel(entry: SamuraiFileEntry): string {
  if ((entry.kind === "TIMER" || entry.kind === "RUN_CONFIG") && entry.epic) return entry.epic;
  return baseName(entry.path);
}

/**
 * "3 KB" / "1.2 MB" — same rounding bar as the audit size line (min 1 KB for
 * anything non-empty). Nothing is exactly "0 KB", so that reading is reserved
 * for genuinely zero bytes rather than rounded up to a byte that is not there
 * (issue #136 review C6).
 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes <= 0) return "0 KB";
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * "1 file · 4 KB" / "6 files · 84 KB" — a card header's own reading. The size
 * counts only the files this group OWNS: a slice row reports the whole shared
 * file's size, so summing those put the same megabytes on every card and told
 * the user this run had produced them (issue #136 review C3).
 */
function groupSummary(entries: SamuraiFileEntry[]): string {
  const bytes = entries.reduce(
    (total, entry) => (SHARED_FILE_KINDS.has(entry.kind) ? total : total + entry.size_bytes),
    0,
  );
  return `${entries.length} file${entries.length === 1 ? "" : "s"} · ${formatSize(bytes)}`;
}

/** Rough age from an RFC 3339 modified time; empty when unknown. */
function formatAge(modifiedAt: string | null): string {
  if (!modifiedAt) return "";
  const then = new Date(modifiedAt).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * How the viewer renders a file, picked from its extension alone (issue #82).
 * `.jsonl` deliberately falls through to `text`: it is one JSON object per
 * line, so parsing the file as a whole would always fail and pretty-printing
 * it line by line would destroy the append-order reading that makes an audit
 * log or the journal legible.
 */
type ViewerFormat = "markdown" | "json" | "text";

function viewerFormat(path: string): ViewerFormat {
  const name = baseName(path).toLowerCase();
  if (name.endsWith(".md")) return "markdown";
  if (name.endsWith(".json")) return "json";
  return "text";
}

/** Pretty-prints JSON; hands back the raw text untouched when it does not parse. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * TIMER rows: "resumes at 06/08/2026, 14:32 · in 6d 3h 12m". Always dated —
 * a 7-day-window park showed a bare `HH:MM` and read as "this afternoon".
 * A stamp that does not parse still says the row is parked, without a time.
 */
function formatFireAt(fireAt: string, now: number): string {
  const resume = formatResumeAt(fireAt, now);
  return resume === null ? "parked" : `resumes at ${resume}`;
}

/**
 * The row's right-hand reading. TIMER rows count down; the two SLICE rows
 * (audit, journal) report their group's own count rather than the shared
 * file's size, which says nothing about this run (issue #140 requirement 4).
 */
function rowMeta(entry: SamuraiFileEntry, group: SamuraiFileGroup, now: number): string {
  if (entry.kind === "TIMER" && entry.fire_at) return formatFireAt(entry.fire_at, now);
  if (entry.kind === "AUDIT_LOG") return `${group.audit_rows} rows`;
  if (entry.kind === "JOURNAL") return `${group.journal_entries} entries`;
  return [formatSize(entry.size_bytes), formatAge(entry.modified_at)].filter(Boolean).join(" · ");
}

function FileRow({
  entry,
  group,
  now,
  onOpen,
  onDelete,
  onCancelTimer,
  onCleanEpic,
  onShowAudit,
  busy,
  healthFlags,
}: {
  entry: SamuraiFileEntry;
  /** The run / PR review this row belongs to — its counts and label. */
  group: SamuraiFileGroup;
  /** Ticking clock behind a TIMER row's countdown (see `useCountdownNow`). */
  now: number;
  /** Every row: open this file in the read-only viewer (issue #82). */
  onOpen: (entry: SamuraiFileEntry) => void;
  /** Absent on TIMER rows — a timer is cancelled, never file-deleted. */
  onDelete: ((entry: SamuraiFileEntry) => void) | null;
  /** TIMER rows only: cancel this epic's pending resume. */
  onCancelTimer: ((entry: SamuraiFileEntry) => void) | null;
  /** Present only on rows offering the one-click epic cleanup. */
  onCleanEpic: ((entry: SamuraiFileEntry) => void) | null;
  /** AUDIT_LOG rows only: focus the audit view on this group (issue #140). */
  onShowAudit: ((entry: SamuraiFileEntry) => void) | null;
  busy: boolean;
  /** Size warnings the health checker raised against this file (issue #67). */
  healthFlags?: HealthFlag[];
}) {
  const label = rowLabel(entry);
  const meta = rowMeta(entry, group, now);
  return (
    <div>
      <div
        className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-maestro-surface"
        title={`${entry.path}${entry.project_path ? `\nproject: ${entry.project_path}` : ""}${entry.epic ? `\nepic: ${entry.epic}` : ""}`}
      >
        <span className="w-12 shrink-0 truncate text-[10px] font-medium text-maestro-muted/70">
          {kindTag(entry.kind)}
        </span>
        {entry.in_use && (
          <span className="shrink-0 whitespace-nowrap rounded bg-amber-500/15 px-1 py-px text-[9px] font-bold tracking-wide text-amber-500">
            IN USE
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-maestro-text">
          {label}
          {entry.project_path ? (
            <span className="text-maestro-muted"> · {baseName(entry.project_path)}</span>
          ) : null}
        </span>
        {/* Dated resume readings are long — the meta truncates (with the full
            text on hover) instead of pushing the row's actions off the edge. */}
        <span className="min-w-0 shrink truncate text-[10px] text-maestro-muted/70" title={meta}>
          {meta}
        </span>
        <button
          type="button"
          onClick={() => onOpen(entry)}
          disabled={busy}
          className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text disabled:opacity-40"
          aria-label={`Open ${label}`}
          title="View this file (read-only)"
        >
          <Eye size={12} />
        </button>
        {onShowAudit && (
          <button
            type="button"
            onClick={() => onShowAudit(entry)}
            disabled={busy}
            className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text disabled:opacity-40"
            aria-label={`Show audit rows for ${group.label}`}
            title="Show only this group's rows in the audit stream above"
          >
            <ScrollText size={12} />
          </button>
        )}
        {onCleanEpic && (
          <button
            type="button"
            onClick={() => onCleanEpic(entry)}
            disabled={busy}
            className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-red disabled:opacity-40"
            aria-label={`Clean up run ${entry.epic}`}
            title="Delete this run's worktree and branch, cancel its timer, archive its run config (asks first)"
          >
            <Eraser size={12} />
          </button>
        )}
        {onCancelTimer && (
          <button
            type="button"
            onClick={() => onCancelTimer(entry)}
            disabled={busy}
            className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-red disabled:opacity-40"
            aria-label={`Cancel resume timer for ${entry.epic}`}
            title="Cancel this pending resume — the parked run will not resume on its own (asks first)"
          >
            <TimerOff size={12} />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(entry)}
            disabled={busy}
            className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-red disabled:opacity-40"
            aria-label={`Delete ${label}`}
            title="Delete this file (asks first)"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      {healthFlags && (
        <div className="pb-0.5 pl-5 pr-1">
          <HealthReasonLines flags={healthFlags} />
        </div>
      )}
    </div>
  );
}

/**
 * Fixed overlay showing one Samurai file, read-only — generalised from the
 * #71 harvest-report viewer to every kind the Files card lists (issue #82).
 * Same overlay chrome as FileDiffModal, minus the outside-click machinery —
 * close button and Escape only.
 *
 * Strictly a viewer: no edit, no save, no open-in-external-app. Removing a
 * file stays the row's delete/cancel action, with its own confirms.
 */
function FileViewerModal({ entry, onClose }: { entry: SamuraiFileEntry; onClose: () => void }) {
  // null = loading.
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const format = viewerFormat(entry.path);

  useEffect(() => {
    let cancelled = false;
    // Harvest reports keep their own dedicated command (issue #71): its
    // containment is the narrower of the two — the harvest directory alone,
    // with no dependence on the inventory snapshot — so there is nothing to
    // gain by widening them onto the general read.
    const read = entry.kind === "HARVEST_REPORT" ? samuraiHarvestRead : samuraiFileRead;
    read(entry.path)
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((err) => {
        // Every backend refusal — vanished since the listing, not a managed
        // file, over the 2 MB cap, OS read failure — is already a readable
        // sentence. Show it in place, verbatim; never crash the panel.
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [entry.path, entry.kind]);

  // Close on Escape — same listener shape as FileDiffModal.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-[36rem] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-maestro-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileText size={14} className="shrink-0 text-maestro-muted" />
            <span className="truncate text-sm font-medium text-maestro-text">
              {baseName(entry.path)}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close file viewer"
            className="shrink-0 rounded p-1 text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-4">
          {error ? (
            <p className="text-[11px] text-maestro-red">{error}</p>
          ) : content === null ? (
            <div className="flex items-center gap-2 text-[11px] text-maestro-muted">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : format === "markdown" ? (
            // allowRawHtml={false}: this is model output (harvest reports) or
            // text ANY local process can write (handoffs) — raw HTML in it
            // must never become live elements in this invoke-capable webview.
            <MarkdownBody content={content} allowRawHtml={false} />
          ) : (
            // Wrapped at whitespace, with a horizontal scroll left for the
            // unbreakable long lines JSONL rows are made of.
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-maestro-text">
              {format === "json" ? prettyJson(content) : content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Second Brain panel body (issue #66, PRD §5.11): the Samurai audit stream on
 * top (the Phase 1 AuditSection absorbed as-is), the ops journal card
 * (issue #71, PRD §5.12) and below them the Files
 * section — every managed resource from `samurai_files_list`, one collapsible
 * card per RUN or PR REVIEW (issue #140) in the backend's order (live pinned
 * first, then newest first), with the kind as a per-row tag, a read-only view
 * per row (issue #82), delete-with-confirm per row (in-use files get a second,
 * harder confirm before force-deleting; TIMER rows get a cancel-timer action
 * instead of delete), and one-click "clean this epic" on run configs without
 * a live supervised session. Deliberately minimal per the PRD: list, read,
 * delete, warn — no file-manager ambitions, and nothing here ever writes to a
 * managed file.
 */
export function SecondBrainSection() {
  // null = loading.
  const [listing, setListing] = useState<SamuraiFilesListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The file shown in the read-only viewer overlay; null = closed (issue #82).
  const [openFile, setOpenFile] = useState<SamuraiFileEntry | null>(null);
  // Group ids the user collapsed — remembered per group for the session
  // (issue #140 requirement 2); cards default to expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  // The group the audit stream above is focused on; null = every row.
  const [auditFilter, setAuditFilter] = useState<AuditRunFilter | null>(null);

  // Which project's audit log the AuditSection above is reading — the gate on
  // the per-group audit action (review finding C1).
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeProjectPath = tabs.find((t) => t.active)?.projectPath ?? "";

  const files = listing?.entries ?? null;

  /**
   * How many FILES the panel manages. Not `entries.length`: since issue #139
   * the shared audit log and journal contribute one row PER GROUP, so a badge
   * counting rows grew with the number of runs while the disk did not (review
   * finding C7).
   */
  const distinctFileCount = new Set((files ?? []).map((entry) => entry.path)).size;

  // Ticking clock for the TIMER rows' countdowns — armed only while a pending
  // timer is actually listed.
  const hasTimer = (files ?? []).some((f) => f.kind === "TIMER" && f.fire_at);
  const now = useCountdownNow(hasTimer);

  /* ── Health checker flags (rule-based, read-only) — issue #67 ── */
  const allHealthFlags = useHealthStore((s) => s.flags);
  const healthRows = useMemo(() => flagsByRow(allHealthFlags, "secondbrain"), [allHealthFlags]);

  const refresh = useCallback(async () => {
    try {
      setListing(await samuraiFilesList());
      setError(null);
    } catch (err) {
      setListing({ groups: [], entries: [] });
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDelete = async (entry: SamuraiFileEntry) => {
    const label = rowLabel(entry);
    // Destructive, never silent (PRD §5.11) — same ask() pattern as the
    // audit clear and epic cleanup.
    const confirmed = await ask(
      `Delete ${label}? This removes the file from disk and cannot be undone.`,
      { title: "Delete Samurai File", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await samuraiFileDelete(entry.path, false);
      setNotice(`Deleted ${label}.`);
      await refresh();
    } catch (err) {
      if (isSamuraiInUseError(err)) {
        // The backend refused: the file is referenced by an active run. Only
        // an explicit second, harder confirmation may force-delete it.
        const forced = await ask(
          `DANGER: ${label} is referenced by an ACTIVE run (a live supervised session, an active run config, or a pending resume timer). Force-deleting it can break that run mid-flight. Are you absolutely sure?`,
          { title: "File In Use — Force Delete?", kind: "error" },
        ).catch(() => false);
        if (forced) {
          try {
            await samuraiFileDelete(entry.path, true);
            setNotice(`Force-deleted ${label}.`);
            await refresh();
          } catch (err2) {
            setError(String(err2));
          }
        }
      } else {
        setError(String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCancelTimer = async (entry: SamuraiFileEntry) => {
    if (!entry.epic || !entry.project_path) return;
    // Not a file delete: deleting schedule.json would neither stop the
    // in-memory timer nor scope to one epic (the backend refuses it).
    //
    // Issue #211: this used to be one confirm with one outcome, and that
    // outcome left the run stopped for GOOD — relaunching was the only way
    // back and the preflight rightly refuses that while the run is ACTIVE.
    // It is now the two-way choice it always should have been. Two dialogs
    // rather than a single relabelled one, and asked in this order, because
    // a native dialog has exactly two buttons and DISMISS maps to the
    // second: every dismissal here must be a no-op, and the timer is not
    // cancelled until the very last answer. A dialog plugin that throws
    // takes the same safe path (`.catch(() => false)`), so a broken dialog
    // can never cancel a timer by itself.
    const resumeNow = await ask(
      `Cancel the pending resume for ${entry.epic} and resume the run NOW? That cancels its timer and spawns a fresh agent immediately. Choose No to decide whether to cancel the timer and leave the run stopped.`,
      {
        title: "Cancel Resume Timer",
        kind: "warning",
        okLabel: "Cancel and resume now",
        cancelLabel: "No",
      },
    ).catch(() => false);

    // Declined the resume: the other way forward, with the consequence
    // named. Dismissing THIS one keeps the timer exactly as it was.
    const cancelOnly =
      !resumeNow &&
      (await ask(
        `Cancel the timer and leave ${entry.epic} parked? The run will NOT resume on its own — you would have to relaunch it. Dismiss to keep the timer.`,
        {
          title: "Cancel and Stay Parked?",
          kind: "warning",
          okLabel: "Cancel and stay parked",
          cancelLabel: "Keep the timer",
        },
      ).catch(() => false));
    if (!resumeNow && !cancelOnly) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (resumeNow) {
        // The resume cancels the timer itself, so this is ONE command, not
        // a cancel followed by a resume.
        const result = await resumeRunNow(entry.project_path, entry.epic);
        setNotice(
          result === null
            ? `Left ${entry.epic} parked — its resume timer is untouched.`
            : `Resuming ${entry.epic}: gen-${result.generation} on ${result.branch} @ ${result.head}.`,
        );
      } else {
        const cancelled = await samuraiTimerCancel(entry.project_path, entry.epic);
        setNotice(
          cancelled
            ? `Cancelled the resume timer for ${entry.epic}. It will NOT resume on its own.`
            : `No pending resume timer for ${entry.epic}.`,
        );
      }
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCleanEpic = async (entry: SamuraiFileEntry) => {
    if (!entry.epic || !entry.project_path) return;
    // Same confirm + report wording as LaunchSection's active-run cleanup.
    const confirmed = await ask(
      `Clean up run ${entry.epic}? This deletes its worktree and samurai branch, cancels its resume timer, and archives its run config. It cannot be undone.`,
      { title: "Clean Up Run", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const report = await samuraiCleanupEpic(entry.project_path, entry.epic);
      const removed = [
        report.worktree_removed ? "worktree" : null,
        report.branch_deleted ? `branch ${report.branch}` : null,
        report.config_archived ? "run config" : null,
        report.timer_cancelled ? "resume timer" : null,
      ].filter(Boolean);
      setNotice(
        removed.length > 0
          ? `Cleaned up run ${report.epic}: removed ${removed.join(", ")}.`
          : `Run ${report.epic} was already clean.`,
      );
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * The cards to render, in the backend's order — live pinned first, then
   * newest `created_at` first (`samurai_files.rs` sorts; this never re-sorts).
   * Search (requirement 5) matches the group LABEL or a file NAME: a label
   * hit keeps the whole card, a file hit keeps the card with the matching
   * rows alone.
   */
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (listing?.groups ?? []).flatMap((group) => {
      const own = (listing?.entries ?? []).filter((entry) => entry.group_id === group.id);
      if (needle === "" || group.label.toLowerCase().includes(needle)) {
        return [{ group, own, shown: own, fileMatch: false }];
      }
      const shown = own.filter((entry) => rowLabel(entry).toLowerCase().includes(needle));
      return shown.length > 0 ? [{ group, own, shown, fileMatch: true }] : [];
    });
  }, [listing, query]);

  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  /**
   * Focus the audit stream on one group (requirement 4), keyed on the exact
   * value the backend counted the group's `audit_rows` on — the epic slug for
   * a run, the `pr:` id for a PR review. Filtering on the raw epic string
   * instead let a card claim N rows and then show none (review finding C5).
   */
  const showGroupAudit = (group: SamuraiFileGroup) =>
    setAuditFilter({
      runId: group.audit_key,
      label: group.label,
      // The account-wide scope's rows live in their OWN audit file, not the
      // active project's — so the stream is pointed at that pseudo-project.
      // Every other group's rows are in the file the view already reads
      // (`groupAuditIsReadable` gates on exactly that), so no override.
      projectPath: isAccountGroup(group) ? SAMURAI_ACCOUNT_PROJECT : undefined,
    });

  /**
   * Whether this group's rows are ones `AuditSection` can read. That view
   * loads the ACTIVE tab's project audit log by default, while the Files
   * panel lists groups from every project — including a cleaned project's
   * run, which has no project path left at all. Offering the audit action on
   * such a group focused a stream that could never hold its rows ("No audit
   * rows for X" under a header claiming N of them), so it is offered only
   * where it can tell the truth (review finding C1).
   *
   * The account-wide scope is the one group that lives on its own
   * pseudo-path with its own file, and it was refused here for that reason —
   * which left the allowance-threshold ALERTs written there (every crossing
   * that happened with nothing supervised) with no viewer in the app at all.
   * It is offered now: the filter carries the pseudo-project and the stream
   * reads THAT file.
   */
  const isAccountGroup = (group: SamuraiFileGroup) =>
    group.project_path === SAMURAI_ACCOUNT_PROJECT;

  const groupAuditIsReadable = (group: SamuraiFileGroup) =>
    isAccountGroup(group) ||
    (group.project_path !== null &&
      activeProjectPath !== "" &&
      samePath(group.project_path, activeProjectPath));

  // TIMER rows all share schedule.json as their path — a file's health
  // reasons render only under the FIRST row bearing that path (the badge
  // already counts each flag exactly once). Rebuilt every render.
  const seenFlagPaths = new Set<string>();

  return (
    <div className="space-y-3">
      <AuditSection filter={auditFilter} onClearFilter={() => setAuditFilter(null)} />

      {/* Issue #98: harvest opens an interactive session — no report row
          lands in this inventory anymore, so no refresh callback. */}
      <JournalSection />

      <div className={cardClass}>
        <SectionHeader
          icon={Files}
          label="Files"
          iconColor="text-maestro-accent"
          badge={
            distinctFileCount > 0 ? (
              <span className="rounded-full bg-maestro-accent/20 px-1.5 text-[10px] font-bold text-maestro-accent">
                {distinctFileCount}
              </span>
            ) : undefined
          }
          right={
            <button
              type="button"
              onClick={refresh}
              className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
              aria-label="Refresh files"
              title="Reload the file inventory"
            >
              <RefreshCw size={12} />
            </button>
          }
        />
        <p className="mb-2 text-[11px] text-maestro-muted">
          Every Samurai-managed file, under the run or PR review it came from. Viewing is read-only;
          deleting always asks and in-use files ask twice.
        </p>
        {error && <p className="mb-2 text-[11px] text-maestro-red">{error}</p>}
        {notice && <p className="mb-2 text-[11px] text-maestro-green">{notice}</p>}
        {listing !== null && listing.groups.length > 0 && (
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search runs and files"
            placeholder="Search runs, PR reviews and files…"
            className="mb-2 w-full rounded border border-maestro-border/60 bg-maestro-bg px-1.5 py-1 text-[11px] text-maestro-text placeholder:text-maestro-muted/60"
          />
        )}
        {listing === null ? (
          <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-maestro-muted">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        ) : listing.groups.length === 0 ? (
          // No kind list to show as empty, and deliberately no System/Other
          // card: a group is a run or a PR review, or it does not exist.
          <p className="px-1 py-2 text-[11px] italic text-maestro-muted">
            No runs or PR reviews yet.
          </p>
        ) : visibleGroups.length === 0 ? (
          <p className="px-1 py-2 text-[11px] italic text-maestro-muted">
            No run or PR review matches this search.
          </p>
        ) : (
          <div className="max-h-[45vh] overflow-y-auto space-y-2">
            {visibleGroups.map(({ group, own, shown, fileMatch }) => {
              // A card matched by a FILE NAME opens itself, so the hit is
              // never hidden behind a collapsed header (requirement 5). A
              // card matched by its LABEL keeps the user's collapse: forcing
              // every searched card open left the header's toggle flipping
              // `aria-expanded` while nothing moved (review finding C4).
              const expanded = fileMatch || !collapsed.has(group.id);
              return (
                <div key={group.id} data-testid="file-group">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id)}
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] hover:bg-maestro-surface"
                    title={group.project_path ?? undefined}
                  >
                    <ChevronRight
                      size={10}
                      className={`shrink-0 text-maestro-muted transition-transform ${expanded ? "rotate-90" : ""}`}
                    />
                    <span
                      data-testid="file-group-label"
                      className="min-w-0 flex-1 truncate font-medium text-maestro-text"
                    >
                      {group.label}
                    </span>
                    {group.is_live && (
                      <span className="shrink-0 whitespace-nowrap rounded bg-maestro-green/20 px-1 py-px text-[9px] font-bold tracking-wide text-maestro-green">
                        LIVE
                      </span>
                    )}
                    <span className="shrink-0 whitespace-nowrap text-[10px] text-maestro-muted/70">
                      {groupSummary(own)}
                    </span>
                  </button>
                  {expanded && (
                    <div className="space-y-0.5 pl-3">
                      {shown.map((entry, i) => {
                        const firstForPath = !seenFlagPaths.has(entry.path);
                        seenFlagPaths.add(entry.path);
                        return (
                          <FileRow
                            key={`${entry.path}-${entry.epic ?? ""}-${i}`}
                            entry={entry}
                            group={group}
                            now={now}
                            healthFlags={
                              firstForPath
                                ? healthRows.get(`${entry.path}|${baseName(entry.path)}`)
                                : undefined
                            }
                            // Every kind is readable in place (issue #82) —
                            // the viewer picks its renderer per extension.
                            onOpen={setOpenFile}
                            // No plain delete on a shared file: a TIMER row is
                            // cancelled instead (schedule.json self-cleans and
                            // the backend refuses deleting it — review F1),
                            // and an AUDIT_LOG / JOURNAL row is this group's
                            // SLICE of a file every other card shares, so
                            // "delete this file" would wipe their rows too
                            // (review finding C2). Clearing the audit log
                            // stays its own action, on the audit card that
                            // says what it destroys.
                            onDelete={SHARED_FILE_KINDS.has(entry.kind) ? null : handleDelete}
                            onCancelTimer={
                              entry.kind === "TIMER" && entry.epic && entry.project_path
                                ? handleCancelTimer
                                : null
                            }
                            onCleanEpic={
                              // One-click epic cleanup wherever it can work:
                              // the backend refuses cleanup only while a live
                              // session exists, so gate on that alone — a
                              // completed run's config stays ACTIVE (in_use)
                              // until archive-at-completion lands with the
                              // COMPLETE event emission, and must still be
                              // cleanable (review F2).
                              entry.kind === "RUN_CONFIG" &&
                              entry.epic &&
                              entry.project_path &&
                              !entry.has_live_session
                                ? handleCleanEpic
                                : null
                            }
                            onShowAudit={
                              entry.kind === "AUDIT_LOG" && groupAuditIsReadable(group)
                                ? () => showGroupAudit(group)
                                : null
                            }
                            busy={busy}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {openFile && <FileViewerModal entry={openFile} onClose={() => setOpenFile(null)} />}
    </div>
  );
}
