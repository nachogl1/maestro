import { act, render, waitFor } from "@testing-library/react";
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
import { killSession, spawnShell } from "@/lib/terminal";
import { useSessionStore } from "@/stores/useSessionStore";
import {
  MAX_RETAINED_PARKED_SAMURAI_TILES,
  TerminalGrid,
  type TerminalGridHandle,
} from "../TerminalGrid";

const invokeMock = vi.mocked(invoke);
const killSessionMock = vi.mocked(killSession);
const spawnShellMock = vi.mocked(spawnShell);

/** Puts a supervision entry on the session, as the supervisor listener would. */
function superviseSession(sessionId: number, state: string) {
  useSessionStore.setState((s) => ({
    samuraiBySessionId: {
      ...s.samuraiBySessionId,
      [sessionId]: { project: "C:/proj", epic: "#38", generation: 1, state: state as never },
    },
  }));
}

/** Renders the grid and launches its single slot, returning the session id. */
async function renderLaunchedGrid() {
  const ref = createRef<TerminalGridHandle>();
  render(<TerminalGrid ref={ref} projectPath="C:/proj" tabId="tab-1" isActive />);
  const handle = ref.current;
  if (!handle) throw new Error("expected TerminalGrid ref to be attached");
  await act(async () => {
    await handle.launchAll();
  });
  await waitFor(() => expect(useSessionStore.getState().sessions).toHaveLength(1));
  return useSessionStore.getState().sessions[0].id;
}

/** The imperative handle of the grid `renderLaunchedGridWith` last rendered. */
let lastGridHandle: TerminalGridHandle | null = null;

/** Renders the grid with `count` launched slots, returning their session ids. */
async function renderLaunchedGridWith(count: number) {
  const ref = createRef<TerminalGridHandle>();
  render(<TerminalGrid ref={ref} projectPath="C:/proj" tabId="tab-1" isActive />);
  const handle = ref.current;
  if (!handle) throw new Error("expected TerminalGrid ref to be attached");
  lastGridHandle = handle;
  await act(async () => {
    for (let i = 1; i < count; i++) handle.addSession();
  });
  await act(async () => {
    await handle.launchAll();
  });
  await waitFor(() => expect(useSessionStore.getState().sessions).toHaveLength(count));
  return useSessionStore.getState().sessions.map((s) => s.id);
}

describe("TerminalGrid samurai park (issue #122)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "generate_project_hash") return "hash";
      // The session listing reports what it could not return, so it is an
      // object, not a bare list.
      if (cmd === "list_claude_sessions") {
        return { sessions: [], total_found: 0, truncated: false, unreadable: 0 };
      }
      // Everything else the card/grid probes (mcp projects, plugins) is a
      // list — an undefined default crashes PreLaunchCard.
      return [];
    });
    killSessionMock.mockClear();
    spawnShellMock.mockReset();
    spawnShellMock.mockImplementation(async () => 1);
    lastGridHandle = null;
    useSessionStore.setState({ sessions: [], samuraiBySessionId: {}, parkedSessionIds: [] });
  });

  it("kills the PTY and parks the tile when a supervised session goes PARKED", async () => {
    const sessionId = await renderLaunchedGrid();
    expect(killSessionMock).not.toHaveBeenCalled();

    // The Phase-2 circuit breaker (samurai_progress.rs) transitions to PARKED
    // with no backend teardown — parking the tile without this kill would
    // orphan a live `claude --dangerously-skip-permissions` PTY.
    await act(async () => {
      superviseSession(sessionId, "PARKED");
    });

    await waitFor(() => expect(killSessionMock).toHaveBeenCalledWith(sessionId));
    // The tile moves to the existing footer parking tray — same mechanism as
    // the P button — rather than being torn down: the session stays known,
    // just parked, so unparking reopens its transcript.
    expect(useSessionStore.getState().sessions).toHaveLength(1);
    expect(useSessionStore.getState().parkedSessionIds).toEqual([sessionId]);
  });

  it("kills the PTY and parks the tile when a supervised session goes KILLED", async () => {
    const sessionId = await renderLaunchedGrid();

    await act(async () => {
      superviseSession(sessionId, "KILLED");
    });

    await waitFor(() => expect(killSessionMock).toHaveBeenCalledWith(sessionId));
    expect(useSessionStore.getState().parkedSessionIds).toEqual([sessionId]);
  });

  it("parks a DEAD session's tile without killing (process is already gone)", async () => {
    const sessionId = await renderLaunchedGrid();

    await act(async () => {
      superviseSession(sessionId, "DEAD");
    });

    await waitFor(() => expect(useSessionStore.getState().parkedSessionIds).toEqual([sessionId]));
    expect(killSessionMock).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions).toHaveLength(1);
  });

  it("does not re-kill an already-parked session on a redundant supervisor event", async () => {
    const sessionId = await renderLaunchedGrid();

    await act(async () => {
      superviseSession(sessionId, "PARKED");
    });
    await waitFor(() => expect(killSessionMock).toHaveBeenCalledTimes(1));

    // A duplicate/late event for the same terminal state must not re-fire
    // the kill — the parkedSet guard in TerminalGrid's effect stops it.
    await act(async () => {
      superviseSession(sessionId, "PARKED");
    });

    expect(killSessionMock).toHaveBeenCalledTimes(1);
  });

  it("kills the PTY of an ALREADY-PARKED tile the circuit breaker flips to PARKED", async () => {
    const sessionId = await renderLaunchedGrid();

    // The user parks a LIVE orchestrator with the P button: the tile hides,
    // the PTY keeps running (that is what park means).
    await act(async () => {
      useSessionStore.getState().parkSession(sessionId);
    });
    expect(killSessionMock).not.toHaveBeenCalled();

    // The Phase-2 circuit breaker later flips the same session to PARKED —
    // the one path that leaves the PTY alive. The kill must still fire, or an
    // agent running with --dangerously-skip-permissions keeps executing
    // off-screen forever.
    await act(async () => {
      superviseSession(sessionId, "PARKED");
    });

    await waitFor(() => expect(killSessionMock).toHaveBeenCalledWith(sessionId));
    expect(useSessionStore.getState().parkedSessionIds).toEqual([sessionId]);
  });

  // Nothing reaps auto-parked samurai tiles and the session cap no longer
  // bounds them, so an overnight run accrues one permanently-mounted
  // TerminalView + xterm buffer (and one shelf chip) per generation — ~48 for
  // a 24h run at 30-minute handoffs. Only the newest few transcripts are kept.
  it("disposes the oldest parked samurai tiles beyond the retention cap", async () => {
    let nextId = 100;
    spawnShellMock.mockImplementation(async () => nextId++);
    const ids = await renderLaunchedGridWith(MAX_RETAINED_PARKED_SAMURAI_TILES + 1);

    // Every generation ends, oldest first — exactly the shape a long run
    // leaves behind.
    for (const id of ids) {
      await act(async () => {
        superviseSession(id, "KILLED");
      });
    }

    // The newest N transcripts stay reachable in the tray; the oldest is gone
    // — session, activity feed, tile and all.
    await waitFor(() =>
      expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(
        ids.slice(-MAX_RETAINED_PARKED_SAMURAI_TILES),
      ),
    );
    expect(useSessionStore.getState().parkedSessionIds).toEqual(
      ids.slice(-MAX_RETAINED_PARKED_SAMURAI_TILES),
    );
  });

  // T11: the sidebar's "open a parked run" test only asserts that onNavigate
  // fired — nothing covered the unpark it promises. This is that half: App
  // routes onNavigate to `zoomSession`, which must bring the tile back out of
  // the tray, or the click opens a pane the user still cannot see.
  it("unparks the session when zoomSession opens a parked tile", async () => {
    const [sessionId] = await renderLaunchedGridWith(1);
    const handle = lastGridHandle;
    if (!handle) throw new Error("expected TerminalGrid ref to be attached");
    await act(async () => {
      useSessionStore.getState().parkSession(sessionId);
    });
    expect(useSessionStore.getState().parkedSessionIds).toEqual([sessionId]);

    await act(async () => {
      expect(handle.zoomSession(sessionId)).toBe(true);
    });

    expect(useSessionStore.getState().parkedSessionIds).toEqual([]);
  });

  it("keeps a user unpark unparked after an auto-park (PR #131 review H2)", async () => {
    const sessionId = await renderLaunchedGrid();

    await act(async () => {
      superviseSession(sessionId, "PARKED");
    });
    await waitFor(() => expect(useSessionStore.getState().parkedSessionIds).toEqual([sessionId]));

    // The user brings the tile back from the tray. The samurai entry keeps
    // its terminal state forever, so the auto-park must be one-shot — not
    // re-fire on the parked-set change and bounce the tile straight back.
    await act(async () => {
      useSessionStore.getState().unparkSession(sessionId);
    });

    expect(useSessionStore.getState().parkedSessionIds).toEqual([]);
    // And no redundant second kill for the already-dead PTY.
    expect(killSessionMock).toHaveBeenCalledTimes(1);
  });
});
