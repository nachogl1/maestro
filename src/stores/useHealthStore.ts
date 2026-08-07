import { create } from "zustand";
import {
  diffNewFlags,
  evaluateMemory,
  evaluateProcesses,
  evaluateSamuraiFiles,
  type HealthArea,
  type HealthFlag,
  type ProcessStreaks,
} from "@/lib/healthRules";
import { listMemoryFiles, listMemoryProjects } from "@/lib/memory";
import { listDevProcesses } from "@/lib/processes";
import { samuraiFilesList, samuraiGetConfig } from "@/lib/samurai";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import { useProcessWatchlistStore } from "@/stores/useProcessWatchlistStore";

/**
 * Background health checker: pure rules over data Maestro already fetches,
 * run every few minutes. It raises attention badges and one-line reasons; it
 * never deletes a memory file, never kills a process, and never touches a
 * Samurai-managed file.
 *
 * Follows the GitHub watchdog's shape — a reducer over samples, transition-only
 * toasts, first-run suppression — but polls from the frontend rather than a
 * Rust task, because every input except one path-existence probe is already a
 * frontend command.
 */

/** A queued toast for a newly-raised flag. */
export interface HealthToast {
  id: string;
  area: HealthArea;
  target: string;
  reason: string;
}

/** Keep at most this many queued toasts per source; oldest are dropped first. */
const MAX_TOASTS = 6;

type HealthState = {
  flags: HealthFlag[];
  /** Consecutive-sample counters, carried between process samples. */
  streaks: ProcessStreaks;
  /**
   * Last known flag keys per area, or `null` while that area has never
   * completed a check — the first-run suppression that stops app start from
   * toasting every pre-existing problem.
   */
  baselineKeys: Record<HealthArea, string[] | null>;
  /**
   * Flag keys the user has waved off. Kept in memory only (a restart brings
   * them back), and pruned to the keys still being raised so a flag that
   * clears and later returns is shown again.
   */
  dismissedKeys: string[];
  toasts: HealthToast[];
  lastCheckedAt: number | null;
  isChecking: boolean;
};

type HealthActions = {
  /**
   * Runs one full check across every project with saved memory, every
   * watched process and every Samurai-managed file. Takes no arguments: the
   * rules read only the memory directories, the process table and the
   * Samurai inventory, never the open workspace.
   */
  runCheck: () => Promise<void>;
  /** Hides one flag until it clears and comes back. Never touches a file. */
  dismissFlag: (key: string) => void;
  dismissToast: (id: string) => void;
  /** Clears the queue outright — used when notifications are switched off. */
  dismissAllToasts: () => void;
};

let toastSeq = 0;

/**
 * Per-project memory scan; throws so the caller can keep the last-known flags.
 *
 * Two IPC calls plus one per project with saved memory, and no file bodies are
 * read: every surviving rule works off the listing `list_memory_files` already
 * returns (count, size, mtime).
 */
async function checkMemory(now: number): Promise<HealthFlag[]> {
  const projects = await listMemoryProjects("");
  // Per-project listings are independent and `evaluateMemory` is pure, so the
  // round trips run together instead of one-at-a-time. Order is preserved by
  // `Promise.all`, so the resulting flag list is identical.
  const perProject = await Promise.all(
    projects.map(async (project) => {
      const files = await listMemoryFiles(project.dirName);
      return evaluateMemory({ dirName: project.dirName, files, now });
    })
  );
  return perProject.flat();
}

/**
 * Samurai-managed file scan (issue #67): two IPC calls — the file inventory
 * plus the configured `size_warn_bytes` threshold — and no file bodies are
 * read. Throws so the caller can keep the area's last-known flags.
 */
async function checkSecondBrain(): Promise<HealthFlag[]> {
  const [files, config] = await Promise.all([samuraiFilesList(), samuraiGetConfig()]);
  return evaluateSamuraiFiles(files, config.size_warn_bytes);
}

export const useHealthStore = create<HealthState & HealthActions>()((set, get) => ({
  flags: [],
  streaks: {},
  baselineKeys: { memory: null, processes: null, secondbrain: null },
  dismissedKeys: [],
  toasts: [],
  lastCheckedAt: null,
  isChecking: false,

  runCheck: async () => {
    if (get().isChecking) return;
    set({ isChecking: true });
    try {
      const now = Date.now();
      const {
        flags: prevFlags,
        streaks: prevStreaks,
        baselineKeys,
        dismissedKeys,
        toasts,
      } = get();

      // Areas are checked independently: a failing one keeps its last-known
      // flags and its baseline, so a transient error neither clears the badge
      // nor re-toasts everything on recovery.
      const memoryFlags = await checkMemory(now).catch((err) => {
        console.error("Health check (memory) failed:", err);
        return null;
      });

      // Deliberate cost note: this enumerates the whole process table (and
      // shells out for listening ports) once per interval even with the
      // Processes panel closed — roughly 20 scans an hour, against the 1200
      // that panel does per hour while open. Reusing the panel's samples was
      // rejected: they only exist while it is open and focused, which would
      // make a "sustained load" streak depend on whether you happened to be
      // looking. The shared `ProcessScanState` refresh does perturb one of
      // the panel's CPU deltas per interval; that is the price of a single
      // shared probe, and it is documented on the `cpuPercent` threshold.
      const watchlist = useProcessWatchlistStore.getState().watchlist;
      const processResult = await listDevProcesses(watchlist)
        .then((processes) => evaluateProcesses(processes, prevStreaks))
        .catch((err) => {
          console.error("Health check (processes) failed:", err);
          return null;
        });

      const secondBrainFlags = await checkSecondBrain().catch((err) => {
        console.error("Health check (second brain) failed:", err);
        return null;
      });

      const nextBaseline = { ...baselineKeys };
      const newFlags: HealthFlag[] = [];
      const areas: Array<[HealthArea, HealthFlag[] | null]> = [
        ["memory", memoryFlags],
        ["processes", processResult?.flags ?? null],
        ["secondbrain", secondBrainFlags],
      ];
      for (const [area, areaFlags] of areas) {
        if (areaFlags === null) continue;
        newFlags.push(...diffNewFlags(baselineKeys[area], areaFlags));
        nextBaseline[area] = areaFlags.map((f) => f.key);
      }

      const keep = (area: HealthArea) => prevFlags.filter((f) => f.area === area);
      const raised = [
        ...(memoryFlags ?? keep("memory")),
        ...(processResult?.flags ?? keep("processes")),
        ...(secondBrainFlags ?? keep("secondbrain")),
      ];

      // Dismissals only hide what is currently raised; pruning them here is
      // what lets a flag that clears and later returns show up again.
      const raisedKeys = new Set(raised.map((f) => f.key));
      const nextDismissed = dismissedKeys.filter((key) => raisedKeys.has(key));
      const dismissed = new Set(nextDismissed);

      const notificationsEnabled = useGitHubWatchdogStore.getState().notificationsEnabled;
      const queued: HealthToast[] = notificationsEnabled
        ? newFlags
            .filter((flag) => !dismissed.has(flag.key))
            .map((flag) => ({
              id: `health-${++toastSeq}`,
              area: flag.area,
              target: flag.target,
              reason: flag.reason,
            }))
        : [];

      set({
        flags: raised.filter((flag) => !dismissed.has(flag.key)),
        streaks: processResult?.streaks ?? prevStreaks,
        baselineKeys: nextBaseline,
        dismissedKeys: nextDismissed,
        toasts: [...toasts, ...queued].slice(-MAX_TOASTS),
        lastCheckedAt: now,
      });
    } finally {
      set({ isChecking: false });
    }
  },

  dismissFlag: (key) => {
    const { flags, dismissedKeys } = get();
    if (dismissedKeys.includes(key)) return;
    set({
      dismissedKeys: [...dismissedKeys, key],
      flags: flags.filter((f) => f.key !== key),
    });
  },

  dismissToast: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  dismissAllToasts: () => set({ toasts: [] }),
}));

/**
 * Flags for one area, keyed `scope|target` — the identity a section row can
 * reconstruct (memory: `dirName|relPath`; processes: `pid:name|matched`;
 * secondbrain: `path|basename`). Whole flags rather than bare reasons, so a
 * row can also offer to dismiss one.
 */
export function flagsByRow(flags: HealthFlag[], area: HealthArea): Map<string, HealthFlag[]> {
  const map = new Map<string, HealthFlag[]>();
  for (const flag of flags) {
    if (flag.area !== area) continue;
    const rowKey = `${flag.scope}|${flag.target}`;
    const list = map.get(rowKey);
    if (list) {
      list.push(flag);
    } else {
      map.set(rowKey, [flag]);
    }
  }
  return map;
}

/** Number of flags raised in one area — drives the attention badge count. */
export function countForArea(flags: HealthFlag[], area: HealthArea): number {
  return flags.reduce((n, f) => (f.area === area ? n + 1 : n), 0);
}
