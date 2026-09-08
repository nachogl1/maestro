import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
// The watchdog store persists through the Tauri store plugin; happy-dom has
// no Tauri backend, so stub it out (same as useSessionStore.samuraiFatal).
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
vi.mock("@/lib/osNotification", () => ({
  notifyOs: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { notifyOs } from "@/lib/osNotification";
import { formatResumeAt } from "@/lib/parkTime";
import type { SamuraiScheduleEntry } from "@/lib/samurai";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import {
  initSamuraiSupervisorListener,
  type SamuraiParkAlert,
  type SamuraiToast,
  useSessionStore,
} from "../useSessionStore";

/** Fixed clock, so every resume reading below is exact. */
const NOW = new Date("2026-08-06T10:00:00+00:00");

/** The park that was already armed when the app launched. */
const SEEDED: SamuraiScheduleEntry = {
  project_path: "C:/proj",
  epic: "#37",
  fire_at: "2026-08-13T09:05:00+00:00",
  reason: "park",
};

function entry(overrides: Partial<SamuraiScheduleEntry> = {}): SamuraiScheduleEntry {
  return { ...SEEDED, ...overrides };
}

/** Captured `samurai-schedule-event` handler — the backend's full-list emit. */
let emitSchedule: (entries: SamuraiScheduleEntry[]) => void;

/** The store as the app-start seed left it (see the first test). */
let afterSeed: { alerts: SamuraiParkAlert[]; toasts: SamuraiToast[]; osCalls: number };

beforeAll(async () => {
  vi.mocked(invoke).mockImplementation(((command: string) =>
    Promise.resolve(command === "samurai_schedule_list" ? [SEEDED] : undefined)) as typeof invoke);
  vi.mocked(listen).mockImplementation(((event: string, handler: (e: unknown) => void) => {
    if (event === "samurai-schedule-event") {
      emitSchedule = (entries) => {
        handler({ payload: entries });
      };
    }
    return Promise.resolve(() => {});
  }) as typeof listen);
  useGitHubWatchdogStore.setState({ notificationsEnabled: true });

  await initSamuraiSupervisorListener();
  // The seed is fire-and-forget inside the init — let its IPC settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const state = useSessionStore.getState();
  afterSeed = {
    alerts: state.samuraiParkAlerts,
    toasts: state.samuraiToasts,
    osCalls: vi.mocked(notifyOs).mock.calls.length,
  };
});

describe("allowance park visibility — the startup seed", () => {
  it("marks parks that already existed, without announcing them again", () => {
    // Coming back to a week-old park is the whole point of the marker…
    expect(afterSeed.alerts).toEqual([
      {
        key: expect.stringContaining("#37"),
        project: "C:/proj",
        epic: "#37",
        fireAt: SEEDED.fire_at,
        acknowledged: false,
      },
    ]);
    // …but toasting it on every launch is noise: the user has known for days.
    expect(afterSeed.toasts).toEqual([]);
    expect(afterSeed.osCalls).toBe(0);
  });
});

describe("allowance park visibility — live schedule events", () => {
  beforeEach(() => {
    // Fake timers only here: the seed above runs on the real clock.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useSessionStore.setState({ samuraiParkAlerts: [], samuraiToasts: [], samuraiSchedule: [] });
    useGitHubWatchdogStore.setState({ notificationsEnabled: true });
    vi.mocked(notifyOs).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces a new park on every loud surface, naming project, epic and resume time", () => {
    emitSchedule([entry()]);

    const state = useSessionStore.getState();
    expect(state.samuraiToasts).toHaveLength(1);
    expect(state.samuraiToasts[0]).toMatchObject({
      kind: "park",
      project: "C:/proj",
      epic: "#37",
      label: `resumes ${formatResumeAt(SEEDED.fire_at)}`,
    });
    // Never a bare HH:MM — a park governed by the 7-day window reads as this
    // afternoon without the date, which is the whole reason parkTime exists.
    expect(state.samuraiToasts[0].label).toContain("in 6d");
    expect(vi.mocked(notifyOs).mock.calls).toEqual([
      ["Samurai parked — proj", `#37 · resumes ${formatResumeAt(SEEDED.fire_at)}`],
    ]);
    // The marker outlives the toast: it is what is still there hours later.
    expect(state.samuraiParkAlerts).toHaveLength(1);
    expect(state.samuraiParkAlerts[0].acknowledged).toBe(false);
  });

  it("fires once per park — the backend re-emits the FULL list on every change", () => {
    emitSchedule([entry()]);
    emitSchedule([entry()]);
    emitSchedule([entry()]);
    expect(useSessionStore.getState().samuraiToasts).toHaveLength(1);
    expect(notifyOs).toHaveBeenCalledTimes(1);

    // A second epic parks: only the newcomer announces itself.
    emitSchedule([entry(), entry({ epic: "#42", fire_at: "2026-08-14T09:05:00+00:00" })]);
    const toasts = useSessionStore.getState().samuraiToasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[1].epic).toBe("#42");
    expect(notifyOs).toHaveBeenCalledTimes(2);
  });

  it("ignores scheduled-launch timers — they are not parks (issue #129)", () => {
    emitSchedule([entry({ epic: "#99", reason: "scheduled_launch" })]);

    const state = useSessionStore.getState();
    expect(state.samuraiParkAlerts).toEqual([]);
    expect(state.samuraiToasts).toEqual([]);
    expect(notifyOs).not.toHaveBeenCalled();
  });

  it("drops the marker when the timer fires or is cancelled", () => {
    emitSchedule([entry(), entry({ epic: "#42" })]);
    expect(useSessionStore.getState().samuraiParkAlerts).toHaveLength(2);

    emitSchedule([entry({ epic: "#42" })]);
    expect(useSessionStore.getState().samuraiParkAlerts.map((a) => a.epic)).toEqual(["#42"]);

    emitSchedule([]);
    expect(useSessionStore.getState().samuraiParkAlerts).toEqual([]);
  });

  it("keeps an acknowledged park acknowledged across re-emits", () => {
    emitSchedule([entry()]);
    useSessionStore.getState().acknowledgeSamuraiParks("C:/proj");
    expect(useSessionStore.getState().samuraiParkAlerts[0].acknowledged).toBe(true);

    emitSchedule([entry()]);
    expect(useSessionStore.getState().samuraiParkAlerts[0].acknowledged).toBe(true);
    // Acknowledging must not re-arm the announcement either.
    expect(useSessionStore.getState().samuraiToasts).toHaveLength(1);
  });

  it("notifications off suppresses the toast and the OS pop-up but never the marker", () => {
    useGitHubWatchdogStore.setState({ notificationsEnabled: false });

    emitSchedule([entry()]);

    const state = useSessionStore.getState();
    expect(state.samuraiToasts).toEqual([]);
    expect(notifyOs).not.toHaveBeenCalled();
    expect(state.samuraiParkAlerts).toHaveLength(1);
  });

  it("acknowledges one project at a time, or all of them", () => {
    emitSchedule([entry(), entry({ project_path: "C:/other", epic: "#42" })]);

    useSessionStore.getState().acknowledgeSamuraiParks("C:/proj");
    expect(useSessionStore.getState().samuraiParkAlerts.map((a) => a.acknowledged)).toEqual([
      true,
      false,
    ]);

    useSessionStore.getState().acknowledgeSamuraiParks();
    expect(useSessionStore.getState().samuraiParkAlerts.map((a) => a.acknowledged)).toEqual([
      true,
      true,
    ]);
  });

  it("re-announces an epic that parks again with a new resume time", () => {
    emitSchedule([entry()]);
    emitSchedule([]);
    emitSchedule([entry({ fire_at: "2026-09-01T09:05:00+00:00" })]);

    expect(useSessionStore.getState().samuraiToasts).toHaveLength(2);
  });

  it("still announces a park whose fire time does not parse", () => {
    emitSchedule([entry({ fire_at: "garbage" })]);

    expect(useSessionStore.getState().samuraiToasts[0].label).toBe("resumes garbage");
    expect(useSessionStore.getState().samuraiParkAlerts).toHaveLength(1);
  });
});
