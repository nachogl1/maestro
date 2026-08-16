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
    // Unlike the samuraiClose suite this must be TRUE: the CLI-launch half of
    // launchSlotInner is exactly what this test is about.
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

vi.mock("@/lib/samurai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/samurai")>();
  return {
    ...actual,
    samuraiRegisterSession: vi.fn(async () => ({})),
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
import { samuraiHarvestArm, samuraiRegisterSession } from "@/lib/samurai";
import { spawnShell, writeStdin } from "@/lib/terminal";
import { terminalArmInitialPrompt } from "@/lib/terminalPrompt";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { MAX_SESSIONS } from "../splitTree";
import { TerminalGrid, type TerminalGridHandle } from "../TerminalGrid";

const invokeMock = vi.mocked(invoke);
const spawnShellMock = vi.mocked(spawnShell);
const writeStdinMock = vi.mocked(writeStdin);
const registerMock = vi.mocked(samuraiRegisterSession);
const harvestArmMock = vi.mocked(samuraiHarvestArm);
const initialPromptArmMock = vi.mocked(terminalArmInitialPrompt);

const WORKTREE = "C:/wt/samurai-77-78";

/**
 * Regression cover for the samurai launch landing in the WRONG place.
 *
 * A samurai launch queues into `usePendingLaunchStore` and then forces the
 * grid to mount (`setSessionsLaunched`), so the consume effect and the
 * deferred auto-launch effect run in the SAME passive-effect flush. React
 * cannot re-render between them, so the ref-sync effect has not run — and the
 * launch used to read the PRISTINE slot from the stale ref: a plain claude
 * session in the project directory, no `--dangerously-skip-permissions`, and
 * no supervision registration. The backend then re-emitted 180s later and
 * opened a SECOND terminal, which is the one that actually worked.
 */
describe("TerminalGrid pending samurai launch", () => {
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
    registerMock.mockClear();
    harvestArmMock.mockClear();
    initialPromptArmMock.mockClear();
    useSessionStore.setState({ sessions: [], samuraiBySessionId: {}, parkedSessionIds: [] });
    usePendingLaunchStore.setState({ pending: [] });
  });

  it("launches a queued samurai claim in its worktree, supervised, on the mount commit", async () => {
    // Queued BEFORE the grid exists — the real ordering: the spawn listener
    // requests the launch and only then mounts the grid.
    usePendingLaunchStore.getState().request({
      tabId: "tab-1",
      mode: "Claude",
      resumeSessionId: null,
      workingDirOverride: WORKTREE,
      branch: null,
      customName: "samurai gen-1 77-78",
      samurai: { project: "C:/proj", epic: "77, 78", generation: 1, model: "claude-opus-5" },
    });

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(spawnShellMock).toHaveBeenCalled());

    // The shell opens in the EPIC WORKTREE, not the project checkout.
    const [workingDir] = spawnShellMock.mock.calls[0];
    expect(workingDir).toBe(WORKTREE);

    // Registered under supervision — this is what arms the backend's brief
    // delivery and stops it re-emitting the spawn event.
    await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
    expect(registerMock).toHaveBeenCalledWith(expect.any(Number), "C:/proj", "77, 78", 1);

    // …and the CLI carries the autonomy flags a samurai generation needs.
    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    const cli = writeStdinMock.mock.calls.map((c) => String(c[1])).join("\n");
    expect(cli).toContain("--dangerously-skip-permissions");
    expect(cli).toContain("--model claude-opus-5");

    // Exactly one terminal: the stray unsupervised one is the bug.
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

    // A plain interactive session: no samurai supervision registration, no
    // forced skip-permissions.
    expect(registerMock).not.toHaveBeenCalled();
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
    });

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(spawnShellMock).toHaveBeenCalled());

    // Armed exactly once, with the launched session's id and the raw prompt…
    await waitFor(() => expect(initialPromptArmMock).toHaveBeenCalledTimes(1));
    expect(initialPromptArmMock).toHaveBeenCalledWith(1, "review the diff\nand summarise it");
    // …and strictly before the CLI command went to the PTY.
    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    expect(initialPromptArmMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeStdinMock.mock.invocationCallOrder[0],
    );

    // A plain interactive session — no harvest, no supervision registration.
    expect(harvestArmMock).not.toHaveBeenCalled();
    expect(registerMock).not.toHaveBeenCalled();
    expect(spawnShellMock).toHaveBeenCalledTimes(1);
  });

  // A run's every past generation leaves a permanently-parked terminal-state
  // tile (issue #122), so a long autonomous run fills the session cap with
  // dead weight — and its successor's pending launch used to be dropped
  // AFTER `consume` had already claimed it, silently stalling the run.
  it("exempts parked samurai terminal-state slots from the session cap (PR #131 review M4)", async () => {
    let nextId = 100;
    spawnShellMock.mockImplementation(async () => nextId++);
    const ref = createRef<TerminalGridHandle>();
    render(<TerminalGrid ref={ref} projectPath="C:/proj" tabId="tab-1" isActive />);
    const handle = ref.current;
    if (!handle) throw new Error("expected TerminalGrid ref to be attached");

    // Fill the grid to the cap with launched sessions.
    await act(async () => {
      for (let i = 1; i < MAX_SESSIONS; i++) handle.addSession();
    });
    await act(async () => {
      await handle.launchAll();
    });
    await waitFor(() => expect(useSessionStore.getState().sessions).toHaveLength(MAX_SESSIONS));
    expect(spawnShellMock).toHaveBeenCalledTimes(MAX_SESSIONS);

    // One earlier samurai generation ended: the auto-park effect moves its
    // tile to the tray, where it stays a KILLED transcript forever.
    const deadId = useSessionStore.getState().sessions[0].id;
    await act(async () => {
      useSessionStore.setState((s) => ({
        samuraiBySessionId: {
          ...s.samuraiBySessionId,
          [deadId]: { project: "C:/proj", epic: "77, 78", generation: 1, state: "KILLED" },
        },
      }));
    });
    await waitFor(() => expect(useSessionStore.getState().parkedSessionIds).toEqual([deadId]));

    // The successor's queued launch must still get a slot.
    await act(async () => {
      usePendingLaunchStore.getState().request({
        tabId: "tab-1",
        mode: "Claude",
        resumeSessionId: null,
        workingDirOverride: WORKTREE,
        branch: null,
        customName: "samurai gen-2 77-78",
        samurai: { project: "C:/proj", epic: "77, 78", generation: 2, model: null },
      });
    });

    await waitFor(() => expect(spawnShellMock).toHaveBeenCalledTimes(MAX_SESSIONS + 1));
    expect(screen.queryByText(/maximum of/)).not.toBeInTheDocument();
    // Launching 12 mocked sessions first makes this test legitimately slow.
  }, 15_000);

  // The injection rides claude's SessionStart hook, which no other CLI posts:
  // a non-Claude launch must NOT arm (it would strand a stale entry backend-
  // side and inject nothing).
  it("does not arm the initial prompt for a non-Claude launch", async () => {
    usePendingLaunchStore.getState().request({
      tabId: "tab-1",
      mode: "OpenCode",
      resumeSessionId: null,
      workingDirOverride: "C:/proj",
      branch: null,
      initialPrompt: "review the diff",
    });

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    expect(initialPromptArmMock).not.toHaveBeenCalled();
  });
});
