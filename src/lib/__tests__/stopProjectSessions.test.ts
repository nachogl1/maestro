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
import { killSession } from "@/lib/terminal";
import { useScratchStore } from "@/stores/useScratchStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { stopProjectSessions } from "../stopProjectSessions";

const FOLDER = "/home/someone/Maestro Scratch";

function tab(id: string, projectPath: string, sessionIds: number[]): WorkspaceTab {
  return {
    id,
    name: id,
    projectPath,
    active: true,
    sessionIds,
    sessionsLaunched: sessionIds.length > 0,
    workspaceType: "non-git",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
  };
}

function seedSessions(projectPath: string, ids: number[]): void {
  useSessionStore.setState({
    sessions: ids.map(
      (id) => ({ id, project_path: projectPath, mode: "Shell", name: "t" }) as SessionConfig,
    ),
  });
}

describe("stopProjectSessions (sidebar Stop All)", () => {
  beforeEach(() => {
    vi.mocked(killSession).mockClear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "remove_sessions_for_project" ? [] : undefined,
    );
    useScratchStore.setState({ folder: FOLDER, question: null, error: null });
  });

  it("stops every terminal of the project and drops them from its tab", async () => {
    useWorkspaceStore.setState({ tabs: [tab("real", "/home/someone/git/app", [1, 2])] });
    seedSessions("/home/someone/git/app", [1, 2]);

    await stopProjectSessions("real", "/home/someone/git/app");

    expect(vi.mocked(killSession).mock.calls.map(([id]) => id)).toEqual([1, 2]);
    expect(useWorkspaceStore.getState().tabs[0].sessionIds).toEqual([]);
    expect(useScratchStore.getState().question).toBeNull();
  });

  it("on a scratch project asks delete or keep, like any last-terminal close", async () => {
    const path = `${FOLDER}/demo`;
    useWorkspaceStore.setState({ tabs: [tab("scratch", path, [1, 2])] });
    seedSessions(path, [1, 2]);

    await stopProjectSessions("scratch", path);

    expect(useScratchStore.getState().question).toMatchObject({
      tabId: "scratch",
      reason: "last-terminal",
    });
  });

  it("asks nothing when the scratch project had no terminal to stop", async () => {
    const path = `${FOLDER}/demo`;
    useWorkspaceStore.setState({ tabs: [tab("scratch", path, [])] });
    seedSessions(path, []);

    await stopProjectSessions("scratch", path);

    expect(useScratchStore.getState().question).toBeNull();
  });
});
