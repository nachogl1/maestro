import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The persisted zustand stores hydrate through the Tauri store plugin at
// import time; happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// "Are you sure you want to close this session?" — answered yes.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(async () => true),
}));

// xterm.js cannot mount in happy-dom.
vi.mock("@/hooks/useXtermSession", () => ({
  useXtermSession: () => {},
}));
vi.mock("@/hooks/useSessionBranch", () => ({
  useSessionBranch: () => null,
}));
vi.mock("@/lib/git", () => ({
  isGitWorktree: vi.fn(async () => false),
}));
vi.mock("@/lib/terminal", () => ({
  killSession: vi.fn().mockResolvedValue(undefined),
  writeStdin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/components/session/ActivityFeed", () => ({ ActivityFeed: () => null }));
vi.mock("@/components/quickactions/QuickActionsManager", () => ({
  QuickActionsManager: () => null,
}));

import { useScratchStore } from "@/stores/useScratchStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { TerminalView } from "../TerminalView";

const FOLDER = "/home/someone/Maestro Scratch";

function tab(id: string, projectPath: string, sessionIds: number[]): WorkspaceTab {
  return {
    id,
    name: id,
    projectPath,
    active: true,
    sessionIds,
    sessionsLaunched: true,
    workspaceType: "non-git",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
  };
}

/** Closes terminal `sessionId` through its header, the way the person does. */
async function closeTerminal(sessionId: number): Promise<void> {
  // The grid's own close path drops the session from its project tab.
  const onKill = (id: number) => {
    const ws = useWorkspaceStore.getState();
    const owner = ws.tabs.find((t) => t.sessionIds.includes(id));
    if (owner) ws.removeSessionFromProject(owner.id, id);
  };
  useSessionStore.setState({
    sessions: [{ id: sessionId, mode: "Shell", status: "Idle", name: "t" } as SessionConfig],
  });
  render(<TerminalView sessionId={sessionId} onKill={onKill} />);
  fireEvent.click(screen.getByRole("button", { name: `Kill session ${sessionId}` }));
  await waitFor(() =>
    expect(useWorkspaceStore.getState().tabs.some((t) => t.sessionIds.includes(sessionId))).toBe(
      false,
    ),
  );
}

describe("TerminalView close on a scratch project", () => {
  beforeEach(() => {
    useScratchStore.setState({
      folder: FOLDER,
      projects: [{ name: "demo", path: `${FOLDER}/demo`, createdAtMs: 1 }],
      question: null,
      error: null,
    });
  });
  afterEach(cleanup);

  it("closing a scratch project's last terminal asks delete or keep", async () => {
    useWorkspaceStore.setState({ tabs: [tab("scratch", `${FOLDER}/demo`, [1])] });

    await closeTerminal(1);

    expect(useScratchStore.getState().question).toMatchObject({
      tabId: "scratch",
      reason: "last-terminal",
    });
  });

  it("closing one of several terminals, or a normal project's last one, never asks", async () => {
    useWorkspaceStore.setState({
      tabs: [tab("scratch", `${FOLDER}/demo`, [1, 2]), tab("real", "/home/someone/git/app", [3])],
    });

    await closeTerminal(1);
    cleanup();
    await closeTerminal(3);

    expect(useScratchStore.getState().question).toBeNull();
  });
});
