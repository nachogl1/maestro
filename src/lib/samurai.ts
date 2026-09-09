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

/**
 * Issue #174: a human label for a RUN-FATAL audit row — one whose run has
 * died or stranded and will not recover on its own — or `null` for every
 * other row. The whole point of supervision is that the human does not watch
 * the terminal, so exactly these rows must come TO the human (toast +
 * persistent attention badge) instead of waiting in the sidebar audit list:
 *
 * - `submit_unconfirmed` — every delivery retry gave up; the agent may be
 *   sitting at an empty prompt (the Nido stranding, 2026-08-20).
 * - `circuit_breaker` — the breaker parked the run.
 * - `successor_no_start` / `spawn_dropped` — a successor never appeared.
 * - `delivery_failed` with `retype: true` — the #171 re-delivery itself
 *   failed (a plain delivery_failed re-arms and can still recover, so it
 *   does not notify).
 * - the watchdog's silent-death `KILL` row (`details.kind: "dead"`).
 * - every cold-start reconciliation verdict (`reconcile_*`): each one says a
 *   persisted ACTIVE run has NO owner and startup deliberately spawned
 *   nothing, so only a human can move it. These were the omission that let
 *   the real Nido run sit dead from 2026-08-20 to 2026-09-08 while 22
 *   `reconcile_interrupted` rows piled up unread in the audit list.
 *
 * Deliberately NOT fatal: allowance parks (planned, resume timer armed),
 * submit_retry (still recovering), ack_timeout (the injector re-arms).
 */
export function samuraiRunFatalLabel(event: SamuraiAuditEvent): string | null {
  const details = (event.details ?? {}) as Record<string, unknown>;
  if (event.event === "KILL") {
    return details.kind === "dead" ? "Agent process died silently" : null;
  }
  if (event.event !== "ALERT") return null;
  switch (details.kind) {
    case "submit_unconfirmed":
      return "Brief delivery unconfirmed — the run may be stranded";
    case "circuit_breaker":
      return "Circuit breaker parked the run";
    case "successor_no_start":
      return "Successor session never started";
    case "spawn_dropped":
      return "Successor spawn was dropped";
    case "delivery_failed":
      return details.retype === true ? "Brief re-delivery failed" : null;
    // The cold-start reconciliation verdicts. They carry the 0 sentinel
    // for session/generation (no session exists — that IS the finding), so
    // they raise the toast + OS notification and badge nothing.
    case "reconcile_interrupted":
      return "Run was interrupted — resume or abandon it";
    case "reconcile_orphan":
      return "An orchestrator from before the restart may still be running";
    case "reconcile_gh_auth":
      return "Run was interrupted and `gh` is logged out — fix auth, then resume";
    case "reconcile_unstartable":
      return "Run has no resume point — relaunch it from the launcher";
    // PR #193 added this row but no label, so the one verdict that says
    // "there is a run here Maestro cannot see at all" reached nothing but
    // the passive audit list — the same silence that let the Nido run rot.
    // It is not in the Active Runs list either (the file is unreadable), so
    // the toast is the ONLY place it can surface.
    case "reconcile_unreadable_config":
      return "A run's saved file could not be read — that run is invisible to Maestro";
    // Issue #205's SECOND rung only. One ALERT kind covers both rungs, and
    // `escalated: false` is the FIRST expiry — a nudge went out and the agent
    // still has a corrective to act on, so it belongs on the attention tier
    // ({@link samuraiRunAttentionLabel}), not here. `escalated: true` is the
    // run going fatal: the brief was never read one corrective later, and the
    // generation was put back on the queue (or could not be).
    case "brief_unread":
      if (details.escalated !== true) return null;
      return details.respawned === true
        ? "Brief was never read — the run was respawned"
        : "Brief was never read — the run is stranded";
    default:
      return null;
  }
}

/**
 * Issue #206: a human label for an ATTENTION audit row — something is wrong
 * with a run but supervision is still correcting it, so the user should SEE
 * it without being told the run is dead.
 *
 * The one row today is the first `brief_unread` expiry (`escalated: false`,
 * issue #205): the delivered brief has not been opened, and a corrective is
 * on its way. Loud enough to reach a user who is not watching the terminal
 * (toast + OS notification, the surfaces #174 built), quiet enough not to
 * claim a dead run — the escalated rung above is what says that.
 *
 * Disjoint from {@link samuraiRunFatalLabel} by construction: no row ever
 * gets a label from both, so a caller can raise whichever is non-null.
 */
export function samuraiRunAttentionLabel(event: SamuraiAuditEvent): string | null {
  if (event.event !== "ALERT") return null;
  const details = (event.details ?? {}) as Record<string, unknown>;
  if (details.kind !== "brief_unread" || details.escalated === true) return null;
  return "Has not read its brief yet — nudging it";
}

/**
 * The `INJECT details.instruction` kinds that deliver a generation's BRIEF —
 * `samurai_replicator.rs`'s three ritual flavours. Every other INJECT
 * (`handoff`, `park`, `soft_winddown`, `winddown_allclear` — the injector's
 * `InstructionKind::as_str`) is an instruction to a RUNNING agent, not the
 * operating instructions a generation starts from, and has no read receipt.
 */
const BRIEF_INSTRUCTION_KINDS = new Set(["launch_brief", "recovery_ritual", "successor_ritual"]);

/**
 * What the audit trail says about one generation's brief:
 *
 * - `delivered` — the pointer reached the terminal (issue #101) and no
 *   receipt has been seen yet. Ordinary for the first seconds of a
 *   generation; only a `brief_unread` ALERT turns it into a complaint.
 * - `unread` — the read window closed with no receipt (issue #205).
 * - `read` — the agent opened the file (the `receipt` row, issue #204).
 */
export type SamuraiBriefStatus = "delivered" | "unread" | "read";

/** One audit row's verdict on a generation's brief (see {@link samuraiBriefSignal}). */
export interface SamuraiBriefSignal {
  generation: number;
  session_id: number;
  status: SamuraiBriefStatus;
}

/**
 * Issue #206: what one audit row says about its generation's brief, or `null`
 * when it says nothing at all.
 *
 * Three row shapes carry the fact, and nothing else in the trail does:
 * `INJECT phase=delivered` for a ritual instruction (the brief went out),
 * `INJECT phase=receipt` (issue #204 — the agent opened it), and
 * `ALERT kind=brief_unread` (issue #205 — the window closed unread). The
 * `corrective` INJECT is deliberately NOT a signal: it re-points at a brief
 * that is still unread, so it must not reset the state to `delivered`.
 */
export function samuraiBriefSignal(event: SamuraiAuditEvent): SamuraiBriefSignal | null {
  const details = (event.details ?? {}) as Record<string, unknown>;
  const at = (status: SamuraiBriefStatus): SamuraiBriefSignal => ({
    generation: event.generation,
    session_id: event.session_id,
    status,
  });
  if (event.event === "INJECT") {
    if (details.phase === "receipt") return at("read");
    if (details.phase === "delivered" && typeof details.instruction === "string") {
      return BRIEF_INSTRUCTION_KINDS.has(details.instruction) ? at("delivered") : null;
    }
    return null;
  }
  if (event.event === "ALERT" && details.kind === "brief_unread") return at("unread");
  return null;
}

/** How a brief status reads on the run badge and the Active Runs row. */
export interface SamuraiBriefPresentation {
  /** The chip text — `brief ✓` or `brief ⚠ unread`. */
  label: string;
  /** Hover text: what the state means and what happens next. */
  title: string;
  /** Sidebar badge palette classes, per the fork's status colours. */
  cls: string;
}

/**
 * Issue #206: the chip for one brief status.
 *
 * Two readings, not three: the user's question is "is this agent working off
 * its instructions?", and a brief that HAS NOT BEEN READ YET answers it the
 * same way as one the window has already expired on. What differs is how
 * alarming it is — a just-delivered brief is muted grey (nothing is wrong
 * yet, the read window is open), an expired one is amber (issue #205's nudge
 * has gone out) — so the tint carries the urgency and the words stay stable.
 *
 * Never red: an unread brief is corrected automatically, and red in this fork
 * means a human is needed. The escalated rung is what turns the run fatal,
 * and that has its own surfaces ({@link samuraiRunFatalLabel}).
 */
export function samuraiBriefPresentation(status: SamuraiBriefStatus): SamuraiBriefPresentation {
  if (status === "read") {
    return {
      label: "brief ✓",
      title: "This generation opened the brief it was given — it is working off its instructions.",
      cls: "bg-maestro-green/20 text-maestro-green",
    };
  }
  if (status === "delivered") {
    return {
      label: "brief ⚠ unread",
      title:
        "The brief was delivered to this generation and it has not opened the file yet. Normal for the first moments of a generation; if the read window closes, Maestro sends one corrective.",
      cls: "bg-maestro-muted/15 text-maestro-muted",
    };
  }
  return {
    label: "brief ⚠ unread",
    title:
      "The read window closed and this generation never opened its brief. Maestro has sent one corrective; if it is still unread after that, the run is taken fatal and respawned.",
    cls: "bg-maestro-orange/20 text-maestro-orange",
  };
}

/** Mirrors the Rust `AuditReadResult`. */
export interface SamuraiAuditReadResult {
  events: SamuraiAuditEvent[];
  file_size_bytes: number;
}

/**
 * The one non-park timer reason (issue #129) — see
 * `SamuraiScheduleEntry.reason`. Every park-facing view filters it out:
 * a scheduled launch is a run that does not exist yet, so treating it as a
 * park badges an empty project "parked · resumes …", and a held (overdue)
 * one counts down into the past.
 */
export const SCHEDULED_LAUNCH_REASON = "scheduled_launch";

/** A park (resume) timer, as opposed to a scheduled launch. */
export function isParkEntry(entry: SamuraiScheduleEntry): boolean {
  return entry.reason !== SCHEDULED_LAUNCH_REASON;
}

/**
 * Comparison form of an epic label. A resume timer's epic and the run
 * config's epic are the same epic written by two different producers
 * (`#38`, `epic-38`, `Epic #38 · issues #7, #9`), so the two only line up
 * once punctuation, casing and padding are out of the way — the same
 * normalisation the branch slug uses.
 */
export function epicSlug(epic: string): string {
  return epic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  /** Why the timer exists: `"park"`, or `"scheduled_launch"` (issue #129). */
  reason: string;
  /**
   * The launch a `"scheduled_launch"` entry performs when it fires (issue
   * #129). Absent on resume timers — the backend omits it when unset.
   */
  launch?: SamuraiScheduledLaunchSpec | null;
  /**
   * A held entry never fires on its own — it waits for the user's
   * launch-or-discard (issue #129: overdue at app start, or unattended
   * retries exhausted). The backend omits it when false.
   */
  held?: boolean;
}

/** Mirrors the Rust `ScheduledLaunchSpec` (issue #129). */
export interface SamuraiScheduledLaunchSpec {
  /** The verbatim free-text launch request (issue #128). */
  text: string;
  model: string | null;
  handoff_context_pct: number | null;
  skip_test_gate: boolean;
  /**
   * The workflow graph snapshotted when the launch was scheduled (issue #91).
   * Absent on entries armed before the field existed — the backend then
   * compiles its default template, exactly as an unedited editor would.
   */
  workflow?: SamuraiWorkflowGraph | null;
  /** Unattended fire attempts already failed and re-armed. */
  attempts: number;
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
 *
 * `launchLinePrompt` (issue #158) claims that a gen-1 launch prompt is on the
 * `claude` command line about to be typed, so the backend must not type it in
 * as well. The claim can be REFUSED without failing the call, so the answer
 * comes back in `launch_line_prompt` — read it, never infer acceptance from
 * the call resolving.
 */
export interface SamuraiRegisterResult {
  session: SamuraiSessionSnapshot;
  /** Whether the backend actually armed the launch-line route. */
  launch_line_prompt: boolean;
}

export function samuraiRegisterSession(
  sessionId: number,
  projectPath: string,
  epic: string,
  generation: number,
  launchLinePrompt = false,
): Promise<SamuraiRegisterResult> {
  return invoke("samurai_register_session", {
    sessionId,
    projectPath,
    epic,
    generation,
    launchLinePrompt,
  });
}

/**
 * Undoes a `launchLinePrompt` claim when the launch line it described never
 * reached the PTY (issue #158). Best effort: `false` just means there was
 * nothing to undo.
 */
export function samuraiRevertLaunchLinePrompt(sessionId: number): Promise<boolean> {
  return invoke("samurai_revert_launch_line_prompt", { sessionId });
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
 * Recovers a crashed, non-completed run (issue #124): an explicit,
 * human-only action. The backend verifies the real state first (ACTIVE run,
 * no live agent, worktree branch + HEAD via git), determines the true resume
 * point from the registry and the handoff files, then spawns the next
 * generation — from the handoff when one exists, else via the full recovery
 * ritual (reconstruct from git + gh, verify before trusting).
 */
export function samuraiRecoverRun(
  projectPath: string,
  epic: string,
): Promise<SamuraiRecoverResult> {
  return invoke("samurai_recover_run", { projectPath, epic });
}

/**
 * Ends a park EARLY (issue #211) — the one manual resume behind every park
 * kind: allowance, gh-auth and circuit breaker alike. Cancels the run's
 * pending resume timer and spawns the successor now.
 *
 * Everything `samuraiRecoverRun` verifies still applies (ACTIVE run, no
 * live agent, worktree branch + HEAD via git, a breaker park's stamp and
 * counter cleared). The difference: an engaged hard park sweep does not
 * refuse it, because an exhausted allowance is exactly what the caller is
 * overriding on purpose. Prefer {@link resumeRunNow} in `lib/samuraiResume`
 * — it adds the allowance warning and the shared in-flight guard.
 */
export function samuraiResumeNow(projectPath: string, epic: string): Promise<SamuraiRecoverResult> {
  return invoke("samurai_resume_now", { projectPath, epic });
}

/**
 * Schedules a one-shot run launch for a day+time (issue #129). `fireAt` is
 * RFC 3339 and must be in the future; the free-text request (issue #128) and
 * the launch options are stored on the timer and launched — full server-side
 * preflight and refusal matrix included — when it fires. Discard a scheduled
 * launch with `samuraiTimerCancel`.
 */
export function samuraiScheduleLaunch(
  projectPath: string,
  text: string,
  fireAt: string,
  model: string | null,
  handoffContextPct: number | null,
  skipTestGate: boolean,
  workflow?: SamuraiWorkflowGraph | null,
): Promise<SamuraiScheduleEntry> {
  return invoke("samurai_schedule_launch", {
    projectPath,
    text,
    fireAt,
    model,
    handoffContextPct,
    skipTestGate,
    // Issue #91: the edited graph must ride the SCHEDULED path too. Omitting
    // it made the backend snapshot the default template into the run config
    // when the timer fired, silently discarding the user's workflow.
    workflow: workflow ?? null,
  });
}

// ---------------------------------------------------------------------------
// Issue #63: run launcher — preflight, launch, cleanup, run listing
// ---------------------------------------------------------------------------

/**
 * A preflight row's verdict (issue #214). `pass` clears; `warn` is advisory
 * — the user may launch over it on their own head; `fail` is "this cannot
 * work" and no checkbox clears it.
 */
export type SamuraiPreflightStatus = "pass" | "warn" | "fail";

/** Every preflight check's stable id — mirrors the Rust `CHECK_*` consts. */
export const PREFLIGHT_GH_AUTH = "gh_auth";
export const PREFLIGHT_USAGE_WINDOWS = "usage_windows";
export const PREFLIGHT_ALLOWANCE_HEADROOM = "allowance_headroom";
export const PREFLIGHT_DUPLICATE_RUN = "duplicate_run";

/**
 * One structured preflight verdict (issue #214) — mirrors the Rust
 * `PreflightCheck` (`commands/samurai.rs`). Every check reports itself
 * whether it passed or not, which is what lets the dialog colour each row
 * and say which one blocks instead of showing one opaque refusal string.
 *
 * Agent-readiness of the epic's issues is not among them: gen-1 judges it
 * itself as step 2 of its opening brief.
 */
export interface SamuraiPreflightCheck {
  /** `gh_auth` | `usage_windows` | `allowance_headroom` | `duplicate_run`. */
  id: string;
  status: SamuraiPreflightStatus;
  /** The human sentence. On a `fail` it IS the launch refusal, verbatim. */
  detail: string;
  /** Whether "Launch anyway (warnings only)" may carry a launch past it. */
  overridable: boolean;
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

/**
 * Mirrors the Rust `InterruptedStamp` (PR #185): cold-start reconciliation
 * found this run ACTIVE with no owner — no resume timer, no live supervised
 * session — and told the human so. The stamp latches that alert (so it is
 * not repeated every launch) and, because it survives on disk, it is ALSO
 * the durable "this run is dead" fact the UI reads: the run stays stamped
 * until it is resumed (recovered), relaunched, or abandoned.
 */
export interface SamuraiInterruptedStamp {
  /** RFC 3339 UTC time the interruption was first reported. */
  at: string;
  /** The generation the run died at — `0` when nothing knew one. */
  prior_generation: number;
  /**
   * Which cold-start verdict raised the row — one of
   * `reconcile_interrupted`, `reconcile_gh_auth`, `reconcile_unstartable`.
   * The backend latches all three onto this one stamp and re-alerts when the
   * kind changes (a logged-out `gh` coming back, say). Optional here: it is
   * backend bookkeeping, and stamps written before it existed have no key.
   */
  kind?: string;
}

/**
 * Mirrors the Rust `ParkedStamp` (issue #209): supervision is holding this
 * run PARKED and only a human gets it moving again.
 *
 * Today the only writer is the circuit breaker, which fires when the agent
 * burned allowance without moving HEAD — an automatic restart would loop
 * straight back into the same burn, so it arms NO resume timer on purpose.
 * An allowance park is the opposite and is not stamped here: it carries its
 * own timer on the schedule and heals itself.
 */
export interface SamuraiParkedStamp {
  /**
   * Why it parked. `circuit_breaker` is the only value written today; an
   * unrecognised reason must still read as parked, never as healthy.
   */
  reason: string;
  /** RFC 3339 UTC time of the park. */
  at: string;
  /** The generation that was parked. */
  generation: number;
  /** The HEAD the breaker watched stand still, when it was readable. */
  head: string | null;
}

/** The `parked.reason` values the backend writes — see
 *  {@link SamuraiParkedStamp}. The breaker stamps its own park (issue #209);
 *  the parker's sweep stamps the other two (issue #211), so every park kind
 *  is visible on the run itself and not only in a timer that, for a gh-auth
 *  park, is never armed at all. */
export const PARK_REASON_CIRCUIT_BREAKER = "circuit_breaker";
export const PARK_REASON_ALLOWANCE = "allowance";
export const PARK_REASON_GH_AUTH_LOST = "gh_auth_lost";

/** How a park stamp's reason reads on a badge. Unknown reasons (a newer
 *  backend) render as themselves rather than vanishing. */
export function parkReasonLabel(reason: string): string {
  switch (reason) {
    case PARK_REASON_CIRCUIT_BREAKER:
      return "breaker";
    case PARK_REASON_ALLOWANCE:
      return "allowance";
    case PARK_REASON_GH_AUTH_LOST:
      return "gh auth";
    default:
      return reason;
  }
}

/** Whether a run is parked BY THE BREAKER: a dead run whose only way out is
 *  the human's Resume click. */
export function isBreakerParked(run: SamuraiRunConfig): boolean {
  return run.status === "ACTIVE" && run.parked?.reason === PARK_REASON_CIRCUIT_BREAKER;
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
   * Short per-project run counter (issue #175) — the N in the default
   * `Samurai-N` session name; 0 on configs written before the counter.
   */
  run_number: number;
  /**
   * The run's CURRENT display name (issue #175): `Samurai-N` by default, or
   * the user's rename, carried into every generation's terminal. Display
   * only — `epic` stays the run's identity. Null on legacy configs.
   */
  display_name: string | null;
  /**
   * ACTIVE = live; COMPLETED = verified finished (issue #96 — the
   * orchestrator declared completion and the backend confirmed via gh that
   * every batch issue is closed and the batch PR is open), awaiting the
   * manual cleanup; ARCHIVED = cleaned up.
   */
  status: "ACTIVE" | "COMPLETED" | "ARCHIVED";
  /**
   * Set once cold-start reconciliation reported this run interrupted (PR
   * #185); null while the run is healthy, and cleared again the moment it
   * has an owner. A stamped ACTIVE run is a DEAD run — badge it, never let
   * it read as live.
   */
  interrupted_at: SamuraiInterruptedStamp | null;
  /**
   * Set while supervision holds this run PARKED with no automatic way back
   * (issue #209) — today only a circuit-breaker trip. Null on a healthy run
   * and on configs written before the stamp existed. Cleared by the resume,
   * the abandon and the cleanup.
   */
  parked: SamuraiParkedStamp | null;
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

/**
 * Runs the launch preflight and returns one structured verdict per check
 * (issue #214): gh auth, allowance windows reported, allowance headroom, and
 * whether a run already owns this epic. `text` is the launcher request,
 * because the duplicate-run check is EPIC-level — without it there is no
 * epic to look up, and that row simply passes.
 */
export function samuraiPreflight(
  projectPath: string,
  text: string,
): Promise<SamuraiPreflightCheck[]> {
  return invoke("samurai_preflight", { projectPath, text });
}

/**
 * Launches a run: server-side preflight re-check, run worktree at the stable
 * path, test-suite gate inside that worktree (issue #90b — bootstrap +
 * `cargo test --workspace`, progress on `samurai-test-gate-event`; a red
 * suite blocks the launch unless `skipTestGate` overrides), ACTIVE run
 * config, gen-1 spawn with the opening brief. Refusals (gh auth, no
 * governing window, live session, duplicate run, red gate) arrive as
 * rejected promises with the reason.
 *
 * `overrideWarnings` (issue #214) is the user's "Launch anyway (warnings
 * only)" tick. The backend re-runs the whole preflight and gates on it —
 * the tick only clears OVERRIDABLE warnings, never a `fail`, and a launch
 * that used it is recorded in the audit as `preflight_overridden`.
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
  overrideWarnings: boolean,
  workflow?: SamuraiWorkflowGraph | null,
): Promise<SamuraiLaunchResult> {
  return invoke("samurai_launch_run", {
    projectPath,
    text,
    model,
    handoffContextPct,
    skipTestGate,
    overrideWarnings,
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

/** What abandoning a run did — mirrors the Rust `SamuraiAbandonReport`. */
export interface SamuraiAbandonReport {
  /** The run config's own spelling of the epic. */
  epic: string;
  /** The worktree that was KEPT — abandoning deletes nothing on disk. */
  worktree_path: string;
  /** A pending resume timer was cancelled (it would respawn the run). */
  timer_cancelled: boolean;
  /** A staged-but-unregistered successor spawn was cancelled. */
  spawn_cancelled: boolean;
}

/**
 * Abandons a run: archives its config so it leaves the runs list and stops
 * alerting, and NOTHING else — the worktree, the branch and every commit on
 * it stay exactly where they are.
 *
 * This is the non-destructive twin of {@link samuraiCleanupEpic}. Before it
 * existed, archiving a config was reachable only through cleanup, so the
 * only way to quiet a dead run was to destroy its work — which is why the
 * dead Nido run was left alerting for three weeks instead.
 *
 * Refuses while a live supervised session exists (delisting a run somebody's
 * agent is still working is the one way this can lose information).
 */
export function samuraiAbandonRun(
  projectPath: string,
  epic: string,
): Promise<SamuraiAbandonReport> {
  return invoke("samurai_abandon_run", { projectPath, epic });
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
