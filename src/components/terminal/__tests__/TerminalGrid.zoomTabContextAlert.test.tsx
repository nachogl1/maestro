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
import { spawnShell } from "@/lib/terminal";
import { useContextAlertStore } from "@/stores/useContextAlertStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { TerminalGrid, type TerminalGridHandle } from "../TerminalGrid";

const invokeMock = vi.mocked(invoke);
const spawnShellMock = vi.mocked(spawnShell);

/** Renders the grid with two launched side-by-side slots. */
async function renderTwoPaneGrid(): Promise<TerminalGridHandle> {
  const ref = createRef<TerminalGridHandle>();
  render(<TerminalGrid ref={ref} projectPath="C:/proj" tabId="tab-1" isActive />);
  const handle = ref.current;
  if (!handle) throw new Error("expected TerminalGrid ref to be attached");
  await act(async () => {
    handle.addSession();
  });
  await act(async () => {
    await handle.launchAll();
  });
  await waitFor(() => expect(useSessionStore.getState().sessions).toHaveLength(2));
  return handle;
}

/** The zoom-strip tab buttons, in strip order (their title names the terminal). */
function zoomTabs(): HTMLElement[] {
  return screen.getAllByTitle(/(^|— )(Switch to |Terminal \d \(click)/);
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

describe("TerminalGrid zoom strip tabs: context alert and active fill", () => {
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
    useContextAlertStore.setState({ threshold: 80 });
  });

  it("blinks the tab of a terminal past the threshold, zoomed or not", async () => {
    const handle = await renderTwoPaneGrid();
    const [first, second] = useSessionStore.getState().sessions;
    await act(async () => {
      expect(handle.zoomSession(first.id)).toBe(true);
    });
    expect(screen.getByText(/^Terminal 1\/2$/)).toBeInTheDocument();

    // The hidden (not zoomed) terminal fills up: its tab blinks.
    setContextPercent(second.id, 85);
    let tabs = zoomTabs();
    expect(tabs[1].className).toContain("zoom-tab-context-alert");
    expect(tabs[1].getAttribute("data-context-alert")).toBe("true");
    expect(tabs[1].title).toContain("Context 85% ≥ 80% alert");
    expect(tabs[0].className).not.toContain("zoom-tab-context-alert");
    expect(tabs[0].hasAttribute("data-context-alert")).toBe(false);

    // The zoomed terminal fills up too: the alert outranks its active fill.
    setContextPercent(first.id, 90);
    tabs = zoomTabs();
    expect(tabs[0].className).toContain("zoom-tab-context-alert");

    // Back under the threshold (e.g. after /clear): the blink stops.
    setContextPercent(first.id, undefined);
    setContextPercent(second.id, 10);
    tabs = zoomTabs();
    expect(tabs[0].className).not.toContain("zoom-tab-context-alert");
    expect(tabs[1].className).not.toContain("zoom-tab-context-alert");
  });

  it("stays quiet when the alert is switched off in Settings", async () => {
    const handle = await renderTwoPaneGrid();
    const [first, second] = useSessionStore.getState().sessions;
    useContextAlertStore.setState({ threshold: null });
    await act(async () => {
      expect(handle.zoomSession(first.id)).toBe(true);
    });
    setContextPercent(second.id, 99);
    expect(zoomTabs()[1].className).not.toContain("zoom-tab-context-alert");
  });

  it("paints the zoomed terminal's tab as a solid fill with bold bright text and an outline", async () => {
    const handle = await renderTwoPaneGrid();
    const [first] = useSessionStore.getState().sessions;
    await act(async () => {
      expect(handle.zoomSession(first.id)).toBe(true);
    });
    const [active, other] = zoomTabs();
    expect(active.className).toContain("bg-maestro-blue/35");
    expect(active.className).toContain("font-bold");
    expect(active.className).toContain("text-maestro-text");
    expect(active.className).toContain("shadow-[inset_0_0_0_1px_rgb(var(--maestro-blue))]");
    expect(other.className).toContain("text-maestro-muted");
    expect(other.className).not.toContain("font-bold");
  });

  it("blinks the tab of a terminal that needs the user on the shared clock, under the red alert", async () => {
    const handle = await renderTwoPaneGrid();
    const [first, second] = useSessionStore.getState().sessions;
    await act(async () => {
      expect(handle.zoomSession(first.id)).toBe(true);
    });

    // The hidden terminal came back from the parking tray by itself.
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    act(() => {
      useSessionStore.setState({ attentionSessionIds: [second.id] });
    });
    let tabs = zoomTabs();
    expect(tabs[1].className).toContain("attention-blink");
    expect(tabs[1].className).not.toContain("warning-flag");
    expect(tabs[1].style.animationDuration).toBe("1200ms");
    expect(tabs[1].style.animationDelay).toBe("-1000ms");
    expect(tabs[0].className).not.toContain("attention-blink");
    clock.mockRestore();

    // Past the context threshold too: the red alert wins.
    setContextPercent(second.id, 85);
    tabs = zoomTabs();
    expect(tabs[1].className).toContain("zoom-tab-context-alert");
    expect(tabs[1].className).not.toContain("attention-blink");

    // A flag the user set by hand stays solid yellow: it is a note, not a call.
    act(() => {
      useSessionStore.setState({ flaggedSessionIds: [first.id] });
    });
    tabs = zoomTabs();
    expect(tabs[0].className).toContain("warning-flag");
    expect(tabs[0].className).not.toContain("attention-blink");
  });

  it("re-aligns the blink when a background project is shown again", async () => {
    // Inactive projects stay mounted under display:none, where no animation
    // runs: shown again, the blink restarts then and must take the clock's
    // phase at that moment, not the one from when the attention began.
    const ref = createRef<TerminalGridHandle>();
    const grid = (isActive: boolean) => (
      <TerminalGrid ref={ref} projectPath="C:/proj" tabId="tab-1" isActive={isActive} />
    );
    const { rerender } = render(grid(true));
    const handle = ref.current;
    if (!handle) throw new Error("expected TerminalGrid ref to be attached");
    await act(async () => {
      handle.addSession();
    });
    await act(async () => {
      await handle.launchAll();
    });
    await waitFor(() => expect(useSessionStore.getState().sessions).toHaveLength(2));
    const [first, second] = useSessionStore.getState().sessions;
    await act(async () => {
      expect(handle.zoomSession(first.id)).toBe(true);
    });

    const clock = vi.spyOn(performance, "now").mockReturnValue(9_000);
    rerender(grid(false)); // the user switched to another project
    clock.mockReturnValue(10_000);
    act(() => {
      useSessionStore.setState({ attentionSessionIds: [second.id] });
    });
    clock.mockReturnValue(10_600);
    rerender(grid(true)); // ...and comes back

    expect(zoomTabs()[1].className).toContain("attention-blink");
    expect(zoomTabs()[1].style.animationDelay).toBe(`-${10_600 % 1_200}ms`);

    // Leaving and coming back while the attention is still on re-aligns too.
    rerender(grid(false));
    clock.mockReturnValue(12_500);
    rerender(grid(true));
    expect(zoomTabs()[1].style.animationDelay).toBe(`-${12_500 % 1_200}ms`);
    clock.mockRestore();
  });
});
