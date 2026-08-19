import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
// The spec asks for NotebookPen, which lucide-react 0.300.0 does not ship —
// PenLine is the closest journal-writing glyph available.
import { Loader2, PenLine, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  type SamuraiJournalCategory,
  type SamuraiJournalEntry,
  type SamuraiJournalEntryStatus,
  type SamuraiJournalListEntry,
  samuraiHarvestPreview,
  samuraiJournalAdd,
  samuraiJournalDelete,
  samuraiJournalList,
} from "@/lib/samurai";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { HarvestReportsSection } from "./HarvestReportsSection";
import { cardClass, SectionHeader } from "./sectionChrome";

/**
 * The empty-journal refusal, byte-identical to the backend's pinned
 * `NOTHING_TO_HARVEST` (`commands/harvest.rs`) — shown before any terminal
 * opens, so an empty journal never wastes a session.
 */
const NOTHING_TO_HARVEST = "Nothing to harvest — no unconsumed journal entries.";

/**
 * What one injection attempt did, mirrored from the backend
 * (`commands::harvest::HarvestInjectionOutcome`). `error` is `null` on
 * success.
 */
interface HarvestInjectionOutcome {
  sessionId: number;
  injected: number;
  error: string | null;
  /**
   * Present only when the triage brief file could not be written and the
   * prompt was typed at the smaller inline budget instead (issue #154) —
   * the reason fewer entries came through than the brief route would have
   * carried. Omitted from the payload on every other path.
   */
  briefDowngrade?: string;
}

/** How many rows to show — the newest slice, same no-virtualization bar as the audit list. */
const JOURNAL_TAIL = 50;

/** The five PRD §5.12 categories, in declaration order, with sentence-case labels. */
const CATEGORIES: { value: SamuraiJournalCategory; label: string }[] = [
  { value: "BOTTLENECK", label: "Bottleneck" },
  { value: "ERROR", label: "Error" },
  { value: "IMPROVEMENT", label: "Improvement" },
  { value: "SKILL", label: "Skill" },
  { value: "CONCERN", label: "Concern" },
];

/** Badge tint per journal category (KIND_BADGES-style, sidebar badge palette). */
const CATEGORY_BADGES: Record<SamuraiJournalCategory, string> = {
  BOTTLENECK: "bg-amber-500/15 text-amber-500",
  ERROR: "bg-red-500/15 text-red-400",
  IMPROVEMENT: "bg-maestro-green/20 text-maestro-green",
  SKILL: "bg-maestro-blue/15 text-maestro-blue",
  CONCERN: "bg-maestro-purple/20 text-maestro-purple",
};

/** Time for today's rows, date + time for older ones (same as AuditSection). */
function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString()
    : d.toLocaleString();
}

function JournalRow({
  entry,
  status,
  busy,
  onDelete,
}: {
  entry: SamuraiJournalEntry;
  status: SamuraiJournalEntryStatus;
  busy: boolean;
  /** Deletable whether UNCONSUMED, CONSUMED or ARCHIVED (issue #100). */
  onDelete: () => void;
}) {
  const badgeCls = CATEGORY_BADGES[entry.category] ?? "bg-maestro-muted/15 text-maestro-muted";
  // PENDING/CONSUMED/ARCHIVED entries went into a harvest already — muted,
  // labeled (PENDING means delivered but not yet evidenced as triaged, issue
  // #159 — the next harvest promotes or re-delivers it).
  const consumed = status !== "UNCONSUMED";
  return (
    <div
      className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-maestro-surface"
      title={`${entry.ts}${entry.project ? `\nproject: ${entry.project}` : ""}${
        entry.agent ? `\nagent: ${entry.agent}` : ""
      }\n${entry.text}`}
    >
      {status === "UNCONSUMED" && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-maestro-accent"
          title="Not yet harvested"
        />
      )}
      <span
        className={`shrink-0 whitespace-nowrap rounded px-1 py-px text-[9px] font-bold tracking-wide ${badgeCls}`}
      >
        {entry.category}
      </span>
      <span
        className={`min-w-0 flex-1 truncate ${consumed ? "text-maestro-muted" : "text-maestro-text"}`}
      >
        {entry.text}
      </span>
      {consumed && (
        <span className="shrink-0 whitespace-nowrap text-[9px] font-bold tracking-wide text-maestro-muted/70">
          {status}
        </span>
      )}
      <span className="shrink-0 text-[10px] text-maestro-muted/70">{formatTs(entry.ts)}</span>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-red disabled:opacity-40"
        aria-label={`Delete journal entry: ${entry.text}`}
        title="Delete this journal entry (asks first)"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

/**
 * Ops journal card (issue #71, PRD §5.12): add-entry form, the newest journal
 * entries with their harvest status, and the "Harvest now" trigger. Sits in
 * the Second Brain panel between the audit stream and the Files section.
 *
 * "Harvest now" (issue #98) opens an INTERACTIVE terminal session instead of
 * running a headless report: it queues a pending launch for the active
 * project's grid (the History-tab mechanism), the grid arms the backend, and
 * the backend injects the journal-triage prompt — /insights, Downloads
 * report, keep/file/discard discussion — on the session's first
 * SessionStarted. Entry statuses flip to PENDING at that injection (issue
 * #159 — promoted to CONSUMED by the next harvest once the run shows
 * evidence of triage, re-delivered otherwise), so this list updates on the
 * next refresh, not on click.
 *
 * Below the entries, [`HarvestReportsSection`] surfaces whatever is left
 * from the retired headless harvest under `<app data>/harvest/*` (issue
 * #142) — legacy reports the Files panel deliberately does not list (no
 * generic group, epic #136).
 */
export function JournalSection() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  const projectPath = activeTab?.projectPath ?? "";

  // null = loading; rows are kept newest-first (the backend lists newest LAST).
  const [rows, setRows] = useState<SamuraiJournalListEntry[] | null>(null);
  // Full entry count from the last good list — the rows above are capped at
  // JOURNAL_TAIL, and the header badge must not lie about the journal's size.
  const [totalEntries, setTotalEntries] = useState(0);
  const [fileSizeBytes, setFileSizeBytes] = useState(0);
  // Lines the backend could not parse. They are kept on disk but never
  // listed or harvested, so without a count the friction an agent recorded
  // with a mis-spelled category simply vanished from every surface.
  const [opaqueLines, setOpaqueLines] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [category, setCategory] = useState<SamuraiJournalCategory>("BOTTLENECK");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  // `isCancelled` lets the mount effect drop a result that resolves after
  // unmount (the HarvestReportModal's cancelled-flag pattern); button
  // handlers use the default never-cancelled predicate.
  const refresh = useCallback(async (isCancelled: () => boolean = () => false) => {
    try {
      const result = await samuraiJournalList();
      if (isCancelled()) return;
      setRows(result.entries.slice().reverse().slice(0, JOURNAL_TAIL));
      setTotalEntries(result.entries.length);
      setFileSizeBytes(result.file_size_bytes);
      setOpaqueLines(result.opaque_line_count ?? 0);
      setError(null);
    } catch (err) {
      if (isCancelled()) return;
      // A failed refresh keeps the last good rows — only the error line
      // changes; a never-loaded list falls through to empty.
      setRows((prev) => prev ?? []);
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  /**
   * What the injection ACTUALLY did. The success notice above is written at
   * click time — before the terminal even opens — so without this a failed
   * injection (no entries left, a dead PTY, a failed consumption commit)
   * left the card claiming the journal had been triaged while the terminal
   * sat at an empty prompt.
   */
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    listen<HarvestInjectionOutcome>("samurai-harvest-event", (e) => {
      const { injected, error: failure, briefDowngrade } = e.payload;
      if (failure) {
        setNotice(null);
        setError(failure);
      } else {
        setError(null);
        // The downgrade is not a failure — the harvest worked — so it rides
        // on the success notice rather than the error slot (issue #154).
        setNotice(
          `Triage prompt injected — ${injected} ${injected === 1 ? "entry" : "entries"} handed to the session${briefDowngrade ? ` (${briefDowngrade})` : ""}`,
        );
      }
      void refresh();
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        // Event system unavailable (tests) — the card still works on reads.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const handleAdd = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await samuraiJournalAdd(category, trimmed, projectPath || undefined);
      setText("");
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Deletes one journal entry (issue #100), guarded confirm first (PRD
   * §5.11 precedent — destructive, never silent). Consumed/archived entries
   * are deletable too: harvest status only reflects triage, not whether the
   * observation is worth keeping.
   */
  const handleDelete = async (row: SamuraiJournalListEntry) => {
    const confirmed = await ask(`Delete this journal entry? "${row.entry.text}"`, {
      title: "Delete Journal Entry",
      kind: "warning",
    }).catch(() => false);
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await samuraiJournalDelete(row.raw);
      setNotice("Deleted journal entry.");
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Opens the interactive harvest triage session (issue #98). No spinner /
   * waiting state: the click only checks the journal and queues a launch —
   * the work happens in the terminal that opens. A double-click is deduped
   * by the pending-launch store (two identical requests are one launch).
   * The terminal opens in the active project's MAIN checkout
   * (workingDirOverride) — the journal is account-wide, so no worktree is
   * derived; the active tab is simply where the user is working.
   */
  const handleHarvest = async () => {
    setError(null);
    setNotice(null);
    if (!activeTab) {
      setError("Open a project tab to start a harvest session.");
      return;
    }
    try {
      // The backend owns the count (issue #159): UNCONSUMED rows plus a
      // PENDING batch whose run left no evidence of triage — that batch is
      // re-delivered, so a client-side UNCONSUMED filter would refuse a
      // journal that still has work.
      const deliverable = await samuraiHarvestPreview();
      if (deliverable === 0) {
        setError(NOTHING_TO_HARVEST);
        return;
      }
      usePendingLaunchStore.getState().request({
        tabId: activeTab.id,
        mode: "Claude",
        resumeSessionId: null,
        workingDirOverride: projectPath || null,
        branch: null,
        customName: "harvest triage",
        harvest: true,
      });
      // Same as the History tab: make sure the grid is mounted to consume
      // the request (the project may sit on the idle landing view).
      useWorkspaceStore.getState().setSessionsLaunched(activeTab.id, true);
      setNotice(
        `Triage session opened — ${deliverable} ${deliverable === 1 ? "entry" : "entries"} will be injected there`,
      );
    } catch (err) {
      // Matter-of-fact: the backend's message.
      setError(String(err));
    }
  };

  return (
    <div className={cardClass}>
      <SectionHeader
        icon={PenLine}
        label="Journal"
        iconColor="text-maestro-accent"
        badge={
          rows && totalEntries > 0 ? (
            <span className="rounded-full bg-maestro-accent/20 px-1.5 text-[10px] font-bold text-maestro-accent">
              {totalEntries}
            </span>
          ) : undefined
        }
        right={
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => refresh()}
              className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
              aria-label="Refresh journal"
              title="Reload the journal"
            >
              <RefreshCw size={12} />
            </button>
            <button
              type="button"
              onClick={handleHarvest}
              className="flex items-center gap-1 rounded border border-maestro-border/60 px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-maestro-text transition-colors hover:bg-maestro-surface"
              aria-label="Harvest now"
              title="Open an interactive terminal session that triages the unconsumed entries with /insights"
            >
              <Sparkles size={11} />
              Harvest now
            </button>
          </span>
        }
      />
      <p className="mb-2 text-[11px] text-maestro-muted">
        Ops observations awaiting the harvest, newest first.
        {fileSizeBytes > 0 ? ` ${Math.max(1, Math.round(fileSizeBytes / 1024))} KB on disk.` : ""}
        {opaqueLines > 0 ? (
          <span className="text-maestro-orange">
            {" "}
            {opaqueLines} unreadable {opaqueLines === 1 ? "line" : "lines"} skipped — never listed
            or harvested.
          </span>
        ) : null}
      </p>
      <form onSubmit={handleAdd} className="mb-2 flex items-center gap-1">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as SamuraiJournalCategory)}
          aria-label="Entry category"
          className="shrink-0 rounded border border-maestro-border/60 bg-maestro-surface px-1 py-1 text-[11px] text-maestro-text focus:border-maestro-accent focus:outline-none"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Log an observation…"
          aria-label="Entry text"
          className="min-w-0 flex-1 rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-[11px] text-maestro-text placeholder:text-maestro-muted/60 focus:border-maestro-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || text.trim() === ""}
          className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text disabled:opacity-40"
          aria-label="Add journal entry"
          title="Add this entry to the ops journal"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
        </button>
      </form>
      {error && <p className="mb-2 text-[11px] text-maestro-red">{error}</p>}
      {notice && <p className="mb-2 text-[11px] text-maestro-green">{notice}</p>}
      {rows === null ? (
        <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-maestro-muted">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <p className="px-1 py-2 text-[11px] italic text-maestro-muted">No journal entries yet.</p>
      ) : (
        <div className="max-h-[45vh] overflow-y-auto space-y-0.5">
          {rows.map((row, i) => (
            <JournalRow
              key={`${row.entry.ts}-${i}`}
              entry={row.entry}
              status={row.status}
              busy={busy}
              onDelete={() => handleDelete(row)}
            />
          ))}
        </div>
      )}
      <HarvestReportsSection />
    </div>
  );
}
