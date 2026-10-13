import { describe, expect, it } from "vitest";
import { diffNewFlags, evaluateSamuraiFiles } from "../healthRules";
import type { SamuraiFileEntry } from "../samurai";

const NOW = Date.parse("2026-08-04T12:00:00Z");

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
      has_live_session: false,
      fire_at: null,
      ...overrides,
    };
  }

  it("stays silent when every file is strictly under the threshold", () => {
    const files = [
      samuraiFile("C:\\data\\audit\\a.jsonl", { size_bytes: WARN - 1 }),
      samuraiFile("C:\\data\\handoffs\\h.md", { kind: "HANDOFF", size_bytes: 12 }),
    ];
    expect(evaluateSamuraiFiles(files, WARN)).toEqual([]);
  });

  it("flags files at or above the threshold, with kind and sizes in the reason", () => {
    const files = [
      samuraiFile("C:\\data\\audit\\big.jsonl", { size_bytes: 6.5 * 1024 * 1024 }),
      // Exactly at the threshold flags — "at or above", matching the Rust
      // config doc for size_warn_bytes (review F3).
      samuraiFile("C:\\data\\audit\\exact.jsonl", { size_bytes: WARN }),
      samuraiFile("C:\\data\\audit\\small.jsonl", { size_bytes: 100 }),
    ];
    const flags = evaluateSamuraiFiles(files, WARN);
    expect(flags).toHaveLength(2);
    expect(flags[0].area).toBe("secondbrain");
    expect(flags[0].scope).toBe("C:\\data\\audit\\big.jsonl");
    expect(flags[0].target).toBe("big.jsonl");
    expect(flags[0].reason).toBe("audit log 6.5 MB (warn at 5.0 MB)");
    expect(flags[1].target).toBe("exact.jsonl");
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
    // Threshold 1 is the legitimate floor (size_warn_bytes validate
    // rationale): it warns on every non-empty file, never on empty ones.
    const one = samuraiFile("C:\\data\\audit\\one.jsonl", { size_bytes: 1 });
    expect(evaluateSamuraiFiles([one], 1)).toHaveLength(1);
    const empty = samuraiFile("C:\\data\\audit\\empty.jsonl", { size_bytes: 0 });
    expect(evaluateSamuraiFiles([empty], 1)).toEqual([]);
  });
});

describe("diffNewFlags", () => {
  const flag = (key: string) => ({
    key,
    area: "secondbrain" as const,
    scope: "C:/data/a.jsonl",
    target: "a.jsonl",
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
