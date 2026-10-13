/**
 * Rule-based health checks for Samurai-managed files.
 *
 * Pure rules — no AI, no network, no side effects, and no backend of their
 * own: every input is data Maestro already fetches (`lib/samurai.ts`). The
 * checker never touches a Samurai-managed file; it only produces
 * {@link HealthFlag}s that the UI renders as an attention badge plus a
 * one-line reason.
 *
 * Design bias: **false positives are worse than misses.** Every rule here is
 * a threshold on something the OS states outright — a size — rather than an
 * inference about meaning. Hold anything new to the same bar.
 */

import { formatBytes } from "@/lib/format";
import type { SamuraiFileEntry, SamuraiFileKind } from "@/lib/samurai";

/** How often the background checker runs. Quiet by design — this is not a monitor. */
export const HEALTH_CHECK_INTERVAL_MS = 3 * 60 * 1000;

/* ================================================================ */
/*  FLAGS                                                            */
/* ================================================================ */

/** Which section a flag belongs to — drives which badge lights up. */
export type HealthArea = "secondbrain";

/** One thing worth a look. Never an action, only an observation. */
export interface HealthFlag {
  /**
   * Stable identity across checks. Transition detection ("is this flag NEW?")
   * compares these, so it must not embed changing numbers.
   */
  key: string;
  area: HealthArea;
  /**
   * Identifies the flagged row for the section that renders it: the
   * absolute file path for Second Brain flags. Distinct from {@link target}
   * because two files can share a base name.
   */
  scope: string;
  /** Short label for the flagged item, e.g. a file name. */
  target: string;
  /** One-line reason shown next to the item. */
  reason: string;
}

/* ================================================================ */
/*  SECOND BRAIN RULES                                               */
/* ================================================================ */

/** Lower-case kind labels for size-warning reasons, e.g. "audit log". */
const SAMURAI_KIND_LABELS: Record<SamuraiFileKind, string> = {
  BRIEF: "brief",
  HANDOFF: "handoff",
  RUN_CONFIG: "run config",
  PR_REVIEW_RUN: "PR review run",
  TIMER: "schedule",
  AUDIT_LOG: "audit log",
  JOURNAL: "journal",
  HARVEST_REPORT: "harvest report",
};

/** Last path segment — the short label a flag shows for a managed file. */
function samuraiBaseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Flags every Samurai-managed file AT OR ABOVE the user-configured warning
 * threshold (`SamuraiConfig.size_warn_bytes` — its Rust doc reads "at or
 * above this many bytes warns", and a threshold of 1 must warn on every
 * non-empty file, the documented test mode). The audit log is the file
 * this exists for (PRD §5.10 — the user deletes audit records manually, so
 * growth must be surfaced, never acted on), but a size is a size and every
 * managed file gets the same bar (PRD §5.11).
 *
 * The threshold is passed in rather than being a constant here because it
 * is Samurai config (PRD §7), settable in the settings modal — and setting
 * it low is the documented test mode.
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
    if (file.size_bytes < sizeWarnBytes) continue;
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
