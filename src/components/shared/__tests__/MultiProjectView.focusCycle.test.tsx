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
    // A fresh id per launch: this test launches two terminals.
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

/** The one terminal the grid has focused (its session id). */
function focusedSession(): number {
  const focused = screen.getAllByTestId(/^terminal-/).filter((el) => el.dataset.focused === "true");
  expect(focused).toHaveLength(1);
  return Number(focused[0].dataset.testid?.replace("terminal-", ""));
}

/** The terminal holding the cursor, where typing goes (its session id). */
function cursorSession(): number {
  const testId = (document.activeElement as HTMLElement | null)?.dataset.testid ?? "";
  return Number(testId.replace("terminal-", ""));
}

/** Cmd/Ctrl+Alt+Arrow inside a terminal (both modifiers so any platform matches). */
async function pressCycle(key: "ArrowRight" | "ArrowLeft", sessionId: number): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId(`terminal-${sessionId}`), {
      key,
      altKey: true,
      ctrlKey: true,
      metaKey: true,
    });
  });
  await flushFrames();
}

describe("MultiProjectView Cmd/Ctrl+Alt+Arrow focus cycling", () => {
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
    useWorkspaceStore.setState({ tabs: [{ ...launchedTab }] });
  });

  it.each([
    { view: "project view", eagleView: false, zoomed: false },
    { view: "project view zoomed", eagleView: false, zoomed: true },
    { view: "eagle view", eagleView: true, zoomed: false },
    { view: "eagle view zoomed", eagleView: true, zoomed: true },
  ])("moves to the next and previous terminal, wrapping, in $view", async (c) => {
    const ref = createRef<MultiProjectViewHandle>();
    render(<MultiProjectView ref={ref} eagleView={c.eagleView} />);
    await flushFrames();
    await launchCard();
    await addAndLaunch(ref, "tab-1");
    await addAndLaunch(ref, "tab-1");
    await act(async () => {
      if (c.zoomed) ref.current?.zoomSessionInProject("tab-1", 1);
      else ref.current?.focusSessionInProject("tab-1", 1);
    });
    await flushFrames();
    expect(focusedSession()).toBe(1);

    const seen: number[] = [];
    for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft"] as const) {
      await pressCycle(key, focusedSession());
      seen.push(focusedSession());
    }

    expect(seen).toEqual([2, 3, 1, 3]);
  });

  it("follows the eagle tile order across projects and puts the cursor in the terminal", async () => {
    useWorkspaceStore.setState({
      tabs: [{ ...launchedTab }, { ...launchedTab, id: "tab-2", name: "other", active: false }],
    });
    const ref = createRef<MultiProjectViewHandle>();
    render(<MultiProjectView ref={ref} eagleView />);
    await flushFrames();
    await launchCard(); // session 1 in the first project
    await launchCard(); // session 2 in the second project
    await addAndLaunch(ref, "tab-1"); // session 3 in the first project
    await act(async () => {
      ref.current?.focusSessionInProject("tab-1", 1);
    });
    await flushFrames();

    expect(cursorSession()).toBe(1);

    // Tiles read project by project: 1 and 3 (first project), then 2.
    const seen: number[] = [];
    for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft"] as const) {
      await pressCycle(key, cursorSession());
      seen.push(cursorSession());
    }

    expect(seen).toEqual([3, 2, 1, 2]);
  });
});
