import { ask } from "@tauri-apps/plugin-dialog";
import { Eye, FileText, Loader2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { MarkdownBody } from "@/components/git/shared/MarkdownBody";
import {
  type SamuraiHarvestReport,
  samuraiFileDelete,
  samuraiHarvestList,
  samuraiHarvestRead,
} from "@/lib/samurai";

/** Last path segment, for compact display (the `SecondBrainSection` precedent). */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** "3 KB" — rounded size on disk, min 1 KB for anything non-empty. */
function formatSizeKb(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Local date the report was last modified; empty when unknown or unparsable. */
function formatModified(modifiedAt: string | null): string {
  if (!modifiedAt) return "";
  const d = new Date(modifiedAt);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

/**
 * Read-only overlay for one legacy harvest report — the same chrome as
 * `SecondBrainSection.tsx`'s `FileViewerModal` (fixed overlay, close button
 * + Escape listener, cancelled-flag fetch), duplicated rather than shared:
 * that modal is typed on `SamuraiFileEntry`, which a harvest row is
 * deliberately not (issue #142 R1 — the Files panel stays untouched).
 */
function HarvestReportViewer({ path, onClose }: { path: string; onClose: () => void }) {
  // null = loading.
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMarkdown = baseName(path).toLowerCase().endsWith(".md");

  useEffect(() => {
    let cancelled = false;
    samuraiHarvestRead(path)
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((err) => {
        // Backend refusals are already readable sentences — show verbatim.
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

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
            <span className="truncate text-sm font-medium text-maestro-text">{baseName(path)}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close harvest report viewer"
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
          ) : isMarkdown ? (
            // allowRawHtml={false}: this is model output — raw HTML in it
            // must never become live elements in this invoke-capable webview.
            <MarkdownBody content={content} allowRawHtml={false} />
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-maestro-text">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The Journal card's legacy-reports sub-block (issue #142): lists whatever
 * is left under `<app data>/harvest/*` from the retired headless harvest —
 * issue #98 moved new `/insights` reports to the user's Downloads folder, so
 * nothing writes here any more. Offers a read-only view and a
 * delete-with-confirm per row, reusing `samurai_file_delete` (its managed
 * roots already include the harvest directory).
 *
 * Renders NOTHING when there is nothing to show: an absent or empty harvest
 * dir is the NORMAL case for most installs, and permanent empty chrome for a
 * legacy bucket most installs will never populate is exactly the noise
 * epic #136 rejects (Q4).
 */
export function HarvestReportsSection() {
  // null = loading; an empty array is a legitimate loaded state (Q4).
  const [reports, setReports] = useState<SamuraiHarvestReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);

  const refresh = useCallback(async (isCancelled: () => boolean = () => false) => {
    try {
      const result = await samuraiHarvestList();
      if (isCancelled()) return;
      setReports(result);
      setError(null);
    } catch (err) {
      if (isCancelled()) return;
      // A failed refresh keeps the last good rows — only the error line
      // changes; a never-loaded list falls through to empty (the
      // `JournalSection.refresh` precedent).
      setReports((prev) => prev ?? []);
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
   * Deletes one legacy report, guarded confirm first (PRD §5.11 precedent —
   * destructive, never silent). Force is never offered: these files carry no
   * group and are never `in_use` (issue #142 Q3/R3).
   */
  const handleDelete = async (report: SamuraiHarvestReport) => {
    const name = baseName(report.path);
    const confirmed = await ask(`Delete this legacy harvest report? "${name}"`, {
      title: "Delete Harvest Report",
      kind: "warning",
    }).catch(() => false);
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await samuraiFileDelete(report.path, false);
      setNotice(`Deleted ${name}.`);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  if (reports === null || (reports.length === 0 && !error && !notice)) return null;

  return (
    <div className="mt-2 border-t border-maestro-border/40 pt-2">
      <p className="mb-0.5 text-[11px] font-semibold text-maestro-text">
        Legacy harvest reports
        {reports.length > 0 && <span className="ml-1 text-maestro-muted">({reports.length})</span>}
      </p>
      <p className="mb-1.5 text-[10px] text-maestro-muted">
        From the retired headless harvest. New triage reports are saved to your Downloads folder.
      </p>
      {error && <p className="mb-1.5 text-[11px] text-maestro-red">{error}</p>}
      {notice && <p className="mb-1.5 text-[11px] text-maestro-green">{notice}</p>}
      {reports.map((report) => {
        const name = baseName(report.path);
        const meta = [formatSizeKb(report.size_bytes), formatModified(report.modified_at)]
          .filter(Boolean)
          .join(" · ");
        return (
          <div
            key={report.path}
            className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-maestro-surface"
            title={report.path}
          >
            <span className="min-w-0 flex-1 truncate text-maestro-text">{name}</span>
            <span className="shrink-0 text-[10px] text-maestro-muted/70">{meta}</span>
            <button
              type="button"
              onClick={() => setOpenPath(report.path)}
              disabled={busy}
              className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text disabled:opacity-40"
              aria-label={`View harvest report: ${name}`}
              title="View this report (read-only)"
            >
              <Eye size={12} />
            </button>
            <button
              type="button"
              onClick={() => handleDelete(report)}
              disabled={busy}
              className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-red disabled:opacity-40"
              aria-label={`Delete harvest report: ${name}`}
              title="Delete this report (asks first)"
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      })}
      {openPath && <HarvestReportViewer path={openPath} onClose={() => setOpenPath(null)} />}
    </div>
  );
}
