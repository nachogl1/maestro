import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const STAGE_WIDTH = 1000;
const STAGE_HEIGHT = 500;

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

/** Matches the percentage part of a host width such as `calc(80% + -2px)`. */
const PERCENT_PATTERN = /([\d.]+)%/;

/** Each pane host's share of the stage width in layout order, ignoring the divider gutter. */
function paneWidths(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-slot-id]")).map(
    (host) => `${Math.round(Number(PERCENT_PATTERN.exec(host.style.width)?.[1]))}%`,
  );
}

/** Drags the single divider so the first pane takes `share` of the stage. */
function dragDividerTo(share: number): void {
  const divider = document.querySelector<HTMLElement>(".split-divider");
  if (!divider?.parentElement) throw new Error("expected a split divider");
  // happy-dom lays nothing out, so the ratio math needs a real stage rect.
  divider.parentElement.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: STAGE_WIDTH, height: STAGE_HEIGHT }) as DOMRect;
  fireEvent.mouseDown(divider);
  fireEvent.mouseMove(window, { clientX: STAGE_WIDTH * share, clientY: 0 });
  fireEvent.mouseUp(window);
}

describe("TerminalGrid tidy up layout (issue #407)", () => {
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
    // Each launched pane needs its own session id or the store dedupes them.
    let nextSessionId = 1;
    spawnShellMock.mockImplementation(async () => nextSessionId++);
    useSessionStore.setState({ sessions: [], samuraiBySessionId: {}, parkedSessionIds: [] });
  });

  it("shows a Tidy up button left of the Terminal n/m label while zoomed and evens the panes", async () => {
    const handle = await renderTwoPaneGrid();
    dragDividerTo(0.8);
    expect(paneWidths()).toEqual(["80%", "20%"]);

    const [first] = useSessionStore.getState().sessions;
    await act(async () => {
      expect(handle.zoomSession(first.id)).toBe(true);
    });
    const tidy = screen.getByRole("button", { name: /tidy up/i });
    const label = screen.getByText(/^Terminal 1\/2$/);
    expect(tidy.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(tidy);
    // Still zoomed: tidying never changes what the user is looking at.
    expect(screen.getByRole("button", { name: /tidy up/i })).toBeTruthy();

    fireEvent.click(screen.getByTitle("Exit zoom"));
    expect(paneWidths()).toEqual(["50%", "50%"]);
  });

  it("evens the panes on Alt+T without zooming", async () => {
    await renderTwoPaneGrid();
    dragDividerTo(0.8);
    expect(paneWidths()).toEqual(["80%", "20%"]);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "t",
          code: "KeyT",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(paneWidths()).toEqual(["50%", "50%"]);
    expect(screen.queryByRole("button", { name: /tidy up/i })).toBeNull();
  });
});
