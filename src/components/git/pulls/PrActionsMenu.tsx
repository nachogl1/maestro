import { MoreVertical, Play } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useDismissable } from "@/hooks/useDismissable";
import {
  buildPrActionPrompt,
  githubRepoSlug,
  prActionBriefStem,
  prActionLaunchName,
} from "@/lib/prActionPrompt";
import {
  compilePrWorkflow,
  DEFAULT_PR_WORKFLOW,
  prWorkflowNeedsWorktree,
  prWorkflowStepsInOrder,
} from "@/lib/prWorkflow";
import type { PullRequestInfo } from "@/stores/useGitHubStore";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { prWorkflowGraphForLaunch, usePrWorkflowStore } from "@/stores/usePrWorkflowStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

interface PrActionsMenuProps {
  pr: PullRequestInfo;
  /** The repository the PR belongs to — named in the launched prompt. */
  repoPath: string;
}

/**
 * The per-row action launcher of the PR monitor: one checkbox per PR workflow
 * step, and a Launch button that opens a terminal primed with the ticked
 * steps as its prompt.
 *
 * The checkboxes are derived from the workflow graph at render time, so a
 * step the user adds in the workflow editor appears here with no code change.
 */
export function PrActionsMenu({ pr, repoPath }: PrActionsMenuProps) {
  const [open, setOpen] = useState(false);
  /**
   * How many steps are ticked. The process is incremental — you cannot review
   * a PR you have not checked, nor merge one you have not reviewed — so
   * ticking step N ticks every EARLIER step and unticking step N unticks
   * every LATER one. That makes the selection always a prefix of the step
   * list, which is why this is a count rather than a set of ids. Defaults to
   * 1: the "just check status" case.
   */
  const [checkedCount, setCheckedCount] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const graph = usePrWorkflowStore((s) => s.graph) ?? DEFAULT_PR_WORKFLOW;
  const steps = useMemo(() => prWorkflowStepsInOrder(graph), [graph]);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  const projectPath = activeTab?.projectPath ?? "";

  // The graph can shrink under us (the workflow editor is live), so never
  // report more ticks than there are steps.
  const ticked = Math.min(checkedCount, steps.length);

  // Close on outside click or Escape — same idiom as the terminal header's
  // zoom menu.
  useDismissable(() => setOpen(false), { ref: menuRef, enabled: open });

  const toggleStep = (index: number) => {
    setCheckedCount((count) => {
      const current = Math.min(count, steps.length);
      // Ticking keeps everything up to and including this step; unticking
      // drops this step and everything after it.
      return index < current ? index : index + 1;
    });
  };

  /**
   * Compiles the ticked steps into a prompt and opens a terminal with it.
   * The graph is re-read through {@link prWorkflowGraphForLaunch} rather than
   * reused from the render, so a launch fired right after app start cannot
   * compile the default while a persisted edit is still loading.
   */
  const handleLaunch = async () => {
    setError(null);
    if (!activeTab) {
      setError("Open a project tab to launch a PR action.");
      return;
    }
    const launchGraph = (await prWorkflowGraphForLaunch()) ?? DEFAULT_PR_WORKFLOW;
    const launchSteps = prWorkflowStepsInOrder(launchGraph);
    const selectedIds = launchSteps
      .slice(0, Math.min(checkedCount, launchSteps.length))
      .map((s) => s.id);
    const compiledSteps = compilePrWorkflow(launchGraph, selectedIds);
    if (compiledSteps.length === 0) {
      setError("The selected steps have no instructions to run.");
      return;
    }
    usePendingLaunchStore.getState().request({
      tabId: activeTab.id,
      mode: "Claude",
      resumeSessionId: null,
      workingDirOverride: projectPath || null,
      branch: null,
      customName: prActionLaunchName(pr.number, selectedIds),
      initialPrompt: buildPrActionPrompt({
        pr,
        repoPath,
        compiledSteps,
        needsWorktree: prWorkflowNeedsWorktree(selectedIds, launchGraph),
      }),
      // This prompt is several KB with every step ticked — too big to type
      // into the PTY reliably (issue #138). Naming a brief target lets the
      // backend stage it as a file in the project checkout and type a
      // one-line pointer at it instead.
      briefDir: projectPath || null,
      briefStem: prActionBriefStem(pr.number, selectedIds),
      // Issue #139: a PR review used to leave NOTHING on disk, so its brief
      // and audit rows had no work to belong to. The same arm hop writes a
      // persistent record — PR, title, repo, steps — which is the review's
      // identity in the Second Brain.
      prRun: {
        pr: pr.number,
        title: pr.title,
        repo: githubRepoSlug(pr.url) ?? "",
        // The PR's OWN checkout, not the tab's project (review finding C10):
        // in a multi-repo workspace they differ, and the record must group
        // under the repository the review is actually about. `briefDir` above
        // stays on the tab's project — that is the terminal's working
        // directory, where the pointer's relative path resolves.
        project_path: repoPath,
        steps: selectedIds,
      },
    });
    // Make sure the grid is mounted to consume the request — the project may
    // still be sitting on the idle landing view.
    useWorkspaceStore.getState().setSessionsLaunched(activeTab.id, true);
    setOpen(false);
  };

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-accent"
        title={`Actions for PR #${pr.number}`}
        aria-label={`Actions for PR #${pr.number}`}
        aria-expanded={open}
      >
        <MoreVertical size={14} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-60 rounded-lg border border-maestro-border bg-maestro-surface p-2 shadow-lg">
          <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-maestro-muted">
            Run on PR #{pr.number}
          </div>

          {steps.length === 0 ? (
            <p className="px-1 py-1 text-[11px] text-maestro-muted">
              The PR workflow has no steps — add one in the workflow editor.
            </p>
          ) : (
            steps.map((step, index) => (
              <label
                key={step.id}
                title={step.text}
                className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-xs text-maestro-text hover:bg-maestro-card"
              >
                <input
                  type="checkbox"
                  checked={index < ticked}
                  onChange={() => toggleStep(index)}
                  className="mt-0.5 shrink-0 accent-maestro-accent"
                />
                <span className="min-w-0 flex-1 truncate">{step.label}</span>
              </label>
            ))
          )}

          {error && <p className="px-1 py-1 text-[10px] text-maestro-red">{error}</p>}

          <button
            type="button"
            onClick={handleLaunch}
            disabled={ticked === 0}
            className="mt-1 flex w-full items-center justify-center gap-1 rounded bg-maestro-accent px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-maestro-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Play size={11} />
            Launch {ticked} {ticked === 1 ? "step" : "steps"}
          </button>

          <p className="px-1 pt-1.5 text-[10px] leading-tight text-maestro-muted/70">
            Steps come from the PR review workflow in the Launch panel.
          </p>
        </div>
      )}
    </div>
  );
}
