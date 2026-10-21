import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
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
// focuses after a launch.
vi.mock("@/components/terminal/TerminalView", () => ({
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

/** The eagle tile (DraggablePane wrapper) holding an element. */
function tileOf(el: Element): HTMLElement {
  const tile = el.closest<HTMLElement>("[data-slot-id]");
  if (!tile) throw new Error("element is not inside a tile");
  return tile;
}

async function launchCard(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Launch Session" }));
  });
  await flushFrames();
}

describe("MultiProjectView Cmd/Ctrl+T while eagle-zoomed", () => {
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

  async function renderZoomedOnFirstTerminal() {
    const ref = createRef<MultiProjectViewHandle>();
    render(<MultiProjectView ref={ref} eagleView />);
    await flushFrames();
    await launchCard();
    await act(async () => {
      ref.current?.zoomSessionInProject("tab-1", 1);
    });
    expect(screen.getByText("Terminal 1/1")).toBeInTheDocument();
    return ref;
  }

  it("keeps the zoom view: the new card is zoomed and its name box has focus", async () => {
    const ref = await renderZoomedOnFirstTerminal();

    await act(async () => {
      ref.current?.addSessionInProject("tab-1");
    });
    await flushFrames();

    expect(screen.getByText("New terminal")).toBeInTheDocument();
    const nameInput = screen.getByLabelText(/Window Name/);
    expect(document.activeElement).toBe(nameInput);
    expect(tileOf(nameInput).className).toContain("top-8");
    expect(tileOf(screen.getByTestId("terminal-view")).style.visibility).toBe("hidden");
  });

  it("hands the zoom to the new terminal once the card launches", async () => {
    const ref = await renderZoomedOnFirstTerminal();
    await act(async () => {
      ref.current?.addSessionInProject("tab-1");
    });
    await flushFrames();

    await launchCard();

    expect(screen.getByText("Terminal 2/2")).toBeInTheDocument();
  });

  it("returns the zoom to the terminal zoomed before when the card is removed", async () => {
    const ref = await renderZoomedOnFirstTerminal();
    await act(async () => {
      ref.current?.addSessionInProject("tab-1");
    });
    await flushFrames();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove session slot" }));
    });

    expect(screen.getByText("Terminal 1/1")).toBeInTheDocument();
  });

  it("zooms the first card of an idle project too", async () => {
    useWorkspaceStore.setState({
      tabs: [
        { ...launchedTab },
        { ...launchedTab, id: "tab-2", name: "other", active: false, sessionsLaunched: false },
      ],
    });
    const ref = await renderZoomedOnFirstTerminal();

    await act(async () => {
      ref.current?.addSessionInProject("tab-2");
    });
    await flushFrames();

    expect(screen.getByText("New terminal")).toBeInTheDocument();
    const nameInput = screen.getByLabelText(/Window Name/);
    expect(document.activeElement).toBe(nameInput);
    expect(tileOf(nameInput).className).toContain("top-8");
  });

  it("still adds the card as a plain tile when eagle view is not zoomed", async () => {
    const ref = createRef<MultiProjectViewHandle>();
    render(<MultiProjectView ref={ref} eagleView />);
    await flushFrames();
    await launchCard();

    await act(async () => {
      ref.current?.addSessionInProject("tab-1");
    });
    await flushFrames();

    expect(screen.queryByText("New terminal")).toBeNull();
    expect(tileOf(screen.getByLabelText(/Window Name/)).className).not.toContain("top-8");
  });
});
