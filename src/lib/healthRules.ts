/**
 * Rule-based health checks for project memory files, watched processes and
 * Samurai-managed files.
 *
 * Pure rules — no AI, no network, no side effects, and no backend of their
 * own: every input is data Maestro already fetches (`lib/memory.ts`,
 * `lib/processes.ts`, `lib/samurai.ts`). The checker never deletes a file or
 * kills a process; it only produces {@link HealthFlag}s that the UI renders
 * as an attention badge plus a one-line reason.
 *
 * Design bias: **false positives are worse than misses.** Every rule here is
 * a threshold on something the OS states outright — a count, a size, an mtime,
 * a CPU share — rather than an inference about meaning. One rule that tried to
 * infer was measured against real data and removed; see the note below it, and
 * hold anything new to the same bar.
 */

import type { MemoryFile } from "@/lib/memory";
import type { DevProcess } from "@/lib/processes";
import type { SamuraiFileEntry, SamuraiFileKind } from "@/lib/samurai";

/* ================================================================ */
/*  THRESHOLDS — the single place to tune the checker                */
/* ================================================================ */

/**
 * Every threshold the health rules use. Deliberately gathered in one object
 * so tuning never means grepping the codebase.
 */
export const HEALTH_THRESHOLDS = {
  /**
   * A project's memory is "sprawling" above this many fact files (the
   * MEMORY.md index does not count). Claude loads the index every session,
   * so a very long fact list is a sign it wants pruning.
   */
  maxFactFiles: 30,

  /**
   * MEMORY.md is loaded into context on every single session, so its size is
   * a direct, recurring token cost. 8 KB ~= 2k tokens of pure index.
   */
  maxIndexBytes: 8 * 1024,

  /**
   * A fact file untouched for this long is likely describing a state of the
   * repo that no longer holds. 6 months, in days.
   */
  staleFactDays: 183,

  /**
   * Sustained CPU share of the whole machine (`DevProcess.cpuPercent` is
   * already normalized 0-100 across all cores).
   *
   * Caveat worth knowing: `cpuPercent` is the average since the shared
   * `ProcessScanState` was last refreshed by *any* caller. With the Processes
   * panel closed that is this checker's own interval — a clean multi-minute
   * average. With the panel open it polls every 3 seconds, so each of our
   * samples measures only the ~3 seconds before it. The consecutive-sample
   * requirement is what makes the rule survive that: N short windows spread
   * across N intervals still means the load was there each time we looked.
   */
  cpuPercent: 80,

  /** Resident memory of a single watched process. 2 GB. */
  memoryBytes: 2 * 1024 * 1024 * 1024,

  /**
   * How many CONSECUTIVE health samples a process must exceed the CPU/RAM
   * threshold before it is flagged. Three samples at the checker's interval
   * is minutes of sustained load, not a build-step spike.
   */
  consecutiveSamples: 3,

  /**
   * A watched process running longer than this is probably a forgotten dev
   * server rather than something actively in use. 24 hours, in seconds.
   */
  runTimeSecs: 24 * 60 * 60,
} as const;

/** How often the background checker runs. Quiet by design — this is not a monitor. */
export const HEALTH_CHECK_INTERVAL_MS = 3 * 60 * 1000;

/* ================================================================ */
/*  FLAGS                                                            */
/* ================================================================ */

/** Which section a flag belongs to — drives which badge lights up. */
export type HealthArea = "memory" | "processes" | "secondbrain";

/** One thing worth a look. Never an action, only an observation. */
export interface HealthFlag {
  /**
   * Stable identity across checks. Transition detection ("is this flag NEW?")
   * compares these, so it must not embed changing numbers.
   */
  key: string;
  area: HealthArea;
  /**
   * Identifies the flagged row for the section that renders it: the memory
   * directory name for memory flags, `pid:name` for process flags, the
   * absolute file path for Second Brain flags. Distinct from {@link target}
   * because two projects can hold a `MEMORY.md` and two processes can share
   * a name.
   */
  scope: string;
  /** Short label for the flagged item, e.g. a memory file or process name. */
  target: string;
  /** One-line reason shown next to the item, e.g. "14 facts". */
  reason: string;
}

/* ================================================================ */
/*  MEMORY RULES                                                     */
/* ================================================================ */

/** Everything one project's memory check needs. */
export interface MemoryCheckInput {
  /** Encoded project dir under ~/.claude/projects (e.g. "C--git-maestro"). */
  dirName: string;
  files: MemoryFile[];
  /** Evaluation time, injected so tests are deterministic. */
  now: number;
}

/*
 * ── Dropped rule: "memory file references repo paths that no longer exist" ──
 *
 * Shipped, measured against the user's real 24-file memory corpus, and
 * REMOVED. Do not reinstate it in this form.
 *
 * v1 (backtick-quoted, must have a file extension) raised 7 flags: 0 true.
 * All were module shorthand — `commands/memory.rs`, `lib/processes.ts` — for
 * files that exist, just deeper in the tree. That is simply how people write
 * about a codebase, and it is indistinguishable from a repo-root-relative
 * path without knowing what is at the root.
 *
 * v2 added a repo-root top-level gate plus build/dependency/dotfolder
 * exclusions. That killed all 7, and left 1 flag: still 0 true. The survivor
 * was a note whose own first line reads "built on branch `featGraph`" —
 * the file exists on that branch, not on the checked-out one.
 *
 * That last class is structural, and it is not alone. A memory file records
 * work done on a branch; the working tree is one branch. Memory also exists
 * partly to record deletions ("we removed X"), which would flag forever and
 * could only be silenced by editing the memory. Add gitignored files and
 * build artifacts and the rule has four independent ways to be wrong and, on
 * real data, none to be right. The user's standing instruction is that false
 * positives are worse than misses.
 *
 * The only version that could work would ask git, not the filesystem: flag a
 * path that exists in neither the working tree NOR anywhere in history on any
 * branch, which is the "typo or invented path" case rather than the "stale
 * note" case. That is a different rule with a different meaning and a real
 * implementation cost, and it should only be built if someone can show it
 * finds something.
 *
 * Removing this also removed the checker's entire Rust surface and every
 * `read_memory_file` call it made per tick.
 */

/** Whole-days elapsed since an RFC 3339 timestamp; null when unparseable. */
function daysSince(modified: string | null, now: number): number | null {
  if (!modified) return null;
  const then = Date.parse(modified);
  if (Number.isNaN(then)) return null;
  return Math.floor((now - then) / (24 * 60 * 60 * 1000));
}

/**
 * Evaluates the memory rules for one project:
 *
 * 1. more than {@link HEALTH_THRESHOLDS.maxFactFiles} fact files;
 * 2. MEMORY.md larger than {@link HEALTH_THRESHOLDS.maxIndexBytes};
 * 3. a fact file untouched for {@link HEALTH_THRESHOLDS.staleFactDays}.
 *
 * All three are thresholds on facts the filesystem states directly — a count,
 * a size, an mtime — which is why they survive contact with real data. A
 * fourth rule that tried to *infer* staleness from the file's prose was
 * dropped; see the note above.
 *
 * Rule 3 flags the individual file, 1 flags the project, 2 flags the index.
 */
export function evaluateMemory({ dirName, files, now }: MemoryCheckInput): HealthFlag[] {
  const flags: HealthFlag[] = [];
  const facts = files.filter((f) => !f.isIndex);

  if (facts.length > HEALTH_THRESHOLDS.maxFactFiles) {
    flags.push({
      key: `memory:${dirName}:count`,
      area: "memory",
      scope: dirName,
      target: dirName,
      reason: `${facts.length} facts`,
    });
  }

  const index = files.find((f) => f.isIndex);
  if (index && index.sizeBytes > HEALTH_THRESHOLDS.maxIndexBytes) {
    flags.push({
      key: `memory:${dirName}:index-size`,
      area: "memory",
      scope: dirName,
      target: index.relPath,
      reason: `index ${Math.round(index.sizeBytes / 1024)} KB`,
    });
  }

  for (const file of facts) {
    const age = daysSince(file.modified, now);
    if (age !== null && age >= HEALTH_THRESHOLDS.staleFactDays) {
      flags.push({
        key: `memory:${dirName}:${file.relPath}:age`,
        area: "memory",
        scope: dirName,
        target: file.relPath,
        reason: `not touched in ${Math.floor(age / 30)} months`,
      });
    }
  }

  return flags;
}

/* ================================================================ */
/*  PROCESS RULES                                                    */
/* ================================================================ */

/**
 * How many consecutive samples a process has been over each threshold.
 * Carried between checks by the store; a process that drops below resets to 0,
 * which is what makes "sustained" mean sustained.
 */
export type ProcessStreaks = Record<string, { cpu: number; mem: number }>;

/**
 * Identity of a process across samples. PID alone is reusable by the OS, so
 * the executable name is folded in — a recycled PID landing on a different
 * program then starts its streak from zero.
 */
export function processKey(p: Pick<DevProcess, "pid" | "name">): string {
  return `${p.pid}:${p.name}`;
}

function formatGb(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Evaluates the process rules against one sample, folding in the streak
 * counters from previous samples.
 *
 * - CPU / RAM: flagged only after {@link HEALTH_THRESHOLDS.consecutiveSamples}
 *   consecutive samples over the threshold, so a build spike stays quiet.
 * - Runtime: flagged immediately — a 24-hour-old process is sustained by
 *   definition, no streak needed.
 *
 * Returns the flags plus the streak map to carry into the next sample; entries
 * for processes that have exited are dropped.
 */
export function evaluateProcesses(
  processes: DevProcess[],
  prev: ProcessStreaks,
): { flags: HealthFlag[]; streaks: ProcessStreaks } {
  const flags: HealthFlag[] = [];
  const streaks: ProcessStreaks = {};

  for (const p of processes) {
    const key = processKey(p);
    const before = prev[key] ?? { cpu: 0, mem: 0 };
    const cpu = p.cpuPercent > HEALTH_THRESHOLDS.cpuPercent ? before.cpu + 1 : 0;
    const mem = p.memoryBytes > HEALTH_THRESHOLDS.memoryBytes ? before.mem + 1 : 0;
    streaks[key] = { cpu, mem };

    // Elapsed time the streak actually covers: N samples span N-1 intervals
    // (three samples at t=0/3/6 min is 6 minutes of evidence, not 9). Derived
    // from the sample count so the copy stays honest if the interval changes.
    //
    // This is the span between the first and last over-threshold sample. What
    // each individual sample measures is a separate question — see the
    // `cpuPercent` threshold docs.
    const sustainedMin = Math.round(((cpu - 1) * HEALTH_CHECK_INTERVAL_MS) / 60_000);

    if (cpu >= HEALTH_THRESHOLDS.consecutiveSamples) {
      flags.push({
        key: `process:${key}:cpu`,
        area: "processes",
        scope: key,
        target: p.matched,
        reason: `CPU >${HEALTH_THRESHOLDS.cpuPercent}% for ${sustainedMin}+ min`,
      });
    }
    if (mem >= HEALTH_THRESHOLDS.consecutiveSamples) {
      flags.push({
        key: `process:${key}:mem`,
        area: "processes",
        scope: key,
        target: p.matched,
        reason: `RAM ${formatGb(p.memoryBytes)}`,
      });
    }
    if (p.runTimeSecs > HEALTH_THRESHOLDS.runTimeSecs) {
      flags.push({
        key: `process:${key}:runtime`,
        area: "processes",
        scope: key,
        target: p.matched,
        reason: `running ${Math.floor(p.runTimeSecs / 3600)}h`,
      });
    }
  }

  return { flags, streaks };
}

/* ================================================================ */
/*  SECOND BRAIN RULES                                               */
/* ================================================================ */

/** Lower-case kind labels for size-warning reasons, e.g. "audit log". */
const SAMURAI_KIND_LABELS: Record<SamuraiFileKind, string> = {
  HANDOFF: "handoff",
  RUN_CONFIG: "run config",
  TIMER: "schedule",
  AUDIT_LOG: "audit log",
  JOURNAL: "journal",
  HARVEST_REPORT: "harvest report",
};

/** "6.2 MB" / "12 KB" / "800 B" — sized to read well at any test threshold. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Last path segment — the short label a flag shows for a managed file. */
function samuraiBaseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Flags every Samurai-managed file larger than the user-configured warning
 * threshold (`SamuraiConfig.size_warn_bytes`). The audit log is the file
 * this exists for (PRD §5.10 — the user deletes audit records manually, so
 * growth must be surfaced, never acted on), but a size is a size and every
 * managed file gets the same bar (PRD §5.11).
 *
 * The threshold is passed in rather than living in {@link HEALTH_THRESHOLDS}
 * because it is Samurai config (PRD §7), settable in the settings modal —
 * and setting it low is the documented test mode.
 *
 * `TIMER` rows all share `schedule.json` as their `path` (one row per
 * pending timer), so entries are deduped by path first: one file, one flag,
 * and the flag key stays unique.
 */
export function evaluateSamuraiFiles(
  files: SamuraiFileEntry[],
  sizeWarnBytes: number,
): HealthFlag[] {
  const flags: HealthFlag[] = [];
  const seenPaths = new Set<string>();

  for (const file of files) {
    if (seenPaths.has(file.path)) continue;
    seenPaths.add(file.path);
    if (file.size_bytes <= sizeWarnBytes) continue;
    flags.push({
      key: `samurai:${file.path}:size`,
      area: "secondbrain",
      scope: file.path,
      target: samuraiBaseName(file.path),
      reason: `${SAMURAI_KIND_LABELS[file.kind]} ${formatBytes(file.size_bytes)} (warn at ${formatBytes(sizeWarnBytes)})`,
    });
  }

  return flags;
}

/* ================================================================ */
/*  TRANSITIONS                                                      */
/* ================================================================ */

/**
 * Flags present in `next` that were absent from `prev`.
 *
 * `prev === null` means no check has completed yet (app start): everything
 * would look new, so nothing is reported — the same first-run suppression the
 * GitHub watchdog uses. Flags that clear never notify.
 */
export function diffNewFlags(prev: readonly string[] | null, next: HealthFlag[]): HealthFlag[] {
  if (prev === null) return [];
  const seen = new Set(prev);
  return next.filter((f) => !seen.has(f.key));
}
