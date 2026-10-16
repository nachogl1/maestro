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
    // Issue #158: the quoting family comes from the backend, never from the
    // OS. Default posix; the cmd-refusal test overrides it.
    terminalShellFamily: vi.fn(async () => "posix"),
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
    // Issue #158: the real command answers with the route it ARMED. The
    // default models a backend that honours the claim; refusal tests
    // override it.
    samuraiRegisterSession: vi.fn(
      async (
        _sessionId: number,
        _projectPath: string,
        _epic: string,
        _generation: number,
        launchLinePrompt = false,
      ) => ({ session: {}, launch_line_prompt: launchLinePrompt }),
    ),
    samuraiHarvestArm: vi.fn(async () => {}),
    samuraiRevertLaunchLinePrompt: vi.fn(async () => true),
  };
});

vi.mock("@/lib/terminalPrompt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/terminalPrompt")>();
  return {
    ...actual,
    terminalArmInitialPrompt: vi.fn(async () => {}),
  };
});

// The cap-exemption tests below have to FILL the grid, and every filled slot
// is a full mocked launch. At the production cap of 12 that cost ~8s of a
// 15s budget — the flake class tracked in issue #116. The behaviour under
// test is "parked samurai tiles do not count", which is identical at any
// cap, so the cap itself is mocked down to 3 (the rest of splitTree stays
// real).
vi.mock("../splitTree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../splitTree")>();
  return { ...actual, MAX_SESSIONS: 3 };
});

import { invoke } from "@tauri-apps/api/core";
import { setSessionMcpServers } from "@/lib/mcp";
import {
  samuraiHarvestArm,
  samuraiRegisterSession,
  samuraiRevertLaunchLinePrompt,
} from "@/lib/samurai";
import { killSession, spawnShell, terminalShellFamily, writeStdin } from "@/lib/terminal";
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
const shellFamilyMock = vi.mocked(terminalShellFamily);
const revertMock = vi.mocked(samuraiRevertLaunchLinePrompt);
const initialPromptArmMock = vi.mocked(terminalArmInitialPrompt);
const killSessionMock = vi.mocked(killSession);
const setMcpServersMock = vi.mocked(setSessionMcpServers);

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
    revertMock.mockClear();
    shellFamilyMock.mockClear();
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
    // Issue #158: no launch prompt was offered, so the pointer stays typed.
    expect(registerMock).toHaveBeenCalledWith(expect.any(Number), "C:/proj", "77, 78", 1, false);

    // …and the CLI carries the autonomy flags a samurai generation needs.
    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    const cli = writeStdinMock.mock.calls.map((c) => String(c[1])).join("\n");
    expect(cli).toContain("--dangerously-skip-permissions");
    expect(cli).toContain("--model claude-opus-5");

    // Exactly one terminal: the stray unsupervised one is the bug.
    expect(spawnShellMock).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().sessions).toHaveLength(1);
  });

  // Issue #158: a gen-1 launch whose spawn event offered a brief POINTER
  // carries it on the `claude` command line itself, and tells the backend so
  // the same pointer is not typed into the REPL a second time.
  it("puts the gen-1 brief pointer on the claude launch line, quoted, and says so", async () => {
    const pointer = "[Maestro Samurai] Read `.maestro/briefs/epic-77-78-gen-1-launch.md` in FULL";
    usePendingLaunchStore.getState().request({
      tabId: "tab-1",
      mode: "Claude",
      resumeSessionId: null,
      workingDirOverride: WORKTREE,
      branch: null,
      customName: "samurai gen-1 77-78",
      samurai: {
        project: "C:/proj",
        epic: "77, 78",
        generation: 1,
        model: null,
        launchPrompt: pointer,
      },
    });

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    const cli = writeStdinMock.mock.calls.map((c) => String(c[1])).join("\n");
    // ONE argument, quoted for the test environment's shell family (happy-dom
    // reports a non-Windows platform, so posix single quotes) — and the
    // backticks the pointer carries are inert inside them.
    expect(cli).toContain(`--dangerously-skip-permissions '${pointer}'`);

    // Registered as a launch-line delivery, strictly before the CLI line.
    expect(registerMock).toHaveBeenCalledWith(expect.any(Number), "C:/proj", "77, 78", 1, true);
    expect(registerMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeStdinMock.mock.invocationCallOrder[0],
    );
  });

  /** Queues the gen-1 launch every #158 test below drives. */
  function queueLaunchWithPointer(pointer: string): void {
    usePendingLaunchStore.getState().request({
      tabId: "tab-1",
      mode: "Claude",
      resumeSessionId: null,
      workingDirOverride: WORKTREE,
      branch: null,
      customName: "samurai gen-1 77-78",
      samurai: {
        project: "C:/proj",
        epic: "77, 78",
        generation: 1,
        model: null,
        launchPrompt: pointer,
      },
    });
  }

  it("falls back to the typed pointer when cmd.exe cannot quote it (#158)", async () => {
    // The refusal that can actually happen end to end: `launch_line_safe`
    // already rejects newlines backend-side, but a `%` reaches the grid
    // intact and cmd.exe has no escape for it.
    shellFamilyMock.mockResolvedValueOnce("cmd");
    const pointer = "[Maestro Samurai] Read `.maestro/briefs/100%-gen-1-launch.md` in FULL";
    queueLaunchWithPointer(pointer);

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    const cli = writeStdinMock.mock.calls.map((c) => String(c[1])).join("\n");
    expect(cli).toContain("claude --name samurai-gen-1-77-78 --dangerously-skip-permissions");
    expect(cli).not.toContain("Maestro Samurai");
    expect(registerMock).toHaveBeenCalledWith(expect.any(Number), "C:/proj", "77, 78", 1, false);
  });

  it("takes the pointer back off the line when registration fails (#158)", async () => {
    // The backend never heard the claim, so it will type the pointer on
    // SessionStarted. Writing a line that ALSO carries it delivers the brief
    // twice — the failure this whole gate exists to prevent.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    registerMock.mockRejectedValueOnce(new Error("supervisor unavailable"));
    const pointer = "[Maestro Samurai] Read `.maestro/briefs/epic-77-78-gen-1-launch.md` in FULL";
    queueLaunchWithPointer(pointer);

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    const cli = writeStdinMock.mock.calls.map((c) => String(c[1])).join("\n");
    expect(cli).toContain("claude --name samurai-gen-1-77-78 --dangerously-skip-permissions");
    expect(cli).not.toContain("Maestro Samurai");
    errorSpy.mockRestore();
  });

  it("reverts the launch-line claim when the line never reaches the PTY (#158)", async () => {
    // Claimed before the write (it has to beat the SessionStart hook), so a
    // failed write leaves the backend believing a delivery happened. Without
    // the revert a later SessionStarted consumes the entry, types nothing,
    // and audits `delivered` — zero delivery behind a false trail.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // SessionNotFound is raised before a single byte is written — the one
    // rejection that PROVES the line never landed.
    writeStdinMock.mockRejectedValueOnce({
      code: "SessionNotFound",
      message: "Session 1 not found",
    });
    const pointer = "[Maestro Samurai] Read `.maestro/briefs/epic-77-78-gen-1-launch.md` in FULL";
    queueLaunchWithPointer(pointer);

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(revertMock).toHaveBeenCalledTimes(1));
    expect(revertMock).toHaveBeenCalledWith(expect.any(Number));
    errorSpy.mockRestore();
  });

  it("leaves the claim standing when the write fails AFTER the bytes landed (#158)", async () => {
    // `write_stdin` also rejects when `write_all` succeeded and `flush` did
    // not: the whole line plus the CR is already in the PTY and claude
    // launches with the pointer. Reverting there would type it a second time
    // on SessionStarted — a double paste, which is worse than the ALERT the
    // activity watch raises if the launch really did fail.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeStdinMock.mockRejectedValueOnce({ code: "WriteFailed", message: "Flush failed: EPIPE" });
    const pointer = "[Maestro Samurai] Read `.maestro/briefs/epic-77-78-gen-1-launch.md` in FULL";
    queueLaunchWithPointer(pointer);

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    // Anchored on the write settling plus an explicit tick, NOT on the outer
    // catch logging: that only happens to run after the revert decision
    // because the revert is awaited before the rethrow. Draining the
    // continuations the rejection scheduled is what makes "never called"
    // mean it, whatever order the handlers take.
    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(revertMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("types the pointer when the backend REFUSES the launch-line claim (#158)", async () => {
    // The refusal resolves like a success — the replicator only logs that it
    // was never offered this route and keeps `Typed`. Reading "no exception"
    // as acceptance writes a line carrying a pointer that is then typed too.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerMock.mockResolvedValueOnce({ session: {}, launch_line_prompt: false } as never);
    const pointer = "[Maestro Samurai] Read `.maestro/briefs/epic-77-78-gen-1-launch.md` in FULL";
    queueLaunchWithPointer(pointer);

    render(<TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive />);

    await waitFor(() => expect(writeStdinMock).toHaveBeenCalled());
    const cli = writeStdinMock.mock.calls.map((c) => String(c[1])).join("\n");
    expect(cli).toContain("claude --name samurai-gen-1-77-78 --dangerously-skip-permissions");
    expect(cli).not.toContain("Maestro Samurai");
    warnSpy.mockRestore();
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

    // A plain interactive session — no harvest, no supervision registration.
    expect(harvestArmMock).not.toHaveBeenCalled();
    expect(registerMock).not.toHaveBeenCalled();
    expect(spawnShellMock).toHaveBeenCalledTimes(1);
  });

  // A run's every past generation leaves a permanently-parked terminal-state
  // tile (issue #122), so a long autonomous run fills the session cap with
  // dead weight — and its successor's pending launch used to be dropped
  // AFTER `consume` had already claimed it, silently stalling the run.
  /**
   * Fills the grid to MAX_SESSIONS launched sessions, then auto-parks the
   * oldest one as a finished samurai generation. Returns the grid handle and
   * that parked session's id.
   */
  async function fillGridWithOneParkedGeneration(
    onSessionCountChange?: (slots: number, launched: number, occupied: number) => void,
  ) {
    let nextId = 100;
    spawnShellMock.mockImplementation(async () => nextId++);
    const ref = createRef<TerminalGridHandle>();
    render(
      <TerminalGrid
        ref={ref}
        projectPath="C:/proj"
        tabId="tab-1"
        isActive
        onSessionCountChange={onSessionCountChange}
      />,
    );
    const handle = ref.current;
    if (!handle) throw new Error("expected TerminalGrid ref to be attached");

    await act(async () => {
      for (let i = 1; i < MAX_SESSIONS; i++) handle.addSession();
    });
    await act(async () => {
      await handle.launchAll();
    });
    await waitFor(() => expect(useSessionStore.getState().sessions).toHaveLength(MAX_SESSIONS));

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
    return { handle, deadId };
  }

  it("exempts parked samurai terminal-state slots from the session cap (PR #131 review M4)", async () => {
    await fillGridWithOneParkedGeneration();
    const launchesBefore = spawnShellMock.mock.calls.length;

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

    await waitFor(() => expect(spawnShellMock).toHaveBeenCalledTimes(launchesBefore + 1));
    expect(screen.queryByText(/maximum of/)).not.toBeInTheDocument();
  });

  // The same exemption has to hold for the manual "+" button: it lives on a
  // different code path (`addSession`), and counting parked samurai tiles
  // there makes "+" a SILENT no-op — early return, no error — so after a few
  // generations the user cannot open a terminal in that project at all.
  it("exempts parked samurai terminal-state slots from the '+' button cap too", async () => {
    const { handle } = await fillGridWithOneParkedGeneration();
    const launchesBefore = spawnShellMock.mock.calls.length;

    await act(async () => {
      handle.addSession();
    });
    // The new slot is real only if it can actually launch a terminal — a
    // refused `addSession` leaves nothing for `launchAll` to spawn.
    await act(async () => {
      await handle.launchAll();
    });

    await waitFor(() => expect(spawnShellMock).toHaveBeenCalledTimes(launchesBefore + 1));
  });

  // The top-bar "+" and the eagle picker grey out on the reported occupied
  // count, so it must apply the same exemption as addSession — otherwise the
  // button looks full while Ctrl+T still adds a terminal.
  it("reports the parked samurai exemption in the occupied count it hands the parent", async () => {
    const onCounts = vi.fn();
    await fillGridWithOneParkedGeneration(onCounts);

    await waitFor(() =>
      expect(onCounts).toHaveBeenLastCalledWith(MAX_SESSIONS, MAX_SESSIONS, MAX_SESSIONS - 1),
    );
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
