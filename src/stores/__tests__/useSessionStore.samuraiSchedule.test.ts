import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  initSamuraiSupervisorListener,
  stopSamuraiSupervisorListener,
  useSessionStore,
  type SamuraiScheduleEntry,
} from "../useSessionStore";

const listenMock = vi.mocked(listen);
const invokeMock = vi.mocked(invoke);

function entry(overrides: Partial<SamuraiScheduleEntry> = {}): SamuraiScheduleEntry {
  return {
    project_path: "C:/proj",
    epic: "#37",
    fire_at: "2026-08-06T14:32:00+00:00",
    reason: "park",
    ...overrides,
  };
}

/** Captured event handler, so tests can emit schedule events. */
let emitScheduleEvent: (payload: unknown) => void;

beforeAll(async () => {
  // The seeds on init must find nothing; individual tests emit events.
  invokeMock.mockResolvedValue([]);
  listenMock.mockImplementation(((event: string, handler: (e: unknown) => void) => {
    if (event === "samurai-schedule-event") {
      emitScheduleEvent = (payload) => handler({ payload });
    }
    return Promise.resolve(() => {});
  }) as typeof listen);
  await initSamuraiSupervisorListener();
});

describe("useSessionStore samurai schedule tracking (issue #61)", () => {
  beforeEach(() => {
    useSessionStore.setState({ samuraiSchedule: [] });
  });

  it("replaces the timer list wholesale on every schedule event", () => {
    emitScheduleEvent([entry(), entry({ epic: "#38", project_path: "C:/other" })]);
    expect(useSessionStore.getState().samuraiSchedule).toHaveLength(2);

    // The backend sends the FULL list — a later event replaces, not merges.
    emitScheduleEvent([entry({ epic: "#38", project_path: "C:/other" })]);
    const timers = useSessionStore.getState().samuraiSchedule;
    expect(timers).toHaveLength(1);
    expect(timers[0].epic).toBe("#38");
  });

  it("an empty event clears the countdown (last timer fired)", () => {
    emitScheduleEvent([entry()]);
    expect(useSessionStore.getState().samuraiSchedule).toHaveLength(1);

    emitScheduleEvent([]);
    expect(useSessionStore.getState().samuraiSchedule).toEqual([]);
  });

  it("ignores a non-array payload (defensive against a mocked IPC layer)", () => {
    emitScheduleEvent([entry()]);
    emitScheduleEvent({ not: "an array" });
    expect(useSessionStore.getState().samuraiSchedule).toHaveLength(1);
  });

  it("seeds pending timers from samurai_schedule_list on init", async () => {
    // stop + init re-runs the whole init path, including the seed — this is
    // the "app restarted with parked epics" case.
    stopSamuraiSupervisorListener();
    invokeMock.mockImplementation(((cmd: string) => {
      if (cmd === "samurai_schedule_list") {
        return Promise.resolve([entry({ epic: "#40" })]);
      }
      return Promise.resolve([]);
    }) as typeof invoke);
    await initSamuraiSupervisorListener();
    // Seeding is fire-and-forget after init resolves; flush the microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timers = useSessionStore.getState().samuraiSchedule;
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ epic: "#40", reason: "park" });
  });

  it("a stale seed never overwrites a live event that raced it (review F8)", async () => {
    stopSamuraiSupervisorListener();
    let resolveSeed!: (value: unknown) => void;
    invokeMock.mockImplementation(((cmd: string) => {
      if (cmd === "samurai_schedule_list") {
        // The seed's IPC round-trip stays in flight until the test says so.
        return new Promise((resolve) => {
          resolveSeed = resolve;
        });
      }
      return Promise.resolve([]);
    }) as typeof invoke);
    await initSamuraiSupervisorListener();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A live event lands while the seed is still in flight: the #37 timer
    // fired, the full-list event now says "#38 only".
    emitScheduleEvent([entry({ epic: "#38" })]);
    // The seed's snapshot (still listing the fired #37) resolves AFTER.
    resolveSeed([entry({ epic: "#37" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timers = useSessionStore.getState().samuraiSchedule;
    expect(timers).toHaveLength(1);
    expect(timers[0].epic).toBe("#38");
  });
});
