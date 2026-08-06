import { ask } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, Loader2, RefreshCw, Rocket, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  samuraiCleanupEpic,
  samuraiLaunchRun,
  samuraiListRuns,
  samuraiPreflight,
  type SamuraiPreflight,
  type SamuraiRunConfig,
} from "@/lib/samurai";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { cardClass, SectionHeader } from "./sectionChrome";

/** Last path segment, for compact project display. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** One pass/fail preflight row. */
function CheckRow({ ok, label, detail }: { ok: boolean; label: string; detail?: string | null }) {
  return (
    <div className="flex items-start gap-1.5 text-[11px]">
      {ok ? (
        <CheckCircle2 size={12} className="mt-px shrink-0 text-maestro-green" />
      ) : (
        <XCircle size={12} className="mt-px shrink-0 text-maestro-red" />
      )}
      <span className={ok ? "text-maestro-text" : "text-maestro-red"}>
        {label}
        {detail ? <span className="text-maestro-muted"> — {detail}</span> : null}
      </span>
    </div>
  );
}

/** One active run with its cleanup action. */
function RunRow({
  run,
  onCleanup,
  busy,
}: {
  run: SamuraiRunConfig;
  onCleanup: (run: SamuraiRunConfig) => void;
  busy: boolean;
}) {
  return (
    <div
      className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-maestro-surface"
      title={`worktree: ${run.worktree_path}\nrepo pin: ${run.repo_pin ?? "none"}\ncreated: ${run.created_at}`}
    >
      <span className="shrink-0 rounded bg-maestro-green/20 px-1 py-px text-[9px] font-bold tracking-wide text-maestro-green">
        ACTIVE
      </span>
      <span className="min-w-0 flex-1 truncate text-maestro-text">
        {run.epic}
        <span className="text-maestro-muted"> · {baseName(run.project_path)}</span>
        {run.model ? <span className="text-maestro-muted"> · {run.model}</span> : null}
      </span>
      <button
        type="button"
        onClick={() => onCleanup(run)}
        disabled={busy}
        className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-red disabled:opacity-40"
        aria-label={`Clean up epic ${run.epic}`}
        title="Delete this epic's worktree and branch, cancel its timer, archive its run config (asks first)"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

/**
 * Samurai run launcher (issue #63, PRD §5.8 + §9): the form that starts an
 * autonomous epic run — project (active tab), epic ref, optional model, the
 * triaged declaration — with explicit preflight pass/fail rows and a Launch
 * button that stays disabled until every gate passes. Below it, the active
 * runs (`samurai_list_runs`) with per-run destructive cleanup behind the
 * same ask()-confirm pattern as the audit clear.
 */
export function LaunchSection() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  const projectPath = activeTab?.projectPath ?? "";

  const [epic, setEpic] = useState("");
  const [model, setModel] = useState("");
  const [triaged, setTriaged] = useState(false);
  const [preflight, setPreflight] = useState<SamuraiPreflight | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // null = loading.
  const [runs, setRuns] = useState<SamuraiRunConfig[] | null>(null);
  const [cleaningEpic, setCleaningEpic] = useState<string | null>(null);

  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await samuraiListRuns());
    } catch (err) {
      setRuns([]);
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  // Preflight probes are project-scoped — a stale pass must not leak onto
  // another project.
  useEffect(() => {
    setPreflight(null);
    setError(null);
    setNotice(null);
  }, [projectPath]);

  const handlePreflight = async () => {
    setPreflightLoading(true);
    setError(null);
    setNotice(null);
    try {
      setPreflight(await samuraiPreflight(projectPath));
    } catch (err) {
      setError(String(err));
      setPreflight(null);
    } finally {
      setPreflightLoading(false);
    }
  };

  const preflightPassed = preflight !== null && preflight.gh_auth.ok && preflight.windows_reported;
  const canLaunch =
    Boolean(projectPath) && epic.trim().length > 0 && triaged && preflightPassed && !launching;

  const handleLaunch = async () => {
    setLaunching(true);
    setError(null);
    setNotice(null);
    try {
      const result = await samuraiLaunchRun(
        projectPath,
        epic.trim(),
        model.trim() ? model.trim() : null,
        triaged,
      );
      setNotice(
        `Run launched: epic ${result.epic} on ${result.branch} (worktree ${result.worktree_path})`,
      );
      setEpic("");
      setTriaged(false);
      setPreflight(null);
      await refreshRuns();
    } catch (err) {
      setError(String(err));
    } finally {
      setLaunching(false);
    }
  };

  const handleCleanup = async (run: SamuraiRunConfig) => {
    // Destructive, never silent (PRD §5.9) — same ask() confirm pattern as
    // the audit clear.
    const confirmed = await ask(
      `Clean up epic ${run.epic}? This deletes its worktree and samurai branch, cancels its resume timer, and archives its run config. It cannot be undone.`,
      { title: "Clean Up Epic", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    setCleaningEpic(run.epic);
    setError(null);
    setNotice(null);
    try {
      const report = await samuraiCleanupEpic(run.project_path, run.epic);
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
      await refreshRuns();
    } catch (err) {
      setError(String(err));
    } finally {
      setCleaningEpic(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className={cardClass}>
        <SectionHeader icon={Rocket} label="Launch Run" iconColor="text-maestro-accent" />
        <p className="mb-2 text-[11px] text-maestro-muted">
          Start an autonomous Samurai run for one GitHub epic in its own worktree.
        </p>

        <div className="space-y-2">
          <div>
            <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-maestro-muted">
              Project
            </label>
            <div className="truncate rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-[11px] text-maestro-text">
              {projectPath ? projectPath : "No active project"}
            </div>
          </div>
          <div>
            <label
              htmlFor="samurai-launch-epic"
              className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-maestro-muted"
            >
              Epic ref
            </label>
            <input
              id="samurai-launch-epic"
              type="text"
              value={epic}
              onChange={(e) => setEpic(e.target.value)}
              placeholder="#38 or 38"
              className="w-full rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-[11px] text-maestro-text placeholder:text-maestro-muted/60 focus:border-maestro-accent focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="samurai-launch-model"
              className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-maestro-muted"
            >
              Model (optional)
            </label>
            <input
              id="samurai-launch-model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="default"
              className="w-full rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-[11px] text-maestro-text placeholder:text-maestro-muted/60 focus:border-maestro-accent focus:outline-none"
            />
          </div>
          <label className="flex cursor-pointer items-start gap-1.5 text-[11px] text-maestro-text">
            <input
              type="checkbox"
              checked={triaged}
              onChange={(e) => setTriaged(e.target.checked)}
              className="mt-px accent-maestro-accent"
            />
            <span>Issues are triaged/agent-ready — planned with Claude</span>
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePreflight}
              disabled={!projectPath || preflightLoading}
              className="rounded border border-maestro-border/60 px-2 py-1 text-[11px] text-maestro-text transition-colors hover:bg-maestro-surface disabled:opacity-40"
            >
              {preflightLoading ? (
                <span className="flex items-center gap-1">
                  <Loader2 size={11} className="animate-spin" /> Checking…
                </span>
              ) : (
                "Run preflight"
              )}
            </button>
            <button
              type="button"
              onClick={handleLaunch}
              disabled={!canLaunch}
              className="rounded bg-maestro-accent/20 px-2 py-1 text-[11px] font-semibold text-maestro-accent transition-colors hover:bg-maestro-accent/30 disabled:opacity-40"
            >
              {launching ? "Launching…" : "Launch"}
            </button>
          </div>

          {preflight && (
            <div className="space-y-1 rounded border border-maestro-border/40 bg-maestro-surface/60 p-1.5">
              <CheckRow
                ok={preflight.gh_auth.ok}
                label={
                  preflight.gh_auth.ok
                    ? `gh authenticated as ${preflight.gh_auth.username ?? "unknown user"}`
                    : "gh auth failed"
                }
                detail={preflight.gh_auth.ok ? null : preflight.gh_auth.error}
              />
              <CheckRow
                ok={preflight.windows_reported}
                label={
                  preflight.windows_reported
                    ? "Allowance windows reported"
                    : "No governing allowance window"
                }
                detail={
                  preflight.windows_reported
                    ? null
                    : "the usage API reports neither the 5h nor the 7d window — parking cannot govern this run"
                }
              />
              <CheckRow
                ok={triaged}
                label={triaged ? "Issues declared triaged/agent-ready" : "Issues not declared triaged"}
                detail={triaged ? null : "tick the declaration above"}
              />
            </div>
          )}

          {error && <p className="text-[11px] text-maestro-red">{error}</p>}
          {notice && <p className="text-[11px] text-maestro-green">{notice}</p>}
        </div>
      </div>

      <div className={cardClass}>
        <SectionHeader
          icon={Rocket}
          label="Active Runs"
          iconColor="text-maestro-green"
          badge={
            runs && runs.length > 0 ? (
              <span className="rounded-full bg-maestro-green/20 px-1.5 text-[10px] font-bold text-maestro-green">
                {runs.length}
              </span>
            ) : undefined
          }
          right={
            <button
              type="button"
              onClick={refreshRuns}
              className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
              aria-label="Refresh active runs"
              title="Reload the active runs list"
            >
              <RefreshCw size={12} />
            </button>
          }
        />
        {runs === null ? (
          <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-maestro-muted">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        ) : runs.length === 0 ? (
          <p className="px-1 py-2 text-[11px] italic text-maestro-muted">
            No active runs. Launch one above.
          </p>
        ) : (
          <div className="space-y-0.5">
            {runs.map((run) => (
              <RunRow
                key={`${run.project_path}-${run.epic}`}
                run={run}
                onCleanup={handleCleanup}
                busy={cleaningEpic !== null}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
