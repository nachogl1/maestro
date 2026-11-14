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

// xterm.js cannot mount in happy-dom — the grid only needs a pane placeholder.
vi.mock("../TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
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
    // TRUE: the CLI-launch half of launchSlotInner is exactly what this
    // test is about.
    checkCliAvailable: vi.fn(async () => true),
    killSession: vi.fn(async () => {}),
    assignSessionBranch: vi.fn(async () => ({ branch: null, worktree_path: null })),
    waitForTerminalReady: vi.fn(async () => {}),
    writeStdin: vi.fn(async () => {}),
    writeSessionHooksConfig: vi.fn(async () => {}),
    removeSessionHooksConfig: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
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

vi.mock("@/lib/samurai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/samurai")>();
  return {
    ...actual,
    samuraiHarvestArm: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/terminalPrompt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/terminalPrompt")>();
  return {
    ...actual,
    terminalArmInitialPrompt: vi.fn(async () => {}),
  };
});

import { invoke } from "@tauri-apps/api/core";
import { setSessionMcpServers } from "@/lib/mcp";
import { samuraiHarvestArm } from "@/lib/samurai";
import { killSession, spawnShell, writeStdin } from "@/lib/terminal";
import { terminalArmInitialPrompt } from "@/lib/terminalPrompt";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { TerminalGrid, type TerminalGridHandle } from "../TerminalGrid";

const invokeMock = vi.mocked(invoke);
const spawnShellMock = vi.mocked(spawnShell);
const writeStdinMock = vi.mocked(writeStdin);
const harvestArmMock = vi.mocked(samuraiHarvestArm);
const initialPromptArmMock = vi.mocked(terminalArmInitialPrompt);
const killSessionMock = vi.mocked(killSession);
const setMcpServersMock = vi.mocked(setSessionMcpServers);

const WORKTREE = "C:/wt/feature-77";

/**
 * Regression cover for a queued launch landing in the WRONG place.
 *
 * A queued launch can arrive before the grid mounts, so the consume effect
 * and the deferred auto-launch effect run in the SAME passive-effect flush.
 * React cannot re-render between them, so the ref-sync effect has not run —
 * and the launch used to read the PRISTINE slot from the stale ref: a plain
 * session in the project directory instead of the one it asked for.
 */
describe("TerminalGrid pending launch", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_project_hash") return "hash";
      // The session listing reports what it could not return, so it is an
      // object, not a bare list (issue #78).
      if (cmd === "list_claude_sessions") {
        return { sessions: [], total_found: 0, truncated: false, unreadable: 0 };
      }
      return [];
    });
    spawnShellMock.mockClear();
    writeStdinMock.mockClear();
    harvestArmMock.mockClear();
    initialPromptArmMock.mockClear();
    useSessionStore.setState({ sessions: [], parkedSessionIds: [] });
    usePendingLaunchStore.setState({ pending: [] });
  });

  it("launches a queued claim in its own directory, on the mount commit", async () => {
    // Queued BEFORE the grid exists — the real ordering for a History resume
    // into a worktree: the request lands first, then the grid mounts.
    usePendingLaunchStore.getState().request({
      tabId: "tab-1",
      mode: "Claude",
      resumeSessionId: null,
      workingDirOverride: WORKTREE,
      branch: null,
      customName: "feature 77",
    });

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(spawnShellMock).toHaveBeenCalled());

    // The shell opens in the requested WORKTREE, not the project checkout.
    const [workingDir] = spawnShellMock.mock.calls[0];
    expect(workingDir).toBe(WORKTREE);

    // …and the CLI launches under the requested name.
    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    const cli = writeStdinMock.mock.calls.map((c) => String(c[1])).join("\n");
    expect(cli).toContain("claude --name feature-77");

    // Exactly one terminal: a second one in the project checkout is the bug.
    expect(spawnShellMock).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().sessions).toHaveLength(1);
  });

  // Issue #98: a "Harvest now" launch rides the same pending-launch flow —
  // the grid must arm the backend's journal-prompt injection BEFORE the CLI
  // command is typed, so the gate is set ahead of claude's SessionStart hook.
  it("arms the harvest triage before launching the CLI for a harvest claim", async () => {
    usePendingLaunchStore.getState().request({
      tabId: "tab-1",
      mode: "Claude",
      resumeSessionId: null,
      workingDirOverride: "C:/proj",
      branch: null,
      customName: "harvest triage",
      harvest: true,
    });

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(spawnShellMock).toHaveBeenCalled());
    // The shell opens in the project's MAIN checkout (the override), no
    // worktree derivation.
    const [workingDir] = spawnShellMock.mock.calls[0];
    expect(workingDir).toBe("C:/proj");

    // Armed exactly once, with the launched session's id…
    await waitFor(() => expect(harvestArmMock).toHaveBeenCalledTimes(1));
    expect(harvestArmMock).toHaveBeenCalledWith(1);
    // …and strictly before the CLI command went to the PTY.
    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    expect(harvestArmMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeStdinMock.mock.invocationCallOrder[0],
    );

    // A plain interactive session: no forced skip-permissions.
    const cli = writeStdinMock.mock.calls.map((c) => String(c[1])).join("\n");
    expect(cli).not.toContain("--dangerously-skip-permissions");
    expect(spawnShellMock).toHaveBeenCalledTimes(1);
  });

  // The generic "launch a terminal with a prompt" capability: any caller can
  // queue a launch carrying `initialPrompt`, and the grid must arm the
  // backend's injection BEFORE the CLI command is typed — the same ordering
  // the harvest arm above relies on.
  it("arms the initial prompt before launching the CLI for a prompted claim", async () => {
    usePendingLaunchStore.getState().request({
      tabId: "tab-1",
      mode: "Claude",
      resumeSessionId: null,
      workingDirOverride: "C:/proj",
      branch: null,
      customName: "prompted session",
      // Multi-line on purpose: the backend flattens it, the grid passes it
      // through verbatim.
      initialPrompt: "review the diff\nand summarise it",
      // Issue #138: a caller may also name where a long prompt is staged as a
      // brief file; the grid passes both halves straight through.
      briefDir: "C:/proj",
      briefStem: "pr-123-check-review",
      // Issue #139: a PR review launch also records itself, at the same hop.
      prRun: {
        pr: 123,
        title: "fix journal splitting",
        repo: "nachogl1/maestro",
        project_path: "C:/proj",
        steps: ["check", "review"],
      },
    });

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(spawnShellMock).toHaveBeenCalled());

    // Armed exactly once, with the launched session's id and the raw prompt…
    await waitFor(() => expect(initialPromptArmMock).toHaveBeenCalledTimes(1));
    expect(initialPromptArmMock).toHaveBeenCalledWith(
      1,
      "review the diff\nand summarise it",
      "C:/proj",
      "pr-123-check-review",
      {
        pr: 123,
        title: "fix journal splitting",
        repo: "nachogl1/maestro",
        project_path: "C:/proj",
        steps: ["check", "review"],
      },
    );
    // …and strictly before the CLI command went to the PTY.
    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    expect(initialPromptArmMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeStdinMock.mock.invocationCallOrder[0],
    );

    // A plain interactive session — no harvest.
    expect(harvestArmMock).not.toHaveBeenCalled();
    expect(spawnShellMock).toHaveBeenCalledTimes(1);
  });

  // A step between spawnShell and the slot taking the session (here the MCP
  // server write) can reject. The shell then belongs to no pane, so the launch
  // must kill it and drop its store row instead of leaking an invisible PTY.
  it("kills the shell and drops its session row when a launch step fails before the slot owns it", async () => {
    spawnShellMock.mockImplementationOnce(async () => 42);
    setMcpServersMock.mockRejectedValueOnce(new Error("Session not found"));
    killSessionMock.mockClear();
    const ref = createRef<TerminalGridHandle>();
    render(<TerminalGrid ref={ref} projectPath="C:/proj" tabId="tab-1" isActive />);

    await act(async () => {
      await ref.current?.launchAll();
    });

    await waitFor(() => expect(killSessionMock).toHaveBeenCalledWith(42));
    expect(useSessionStore.getState().sessions).toHaveLength(0);
    expect(writeStdinMock).not.toHaveBeenCalled();
  });

  // The injection rides claude's SessionStart hook, which a plain shell never
  // posts: a plain terminal must NOT arm (it would strand a stale entry
  // backend-side and inject nothing), and it types no CLI line at all.
  it("does not arm the initial prompt for a plain terminal launch", async () => {
    usePendingLaunchStore.getState().request({
      tabId: "tab-1",
      mode: "Plain",
      resumeSessionId: null,
      workingDirOverride: "C:/proj",
      branch: null,
      initialPrompt: "review the diff",
    });

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(screen.getByTestId("terminal-view")).toBeInTheDocument());
    expect(initialPromptArmMock).not.toHaveBeenCalled();
    expect(writeStdinMock).not.toHaveBeenCalled();
  });
});
