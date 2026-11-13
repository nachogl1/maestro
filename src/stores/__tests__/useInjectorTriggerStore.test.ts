import { beforeEach, describe, expect, it, vi } from "vitest";

// One in-memory settings file that outlives a module reload, as the real
// store file in Maestro's app data outlives an app restart.
const disk = new Map<string, unknown>();
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn(async (key: string) => disk.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      disk.set(key, value);
    }),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(async (key: string) => {
      disk.delete(key);
    }),
  })),
}));

const SAVED_KEY = "maestro-injector-triggers";

/** Loads the stores as a fresh app launch does and waits for the saved triggers. */
async function launch() {
  vi.resetModules();
  const { useInjectorTriggerStore } = await import("../useInjectorTriggerStore");
  const { useSessionStore } = await import("../useSessionStore");
  await useInjectorTriggerStore.persist.rehydrate();
  return { store: useInjectorTriggerStore, sessions: useSessionStore };
}

function liveSession(id: number) {
  return {
    id,
    mode: "Claude" as const,
    name: null,
    branch: null,
    worktree_path: null,
    project_path: "C:\\git\\demo",
    status: "Idle" as const,
  };
}

describe("useInjectorTriggerStore", () => {
  beforeEach(() => disk.clear());

  it("brings every trigger back after a restart, re-armed and watching no old terminal", async () => {
    const before = await launch();
    before.sessions.setState({ sessions: [liveSession(1), liveSession(2)] });
    before.store.getState().addTrigger({
      name: "Compact reminder",
      watch: "ticked",
      watchIds: [1, 2],
      threshold: 80,
      message: "Run /compact",
      target: "reached",
    });
    before.store.getState().addTrigger({
      watch: "all",
      watchIds: [],
      threshold: 90,
      message: "write a handoff",
      target: "all",
    });
    const [ticked] = before.store.getState().triggers;
    before.store.getState().setFiredIds(new Map([[ticked.id, [1]]]));
    await vi.waitFor(() => expect(disk.has(SAVED_KEY)).toBe(true));

    const after = await launch();

    expect(after.store.getState().triggers).toEqual([
      {
        id: ticked.id,
        name: "Compact reminder",
        watch: "ticked",
        watchIds: [],
        threshold: 80,
        message: "Run /compact",
        target: "reached",
        firedIds: [],
        lastFire: null,
      },
      expect.objectContaining({ name: "", watch: "all", threshold: 90, firedIds: [] }),
    ]);
  });

  it("saves an edit and a delete", async () => {
    const before = await launch();
    const input = { watch: "all" as const, watchIds: [], threshold: 50, target: "all" as const };
    before.store.getState().addTrigger({ ...input, message: "first" });
    before.store.getState().addTrigger({ ...input, message: "second" });
    const [first, second] = before.store.getState().triggers;
    before.store
      .getState()
      .updateTrigger(first.id, { ...input, name: "Renamed", threshold: 60, message: "first!" });
    before.store.getState().removeTrigger(second.id);
    await vi.waitFor(() => expect(String(disk.get(SAVED_KEY))).toContain("Renamed"));

    const after = await launch();

    expect(after.store.getState().triggers).toEqual([
      expect.objectContaining({ id: first.id, name: "Renamed", threshold: 60, message: "first!" }),
    ]);
  });

  it("gives a new trigger an id no loaded trigger has", async () => {
    disk.set(
      SAVED_KEY,
      JSON.stringify({
        state: {
          triggers: [
            { id: "trigger-1", name: "", watch: "all", threshold: 50, message: "a", target: "all" },
          ],
        },
        version: 1,
      }),
    );
    const { store } = await launch();
    store
      .getState()
      .addTrigger({ watch: "all", watchIds: [], threshold: 60, message: "b", target: "all" });

    const ids = store.getState().triggers.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  it.each([
    { what: "a damaged file", saved: "{not json" },
    { what: "a file of another shape", saved: JSON.stringify({ state: { triggers: "x" } }) },
    { what: "an older version", saved: JSON.stringify({ state: { triggers: null }, version: 0 }) },
    { what: "a bare value", saved: JSON.stringify(42) },
  ])("starts with no trigger and keeps working after $what", async ({ saved }) => {
    disk.set(SAVED_KEY, saved);
    const { store } = await launch();

    expect(store.getState().triggers).toEqual([]);
    store
      .getState()
      .addTrigger({ watch: "all", watchIds: [], threshold: 60, message: "b", target: "all" });
    expect(store.getState().triggers).toHaveLength(1);
  });

  it("stops watching a ticked terminal once it closes, so a new terminal with its number is not watched", async () => {
    const { store, sessions } = await launch();
    sessions.setState({ sessions: [liveSession(1), liveSession(2)] });
    store.getState().addTrigger({
      watch: "ticked",
      watchIds: [1, 2],
      threshold: 60,
      message: "b",
      target: "all",
    });

    sessions.setState({ sessions: [liveSession(1)] });

    expect(store.getState().triggers[0].watchIds).toEqual([1]);
  });
});

describe("useTriggerHistoryStore", () => {
  it("keeps one waiting follow-up per trigger and terminal, the newest firing's", async () => {
    vi.resetModules();
    const { useTriggerHistoryStore } = await import("../useInjectorTriggerStore");
    const waiting = (firingId: string, sessionId: number, triggerId = "t1") => ({
      triggerId,
      triggerName: "Compact",
      sessionId,
      terminal: `term-${sessionId}`,
      project: "demo",
      threshold: 80,
      baseline: 85,
      firingId,
      firingAt: 1,
      firedBy: "term-1",
    });
    const history = useTriggerHistoryStore.getState();
    history.addPendingFollowUps([waiting("f1", 1), waiting("f1", 2), waiting("f1", 1, "t2")]);
    history.addPendingFollowUps([waiting("f2", 1)]);

    expect(
      useTriggerHistoryStore.getState().pending.map((p) => [p.triggerId, p.sessionId, p.firingId]),
    ).toEqual([
      ["t1", 2, "f1"],
      ["t2", 1, "f1"],
      ["t1", 1, "f2"],
    ]);
  });
});
