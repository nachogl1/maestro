import { act, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted zustand stores hydrate through the Tauri store plugin at
// import time; happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

// useTerminalDragDrop subscribes to the real Tauri window on mount.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: async () => () => {},
  }),
}));

// xterm.js cannot mount in happy-dom — the grid only needs a pane placeholder.
vi.mock("../TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));

vi.mock("@/lib/terminal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/terminal")>();
  return {
    ...actual,
    spawnShell: vi.fn(async () => 1),
    createSession: vi.fn(async (id: number) => ({
      id,
      mode: "Claude",
      branch: null,
      status: "Working",
      worktree_path: null,
      project_path: "C:/proj",
      name: null,
    })),
    // Skips the CLI-launch half of launchSlotInner — this test only needs a
    // slot that owns a session id.
    checkCliAvailable: vi.fn(async () => false),
    killSession: vi.fn(async () => {}),
    assignSessionBranch: vi.fn(async () => ({ branch: null, worktree_path: null })),
    waitForTerminalReady: vi.fn(async () => {}),
    writeStdin: vi.fn(async () => {}),
    writeSessionHooksConfig: vi.fn(async () => {}),
    removeSessionHooksConfig: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp")>();
  return {
    ...actual,
    getProjectMcpServers: vi.fn(async () => []),
    loadProjectMcpDefaults: vi.fn(async () => null),
    setSessionMcpServers: vi.fn(async () => {}),
    writeSessionMcpConfig: vi.fn(async () => {}),
    writeOpenCodeMcpConfig: vi.fn(async () => {}),
    removeSessionMcpConfig: vi.fn(async () => {}),
    removeOpenCodeMcpConfig: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/plugins")>();
  return {
    ...actual,
    getProjectPlugins: vi.fn(async () => ({ plugins: [], skills: [] })),
    loadProjectSkillDefaults: vi.fn(async () => null),
    loadProjectPluginDefaults: vi.fn(async () => null),
    loadBranchConfig: vi.fn(async () => null),
    saveBranchConfig: vi.fn(async () => {}),
    setSessionSkills: vi.fn(async () => {}),
    setSessionPlugins: vi.fn(async () => {}),
    writeSessionPluginConfig: vi.fn(async () => {}),
    removeSessionPluginConfig: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git")>();
  return {
    ...actual,
    getBranchesWithWorktreeStatus: vi.fn(async () => []),
    invalidateCurrentBranchCache: vi.fn(),
  };
});

vi.mock("@/lib/worktreeManager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktreeManager")>();
  return {
    ...actual,
    prepareSessionWorktree: vi.fn(),
    cleanupSessionWorktree: vi.fn(async () => {}),
  };
});

import { invoke } from "@tauri-apps/api/core";
import { spawnShell } from "@/lib/terminal";
import { useMcpStore } from "@/stores/useMcpStore";
import { usePluginStore } from "@/stores/usePluginStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { TerminalGrid, type TerminalGridHandle } from "../TerminalGrid";

const invokeMock = vi.mocked(invoke);
const spawnShellMock = vi.mocked(spawnShell);

describe("TerminalGrid onAllSessionsClosed", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_project_hash") return "hash";
      if (cmd === "list_claude_sessions") {
        return { sessions: [], total_found: 0, truncated: false, unreadable: 0 };
      }
      return [];
    });
    let nextId = 100;
    spawnShellMock.mockReset();
    spawnShellMock.mockImplementation(async () => nextId++);
    useSessionStore.setState({ sessions: [], samuraiBySessionId: {}, parkedSessionIds: [] });
    useMcpStore.setState({ projectServers: {} });
    usePluginStore.setState({ projectSkills: {}, projectPlugins: {} });
  });

  it("does not fire again when MCP servers, skills or plugins change after all slots closed", async () => {
    const onAllSessionsClosed = vi.fn();
    const ref = createRef<TerminalGridHandle>();
    render(
      <TerminalGrid
        ref={ref}
        projectPath="C:/proj"
        tabId="tab-1"
        isActive
        onAllSessionsClosed={onAllSessionsClosed}
      />,
    );
    const handle = ref.current;
    if (!handle) throw new Error("expected TerminalGrid ref to be attached");
    await act(async () => {
      handle.addSession();
    });
    await act(async () => {
      await handle.launchAll();
    });
    await waitFor(() => expect(useSessionStore.getState().sessions).toHaveLength(2));
    const ids = useSessionStore.getState().sessions.map((s) => s.id);

    // Killing both in one batch takes the in-place removal path for each, so
    // the grid reaches zero slots and the closed effect fires.
    await act(async () => {
      for (const id of ids) handle.killSessionById(id);
    });
    await waitFor(() => expect(onAllSessionsClosed).toHaveBeenCalledTimes(1));

    // A late fetch landing while the grid is still mounted must not re-fire it.
    await act(async () => {
      useMcpStore.setState({
        projectServers: { "C:/proj": [{ name: "srv" } as never] },
      });
    });
    await act(async () => {
      usePluginStore.setState({
        projectSkills: { "C:/proj": [{ id: "skill-a" } as never] },
        projectPlugins: { "C:/proj": [{ id: "plugin-a", enabled_by_default: true } as never] },
      });
    });

    expect(onAllSessionsClosed).toHaveBeenCalledTimes(1);
  });
});
