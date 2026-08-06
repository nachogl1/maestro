//! Samurai injection controller (Phase 2, issues #53/#54; PRD §5.3/§5.4).
//!
//! Turns the context-percentage signal (P2.1's [`SamuraiContextStore`]) into
//! the first real supervisor *action*: when a WORKING session crosses
//! `handoff_context_pct`, request a handoff and type the instruction into
//! the session's terminal. Maestro types blindly (PRD §5.3), so two guards
//! apply:
//!
//! 1. **Idle gate** — the instruction is written only when the Stop hook
//!    reports the agent finished its turn (`SessionEnded { reason: "stop" }`),
//!    never on trigger alone. The signal is tapped in `lib.rs`'s
//!    `hook_emit_fn` chain via [`observe_hook`](SamuraiInjector::observe_hook),
//!    NOT the EventBus tee: the bus dedup key for `SessionEnded` ignores
//!    `reason` (5s window, see `claude_event.rs`), so a Stop landing shortly
//!    after a SessionEnd — or after another Stop — could be swallowed before
//!    it ever reached a bus-side tee. Issue #54 closes P2.2's known gap: the
//!    controller also tracks whether each session's most recent signal *was*
//!    a Stop ([`idle_effect`]), and a session that is idle right now is
//!    injected at tick time instead of waiting for a future Stop that will
//!    never fire.
//! 2. **ACK protocol** — the instruction requires the orchestrator to reply
//!    with `<samurai-ack>handoff gen-N</samurai-ack>`; the scanner reads
//!    every `AssistantMessage` from the EventBus tee (same spot as the
//!    context store) via [`observe`](SamuraiInjector::observe). No ACK
//!    within `ack_timeout_secs` → one retry at the next idle → still
//!    nothing → `ALERT` audit row (`details.kind = "ack_timeout"`) and the
//!    session stays in HANDOFF_REQUESTED for human attention.
//!
//! Issue #54 adds the rest of the handoff protocol. After the ACK the
//! orchestrator writes the §6 handoff file, commits WIP, and replies with
//! `<samurai-handoff-written>gen-N</samurai-handoff-written>`. On that
//! marker the controller runs exactly two checks (PRD decision #5 — no
//! template validation): the handoff file exists under the session's
//! working directory, and `git status --porcelain` reports no modified or
//! staged tracked files. Both pass → `HANDOFF_WRITTEN` (P2.4 takes over).
//! A failed check — or `ack_timeout_secs * 3` without the marker — arms ONE
//! corrective re-instruction through the existing retry plumbing; when that
//! round fails too, an `ALERT` audit row (`details.kind = "handoff_invalid"`)
//! fires and the session stays in HANDOFF_REQUESTED.
//!
//! Issue #60 parameterizes the ladder by instruction kind ([`PendingKind`]):
//! the same trigger→idle→ACK→retry→written→validate→corrective machinery now
//! also carries the allowance **park** instruction (lives in PARK_REQUESTED,
//! validates the same file+WIP checks, completes into PARKED and notifies the
//! parker) and the **soft wind-down** (no supervisor state at all — the ACK
//! alone completes it). The parker starts those ladders via
//! [`begin_park`](SamuraiInjector::begin_park) /
//! [`begin_soft_winddown`](SamuraiInjector::begin_soft_winddown).
//!
//! Loop shape mirrors `samurai_watchdog`: one periodic tick, decisions as
//! pure functions with table tests, I/O at the edges.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;

use super::claude_event::ClaudeEvent;
use super::process_manager::ProcessManager;
use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_config::SharedSamuraiConfig;
use super::samurai_context::SamuraiContextStore;
use super::samurai_parker::SamuraiParker;
use super::samurai_prompts;
use super::samurai_replicator::SamuraiReplicator;
use super::supervisor::{SessionSnapshot, Supervisor, SupervisorState};
use super::windows_process::StdCommandExt;

/// How often the trigger/timeout pass runs (same cadence as the watchdog).
pub const TICK_INTERVAL: Duration = Duration::from_secs(30);

/// The ACK marker tag the injected instruction requires in the reply.
pub const ACK_TAG: &str = "samurai-ack";

/// The completion marker tag: the orchestrator replies with it once the
/// handoff file is written and WIP is committed.
pub const WRITTEN_TAG: &str = "samurai-handoff-written";

/// The written marker gets `ack_timeout_secs * 3`: the ACK window is tuned
/// for a one-line reply, but producing the written marker means letting
/// subagents finish their current step, writing the §6 file and committing
/// WIP — real work that takes real time.
const WRITTEN_WINDOW_MULTIPLIER: u32 = 3;

/// Age cap on the two "waiting for idle" states (fresh-eyes finding E): a
/// trigger whose Stop never comes (wedged turn) or an armed retry whose idle
/// never comes would otherwise wait forever and the promised `ack_timeout`
/// ALERT could never fire. ×3 the ACK timeout because turns are legitimately
/// long (a busy orchestrator can run many minutes between Stops) and the PRD
/// only promises an EVENTUAL alert — a tight cap would false-alarm on every
/// long turn.
const STUCK_WAIT_MULTIPLIER: u32 = 3;

/// Resolves a Maestro session id to the directory its shell works in (the
/// worktree/sub-repo-aware cwd the SessionManager recorded). Injected as a
/// closure so the controller stays constructible in tests without tauri
/// managed state.
pub type SessionDirResolver = Arc<dyn Fn(u32) -> Option<String> + Send + Sync>;

/// Which ladder a pending entry runs (issue #60). The mechanics (idle-gate,
/// ACK, retry-once, written window, corrective round, timeouts) are shared;
/// the kind selects the supervisor state the entry lives in, the marker
/// values, the corrective text and the completion action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PendingKind {
    /// Context-threshold handoff (Phase 2): lives in HANDOFF_REQUESTED and
    /// completes into HANDOFF_WRITTEN + replication.
    Handoff,
    /// Allowance park (issue #60): lives in PARK_REQUESTED, runs the same
    /// two-check validation against the same handoff file (it doubles as
    /// park state), completes into PARKED and notifies the parker.
    Park,
    /// Soft wind-down (issue #60): no supervisor transition — the session
    /// stays WORKING and the ACK alone completes the entry.
    SoftWinddown,
}

impl PendingKind {
    /// The supervisor state a live entry of this kind belongs to; the tick's
    /// prune pass drops the entry when its session leaves this state.
    fn expected_state(self) -> SupervisorState {
        match self {
            Self::Handoff => SupervisorState::HandoffRequested,
            Self::Park => SupervisorState::ParkRequested,
            Self::SoftWinddown => SupervisorState::Working,
        }
    }

    /// Audit/log spelling of the instruction (`details.instruction`).
    fn as_str(self) -> &'static str {
        match self {
            Self::Handoff => "handoff",
            Self::Park => "park",
            Self::SoftWinddown => "soft_winddown",
        }
    }

    /// The ALERT `details.kind` for an exhausted validation ladder.
    /// SoftWinddown never reaches validation; the value is defensive only.
    fn invalid_kind(self) -> &'static str {
        match self {
            Self::Handoff => "handoff_invalid",
            Self::Park => "park_invalid",
            Self::SoftWinddown => "soft_winddown_invalid",
        }
    }
}

/// The round-scoped ACK value one entry expects (finding C discipline,
/// per kind).
fn expected_ack_value(kind: PendingKind, generation: u32, corrective: bool) -> String {
    match (kind, corrective) {
        (PendingKind::Handoff, false) => samurai_prompts::handoff_ack_value(generation),
        (PendingKind::Handoff, true) => samurai_prompts::handoff_ack_retry_value(generation),
        (PendingKind::Park, false) => samurai_prompts::park_ack_value(generation),
        (PendingKind::Park, true) => samurai_prompts::park_ack_retry_value(generation),
        (PendingKind::SoftWinddown, _) => samurai_prompts::soft_winddown_ack_value(generation),
    }
}

/// The round-scoped written-marker value one entry expects; `None` for the
/// soft wind-down, which has no written stage.
fn expected_written_value(kind: PendingKind, generation: u32, corrective: bool) -> Option<String> {
    match (kind, corrective) {
        (PendingKind::Handoff, false) => Some(samurai_prompts::handoff_written_value(generation)),
        (PendingKind::Handoff, true) => {
            Some(samurai_prompts::handoff_written_retry_value(generation))
        }
        (PendingKind::Park, false) => Some(samurai_prompts::park_written_value(generation)),
        (PendingKind::Park, true) => Some(samurai_prompts::park_written_retry_value(generation)),
        (PendingKind::SoftWinddown, _) => None,
    }
}

/// The kind's corrective re-instruction text. SoftWinddown cannot reach a
/// corrective (no validation stage); re-issuing the wind-down is the safe
/// defensive fallback.
fn corrective_instruction_for(
    kind: PendingKind,
    epic: &str,
    generation: u32,
    failure: &str,
) -> String {
    match kind {
        PendingKind::Handoff => {
            samurai_prompts::handoff_corrective_instruction(epic, generation, failure)
        }
        PendingKind::Park => samurai_prompts::park_corrective_instruction(epic, generation, failure),
        PendingKind::SoftWinddown => samurai_prompts::soft_winddown_instruction(generation),
    }
}

/// One instruction the controller is shepherding from trigger to ACK to the
/// validated handoff. Created when the trigger transitions a session into
/// HANDOFF_REQUESTED; dropped when the session leaves that state, validation
/// succeeds, or the final timeout/validation failure ALERTs.
struct PendingInstruction {
    /// Which ladder this entry runs (issue #60).
    kind: PendingKind,
    /// Audit context, captured from the transition snapshot.
    project: String,
    epic: String,
    generation: u32,
    /// The instruction text (no trailing `\r`; added at write time).
    instruction: String,
    /// Injection attempts so far: 0 (waiting for first idle), 1, or 2 (max).
    attempts: u8,
    /// When the latest injection was written; `None` before the first.
    injected_at: Option<Instant>,
    /// When the entry started (or resumed) WAITING for an idle signal:
    /// stamped at creation, and re-stamped whenever a retry/corrective is
    /// armed. Caps the wait (finding E): no injection possible within
    /// `ack_timeout_secs * STUCK_WAIT_MULTIPLIER` of this → ALERT.
    waiting_since: Instant,
    /// The orchestrator replied with the expected ACK marker.
    acked: bool,
    /// Attempt 1 timed out; re-inject at the next idle signal.
    awaiting_retry: bool,
    /// When the ACK arrived — the written-marker window runs from here.
    acked_at: Option<Instant>,
    /// The written marker arrived and the two-check validation is in flight.
    validating: bool,
    /// This entry carries the single corrective re-instruction; any further
    /// failure ALERTs instead of retrying again.
    corrective: bool,
    /// What the first round's validation/timeout found wrong (rides into the
    /// final `handoff_invalid` ALERT details).
    failure: Option<String>,
}

impl PendingInstruction {
    /// A fresh round-1 entry: waiting for the first idle signal.
    fn new(kind: PendingKind, snapshot: &SessionSnapshot, instruction: String) -> Self {
        Self {
            kind,
            project: snapshot.project.clone(),
            epic: snapshot.epic.clone(),
            generation: snapshot.generation,
            instruction,
            attempts: 0,
            injected_at: None,
            waiting_since: Instant::now(),
            acked: false,
            awaiting_retry: false,
            acked_at: None,
            validating: false,
            corrective: false,
            failure: None,
        }
    }
}

/// Trigger predicate (PRD §5.4): only a WORKING session with a known context
/// percentage at or past the threshold requests a handoff. `None` percent
/// (no assistant message observed yet) is missing evidence, not a trigger —
/// same philosophy as the watchdog's staleness handling.
fn should_request_handoff(
    state: SupervisorState,
    percent: Option<f64>,
    threshold_pct: f64,
) -> bool {
    state == SupervisorState::Working && percent.is_some_and(|p| p >= threshold_pct)
}

/// The idle signal: `SessionEnded` with `reason == "stop"` (the Stop hook —
/// agent finished its turn). The SessionEnd hook emits the same variant with
/// a different reason; that is a session going away, not a turn boundary.
fn idle_session_id(event: &ClaudeEvent) -> Option<u32> {
    match event {
        ClaudeEvent::SessionEnded {
            session_id, reason, ..
        } if reason == "stop" => Some(*session_id),
        _ => None,
    }
}

/// Issue #54 bonus fix (P2.2's known limitation): what one event says about
/// a session being idle *right now*. `Some((id, true))` — the Stop hook: the
/// turn just finished and no future idle signal will fire on its own.
/// `Some((id, false))` — evidence the turn restarted (SessionStarted, a tool
/// call, a submitted user prompt) or the session went away entirely (a
/// non-stop SessionEnded — never inject into a dead shell). `None` — no
/// signal either way.
///
/// Deliberately NOT cleared on `AssistantMessage`: transcript messages are
/// delivered by a file watcher and the final message of a turn regularly
/// arrives AFTER that turn's Stop hook (file polling vs. hook HTTP push).
/// Clearing on it would wipe a just-set idle flag while the session sits
/// idle — deadlocking exactly the already-idle case this fix exists for,
/// including the corrective re-instruction, which is always armed right
/// after such a late-arriving marker message. `UserMessage` is safe: it is
/// written at prompt submission, a genuine turn restart.
fn idle_effect(event: &ClaudeEvent) -> Option<(u32, bool)> {
    match event {
        ClaudeEvent::SessionEnded {
            session_id, reason, ..
        } => Some((*session_id, reason == "stop")),
        ClaudeEvent::SessionStarted { session_id, .. } => Some((*session_id, false)),
        ClaudeEvent::ToolUseStarted { session_id, .. } => Some((*session_id, false)),
        ClaudeEvent::UserMessage { session_id, .. } => Some((*session_id, false)),
        _ => None,
    }
}

/// Whether an idle signal should inject now. First idle after the trigger →
/// attempt 1; after attempt 1 times out (never on an idle alone — a reply
/// without the marker must not burn the retry), the next idle → attempt 2;
/// beyond that, or once ACKed, never. The corrective round re-enters this
/// exact table as (attempts=1, awaiting_retry=true). `expected` is the
/// entry's [`PendingKind::expected_state`] — a session that left it is no
/// longer instructable (the tick's prune pass drops the entry).
fn should_inject_on_idle(
    state: SupervisorState,
    expected: SupervisorState,
    acked: bool,
    attempts: u8,
    awaiting_retry: bool,
) -> bool {
    if state != expected || acked {
        return false;
    }
    match attempts {
        0 => true,
        1 => awaiting_retry,
        _ => false,
    }
}

/// What the tick's timeout pass concluded about one pending instruction
/// still waiting for its ACK.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimeoutVerdict {
    /// Nothing to do this tick.
    Keep,
    /// Attempt 1 ran out of time: arm the retry for the next idle signal.
    ArmRetry,
    /// The retry ran out of time too: ALERT once and stop tracking.
    Alert,
    /// Finding E: a waiting state aged out — the trigger fired but the Stop
    /// hook never came (wedged turn), or the retry was armed and idle never
    /// came. ALERT once (`never_idled` / `retry_never_injected`) and stop
    /// tracking: the session cannot be instructed.
    AlertStuck,
}

/// Pure ACK-timeout decision. `elapsed` is time since the latest injection
/// (`None` = not injected yet, still waiting for the first idle);
/// `waiting_elapsed` is time since the entry started waiting for an idle
/// signal (creation / retry armed). Both boundaries are strict (`>`),
/// matching "no ACK within N seconds".
fn timeout_verdict(
    acked: bool,
    attempts: u8,
    awaiting_retry: bool,
    elapsed: Option<Duration>,
    waiting_elapsed: Duration,
    timeout: Duration,
) -> TimeoutVerdict {
    if acked {
        return TimeoutVerdict::Keep; // resolved — the written phase owns it
    }
    let wait_cap = timeout * STUCK_WAIT_MULTIPLIER;
    if awaiting_retry {
        // Retry armed; idle never came (finding E: age-capped, not forever).
        return if waiting_elapsed > wait_cap {
            TimeoutVerdict::AlertStuck
        } else {
            TimeoutVerdict::Keep
        };
    }
    let Some(elapsed) = elapsed else {
        // Trigger fired, Stop never came — same age cap (finding E).
        return if waiting_elapsed > wait_cap {
            TimeoutVerdict::AlertStuck
        } else {
            TimeoutVerdict::Keep
        };
    };
    if elapsed <= timeout {
        return TimeoutVerdict::Keep;
    }
    match attempts {
        0 => TimeoutVerdict::Keep, // unreachable (elapsed implies an attempt); never panic
        1 => TimeoutVerdict::ArmRetry,
        _ => TimeoutVerdict::Alert,
    }
}

/// What the tick concluded about an ACKed instruction still waiting for the
/// written marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WrittenVerdict {
    /// Still inside the window, or validation owns the entry.
    Keep,
    /// The window expired on the first round: arm the corrective.
    Corrective,
    /// The window expired on the corrective round: ALERT once.
    Alert,
}

/// Pure written-marker timeout decision, evaluated only for ACKed entries.
/// `elapsed_since_ack` runs from the ACK (`None` is defensive — an ACK
/// always stamps `acked_at`). Strict boundary, same as [`timeout_verdict`].
fn written_verdict(
    validating: bool,
    corrective: bool,
    elapsed_since_ack: Option<Duration>,
    window: Duration,
) -> WrittenVerdict {
    if validating {
        return WrittenVerdict::Keep; // marker arrived; validation owns it
    }
    let Some(elapsed) = elapsed_since_ack else {
        return WrittenVerdict::Keep;
    };
    if elapsed <= window {
        return WrittenVerdict::Keep;
    }
    if corrective {
        WrittenVerdict::Alert
    } else {
        WrittenVerdict::Corrective
    }
}

/// Pull the inner text of the first `<tag>…</tag>` pair out of an assistant
/// message. Same deliberate plain string scan as
/// `transcript_parser::tag_value` — no XML parser, and a malformed blob
/// simply yields `None`.
fn marker_value(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].trim().to_string())
}

fn ack_value(text: &str) -> Option<String> {
    marker_value(text, ACK_TAG)
}

fn written_value(text: &str) -> Option<String> {
    marker_value(text, WRITTEN_TAG)
}

/// `fs::canonicalize` on Windows returns `\\?\`-prefixed extended-length
/// paths (the SessionManager stores them verbatim); `CreateProcess` rejects
/// that form as a working directory. Strip it, same as
/// `commands/terminal.rs` / `commands/ai_runner.rs`. On other platforms the
/// prefix never occurs and this is a no-op. `pub(crate)`: the replicator
/// (issue #55) resolves session dirs through the same resolver and needs the
/// identical stripping.
pub(crate) fn strip_extended_prefix(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path)
}

/// Whether one `git status --porcelain` line blocks the handoff. Untracked
/// (`??`) and ignored (`!!`) entries never block — new files the orchestrator
/// chose not to stage are its call — and neither does anything under
/// `.maestro/` (where the handoff file itself lands when the gitignore step
/// was skipped). Everything else is a modified/staged TRACKED file: WIP that
/// should have been committed.
fn porcelain_line_blocks(line: &str) -> bool {
    if line.len() < 3 {
        return false; // not a porcelain status line
    }
    let (code, path) = line.split_at(2);
    if code == "??" || code == "!!" {
        return false;
    }
    !path
        .trim_start()
        .trim_start_matches('"')
        .starts_with(".maestro/")
}

/// The two handoff checks — exactly two, per PRD decision #5 (no
/// template-section validation: a model can emit empty sections; the
/// successor's verify ritual is the real check). Blocking: runs inside
/// `spawn_blocking`. Git runs with a fixed argv and `current_dir` — no
/// shell, so untrusted strings are never interpolated into one.
fn validate_handoff(working_dir: &Path, relpath: &str) -> Result<(), String> {
    if !working_dir.join(relpath).is_file() {
        return Err(format!("the handoff file is missing at {relpath}"));
    }
    let output = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(working_dir)
        .hide_console_window()
        .output()
        .map_err(|e| format!("could not run git status in the session working directory: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git status failed in the session working directory: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let blocking: Vec<&str> = stdout
        .lines()
        .filter(|l| porcelain_line_blocks(l))
        .collect();
    if blocking.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "WIP is not committed — modified/staged tracked files remain: {}",
            blocking
                .iter()
                .take(5)
                .map(|l| l.trim())
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }
}

/// First-round failure (validation or written-marker timeout): turn the
/// entry into the single corrective re-instruction, re-armed through the
/// exact P2.2 retry plumbing — `attempts=1 + awaiting_retry=true` is the
/// "retry armed, inject at next idle" configuration, so a corrective that
/// never ACKs walks the existing attempts=2 timeout path into the ALERT
/// (with the `handoff_invalid` kind instead of `ack_timeout`).
fn arm_corrective(p: &mut PendingInstruction, failure: String) {
    log::warn!(
        "samurai injector: {} for gen-{} invalid ({failure}) — arming one corrective re-instruction",
        p.kind.as_str(),
        p.generation
    );
    p.instruction = corrective_instruction_for(p.kind, &p.epic, p.generation, &failure);
    p.attempts = 1;
    p.awaiting_retry = true;
    // The wait for the corrective's idle starts now (finding E age cap).
    p.waiting_since = Instant::now();
    p.acked = false;
    p.acked_at = None;
    p.validating = false;
    p.corrective = true;
    p.failure = Some(failure);
}

/// The kind's `*_invalid` ALERT row (corrective round exhausted) — e.g.
/// `handoff_invalid` / `park_invalid`. `failure` names the check that
/// failed, per the issue's audit contract.
fn invalid_alert(p: &PendingInstruction, session_id: u32, failure: String) -> AuditEvent {
    AuditEvent::now(
        p.epic.clone(),
        AuditEventKind::Alert,
        p.generation,
        session_id,
        json!({ "kind": p.kind.invalid_kind(), "failure": failure }),
    )
}

/// Review F3a test seam: an optional hook [`finish_validation`] runs between
/// its completion decision (pending lock released, entry KEPT) and the
/// transition chain — the exact window a concurrent sweep advance used to
/// disengage in. Test-only; production never sets it. The first argument is
/// the address of the pending map the call belongs to, so the one test that
/// sets the hook can ignore calls from other tests' injectors (tests run in
/// parallel in one process).
#[cfg(test)]
static VALIDATION_GAP_HOOK: Mutex<Option<Arc<dyn Fn(usize, u32) + Send + Sync>>> =
    Mutex::new(None);

#[cfg(test)]
fn validation_gap_hook() -> Option<Arc<dyn Fn(usize, u32) + Send + Sync>> {
    VALIDATION_GAP_HOOK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

#[cfg(test)]
fn set_validation_gap_hook(hook: Option<Arc<dyn Fn(usize, u32) + Send + Sync>>) {
    *VALIDATION_GAP_HOOK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = hook;
}

/// Completes one validation run. Module-level (not `&self`) because the
/// spawned validation task outlives any borrow of the controller — it
/// captures clones of exactly the pieces this needs. Both checks passed →
/// the kind's completion state (HANDOFF_WRITTEN + replication, or PARKED +
/// parker notification — the transition writes its audit row itself) and the
/// entry completes. Failed → corrective on the first round, the kind's
/// `*_invalid` ALERT on the corrective round (a failed park additionally
/// tells the parker so its sweep can skip the session and continue).
fn finish_validation(
    pending: &Mutex<HashMap<u32, PendingInstruction>>,
    supervisor: &Supervisor,
    audit: &AuditLog,
    replicator: Option<&Arc<SamuraiReplicator>>,
    parker: Option<&Arc<SamuraiParker>>,
    session_id: u32,
    outcome: Result<(), String>,
) {
    enum Next {
        Transition(PendingKind),
        Alert(PendingKind, String, AuditEvent),
        Nothing,
    }
    let next = {
        let mut map = pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(p) = map.get_mut(&session_id) else {
            log::warn!(
                "samurai injector: validation finished for session {session_id} with no pending instruction — dropped"
            );
            return;
        };
        if !p.validating {
            log::warn!(
                "samurai injector: stale validation result for session {session_id} — ignored"
            );
            return;
        }
        match outcome {
            Ok(()) => {
                // Review F3a: the entry is deliberately KEPT in the map until
                // the transition + completion chain below has RETURNED, and
                // only removed then. Removing it here opened a gap where a
                // concurrent `complete_sweep` (parker tick / teardown
                // completion) saw a ParkRequested session with nothing
                // pending — `blocks_completion` said "not blocking" — and
                // disengaged the sweep before `on_parked` recorded the epic:
                // parked epic, NO resume timer. `has_pending` now holds the
                // sweep open through the handover; the entry stays claimed
                // via `validating`, so a replayed marker cannot restart a
                // second validation meanwhile.
                Next::Transition(p.kind)
            }
            Err(failure) => {
                if p.corrective {
                    let kind = p.kind;
                    let project = p.project.clone();
                    let event = invalid_alert(p, session_id, failure);
                    map.remove(&session_id);
                    Next::Alert(kind, project, event)
                } else {
                    arm_corrective(p, failure);
                    Next::Nothing
                }
            }
        }
    };
    // Test-only interleaving seam (review F3a): lets the pinning test drive
    // a concurrent sweep advance into the exact window between the
    // completion decision and the transition chain.
    #[cfg(test)]
    if let Some(hook) = validation_gap_hook() {
        hook(pending as *const _ as usize, session_id);
    }
    match next {
        Next::Transition(kind) => {
            match kind {
                PendingKind::Handoff => {
                    log::info!(
                        "samurai injector: session {session_id} handoff validated (file present, WIP committed) — HANDOFF_WRITTEN"
                    );
                    match supervisor.transition(session_id, SupervisorState::HandoffWritten) {
                        // Issue #55: a validated handoff chains straight into the
                        // replicator (kill gen-N, stage gen-N+1) — no polling.
                        Ok(snapshot) => {
                            if let Some(replicator) = replicator {
                                replicator.on_handoff_written(&snapshot);
                            }
                        }
                        // E.g. the watchdog declared the session DEAD mid-validation.
                        Err(e) => log::warn!(
                            "samurai injector: HANDOFF_WRITTEN transition for session {session_id} rejected: {e}"
                        ),
                    }
                }
                PendingKind::Park => {
                    log::info!(
                        "samurai injector: session {session_id} park validated (file present, WIP committed) — PARKED"
                    );
                    match supervisor.transition(session_id, SupervisorState::Parked) {
                        // Issue #60: a validated park chains straight into the
                        // parker (teardown + sweep advance) — no polling.
                        // `on_parked` records the epic for its resume timer
                        // synchronously, so by the time the entry is removed
                        // below the sweep can only complete WITH the epic.
                        // (Residual instruction-level window: a tick landing
                        // exactly between the transition and `on_parked`'s
                        // insert — two adjacent calls on this thread —
                        // still sees a terminal state first; accepted.)
                        Ok(snapshot) => {
                            if let Some(parker) = parker {
                                parker.on_parked(&snapshot);
                            }
                        }
                        // E.g. the watchdog declared the session DEAD mid-validation;
                        // the parker's tick re-evaluates the sweep on its own.
                        Err(e) => log::warn!(
                            "samurai injector: PARKED transition for session {session_id} rejected: {e}"
                        ),
                    }
                }
                // The soft wind-down has no written stage, so no validation ever
                // runs for it — defensive arm, never expected.
                PendingKind::SoftWinddown => log::warn!(
                    "samurai injector: unexpected validation completion for a soft wind-down (session {session_id}) — ignored"
                ),
            }
            // Review F3a: removal AFTER the chain returned (see the Ok arm
            // above). On a rejected transition the entry is removed too —
            // the session left the expected state, the tick's prune would
            // only do the same a little later.
            pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&session_id);
        }
        Next::Alert(kind, project, event) => {
            log::error!(
                "samurai injector: session {} {} still invalid after the corrective round — ALERT ({}): {}",
                session_id,
                kind.as_str(),
                kind.invalid_kind(),
                event.details["failure"]
            );
            audit.append(&project, event);
            if kind == PendingKind::Park {
                if let Some(parker) = parker {
                    parker.on_park_failed(session_id);
                }
            }
        }
        Next::Nothing => {}
    }
}

/// The injection controller. Fed from three directions: the periodic tick
/// (trigger + timeouts + already-idle injection), the hook chain (idle
/// signals), and the EventBus tee (ACK/written scanning). All state lives
/// behind uncontended `Mutex`es; no lock is ever held across an await point.
pub struct SamuraiInjector {
    supervisor: Arc<Supervisor>,
    context: Arc<SamuraiContextStore>,
    config: SharedSamuraiConfig,
    processes: ProcessManager,
    audit: AuditLog,
    session_dirs: SessionDirResolver,
    /// `Arc` so the spawned validation task can reach the map after the
    /// call that spawned it returned.
    pending: Arc<Mutex<HashMap<u32, PendingInstruction>>>,
    /// Sessions whose most recent signal was a Stop — idle right now (issue
    /// #54 bonus fix; see [`idle_effect`]). Holds bare u32s, so an
    /// unsupervised session costs one integer until its SessionEnd.
    idle_now: Arc<Mutex<HashSet<u32>>>,
    /// Issue #55: the replication controller a validated handoff chains
    /// into. It also shares this controller's tick (its no-start timeout
    /// pass) and hook tap (SessionStarted ritual delivery). `None` only in
    /// tests that exercise the injector alone.
    replicator: Option<Arc<SamuraiReplicator>>,
    /// Issue #60: the parker a validated/failed park chains into; it also
    /// rides this controller's tick (sweep re-evaluation). Late-bound (the
    /// parker is constructed after the injector, holding an `Arc` of it);
    /// unset only in tests that exercise the injector alone.
    parker: std::sync::OnceLock<Arc<SamuraiParker>>,
    /// Review F4: the run-config store, consulted by the trigger pass for a
    /// per-run `handoff_context_pct` override (`thresholds` on the epic's
    /// run config). Late-bound like the parker; unset = global config only.
    run_configs: std::sync::OnceLock<Arc<super::samurai_run_config::RunConfigStore>>,
}

impl SamuraiInjector {
    pub fn new(
        supervisor: Arc<Supervisor>,
        context: Arc<SamuraiContextStore>,
        config: SharedSamuraiConfig,
        processes: ProcessManager,
        audit: AuditLog,
        session_dirs: SessionDirResolver,
        replicator: Option<Arc<SamuraiReplicator>>,
    ) -> Self {
        Self {
            supervisor,
            context,
            config,
            processes,
            audit,
            session_dirs,
            pending: Arc::new(Mutex::new(HashMap::new())),
            idle_now: Arc::new(Mutex::new(HashSet::new())),
            replicator,
            parker: std::sync::OnceLock::new(),
            run_configs: std::sync::OnceLock::new(),
        }
    }

    /// Issue #60: late-binds the parker (constructed after the injector; it
    /// holds an `Arc` of this controller, so the reverse edge is a OnceLock).
    /// Second calls are ignored, like every OnceLock slot in setup.
    pub fn set_parker(&self, parker: Arc<SamuraiParker>) {
        let _ = self.parker.set(parker);
    }

    /// Review F4: late-binds the run-config store (constructed after the
    /// injector in lib.rs), same pattern as `set_parker`. Second calls are
    /// ignored.
    pub fn set_run_configs(&self, store: Arc<super::samurai_run_config::RunConfigStore>) {
        let _ = self.run_configs.set(store);
    }

    /// The epic's per-run handoff threshold override, when its run config
    /// carries a `thresholds` block (review F4). Only the handoff trigger is
    /// per-run-meaningful — park thresholds stay GLOBAL (allowance windows
    /// are account-wide; see `allowance_watcher`). One small JSON read per
    /// supervised session per 30s tick; `None` on every miss.
    fn handoff_threshold_for(&self, project: &str, epic: &str) -> Option<f64> {
        self.run_configs
            .get()?
            .get(project, epic)?
            .thresholds
            .map(|t| t.handoff_context_pct)
    }

    /// EventBus tee (same spot as `SamuraiContextStore::observe`): scan
    /// assistant replies for the ACK and written markers, and let
    /// transcript-side activity update the idle flag. Every other variant is
    /// ignored, so the tee can pass the whole stream without filtering.
    pub fn observe(&self, event: &ClaudeEvent) {
        self.note_idle(event);
        if let ClaudeEvent::AssistantMessage {
            session_id, text, ..
        } = event
        {
            // ACK first: a reply carrying both markers at once must count as
            // ACKed before the written marker is considered.
            self.scan_ack(*session_id, text);
            self.scan_written(*session_id, text);
        }
    }

    /// Hook-chain tee (`hook_emit_fn` in `lib.rs`, pre-dedup — see module
    /// doc for why the idle signal cannot ride the EventBus tee). Also feeds
    /// the replicator (issue #55): a staged successor's ritual is delivered
    /// on its first `SessionStarted`, which arrives on this same chain.
    pub fn observe_hook(&self, event: &ClaudeEvent) {
        if let Some(replicator) = &self.replicator {
            replicator.observe_hook(event);
        }
        self.note_idle(event);
        if let Some(session_id) = idle_session_id(event) {
            self.on_idle(session_id);
        }
    }

    /// One trigger + timeout pass. Called from the spawned loop; fully
    /// synchronous (validation I/O is spawned, never run inline).
    pub fn tick(&self) {
        let (threshold_pct, timeout) = {
            let cfg = self
                .config
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (
                cfg.handoff_context_pct,
                Duration::from_secs(cfg.ack_timeout_secs),
            )
        };
        let written_window = timeout * WRITTEN_WINDOW_MULTIPLIER;

        // Trigger pass: WORKING sessions past the threshold request a
        // handoff. The state machine enforces one-in-flight and handoff/park
        // exclusivity and writes the HANDOFF(phase=requested) audit row; a
        // rejected transition already produced its illegal_transition ALERT.
        for session in self.supervisor.list_sessions() {
            let percent = self.context.percent(session.session_id);
            // Review F4: a per-run threshold override on the epic's run
            // config replaces the global handoff trigger for this session.
            let threshold = self
                .handoff_threshold_for(&session.project, &session.epic)
                .unwrap_or(threshold_pct);
            if !should_request_handoff(session.state, percent, threshold) {
                continue;
            }
            match self
                .supervisor
                .transition(session.session_id, SupervisorState::HandoffRequested)
            {
                Ok(snapshot) => {
                    log::info!(
                        "samurai injector: session {} at {:.1}% (threshold {threshold}%) — handoff requested, awaiting idle",
                        snapshot.session_id,
                        percent.unwrap_or_default(),
                    );
                    let instruction = samurai_prompts::handoff_instruction(
                        &snapshot.epic,
                        snapshot.generation,
                    );
                    self.lock_pending().insert(
                        snapshot.session_id,
                        PendingInstruction::new(PendingKind::Handoff, &snapshot, instruction),
                    );
                }
                Err(e) => log::warn!(
                    "samurai injector: handoff trigger for session {} rejected: {e}",
                    session.session_id
                ),
            }
        }

        // Prune + timeout pass. Re-list: the trigger pass above may have just
        // moved sessions into HANDOFF_REQUESTED.
        let state_of: HashMap<u32, SupervisorState> = self
            .supervisor
            .list_sessions()
            .into_iter()
            .map(|s| (s.session_id, s.state))
            .collect();

        let alerts: Vec<(u32, PendingKind, String, AuditEvent)> = {
            let mut pending = self.lock_pending();

            // An entry is only meaningful while its session sits in its
            // kind's expected state (HANDOFF_REQUESTED / PARK_REQUESTED /
            // WORKING for the soft wind-down): validation advancing it, the
            // watchdog declaring it DEAD, a superseding instruction, or
            // teardown unregistering it all end the tracking.
            pending.retain(|id, p| {
                let expected = p.kind.expected_state();
                let keep = state_of.get(id) == Some(&expected);
                if !keep {
                    log::info!(
                        "samurai injector: session {id} left {} — dropping pending {} instruction",
                        expected.as_str(),
                        p.kind.as_str(),
                    );
                }
                keep
            });

            let mut alerts: Vec<(u32, PendingKind, String, AuditEvent)> = Vec::new();
            for (id, p) in pending.iter_mut() {
                if !p.acked {
                    // ACK phase — P2.2 plumbing, shared by the corrective
                    // round (which re-arms as attempts=1 + awaiting_retry).
                    match timeout_verdict(
                        p.acked,
                        p.attempts,
                        p.awaiting_retry,
                        p.injected_at.map(|t| t.elapsed()),
                        p.waiting_since.elapsed(),
                        timeout,
                    ) {
                        TimeoutVerdict::Keep => {}
                        TimeoutVerdict::ArmRetry => {
                            log::warn!(
                                "samurai injector: session {id} did not ACK within {timeout:?} — retrying at next idle"
                            );
                            p.awaiting_retry = true;
                            // The wait for the retry's idle starts now
                            // (finding E age cap).
                            p.waiting_since = Instant::now();
                        }
                        TimeoutVerdict::AlertStuck => {
                            // Finding E: no injection was ever possible —
                            // either the trigger's Stop never came (wedged
                            // turn) or the armed retry's idle never came.
                            // One ack_timeout ALERT with the exact flavor.
                            let flag = if p.awaiting_retry {
                                "retry_never_injected"
                            } else {
                                "never_idled"
                            };
                            let mut details = json!({
                                "kind": "ack_timeout",
                                "attempts": p.attempts,
                                "instruction": p.kind.as_str(),
                            });
                            details[flag] = json!(true);
                            let event = AuditEvent::now(
                                p.epic.clone(),
                                AuditEventKind::Alert,
                                p.generation,
                                *id,
                                details,
                            );
                            alerts.push((*id, p.kind, p.project.clone(), event));
                        }
                        TimeoutVerdict::Alert => {
                            let event = if p.corrective {
                                // The corrective round dying unACKed is a
                                // validation failure, not a fresh ack_timeout.
                                let failure = format!(
                                    "{}; the corrective instruction was never acknowledged",
                                    p.failure.as_deref().unwrap_or("validation failed")
                                );
                                invalid_alert(p, *id, failure)
                            } else {
                                AuditEvent::now(
                                    p.epic.clone(),
                                    AuditEventKind::Alert,
                                    p.generation,
                                    *id,
                                    json!({
                                        "kind": "ack_timeout",
                                        "attempts": p.attempts,
                                        "instruction": p.kind.as_str(),
                                    }),
                                )
                            };
                            alerts.push((*id, p.kind, p.project.clone(), event));
                        }
                    }
                    continue;
                }
                // Written phase (ACKed): wait for the marker or time out.
                match written_verdict(
                    p.validating,
                    p.corrective,
                    p.acked_at.map(|t| t.elapsed()),
                    written_window,
                ) {
                    WrittenVerdict::Keep => {}
                    WrittenVerdict::Corrective => arm_corrective(
                        p,
                        format!(
                            "the <{WRITTEN_TAG}> marker did not arrive within {written_window:?} of the ACK"
                        ),
                    ),
                    WrittenVerdict::Alert => {
                        let failure = format!(
                            "{}; the <{WRITTEN_TAG}> marker did not arrive after the corrective instruction",
                            p.failure.as_deref().unwrap_or("validation failed")
                        );
                        let event = invalid_alert(p, *id, failure);
                        alerts.push((*id, p.kind, p.project.clone(), event));
                    }
                }
            }
            // Alerted sessions stop being tracked (the removal is what makes
            // the ALERT fire exactly once); they stay in their `*_REQUESTED`
            // state for human attention.
            for (id, _, _, _) in &alerts {
                pending.remove(id);
            }
            alerts
        };

        for (id, kind, project, event) in alerts {
            log::error!(
                "samurai injector: session {} {} protocol failed — ALERT ({}), leaving in {}",
                event.session_id,
                kind.as_str(),
                event.details["kind"],
                kind.expected_state().as_str(),
            );
            self.audit.append(&project, event);
            // Issue #60: a failed park is skipped — the parker's sweep must
            // move on to the next session instead of waiting forever.
            if kind == PendingKind::Park {
                if let Some(parker) = self.parker.get() {
                    parker.on_park_failed(id);
                }
            }
        }

        // Bonus fix (issue #54): a session whose most recent signal was a
        // Stop is idle RIGHT NOW and will never fire another idle signal on
        // its own — inject at tick time instead of waiting forever. Covers
        // the fresh trigger above (same tick, zero extra latency), an armed
        // retry, and a corrective armed between ticks.
        let idle: HashSet<u32> = self
            .idle_now
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let idle_pending: Vec<u32> = self
            .lock_pending()
            .keys()
            .filter(|id| idle.contains(id))
            .copied()
            .collect();
        for id in idle_pending {
            self.on_idle(id);
        }

        // Issue #55: the replicator's timeout pass (a staged successor that
        // never produced its SessionStarted) rides this same tick.
        if let Some(replicator) = &self.replicator {
            replicator.tick();
        }

        // Issue #60: the parker's sweep re-evaluation rides it too — the
        // edge-tolerance that keeps a sweep moving after races/failures.
        if let Some(parker) = self.parker.get() {
            parker.tick();
        }
    }

    /// Issue #60: the parker moved `snapshot`'s session into PARK_REQUESTED —
    /// start shepherding the park instruction through the ladder. Replaces a
    /// pending soft wind-down for the same session (the park supersedes it);
    /// a handoff entry can never be live here because the supervisor's
    /// mutual-exclusion guard rejects the PARK_REQUESTED transition first.
    pub fn begin_park(&self, snapshot: &SessionSnapshot) {
        let instruction =
            samurai_prompts::park_instruction(&snapshot.epic, snapshot.generation);
        self.lock_pending().insert(
            snapshot.session_id,
            PendingInstruction::new(PendingKind::Park, snapshot, instruction),
        );
        log::info!(
            "samurai injector: session {} (gen-{}) park instruction armed — awaiting idle",
            snapshot.session_id,
            snapshot.generation,
        );
        self.inject_if_idle(snapshot.session_id);
    }

    /// Issue #60: soft wind-down for a WORKING session. Returns `false`
    /// (nothing armed) when the session already has a pending instruction of
    /// any kind — it is already heading somewhere; the caller logs the skip.
    pub fn begin_soft_winddown(&self, snapshot: &SessionSnapshot) -> bool {
        {
            let mut pending = self.lock_pending();
            if pending.contains_key(&snapshot.session_id) {
                return false;
            }
            let instruction =
                samurai_prompts::soft_winddown_instruction(snapshot.generation);
            pending.insert(
                snapshot.session_id,
                PendingInstruction::new(PendingKind::SoftWinddown, snapshot, instruction),
            );
        }
        log::info!(
            "samurai injector: session {} (gen-{}) soft wind-down armed — awaiting idle",
            snapshot.session_id,
            snapshot.generation,
        );
        self.inject_if_idle(snapshot.session_id);
        true
    }

    /// Whether a pending instruction (any kind) is being shepherded for the
    /// session. The parker's eligibility/blocking decisions read this.
    pub fn has_pending(&self, session_id: u32) -> bool {
        self.lock_pending().contains_key(&session_id)
    }

    /// A session that is idle RIGHT NOW (its last signal was a Stop) never
    /// fires another idle signal on its own — entries armed outside the tick
    /// (issue #60's park/wind-down) inject immediately instead of waiting up
    /// to a full tick, same reasoning as the tick's idle_pending pass.
    fn inject_if_idle(&self, session_id: u32) {
        let idle = self
            .idle_now
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(&session_id);
        if idle {
            self.on_idle(session_id);
        }
    }

    /// Idle signal for one session: decide-and-record synchronously, then
    /// hand the actual PTY write to the blocking pool.
    fn on_idle(&self, session_id: u32) {
        if let Some(data) = self.arm_injection_on_idle(session_id) {
            // The injection submits a prompt — the session is working again.
            self.idle_now
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&session_id);
            self.spawn_write(session_id, data);
        }
    }

    /// Decision + bookkeeping for an idle signal, no I/O. Returns the exact
    /// bytes to write (instruction + `\r`) when an injection is due.
    fn arm_injection_on_idle(&self, session_id: u32) -> Option<String> {
        let state = self.session_state(session_id)?;
        let mut pending = self.lock_pending();
        let p = pending.get_mut(&session_id)?;
        if !should_inject_on_idle(
            state,
            p.kind.expected_state(),
            p.acked,
            p.attempts,
            p.awaiting_retry,
        ) {
            return None;
        }
        p.attempts += 1;
        p.injected_at = Some(Instant::now());
        p.awaiting_retry = false;
        log::info!(
            "samurai injector: session {session_id} idle — injecting {}{} instruction (attempt {})",
            if p.corrective { "corrective " } else { "" },
            p.kind.as_str(),
            p.attempts
        );
        Some(format!("{}\r", p.instruction))
    }

    /// Write the instruction into the session's PTY. `write_stdin` is fully
    /// blocking (std mutex + pipe write with no bounded completion time), so
    /// it runs on the blocking pool — same pattern as
    /// `commands::terminal::write_stdin`.
    fn spawn_write(&self, session_id: u32, data: String) {
        let pm = self.processes.clone();
        tauri::async_runtime::spawn(async move {
            match tokio::task::spawn_blocking(move || pm.write_stdin(session_id, &data)).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => log::warn!(
                    "samurai injector: writing instruction to session {session_id} failed: {e}"
                ),
                Err(e) => {
                    log::warn!("samurai injector: write task for session {session_id} failed: {e}")
                }
            }
        });
    }

    /// ACK scan for one assistant reply. Only the session's own expected
    /// value counts: a transcript replay (SessionStart re-reads from byte 0)
    /// can surface an old generation's marker, which must not ACK a new
    /// instruction.
    fn scan_ack(&self, session_id: u32, text: &str) {
        if !text.contains('<') {
            return; // cheap reject for the overwhelmingly common path
        }
        let Some(value) = ack_value(text) else {
            return;
        };
        let mut pending = self.lock_pending();
        let Some(p) = pending.get_mut(&session_id) else {
            log::warn!(
                "samurai injector: ACK marker from session {session_id} with no pending instruction — ignored"
            );
            return;
        };
        if p.acked {
            return;
        }
        // Round-scoped (finding C) AND kind-scoped (issue #60): the
        // corrective round expects a DISTINCT value, so a transcript replay
        // of round 1's ACK (claude --resume rewrites history into a new
        // transcript, read from byte 0) can never consume the corrective
        // round — and a replayed handoff ACK can never consume a park.
        let expected = expected_ack_value(p.kind, p.generation, p.corrective);
        if value == expected {
            log::info!(
                "samurai injector: session {session_id} ACKed {} (gen-{})",
                p.kind.as_str(),
                p.generation
            );
            // The soft wind-down has no written stage: the ACK IS the
            // completion — stop tracking, the session keeps WORKING.
            if p.kind == PendingKind::SoftWinddown {
                pending.remove(&session_id);
                return;
            }
            p.acked = true;
            p.acked_at = Some(Instant::now());
            p.awaiting_retry = false;
        } else {
            log::warn!(
                "samurai injector: session {session_id} ACK value {value:?} does not match expected {expected:?} — ignored"
            );
        }
    }

    /// Written-marker scan for one assistant reply (issue #54): after the
    /// ACK, the exact `<samurai-handoff-written>gen-N</samurai-handoff-written>`
    /// value starts the two-check validation. Same exact-value discipline as
    /// the ACK — a replayed old generation's marker must not validate a new
    /// handoff.
    fn scan_written(&self, session_id: u32, text: &str) {
        if !text.contains('<') {
            return;
        }
        let Some(value) = written_value(text) else {
            return;
        };
        // Phase 1, under the lock: match the marker and claim the validation.
        let (kind, epic, generation) = {
            let mut pending = self.lock_pending();
            let Some(p) = pending.get_mut(&session_id) else {
                log::warn!(
                    "samurai injector: written marker from session {session_id} with no pending instruction — ignored"
                );
                return;
            };
            if !p.acked {
                // Completion detection starts after the ACK (issue #54); a
                // marker without one is a replay or a protocol violation.
                // This also covers the soft wind-down, whose entry can never
                // be ACKed (the ACK removes it) and has no written stage.
                log::warn!(
                    "samurai injector: written marker from session {session_id} before its ACK — ignored"
                );
                return;
            }
            if p.validating {
                return; // a validation for this marker is already in flight
            }
            // Same per-round, per-kind discipline as the ACK (finding C).
            let Some(expected) = expected_written_value(p.kind, p.generation, p.corrective)
            else {
                log::warn!(
                    "samurai injector: written marker from session {session_id} for a {} instruction — ignored",
                    p.kind.as_str()
                );
                return;
            };
            if value != expected {
                log::warn!(
                    "samurai injector: session {session_id} written value {value:?} does not match expected {expected:?} — ignored"
                );
                return;
            }
            p.validating = true;
            (p.kind, p.epic.clone(), p.generation)
        };
        // Phase 2, no lock: resolve the working dir, then validate off-thread.
        // The park validates the SAME file — it doubles as park state.
        let relpath = samurai_prompts::handoff_file_relpath(&epic, generation);
        match (self.session_dirs)(session_id) {
            Some(dir) => {
                log::info!(
                    "samurai injector: session {session_id} reported {} written — validating {relpath} in {dir}",
                    kind.as_str()
                );
                self.spawn_validation(session_id, dir, relpath);
            }
            None => {
                log::warn!(
                    "samurai injector: session {session_id} has no recorded working directory — {} cannot be validated",
                    kind.as_str()
                );
                finish_validation(
                    &self.pending,
                    &self.supervisor,
                    &self.audit,
                    self.replicator.as_ref(),
                    self.parker.get(),
                    session_id,
                    Err("the session's working directory is unknown".to_string()),
                );
            }
        }
    }

    /// Run the two checks off the runtime: `git status` has no bounded
    /// completion time (repo size, cold FS caches), so it goes through
    /// `spawn_blocking` — same policy as [`spawn_write`](Self::spawn_write).
    fn spawn_validation(&self, session_id: u32, working_dir: String, relpath: String) {
        let pending = self.pending.clone();
        let supervisor = self.supervisor.clone();
        let audit = self.audit.clone();
        let replicator = self.replicator.clone();
        let parker = self.parker.get().cloned();
        tauri::async_runtime::spawn(async move {
            let outcome = tokio::task::spawn_blocking(move || {
                let dir = PathBuf::from(strip_extended_prefix(&working_dir));
                validate_handoff(&dir, &relpath)
            })
            .await
            .unwrap_or_else(|e| Err(format!("validation task failed: {e}")));
            finish_validation(
                &pending,
                &supervisor,
                &audit,
                replicator.as_ref(),
                parker.as_ref(),
                session_id,
                outcome,
            );
        });
    }

    /// Track the per-session "idle right now" flag from either tee.
    /// Idempotent, so the hook chain and the (deduped) bus applying the same
    /// event back-to-back is harmless.
    fn note_idle(&self, event: &ClaudeEvent) {
        if let Some((session_id, idle)) = idle_effect(event) {
            let mut set = self
                .idle_now
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if idle {
                set.insert(session_id);
            } else {
                set.remove(&session_id);
            }
        }
    }

    /// Teardown propagation (fresh-eyes finding H): the session's terminal
    /// was closed outside the samurai pipeline, so any pending instruction
    /// and the idle flag are stale — drop them. Teardown, not a state
    /// change: no event, no audit row (the tick's retain would prune the
    /// pending entry on its own within 30s once the supervisor entry is
    /// gone; this makes the removal immediate and covers the idle flag too).
    pub fn remove_session(&self, session_id: u32) {
        self.lock_pending().remove(&session_id);
        self.idle_now
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&session_id);
    }

    /// Current supervisor state of one session, `None` when unsupervised.
    fn session_state(&self, session_id: u32) -> Option<SupervisorState> {
        self.supervisor
            .list_sessions()
            .into_iter()
            .find(|s| s.session_id == session_id)
            .map(|s| s.state)
    }

    /// Recover from a poisoned lock rather than panicking — this runs on the
    /// event path (same policy as `SamuraiContextStore`).
    fn lock_pending(&self) -> std::sync::MutexGuard<'_, HashMap<u32, PendingInstruction>> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Test-only view of one pending entry: (attempts, acked, awaiting_retry).
    /// `pub(crate)`: the parker's sweep tests (issue #60) drive this ladder
    /// end-to-end from their own module.
    #[cfg(test)]
    pub(crate) fn pending_view(&self, session_id: u32) -> Option<(u8, bool, bool)> {
        self.lock_pending()
            .get(&session_id)
            .map(|p| (p.attempts, p.acked, p.awaiting_retry))
    }

    /// Test-only view of the #54 fields: (corrective, validating, failure).
    #[cfg(test)]
    fn pending_detail(&self, session_id: u32) -> Option<(bool, bool, Option<String>)> {
        self.lock_pending()
            .get(&session_id)
            .map(|p| (p.corrective, p.validating, p.failure.clone()))
    }

    /// Test-only copy of the currently armed instruction text.
    #[cfg(test)]
    fn pending_instruction(&self, session_id: u32) -> Option<String> {
        self.lock_pending()
            .get(&session_id)
            .map(|p| p.instruction.clone())
    }

    /// Test-only: age the latest injection so timeout paths run without
    /// real waiting. `pub(crate)` for the parker's sweep tests (issue #60).
    #[cfg(test)]
    pub(crate) fn backdate_injection(&self, session_id: u32, by: Duration) {
        let mut pending = self.lock_pending();
        let p = pending.get_mut(&session_id).expect("no pending entry");
        p.injected_at = p.injected_at.expect("nothing injected").checked_sub(by);
        assert!(p.injected_at.is_some(), "backdate underflowed Instant");
    }

    /// Test-only: age the ACK so written-window paths run without waiting.
    #[cfg(test)]
    fn backdate_ack(&self, session_id: u32, by: Duration) {
        let mut pending = self.lock_pending();
        let p = pending.get_mut(&session_id).expect("no pending entry");
        p.acked_at = p.acked_at.expect("not acked").checked_sub(by);
        assert!(p.acked_at.is_some(), "backdate underflowed Instant");
    }

    /// Test-only: age the waiting clock so the stuck-wait cap (finding E)
    /// runs without real waiting.
    #[cfg(test)]
    fn backdate_waiting(&self, session_id: u32, by: Duration) {
        let mut pending = self.lock_pending();
        let p = pending.get_mut(&session_id).expect("no pending entry");
        p.waiting_since = p
            .waiting_since
            .checked_sub(by)
            .expect("backdate underflowed Instant");
    }
}

/// Spawns the injection controller loop. Called once from app setup; runs
/// for the app's lifetime (same lifecycle as the watchdog).
pub fn spawn_injector(injector: Arc<SamuraiInjector>) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(TICK_INTERVAL);
        // After a laptop sleep, run one catch-up tick, not a burst.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            injector.tick();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::samurai_config::SamuraiConfig;
    use std::sync::RwLock;
    use tempfile::tempdir;

    use SupervisorState::*;

    const TIMEOUT: Duration = Duration::from_secs(180);
    const OVER: Option<Duration> = Some(Duration::from_secs(181));
    const UNDER: Option<Duration> = Some(Duration::from_secs(30));
    /// The written window at the default config (180s * 3).
    const WINDOW: Duration = Duration::from_secs(540);
    const OVER_WINDOW: Option<Duration> = Some(Duration::from_secs(541));
    const UNDER_WINDOW: Option<Duration> = Some(Duration::from_secs(300));
    /// A waiting age safely inside the stuck cap (180s * 3 = 540s).
    const WAIT_OK: Duration = Duration::from_secs(60);
    /// A waiting age past the stuck cap (finding E).
    const WAIT_OVER: Duration = Duration::from_secs(541);

    // --- pure decision tables ---

    #[test]
    fn test_trigger_only_for_working_at_or_past_threshold() {
        // (state, percent, expected) — threshold 45.0 throughout.
        let table = [
            (Working, Some(45.0), true), // at threshold: >= fires
            (Working, Some(45.1), true),
            (Working, Some(90.0), true),
            (Working, Some(44.9), false),
            (Working, None, false), // no reading yet: missing evidence
            (HandoffRequested, Some(90.0), false), // already requested
            (HandoffWritten, Some(90.0), false),
            (ParkRequested, Some(90.0), false),
            (Killed, Some(90.0), false),
            (Parked, Some(90.0), false),
            (Dead, Some(90.0), false),
        ];
        for (state, percent, expected) in table {
            assert_eq!(
                should_request_handoff(state, percent, 45.0),
                expected,
                "{state:?} at {percent:?}"
            );
        }
    }

    #[test]
    fn test_idle_signal_is_only_the_stop_hook() {
        let stop = ClaudeEvent::SessionEnded {
            session_id: 7,
            reason: "stop".into(),
            timestamp: "t".into(),
        };
        assert_eq!(idle_session_id(&stop), Some(7));

        // The SessionEnd hook emits the same variant with another reason.
        let ended = ClaudeEvent::SessionEnded {
            session_id: 7,
            reason: "exit".into(),
            timestamp: "t".into(),
        };
        assert_eq!(idle_session_id(&ended), None);

        let other = ClaudeEvent::UserMessage {
            session_id: 7,
            uuid: "u".into(),
            text: "hi".into(),
            timestamp: "t".into(),
        };
        assert_eq!(idle_session_id(&other), None);
    }

    #[test]
    fn test_idle_effect_table() {
        // (event, expected) — the bonus-fix idle flag transitions.
        let table: [(ClaudeEvent, Option<(u32, bool)>); 6] = [
            (
                // The Stop hook: idle right now.
                ClaudeEvent::SessionEnded {
                    session_id: 1,
                    reason: "stop".into(),
                    timestamp: "t".into(),
                },
                Some((1, true)),
            ),
            (
                // Any other SessionEnded: the session is gone, never idle.
                ClaudeEvent::SessionEnded {
                    session_id: 2,
                    reason: "exit".into(),
                    timestamp: "t".into(),
                },
                Some((2, false)),
            ),
            (
                // A fresh session: turn state unknown, treat as active.
                ClaudeEvent::SessionStarted {
                    session_id: 3,
                    claude_session_uuid: "u".into(),
                    transcript_path: "p".into(),
                    timestamp: "t".into(),
                },
                Some((3, false)),
            ),
            (
                // A tool call: the agent is actively working.
                ClaudeEvent::ToolUseStarted {
                    session_id: 4,
                    tool_name: "Bash".into(),
                    tool_use_id: "tu".into(),
                    input_summary: "…".into(),
                    timestamp: "t".into(),
                },
                Some((4, false)),
            ),
            (
                // A submitted prompt: the turn restarted.
                ClaudeEvent::UserMessage {
                    session_id: 5,
                    uuid: "u".into(),
                    text: "go".into(),
                    timestamp: "t".into(),
                },
                Some((5, false)),
            ),
            (
                // AssistantMessage deliberately says nothing: it can arrive
                // AFTER its own turn's Stop (transcript lag) and must not
                // wipe the idle flag — see idle_effect's doc.
                ClaudeEvent::AssistantMessage {
                    session_id: 6,
                    uuid: "u".into(),
                    text: "done".into(),
                    model: "m".into(),
                    token_usage: None,
                    timestamp: "t".into(),
                },
                None,
            ),
        ];
        for (event, expected) in table {
            assert_eq!(idle_effect(&event), expected, "{event:?}");
        }
    }

    #[test]
    fn test_inject_on_idle_sequencing() {
        // (state, expected_state, acked, attempts, awaiting_retry, expected)
        let table = [
            (HandoffRequested, HandoffRequested, false, 0, false, true), // first idle → attempt 1
            (HandoffRequested, HandoffRequested, false, 1, true, true), // timed out → retry at idle
            (HandoffRequested, HandoffRequested, false, 1, false, false), // reply w/o marker: hold for timeout
            (HandoffRequested, HandoffRequested, false, 2, false, false), // both attempts spent
            (HandoffRequested, HandoffRequested, false, 2, true, false), // never a third attempt
            (HandoffRequested, HandoffRequested, true, 0, false, false), // ACKed before injection
            (HandoffRequested, HandoffRequested, true, 1, false, false), // ACKed: done here
            (Working, HandoffRequested, false, 0, false, false),         // not in handoff
            (HandoffWritten, HandoffRequested, false, 0, false, false),
            (Dead, HandoffRequested, false, 1, true, false),
            // Issue #60: the park ladder lives in PARK_REQUESTED …
            (ParkRequested, ParkRequested, false, 0, false, true),
            (ParkRequested, ParkRequested, false, 1, true, true),
            (ParkRequested, ParkRequested, true, 1, false, false),
            (Working, ParkRequested, false, 0, false, false), // left the state
            // … and the soft wind-down in WORKING.
            (Working, Working, false, 0, false, true),
            (Working, Working, false, 1, true, true),
            (ParkRequested, Working, false, 0, false, false), // superseded
        ];
        for (state, expected_state, acked, attempts, awaiting_retry, expected) in table {
            assert_eq!(
                should_inject_on_idle(state, expected_state, acked, attempts, awaiting_retry),
                expected,
                "{state:?}/{expected_state:?} acked={acked} attempts={attempts} awaiting_retry={awaiting_retry}"
            );
        }
    }

    #[test]
    fn test_timeout_verdict_sequencing() {
        use TimeoutVerdict::*;
        // (acked, attempts, awaiting_retry, elapsed, waiting, expected)
        let table = [
            (false, 0, false, None, WAIT_OK, Keep), // not injected: waiting, inside the cap
            (false, 1, false, UNDER, WAIT_OK, Keep), // inside the window
            (false, 1, false, OVER, WAIT_OK, ArmRetry), // attempt 1 expired → arm retry
            (false, 1, true, OVER, WAIT_OK, Keep),  // retry armed: wait for idle
            (false, 2, false, UNDER, WAIT_OK, Keep), // attempt 2 still inside the window
            (false, 2, false, OVER, WAIT_OK, Alert), // attempt 2 expired → ALERT once
            (true, 1, false, OVER, WAIT_OK, Keep),  // ACKed: the ACK clock stops
            (true, 2, false, OVER, WAIT_OK, Keep),
            // Finding E: the waiting states are age-capped, never forever.
            (false, 0, false, None, WAIT_OVER, AlertStuck), // Stop never came
            (false, 1, true, OVER, WAIT_OVER, AlertStuck),  // idle never came
            (false, 1, true, UNDER, WAIT_OVER, AlertStuck), // cap ignores the injection clock
            // The cap only governs waiting states — an injected, non-retry
            // entry keeps the normal ACK clock even when it is old.
            (false, 1, false, UNDER, WAIT_OVER, Keep),
            (false, 2, false, OVER, WAIT_OVER, Alert),
            // And an ACKed entry is out of scope regardless of age.
            (true, 1, true, OVER, WAIT_OVER, Keep),
        ];
        for (acked, attempts, awaiting_retry, elapsed, waiting, expected) in table {
            assert_eq!(
                timeout_verdict(acked, attempts, awaiting_retry, elapsed, waiting, TIMEOUT),
                expected,
                "acked={acked} attempts={attempts} awaiting_retry={awaiting_retry} elapsed={elapsed:?} waiting={waiting:?}"
            );
        }
    }

    #[test]
    fn test_timeout_boundary_is_strict() {
        // "no ACK within N seconds": exactly N is still within.
        assert_eq!(
            timeout_verdict(false, 1, false, Some(TIMEOUT), WAIT_OK, TIMEOUT),
            TimeoutVerdict::Keep
        );
        assert_eq!(
            timeout_verdict(
                false,
                1,
                false,
                Some(TIMEOUT + Duration::from_millis(1)),
                WAIT_OK,
                TIMEOUT
            ),
            TimeoutVerdict::ArmRetry
        );
        // The stuck cap is equally strict: exactly timeout*3 is still within.
        assert_eq!(
            timeout_verdict(false, 0, false, None, TIMEOUT * 3, TIMEOUT),
            TimeoutVerdict::Keep
        );
        assert_eq!(
            timeout_verdict(
                false,
                0,
                false,
                None,
                TIMEOUT * 3 + Duration::from_millis(1),
                TIMEOUT
            ),
            TimeoutVerdict::AlertStuck
        );
    }

    #[test]
    fn test_written_verdict_sequencing() {
        use WrittenVerdict::*;
        // (validating, corrective, elapsed_since_ack, expected)
        let table = [
            (false, false, None, Keep),              // defensive: no ACK clock
            (false, false, UNDER_WINDOW, Keep),      // inside the generous window
            (false, false, OVER_WINDOW, Corrective), // round 1 expired → corrective
            (false, true, OVER_WINDOW, Alert),       // corrective expired → ALERT
            (true, false, OVER_WINDOW, Keep),        // validation owns the entry
            (true, true, OVER_WINDOW, Keep),
        ];
        for (validating, corrective, elapsed, expected) in table {
            assert_eq!(
                written_verdict(validating, corrective, elapsed, WINDOW),
                expected,
                "validating={validating} corrective={corrective} elapsed={elapsed:?}"
            );
        }
        // Strict boundary, same discipline as the ACK timeout.
        assert_eq!(written_verdict(false, false, Some(WINDOW), WINDOW), Keep);
        assert_eq!(
            written_verdict(
                false,
                false,
                Some(WINDOW + Duration::from_millis(1)),
                WINDOW
            ),
            Corrective
        );
    }

    #[test]
    fn test_marker_value_extraction() {
        assert_eq!(
            ack_value("done. <samurai-ack>handoff gen-3</samurai-ack> standing by"),
            Some("handoff gen-3".to_string())
        );
        // Inner whitespace is trimmed, same as transcript_parser::tag_value.
        assert_eq!(
            ack_value("<samurai-ack>\thandoff gen-3 </samurai-ack>"),
            Some("handoff gen-3".to_string())
        );
        assert_eq!(ack_value("no marker here"), None);
        assert_eq!(ack_value("<samurai-ack>unclosed"), None);
        assert_eq!(ack_value("</samurai-ack>only a close tag"), None);

        // The written marker follows the same discipline.
        assert_eq!(
            written_value("all done <samurai-handoff-written>gen-4</samurai-handoff-written>"),
            Some("gen-4".to_string())
        );
        assert_eq!(written_value("<samurai-handoff-written>unclosed"), None);
        // The tags do not cross-match.
        assert_eq!(
            written_value("<samurai-ack>handoff gen-3</samurai-ack>"),
            None
        );
        assert_eq!(
            ack_value("<samurai-handoff-written>gen-4</samurai-handoff-written>"),
            None
        );
    }

    #[test]
    fn test_porcelain_line_classification() {
        // (line, blocks)
        let table = [
            ("?? notes.txt", false),                   // untracked: fine
            ("?? .maestro/", false),                   // the handoff dir itself
            ("!! target/", false),                     // ignored: fine
            (" M src/lib.rs", true),                   // modified tracked file
            ("M  src/lib.rs", true),                   // staged modification
            ("MM src/lib.rs", true),                   // staged + modified again
            ("A  new.rs", true),                       // staged addition
            ("D  gone.rs", true),                      // staged deletion
            (" D gone.rs", true),                      // unstaged deletion
            ("R  old.rs -> new.rs", true),             // rename
            ("UU conflicted.rs", true),                // merge conflict
            (" M .maestro/handoffs/e-gen1.md", false), // .maestro/: acceptable
            ("A  .maestro/state.json", false),
            ("", false), // blank / malformed lines never block
            ("M", false),
        ];
        for (line, expected) in table {
            assert_eq!(porcelain_line_blocks(line), expected, "line {line:?}");
        }
    }

    #[test]
    fn test_strip_extended_prefix() {
        assert_eq!(strip_extended_prefix(r"\\?\C:\git\proj"), r"C:\git\proj");
        assert_eq!(strip_extended_prefix(r"C:\git\proj"), r"C:\git\proj");
        assert_eq!(strip_extended_prefix("/home/x"), "/home/x");
    }

    // --- validation against real git repos in temp dirs ---

    /// `git init` + one committed file, returning the repo dir. Identity is
    /// set repo-locally so the test never touches the user's config.
    fn init_repo(dir: &Path) {
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .hide_console_window()
                .output()
                .expect("git must be runnable in tests");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("tracked.txt"), "v1\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["commit", "-q", "-m", "init"]);
    }

    fn write_handoff_file(dir: &Path, epic: &str, generation: u32) {
        let rel = samurai_prompts::handoff_file_relpath(epic, generation);
        let path = dir.join(&rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "# Handoff\n").unwrap();
    }

    #[test]
    fn test_validate_handoff_file_and_wip_matrix() {
        let dir = tempdir().unwrap();
        let repo = dir.path();
        init_repo(repo);
        let rel = samurai_prompts::handoff_file_relpath("#9", 1);

        // File absent, tree clean → the file check fails first.
        let err = validate_handoff(repo, &rel).unwrap_err();
        assert!(err.contains("missing"), "unexpected: {err}");
        assert!(err.contains(&rel), "failure must name the path: {err}");

        // File present (untracked .maestro/), tree clean → valid.
        write_handoff_file(repo, "#9", 1);
        assert_eq!(validate_handoff(repo, &rel), Ok(()));

        // Extra untracked files stay acceptable.
        std::fs::write(repo.join("scratch.txt"), "tmp\n").unwrap();
        assert_eq!(validate_handoff(repo, &rel), Ok(()));

        // A modified tracked file → WIP not committed.
        std::fs::write(repo.join("tracked.txt"), "v2\n").unwrap();
        let err = validate_handoff(repo, &rel).unwrap_err();
        assert!(err.contains("WIP is not committed"), "unexpected: {err}");
        assert!(err.contains("tracked.txt"), "failure names the file: {err}");

        // File present but absent again (deleted) → back to the file check.
        std::fs::remove_file(repo.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))).unwrap();
        let err = validate_handoff(repo, &rel).unwrap_err();
        assert!(err.contains("missing"), "unexpected: {err}");
    }

    #[test]
    fn test_validate_handoff_outside_a_git_repo_fails() {
        let dir = tempdir().unwrap();
        write_handoff_file(dir.path(), "#9", 1);
        let rel = samurai_prompts::handoff_file_relpath("#9", 1);
        let err = validate_handoff(dir.path(), &rel).unwrap_err();
        assert!(err.contains("git status failed"), "unexpected: {err}");
    }

    // --- controller against a real supervisor + audit log ---

    /// An injector wired to a real supervisor and audit log in a temp dir.
    /// The ProcessManager holds no sessions — tests drive the decision paths
    /// (`tick` / `arm_injection_on_idle` / `observe`) and a PTY write for an
    /// unknown session is a logged no-op. The dir resolver serves
    /// `dirs`: session id → working dir (insert a tempdir repo per test).
    type DirMap = Arc<Mutex<HashMap<u32, String>>>;

    fn harness(
        dir: &std::path::Path,
    ) -> (
        SamuraiInjector,
        AuditLog,
        Arc<Supervisor>,
        Arc<SamuraiContextStore>,
        DirMap,
    ) {
        let (audit, task) = AuditLog::new(dir.to_path_buf(), None);
        tokio::spawn(task);
        let supervisor = Arc::new(Supervisor::new(audit.clone(), None));
        let context = Arc::new(SamuraiContextStore::new());
        let config: SharedSamuraiConfig = Arc::new(RwLock::new(SamuraiConfig::default()));
        let dirs: DirMap = Arc::new(Mutex::new(HashMap::new()));
        let dirs_for_resolver = dirs.clone();
        let resolver: SessionDirResolver =
            Arc::new(move |session_id| dirs_for_resolver.lock().unwrap().get(&session_id).cloned());
        let injector = SamuraiInjector::new(
            supervisor.clone(),
            context.clone(),
            config,
            ProcessManager::new(),
            audit.clone(),
            resolver,
            // The injector alone: the P2.3 → P2.4 chain has its own
            // integration test in `samurai_replicator`.
            None,
        );
        (injector, audit, supervisor, context, dirs)
    }

    fn context_event(session_id: u32, percent: f64) -> ClaudeEvent {
        ClaudeEvent::ContextUsageUpdate {
            session_id,
            model: "claude-opus-4".to_string(),
            context_tokens: 90_000,
            context_window: 200_000,
            percent,
            timestamp: "2026-08-06T00:00:00Z".to_string(),
        }
    }

    fn assistant_message(session_id: u32, text: &str) -> ClaudeEvent {
        ClaudeEvent::AssistantMessage {
            session_id,
            uuid: format!("uuid-{session_id}-{}", text.len()),
            text: text.to_string(),
            model: "claude-opus-4".to_string(),
            token_usage: None,
            timestamp: "t".to_string(),
        }
    }

    fn stop_event(session_id: u32) -> ClaudeEvent {
        ClaudeEvent::SessionEnded {
            session_id,
            reason: "stop".into(),
            timestamp: "t".into(),
        }
    }

    /// Polls until `cond` holds or ~2s pass — validation runs on a separate
    /// (tauri) runtime, so tests wait for its completion signal.
    async fn wait_until(mut cond: impl FnMut() -> bool) {
        for _ in 0..200 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not reached within 2s");
    }

    #[tokio::test]
    async fn test_trigger_tick_requests_handoff_and_tracks_instruction() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-trigger";
        supervisor
            .register_session(1, project.into(), "epic-1".into(), 2)
            .unwrap();
        context.observe(&context_event(1, 50.0));

        injector.tick();

        assert_eq!(injector.session_state(1), Some(HandoffRequested));
        assert_eq!(injector.pending_view(1), Some((0, false, false)));

        // The transition wrote the HANDOFF(phase=requested) audit row itself.
        let rows = audit.read(project, None, None).await.unwrap().events;
        let last = rows.last().unwrap();
        assert_eq!(last.event, AuditEventKind::Handoff);
        assert_eq!(last.details["phase"], "requested");

        // A second tick must not re-trigger (state is no longer WORKING) nor
        // reset the pending entry.
        injector.tick();
        assert_eq!(injector.pending_view(1), Some((0, false, false)));
        let rows = audit.read(project, None, None).await.unwrap().events;
        assert_eq!(
            rows.iter()
                .filter(|r| r.event == AuditEventKind::Handoff)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn test_below_threshold_or_unknown_percent_never_triggers() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, _dirs) = harness(dir.path());
        supervisor
            .register_session(1, "C:/git/proj-inj-low".into(), "epic".into(), 1)
            .unwrap();
        // Session 2 has no context reading at all.
        supervisor
            .register_session(2, "C:/git/proj-inj-low".into(), "epic".into(), 1)
            .unwrap();
        context.observe(&context_event(1, 44.9));

        injector.tick();

        assert_eq!(injector.session_state(1), Some(Working));
        assert_eq!(injector.session_state(2), Some(Working));
        assert!(injector.pending_view(1).is_none());
        assert!(injector.pending_view(2).is_none());
    }

    #[tokio::test]
    async fn test_handoff_trigger_uses_run_config_threshold_override() {
        // Review F4: an epic whose run config carries a `thresholds` block
        // triggers at ITS handoff_context_pct; epics without one keep the
        // global value. Park thresholds are untouched (they stay global).
        use crate::core::samurai_config::SamuraiConfig as Cfg;
        use crate::core::samurai_run_config::{RunConfigStore, SamuraiRunConfig};

        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-override";
        let store = Arc::new(RunConfigStore::new(dir.path().join("runs")));
        // epic-hi: override RAISES the trigger to 80% (global default 45%).
        let mut hi = SamuraiRunConfig::new(project, "epic-hi", "wt-hi");
        hi.thresholds = Some(Cfg {
            handoff_context_pct: 80.0,
            ..Cfg::default()
        });
        store.save(&hi).unwrap();
        // epic-none: config WITHOUT thresholds → global applies.
        store
            .save(&SamuraiRunConfig::new(project, "epic-none", "wt-none"))
            .unwrap();
        injector.set_run_configs(store);

        supervisor
            .register_session(1, project.into(), "epic-hi".into(), 1)
            .unwrap();
        supervisor
            .register_session(2, project.into(), "epic-none".into(), 1)
            .unwrap();
        supervisor
            .register_session(3, project.into(), "epic-noconfig".into(), 1)
            .unwrap();
        for id in [1, 2, 3] {
            context.observe(&context_event(id, 50.0));
        }

        injector.tick();

        // 50% is under the overridden 80% but over the global 45%.
        assert_eq!(injector.session_state(1), Some(Working), "override holds");
        assert_eq!(injector.session_state(2), Some(HandoffRequested));
        assert_eq!(injector.session_state(3), Some(HandoffRequested));

        // And an override can LOWER the trigger below the global too.
        hi.thresholds = Some(Cfg {
            handoff_context_pct: 40.0,
            ..Cfg::default()
        });
        injector.run_configs.get().unwrap().save(&hi).unwrap();
        injector.tick();
        assert_eq!(injector.session_state(1), Some(HandoffRequested));
    }

    #[tokio::test]
    async fn test_idle_injects_once_and_holds_until_timeout() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, _dirs) = harness(dir.path());
        supervisor
            .register_session(1, "C:/git/proj-inj-idle".into(), "epic".into(), 3)
            .unwrap();
        context.observe(&context_event(1, 50.0));
        injector.tick();

        // First idle → attempt 1, instruction + \r, single pasteable block.
        let data = injector.arm_injection_on_idle(1).expect("must inject");
        assert!(data.ends_with('\r'));
        assert_eq!(data.matches('\r').count(), 1, "exactly the final CR");
        assert!(!data.contains('\n'));
        assert!(data.contains("<samurai-ack>handoff gen-3</samurai-ack>"));
        // Issue #54: the full brief rides along — file path + written marker.
        assert!(data.contains(".maestro/handoffs/epic-gen3.md"));
        assert!(data.contains("<samurai-handoff-written>gen-3</samurai-handoff-written>"));
        assert_eq!(injector.pending_view(1), Some((1, false, false)));

        // Another idle before the timeout (agent replied without the marker):
        // the retry is not armed, so nothing is injected.
        assert!(injector.arm_injection_on_idle(1).is_none());
        assert_eq!(injector.pending_view(1), Some((1, false, false)));
    }

    #[tokio::test]
    async fn test_idle_without_pending_or_before_trigger_does_nothing() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, _context, _dirs) = harness(dir.path());
        // Unsupervised session: nothing happens.
        assert!(injector.arm_injection_on_idle(9).is_none());
        // Supervised but WORKING (no trigger yet): nothing happens.
        supervisor
            .register_session(1, "C:/git/proj-inj-none".into(), "epic".into(), 1)
            .unwrap();
        assert!(injector.arm_injection_on_idle(1).is_none());
    }

    #[tokio::test]
    async fn test_ack_resolves_instruction_and_stops_injection() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, _dirs) = harness(dir.path());
        supervisor
            .register_session(1, "C:/git/proj-inj-ack".into(), "epic".into(), 4)
            .unwrap();
        context.observe(&context_event(1, 50.0));
        injector.tick();
        injector.arm_injection_on_idle(1).expect("attempt 1");

        // Wrong generation (e.g. a replayed old transcript line): ignored.
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>handoff gen-3</samurai-ack>",
        ));
        assert_eq!(injector.pending_view(1), Some((1, false, false)));

        // The real ACK: acked, state stays HANDOFF_REQUESTED (the written
        // marker advances it), and no further idle ever injects again.
        injector.observe(&assistant_message(
            1,
            "Understood. <samurai-ack>handoff gen-4</samurai-ack>",
        ));
        assert_eq!(injector.pending_view(1), Some((1, true, false)));
        assert_eq!(injector.session_state(1), Some(HandoffRequested));
        assert!(injector.arm_injection_on_idle(1).is_none());

        // And the timeout pass leaves an ACKed instruction alone (the
        // written window is far larger than the ACK timeout).
        injector.backdate_injection(1, TIMEOUT + Duration::from_secs(5));
        injector.tick();
        assert_eq!(injector.pending_view(1), Some((1, true, false)));
    }

    #[tokio::test]
    async fn test_timeout_retry_then_alert_once_and_stay_for_human() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-timeout";
        supervisor
            .register_session(1, project.into(), "epic-t".into(), 5)
            .unwrap();
        context.observe(&context_event(1, 50.0));
        injector.tick();

        // Attempt 1 times out → the tick arms the retry.
        injector.arm_injection_on_idle(1).expect("attempt 1");
        injector.backdate_injection(1, TIMEOUT + Duration::from_secs(1));
        injector.tick();
        assert_eq!(injector.pending_view(1), Some((1, false, true)));

        // Next idle → attempt 2; it times out too → single ALERT, untracked.
        injector.arm_injection_on_idle(1).expect("attempt 2");
        assert_eq!(injector.pending_view(1), Some((2, false, false)));
        injector.backdate_injection(1, TIMEOUT + Duration::from_secs(1));
        injector.tick();

        assert!(injector.pending_view(1).is_none(), "tracking stopped");
        assert_eq!(
            injector.session_state(1),
            Some(HandoffRequested),
            "session stays in HANDOFF_REQUESTED for human attention"
        );
        assert!(
            injector.arm_injection_on_idle(1).is_none(),
            "no third attempt ever"
        );

        let rows = audit.read(project, None, None).await.unwrap().events;
        let acks: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Alert && r.details["kind"] == "ack_timeout")
            .collect();
        assert_eq!(acks.len(), 1, "the ALERT fires exactly once");
        assert_eq!(acks[0].details["attempts"], 2);
        assert_eq!(acks[0].session_id, 1);
        assert_eq!(acks[0].generation, 5);

        // Further ticks stay quiet.
        injector.tick();
        let rows = audit.read(project, None, None).await.unwrap().events;
        assert_eq!(
            rows.iter()
                .filter(|r| r.details["kind"] == "ack_timeout")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn test_pending_dropped_when_session_leaves_handoff_requested() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, _dirs) = harness(dir.path());
        supervisor
            .register_session(1, "C:/git/proj-inj-dead".into(), "epic".into(), 1)
            .unwrap();
        context.observe(&context_event(1, 50.0));
        injector.tick();
        assert!(injector.pending_view(1).is_some());

        // The watchdog declares the session DEAD mid-handoff: the next tick
        // drops the instruction, and an idle for it injects nothing.
        supervisor.transition(1, Dead).unwrap();
        injector.tick();
        assert!(injector.pending_view(1).is_none());
        assert!(injector.arm_injection_on_idle(1).is_none());
    }

    #[tokio::test]
    async fn test_observe_ignores_ack_with_no_pending_instruction() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, _context, _dirs) = harness(dir.path());
        supervisor
            .register_session(1, "C:/git/proj-inj-stray".into(), "epic".into(), 1)
            .unwrap();
        // A stray marker (session still WORKING) must not create state.
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>handoff gen-1</samurai-ack>",
        ));
        assert!(injector.pending_view(1).is_none());
        assert_eq!(injector.session_state(1), Some(Working));
    }

    // --- issue #54: written marker → validation → HANDOFF_WRITTEN ---

    /// Drives session 1 (generation `generation`) through trigger, idle
    /// injection and ACK, ready for the written marker.
    fn drive_to_acked(
        injector: &SamuraiInjector,
        supervisor: &Supervisor,
        context: &SamuraiContextStore,
        project: &str,
        generation: u32,
    ) {
        supervisor
            .register_session(1, project.into(), "epic-9".into(), generation)
            .unwrap();
        context.observe(&context_event(1, 50.0));
        injector.tick();
        injector.arm_injection_on_idle(1).expect("attempt 1");
        injector.observe(&assistant_message(
            1,
            &format!("<samurai-ack>handoff gen-{generation}</samurai-ack>"),
        ));
    }

    #[tokio::test]
    async fn test_written_marker_with_valid_handoff_reaches_handoff_written() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, context, dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-valid";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        write_handoff_file(repo.path(), "epic-9", 2);
        dirs.lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        drive_to_acked(&injector, &supervisor, &context, project, 2);

        // Wrong-generation written marker: ignored, exact-value discipline.
        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-1</samurai-handoff-written>",
        ));
        assert_eq!(injector.pending_detail(1), Some((false, false, None)));

        // The real marker → async validation → both checks pass →
        // HANDOFF_WRITTEN, entry completed.
        injector.observe(&assistant_message(
            1,
            "Handoff complete. <samurai-handoff-written>gen-2</samurai-handoff-written>",
        ));
        wait_until(|| injector.session_state(1) == Some(HandoffWritten)).await;
        wait_until(|| injector.pending_view(1).is_none()).await;

        // The transition wrote the HANDOFF(phase=written) row; no ALERT.
        // The state flips before the row reaches the audit writer (separate
        // runtime), so poll the log rather than read once.
        let mut rows = Vec::new();
        for _ in 0..200 {
            rows = audit.read(project, None, None).await.unwrap().events;
            if rows
                .iter()
                .any(|r| r.event == AuditEventKind::Handoff && r.details["phase"] == "written")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(rows
            .iter()
            .any(|r| r.event == AuditEventKind::Handoff && r.details["phase"] == "written"));
        assert!(!rows.iter().any(|r| r.event == AuditEventKind::Alert));
    }

    #[tokio::test]
    async fn test_written_marker_before_ack_is_ignored() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, _dirs) = harness(dir.path());
        supervisor
            .register_session(1, "C:/git/proj-inj-early".into(), "epic-9".into(), 2)
            .unwrap();
        context.observe(&context_event(1, 50.0));
        injector.tick();
        injector.arm_injection_on_idle(1).expect("attempt 1");

        // Marker without an ACK: completion detection starts after the ACK.
        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-2</samurai-handoff-written>",
        ));
        assert_eq!(injector.pending_detail(1), Some((false, false, None)));
        assert_eq!(injector.session_state(1), Some(HandoffRequested));
    }

    #[tokio::test]
    async fn test_invalid_handoff_arms_corrective_then_alerts() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, context, dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-invalid";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        // Handoff file present but WIP left uncommitted → check 2 fails.
        write_handoff_file(repo.path(), "epic-9", 2);
        std::fs::write(repo.path().join("tracked.txt"), "dirty\n").unwrap();
        dirs.lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        drive_to_acked(&injector, &supervisor, &context, project, 2);

        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-2</samurai-handoff-written>",
        ));

        // Validation fails → the ONE corrective is armed on the retry
        // plumbing (attempts=1 + awaiting_retry) with the failure recorded.
        wait_until(|| matches!(injector.pending_detail(1), Some((true, false, Some(_))))).await;
        assert_eq!(injector.pending_view(1), Some((1, false, true)));
        let (_, _, failure) = injector.pending_detail(1).unwrap();
        assert!(failure.unwrap().contains("WIP is not committed"));

        // Next idle injects the corrective: names the failure, demands the
        // ACK + written cycle with ROUND-SCOPED retry values (finding C).
        let data = injector.arm_injection_on_idle(1).expect("corrective");
        assert!(data.contains("Handoff INVALID"));
        assert!(data.contains("WIP is not committed"));
        assert!(data.contains("<samurai-ack>handoff gen-2 retry</samurai-ack>"));
        assert!(data.contains("<samurai-handoff-written>gen-2 retry</samurai-handoff-written>"));
        assert!(!data[..data.len() - 1].contains('\r') && !data.contains('\n'));

        // A replay of ROUND 1's markers (claude --resume rewrites history
        // into a new transcript, read from byte 0) must not touch the
        // corrective round (finding C).
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>handoff gen-2</samurai-ack>",
        ));
        assert_eq!(injector.pending_view(1), Some((2, false, false)));
        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-2</samurai-handoff-written>",
        ));
        assert_eq!(
            injector.pending_detail(1).map(|(_, validating, _)| validating),
            Some(false),
            "a replayed round-1 written marker must not start validation"
        );

        // The corrective round's ACK + written cycle still fails (repo is
        // still dirty) → single handoff_invalid ALERT, tracking stops, the
        // session stays in HANDOFF_REQUESTED for a human.
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>handoff gen-2 retry</samurai-ack>",
        ));
        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-2 retry</samurai-handoff-written>",
        ));
        wait_until(|| injector.pending_view(1).is_none()).await;
        assert_eq!(injector.session_state(1), Some(HandoffRequested));

        // The entry is removed just before the append reaches the audit
        // writer (different runtime), so poll the log rather than read once.
        let mut alerts: Vec<AuditEvent> = Vec::new();
        for _ in 0..200 {
            let rows = audit.read(project, None, None).await.unwrap().events;
            alerts = rows
                .into_iter()
                .filter(|r| {
                    r.event == AuditEventKind::Alert && r.details["kind"] == "handoff_invalid"
                })
                .collect();
            if !alerts.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(alerts.len(), 1, "the ALERT fires exactly once");
        assert!(alerts[0].details["failure"]
            .as_str()
            .unwrap()
            .contains("WIP is not committed"));
        assert_eq!(alerts[0].generation, 2);
        assert_eq!(alerts[0].session_id, 1);
    }

    #[tokio::test]
    async fn test_corrective_round_can_still_succeed() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, dirs) = harness(dir.path());
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        // First round: file missing entirely.
        dirs.lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        drive_to_acked(&injector, &supervisor, &context, "C:/git/proj-inj-fix", 2);
        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-2</samurai-handoff-written>",
        ));
        wait_until(|| matches!(injector.pending_detail(1), Some((true, _, _)))).await;
        injector.arm_injection_on_idle(1).expect("corrective");

        // The orchestrator fixes it: writes the file, re-ACKs with the
        // round-scoped retry values (finding C), re-reports.
        write_handoff_file(repo.path(), "epic-9", 2);
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>handoff gen-2 retry</samurai-ack>",
        ));
        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-2 retry</samurai-handoff-written>",
        ));
        wait_until(|| injector.session_state(1) == Some(HandoffWritten)).await;
        wait_until(|| injector.pending_view(1).is_none()).await;
    }

    #[tokio::test]
    async fn test_written_window_timeout_arms_corrective_then_alerts() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-wtimeout";
        drive_to_acked(&injector, &supervisor, &context, project, 5);

        // ACKed but the written marker never arrives: past timeout*3 the
        // tick arms the corrective (not an ALERT — first round).
        injector.backdate_ack(1, WINDOW + Duration::from_secs(1));
        injector.tick();
        assert_eq!(injector.pending_view(1), Some((1, false, true)));
        let (corrective, _, failure) = injector.pending_detail(1).unwrap();
        assert!(corrective);
        assert!(failure.unwrap().contains("did not arrive"));

        // Corrective injected, re-ACKed (retry value — finding C) — and the
        // marker never comes again: final failure → handoff_invalid ALERT.
        injector.arm_injection_on_idle(1).expect("corrective");
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>handoff gen-5 retry</samurai-ack>",
        ));
        injector.backdate_ack(1, WINDOW + Duration::from_secs(1));
        injector.tick();

        assert!(injector.pending_view(1).is_none(), "tracking stopped");
        assert_eq!(injector.session_state(1), Some(HandoffRequested));
        let rows = audit.read(project, None, None).await.unwrap().events;
        let alerts: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Alert && r.details["kind"] == "handoff_invalid")
            .collect();
        assert_eq!(alerts.len(), 1);
        assert!(alerts[0].details["failure"]
            .as_str()
            .unwrap()
            .contains("did not arrive"));
    }

    #[tokio::test]
    async fn test_corrective_never_acked_alerts_handoff_invalid() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-cack";
        drive_to_acked(&injector, &supervisor, &context, project, 3);

        // Written window expires → corrective armed and injected.
        injector.backdate_ack(1, WINDOW + Duration::from_secs(1));
        injector.tick();
        injector.arm_injection_on_idle(1).expect("corrective");

        // The corrective itself is never ACKed → the existing attempts=2
        // timeout path fires, but as handoff_invalid, not ack_timeout.
        injector.backdate_injection(1, TIMEOUT + Duration::from_secs(1));
        injector.tick();

        assert!(injector.pending_view(1).is_none());
        assert_eq!(injector.session_state(1), Some(HandoffRequested));
        let rows = audit.read(project, None, None).await.unwrap().events;
        assert!(!rows.iter().any(|r| r.details["kind"] == "ack_timeout"));
        let alerts: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Alert && r.details["kind"] == "handoff_invalid")
            .collect();
        assert_eq!(alerts.len(), 1);
        assert!(alerts[0].details["failure"]
            .as_str()
            .unwrap()
            .contains("never acknowledged"));
    }

    #[tokio::test]
    async fn test_unknown_working_dir_walks_the_failure_path() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, _dirs) = harness(dir.path());
        // No dir registered for session 1 → validation cannot run → treated
        // as a first-round failure (corrective armed), not a panic or a hang.
        drive_to_acked(&injector, &supervisor, &context, "C:/git/proj-inj-nodir", 2);
        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-2</samurai-handoff-written>",
        ));
        wait_until(|| matches!(injector.pending_detail(1), Some((true, false, Some(_))))).await;
        let (_, _, failure) = injector.pending_detail(1).unwrap();
        assert!(failure.unwrap().contains("working directory is unknown"));
    }

    // --- issue #54 bonus: inject at tick time when already idle ---

    #[tokio::test]
    async fn test_trigger_injects_immediately_when_session_already_idle() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, _dirs) = harness(dir.path());
        supervisor
            .register_session(1, "C:/git/proj-inj-preidle".into(), "epic".into(), 3)
            .unwrap();
        context.observe(&context_event(1, 50.0));

        // The session's last signal was a Stop BEFORE the trigger: without
        // the fix the instruction would wait for a future Stop that never
        // comes. The same tick that triggers must inject (attempt 1).
        injector.observe_hook(&stop_event(1));
        injector.tick();
        assert_eq!(injector.pending_view(1), Some((1, false, false)));

        // The injection consumed the idle flag: the next tick does not
        // double-inject.
        injector.tick();
        assert_eq!(injector.pending_view(1), Some((1, false, false)));
    }

    #[tokio::test]
    async fn test_activity_after_stop_clears_the_idle_flag() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, _dirs) = harness(dir.path());
        supervisor
            .register_session(1, "C:/git/proj-inj-active".into(), "epic".into(), 3)
            .unwrap();
        context.observe(&context_event(1, 50.0));

        // Stop, then a tool call: the turn restarted, so the trigger tick
        // must go back to waiting for the NEXT idle signal.
        injector.observe_hook(&stop_event(1));
        injector.observe_hook(&ClaudeEvent::ToolUseStarted {
            session_id: 1,
            tool_name: "Bash".into(),
            tool_use_id: "tu".into(),
            input_summary: "…".into(),
            timestamp: "t".into(),
        });
        injector.tick();
        assert_eq!(injector.pending_view(1), Some((0, false, false)));

        // The real idle signal then injects as usual.
        injector.observe_hook(&stop_event(1));
        assert_eq!(injector.pending_view(1), Some((1, false, false)));
    }

    #[tokio::test]
    async fn test_tick_injects_armed_retry_when_already_idle() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, _dirs) = harness(dir.path());
        supervisor
            .register_session(1, "C:/git/proj-inj-ridle".into(), "epic".into(), 3)
            .unwrap();
        context.observe(&context_event(1, 50.0));
        injector.observe_hook(&stop_event(1));
        injector.tick(); // trigger + immediate attempt 1

        // The agent replies without the marker (its Stop re-marks idle),
        // attempt 1 times out: the SAME tick arms the retry and — because
        // the session is idle right now — injects attempt 2 immediately.
        injector.observe_hook(&stop_event(1));
        injector.backdate_injection(1, TIMEOUT + Duration::from_secs(1));
        injector.tick();
        assert_eq!(injector.pending_view(1), Some((2, false, false)));
    }

    #[tokio::test]
    async fn test_corrective_injects_at_tick_when_already_idle() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, dirs) = harness(dir.path());
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        // Repo registered but no handoff file written → check 1 will fail.
        dirs.lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        drive_to_acked(&injector, &supervisor, &context, "C:/git/proj-inj-cidle", 2);

        // The written-marker turn ended with a Stop (which the transcript's
        // late AssistantMessage must NOT clear — see idle_effect). The file
        // is missing → validation fails → corrective armed; the next tick
        // sees the idle session and injects the corrective without any new
        // Stop ever arriving.
        injector.observe_hook(&stop_event(1));
        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-2</samurai-handoff-written>",
        ));
        wait_until(|| matches!(injector.pending_detail(1), Some((true, false, Some(_))))).await;
        assert_eq!(injector.pending_view(1), Some((1, false, true)));

        injector.tick();
        assert_eq!(
            injector.pending_view(1),
            Some((2, false, false)),
            "tick injected the corrective into the already-idle session"
        );
        let text = injector.pending_instruction(1).unwrap();
        assert!(text.contains("Handoff INVALID"));
    }

    // --- fresh-eyes finding E: the waiting states are age-capped ---

    #[tokio::test]
    async fn test_never_idled_session_alerts_after_wait_cap() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-wedged";
        supervisor
            .register_session(1, project.into(), "epic-w".into(), 4)
            .unwrap();
        context.observe(&context_event(1, 50.0));
        injector.tick(); // trigger; the session never goes idle (wedged turn)
        assert_eq!(injector.pending_view(1), Some((0, false, false)));

        // Inside the cap: kept, still waiting.
        injector.tick();
        assert!(injector.pending_view(1).is_some());

        // Past ack_timeout*3 with no injection possible: single ALERT with
        // the never_idled flavor, tracking stops.
        injector.backdate_waiting(1, WAIT_OVER);
        injector.tick();
        assert!(injector.pending_view(1).is_none(), "tracking stopped");
        assert_eq!(injector.session_state(1), Some(HandoffRequested));

        let mut alerts: Vec<AuditEvent> = Vec::new();
        for _ in 0..200 {
            let rows = audit.read(project, None, None).await.unwrap().events;
            alerts = rows
                .into_iter()
                .filter(|r| r.details["kind"] == "ack_timeout")
                .collect();
            if !alerts.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(alerts.len(), 1, "the ALERT fires exactly once");
        assert_eq!(alerts[0].details["never_idled"], true);
        assert_eq!(alerts[0].details["attempts"], 0);

        // Further ticks stay quiet.
        injector.tick();
        let rows = audit.read(project, None, None).await.unwrap().events;
        assert_eq!(
            rows.iter()
                .filter(|r| r.details["kind"] == "ack_timeout")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn test_armed_retry_that_never_injects_alerts_after_wait_cap() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-noidle";
        supervisor
            .register_session(1, project.into(), "epic-n".into(), 2)
            .unwrap();
        context.observe(&context_event(1, 50.0));
        injector.tick();

        // Attempt 1 times out → retry armed; idle then NEVER comes.
        injector.arm_injection_on_idle(1).expect("attempt 1");
        injector.backdate_injection(1, TIMEOUT + Duration::from_secs(1));
        injector.tick();
        assert_eq!(injector.pending_view(1), Some((1, false, true)));

        injector.backdate_waiting(1, WAIT_OVER);
        injector.tick();
        assert!(injector.pending_view(1).is_none(), "tracking stopped");

        let mut alerts: Vec<AuditEvent> = Vec::new();
        for _ in 0..200 {
            let rows = audit.read(project, None, None).await.unwrap().events;
            alerts = rows
                .into_iter()
                .filter(|r| r.details["kind"] == "ack_timeout")
                .collect();
            if !alerts.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].details["retry_never_injected"], true);
        assert_eq!(alerts[0].details["attempts"], 1);
    }

    // --- fresh-eyes finding H: teardown propagation ---

    #[tokio::test]
    async fn test_remove_session_drops_pending_and_idle_state() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, _dirs) = harness(dir.path());
        supervisor
            .register_session(1, "C:/git/proj-inj-teardown".into(), "epic".into(), 1)
            .unwrap();
        context.observe(&context_event(1, 50.0));
        injector.observe_hook(&stop_event(1)); // idle flag set
        injector.tick(); // trigger + immediate injection (attempt 1)
        assert!(injector.pending_view(1).is_some());

        // The terminal is closed outside the samurai pipeline: supervisor
        // entry and injector state both go.
        assert!(supervisor.remove_session(1));
        injector.remove_session(1);

        assert!(injector.pending_view(1).is_none());
        assert!(injector.arm_injection_on_idle(1).is_none());
        // The tick no longer sees the session: nothing is recreated.
        injector.tick();
        assert!(injector.pending_view(1).is_none());
        assert!(supervisor.list_sessions().is_empty());
    }

    // --- issue #60: the park ladder ---

    /// Registers session 1, transitions it into PARK_REQUESTED (the parker's
    /// move) and arms the park ladder, returning the snapshot.
    fn drive_to_park_requested(
        injector: &SamuraiInjector,
        supervisor: &Supervisor,
        project: &str,
        generation: u32,
    ) -> crate::core::supervisor::SessionSnapshot {
        supervisor
            .register_session(1, project.into(), "epic-9".into(), generation)
            .unwrap();
        let snapshot = supervisor.transition(1, ParkRequested).unwrap();
        injector.begin_park(&snapshot);
        snapshot
    }

    #[tokio::test]
    async fn test_park_ladder_validates_and_reaches_parked() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, _context, dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-park";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        write_handoff_file(repo.path(), "epic-9", 2);
        dirs.lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        drive_to_park_requested(&injector, &supervisor, project, 2);

        // The park instruction rides the same ladder with its own markers
        // and the STANDARD handoff relpath (the file doubles as park state).
        let data = injector.arm_injection_on_idle(1).expect("park attempt 1");
        assert!(data.contains("<samurai-ack>park gen-2</samurai-ack>"));
        assert!(data.contains(".maestro/handoffs/epic-9-gen2.md"));
        assert!(data.contains("<samurai-handoff-written>gen-2 park</samurai-handoff-written>"));
        assert!(!data[..data.len() - 1].contains('\r') && !data.contains('\n'));

        // A replayed HANDOFF ACK for the same generation must not ACK the
        // park (kind-scoped values), and a replayed handoff written marker
        // must not start its validation.
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>handoff gen-2</samurai-ack>",
        ));
        assert_eq!(injector.pending_view(1), Some((1, false, false)));
        injector.observe(&assistant_message(
            1,
            "Parking. <samurai-ack>park gen-2</samurai-ack>",
        ));
        assert_eq!(injector.pending_view(1), Some((1, true, false)));
        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-2</samurai-handoff-written>",
        ));
        assert_eq!(
            injector.pending_detail(1).map(|(_, validating, _)| validating),
            Some(false),
            "a handoff written value must not validate a park"
        );

        // The real park marker → validation → PARKED, entry completed. The
        // parker slot is unset in this harness — the transition still runs.
        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-2 park</samurai-handoff-written>",
        ));
        wait_until(|| injector.session_state(1) == Some(Parked)).await;
        wait_until(|| injector.pending_view(1).is_none()).await;

        // The transitions wrote both PARK phases; no ALERT anywhere.
        let mut rows = Vec::new();
        for _ in 0..200 {
            rows = audit.read(project, None, None).await.unwrap().events;
            if rows
                .iter()
                .any(|r| r.event == AuditEventKind::Park && r.details["phase"] == "parked")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(rows
            .iter()
            .any(|r| r.event == AuditEventKind::Park && r.details["phase"] == "requested"));
        assert!(rows
            .iter()
            .any(|r| r.event == AuditEventKind::Park && r.details["phase"] == "parked"));
        assert!(!rows.iter().any(|r| r.event == AuditEventKind::Alert));
    }

    #[tokio::test]
    async fn test_park_validation_gap_holds_sweep_open_until_on_parked() {
        // Review F3a. Every sweep's LAST park exercises this window: the
        // completion decision used to REMOVE the pending entry before the
        // PARKED transition + parker.on_parked ran, so a complete_sweep
        // racing into that gap (30s tick / teardown completion) saw nothing
        // blocking, disengaged, and on_parked landed in a dead sweep —
        // parked epic, NO resume timer. The gap hook drives a parker tick
        // into that exact window deterministically.
        use crate::core::allowance_watcher::{AllowanceEvent, AllowanceWindow, ThresholdKind};
        use crate::core::samurai_parker::SamuraiParker;
        use crate::core::samurai_replicator::SessionTeardown;
        use crate::core::samurai_schedule::SamuraiSchedule;

        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, context, dirs) = harness(dir.path());
        let injector = Arc::new(injector);
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        write_handoff_file(repo.path(), "epic-9", 2);
        dirs.lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        let (schedule, _fire_task) =
            SamuraiSchedule::new(dir.path().join("schedule"), Arc::new(|_| {}), None);
        let teardown: SessionTeardown = Arc::new(|_| Box::pin(async {}));
        let parker = SamuraiParker::new(
            supervisor.clone(),
            context.clone(),
            injector.clone(),
            schedule.clone(),
            audit.clone(),
            teardown,
        );
        injector.set_parker(parker.clone());

        supervisor
            .register_session(1, "C:/git/proj-inj-gap".into(), "epic-9".into(), 2)
            .unwrap();
        // The hard crossing engages the sweep and PARK_REQUESTs the session.
        parker.on_allowance_event(&AllowanceEvent::ThresholdCrossed {
            window: AllowanceWindow::FiveHour,
            threshold_kind: ThresholdKind::Hard,
            value: 91.0,
            threshold: 90.0,
            resets_at: Some("2030-01-01T00:00:00Z".to_string()),
        });
        assert_eq!(injector.session_state(1), Some(ParkRequested));

        // Ladder to the marker: idle → inject → ACK, then arm the gap hook
        // BEFORE the written marker starts the real validation. The map
        // address filters out calls from other tests' injectors.
        injector.observe_hook(&stop_event(1));
        injector.observe(&assistant_message(1, "<samurai-ack>park gen-2</samurai-ack>"));
        let map_addr = Arc::as_ptr(&injector.pending) as usize;
        let observed: Arc<Mutex<Vec<(bool, bool)>>> = Arc::new(Mutex::new(Vec::new()));
        let observed_rec = observed.clone();
        let hook_injector = injector.clone();
        let hook_parker = parker.clone();
        set_validation_gap_hook(Some(Arc::new(move |addr: usize, session_id: u32| {
            if addr != map_addr {
                return;
            }
            // The racing edge, landed deterministically in the gap.
            hook_parker.tick();
            observed_rec.lock().unwrap().push((
                hook_injector.has_pending(session_id),
                hook_parker.parking_engaged(),
            ));
        })));
        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-2 park</samurai-handoff-written>",
        ));

        wait_until(|| injector.session_state(1) == Some(Parked)).await;
        wait_until(|| !parker.parking_engaged()).await;
        set_validation_gap_hook(None);

        assert_eq!(
            *observed.lock().unwrap(),
            vec![(true, true)],
            "in the validation gap the entry must still be pending and the racing tick must NOT disengage the sweep"
        );
        // The essence of the bug: the parked epic still gets its resume timer.
        let timers = schedule.list();
        assert_eq!(timers.len(), 1, "the sweep's LAST park must arm its resume timer");
        assert_eq!(timers[0].epic, "epic-9");
        assert_eq!(timers[0].reason, "park");
    }

    #[tokio::test]
    async fn test_invalid_park_arms_corrective_then_alerts_park_invalid() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, _context, dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-park-bad";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        // File present but WIP left uncommitted → check 2 fails.
        write_handoff_file(repo.path(), "epic-9", 2);
        std::fs::write(repo.path().join("tracked.txt"), "dirty\n").unwrap();
        dirs.lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        drive_to_park_requested(&injector, &supervisor, project, 2);

        injector.arm_injection_on_idle(1).expect("park attempt 1");
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>park gen-2</samurai-ack>",
        ));
        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-2 park</samurai-handoff-written>",
        ));

        // Validation fails → the ONE corrective, with the park's wording and
        // round-scoped retry markers.
        wait_until(|| matches!(injector.pending_detail(1), Some((true, false, Some(_))))).await;
        let data = injector.arm_injection_on_idle(1).expect("corrective");
        assert!(data.contains("Park INVALID"));
        assert!(data.contains("WIP is not committed"));
        assert!(data.contains("<samurai-ack>park gen-2 retry</samurai-ack>"));
        assert!(data.contains("<samurai-handoff-written>gen-2 park retry</samurai-handoff-written>"));

        // The corrective cycle fails too (repo still dirty) → a single
        // park_invalid ALERT; the session stays in PARK_REQUESTED.
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>park gen-2 retry</samurai-ack>",
        ));
        injector.observe(&assistant_message(
            1,
            "<samurai-handoff-written>gen-2 park retry</samurai-handoff-written>",
        ));
        wait_until(|| injector.pending_view(1).is_none()).await;
        assert_eq!(injector.session_state(1), Some(ParkRequested));

        let mut alerts: Vec<AuditEvent> = Vec::new();
        for _ in 0..200 {
            let rows = audit.read(project, None, None).await.unwrap().events;
            alerts = rows
                .into_iter()
                .filter(|r| r.event == AuditEventKind::Alert && r.details["kind"] == "park_invalid")
                .collect();
            if !alerts.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(alerts.len(), 1, "the ALERT fires exactly once");
        assert!(alerts[0].details["failure"]
            .as_str()
            .unwrap()
            .contains("WIP is not committed"));
    }

    // --- issue #60: the soft wind-down ladder ---

    #[tokio::test]
    async fn test_soft_winddown_ack_completes_without_any_transition() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, _context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-soft";
        let snapshot = supervisor
            .register_session(1, project.into(), "epic-9".into(), 3)
            .unwrap();

        assert!(injector.begin_soft_winddown(&snapshot));
        // A second wind-down while one is pending is refused (edge storms).
        assert!(!injector.begin_soft_winddown(&snapshot));

        // Injected on idle while the session stays WORKING; the text carries
        // the wind-down ACK and no written marker.
        let data = injector.arm_injection_on_idle(1).expect("attempt 1");
        assert!(data.contains("<samurai-ack>winddown gen-3</samurai-ack>"));
        assert!(!data.contains("<samurai-handoff-written>"));
        assert_eq!(injector.session_state(1), Some(Working));

        // The ACK alone completes the entry — no state change, no audit row
        // beyond the SPAWN, and a later idle injects nothing.
        injector.observe(&assistant_message(
            1,
            "Winding down. <samurai-ack>winddown gen-3</samurai-ack>",
        ));
        assert!(injector.pending_view(1).is_none());
        assert_eq!(injector.session_state(1), Some(Working));
        assert!(injector.arm_injection_on_idle(1).is_none());
        let rows = audit.read(project, None, None).await.unwrap().events;
        assert_eq!(rows.len(), 1, "SPAWN only — the wind-down is stateless");
    }

    #[tokio::test]
    async fn test_soft_winddown_timeout_alerts_ack_timeout_and_stops() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, _context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-soft-to";
        let snapshot = supervisor
            .register_session(1, project.into(), "epic-9".into(), 3)
            .unwrap();
        assert!(injector.begin_soft_winddown(&snapshot));

        // Attempt 1 times out → retry; attempt 2 times out → ALERT, done.
        injector.arm_injection_on_idle(1).expect("attempt 1");
        injector.backdate_injection(1, TIMEOUT + Duration::from_secs(1));
        injector.tick();
        assert_eq!(injector.pending_view(1), Some((1, false, true)));
        injector.arm_injection_on_idle(1).expect("attempt 2");
        injector.backdate_injection(1, TIMEOUT + Duration::from_secs(1));
        injector.tick();

        assert!(injector.pending_view(1).is_none(), "tracking stopped");
        assert_eq!(injector.session_state(1), Some(Working));

        let mut alerts: Vec<AuditEvent> = Vec::new();
        for _ in 0..200 {
            let rows = audit.read(project, None, None).await.unwrap().events;
            alerts = rows
                .into_iter()
                .filter(|r| r.details["kind"] == "ack_timeout")
                .collect();
            if !alerts.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].details["instruction"], "soft_winddown");
    }

    #[tokio::test]
    async fn test_begin_park_supersedes_a_pending_soft_winddown() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, _context, _dirs) = harness(dir.path());
        let snapshot = supervisor
            .register_session(1, "C:/git/proj-inj-super".into(), "epic-9".into(), 2)
            .unwrap();
        assert!(injector.begin_soft_winddown(&snapshot));
        assert!(injector.has_pending(1));

        // The park replaces the wind-down entry; the next idle injects the
        // PARK instruction, not the stale wind-down.
        let parked = supervisor.transition(1, ParkRequested).unwrap();
        injector.begin_park(&parked);
        let data = injector.arm_injection_on_idle(1).expect("park attempt 1");
        assert!(data.contains("<samurai-ack>park gen-2</samurai-ack>"));
        assert!(!data.contains("winddown"));
    }
}
