import { invoke } from "@tauri-apps/api/core";

/**
 * Thin wrappers over the Samurai tauri commands
 * (`src-tauri/src/commands/samurai.rs`) that the Second Brain panel, the
 * health checker, the journal and harvest still use. Starting and supervising
 * Samurai runs from the app is gone (issue #612); what is left here goes with
 * the Second Brain panel.
 */

/**
 * Audit row kinds (PRD §5.10). Sub-kinds live in `details.kind`.
 * `INJECT` (issue #101) records every instruction Maestro typed into an
 * orchestrator terminal — `details.phase` is `"delivered"` or `"acked"`.
 * `KILL` records an agent's DEATH — `details.cause` says which path ended
 * it (`handoff` / `process_died` / `user_kill` / `run_complete`). Without
 * it a long-dead agent's newest row stayed `SPAWN` forever.
 */
export type SamuraiAuditEventKind =
  | "SPAWN"
  | "HANDOFF"
  | "PARK"
  | "RESUME"
  | "COMPLETE"
  | "ALERT"
  | "INJECT"
  | "KILL";

/** One audit JSONL row — mirrors the Rust `AuditEvent`. */
export interface SamuraiAuditEvent {
  /** RFC 3339 UTC timestamp. */
  ts: string;
  /** Epic reference; empty when unknown (e.g. account-wide ALERTs). */
  epic: string;
  event: SamuraiAuditEventKind;
  /** Orchestrator generation number (gen-N); 0 for account-wide rows. */
  generation: number;
  session_id: number;
  /** Free-form detail object for sub-kinds and context. */
  details: unknown;
}

/** Payload of the live `samurai-audit-event` channel. */
export interface SamuraiAuditEventPayload {
  project: string;
  event: SamuraiAuditEvent;
}

/** Mirrors the Rust `AuditReadResult`. */
export interface SamuraiAuditReadResult {
  events: SamuraiAuditEvent[];
  file_size_bytes: number;
}

/**
 * Reads a project's audit rows (optionally only the last `tail`, optionally
 * only rows strictly after `sinceTs`) plus the current file size in bytes.
 */
export function samuraiAuditRead(
  projectPath: string,
  tail?: number,
  sinceTs?: string,
): Promise<SamuraiAuditReadResult> {
  return invoke("samurai_audit_read", { projectPath, tail, sinceTs });
}

/** Deletes a project's audit log. User-initiated only (PRD decision #15). */
export function samuraiAuditClear(projectPath: string): Promise<void> {
  return invoke("samurai_audit_clear", { projectPath });
}

/** Mirrors the Rust `SamuraiRecoverResult` (issue #124). */
export interface SamuraiRecoverResult {
  epic: string;
  /** The generation now spawning. */
  generation: number;
  /** The true resume point: the highest generation the registry or the
   *  handoff files know. */
  prior_generation: number;
  /** Resume from the prior handoff, vs full reconstruction (git + gh). */
  from_handoff: boolean;
  /** The worktree's current branch, verified via git. */
  branch: string;
  /** The worktree's current short HEAD sha, verified via git. */
  head: string;
  /** A pending resume timer was superseded by this manual recovery. */
  timer_cancelled: boolean;
}

/**
 * Ends a park EARLY (issue #211) — the one manual resume behind every park
 * kind: allowance, gh-auth and circuit breaker alike. Cancels the run's
 * pending resume timer and spawns the successor now.
 *
 * The backend still verifies an ACTIVE run, no live agent, the worktree
 * branch + HEAD via git, and clears a breaker park's stamp and counter. An
 * engaged hard park sweep does not refuse it, because an exhausted allowance
 * is exactly what the caller is overriding on purpose. Prefer
 * {@link resumeRunNow} in `lib/samuraiResume` — it adds the allowance warning.
 */
export function samuraiResumeNow(projectPath: string, epic: string): Promise<SamuraiRecoverResult> {
  return invoke("samurai_resume_now", { projectPath, epic });
}

/** What one cleanup pass removed (all-false = already clean, PRD §5.9). */
export interface SamuraiCleanupReport {
  epic: string;
  branch: string;
  /** A staged-but-unregistered gen-N spawn was cancelled before the delete. */
  spawn_cancelled: boolean;
  timer_cancelled: boolean;
  config_archived: boolean;
  worktree_removed: boolean;
  worktree_path: string | null;
  branch_deleted: boolean;
}

/**
 * One-click epic cleanup (destructive — confirm before calling): cancels the
 * resume timer, archives the run config, removes the epic worktree, deletes
 * the `<project>-<slug>` branch (or its pre-rename `samurai-<slug>` form, as
 * a fallback). Idempotent; refuses while a live supervised session exists.
 */
export function samuraiCleanupEpic(
  projectPath: string,
  epic: string,
): Promise<SamuraiCleanupReport> {
  return invoke("samurai_cleanup_epic", { projectPath, epic });
}

// ---------------------------------------------------------------------------
// Issue #65: Second Brain file inventory + guarded delete
// ---------------------------------------------------------------------------

/**
 * What a listed file is (PRD §8 rows 1–5, plus the two kinds issue #139
 * adds) — mirrors `SamuraiFileKind`. A kind is a per-row TAG, never a
 * section header: rows are grouped by their {@link SamuraiFileGroup}.
 */
export type SamuraiFileKind =
  | "BRIEF"
  | "HANDOFF"
  | "RUN_CONFIG"
  | "PR_REVIEW_RUN"
  | "TIMER"
  | "AUDIT_LOG"
  | "JOURNAL"
  | "HARVEST_REPORT";

/** What a group represents (issue #139) — mirrors `SamuraiGroupKind`. */
export type SamuraiGroupKind = "RUN" | "PR_REVIEW";

/**
 * One unit of WORK every artifact belongs to — a samurai run or a PR review
 * (issue #139; mirrors the Rust `SamuraiFileGroup`).
 *
 * There is deliberately no generic/system group: if an artifact would land
 * in one, that is a backend writer bug, never a UI fallback.
 */
export interface SamuraiFileGroup {
  /** `run:<project-hash>:<epic-slug>` or `pr:<owner/repo>#<number>`. */
  id: string;
  kind: SamuraiGroupKind;
  /**
   * `Epic #38 — Samurai supervision`, `Run #77, #78 — (2 issues)`,
   * `PR #142 — fix journal splitting`; refs alone when no title was captured.
   */
  label: string;
  /** The refs behind the group: `["#38"]`, `["#77", "#78"]`. */
  refs: string[];
  project_path: string | null;
  /** RFC 3339 creation time; null for a run known only from a timer/session. */
  created_at: string | null;
  /** A live supervised session (run) or an open review terminal (PR review). */
  is_live: boolean;
  /**
   * The value an audit row's `epic` must resolve to for the row to belong to
   * this group — the epic SLUG for a run (`38`, never `#38`), the `pr:` id for
   * a PR review. `audit_rows` is counted on exactly this spelling, so the
   * audit view must filter on it rather than on a raw epic string: the two
   * spellings of one run made a card claim N rows and then show none.
   */
  audit_key: string;
  /** This group's slice of the shared project audit JSONL. */
  audit_rows: number;
  /** This group's slice of the shared ops journal. */
  journal_entries: number;
}

/**
 * One inventory row — mirrors the Rust `SamuraiFileEntry`
 * (`core/samurai_files.rs`). `TIMER` rows share `schedule.json` as their
 * `path` (one row per pending timer) and carry `fire_at` so the UI can
 * render "resumes at 14:32"; `AUDIT_LOG` and `JOURNAL` rows likewise share
 * one file and represent their group's slice of it.
 */
export interface SamuraiFileEntry {
  /** The {@link SamuraiFileGroup.id} this artifact belongs to — never empty. */
  group_id: string;
  kind: SamuraiFileKind;
  /** Absolute path, Windows `\\?\` prefix already stripped. */
  path: string;
  size_bytes: number;
  /** RFC 3339 UTC modified time; null when the filesystem reports none. */
  modified_at: string | null;
  /** Owning project, when the association is known. */
  project_path: string | null;
  /** Owning epic, when the association is known. */
  epic: string | null;
  /**
   * Referenced by an ACTIVE run config, a live supervised session, or a
   * pending timer — deleting requires `force` (harder confirm, PRD §5.11).
   */
  in_use: boolean;
  /**
   * A live (non-terminal) supervised session exists for this entry's
   * project + epic — the session slice of `in_use` on its own; false for
   * kinds without an epic association. Gates "clean this epic": the backend
   * refuses cleanup only while a live session exists.
   */
  has_live_session: boolean;
  /** TIMER rows only: RFC 3339 fire time. */
  fire_at: string | null;
}

/**
 * Fixed prefix of the "file is in use, pass force" delete refusal — must
 * match `IN_USE_ERROR_PREFIX` in `src-tauri/src/core/samurai_files.rs`.
 */
export const SAMURAI_IN_USE_ERROR_PREFIX = "IN_USE:";

/** True when a `samuraiFileDelete` rejection means "in use — force needed". */
export function isSamuraiInUseError(error: unknown): boolean {
  return typeof error === "string" && error.startsWith(SAMURAI_IN_USE_ERROR_PREFIX);
}

/** The grouped inventory `samurai_files_list` returns (issue #139). */
export interface SamuraiFilesListing {
  /** One per samurai run or PR review, live first then newest first. */
  groups: SamuraiFileGroup[];
  /** Every artifact, each carrying the `group_id` it belongs to. */
  entries: SamuraiFileEntry[];
}

/**
 * Every Samurai-managed artifact (PRD §8), grouped by the run or PR review it
 * came from (issue #139): briefs, handoffs, run configs (active + archived),
 * PR-review records, pending timers, and each group's slice of the shared
 * audit log and ops journal.
 */
export function samuraiFilesList(): Promise<SamuraiFilesListing> {
  return invoke("samurai_files_list");
}

/**
 * Deletes one Samurai-managed file (destructive — confirm before calling).
 * Rejects paths outside the backend-computed managed roots; an in-use file
 * rejects with a `SAMURAI_IN_USE_ERROR_PREFIX`-prefixed message unless
 * `force` is true (use `isSamuraiInUseError` to route to a harder confirm).
 * `schedule.json` always rejects, force or not — cancel its timers instead
 * (`samuraiTimerCancel`, or the epic cleanup).
 */
export function samuraiFileDelete(path: string, force: boolean): Promise<void> {
  return invoke("samurai_file_delete", { path, force });
}

/**
 * Cancels one epic's pending resume timer (confirm before calling — the
 * parked run will NOT resume on its own afterwards; relaunching is the only
 * way back). Resolves `false` when no timer was pending — cancelling twice
 * is not an error.
 */
export function samuraiTimerCancel(projectPath: string, epic: string): Promise<boolean> {
  return invoke("samurai_timer_cancel", { projectPath, epic });
}

// ---------------------------------------------------------------------------
// Issue #67: config read for the health checker's size-warning rule
// ---------------------------------------------------------------------------

/** Samurai thresholds (PRD §7). Keys are the backend's snake_case wire
 *  names — must match `SamuraiConfig` in `src-tauri/src/core/samurai_config.rs`. */
export interface SamuraiConfig {
  handoff_context_pct: number;
  park_soft_5h_pct: number;
  park_hard_5h_pct: number;
  park_hard_7d_pct: number;
  ack_timeout_secs: number;
  /** The stuck-turn cap: how long an instruction may wait for an idle signal
   *  before the injector raises its one-shot ack_timeout ALERT. */
  max_turn_wait_secs: number;
  staleness_window_secs: number;
  handoff_retention_days: number;
  breaker_events: number;
  size_warn_bytes: number;
}

/** The saved Samurai config. The health checker reads `size_warn_bytes`. */
export function samuraiGetConfig(): Promise<SamuraiConfig> {
  return invoke("samurai_get_config");
}

// ---------------------------------------------------------------------------
// Issue #69: ops journal — add + list
// ---------------------------------------------------------------------------

/** Journal entry categories (PRD §5.12) — mirrors the Rust `JournalCategory`. */
export type SamuraiJournalCategory = "BOTTLENECK" | "ERROR" | "IMPROVEMENT" | "SKILL" | "CONCERN";

/**
 * One ops-journal JSONL line — mirrors the Rust `JournalEntry`
 * (`core/samurai_journal.rs`). `project` and `agent` are ABSENT (not null)
 * when unset — agents hand-write these lines from shell prompts, the
 * minimal shape is the contract.
 */
export interface SamuraiJournalEntry {
  /** RFC 3339 UTC timestamp. */
  ts: string;
  category: SamuraiJournalCategory;
  text: string;
  /** Owning project path (Windows `\\?\` prefix already stripped). */
  project?: string;
  /** The agent that recorded the entry; absent for user entries. */
  agent?: string;
}

/**
 * Consumption status derived from the harvest markers — mirrors the Rust
 * `JournalEntryStatus`: after the last marker = UNCONSUMED, between the
 * last two = PENDING while that harvest's triage is still unevidenced
 * (issue #159 — the next harvest either promotes the batch to CONSUMED or
 * re-delivers it) and CONSUMED once it is; ARCHIVED shows only for
 * stragglers a crashed harvest left in the active file (the next harvest
 * moves them to `archive.jsonl`).
 */
export type SamuraiJournalEntryStatus = "UNCONSUMED" | "PENDING" | "CONSUMED" | "ARCHIVED";

/**
 * Mirrors the Rust `JournalEntryWithStatus`. `raw` is the entry's exact
 * on-disk JSONL text (no trailing newline) — entries carry no id, so this
 * is the identity `samuraiJournalDelete` matches on; round-trip it
 * unmodified (issue #100).
 */
export interface SamuraiJournalListEntry {
  entry: SamuraiJournalEntry;
  status: SamuraiJournalEntryStatus;
  raw: string;
}

/**
 * Mirrors the Rust `JournalListResult`: the active file's entries (newest
 * last) with derived status, plus the file size in bytes.
 */
export interface SamuraiJournalListResult {
  entries: SamuraiJournalListEntry[];
  file_size_bytes: number;
  /** Lines the parser could not understand — recorded, never listed. */
  opaque_line_count: number;
}

/**
 * Adds one user-authored journal entry (the UI path — agents append to the
 * JSONL directly, so there is no agent parameter). Rejects empty text.
 */
export function samuraiJournalAdd(
  category: SamuraiJournalCategory,
  text: string,
  project?: string,
): Promise<void> {
  return invoke("samurai_journal_add", { category, text, project });
}

/** The active journal with per-entry consumption status, newest last. */
export function samuraiJournalList(): Promise<SamuraiJournalListResult> {
  return invoke("samurai_journal_list");
}

/**
 * Deletes one journal entry (destructive — confirm before calling), passing
 * back the exact `raw` text `samuraiJournalList` returned for that row (see
 * `SamuraiJournalListEntry.raw`). Byte-identical duplicate lines are deleted
 * together — entries carry no id to distinguish them (issue #100). Resolves
 * the number of lines removed; rejects when the identity no longer matches
 * anything (e.g. a stale list from before a harvest changed the file).
 */
export function samuraiJournalDelete(raw: string): Promise<number> {
  return invoke("samurai_journal_delete", { raw });
}

// ---------------------------------------------------------------------------
// Issue #98: harvest — interactive triage session
// ---------------------------------------------------------------------------

/**
 * Arms the interactive harvest triage for a just-launched session (Rust
 * `samurai_harvest_arm`, issue #98). TerminalGrid calls this right before it
 * types the CLI command — like the samurai successor registration — so the
 * backend can inject the journal-triage prompt on the session's first
 * SessionStarted hook signal. Journal entries flip to PENDING at that
 * injection, not here (issue #159 — they are promoted to consumed by the
 * NEXT harvest, once the run shows evidence of triage). Rejects with
 * "Nothing to harvest…" when a harvest would deliver nothing.
 */
export function samuraiHarvestArm(sessionId: number): Promise<void> {
  return invoke("samurai_harvest_arm", { sessionId });
}

/**
 * How many journal entries a harvest would deliver right now (Rust
 * `samurai_harvest_preview`, issue #159): the UNCONSUMED entries plus a
 * PENDING batch whose run shows no evidence of triage — those are
 * re-delivered, so the Journal panel can no longer derive this count from
 * the listed statuses alone. 0 means nothing to harvest.
 */
export function samuraiHarvestPreview(): Promise<number> {
  return invoke("samurai_harvest_preview");
}

/**
 * Reads one saved harvest report by absolute path — the Journal panel's
 * legacy-reports section lists rows by path, this serves their content (Rust
 * `samurai_harvest_read`). New reports no longer land there (issue #98
 * moved harvest into an interactive session, whose /insights report goes to
 * Downloads), but previously generated ones stay readable. The backend
 * refuses anything that is not a regular file directly under the harvest
 * directory.
 */
export function samuraiHarvestRead(path: string): Promise<string> {
  return invoke("samurai_harvest_read", { path });
}

/** Mirrors the Rust `HarvestReportRow` (issue #142). */
export interface SamuraiHarvestReport {
  path: string;
  size_bytes: number;
  modified_at: string | null;
}

/**
 * Every legacy harvest report saved under `<app data>/harvest/` (Rust
 * `samurai_harvest_list`), newest first. Resolves an EMPTY list when the
 * directory was never created or holds nothing — that is the normal state
 * since #98 moved harvest into an interactive session, not a failure.
 */
export function samuraiHarvestList(): Promise<SamuraiHarvestReport[]> {
  return invoke("samurai_harvest_list");
}

// ---------------------------------------------------------------------------
// Issue #82: guarded read of ANY listed Samurai file — the Second Brain viewer
// ---------------------------------------------------------------------------

/**
 * Reads one Samurai-managed file by absolute path, read-only (Rust
 * `samurai_file_read`) — the Second Brain's file viewer serves every row's
 * content from here, not just harvest reports.
 *
 * Containment is the backend's: the path is accepted ONLY if the inventory it
 * recomputes on every call — the same snapshot `samuraiFilesList` returns —
 * currently holds it. Anything else, anything over the 2 MB cap, and any read
 * failure rejects with a plain readable string; render it as-is rather than
 * parsing it.
 */
export function samuraiFileRead(path: string): Promise<string> {
  return invoke("samurai_file_read", { path });
}

/**
 * The pseudo-project the backend writes account-wide ALERT rows to when
 * nothing is supervised — the TS mirror of `allowance_watcher::ACCOUNT_PROJECT`.
 * It is a real key for `samurai_audit_read`, not a path: the Second Brain's
 * "Account-wide" card and the audit stream both read it with this exact
 * string.
 */
export const SAMURAI_ACCOUNT_PROJECT = "samurai-account";

/**
 * The run id those account-wide rows carry — the TS mirror of
 * `allowance_watcher::ACCOUNT_RUN`, the pseudo-run paired with
 * {@link SAMURAI_ACCOUNT_PROJECT}. `AuditSection` re-exports it, which is
 * where audit-row grouping consumes it.
 */
export const SAMURAI_ACCOUNT_RUN = "account";
