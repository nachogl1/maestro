import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

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

import { HEALTH_THRESHOLDS } from "../../lib/healthRules";
import type { DevProcess } from "../../lib/processes";
import { useGitHubWatchdogStore } from "../useGitHubWatchdogStore";
import { countForArea, flagsByRow, useHealthStore } from "../useHealthStore";

const invokeMock = vi.mocked(invoke);

/** `C:\git\app` encoded the way Claude Code names its project directories. */
const APP_DIR = "C--git-app";
const APP_PATH = "C:\\git\\app";

function proc(overrides: Partial<DevProcess> = {}): DevProcess {
  return {
    pid: 100,
    parentPid: 1,
    name: "node",
    cmd: "node vite",
    cwd: APP_PATH,
    memoryBytes: 1024,
    cpuPercent: 1,
    runTimeSecs: 10,
    isMaestro: false,
    matched: "vite",
    ports: [],
    ...overrides,
  };
}

/**
 * Wires the five commands one check makes. `memoryFiles` is keyed by memory
 * dir; `fail` names a command that should throw.
 */
function mockBackend({
  memoryProjects = [] as Array<{ dirName: string }>,
  memoryFiles = {} as Record<string, unknown[]>,
  processes = [] as DevProcess[],
  samuraiFiles = [] as unknown[],
  sizeWarnBytes = 5 * 1024 * 1024,
  fail = null as null | string,
} = {}) {
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === fail) throw new Error(`${cmd} exploded`);
    switch (cmd) {
      case "list_memory_projects":
        return memoryProjects.map((p) => ({
          dirName: p.dirName,
          memoryPath: `/m/${p.dirName}`,
          fileCount: (memoryFiles[p.dirName] ?? []).length,
          isActive: false,
        }));
      case "list_memory_files":
        return memoryFiles[args?.dirName as string] ?? [];
      case "list_dev_processes":
        return processes;
      case "samurai_files_list":
        return samuraiFiles;
      case "samurai_get_config":
        return { size_warn_bytes: sizeWarnBytes };
      default:
        return undefined;
    }
  });
}

function memFile(relPath: string, overrides: Record<string, unknown> = {}) {
  return {
    relPath,
    path: `/m/${relPath}`,
    description: null,
    memType: null,
    isIndex: relPath === "MEMORY.md",
    sizeBytes: 100,
    modified: new Date().toISOString(),
    ...overrides,
  };
}

/** One Samurai-managed inventory row, shaped like `SamuraiFileEntry`. */
function samuraiFile(path: string, sizeBytes: number) {
  return {
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

/** A project whose fact count is one over the threshold. */
function sprawlingProject() {
  return {
    memoryProjects: [{ dirName: APP_DIR }],
    memoryFiles: {
      [APP_DIR]: Array.from({ length: HEALTH_THRESHOLDS.maxFactFiles + 1 }, (_, i) =>
        memFile(`f${i}.md`),
      ),
    },
  };
}

describe("useHealthStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useHealthStore.setState({
      flags: [],
      streaks: {},
      baselineKeys: { memory: null, processes: null, secondbrain: null },
      dismissedKeys: [],
      toasts: [],
      lastCheckedAt: null,
      isChecking: false,
    });
    useGitHubWatchdogStore.setState({ notificationsEnabled: true });
  });

  it("raises flags but no toasts on the first check", async () => {
    mockBackend(sprawlingProject());
    await useHealthStore.getState().runCheck();

    const { flags, toasts, lastCheckedAt } = useHealthStore.getState();
    expect(countForArea(flags, "memory")).toBe(1);
    expect(toasts).toEqual([]);
    expect(lastCheckedAt).not.toBeNull();
  });

  it("toasts only flags that are new since the previous check", async () => {
    mockBackend(sprawlingProject());
    await useHealthStore.getState().runCheck();

    // Second check: same sprawl, plus a long-running process.
    mockBackend({
      ...sprawlingProject(),
      processes: [proc({ runTimeSecs: HEALTH_THRESHOLDS.runTimeSecs + 60 })],
    });
    await useHealthStore.getState().runCheck();

    const { toasts } = useHealthStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].area).toBe("processes");
    expect(toasts[0].reason).toBe("running 24h");

    // Third check with unchanged data: no repeat toast.
    await useHealthStore.getState().runCheck();
    expect(useHealthStore.getState().toasts).toHaveLength(1);
  });

  it("keeps badges but queues no toasts while notifications are off", async () => {
    useGitHubWatchdogStore.setState({ notificationsEnabled: false });
    mockBackend({ processes: [] });
    await useHealthStore.getState().runCheck();

    mockBackend({ processes: [proc({ runTimeSecs: HEALTH_THRESHOLDS.runTimeSecs + 60 })] });
    await useHealthStore.getState().runCheck();

    const { flags, toasts } = useHealthStore.getState();
    expect(countForArea(flags, "processes")).toBe(1);
    expect(toasts).toEqual([]);
  });

  it("keeps the last-known flags of an area whose check failed", async () => {
    mockBackend(sprawlingProject());
    await useHealthStore.getState().runCheck();
    expect(countForArea(useHealthStore.getState().flags, "memory")).toBe(1);

    mockBackend({ ...sprawlingProject(), fail: "list_memory_projects" });
    await useHealthStore.getState().runCheck();

    // Badge survives the blip, and recovery does not re-toast the same flag.
    expect(countForArea(useHealthStore.getState().flags, "memory")).toBe(1);
    mockBackend(sprawlingProject());
    await useHealthStore.getState().runCheck();
    expect(useHealthStore.getState().toasts).toEqual([]);
  });

  it("never reads a memory file body â€” every rule works off the listing", async () => {
    mockBackend(sprawlingProject());
    await useHealthStore.getState().runCheck();

    const commands = invokeMock.mock.calls.map(([cmd]) => cmd);
    expect(commands).not.toContain("read_memory_file");
    expect(commands).not.toContain("check_paths_exist");
  });

  it("hides a dismissed flag until it clears and comes back", async () => {
    mockBackend(sprawlingProject());
    await useHealthStore.getState().runCheck();
    const key = useHealthStore.getState().flags[0].key;

    useHealthStore.getState().dismissFlag(key);
    expect(useHealthStore.getState().flags).toEqual([]);

    // Still raised by the rules, still hidden â€” and no toast for it.
    await useHealthStore.getState().runCheck();
    expect(useHealthStore.getState().flags).toEqual([]);
    expect(useHealthStore.getState().toasts).toEqual([]);

    // The project is pruned back under the threshold: flag clears, and so
    // does the dismissal.
    mockBackend({
      memoryProjects: [{ dirName: APP_DIR }],
      memoryFiles: { [APP_DIR]: [memFile("a.md")] },
    });
    await useHealthStore.getState().runCheck();
    expect(useHealthStore.getState().dismissedKeys).toEqual([]);

    // Sprawls again: shown again.
    mockBackend(sprawlingProject());
    await useHealthStore.getState().runCheck();
    expect(countForArea(useHealthStore.getState().flags, "memory")).toBe(1);
  });

  it("exposes reasons keyed by scope and target for inline highlighting", async () => {
    mockBackend({
      ...sprawlingProject(),
      processes: [proc({ runTimeSecs: HEALTH_THRESHOLDS.runTimeSecs + 60 })],
    });
    await useHealthStore.getState().runCheck();

    const { flags } = useHealthStore.getState();
    expect(
      flagsByRow(flags, "memory")
        .get(`${APP_DIR}|${APP_DIR}`)
        ?.map((f) => f.reason),
    ).toEqual([`${HEALTH_THRESHOLDS.maxFactFiles + 1} facts`]);
    expect(
      flagsByRow(flags, "processes")
        .get("100:node|vite")
        ?.map((f) => f.reason),
    ).toEqual(["running 24h"]);
  });

  it("surfaces Samurai size warnings in the secondbrain area, keyed for row highlighting", async () => {
    const auditPath = "C:\\data\\samurai\\audit\\app.jsonl";
    mockBackend({ samuraiFiles: [samuraiFile(auditPath, 6 * 1024 * 1024)] });
    await useHealthStore.getState().runCheck();

    const { flags, toasts } = useHealthStore.getState();
    expect(countForArea(flags, "secondbrain")).toBe(1);
    // First check ever: badge yes, toast no (first-run suppression).
    expect(toasts).toEqual([]);
    expect(
      flagsByRow(flags, "secondbrain")
        .get(`${auditPath}|app.jsonl`)
        ?.map((f) => f.reason),
    ).toEqual(["audit log 6.0 MB (warn at 5.0 MB)"]);
  });

  it("toasts a new Samurai size flag once and never again while it persists", async () => {
    const auditPath = "C:\\data\\samurai\\audit\\app.jsonl";
    mockBackend({ samuraiFiles: [samuraiFile(auditPath, 6 * 1024 * 1024)] });
    await useHealthStore.getState().runCheck();
    expect(useHealthStore.getState().toasts).toEqual([]);

    // A second file crosses the threshold: exactly one toast, for it alone.
    mockBackend({
      samuraiFiles: [
        samuraiFile(auditPath, 6 * 1024 * 1024),
        samuraiFile("C:\\data\\samurai\\audit\\other.jsonl", 7 * 1024 * 1024),
      ],
    });
    await useHealthStore.getState().runCheck();
    const { toasts } = useHealthStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].area).toBe("secondbrain");
    expect(toasts[0].target).toBe("other.jsonl");

    // Unchanged data on the next check: no repeat toast.
    await useHealthStore.getState().runCheck();
    expect(useHealthStore.getState().toasts).toHaveLength(1);
  });

  it("ignores a re-entrant check while one is in flight", async () => {
    mockBackend(sprawlingProject());
    const first = useHealthStore.getState().runCheck();
    await useHealthStore.getState().runCheck();
    await first;
    const projectListCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "list_memory_projects",
    );
    expect(projectListCalls).toHaveLength(1);
  });
});
