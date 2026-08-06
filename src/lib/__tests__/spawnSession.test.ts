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
    usePendingLaunchStore.setState({ pending: null });
    useWorkspaceStore.setState({ tabs: [] });
  });

  it("queues a successor launch through the pending-launch store with the event's args", () => {
    useWorkspaceStore.setState({
      tabs: [tab("tab-other", "C:\\git\\other"), tab("tab-proj", "C:\\git\\proj")],
    });

    emitSpawnEvent(spawnEvent());

    expect(usePendingLaunchStore.getState().pending).toEqual({
      tabId: "tab-proj",
      mode: "Claude",
      resumeSessionId: null,
      workingDirOverride: "C:\\git\\proj-worktrees\\epic-37",
      branch: null,
      customName: "samurai gen-3 37",
      samurai: { project: "C:\\git\\proj", epic: "#37", generation: 3 },
    });
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

    expect(usePendingLaunchStore.getState().pending?.tabId).toBe("tab-proj");
  });

  it("does nothing when no open project tab matches", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    useWorkspaceStore.setState({ tabs: [tab("tab-other", "C:\\git\\other")] });

    emitSpawnEvent(spawnEvent());

    expect(usePendingLaunchStore.getState().pending).toBeNull();
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
