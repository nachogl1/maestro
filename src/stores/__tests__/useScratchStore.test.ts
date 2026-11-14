import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@/lib/terminal", () => ({
  killSession: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { useScratchStore } from "../useScratchStore";
import { useWorkspaceStore, type WorkspaceTab } from "../useWorkspaceStore";

const mockInvoke = vi.mocked(invoke);

const FOLDER = "/home/someone/Maestro Scratch";
const SCRATCH_PATH = `${FOLDER}/demo`;
/** A real folder in the scratch folder that Maestro never made (no marker, so never listed). */
const REAL_IN_FOLDER = `${FOLDER}/real-work`;

function tab(id: string, projectPath: string, sessionIds: number[] = []): WorkspaceTab {
  return {
    id,
    name: projectPath.split("/").pop() ?? id,
    projectPath,
    active: false,
    sessionIds,
    sessionsLaunched: sessionIds.length > 0,
    workspaceType: "non-git",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
  };
}

function calls(command: string) {
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === command);
}

describe("useScratchStore", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "scratch_list") return { folder: FOLDER, projects: [] };
      if (cmd === "scratch_create") return SCRATCH_PATH;
      if (cmd === "remove_sessions_for_project") return [];
      return undefined;
    });
    useScratchStore.setState({
      folderSetting: null,
      folder: FOLDER,
      projects: [{ name: "demo", path: SCRATCH_PATH, createdAtMs: 1 }],
      error: null,
      question: null,
    });
    useWorkspaceStore.setState({
      tabs: [tab("scratch", SCRATCH_PATH, [1]), tab("real", "/home/someone/git/app", [2])],
    });
  });

  it("makes a scratch project in the folder chosen in Settings and returns its path", async () => {
    useScratchStore.setState({ folderSetting: "/data/scratch" });

    const path = await useScratchStore.getState().create("demo");

    expect(path).toBe(SCRATCH_PATH);
    expect(calls("scratch_create")).toEqual([
      ["scratch_create", { folder: "/data/scratch", name: "demo" }],
    ]);
  });

  it("rejects a refused name with the backend's sentence", async () => {
    mockInvoke.mockRejectedValueOnce('A scratch project named "demo" already exists.');

    await expect(useScratchStore.getState().create("demo")).rejects.toThrow(
      'A scratch project named "demo" already exists.',
    );
  });

  it("lists the scratch folder named in Settings once it changes", async () => {
    mockInvoke.mockImplementation(async (cmd, args) =>
      cmd === "scratch_list"
        ? {
            folder: (args as { folder: string }).folder,
            projects: [{ name: "kept", path: "/data/scratch/kept", createdAtMs: 1 }],
          }
        : undefined,
    );

    await useScratchStore.getState().setFolderSetting("/data/scratch");

    const state = useScratchStore.getState();
    expect(state.folder).toBe("/data/scratch");
    expect(state.projects.map((p) => p.name)).toEqual(["kept"]);
  });

  it("asks before closing a scratch project's tab, never a normal project's", () => {
    const store = useScratchStore.getState();

    expect(store.askBeforeClosingTab("real")).toBe(false);
    expect(useScratchStore.getState().question).toBeNull();

    expect(store.askBeforeClosingTab("scratch")).toBe(true);
    expect(useScratchStore.getState().question).toMatchObject({
      tabId: "scratch",
      path: SCRATCH_PATH,
      reason: "close-tab",
      runningCount: 1,
    });
  });

  it("asks after a terminal closes only when it was the scratch project's last one", () => {
    const store = useScratchStore.getState();

    store.askAfterTerminalClosed("scratch"); // terminal 1 still runs
    expect(useScratchStore.getState().question).toBeNull();

    useWorkspaceStore.setState({
      tabs: [tab("scratch", SCRATCH_PATH), tab("real", "/home/someone/git/app")],
    });
    store.askAfterTerminalClosed("real");
    expect(useScratchStore.getState().question).toBeNull();

    store.askAfterTerminalClosed("scratch");
    expect(useScratchStore.getState().question?.reason).toBe("last-terminal");
  });

  it("asks nothing for a folder in the scratch folder that Maestro did not make", () => {
    useWorkspaceStore.setState({ tabs: [tab("unmarked", REAL_IN_FOLDER)] });
    const store = useScratchStore.getState();

    expect(store.isScratch(REAL_IN_FOLDER)).toBe(false);
    expect(store.askBeforeClosingTab("unmarked")).toBe(false);
    store.askAfterTerminalClosed("unmarked");

    expect(useScratchStore.getState().question).toBeNull();
  });

  it("Keep on closing the tab closes it and leaves the folder", async () => {
    useScratchStore.getState().askBeforeClosingTab("scratch");

    await useScratchStore.getState().answer("keep");

    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(["real"]);
    expect(calls("scratch_delete")).toHaveLength(0);
    expect(useScratchStore.getState().question).toBeNull();
  });

  it("Keep after the last terminal leaves the tab and the folder", async () => {
    useWorkspaceStore.setState({ tabs: [tab("scratch", SCRATCH_PATH)] });
    useScratchStore.getState().askAfterTerminalClosed("scratch");

    await useScratchStore.getState().answer("keep");

    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(["scratch"]);
    expect(calls("scratch_delete")).toHaveLength(0);
  });

  it("dismissing the question leaves the tab open", async () => {
    useScratchStore.getState().askBeforeClosingTab("scratch");

    await useScratchStore.getState().answer("cancel");

    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(["scratch", "real"]);
    expect(useScratchStore.getState().question).toBeNull();
  });

  it("Delete closes the tab first, then deletes the folder", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "scratch_delete") {
        // The tab and its terminals are gone before the folder is removed.
        expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual(["real"]);
      }
      if (cmd === "remove_sessions_for_project") return [];
      return cmd === "scratch_list" ? { folder: FOLDER, projects: [] } : undefined;
    });
    useScratchStore.getState().askBeforeClosingTab("scratch");

    await useScratchStore.getState().answer("delete");

    expect(calls("scratch_delete")).toEqual([
      ["scratch_delete", { folder: null, path: SCRATCH_PATH }],
    ]);
    expect(useScratchStore.getState().question).toBeNull();
  });

  it("a failed delete keeps the question open with the reason", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "scratch_delete")
        throw "Only a folder directly inside the scratch folder can be deleted.";
      if (cmd === "remove_sessions_for_project") return [];
      return cmd === "scratch_list" ? { folder: FOLDER, projects: [] } : undefined;
    });
    useScratchStore.getState().askBeforeClosingTab("scratch");

    await useScratchStore.getState().answer("delete");

    const state = useScratchStore.getState();
    expect(state.question?.path).toBe(SCRATCH_PATH);
    expect(state.error).toBe("Only a folder directly inside the scratch folder can be deleted.");
  });
});
