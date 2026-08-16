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
 * Preflight results (PRD §5.8). Agent-readiness of the epic's issues is no
 * longer a gate here: gen-1 judges it itself as step 2 of its opening brief,
 * so there is nothing for the form to declare or for this to report.
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

/**
 * One workflow step box — mirrors the Rust `WorkflowNode`
 * (`core/samurai_workflow.rs`). `id` is the stable identity edits preserve;
 * step numbers are assigned at compile time, never stored.
 */
export interface SamuraiWorkflowNode {
  id: string;
  /** The step's instruction text (editable in the workflow editor). */
  text: string;
  /**
   * Optional short display name, used where a step needs a one-line handle
   * instead of its full text — the PR review workflow's checkboxes. Absent on
   * Samurai run graphs; Rust's serde ignores the unknown field, so a graph
   * carrying one still deserializes into `WorkflowNode`.
   */
  label?: string;
}

/** One directed edge between two node ids — mirrors the Rust `WorkflowEdge`. */
export interface SamuraiWorkflowEdge {
  from: string;
  to: string;
}

/**
 * The run workflow graph (issue #91) — mirrors the Rust `WorkflowGraph`.
 * The backend compiles the path reachable from `start` (following the FIRST
 * outgoing edge per node, in edge-list order; cycles stop before a repeat;
 * unreachable nodes are excluded) into the numbered WORKFLOW section of
 * every orchestrator brief. The graph is instruction, not machinery — v1
 * has no step enforcement. Snapshotted into the run config at launch, so
 * successor briefs recompile the same workflow after handoffs.
 */
export interface SamuraiWorkflowGraph {
  nodes: SamuraiWorkflowNode[];
  edges: SamuraiWorkflowEdge[];
  /** Node id the compile walk starts from. */
  start: string;
}

/** One epic's run config — mirrors the Rust `SamuraiRunConfig` (P3.1). */
export interface SamuraiRunConfig {
  /** Canonical project path (Windows `\\?\` prefix already stripped). */
  project_path: string;
  /**
   * The run's identity AND display string. Since issue #83 a launch stores
   * the readable label here (`epic #5 · issues #7, #9`); configs written
   * before that hold a single raw ref (`#38`). Render this rather than
   * rebuilding it from the two lists below, which older configs leave empty.
   */
  epic: string;
  /** Parent epic refs, bare (`5`); empty for configs written before #83. */
  epics: string[];
  /** Standalone issue refs, bare (`7`); empty for pre-#83 configs. */
  issues: string[];
  /**
   * The free-text launch request this run was started from, verbatim
   * (issue #128); null on configs written before free-text launches.
   */
  launch_text: string | null;
  /** `--repo owner/repo` pin for orchestrator prompts; null when unknown. */
  repo_pin: string | null;
  /** The epic's stable worktree path (PRD §5.9). */
  worktree_path: string;
  model: string | null;
  /** Per-run threshold overrides; null = the global config applies. */
  thresholds: unknown;
  /**
   * The workflow graph snapshotted at launch (issue #91); null on configs
   * written before workflows existed — the backend then compiles the
   * default template.
   */
  workflow: SamuraiWorkflowGraph | null;
  /**
   * ACTIVE = live; COMPLETED = verified finished (issue #96 — the
   * orchestrator declared completion and the backend confirmed via gh that
   * every batch issue is closed and the batch PR is open), awaiting the
   * manual cleanup; ARCHIVED = cleaned up.
   */
  status: "ACTIVE" | "COMPLETED" | "ARCHIVED";
  /** RFC 3339 UTC creation timestamp. */
  created_at: string;
}

/**
 * A run's orchestrator's live details (issue #102) — mirrors the Rust
 * `SamuraiRunOrchestrator`. `generation`/`session_id` come from the
 * supervisor's session list; `model`/`context_window`/`context_percent`
 * come from the same per-session reading the 45% handoff trigger reads.
 * Every field is `null` when its source has nothing yet — no session
 * registered, or (for the live reading) no assistant message seen since —
 * render that as a dash, never a guess.
 */
export interface SamuraiRunOrchestrator {
  generation: number | null;
  session_id: number | null;
  model: string | null;
  /** The model's context window, in tokens. */
  context_window: number | null;
  /** `0`–`100`, one decimal. */
  context_percent: number | null;
}

/**
 * One Active Runs row — mirrors the Rust `SamuraiRunListEntry`: every
 * `SamuraiRunConfig` field (flattened on the wire) plus the live
 * `orchestrator` details.
 */
export interface SamuraiRunListEntry extends SamuraiRunConfig {
  orchestrator: SamuraiRunOrchestrator;
}

/**
 * One tick of the launch test-suite gate (issue #90b) — payload of the live
 * `samurai-test-gate-event` channel, emitted while the launch bootstraps the
 * epic worktree and runs `cargo test --workspace` in it. Mirrors the Rust
 * `TestGateProgress` (`core/samurai_test_gate.rs`).
 */
export interface SamuraiTestGateProgress {
  /** Canonical project path — filter on it, like every samurai channel. */
  project: string;
  epic: string;
  /** Wire step name. */
  step: "bootstrap_npm" | "bootstrap_mcp" | "cargo_test" | "passed" | "failed";
  /** Human line for the progress row ("bootstrap: npm install…"). */
  detail: string;
  /** Seconds since the gate started, as of this tick. */
  elapsed_secs: number;
}

/** What a successful launch set up. */
export interface SamuraiLaunchResult {
  /** The run's readable label (`epic #5 · issues #7, #9`) — issue #83. */
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
  /** A staged-but-unregistered gen-N spawn was cancelled before the delete. */
  spawn_cancelled: boolean;
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
 * Launches a run: server-side preflight re-check, run worktree at the stable
 * path, test-suite gate inside that worktree (issue #90b — bootstrap +
 * `cargo test --workspace`, progress on `samurai-test-gate-event`; a red
 * suite blocks the launch unless `skipTestGate` overrides), ACTIVE run
 * config, gen-1 spawn with the opening brief. Refusals (gh auth, no
 * governing window, live session, red gate) arrive as rejected promises
 * with the reason.
 *
 * `text` is the launcher's single free-text box (issue #128) — "what do you
 * want to work on today". It rides to the orchestrator VERBATIM. Any `#N`
 * refs found in it keep the ref-launch behavior (context read from GitHub,
 * epic-first); pure prose runs on the words alone. The backend normalizes
 * whitespace and derives the run's identity (refs label, or a short
 * slug+hash for prose), and refuses an empty request.
 *
 * `workflow` (issue #91) is the run's workflow graph — the editor's edited
 * graph, or omitted/null for the default template. Whatever the run
 * launches with is snapshotted into its run config, so successor briefs
 * recompile the same workflow after handoffs.
 */
export function samuraiLaunchRun(
  projectPath: string,
  text: string,
  model: string | null,
  handoffContextPct: number | null,
  skipTestGate: boolean,
  workflow?: SamuraiWorkflowGraph | null,
): Promise<SamuraiLaunchResult> {
  return invoke("samurai_launch_run", {
    projectPath,
    text,
    model,
    handoffContextPct,
    skipTestGate,
    workflow: workflow ?? null,
  });
}

/**
 * The DEFAULT workflow graph (issue #91) — the single source of truth for
 * the workflow editor's reset-to-default, identical to what a launch
 * without an explicit graph runs with.
 */
export function samuraiDefaultWorkflow(): Promise<SamuraiWorkflowGraph> {
  return invoke("samurai_default_workflow");
}

/**
 * Every unarchived run config across all projects — ACTIVE (live) plus
 * COMPLETED (finished-awaiting-cleanup, issue #96) — the runs list. Each row
 * carries its orchestrator's live details (issue #102): model, max context
 * window, live context %, generation, session id.
 */
export function samuraiListRuns(): Promise<SamuraiRunListEntry[]> {
  return invoke("samurai_list_runs");
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
 * last two = CONSUMED; ARCHIVED shows only for stragglers a crashed
 * harvest left in the active file (the next harvest moves them to
 * `archive.jsonl`).
 */
export type SamuraiJournalEntryStatus = "UNCONSUMED" | "CONSUMED" | "ARCHIVED";

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
 * SessionStarted hook signal. Journal entries flip to consumed AT that
 * injection, not here. Rejects with "Nothing to harvest…" when the journal
 * has no unconsumed entries.
 */
export function samuraiHarvestArm(sessionId: number): Promise<void> {
  return invoke("samurai_harvest_arm", { sessionId });
}

/**
 * Reads one saved harvest report by absolute path — the Second Brain lists
 * `HARVEST_REPORT` rows by path, this serves their content (Rust
 * `samurai_harvest_read`). New reports no longer land there (issue #98
 * moved harvest into an interactive session, whose /insights report goes to
 * Downloads), but previously generated ones stay readable. The backend
 * refuses anything that is not a regular file directly under the harvest
 * directory.
 */
export function samuraiHarvestRead(path: string): Promise<string> {
  return invoke("samurai_harvest_read", { path });
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
