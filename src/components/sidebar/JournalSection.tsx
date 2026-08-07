// The spec asks for NotebookPen, which lucide-react 0.300.0 does not ship —
// PenLine is the closest journal-writing glyph available.
import { Loader2, PenLine, Plus, RefreshCw, Sparkles } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  samuraiHarvestRun,
  samuraiJournalAdd,
  samuraiJournalList,
  type SamuraiJournalCategory,
  type SamuraiJournalEntry,
  type SamuraiJournalEntryStatus,
} from "@/lib/samurai";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { cardClass, SectionHeader } from "./sectionChrome";

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
}: {
  entry: SamuraiJournalEntry;
  status: SamuraiJournalEntryStatus;
}) {
  const badgeCls = CATEGORY_BADGES[entry.category] ?? "bg-maestro-muted/15 text-maestro-muted";
  // CONSUMED/ARCHIVED entries went into a harvest already — muted, labeled.
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
    </div>
  );
}

/**
 * Ops journal card (issue #71, PRD §5.12): add-entry form, the newest journal
 * entries with their harvest status, and the "Harvest now" trigger. Sits in
 * the Second Brain panel between the audit stream and the Files section.
 * `onHarvested` lets the parent refresh its file inventory after a harvest so
 * the new HARVEST_REPORT row appears.
 */
export function JournalSection({ onHarvested }: { onHarvested?: () => void }) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  const projectPath = activeTab?.projectPath ?? "";

  // null = loading; rows are kept newest-first (the backend lists newest LAST).
  const [rows, setRows] = useState<
    { entry: SamuraiJournalEntry; status: SamuraiJournalEntryStatus }[] | null
  >(null);
  const [fileSizeBytes, setFileSizeBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [category, setCategory] = useState<SamuraiJournalCategory>("BOTTLENECK");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [harvestBusy, setHarvestBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await samuraiJournalList();
      setRows(result.entries.slice().reverse().slice(0, JOURNAL_TAIL));
      setFileSizeBytes(result.file_size_bytes);
      setError(null);
    } catch (err) {
      setRows([]);
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
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

  const handleHarvest = async () => {
    setHarvestBusy(true);
    setError(null);
    setNotice(null);
    try {
      const report = await samuraiHarvestRun();
      setNotice(`Report ${report.date} written — see Files`);
      // Statuses flip to CONSUMED here; the parent's file list gains the
      // report row.
      await refresh();
      onHarvested?.();
    } catch (err) {
      // Matter-of-fact: the backend's message (e.g. nothing-to-harvest).
      setError(String(err));
    } finally {
      setHarvestBusy(false);
    }
  };

  return (
    <div className={cardClass}>
      <SectionHeader
        icon={PenLine}
        label="Journal"
        iconColor="text-maestro-accent"
        badge={
          rows && rows.length > 0 ? (
            <span className="rounded-full bg-maestro-accent/20 px-1.5 text-[10px] font-bold text-maestro-accent">
              {rows.length}
            </span>
          ) : undefined
        }
        right={
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={refresh}
              className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
              aria-label="Refresh journal"
              title="Reload the journal"
            >
              <RefreshCw size={12} />
            </button>
            <button
              type="button"
              onClick={handleHarvest}
              disabled={harvestBusy}
              className="flex items-center gap-1 rounded border border-maestro-border/60 px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-maestro-text transition-colors hover:bg-maestro-surface disabled:opacity-40"
              aria-label="Harvest now"
              title="Digest the unconsumed entries into today's harvest report (runs headless Claude)"
            >
              {harvestBusy ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Sparkles size={11} />
              )}
              Harvest now
            </button>
          </span>
        }
      />
      <p className="mb-2 text-[11px] text-maestro-muted">
        Ops observations awaiting the harvest, newest first.
        {fileSizeBytes > 0 ? ` ${Math.max(1, Math.round(fileSizeBytes / 1024))} KB on disk.` : ""}
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
        <div className="space-y-0.5">
          {rows.map(({ entry, status }, i) => (
            <JournalRow key={`${entry.ts}-${i}`} entry={entry} status={status} />
          ))}
        </div>
      )}
    </div>
  );
}
