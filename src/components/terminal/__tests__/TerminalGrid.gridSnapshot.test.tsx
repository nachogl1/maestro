import { act, render, screen } from "@testing-library/react";
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
// Records each pane's props so tests can check what the grid passed down.
const terminalViewProps: Array<{ sessionId: number; replayOutput?: boolean }> = [];
vi.mock("../TerminalView", () => ({
  TerminalView: (props: { sessionId: number; replayOutput?: boolean }) => {
    terminalViewProps.push(props);
    return <div data-testid="terminal-view" data-session-id={props.sessionId} />;
  },
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
import type { SessionSlot } from "@/components/terminal/PreLaunchCard";
import type { GridSnapshot } from "@/lib/projectWindow";
import { killSession, spawnShell } from "@/lib/terminal";
import { createLeaf } from "../splitTree";
import { TerminalGrid, type TerminalGridHandle } from "../TerminalGrid";

const invokeMock = vi.mocked(invoke);
const killSessionMock = vi.mocked(killSession);
const spawnShellMock = vi.mocked(spawnShell);

/** A launched slot, as a grid in another window would export it. */
function launchedSlot(id: string, sessionId: number): SessionSlot {
  return {
    id,
    mode: "Claude",
    branch: null,
    customName: "",
    worktreeMode: "project",
    sessionId,
    worktreePath: null,
    worktreeWarning: null,
    enabledMcpServers: [],
    enabledSkills: [],
    enabledPlugins: [],
    mcpDefaultsApplied: true,
    skillsDefaultsApplied: true,
    pluginsDefaultsApplied: true,
  };
}

function seededSnapshot(): GridSnapshot {
  return {
    slots: [launchedSlot("slot-a", 41), launchedSlot("slot-b", 42)],
    layoutTree: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      ratio: 0.5,
      children: [createLeaf("slot-a"), createLeaf("slot-b")],
    },
  };
}

describe("TerminalGrid snapshots (project pop-out windows)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_project_hash") return "hash";
      if (cmd === "list_claude_sessions") {
        return { sessions: [], total_found: 0, truncated: false, unreadable: 0 };
      }
      // Everything else the card/grid probes is a list.
      return [];
    });
    terminalViewProps.length = 0;
    killSessionMock.mockClear();
    spawnShellMock.mockClear();
  });

  it("rebuilds panes for the snapshot's running sessions without spawning shells", () => {
    render(
      <TerminalGrid
        projectPath="C:/proj"
        tabId="tab-1"
        isActive
        preserveOnHide
        initialGridState={seededSnapshot()}
      />,
    );
    const ids = screen.getAllByTestId("terminal-view").map((el) => el.dataset.sessionId);
    expect(ids.sort()).toEqual(["41", "42"]);
    expect(spawnShellMock).not.toHaveBeenCalled();
  });

  it("exports the seeded panes and layout unchanged", () => {
    const ref = createRef<TerminalGridHandle>();
    const snapshot = seededSnapshot();
    render(
      <TerminalGrid
        ref={ref}
        projectPath="C:/proj"
        tabId="tab-1"
        isActive
        preserveOnHide
        initialGridState={snapshot}
      />,
    );
    expect(ref.current?.exportGridState()).toEqual(snapshot);
  });

  it("starts with one empty slot when no snapshot is given", () => {
    const ref = createRef<TerminalGridHandle>();
    render(<TerminalGrid ref={ref} projectPath="C:/proj" tabId="tab-1" isActive />);
    const exported = ref.current?.exportGridState();
    expect(exported?.slots).toHaveLength(1);
    expect(exported?.slots[0].sessionId).toBeNull();
  });

  it("starts with one empty slot when the snapshot has no slots", () => {
    const ref = createRef<TerminalGridHandle>();
    render(
      <TerminalGrid
        ref={ref}
        projectPath="C:/proj"
        tabId="tab-1"
        isActive
        initialGridState={{ slots: [], layoutTree: createLeaf("gone") }}
      />,
    );
    expect(ref.current?.exportGridState().slots).toHaveLength(1);
  });

  it("reports its state through onGridStateChange", () => {
    const onGridStateChange = vi.fn();
    const snapshot = seededSnapshot();
    render(
      <TerminalGrid
        projectPath="C:/proj"
        tabId="tab-1"
        isActive
        preserveOnHide
        initialGridState={snapshot}
        onGridStateChange={onGridStateChange}
      />,
    );
    expect(onGridStateChange).toHaveBeenLastCalledWith(snapshot);
  });

  it("passes replayOutput down to every terminal pane", () => {
    render(
      <TerminalGrid
        projectPath="C:/proj"
        tabId="tab-1"
        isActive
        preserveOnHide
        initialGridState={seededSnapshot()}
        replayOutput
      />,
    );
    expect(terminalViewProps.length).toBeGreaterThan(0);
    expect(terminalViewProps.every((p) => p.replayOutput === true)).toBe(true);
  });

  it("leaves the sessions running when unmounted with preserveOnHide (moving windows)", async () => {
    const { unmount } = render(
      <TerminalGrid
        projectPath="C:/proj"
        tabId="tab-1"
        isActive
        preserveOnHide
        initialGridState={seededSnapshot()}
      />,
    );
    await act(async () => {
      unmount();
    });
    expect(killSessionMock).not.toHaveBeenCalled();
  });
});
