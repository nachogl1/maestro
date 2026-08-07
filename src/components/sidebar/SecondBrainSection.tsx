import { ask } from "@tauri-apps/plugin-dialog";
import { Eraser, Eye, Files, Loader2, RefreshCw, Sparkles, TimerOff, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { HealthFlag } from "@/lib/healthRules";
import {
  isSamuraiInUseError,
  samuraiCleanupEpic,
  samuraiFileDelete,
  samuraiFilesList,
  samuraiHarvestRead,
  samuraiTimerCancel,
  type SamuraiFileEntry,
  type SamuraiFileKind,
} from "@/lib/samurai";
import { MarkdownBody } from "@/components/git/shared/MarkdownBody";
import { HealthReasonLines } from "@/components/shared/HealthReasonLines";
import { flagsByRow, useHealthStore } from "@/stores/useHealthStore";
import { AuditSection } from "./AuditSection";
import { JournalSection } from "./JournalSection";
import { cardClass, SectionHeader } from "./sectionChrome";

/**
 * Display order + labels for the file groups (PRD §8 rows 1–5). Journal and
 * harvest reports only exist from Phase 5, so their groups stay hidden until
 * files actually appear; the other groups show an empty hint instead.
 */
const GROUPS: { kind: SamuraiFileKind; label: string; hideWhenEmpty: boolean }[] = [
  { kind: "HANDOFF", label: "Handoffs", hideWhenEmpty: false },
  { kind: "RUN_CONFIG", label: "Run configs", hideWhenEmpty: false },
  { kind: "TIMER", label: "Timers", hideWhenEmpty: false },
  { kind: "AUDIT_LOG", label: "Audit logs", hideWhenEmpty: false },
  { kind: "JOURNAL", label: "Journal", hideWhenEmpty: true },
  { kind: "HARVEST_REPORT", label: "Harvest reports", hideWhenEmpty: true },
];

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

/** "3 KB" / "1.2 MB" — same rounding bar as the audit size line (min 1 KB). */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
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

/** TIMER rows: "resumes at 14:32" (date prefixed when not today). */
function formatFireAt(fireAt: string): string {
  const d = new Date(fireAt);
  if (Number.isNaN(d.getTime())) return `resumes at ${fireAt}`;
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? `resumes at ${time}`
    : `resumes at ${d.toLocaleDateString()} ${time}`;
}

function FileRow({
  entry,
  onOpen,
  onDelete,
  onCancelTimer,
  onCleanEpic,
  busy,
  healthFlags,
}: {
  entry: SamuraiFileEntry;
  /** HARVEST_REPORT rows only: view the report markdown (issue #71). */
  onOpen: ((entry: SamuraiFileEntry) => void) | null;
  /** Absent on TIMER rows — a timer is cancelled, never file-deleted. */
  onDelete: ((entry: SamuraiFileEntry) => void) | null;
  /** TIMER rows only: cancel this epic's pending resume. */
  onCancelTimer: ((entry: SamuraiFileEntry) => void) | null;
  /** Present only on rows offering the one-click epic cleanup. */
  onCleanEpic: ((entry: SamuraiFileEntry) => void) | null;
  busy: boolean;
  /** Size warnings the health checker raised against this file (issue #67). */
  healthFlags?: HealthFlag[];
}) {
  const label = rowLabel(entry);
  const meta =
    entry.kind === "TIMER" && entry.fire_at
      ? formatFireAt(entry.fire_at)
      : [formatSize(entry.size_bytes), formatAge(entry.modified_at)].filter(Boolean).join(" · ");
  return (
    <div>
      <div
        className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-maestro-surface"
        title={`${entry.path}${entry.project_path ? `\nproject: ${entry.project_path}` : ""}${entry.epic ? `\nepic: ${entry.epic}` : ""}`}
      >
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
        <span className="shrink-0 text-[10px] text-maestro-muted/70">{meta}</span>
        {onOpen && (
          <button
            type="button"
            onClick={() => onOpen(entry)}
            disabled={busy}
            className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text disabled:opacity-40"
            aria-label={`Open ${label}`}
            title="View this harvest report"
          >
            <Eye size={12} />
          </button>
        )}
        {onCleanEpic && (
          <button
            type="button"
            onClick={() => onCleanEpic(entry)}
            disabled={busy}
            className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-red disabled:opacity-40"
            aria-label={`Clean up epic ${entry.epic}`}
            title="Delete this epic's worktree and branch, cancel its timer, archive its run config (asks first)"
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
 * Fixed overlay showing one harvest report's markdown (issue #71). Same
 * overlay chrome as FileDiffModal, minus the outside-click machinery — close
 * button and Escape only.
 */
function HarvestReportModal({
  entry,
  onClose,
}: {
  entry: SamuraiFileEntry;
  onClose: () => void;
}) {
  // null = loading.
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    samuraiHarvestRead(entry.path)
      .then((md) => {
        if (!cancelled) setMarkdown(md);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [entry.path]);

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
            <Sparkles size={14} className="shrink-0 text-maestro-muted" />
            <span className="truncate text-sm font-medium text-maestro-text">
              {baseName(entry.path)}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close report"
            className="shrink-0 rounded p-1 text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-4">
          {error ? (
            <p className="text-[11px] text-maestro-red">{error}</p>
          ) : markdown === null ? (
            <div className="flex items-center gap-2 text-[11px] text-maestro-muted">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : (
            <MarkdownBody content={markdown} />
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
 * section — every managed resource from `samurai_files_list` grouped by kind
 * with size + age, delete-with-confirm per row (in-use files get a second,
 * harder confirm before force-deleting; TIMER rows get a cancel-timer action
 * instead of delete), and one-click "clean this epic" on run configs without
 * a live supervised session. Deliberately minimal per the PRD: list, delete,
 * warn — no file-manager ambitions.
 */
export function SecondBrainSection() {
  // null = loading.
  const [files, setFiles] = useState<SamuraiFileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The harvest report shown in the overlay; null = closed (issue #71).
  const [openReport, setOpenReport] = useState<SamuraiFileEntry | null>(null);

  /* ── Health checker flags (rule-based, read-only) — issue #67 ── */
  const allHealthFlags = useHealthStore((s) => s.flags);
  const healthRows = useMemo(() => flagsByRow(allHealthFlags, "secondbrain"), [allHealthFlags]);

  const refresh = useCallback(async () => {
    try {
      setFiles(await samuraiFilesList());
      setError(null);
    } catch (err) {
      setFiles([]);
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
    // in-memory timer nor scope to one epic (the backend refuses it). The
    // confirm names the real consequence — no self-resume afterwards.
    const confirmed = await ask(
      `Cancel the pending resume for ${entry.epic}? The parked run will NOT resume on its own — you would have to relaunch it.`,
      { title: "Cancel Resume Timer", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const cancelled = await samuraiTimerCancel(entry.project_path, entry.epic);
      setNotice(
        cancelled
          ? `Cancelled the resume timer for ${entry.epic}.`
          : `No pending resume timer for ${entry.epic}.`,
      );
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
      `Clean up epic ${entry.epic}? This deletes its worktree and samurai branch, cancels its resume timer, and archives its run config. It cannot be undone.`,
      { title: "Clean Up Epic", kind: "warning" },
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
          ? `Cleaned up epic ${report.epic}: removed ${removed.join(", ")}.`
          : `Epic ${report.epic} was already clean.`,
      );
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  // TIMER rows all share schedule.json as their path — a file's health
  // reasons render only under the FIRST row bearing that path (the badge
  // already counts each flag exactly once). Rebuilt every render.
  const seenFlagPaths = new Set<string>();

  return (
    <div className="space-y-3">
      <AuditSection />

      <JournalSection onHarvested={refresh} />

      <div className={cardClass}>
        <SectionHeader
          icon={Files}
          label="Files"
          iconColor="text-maestro-accent"
          badge={
            files && files.length > 0 ? (
              <span className="rounded-full bg-maestro-accent/20 px-1.5 text-[10px] font-bold text-maestro-accent">
                {files.length}
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
          Every Samurai-managed file, all projects. Deleting always asks; in-use files ask twice.
        </p>
        {error && <p className="mb-2 text-[11px] text-maestro-red">{error}</p>}
        {notice && <p className="mb-2 text-[11px] text-maestro-green">{notice}</p>}
        {files === null ? (
          <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-maestro-muted">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-2">
            {GROUPS.map(({ kind, label, hideWhenEmpty }) => {
              const entries = files.filter((f) => f.kind === kind);
              if (entries.length === 0 && hideWhenEmpty) return null;
              return (
                <div key={kind}>
                  <div className="mb-0.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-maestro-muted">
                    {label}
                  </div>
                  {entries.length === 0 ? (
                    <p className="px-1 text-[11px] italic text-maestro-muted">None.</p>
                  ) : (
                    <div className="space-y-0.5">
                      {entries.map((entry, i) => {
                        const firstForPath = !seenFlagPaths.has(entry.path);
                        seenFlagPaths.add(entry.path);
                        return (
                          <FileRow
                            key={`${entry.path}-${entry.epic ?? ""}-${i}`}
                            entry={entry}
                            healthFlags={
                              firstForPath
                                ? healthRows.get(`${entry.path}|${baseName(entry.path)}`)
                                : undefined
                            }
                            // Harvest reports are the one readable kind —
                            // everything else is machine state (issue #71).
                            onOpen={kind === "HARVEST_REPORT" ? setOpenReport : null}
                            // TIMER rows are cancelled, never file-deleted —
                            // schedule.json self-cleans and the backend
                            // refuses deleting it (review F1).
                            onDelete={kind === "TIMER" ? null : handleDelete}
                            onCancelTimer={
                              kind === "TIMER" && entry.epic && entry.project_path
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
                              kind === "RUN_CONFIG" &&
                              entry.epic &&
                              entry.project_path &&
                              !entry.has_live_session
                                ? handleCleanEpic
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

      {openReport && (
        <HarvestReportModal entry={openReport} onClose={() => setOpenReport(null)} />
      )}
    </div>
  );
}
