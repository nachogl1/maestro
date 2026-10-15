import { useEffect, useMemo } from "react";
import { watchedProjectsFromTabs } from "@/stores/useGitHubWatchdogStore";
import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";

/** Delay before the start-up catch-up run, so it does not compete with first paint. */
export const WORK_JOURNAL_CATCH_UP_DELAY_MS = 30_000;

const HOUR_MS = 60 * 60 * 1000;

type CandidateTimerTabs = Parameters<typeof watchedProjectsFromTabs>[0];

/** The project paths a run covers: the open tabs' repos, deduplicated. */
export function candidateRunProjects(tabs: CandidateTimerTabs): string[] {
  return watchedProjectsFromTabs(tabs).map((project) => project.repoPath);
}

/** One run over the projects open right now. */
function runWithOpenProjects(): void {
  const store = useWorkJournalCandidateRunStore.getState();
  void store.runNow(store.projects);
}

/**
 * Work Journal candidate timer, mounted once via `useBackgroundPollers`:
 * keeps the open projects in the run store (for "Run now" too), reads the
 * run settings on start, runs one catch-up run shortly after start (the
 * backend covers the time since the last run), then one run every "run every
 * X hours" while the app is open. Changing the setting restarts the
 * interval. In-app only; no OS scheduler.
 */
export function useWorkJournalCandidateTimer(tabs: CandidateTimerTabs): void {
  const runEveryHours = useWorkJournalCandidateRunStore((s) => s.runEveryHours);

  // Serialized so tab changes that keep the same projects do not update the store.
  const projectsJson = useMemo(() => JSON.stringify(candidateRunProjects(tabs)), [tabs]);
  useEffect(() => {
    useWorkJournalCandidateRunStore.getState().setProjects(JSON.parse(projectsJson));
  }, [projectsJson]);

  useEffect(() => {
    void useWorkJournalCandidateRunStore.getState().load();
    const catchUp = setTimeout(runWithOpenProjects, WORK_JOURNAL_CATCH_UP_DELAY_MS);
    return () => clearTimeout(catchUp);
  }, []);

  useEffect(() => {
    const interval = setInterval(runWithOpenProjects, runEveryHours * HOUR_MS);
    return () => clearInterval(interval);
  }, [runEveryHours]);
}
