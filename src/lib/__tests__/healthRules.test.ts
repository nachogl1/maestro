import { describe, expect, it } from "vitest";
import {
  diffNewFlags,
  evaluateMemory,
  evaluateProcesses,
  evaluateSamuraiFiles,
  HEALTH_THRESHOLDS,
  processKey,
  type ProcessStreaks,
} from "../healthRules";
import type { MemoryFile } from "../memory";
import type { DevProcess } from "../processes";
import type { SamuraiFileEntry } from "../samurai";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-04T12:00:00Z");

function file(relPath: string, overrides: Partial<MemoryFile> = {}): MemoryFile {
  return {
    relPath,
    path: `/home/a/.claude/projects/P/memory/${relPath}`,
    description: null,
    memType: null,
    isIndex: relPath === "MEMORY.md",
    sizeBytes: 500,
    modified: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function proc(overrides: Partial<DevProcess> = {}): DevProcess {
  return {
    pid: 100,
    parentPid: 1,
    name: "node",
    cmd: "node vite",
    cwd: "C:\\git\\app",
    memoryBytes: 128 * 1024 * 1024,
    cpuPercent: 2,
    runTimeSecs: 60,
    isMaestro: false,
    matched: "vite",
    ports: [],
    ...overrides,
  };
}

describe("evaluateMemory", () => {
  it("stays silent on a healthy project", () => {
    const files = [file("MEMORY.md"), file("a.md"), file("b.md")];
    expect(evaluateMemory({ dirName: "P", files, now: NOW })).toEqual([]);
  });

  it("flags a project with too many fact files (index excluded)", () => {
    const files = [
      file("MEMORY.md"),
      ...Array.from({ length: HEALTH_THRESHOLDS.maxFactFiles + 1 }, (_, i) => file(`f${i}.md`)),
    ];
    const flags = evaluateMemory({ dirName: "P", files, now: NOW });
    expect(flags).toHaveLength(1);
    expect(flags[0].reason).toBe(`${HEALTH_THRESHOLDS.maxFactFiles + 1} facts`);
    expect(flags[0].scope).toBe("P");
  });

  it("does not flag a project sitting exactly on the fact-count threshold", () => {
    const files = Array.from({ length: HEALTH_THRESHOLDS.maxFactFiles }, (_, i) => file(`f${i}.md`));
    expect(evaluateMemory({ dirName: "P", files, now: NOW })).toEqual([]);
  });

  it("flags an oversized MEMORY.md against the index row", () => {
    const files = [file("MEMORY.md", { sizeBytes: HEALTH_THRESHOLDS.maxIndexBytes + 1 })];
    const flags = evaluateMemory({ dirName: "P", files, now: NOW });
    expect(flags).toHaveLength(1);
    expect(flags[0].target).toBe("MEMORY.md");
    expect(flags[0].reason).toMatch(/^index \d+ KB$/);
  });

  it("flags fact files older than the stale threshold, never the index", () => {
    const old = new Date(NOW - (HEALTH_THRESHOLDS.staleFactDays + 1) * DAY_MS).toISOString();
    const files = [
      file("MEMORY.md", { modified: old, sizeBytes: 10 }),
      file("ancient.md", { modified: old }),
      file("fresh.md"),
    ];
    const flags = evaluateMemory({ dirName: "P", files, now: NOW });
    expect(flags).toHaveLength(1);
    expect(flags[0].target).toBe("ancient.md");
    expect(flags[0].reason).toMatch(/not touched in \d+ months/);
  });

  it("ignores files with an unparseable or absent modified time", () => {
    const files = [file("a.md", { modified: null }), file("b.md", { modified: "not-a-date" })];
    expect(evaluateMemory({ dirName: "P", files, now: NOW })).toEqual([]);
  });

});

describe("evaluateProcesses", () => {
  const hot = proc({ cpuPercent: HEALTH_THRESHOLDS.cpuPercent + 5 });

  it("needs consecutive samples before flagging CPU", () => {
    let streaks: ProcessStreaks = {};
    for (let i = 1; i < HEALTH_THRESHOLDS.consecutiveSamples; i++) {
      const result = evaluateProcesses([hot], streaks);
      expect(result.flags).toEqual([]);
      streaks = result.streaks;
    }
    const final = evaluateProcesses([hot], streaks);
    expect(final.flags).toHaveLength(1);
    // Three samples span two intervals, not three: 6 minutes of evidence.
    expect(final.flags[0].reason).toBe("CPU >80% for 6+ min");
  });

  it("resets the streak when a process drops below the threshold", () => {
    let streaks: ProcessStreaks = {};
    for (let i = 0; i < HEALTH_THRESHOLDS.consecutiveSamples - 1; i++) {
      streaks = evaluateProcesses([hot], streaks).streaks;
    }
    streaks = evaluateProcesses([proc({ cpuPercent: 1 })], streaks).streaks;
    expect(streaks[processKey(hot)].cpu).toBe(0);
    expect(evaluateProcesses([hot], streaks).flags).toEqual([]);
  });

  it("applies the same consecutive rule to RAM", () => {
    const fat = proc({ memoryBytes: HEALTH_THRESHOLDS.memoryBytes + 1 });
    let streaks: ProcessStreaks = {};
    for (let i = 0; i < HEALTH_THRESHOLDS.consecutiveSamples - 1; i++) {
      const result = evaluateProcesses([fat], streaks);
      expect(result.flags).toEqual([]);
      streaks = result.streaks;
    }
    const flags = evaluateProcesses([fat], streaks).flags;
    expect(flags.map((f) => f.reason)).toEqual(["RAM 2.0 GB"]);
  });

  it("flags long runtime on the very first sample", () => {
    const old = proc({ runTimeSecs: HEALTH_THRESHOLDS.runTimeSecs + 3600 });
    const flags = evaluateProcesses([old], {}).flags;
    expect(flags).toHaveLength(1);
    expect(flags[0].reason).toBe("running 25h");
  });

  it("starts a recycled PID from a clean streak", () => {
    const streaks = { [processKey(hot)]: { cpu: 99, mem: 99 } };
    const other = proc({ pid: hot.pid, name: "python", cpuPercent: hot.cpuPercent });
    const result = evaluateProcesses([other], streaks);
    expect(result.flags).toEqual([]);
    expect(result.streaks[processKey(other)].cpu).toBe(1);
  });

  it("drops streaks for processes that have exited", () => {
    const { streaks } = evaluateProcesses([hot], { "999:ghost": { cpu: 5, mem: 5 } });
    expect(streaks["999:ghost"]).toBeUndefined();
  });
});

describe("evaluateSamuraiFiles", () => {
  const WARN = 5 * 1024 * 1024;

  function samuraiFile(path: string, overrides: Partial<SamuraiFileEntry> = {}): SamuraiFileEntry {
    return {
      kind: "AUDIT_LOG",
      path,
      size_bytes: 1024,
      modified_at: new Date(NOW).toISOString(),
      project_path: "C:\\git\\app",
      epic: null,
      in_use: false,
      fire_at: null,
      ...overrides,
    };
  }

  it("stays silent when every file is at or under the threshold", () => {
    const files = [
      samuraiFile("C:\\data\\audit\\a.jsonl", { size_bytes: WARN }),
      samuraiFile("C:\\data\\handoffs\\h.md", { kind: "HANDOFF", size_bytes: 12 }),
    ];
    expect(evaluateSamuraiFiles(files, WARN)).toEqual([]);
  });

  it("flags only files strictly over the threshold, with kind and sizes in the reason", () => {
    const files = [
      samuraiFile("C:\\data\\audit\\big.jsonl", { size_bytes: 6.5 * 1024 * 1024 }),
      samuraiFile("C:\\data\\audit\\small.jsonl", { size_bytes: 100 }),
    ];
    const flags = evaluateSamuraiFiles(files, WARN);
    expect(flags).toHaveLength(1);
    expect(flags[0].area).toBe("secondbrain");
    expect(flags[0].scope).toBe("C:\\data\\audit\\big.jsonl");
    expect(flags[0].target).toBe("big.jsonl");
    expect(flags[0].reason).toBe("audit log 6.5 MB (warn at 5.0 MB)");
  });

  it("keys flags by path only — the key survives the file growing", () => {
    const path = "C:\\data\\audit\\log.jsonl";
    const before = evaluateSamuraiFiles([samuraiFile(path, { size_bytes: WARN + 1 })], WARN);
    const after = evaluateSamuraiFiles([samuraiFile(path, { size_bytes: WARN * 3 })], WARN);
    expect(before[0].key).toBe(`samurai:${path}:size`);
    expect(after[0].key).toBe(before[0].key);
  });

  it("dedupes TIMER rows sharing schedule.json into one flag", () => {
    const timer = (epic: string) =>
      samuraiFile("C:\\data\\schedule.json", {
        kind: "TIMER" as const,
        size_bytes: WARN + 1,
        epic,
        fire_at: new Date(NOW).toISOString(),
      });
    const flags = evaluateSamuraiFiles([timer("epic-a"), timer("epic-b")], WARN);
    expect(flags).toHaveLength(1);
    expect(flags[0].key).toBe("samurai:C:\\data\\schedule.json:size");
  });

  it("fires at test-low thresholds (PRD §7 test mode)", () => {
    const flags = evaluateSamuraiFiles(
      [samuraiFile("C:\\data\\audit\\log.jsonl", { size_bytes: 2048 })],
      1024,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].reason).toBe("audit log 2 KB (warn at 1 KB)");
  });
});

describe("diffNewFlags", () => {
  const flag = (key: string) => ({
    key,
    area: "memory" as const,
    scope: "P",
    target: "a.md",
    reason: "r",
  });

  it("reports nothing on the first run", () => {
    expect(diffNewFlags(null, [flag("a"), flag("b")])).toEqual([]);
  });

  it("reports only keys absent from the baseline", () => {
    expect(diffNewFlags(["a"], [flag("a"), flag("b")]).map((f) => f.key)).toEqual(["b"]);
  });

  it("never reports flags that cleared", () => {
    expect(diffNewFlags(["a", "b"], [flag("a")])).toEqual([]);
  });
});
