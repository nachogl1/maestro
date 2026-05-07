import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { PullRequestInfo } from "./useGitHubStore";
import { useToastStore } from "./useToastStore";

const POLL_INTERVAL_MS = 60_000;
const STORAGE_KEY = "maestro.prTracking.enabled";

/** Snapshot of one PR's state used to detect transitions. */
interface PRSnapshot {
  state: string;
  mergedAt: string | null;
}

interface PRTrackingState {
  /** Whether to poll for PR movements and emit toasts. Persisted. */
  tracking: boolean;
  /** Toggle and persist. */
  toggleTracking: () => void;
  /** Start polling for a given repo; returns cleanup. */
  start: (repoPath: string) => () => void;
}

/** Snapshot table keyed by `${repoPath}:${prNumber}`. Per-repo so switching repos doesn't cross-fire toasts. */
const snapshots = new Map<string, PRSnapshot>();
/** Whether we've taken a baseline snapshot for the current repo (no toasts on first poll). */
const baselineDone = new Map<string, boolean>();

function loadInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function snapshotKey(repoPath: string, number: number): string {
  return `${repoPath}:${number}`;
}

async function pollOnce(repoPath: string): Promise<void> {
  let prs: PullRequestInfo[];
  try {
    prs = await invoke<PullRequestInfo[]>("github_list_prs", {
      repoPath,
      state: null, // all states so we see merges too
      limit: 50,
      search: null,
    });
  } catch {
    return; // silent on errors so we don't spam the user
  }

  const isBaseline = !baselineDone.get(repoPath);
  const seenNumbers = new Set<number>();
  const pushToast = useToastStore.getState().pushToast;

  for (const pr of prs) {
    seenNumbers.add(pr.number);
    const key = snapshotKey(repoPath, pr.number);
    const prev = snapshots.get(key);

    if (!isBaseline) {
      // PR-movement toasts are persistent (durationMs=0) — a burst of merges
      // shouldn't disappear while the user is away. They dismiss with the X.
      if (!prev && pr.state === "OPEN") {
        pushToast(
          {
            tone: "info",
            title: `PR #${pr.number} opened`,
            body: `${pr.author.login}: ${truncate(pr.title, 80)}`,
            href: pr.url,
          },
          0
        );
      }
      // OPEN → MERGED transition
      else if (prev && prev.state === "OPEN" && pr.mergedAt) {
        pushToast(
          {
            tone: "success",
            title: `PR #${pr.number} merged`,
            body: truncate(pr.title, 100),
            href: pr.url,
          },
          0
        );
      }
    }

    snapshots.set(key, { state: pr.state, mergedAt: pr.mergedAt });
  }

  // Drop snapshots for PRs no longer returned (e.g. dropped from page).
  // Only prune ones for this repo.
  const prefix = `${repoPath}:`;
  for (const key of snapshots.keys()) {
    if (key.startsWith(prefix)) {
      const num = Number(key.slice(prefix.length));
      if (!seenNumbers.has(num)) snapshots.delete(key);
    }
  }

  baselineDone.set(repoPath, true);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export const usePRTrackingStore = create<PRTrackingState>()((set, get) => ({
  tracking: loadInitial(),

  toggleTracking: () => {
    const next = !get().tracking;
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
    set({ tracking: next });
  },

  start: (repoPath: string) => {
    // Reset baseline for this repo so we don't flood with notifications on first poll.
    baselineDone.set(repoPath, false);
    let stopped = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (stopped) return;
      await pollOnce(repoPath);
      if (stopped) return;
      timeoutId = setTimeout(tick, POLL_INTERVAL_MS);
    };

    tick();

    return () => {
      stopped = true;
      if (timeoutId) clearTimeout(timeoutId);
      // Forget snapshots for this repo so a re-enable starts clean.
      const prefix = `${repoPath}:`;
      for (const key of snapshots.keys()) {
        if (key.startsWith(prefix)) snapshots.delete(key);
      }
      baselineDone.delete(repoPath);
    };
  },
}));
