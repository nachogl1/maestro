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
    // A fresh id per launch: this test launches three terminals.
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
import { useParkedOrderStore } from "@/stores/useParkedOrderStore";
import { useSessionStore } from "@/stores/useSessionStore";
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

/** The terminal holding the cursor, where typing goes (its session id). */
function cursorSession(): number {
  const testId = (document.activeElement as HTMLElement | null)?.dataset.testid ?? "";
  return Number(testId.replace("terminal-", ""));
}

/** The parked-shelf chip of a session. */
function parkedChip(sessionId: number): HTMLElement {
  const chip = document.querySelector<HTMLElement>(`[data-parked-session-id="${sessionId}"]`);
  if (!chip) throw new Error(`no parked chip for session ${sessionId}`);
  return chip;
}

async function press(target: EventTarget, init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, init);
  });
  await flushFrames();
}

const ALT_U = { code: "KeyU", key: "u", altKey: true };

describe("MultiProjectView restoring parked terminals from the keyboard", () => {
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
    useSessionStore.setState({ parkedSessionIds: [] });
    useParkedOrderStore.setState({ order: [] });
  });

  it.each([
    { view: "project view", eagleView: false, zoomed: false },
    { view: "project view zoomed", eagleView: false, zoomed: true },
    { view: "eagle view", eagleView: true, zoomed: false },
    { view: "eagle view zoomed", eagleView: true, zoomed: true },
  ])("Alt+U, Enter, Enter keeps the cursor in the shelf until Alt+U, in $view", async (c) => {
    const ref = createRef<MultiProjectViewHandle>();
    render(<MultiProjectView ref={ref} eagleView={c.eagleView} />);
    await flushFrames();
    await launchCard();
    await addAndLaunch(ref, "tab-1");
    await addAndLaunch(ref, "tab-1");
    await addAndLaunch(ref, "tab-1");
    await act(async () => {
      if (c.zoomed) ref.current?.zoomSessionInProject("tab-1", 1);
      else ref.current?.focusSessionInProject("tab-1", 1);
    });
    await flushFrames();
    await act(async () => {
      for (const id of [2, 3, 4]) useSessionStore.getState().parkSession(id);
    });
    await flushFrames();
    expect(cursorSession()).toBe(1);

    await press(window, ALT_U);
    expect(parkedChip(2)).toHaveFocus();

    await press(parkedChip(2), { key: "Enter" });
    expect(parkedChip(3)).toHaveFocus();
    await press(parkedChip(3), { key: "Enter" });
    expect(parkedChip(4)).toHaveFocus();
    expect(useSessionStore.getState().parkedSessionIds).toEqual([4]);

    await press(window, ALT_U);
    expect(cursorSession()).toBe(1);
  });
});
