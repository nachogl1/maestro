import { invoke } from "@tauri-apps/api/core";

/**
 * Thin wrappers over the Samurai supervisor / audit tauri commands
 * (`src-tauri/src/commands/samurai.rs`), following the per-domain lib module
 * convention (`lib/processes.ts`, `lib/memory.ts`, …).
 *
 * Phase 1 (issue #46) consumes read-only surfaces: the supervised-session
 * snapshots and the per-project audit log. Registration/transitions stay
 * backend-driven (or manual via devtools) until Phases 2–3.
 */

/** Wire names of the supervisor states (SCREAMING serde names, PRD §5.2). */
export type SamuraiSupervisorState =
  | "WORKING"
  | "HANDOFF_REQUESTED"
  | "HANDOFF_WRITTEN"
  | "KILLED"
  | "PARK_REQUESTED"
  | "PARKED"
  | "DEAD";

/**
 * Mirrors the Rust `SessionSnapshot` — also the exact payload of every
 * `samurai-supervisor-event`.
 */
export interface SamuraiSessionSnapshot {
  session_id: number;
  /** Canonical project path (Windows `\\?\` prefix already stripped). */
  project: string;
  epic: string;
  generation: number;
  state: SamuraiSupervisorState;
  previous_state: SamuraiSupervisorState | null;
  in_flight: "HANDOFF" | "PARK" | null;
  /** RFC 3339 UTC timestamp of the change. */
  ts: string;
}

/** Audit row kinds (PRD §5.10). Sub-kinds live in `details.kind`. */
export type SamuraiAuditEventKind =
  | "SPAWN"
  | "HANDOFF"
  | "PARK"
  | "RESUME"
  | "COMPLETE"
  | "ALERT";

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
 * One pending resume timer — mirrors the Rust `ScheduleEntry`
 * (`core/samurai_schedule.rs`). Also the element type of the
 * `samurai-schedule-event` payload, which carries the FULL current list on
 * every arm/cancel/fire (issue #61).
 */
export interface SamuraiScheduleEntry {
  /** Canonical project path (Windows `\\?\` prefix already stripped). */
  project_path: string;
  epic: string;
  /** RFC 3339 UTC fire time — when the epic resumes. */
  fire_at: string;
  /** Why the timer exists (currently always `"park"`). */
  reason: string;
}

/** Snapshots of every supervised session, ordered by session id. */
export function samuraiListSessions(): Promise<SamuraiSessionSnapshot[]> {
  return invoke("samurai_list_sessions");
}

/**
 * Places a session under supervision (SPAWN audit row + supervisor event).
 * Used by the successor spawn flow (issue #55): registering with the exact
 * (project, epic, generation) the `samurai-spawn-successor` event named arms
 * the backend's verify-ritual delivery for this session's first
 * SessionStarted hook signal.
 */
export function samuraiRegisterSession(
  sessionId: number,
  projectPath: string,
  epic: string,
  generation: number,
): Promise<SamuraiSessionSnapshot> {
  return invoke("samurai_register_session", { sessionId, projectPath, epic, generation });
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

/**
 * Every pending resume timer, all projects (issue #61). Seeds the schedule
 * state on listener init; live updates ride `samurai-schedule-event`.
 */
export function samuraiScheduleList(): Promise<SamuraiScheduleEntry[]> {
  return invoke("samurai_schedule_list");
}

// ---------------------------------------------------------------------------
// Issue #63: run launcher — preflight, launch, cleanup, run listing
// ---------------------------------------------------------------------------

/** The `gh auth status` probe's structured result (a failed check is data). */
export interface SamuraiGhAuthCheck {
  ok: boolean;
  /** The authenticated gh user, when the check passed. */
  username: string | null;
  /** Why the check failed (gh missing, not logged in, runner error). */
  error: string | null;
}

/**
 * Preflight results (PRD §5.8). The third launch gate — issues declared
 * triaged/agent-ready — is a user declaration (checkbox in the form), so it
 * never appears here.
 */
export interface SamuraiPreflight {
  gh_auth: SamuraiGhAuthCheck;
  /**
   * Whether the usage API reports a governing allowance window. `false`
   * (session AND weekly both unreported, or the poll failed) is a
   * launch-blocking error — parking cannot govern the run.
   */
  windows_reported: boolean;
}

/** One epic's run config — mirrors the Rust `SamuraiRunConfig` (P3.1). */
export interface SamuraiRunConfig {
  /** Canonical project path (Windows `\\?\` prefix already stripped). */
  project_path: string;
  epic: string;
  /** `--repo owner/repo` pin for orchestrator prompts; null when unknown. */
  repo_pin: string | null;
  /** The epic's stable worktree path (PRD §5.9). */
  worktree_path: string;
  model: string | null;
  /** Per-run threshold overrides; null = the global config applies. */
  thresholds: unknown;
  status: "ACTIVE" | "ARCHIVED";
  /** RFC 3339 UTC creation timestamp. */
  created_at: string;
}

/** What a successful launch set up. */
export interface SamuraiLaunchResult {
  epic: string;
  branch: string;
  worktree_path: string;
  repo_pin: string | null;
  /** Review F5: a stale resume timer from a previous run was cancelled. */
  stale_timer_cancelled: boolean;
}

/** What one cleanup pass removed (all-false = already clean, PRD §5.9). */
export interface SamuraiCleanupReport {
  epic: string;
  branch: string;
  timer_cancelled: boolean;
  config_archived: boolean;
  worktree_removed: boolean;
  worktree_path: string | null;
  branch_deleted: boolean;
}

/** Runs the launch preflight: gh auth + allowance windows reported. */
export function samuraiPreflight(projectPath: string): Promise<SamuraiPreflight> {
  return invoke("samurai_preflight", { projectPath });
}

/**
 * Launches an epic run: server-side preflight re-check, epic worktree at the
 * stable path, ACTIVE run config, gen-1 spawn with the opening brief.
 * Refusals (untriaged, gh auth, no governing window, live session) arrive as
 * rejected promises with the reason.
 */
export function samuraiLaunchRun(
  projectPath: string,
  epic: string,
  model: string | null,
  issuesTriaged: boolean,
  handoffContextPct: number | null,
): Promise<SamuraiLaunchResult> {
  return invoke("samurai_launch_run", {
    projectPath,
    epic,
    model,
    issuesTriaged,
    handoffContextPct,
  });
}

/** Every ACTIVE run config across all projects — the active-runs list. */
export function samuraiListRuns(): Promise<SamuraiRunConfig[]> {
  return invoke("samurai_list_runs");
}

/**
 * One-click epic cleanup (destructive — confirm before calling): cancels the
 * resume timer, archives the run config, removes the epic worktree, deletes
 * the `samurai/<slug>` branch. Idempotent; refuses while a live supervised
 * session exists.
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

/** What a listed file is (PRD §8 rows 1–5) — mirrors `SamuraiFileKind`. */
export type SamuraiFileKind =
  | "HANDOFF"
  | "RUN_CONFIG"
  | "TIMER"
  | "AUDIT_LOG"
  | "JOURNAL"
  | "HARVEST_REPORT";

/**
 * One inventory row — mirrors the Rust `SamuraiFileEntry`
 * (`core/samurai_files.rs`). `TIMER` rows share `schedule.json` as their
 * `path` (one row per pending timer) and carry `fire_at` so the UI can
 * render "resumes at 14:32".
 */
export interface SamuraiFileEntry {
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

/**
 * Every Samurai-managed file (PRD §8) as one flat list: handoffs, run
 * configs (active + archived), pending timers, per-project audit logs, and
 * Phase 5 journal/harvest reports once they exist.
 */
export function samuraiFilesList(): Promise<SamuraiFileEntry[]> {
  return invoke("samurai_files_list");
}

/**
 * Deletes one Samurai-managed file (destructive — confirm before calling).
 * Rejects paths outside the backend-computed managed roots; an in-use file
 * rejects with a `SAMURAI_IN_USE_ERROR_PREFIX`-prefixed message unless
 * `force` is true (use `isSamuraiInUseError` to route to a harder confirm).
 */
export function samuraiFileDelete(path: string, force: boolean): Promise<void> {
  return invoke("samurai_file_delete", { path, force });
}
