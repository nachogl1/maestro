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
import { useContextAlertStore } from "@/stores/useContextAlertStore";
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

async function launchCard(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Launch Session" }));
  });
  await flushFrames();
}

function setContextPercent(sessionId: number, contextPercent: number | undefined): void {
  act(() => {
    useSessionStore.setState({
      sessions: useSessionStore
        .getState()
        .sessions.map((s) => (s.id === sessionId ? { ...s, contextPercent } : s)),
    });
  });
}

/** The eagle zoom-strip tab buttons, in strip order (their title names the terminal). */
function eagleZoomTabs(): HTMLElement[] {
  return screen.getAllByTitle(/(^|— )(Switch to proj · |proj · .* \(click)/);
}

describe("MultiProjectView eagle zoom strip tabs: context alert and active fill", () => {
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
    useSessionStore.setState({ sessions: [], parkedSessionIds: [] });
    useContextAlertStore.setState({ threshold: 80 });
  });

  async function renderZoomedWithTwoTerminals(): Promise<void> {
    const ref = createRef<MultiProjectViewHandle>();
    render(<MultiProjectView ref={ref} eagleView />);
    await flushFrames();
    await launchCard();
    await act(async () => {
      ref.current?.zoomSessionInProject("tab-1", 1);
    });
    expect(screen.getByText("Terminal 1/1")).toBeInTheDocument();
    // A second card added while zoomed launches as terminal 2 and takes the zoom.
    await act(async () => {
      ref.current?.addSessionInProject("tab-1");
    });
    await flushFrames();
    await launchCard();
    expect(screen.getByText("Terminal 2/2")).toBeInTheDocument();
    await act(async () => {
      ref.current?.zoomSessionInProject("tab-1", 1);
    });
    expect(screen.getByText("Terminal 1/2")).toBeInTheDocument();
  }

  it("blinks the tab of a terminal past the threshold and drops the active fill while it does", async () => {
    await renderZoomedWithTwoTerminals();

    const [active, other] = eagleZoomTabs();
    expect(active.className).toContain("font-bold");
    // happy-dom drops the color-mix() background, so the outline stands in
    // for the whole inline fill here.
    expect(active.style.boxShadow).toContain("inset 0 0 0 1px");
    expect(other.className).not.toContain("font-bold");
    expect(other.style.boxShadow).toBe("");

    setContextPercent(2, 85);
    let tabs = eagleZoomTabs();
    expect(tabs[1].className).toContain("zoom-tab-context-alert");
    expect(tabs[1].getAttribute("data-context-alert")).toBe("true");
    expect(tabs[1].title).toContain("Context 85% ≥ 80% alert");
    expect(tabs[0].className).not.toContain("zoom-tab-context-alert");

    // The zoomed terminal fills up: the alert class takes over and the inline
    // active fill is dropped so the red (a class) can win.
    setContextPercent(1, 90);
    tabs = eagleZoomTabs();
    expect(tabs[0].className).toContain("zoom-tab-context-alert");
    expect(tabs[0].style.boxShadow).toBe("");

    setContextPercent(1, undefined);
    tabs = eagleZoomTabs();
    expect(tabs[0].className).not.toContain("zoom-tab-context-alert");
    expect(tabs[0].style.boxShadow).toContain("inset 0 0 0 1px");
  });
});
