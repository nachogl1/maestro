import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted stores hydrate through the Tauri store plugin at import time;
// happy-dom has no Tauri backend, so stub it out.
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

import { useGitHubWatchdogStore } from "../useGitHubWatchdogStore";
import { countForArea, flagsByRow, useHealthStore } from "../useHealthStore";

const invokeMock = vi.mocked(invoke);

const APP_PATH = "C:\\git\\app";
const AUDIT_PATH = "C:\\data\\samurai\\audit\\app.jsonl";
const OTHER_PATH = "C:\\data\\samurai\\audit\\other.jsonl";
const WARN = 5 * 1024 * 1024;

/**
 * Wires the two commands one check makes. `fail` names a command that
 * should throw.
 */
function mockBackend({
  samuraiFiles = [] as unknown[],
  sizeWarnBytes = WARN,
  fail = null as null | string,
} = {}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === fail) throw new Error(`${cmd} exploded`);
    switch (cmd) {
      case "samurai_files_list":
        return { groups: [], entries: samuraiFiles };
      case "samurai_get_config":
        return { size_warn_bytes: sizeWarnBytes };
      default:
        return undefined;
    }
  });
}

/** One Samurai-managed inventory row, shaped like `SamuraiFileEntry`. */
function samuraiFile(path: string, sizeBytes: number) {
  return {
    group_id: "run:000000000000:38",
    kind: "AUDIT_LOG",
    path,
    size_bytes: sizeBytes,
    modified_at: new Date().toISOString(),
    project_path: APP_PATH,
    epic: null,
    in_use: false,
    has_live_session: false,
    fire_at: null,
  };
}

/** An inventory with one audit log over the warning threshold. */
function oversizedAudit() {
  return { samuraiFiles: [samuraiFile(AUDIT_PATH, 6 * 1024 * 1024)] };
}

describe("useHealthStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useHealthStore.setState({
      flags: [],
      baselineKeys: { secondbrain: null },
      dismissedKeys: [],
      toasts: [],
      lastCheckedAt: null,
      isChecking: false,
    });
    useGitHubWatchdogStore.setState({ notificationsEnabled: true });
  });

  it("raises flags but no toasts on the first check", async () => {
    mockBackend(oversizedAudit());
    await useHealthStore.getState().runCheck();

    const { flags, toasts, lastCheckedAt } = useHealthStore.getState();
    expect(countForArea(flags, "secondbrain")).toBe(1);
    expect(toasts).toEqual([]);
    expect(lastCheckedAt).not.toBeNull();
  });

  it("toasts only flags that are new since the previous check", async () => {
    mockBackend(oversizedAudit());
    await useHealthStore.getState().runCheck();

    // Second check: same audit log, plus a second oversized file.
    mockBackend({
      samuraiFiles: [
        samuraiFile(AUDIT_PATH, 6 * 1024 * 1024),
        samuraiFile(OTHER_PATH, 7 * 1024 * 1024),
      ],
    });
    await useHealthStore.getState().runCheck();

    const { toasts } = useHealthStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].area).toBe("secondbrain");
    expect(toasts[0].target).toBe("other.jsonl");

    // Third check with unchanged data: no repeat toast.
    await useHealthStore.getState().runCheck();
    expect(useHealthStore.getState().toasts).toHaveLength(1);
  });

  it("keeps badges but queues no toasts while notifications are off", async () => {
    useGitHubWatchdogStore.setState({ notificationsEnabled: false });
    mockBackend();
    await useHealthStore.getState().runCheck();

    mockBackend(oversizedAudit());
    await useHealthStore.getState().runCheck();

    const { flags, toasts } = useHealthStore.getState();
    expect(countForArea(flags, "secondbrain")).toBe(1);
    expect(toasts).toEqual([]);
  });

  it("keeps the last-known flags when the check failed", async () => {
    mockBackend(oversizedAudit());
    await useHealthStore.getState().runCheck();
    expect(countForArea(useHealthStore.getState().flags, "secondbrain")).toBe(1);

    mockBackend({ ...oversizedAudit(), fail: "samurai_files_list" });
    await useHealthStore.getState().runCheck();

    // Badge survives the blip, and recovery does not re-toast the same flag.
    expect(countForArea(useHealthStore.getState().flags, "secondbrain")).toBe(1);
    mockBackend(oversizedAudit());
    await useHealthStore.getState().runCheck();
    expect(useHealthStore.getState().toasts).toEqual([]);
  });

  it("hides a dismissed flag until it clears and comes back", async () => {
    mockBackend(oversizedAudit());
    await useHealthStore.getState().runCheck();
    const key = useHealthStore.getState().flags[0].key;

    useHealthStore.getState().dismissFlag(key);
    expect(useHealthStore.getState().flags).toEqual([]);

    // Still raised by the rules, still hidden — and no toast for it.
    await useHealthStore.getState().runCheck();
    expect(useHealthStore.getState().flags).toEqual([]);
    expect(useHealthStore.getState().toasts).toEqual([]);

    // The file shrinks back under the threshold: flag clears, and so does
    // the dismissal.
    mockBackend({ samuraiFiles: [samuraiFile(AUDIT_PATH, 1024)] });
    await useHealthStore.getState().runCheck();
    expect(useHealthStore.getState().dismissedKeys).toEqual([]);

    // Grows again: shown again.
    mockBackend(oversizedAudit());
    await useHealthStore.getState().runCheck();
    expect(countForArea(useHealthStore.getState().flags, "secondbrain")).toBe(1);
  });

  it("surfaces Samurai size warnings in the secondbrain area, keyed for row highlighting", async () => {
    mockBackend(oversizedAudit());
    await useHealthStore.getState().runCheck();

    const { flags, toasts } = useHealthStore.getState();
    expect(countForArea(flags, "secondbrain")).toBe(1);
    // First check ever: badge yes, toast no (first-run suppression).
    expect(toasts).toEqual([]);
    expect(
      flagsByRow(flags, "secondbrain")
        .get(`${AUDIT_PATH}|app.jsonl`)
        ?.map((f) => f.reason),
    ).toEqual(["audit log 6.0 MB (warn at 5.0 MB)"]);
  });

  it("keeps a dismissal made while a check is in flight", async () => {
    mockBackend(oversizedAudit());
    await useHealthStore.getState().runCheck();
    const key = useHealthStore.getState().flags[0].key;

    // Dismiss from inside the config read: that lands after runCheck has
    // read the state it later writes back, which is the window a stale
    // snapshot would silently undo.
    mockBackend(oversizedAudit());
    const backend = invokeMock.getMockImplementation();
    if (!backend) throw new Error("expected invokeMock to have a base implementation");
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "samurai_get_config") useHealthStore.getState().dismissFlag(key);
      return backend(cmd, args);
    });
    await useHealthStore.getState().runCheck();

    expect(useHealthStore.getState().dismissedKeys).toContain(key);
    expect(useHealthStore.getState().flags).toEqual([]);
  });

  it("ignores a re-entrant check while one is in flight", async () => {
    mockBackend(oversizedAudit());
    const first = useHealthStore.getState().runCheck();
    await useHealthStore.getState().runCheck();
    await first;
    const listCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "samurai_files_list");
    expect(listCalls).toHaveLength(1);
  });
});
