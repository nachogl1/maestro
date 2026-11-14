import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted workspace store hydrates through the Tauri store plugin at
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
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { invoke } from "@tauri-apps/api/core";
import { useActivityStore } from "@/stores/useActivityStore";
import {
  BROUGHT_BACK_MESSAGE,
  buildOpenTerminals,
  type OfferedTerminal,
  type OpenTerminalsInput,
  type OpenTerminalsOffer,
  resetOpenTerminalsSnapshotForTests,
  useOpenTerminalsSnapshotStore,
} from "@/stores/useOpenTerminalsSnapshotStore";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";

const invokeMock = vi.mocked(invoke);

const SHOP = "C:\\work\\shop-api";
const DOCS = "C:\\work\\docs-site";
const CONVERSATION = "0b5e6a4c-1d2f-4e3a-9b8c-7d6e5f4a3b2c";

function tab(id: string, projectPath: string, sessionIds: number[] = []): WorkspaceTab {
  return {
    id,
    name: projectPath.split("\\").pop() ?? projectPath,
    projectPath,
    active: id === "shop",
    sessionIds,
    sessionsLaunched: false,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: projectPath,
    worktreeBasePath: null,
  };
}

function session(id: number, projectPath: string, overrides: Partial<SessionConfig> = {}) {
  return {
    id,
    mode: "Claude",
    name: `agent-${id}`,
    branch: null,
    worktree_path: null,
    project_path: projectPath,
    working_directory: projectPath,
    status: "Idle",
    ...overrides,
  } satisfies SessionConfig;
}

function offered(overrides: Partial<OfferedTerminal> = {}): OfferedTerminal {
  return {
    projectPath: SHOP,
    name: "checkout-fix",
    kind: "Claude",
    workingDirectory: SHOP,
    branch: null,
    pinned: false,
    parked: false,
    samurai: false,
    conversationId: CONVERSATION,
    folderExists: true,
    conversationFound: true,
    ...overrides,
  };
}

/** The backend: answers the load with `offer`, records everything else. */
function backend(offer: OpenTerminalsOffer | null): void {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "open_terminals_load") return offer;
    return undefined;
  });
}

function calls(command: string): unknown[][] {
  return invokeMock.mock.calls.filter(([c]) => c === command);
}

/** Adds a session the way a launch does, so the store reacts to it. */
function addSession(config: SessionConfig): void {
  useSessionStore.getState().addSession(config);
}

describe("buildOpenTerminals", () => {
  const base: OpenTerminalsInput = {
    tabs: [],
    sessions: [],
    parkedSessionIds: [],
    pinnedSessionIds: [],
    samuraiSessionIds: [],
    conversationBySessionId: {},
  };

  it("groups terminals by project in tab order, then in the order each project opened them", () => {
    const list = buildOpenTerminals({
      ...base,
      tabs: [tab("docs", DOCS, [4]), tab("shop", SHOP, [3, 1])],
      sessions: [
        session(1, SHOP),
        session(2, "C:\\work\\no-tab"),
        session(3, SHOP),
        session(4, DOCS),
        session(5, SHOP),
      ],
    });

    expect(list.map((t) => t.name)).toEqual([
      "agent-4",
      "agent-3",
      "agent-1",
      "agent-5",
      "agent-2",
    ]);
  });

  it("records name, kind, folder, branch, pin, park, Samurai and the latest conversation", () => {
    const worktree = "C:\\wt\\shop-api-feature";
    const list = buildOpenTerminals({
      ...base,
      tabs: [tab("shop", SHOP, [1, 2])],
      sessions: [
        session(1, SHOP, { working_directory: worktree, branch: "feat/x" }),
        session(2, SHOP, { mode: "Plain", name: "  " }),
      ],
      pinnedSessionIds: [1],
      parkedSessionIds: [2],
      samuraiSessionIds: [1],
      conversationBySessionId: { 1: CONVERSATION, 2: "ignored-for-a-shell" },
    });

    expect(list).toEqual([
      {
        projectPath: SHOP,
        name: "agent-1",
        kind: "Claude",
        workingDirectory: worktree,
        branch: "feat/x",
        pinned: true,
        parked: false,
        samurai: true,
        conversationId: CONVERSATION,
      },
      {
        projectPath: SHOP,
        name: null,
        kind: "Plain",
        workingDirectory: SHOP,
        branch: null,
        pinned: false,
        parked: true,
        samurai: false,
        conversationId: null,
      },
    ]);
  });
});

describe("useOpenTerminalsSnapshotStore", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetOpenTerminalsSnapshotForTests();
    invokeMock.mockReset();
    usePendingLaunchStore.setState({ pending: [] });
    useActivityStore.setState({ sessions: {} });
    useSessionStore.setState({
      sessions: [],
      parkedSessionIds: [],
      pinnedSessionIds: [],
      attentionSessionIds: [],
      samuraiBySessionId: {},
    });
    useWorkspaceStore.setState({ tabs: [tab("shop", SHOP), tab("docs", DOCS)] });
  });

  it.each([
    // A normal close removes the list, so its next start is a first start.
    ["a first start or a start after a normal close (no list)", null],
    [
      "a list holding only Samurai terminals",
      { savedAt: 1, terminals: [offered({ samurai: true })] },
    ],
    ["an empty list", { savedAt: 1, terminals: [] }],
  ])("offers nothing on %s and starts saving the open terminals", async (_case, offer) => {
    backend(offer);

    await useOpenTerminalsSnapshotStore.getState().begin();

    expect(useOpenTerminalsSnapshotStore.getState().offer).toBeNull();
    expect(calls("open_terminals_save")).toEqual([["open_terminals_save", { terminals: [] }]]);
  });

  it("offers a found list and saves nothing over it until it is answered", async () => {
    const offer = { savedAt: 1, terminals: [offered()] };
    backend(offer);

    await useOpenTerminalsSnapshotStore.getState().begin();
    addSession(session(7, SHOP));

    expect(useOpenTerminalsSnapshotStore.getState().offer).toEqual(offer);
    expect(calls("open_terminals_save")).toEqual([]);
  });

  it("declining removes the list and then keeps the new one up to date", async () => {
    vi.useFakeTimers();
    backend({ savedAt: 1, terminals: [offered()] });
    await useOpenTerminalsSnapshotStore.getState().begin();

    await useOpenTerminalsSnapshotStore.getState().decline();
    addSession(session(7, SHOP));
    await vi.advanceTimersByTimeAsync(1000);

    expect(useOpenTerminalsSnapshotStore.getState().offer).toBeNull();
    expect(calls("open_terminals_clear")).toHaveLength(1);
    const saves = calls("open_terminals_save");
    expect(saves.at(-1)?.[1]).toEqual({
      terminals: [expect.objectContaining({ projectPath: SHOP, name: "agent-7" })],
    });
  });

  it("brings back the chosen terminals in order: a found conversation resumes, the rest open new", async () => {
    const terminals = [
      offered({ name: "checkout-fix", branch: "feat/x", workingDirectory: "C:\\wt\\x" }),
      offered({
        name: "dev server",
        kind: "Plain",
        conversationId: null,
        conversationFound: false,
      }),
      offered({
        name: "search-index",
        projectPath: DOCS,
        workingDirectory: DOCS,
        conversationFound: false,
      }),
      offered({ name: "old-experiment", folderExists: false }),
    ];
    backend({ savedAt: 1, terminals });
    await useOpenTerminalsSnapshotStore.getState().begin();

    await useOpenTerminalsSnapshotStore.getState().bringBack(terminals);

    expect(calls("open_terminals_clear")).toHaveLength(1);
    const pending = usePendingLaunchStore.getState().pending;
    expect(pending.map((p) => [p.tabId, p.mode, p.customName, p.resumeSessionId])).toEqual([
      ["shop", "Claude", "checkout-fix", CONVERSATION],
      ["shop", "Plain", "dev server", null],
      ["docs", "Claude", "search-index", null],
    ]);
    expect(pending[0]).toMatchObject({ workingDirOverride: "C:\\wt\\x", branch: "feat/x" });
    const launched = useWorkspaceStore.getState().tabs.map((t) => [t.id, t.sessionsLaunched]);
    expect(launched).toEqual([
      ["shop", true],
      ["docs", true],
    ]);
  });

  it("queues two look-alike shells as two launches", async () => {
    const shell = offered({
      name: null,
      kind: "Plain",
      conversationId: null,
      conversationFound: false,
    });
    backend({ savedAt: 1, terminals: [shell, shell] });
    await useOpenTerminalsSnapshotStore.getState().begin();

    await useOpenTerminalsSnapshotStore.getState().bringBack([shell, shell]);

    expect(usePendingLaunchStore.getState().pending).toHaveLength(2);
  });

  it("gives each reopened terminal its pin, its shelf place with the needs-you signal, and its warning", async () => {
    const terminals = [
      offered({ name: "pinned-resumed", pinned: true }),
      offered({ name: "parked-shell", kind: "Plain", parked: true, conversationFound: false }),
      offered({ name: "lost", conversationFound: false }),
    ];
    backend({ savedAt: 1, terminals });
    await useOpenTerminalsSnapshotStore.getState().begin();
    await useOpenTerminalsSnapshotStore.getState().bringBack(terminals);

    addSession(session(11, SHOP, { name: "pinned-resumed" }));
    addSession(session(12, SHOP, { name: "parked-shell", mode: "Plain" }));
    addSession(session(13, SHOP, { name: "lost" }));

    const sessions = useSessionStore.getState();
    expect(sessions.pinnedSessionIds).toEqual([11]);
    expect(sessions.parkedSessionIds).toEqual([12]);
    expect(sessions.sessions.find((s) => s.id === 12)).toMatchObject({
      status: "NeedsInput",
      statusMessage: BROUGHT_BACK_MESSAGE,
    });
    expect(useOpenTerminalsSnapshotStore.getState().warnedSessionIds).toEqual([12, 13]);

    // A terminal opened afterwards gets nothing.
    addSession(session(14, SHOP));
    expect(useSessionStore.getState().pinnedSessionIds).toEqual([11]);
    expect(useOpenTerminalsSnapshotStore.getState().warnedSessionIds).toEqual([12, 13]);
  });

  it("a parked Claude terminal keeps the needs-you signal through its session start", async () => {
    const terminals = [offered({ name: "payments-review", parked: true })];
    backend({ savedAt: 1, terminals });
    await useOpenTerminalsSnapshotStore.getState().begin();
    await useOpenTerminalsSnapshotStore.getState().bringBack(terminals);
    addSession(session(31, SHOP));

    // The resumed claude's SessionStart hook paints the terminal Idle.
    useSessionStore
      .getState()
      .updateSession(31, { status: "Idle", statusMessage: "Session started" });
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ status: "NeedsInput" });

    // Later statuses are the agent's own.
    useSessionStore.getState().updateSession(31, { status: "Working" });
    useSessionStore.getState().updateSession(31, { status: "Idle" });
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ status: "Idle" });
  });

  it("closing a warning removes it, and a closed terminal loses its warning", async () => {
    const terminals = [
      offered({ name: "a", conversationFound: false }),
      offered({ name: "b", conversationFound: false }),
    ];
    backend({ savedAt: 1, terminals });
    await useOpenTerminalsSnapshotStore.getState().begin();
    await useOpenTerminalsSnapshotStore.getState().bringBack(terminals);
    addSession(session(21, SHOP));
    addSession(session(22, SHOP));

    useOpenTerminalsSnapshotStore.getState().dismissWarning(21);
    useSessionStore.getState().removeSession(22);

    expect(useOpenTerminalsSnapshotStore.getState().warnedSessionIds).toEqual([]);
  });
});
