import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
// The watchdog store persists through the Tauri store plugin; happy-dom has
// no Tauri backend, so stub it out (same as useSessionStore.samuraiFatal).
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));
vi.mock("@/lib/osNotification", () => ({
  notifyOs: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";

import { notifyOs } from "@/lib/osNotification";
import type { SamuraiRunListEntry } from "@/lib/samurai";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import {
  initSamuraiSupervisorListener,
  stopSamuraiSupervisorListener,
  useSessionStore,
} from "../useSessionStore";

const invokeMock = vi.mocked(invoke);

/** The dead Nido run as `samurai_list_runs` really returns it. */
function run(overrides: Partial<SamuraiRunListEntry> = {}): SamuraiRunListEntry {
  return {
    project_path: "C:/git/nido",
    epic: "epics #38, #39",
    epics: [],
    issues: [],
    launch_text: null,
    repo_pin: null,
    worktree_path: "C:/wt/nido-38",
    model: null,
    thresholds: null,
    workflow: null,
    run_number: 0,
    display_name: null,
    status: "ACTIVE",
    interrupted_at: { at: "2026-08-20T10:00:00Z", prior_generation: 2 },
    created_at: "2026-08-19T09:00:00Z",
    orchestrator: {
      generation: null,
      session_id: null,
      model: null,
      context_window: null,
      context_percent: null,
    },
    ...overrides,
  };
}

/** Routes the invoke mock; only the run list matters to this seed. */
function mockRuns(runs: SamuraiRunListEntry[]) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "samurai_list_runs") return runs;
    return undefined;
  });
}

/** A fresh listener lifetime, so the seed runs against the current mock. */
async function restartListener() {
  stopSamuraiSupervisorListener();
  await initSamuraiSupervisorListener();
  // The seed is fire-and-forget inside init; let its promise chain settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * FIX 4: cold-start reconciliation runs in the Tauri setup closure, before
 * App mounts the supervisor listener, and Tauri buffers no events — so the
 * `reconcile_interrupted` ALERT is emitted to nobody on the one path that
 * matters. The seed reads the LATCHED state off the run list instead.
 */
describe("interrupted-run startup seed", () => {
  beforeEach(() => {
    useSessionStore.setState({ samuraiToasts: [], attentionSessionIds: [] });
    useGitHubWatchdogStore.setState({ notificationsEnabled: true });
    vi.mocked(notifyOs).mockClear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("toasts an already-interrupted run with no live event at all", async () => {
    mockRuns([run()]);

    await restartListener();

    const toasts = useSessionStore.getState().samuraiToasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      kind: "fatal",
      project: "C:/git/nido",
      epic: "epics #38, #39",
      // The generation it died at, straight off the latch.
      generation: 2,
      label: "Run was interrupted — resume or abandon it",
    });
    // The surface that reaches the user while Maestro is minimized — the
    // situation the real run actually died in.
    expect(vi.mocked(notifyOs).mock.calls).toEqual([
      [
        "Samurai run needs you — nido",
        "Run was interrupted — resume or abandon it (epics #38, #39)",
      ],
    ]);
  });

  it("stays quiet for healthy, completed and archived-away runs", async () => {
    mockRuns([
      // Healthy: never stamped.
      run({ epic: "#1", interrupted_at: null }),
      // Finished-awaiting-cleanup is not a dead run.
      run({ epic: "#2", status: "COMPLETED" }),
    ]);

    await restartListener();

    expect(useSessionStore.getState().samuraiToasts).toEqual([]);
    expect(notifyOs).not.toHaveBeenCalled();
  });

  it("honours the notifications toggle", async () => {
    useGitHubWatchdogStore.setState({ notificationsEnabled: false });
    mockRuns([run()]);

    await restartListener();

    expect(useSessionStore.getState().samuraiToasts).toEqual([]);
    expect(notifyOs).not.toHaveBeenCalled();
  });

  it("survives a backend that answers with nothing", async () => {
    invokeMock.mockResolvedValue(undefined);

    await restartListener();

    expect(useSessionStore.getState().samuraiToasts).toEqual([]);
  });
});
