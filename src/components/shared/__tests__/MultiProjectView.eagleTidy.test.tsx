import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nextSessionId = vi.hoisted(() => ({ value: 1 }));

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

// xterm.js cannot mount in happy-dom — stand in the helper textarea the grid
// focuses, labelled with its session and whether the grid has it focused.
vi.mock("@/components/terminal/TerminalView", () => ({
  TerminalView: ({ sessionId, isFocused }: { sessionId: number; isFocused: boolean }) => (
    <textarea
      data-testid={`terminal-${sessionId}`}
      data-focused={String(isFocused)}
      className="xterm-helper-textarea"
    />
  ),
}));

vi.mock("@/lib/terminal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/terminal")>();
  return {
    ...actual,
    // A fresh id per launch: this test launches four terminals.
    spawnShell: vi.fn(async () => nextSessionId.value++),
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
    removeSessionMcpConfig: vi.fn(async () => {}),
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
import type { TileRect } from "@/lib/eagleLayout";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { MultiProjectView, type MultiProjectViewHandle } from "../MultiProjectView";

const invokeMock = vi.mocked(invoke);

const launchedTab: WorkspaceTab = {
  id: "tab-1",
  name: "proj",
  projectPath: "C:/proj",
  active: true,
  sessionIds: [],
  sessionsLaunched: true,
  workspaceType: "single-repo",
  repositories: [],
  selectedRepoPath: null,
  worktreeBasePath: null,
};

/** Let the grid's double requestAnimationFrame focus helpers run. */
async function flushFrames(): Promise<void> {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Launch the first pre-launch card on screen (made-up sessions 1, 2, 3 … in launch order). */
async function launchCard(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Launch Session" })[0]);
  });
  await flushFrames();
}

/** Add a pre-launch card to a project and launch it. */
async function addAndLaunch(ref: RefObject<MultiProjectViewHandle | null>, tabId: string) {
  await act(async () => {
    ref.current?.addSessionInProject(tabId);
  });
  await flushFrames();
  await launchCard();
}

/** Full-height columns of a 60-cell grid, left to right, 15 cells wide each. */
function column(index: number): TileRect {
  return { x: index * 15, y: 0, w: 15, h: 60 };
}

/** Launch four terminals in eagle view, placed two over two reading 2, 3 / 4, 1. */
async function renderFourTiles(): Promise<RefObject<MultiProjectViewHandle | null>> {
  const ref = createRef<MultiProjectViewHandle>();
  render(<MultiProjectView ref={ref} eagleView />);
  await flushFrames();
  await launchCard();
  for (let i = 0; i < 3; i++) await addAndLaunch(ref, "tab-1");
  act(() => {
    useWorkspaceStore.getState().setEagleTileRects({
      2: { x: 0, y: 0, w: 30, h: 30 },
      3: { x: 30, y: 0, w: 30, h: 30 },
      4: { x: 0, y: 30, w: 30, h: 30 },
      1: { x: 30, y: 30, w: 30, h: 30 },
    });
  });
  return ref;
}

describe("MultiProjectView eagle view tidy up (issue #493)", () => {
  beforeEach(() => {
    nextSessionId.value = 1;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_project_hash") return "hash";
      if (cmd === "list_claude_sessions") {
        return { sessions: [], total_found: 0, truncated: false, unreadable: 0 };
      }
      return [];
    });
    useWorkspaceStore.setState({ tabs: [{ ...launchedTab }], eagleTileRects: {} });
  });

  it.each([
    {
      how: "the Tidy up button",
      tidy: (ref: RefObject<MultiProjectViewHandle | null>) => ref.current?.tidyActiveProject(),
    },
    {
      how: "Alt+T",
      tidy: () =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "t", code: "KeyT", altKey: true, bubbles: true }),
        ),
    },
  ])("puts the tiles in one row of full-height columns, in reading order, with $how", async (c) => {
    const ref = await renderFourTiles();

    act(() => {
      c.tidy(ref);
    });

    expect(useWorkspaceStore.getState().eagleTileRects).toEqual({
      2: column(0),
      3: column(1),
      4: column(2),
      1: column(3),
    });
  });
});
