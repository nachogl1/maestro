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
import { useMcpStore } from "@/stores/useMcpStore";
import { usePluginStore } from "@/stores/usePluginStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { TerminalGrid, type TerminalGridHandle } from "../TerminalGrid";

const invokeMock = vi.mocked(invoke);
const spawnShellMock = vi.mocked(spawnShell);

/** Let the grid's double requestAnimationFrame focus helpers run. */
async function flushFrames(): Promise<void> {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("TerminalGrid keyboard focus flow", () => {
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

  it("focuses the new card's name input when a session is added", async () => {
    const ref = createRef<TerminalGridHandle>();
    render(<TerminalGrid ref={ref} projectPath="C:/proj" tabId="tab-1" isActive />);
    const handle = ref.current;
    if (!handle) throw new Error("expected TerminalGrid ref to be attached");

    await act(async () => {
      handle.addSession();
    });
    await flushFrames();

    const nameInputs = screen.getAllByLabelText(/Window Name/);
    expect(nameInputs).toHaveLength(2);
    expect(document.activeElement).toBe(nameInputs[1]);
  });

  it("keeps trying until the new card's name input accepts focus", async () => {
    // A browser refuses focus while the card is still hidden (an eagle tile
    // waiting for its place), so the first attempts do nothing.
    const realFocus = HTMLInputElement.prototype.focus;
    let refusals = 3;
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, "focus").mockImplementation(function (
      this: HTMLInputElement,
      options?: FocusOptions,
    ) {
      if (this.id.startsWith("session-name-") && refusals > 0) {
        refusals--;
        return;
      }
      realFocus.call(this, options);
    });
    const ref = createRef<TerminalGridHandle>();
    render(<TerminalGrid ref={ref} projectPath="C:/proj" tabId="tab-1" isActive />);

    try {
      await act(async () => {
        ref.current?.addSession();
      });
      const nameInputs = screen.getAllByLabelText(/Window Name/);
      await waitFor(() => expect(document.activeElement).toBe(nameInputs[1]));
      expect(refusals).toBe(0);
    } finally {
      focusSpy.mockRestore();
    }
  });

  it("takes focus back when a terminal grabs it right after the card is added", async () => {
    const ref = createRef<TerminalGridHandle>();
    render(<TerminalGrid ref={ref} projectPath="C:/proj" tabId="tab-1" isActive />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Launch Session" }));
    });
    const terminal = await screen.findByTestId("terminal-view");

    await act(async () => {
      ref.current?.addSession();
    });
    await flushFrames();
    const nameInput = screen.getByLabelText(/Window Name/);
    expect(document.activeElement).toBe(nameInput);

    // A terminal's own focus (its xterm initialising as the focused pane).
    act(() => terminal.focus());
    await waitFor(() => expect(document.activeElement).toBe(nameInput));
  });

  it("leaves focus where the user clicks after the card is added", async () => {
    const ref = createRef<TerminalGridHandle>();
    render(<TerminalGrid ref={ref} projectPath="C:/proj" tabId="tab-1" isActive />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Launch Session" }));
    });
    const terminal = await screen.findByTestId("terminal-view");

    await act(async () => {
      ref.current?.addSession();
    });
    await flushFrames();

    fireEvent.pointerDown(terminal);
    act(() => terminal.focus());
    await flushFrames();
    await flushFrames();

    expect(document.activeElement).toBe(terminal);
  });

  it("names and launches a new terminal from the keyboard alone", async () => {
    const ref = createRef<TerminalGridHandle>();
    render(<TerminalGrid ref={ref} projectPath="C:/proj" tabId="tab-1" isActive />);

    await act(async () => {
      ref.current?.addSession();
    });
    await flushFrames();
    const nameInput = document.activeElement as HTMLInputElement;
    expect(nameInput).toBe(screen.getAllByLabelText(/Window Name/)[1]);

    fireEvent.change(nameInput, { target: { value: "backend bugfix" } });
    await act(async () => {
      fireEvent.keyDown(nameInput, { key: "Enter" });
    });

    await waitFor(() => expect(screen.getByTestId("terminal-view")).toBeInTheDocument());
    expect(spawnShellMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "rename_session",
      expect.objectContaining({ name: expect.stringContaining("backend") }),
    );
    expect(screen.getAllByLabelText(/Window Name/)).toHaveLength(1);
  });

  it("focuses the first card's name input when mounted for a new terminal", async () => {
    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive focusNameOnMount />);
    await flushFrames();

    expect(document.activeElement).toBe(screen.getByLabelText(/Window Name/));
  });

  it("leaves focus alone on a plain mount", async () => {
    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);
    await flushFrames();

    expect(document.activeElement).not.toBe(screen.getByLabelText(/Window Name/));
  });

  it("focuses the terminal input after launching from the card", async () => {
    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Launch Session" }));
    });
    // Mounts already focused, so the real xterm grabs focus on init.
    await waitFor(() =>
      expect(screen.getByTestId("terminal-view")).toHaveAttribute("data-focused", "true"),
    );
    // Fallback focus once the launch completes and nothing else holds focus.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("terminal-view")));
  });
});
