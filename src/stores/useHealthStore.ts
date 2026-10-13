import { create } from "zustand";
import {
  diffNewFlags,
  evaluateSamuraiFiles,
  type HealthArea,
  type HealthFlag,
} from "@/lib/healthRules";
import { samuraiFilesList, samuraiGetConfig } from "@/lib/samurai";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";

/**
 * Background health checker: pure rules over data Maestro already fetches,
 * run every few minutes. It raises attention badges and one-line reasons; it
 * never touches a Samurai-managed file.
 *
 * Follows the GitHub watchdog's shape — a reducer over samples, transition-only
 * toasts, first-run suppression — but polls from the frontend rather than a
 * Rust task, because every input is already a frontend command.
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
   * Runs one full check across every Samurai-managed file. Takes no
   * arguments: the rules read only the Samurai inventory, never the open
   * workspace.
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
 * Samurai-managed file scan (issue #67): two IPC calls — the file inventory
 * plus the configured `size_warn_bytes` threshold — and no file bodies are
 * read. Throws so the caller can keep the area's last-known flags.
 */
async function checkSecondBrain(): Promise<HealthFlag[]> {
  const [listing, config] = await Promise.all([samuraiFilesList(), samuraiGetConfig()]);
  return evaluateSamuraiFiles(listing.entries, config.size_warn_bytes);
}

export const useHealthStore = create<HealthState & HealthActions>()((set, get) => ({
  flags: [],
  baselineKeys: { secondbrain: null },
  dismissedKeys: [],
  toasts: [],
  lastCheckedAt: null,
  isChecking: false,

  runCheck: async () => {
    if (get().isChecking) return;
    set({ isChecking: true });
    try {
      const now = Date.now();
      const { flags: prevFlags, baselineKeys } = get();

      // A failing check keeps its last-known flags and its baseline, so a
      // transient error neither clears the badge nor re-toasts everything on
      // recovery.
      const secondBrainFlags = await checkSecondBrain().catch((err) => {
        console.error("Health check (second brain) failed:", err);
        return null;
      });

      const nextBaseline = { ...baselineKeys };
      const newFlags: HealthFlag[] = [];
      if (secondBrainFlags !== null) {
        newFlags.push(...diffNewFlags(baselineKeys.secondbrain, secondBrainFlags));
        nextBaseline.secondbrain = secondBrainFlags.map((f) => f.key);
      }

      const raised = secondBrainFlags ?? prevFlags.filter((f) => f.area === "secondbrain");

      // Read dismissals and toasts here rather than before the await above:
      // that takes a while, and a flag or toast the user dismissed while the
      // check was in flight must not be resurrected by a stale snapshot.
      // Nothing can interleave between this read and the `set` below — there
      // is no await between them.
      const { dismissedKeys, toasts } = get();

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
 * reconstruct (secondbrain: `path|basename`). Whole flags rather than bare
 * reasons, so a row can also offer to dismiss one.
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
