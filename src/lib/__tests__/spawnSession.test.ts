import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store/lib modules (same order
// discipline as useSessionStore.samuraiSupervisor.test.ts).
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  initSamuraiSpawnListener,
  registerSamuraiSuccessor,
  samuraiSuccessorCliFlags,
  successorLaunchImminent,
  type SamuraiSpawnSuccessorEvent,
} from "../spawnSession";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";

const listenMock = vi.mocked(listen);
const invokeMock = vi.mocked(invoke);

function tab(id: string, projectPath: string): WorkspaceTab {
  return {
    id,
    name: id,
    projectPath,
    active: true,
    sessionIds: [],
    sessionsLaunched: false,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
  };
}

function spawnEvent(overrides: Partial<SamuraiSpawnSuccessorEvent> = {}): SamuraiSpawnSuccessorEvent {
  return {
    project: "C:\\git\\proj",
    epic: "#37",
    generation: 3,
    working_dir: "C:\\git\\proj-worktrees\\epic-37",
    session_name: "samurai gen-3 37",
    ...overrides,
  };
}

/** Captured event handler, so tests can fire samurai-spawn-successor. */
let emitSpawnEvent: (payload: SamuraiSpawnSuccessorEvent) => void;

beforeAll(async () => {
  listenMock.mockImplementation(((event: string, handler: (e: unknown) => void) => {
    if (event === "samurai-spawn-successor") {
      emitSpawnEvent = (payload) => handler({ payload });
    }
    return Promise.resolve(() => {});
  }) as typeof listen);
  await initSamuraiSpawnListener();
});

describe("samurai successor spawn listener (issue #55)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    usePendingLaunchStore.setState({ pending: [] });
    useWorkspaceStore.setState({ tabs: [] });
  });

  it("queues a successor launch through the pending-launch store with the event's args", () => {
    useWorkspaceStore.setState({
      tabs: [tab("tab-other", "C:\\git\\other"), tab("tab-proj", "C:\\git\\proj")],
    });

    emitSpawnEvent(spawnEvent());

    expect(usePendingLaunchStore.getState().pending).toEqual([
      {
        tabId: "tab-proj",
        mode: "Claude",
        resumeSessionId: null,
        workingDirOverride: "C:\\git\\proj-worktrees\\epic-37",
        branch: null,
        customName: "samurai gen-3 37",
        samurai: { project: "C:\\git\\proj", epic: "#37", generation: 3 },
      },
    ]);
  });

  it("two successor spawn events in one tick both stay queued (finding B)", () => {
    useWorkspaceStore.setState({
      tabs: [tab("tab-a", "C:\\git\\a"), tab("tab-b", "C:\\git\\b")],
    });

    emitSpawnEvent(spawnEvent({ project: "C:\\git\\a", epic: "#1", generation: 2 }));
    emitSpawnEvent(spawnEvent({ project: "C:\\git\\b", epic: "#2", generation: 5 }));

    const pending = usePendingLaunchStore.getState().pending;
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ tabId: "tab-a", samurai: { epic: "#1" } });
    expect(pending[1]).toMatchObject({ tabId: "tab-b", samurai: { epic: "#2" } });
  });

  it("mounts the project's grid so the queued launch is consumed", () => {
    useWorkspaceStore.setState({ tabs: [tab("tab-proj", "C:\\git\\proj")] });

    emitSpawnEvent(spawnEvent());

    expect(useWorkspaceStore.getState().tabs[0].sessionsLaunched).toBe(true);
  });

  it("matches the project tab case- and prefix-insensitively (canonical backend paths)", () => {
    // The backend sends canonicalized paths; the tab may have been opened
    // with different casing.
    useWorkspaceStore.setState({ tabs: [tab("tab-proj", "c:\\Git\\Proj")] });

    emitSpawnEvent(spawnEvent({ project: "C:\\git\\proj" }));

    expect(usePendingLaunchStore.getState().pending[0]?.tabId).toBe("tab-proj");
  });

  it("does nothing when no open project tab matches", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    useWorkspaceStore.setState({ tabs: [tab("tab-other", "C:\\git\\other")] });

    emitSpawnEvent(spawnEvent());

    expect(usePendingLaunchStore.getState().pending).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("registerSamuraiSuccessor invokes samurai_register_session with the event's identity", async () => {
    await registerSamuraiSuccessor(42, { project: "C:\\git\\proj", epic: "#37", generation: 3 });

    expect(invokeMock).toHaveBeenCalledWith("samurai_register_session", {
      sessionId: 42,
      projectPath: "C:\\git\\proj",
      epic: "#37",
      generation: 3,
    });
  });

  it("samuraiSuccessorCliFlags forces skip-permissions and keeps custom flags", () => {
    expect(samuraiSuccessorCliFlags({ skipPermissions: false, customFlags: "--verbose" })).toEqual({
      skipPermissions: true,
      customFlags: "--verbose",
    });
    expect(samuraiSuccessorCliFlags({ skipPermissions: true, customFlags: "" })).toEqual({
      skipPermissions: true,
      customFlags: "",
    });
  });
});

// Fresh-eyes finding A: when the killed predecessor was the project's ONLY
// session, TerminalGrid's last-slot kill path must NOT return to the landing
// view (which unmounts the grid and destroys the launch) while a successor
// launch is queued or already claimed. This is the pure decision, exercised
// across the interleavings of the KILLED event vs the spawn event.
describe("successorLaunchImminent (finding A last-slot guard)", () => {
  beforeEach(() => {
    usePendingLaunchStore.setState({ pending: [] });
    useWorkspaceStore.setState({ tabs: [tab("tab-proj", "C:\\git\\proj")] });
  });

  it("is false with nothing queued and nothing claimed (normal last-slot close)", () => {
    expect(successorLaunchImminent([], 0, "tab-proj")).toBe(false);
  });

  it("KILLED lands after the spawn event queued but before the grid consumed: queue wins", () => {
    emitSpawnEvent(spawnEvent());
    const queued = usePendingLaunchStore.getState().pending;

    expect(successorLaunchImminent(queued, 0, "tab-proj")).toBe(true);
    // A different project's grid is unaffected by the queued launch.
    expect(successorLaunchImminent(queued, 0, "tab-other")).toBe(false);
  });

  it("KILLED lands after the grid consumed but before the deferred launch fired: claim wins", () => {
    emitSpawnEvent(spawnEvent());
    // The grid's consume effect claims the launch (store drains) and holds
    // the configured slot id until the deferred launch effect fires.
    const claimed = usePendingLaunchStore.getState().consume("tab-proj");
    expect(claimed).not.toBeNull();
    const queued = usePendingLaunchStore.getState().pending;
    expect(queued).toEqual([]);

    expect(successorLaunchImminent(queued, 1, "tab-proj")).toBe(true);
    // Claims are grid-local, so they guard even without a tab id.
    expect(successorLaunchImminent(queued, 1, undefined)).toBe(true);
  });

  it("after the deferred launch fired nothing holds the grid: back to false", () => {
    emitSpawnEvent(spawnEvent());
    usePendingLaunchStore.getState().consume("tab-proj");
    // launchSlot took over; the claim list is empty again.
    expect(successorLaunchImminent(usePendingLaunchStore.getState().pending, 0, "tab-proj")).toBe(
      false,
    );
  });

  it("is false without a tab id when nothing is claimed", () => {
    emitSpawnEvent(spawnEvent());
    expect(successorLaunchImminent(usePendingLaunchStore.getState().pending, 0, undefined)).toBe(
      false,
    );
  });
});
