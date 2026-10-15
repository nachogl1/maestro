import { useEffect, useMemo } from "react";
import { useAgentNameSync } from "@/hooks/useAgentNameSync";
import { HEALTH_CHECK_INTERVAL_MS } from "@/lib/healthRules";
import { useGitHubWatchdogStore, watchedProjectsFromTabs } from "@/stores/useGitHubWatchdogStore";
import { useHealthStore } from "@/stores/useHealthStore";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";

/** How often the Work Journal backup checks whether its daily backup is due. */
const WORK_JOURNAL_BACKUP_CHECK_MS = 60 * 60 * 1000;

/**
 * App-lifetime background polling, mounted once by `App`: the update
 * auto-check interval, the GitHub watchdog (snapshot listener + keeping the
 * Rust poller's project set in sync with `tabs`), the health checker, the
 * Work Journal daily backup check, and the Claude agent-name sync that keeps
 * terminal titles on agent names.
 */
export function useBackgroundPollers(tabs: Parameters<typeof watchedProjectsFromTabs>[0]): void {
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const autoCheckEnabled = useUpdateStore((s) => s.autoCheckEnabled);
  const checkIntervalMinutes = useUpdateStore((s) => s.checkIntervalMinutes);

  useEffect(() => {
    if (!autoCheckEnabled) return;
    // Check on mount
    checkForUpdates();
    // Then periodically
    const interval = setInterval(checkForUpdates, checkIntervalMinutes * 60 * 1000);
    return () => clearInterval(interval);
  }, [autoCheckEnabled, checkIntervalMinutes, checkForUpdates]);

  // GitHub watchdog: receive poll snapshots from the Rust background task.
  const initWatchdogListeners = useGitHubWatchdogStore((s) => s.initListeners);
  useEffect(() => {
    const unlistenPromise = initWatchdogListeners().catch((err) => {
      console.error("Failed to initialize GitHub watchdog listeners:", err);
      return () => {};
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [initWatchdogListeners]);

  // GitHub watchdog: keep the Rust poller's project set in sync with the
  // open workspace tabs (deduplicated by repo path — see helper docs).
  // Serialized so active-tab flips (which also mutate `tabs`) don't
  // re-invoke the command; the backend additionally ignores identical sets.
  const watchedProjectsJson = useMemo(() => JSON.stringify(watchedProjectsFromTabs(tabs)), [tabs]);
  useEffect(() => {
    void useGitHubWatchdogStore.getState().syncProjects(JSON.parse(watchedProjectsJson));
  }, [watchedProjectsJson]);

  // Health checker: rule-based Samurai-file checks on a quiet interval.
  // Independent of the open tabs, so nothing here restarts the interval.
  // The first run is delayed rather than fired on mount so it does not
  // compete with first paint and terminal spawn. The badge still populates
  // long before the first interval tick, and first-run suppression via
  // `baselineKeys` keeps the toast behaviour identical whenever it lands.
  useEffect(() => {
    const runCheck = () => void useHealthStore.getState().runCheck();
    const firstRun = setTimeout(runCheck, 30_000);
    const interval = setInterval(runCheck, HEALTH_CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(firstRun);
      clearInterval(interval);
    };
  }, []);

  // Work Journal backup: once on start, then hourly. The backend backs up
  // only when a folder is set and the last backup is a day old, so most
  // checks write nothing.
  useEffect(() => {
    const runCheck = () => void useWorkJournalBackupStore.getState().backUpIfDue();
    runCheck();
    const interval = setInterval(runCheck, WORK_JOURNAL_BACKUP_CHECK_MS);
    return () => clearInterval(interval);
  }, []);

  useAgentNameSync();
}
