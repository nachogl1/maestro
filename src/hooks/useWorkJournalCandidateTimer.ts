import { useEffect, useMemo } from "react";
import { serveWorkJournalWindow } from "@/lib/workJournalWindow";
import { watchedProjectsFromTabs } from "@/stores/useGitHubWatchdogStore";
import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";

/** Delay before the start-up catch-up run, so it does not compete with first paint. */
export const WORK_JOURNAL_CATCH_UP_DELAY_MS = 30_000;

const HOUR_MS = 60 * 60 * 1000;

type CandidateTimerTabs = ReadonlyArray<
  Parameters<typeof watchedProjectsFromTabs>[0][number] & {
    repositories?: ReadonlyArray<{ path: string }>;
  }
>;

/**
 * The open tabs' project paths for a run: each tab's selected repo plus every
 * other repo of a multi-repo tab, deduplicated. The backend adds the projects
 * earlier runs covered and those of terminals open in the run's window, so
 * closed tabs are still covered.
 */
export function candidateRunProjects(tabs: CandidateTimerTabs): string[] {
  const paths = watchedProjectsFromTabs(tabs).map((project) => project.repoPath);
  for (const tab of tabs) {
    for (const repo of tab.repositories ?? []) {
      if (!paths.includes(repo.path)) paths.push(repo.path);
    }
  }
  return paths;
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

  // The schedule is recorded in the store for the suggestions box's "next run".
  useEffect(() => {
    const { load, setSchedule } = useWorkJournalCandidateRunStore.getState();
    void load();
    setSchedule({ catchUpPending: true });
    const catchUp = setTimeout(() => {
      setSchedule({ catchUpPending: false });
      runWithOpenProjects();
    }, WORK_JOURNAL_CATCH_UP_DELAY_MS);
    return () => {
      clearTimeout(catchUp);
      setSchedule({ catchUpPending: false });
    };
  }, []);

  // The pop-out window's "run now" runs here, and it sees this run state.
  useEffect(() => {
    const stop = serveWorkJournalWindow(runWithOpenProjects).catch((err) => {
      console.error("Failed to serve the Work Journal window:", err);
      return () => {};
    });
    return () => {
      void stop.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const { setSchedule } = useWorkJournalCandidateRunStore.getState();
    const period = runEveryHours * HOUR_MS;
    setSchedule({ nextRunAt: Date.now() + period });
    const interval = setInterval(() => {
      setSchedule({ nextRunAt: Date.now() + period });
      runWithOpenProjects();
    }, period);
    return () => {
      clearInterval(interval);
      setSchedule({ nextRunAt: null });
    };
  }, [runEveryHours]);
}
