import { Loader2, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { formatWorkshopTime, isDue, withSectionsOpen } from "@/lib/workshopReport";
import {
  usePrivacyFeatureAllowed,
  usePrivacySettingsStore,
} from "@/stores/usePrivacySettingsStore";
import { useWorkshopStore } from "@/stores/useWorkshopStore";
import { WorkshopCardSummary } from "./WorkshopCardSummary";
import { WorkshopSummary } from "./WorkshopSummary";

type WorkshopTab = "summary" | "transcript";

const TABS: { id: WorkshopTab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "transcript", label: "Real Transcript" },
];

/**
 * Workshop (issue #415): the weekly `/insights` report, read-only. A header
 * with when the shown run ran, when the next run is and every past run, then
 * two tabs: the AI summary (cards, or Markdown for a run from before the cards) and the report
 * exactly as `/insights` wrote it. While the Workshop is off (Settings →
 * Privacy) no run starts; a notice says how to turn it on and the saved runs
 * stay readable.
 */
export function WorkshopPanel() {
  const status = useWorkshopStore((s) => s.status);
  const selectedRunId = useWorkshopStore((s) => s.selectedRunId);
  const content = useWorkshopStore((s) => s.content);
  const running = useWorkshopStore((s) => s.running);
  const error = useWorkshopStore((s) => s.error);
  const load = useWorkshopStore((s) => s.load);
  const select = useWorkshopStore((s) => s.select);
  const run = useWorkshopStore((s) => s.run);
  const allowed = usePrivacyFeatureAllowed("workshop");
  const openPrivacySettings = usePrivacySettingsStore((s) => s.openSettings);
  const [tab, setTab] = useState<WorkshopTab>("summary");

  useEffect(() => {
    void load();
  }, [load]);

  const runs = status?.runs ?? [];
  const shownRun = runs.find((r) => r.id === selectedRunId) ?? null;
  const nextRunAt = status?.next_run_at ?? null;
  const failure = error ?? status?.last_failure?.message ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-maestro-border/60 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-maestro-muted">Ran</span>
          <span className="flex-1 font-medium text-maestro-text">
            {shownRun ? formatWorkshopTime(shownRun.ran_at) : "Not yet"}
          </span>
          <button
            type="button"
            onClick={() => void run(true)}
            disabled={running || !allowed}
            className="flex items-center gap-1 rounded border border-maestro-border/60 px-2 py-0.5 text-[11px] font-semibold text-maestro-text transition-colors hover:bg-maestro-card disabled:opacity-60"
          >
            {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
            {running ? "Running…" : "Run now"}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-maestro-muted">Next run</span>
          <span className="font-medium text-maestro-text">
            {!allowed
              ? "Off"
              : nextRunAt === null || isDue(nextRunAt, Date.now())
                ? "Due now"
                : formatWorkshopTime(nextRunAt)}
          </span>
        </div>
        {runs.length > 0 && (
          <label className="flex items-center gap-2">
            <span className="text-maestro-muted">Past runs</span>
            <select
              aria-label="Past runs"
              value={selectedRunId ?? ""}
              onChange={(e) => void select(e.target.value)}
              className="min-w-0 flex-1 rounded border border-maestro-border/60 bg-maestro-bg px-1.5 py-0.5 text-xs text-maestro-text"
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {formatWorkshopTime(r.ran_at)}
                </option>
              ))}
            </select>
          </label>
        )}
        {failure && (
          <p role="alert" className="rounded bg-red-500/10 px-2 py-1 text-red-400">
            The last run failed: {failure}
          </p>
        )}
      </div>

      {!allowed && (
        <div className="mx-3 mt-3 flex shrink-0 flex-col items-start gap-2 rounded-md border border-dashed border-maestro-border px-3 py-2.5 text-xs text-maestro-text">
          <p>
            Workshop is off, so no report is made. Claude would read the past week's conversations
            to write it.
          </p>
          <button
            type="button"
            onClick={openPrivacySettings}
            className="text-maestro-accent underline hover:opacity-80"
          >
            Turn it on in Settings → Privacy
          </button>
        </div>
      )}

      <div role="tablist" className="flex shrink-0 border-b border-maestro-border/60 px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t.id
                ? "border-maestro-accent text-maestro-text"
                : "border-transparent text-maestro-muted hover:text-maestro-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!content ? (
          allowed && (
            <p className="px-4 py-6 text-sm leading-6 text-maestro-muted">
              {running
                ? "Running /insights… this takes a few minutes."
                : "No insights yet. The first run starts shortly after Maestro opens, or click Run now."}
            </p>
          )
        ) : tab === "summary" ? (
          content.summary_cards ? (
            <WorkshopCardSummary summary={content.summary_cards} />
          ) : content.summary ? (
            <WorkshopSummary markdown={content.summary} />
          ) : (
            <p className="px-4 py-6 text-sm leading-6 text-maestro-muted">
              No summary for this run
              {shownRun?.summary_error ? ` (${shownRun.summary_error})` : ""}. The Real Transcript
              tab has the full report.
            </p>
          )
        ) : (
          <iframe
            title="Insights report"
            sandbox=""
            srcDoc={withSectionsOpen(content.report_html)}
            className="block h-full w-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  );
}
