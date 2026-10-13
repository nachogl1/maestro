import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type GateHandler = (event: { payload: unknown }) => void;
const handlers: GateHandler[] = [];
const unlistenFn = vi.fn();
const listen = vi.fn(async (_event: string, handler: GateHandler) => {
  handlers.push(handler);
  return unlistenFn;
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: GateHandler) => listen(event, handler),
}));

import type { SamuraiTestGateProgress } from "@/lib/samurai";
import {
  initSamuraiGateListener,
  latestGateForProject,
  stopSamuraiGateListener,
  useSamuraiGateStore,
} from "../useSamuraiGateStore";

function tick(
  project: string,
  epic: string,
  step: SamuraiTestGateProgress["step"] = "cargo_test",
): SamuraiTestGateProgress {
  return { project, epic, step, detail: step, elapsed_secs: 1 };
}

describe("useSamuraiGateStore", () => {
  beforeEach(() => {
    useSamuraiGateStore.setState({ gates: {} });
    handlers.length = 0;
    listen.mockClear();
    unlistenFn.mockClear();
  });

  afterEach(() => {
    stopSamuraiGateListener();
    vi.restoreAllMocks();
  });

  it("record keeps only the latest tick per project and epic", () => {
    const { record } = useSamuraiGateStore.getState();
    record(tick("/p", "epic #1", "bootstrap_npm"));
    record(tick("/p", "epic #1", "cargo_test"));
    record(tick("/p", "epic #2", "passed"));

    const entries = Object.values(useSamuraiGateStore.getState().gates);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.progress.step).sort()).toEqual(["cargo_test", "passed"]);
  });

  it("record stamps the arrival time", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    useSamuraiGateStore.getState().record(tick("/p", "e"));
    expect(Object.values(useSamuraiGateStore.getState().gates)[0].at).toBe(1234);
  });

  it("clearProject drops only the given project's entries", () => {
    const { record } = useSamuraiGateStore.getState();
    record(tick("/p", "e1"));
    record(tick("/p", "e2"));
    record(tick("/other", "e1"));

    useSamuraiGateStore.getState().clearProject("/p");

    const entries = Object.values(useSamuraiGateStore.getState().gates);
    expect(entries.map((e) => e.progress.project)).toEqual(["/other"]);
  });

  it("latestGateForProject returns the newest entry of that project, or null", () => {
    const now = vi.spyOn(Date, "now");
    const { record } = useSamuraiGateStore.getState();
    now.mockReturnValue(100);
    record(tick("/p", "old"));
    now.mockReturnValue(300);
    record(tick("/other", "newest-elsewhere"));
    now.mockReturnValue(200);
    record(tick("/p", "new"));

    const { gates } = useSamuraiGateStore.getState();
    expect(latestGateForProject(gates, "/p")?.progress.epic).toBe("new");
    expect(latestGateForProject(gates, "/missing")).toBeNull();
  });

  it("initSamuraiGateListener records incoming events and is idempotent", async () => {
    await initSamuraiGateListener();
    await initSamuraiGateListener();

    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0][0]).toBe("samurai-test-gate-event");

    handlers[0]({ payload: tick("/p", "e", "failed") });
    const entry = latestGateForProject(useSamuraiGateStore.getState().gates, "/p");
    expect(entry?.progress.step).toBe("failed");
  });

  it("stopSamuraiGateListener detaches so the next init re-subscribes", async () => {
    await initSamuraiGateListener();
    stopSamuraiGateListener();

    expect(unlistenFn).toHaveBeenCalledTimes(1);

    await initSamuraiGateListener();
    expect(listen).toHaveBeenCalledTimes(2);
  });
});
