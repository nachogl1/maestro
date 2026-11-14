import { act, render, screen, waitFor } from "@testing-library/react";
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

// xterm.js cannot mount in happy-dom — stand in the helper textarea the grid
// focuses after a launch.
vi.mock("../TerminalView", () => ({
  TerminalView: ({ isFocused }: { isFocused: boolean }) => (
    <textarea
      data-testid="terminal-view"
      data-focused={String(isFocused)}
      className="xterm-helper-textarea"
    />
  ),
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
import { useSessionStore } from "@/stores/useSessionStore";
import { TerminalGrid, type TerminalGridHandle } from "../TerminalGrid";

const invokeMock = vi.mocked(invoke);
const spawnShellMock = vi.mocked(spawnShell);

/** Renders the grid with three launched terminals. */
async function renderThreePaneGrid(): Promise<TerminalGridHandle> {
  const ref = createRef<TerminalGridHandle>();
  render(<TerminalGrid ref={ref} projectPath="C:/proj" tabId="tab-1" isActive />);
  const handle = ref.current;
  if (!handle) throw new Error("expected TerminalGrid ref to be attached");
  await act(async () => {
    handle.addSession();
    handle.addSession();
  });
  await act(async () => {
    await handle.launchAll();
  });
  await waitFor(() => expect(useSessionStore.getState().sessions).toHaveLength(3));
  return handle;
}

describe("TerminalGrid zoom view: the parked strip stays below the zoomed terminal", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_project_hash") return "hash";
      if (cmd === "list_claude_sessions") {
        return { sessions: [], total_found: 0, truncated: false, unreadable: 0 };
      }
      return [];
    });
    spawnShellMock.mockReset();
    let nextSessionId = 1;
    spawnShellMock.mockImplementation(async () => nextSessionId++);
    useSessionStore.setState({
      sessions: [],
      samuraiBySessionId: {},
      parkedSessionIds: [],
      attentionSessionIds: [],
      flaggedSessionIds: [],
    });
  });

  it("gives the strip its own row under a zoom area that clips the zoomed terminal", async () => {
    const handle = await renderThreePaneGrid();
    const [first, second, third] = useSessionStore.getState().sessions;
    act(() => {
      useSessionStore.getState().parkSession(second.id);
      useSessionStore.getState().parkSession(third.id);
    });
    await act(async () => {
      expect(handle.zoomSession(first.id)).toBe(true);
    });
    expect(screen.getByText(/^Terminal 1\/1$/)).toBeInTheDocument();

    const shelf = screen.getByRole("toolbar", { name: "Parked terminals" });
    expect(shelf.querySelectorAll("[data-parked-session-id]")).toHaveLength(2);

    const stage = document.querySelector<HTMLElement>('[data-split-stage="tab-1"]');
    const zoomArea = stage?.parentElement;
    if (!stage || !zoomArea) throw new Error("expected the zoom area around the split stage");
    const zoomedHost = stage.querySelector<HTMLElement>(":scope > [data-slot-id].inset-0");
    expect(zoomedHost).not.toBeNull();

    // The strip is the zoom area's next sibling in the same column, never inside it.
    expect(zoomArea.contains(shelf)).toBe(false);
    expect(zoomArea.nextElementSibling).toBe(shelf);
    expect(zoomArea.parentElement?.className).toMatch(/\bflex-col\b/);
    expect(shelf.className).toMatch(/\bshrink-0\b/);

    // The zoom area shrinks to what is left above the strip and clips
    // everything inside it, so no part of the zoomed terminal can paint
    // over the parked pills.
    for (const cls of ["flex-1", "min-h-0", "overflow-hidden"]) {
      expect(zoomArea.className.split(/\s+/)).toContain(cls);
    }
  });
});
