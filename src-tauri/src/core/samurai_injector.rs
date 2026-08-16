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
//!    NOT the EventBus tee: the bus dedups `SessionEnded` by session *and*
//!    reason inside a 5s window (see `claude_event.rs`), so a Stop landing
//!    shortly after another Stop could be swallowed before it ever reached
//!    a bus-side tee. Issue #54 closes P2.2's known gap: the
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
use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_config::SharedSamuraiConfig;
use super::samurai_context::SamuraiContextStore;
use super::samurai_parker::SamuraiParker;
use super::samurai_prompts;
use super::samurai_pty::DeliveryOutcome;
use super::samurai_replicator::{SamuraiReplicator, StdinWriter};
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

/// How many consecutive ticks a WORKING session may have no context reading
/// at all before the `context_blind` ALERT fires (10 × 30s = 5 minutes). A
/// freshly spawned orchestrator produces its first assistant message with
/// usage within seconds, so a gap this long is a broken watch, not a slow
/// start — and it means the handoff can never trigger for that session.
const BLIND_TICKS_BEFORE_ALERT: u32 = 10;

/// Resolves a Maestro session id to the directory its shell works in (the
/// worktree/sub-repo-aware cwd the SessionManager recorded). Injected as a
/// closure so the controller stays constructible in tests without tauri
/// managed state.
pub type SessionDirResolver = Arc<dyn Fn(u32) -> Option<String> + Send + Sync>;

/// Re-resolves one session's transcript and force-reattaches its watch
/// (issue #118). Returns `true` when a transcript was found and a fresh
/// watch attached. Production (lib.rs) resolves the session's working
/// directory to the newest transcript in its Claude projects directory and
/// calls `TranscriptWatcher::restart_watching`; tests inject a recorder.
pub type TranscriptRewatcher = Arc<dyn Fn(u32) -> bool + Send + Sync>;

/// One session's blindness episode (issue #118): consecutive WORKING ticks
/// with no context reading, plus whether this episode's single self-heal
/// (transcript rewatch) already ran. The episode ends when a reading lands
/// (the entry is removed), so a later blind spell heals and alerts afresh.
#[derive(Default)]
struct BlindState {
    ticks: u32,
    rewatch_attempted: bool,
}

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
    /// Wind-down all-clear (issue #120): the allowance recovered, so a
    /// wound-down-never-parked session may resume full throughput. Ack-only
    /// like the wind-down: no transition, no file, no written marker.
    WinddownAllClear,
}

impl PendingKind {
    /// The supervisor state a live entry of this kind belongs to; the tick's
    /// prune pass drops the entry when its session leaves this state.
    fn expected_state(self) -> SupervisorState {
        match self {
            Self::Handoff => SupervisorState::HandoffRequested,
            Self::Park => SupervisorState::ParkRequested,
            Self::SoftWinddown | Self::WinddownAllClear => SupervisorState::Working,
        }
    }

    /// Audit/log spelling of the instruction (`details.instruction`).
    fn as_str(self) -> &'static str {
        match self {
            Self::Handoff => "handoff",
            Self::Park => "park",
            Self::SoftWinddown => "soft_winddown",
            Self::WinddownAllClear => "winddown_allclear",
        }
    }

    /// The ALERT `details.kind` for an exhausted validation ladder.
    /// SoftWinddown never reaches validation; the value is defensive only.
    fn invalid_kind(self) -> &'static str {
        match self {
            Self::Handoff => "handoff_invalid",
            Self::Park => "park_invalid",
            Self::SoftWinddown => "soft_winddown_invalid",
            Self::WinddownAllClear => "winddown_allclear_invalid",
        }
    }
}

/// The round-scoped ACK value one entry expects (finding C discipline,
/// per kind). `episode` (issue #131 fix M7) additionally scopes the two
/// ack-only kinds to one wind-down episode within the generation — see
/// [`samurai_prompts::soft_winddown_ack_value`]; ignored by every other
/// kind, which is unique per generation alone.
fn expected_ack_value(
    kind: PendingKind,
    generation: u32,
    corrective: bool,
    episode: u32,
) -> String {
    match (kind, corrective) {
        (PendingKind::Handoff, false) => samurai_prompts::handoff_ack_value(generation),
        (PendingKind::Handoff, true) => samurai_prompts::handoff_ack_retry_value(generation),
        (PendingKind::Park, false) => samurai_prompts::park_ack_value(generation),
        (PendingKind::Park, true) => samurai_prompts::park_ack_retry_value(generation),
        (PendingKind::SoftWinddown, _) => {
            samurai_prompts::soft_winddown_ack_value(generation, episode)
        }
        (PendingKind::WinddownAllClear, _) => {
            samurai_prompts::winddown_allclear_ack_value(generation, episode)
        }
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
        (PendingKind::SoftWinddown, _) | (PendingKind::WinddownAllClear, _) => None,
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
    episode: u32,
) -> String {
    match kind {
        PendingKind::Handoff => {
            samurai_prompts::handoff_corrective_instruction(epic, generation, failure)
        }
        PendingKind::Park => {
            samurai_prompts::park_corrective_instruction(epic, generation, failure)
        }
        PendingKind::SoftWinddown => {
            samurai_prompts::soft_winddown_instruction(generation, episode)
        }
        PendingKind::WinddownAllClear => {
            samurai_prompts::winddown_allclear_instruction(generation, episode)
        }
    }
}

/// A capture-time [`Instant`] that test code can artificially age without
/// rewinding the underlying clock (issue #90). `Instant` is boot-relative on
/// Windows, so `Instant::now().checked_sub(by)` underflows whenever the
/// machine's uptime is shorter than `by` — flaky right after a reboot, green
/// on a long-running box. Advancing the *reading* side instead (adding to
/// elapsed time) can never underflow, so tests age these clocks that way.
/// `pub(crate)`: shared with `samurai_replicator`, which has the same
/// backdate-for-tests need on its own staged-ritual clocks.
#[derive(Clone, Copy)]
pub(crate) struct AgeableInstant {
    at: Instant,
    /// Test-only extra age layered on top of `at`'s real elapsed time.
    /// Always zero outside tests; production reads are unaffected.
    #[cfg(test)]
    extra: Duration,
}

impl AgeableInstant {
    pub(crate) fn now() -> Self {
        Self {
            at: Instant::now(),
            #[cfg(test)]
            extra: Duration::ZERO,
        }
    }

    pub(crate) fn elapsed(&self) -> Duration {
        #[cfg(test)]
        {
            self.at.elapsed() + self.extra
        }
        #[cfg(not(test))]
        {
            self.at.elapsed()
        }
    }

    /// Test-only: simulate `by` additional elapsed time on this timestamp.
    #[cfg(test)]
    pub(crate) fn backdate(&mut self, by: Duration) {
        self.extra += by;
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
    /// The instruction text. No submit key, ever — `samurai_pty` sends the
    /// Enter as a separate PTY write at delivery time.
    instruction: String,
    /// Injection attempts so far: 0 (waiting for first idle), 1, or 2 (max).
    attempts: u8,
    /// When the latest injection was written; `None` before the first.
    injected_at: Option<AgeableInstant>,
    /// When the entry started (or resumed) WAITING for an idle signal:
    /// stamped at creation, and re-stamped whenever a retry/corrective is
    /// armed. Caps the wait (finding E): no injection possible within
    /// `ack_timeout_secs * STUCK_WAIT_MULTIPLIER` of this → ALERT.
    waiting_since: AgeableInstant,
    /// The orchestrator replied with the expected ACK marker.
    acked: bool,
    /// Attempt 1 timed out; re-inject at the next idle signal.
    awaiting_retry: bool,
    /// When the ACK arrived — the written-marker window runs from here.
    acked_at: Option<AgeableInstant>,
    /// The written marker arrived and the two-check validation is in flight.
    validating: bool,
    /// This entry carries the single corrective re-instruction; any further
    /// failure ALERTs instead of retrying again.
    corrective: bool,
    /// What the first round's validation/timeout found wrong (rides into the
    /// final `handoff_invalid` ALERT details).
    failure: Option<String>,
    /// The stuck-wait ALERT already fired for this entry. It stays tracked
    /// (a long turn ends eventually and the instruction is still owed), but
    /// the ALERT is one-shot and the parker must stop counting it as pending
    /// — see [`TimeoutVerdict::AlertStuck`] and `has_pending`.
    stuck_alerted: bool,
    /// The wind-down EPISODE this entry belongs to (issue #131 fix M7):
    /// meaningful only for [`PendingKind::SoftWinddown`] /
    /// [`PendingKind::WinddownAllClear`], 0 for every other kind. See
    /// [`samurai_prompts::soft_winddown_ack_value`] for why generation+kind
    /// alone is not a unique ack value for these two kinds.
    episode: u32,
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
            waiting_since: AgeableInstant::now(),
            acked: false,
            awaiting_retry: false,
            acked_at: None,
            validating: false,
            corrective: false,
            failure: None,
            stuck_alerted: false,
            episode: 0,
        }
    }

    /// Fix M7: stamps the wind-down episode number onto a freshly built
    /// [`PendingKind::SoftWinddown`] / [`PendingKind::WinddownAllClear`]
    /// entry.
    fn with_episode(mut self, episode: u32) -> Self {
        self.episode = episode;
        self
    }

    /// How long since the latest injection; `None` before the first.
    /// [`AgeableInstant`] carries the test-only backdate offset (issue #90),
    /// so these reads never underflow on a freshly booted machine.
    fn injected_elapsed(&self) -> Option<Duration> {
        self.injected_at.map(|t| t.elapsed())
    }

    /// How long this entry has been WAITING for an idle signal.
    fn waiting_elapsed(&self) -> Duration {
        self.waiting_since.elapsed()
    }

    /// How long since the ACK arrived; `None` before it does.
    fn acked_elapsed(&self) -> Option<Duration> {
        self.acked_at.map(|t| t.elapsed())
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
    /// came. ALERT once (`never_idled` / `retry_never_injected`).
    ///
    /// Unlike [`Alert`](Self::Alert) the entry is KEPT: "no idle yet" is not
    /// "cannot be instructed". A long turn — a subagent wave, a full
    /// build+test — ends eventually, and dropping the entry at the cap left
    /// the epic stranded for good: the trigger only fires for WORKING
    /// sessions, the parker skips a mid-handoff session, and the watchdog
    /// will not call a live `claude` DEAD. The next Stop hook now still
    /// delivers the instruction it was waiting to deliver.
    AlertStuck,
}

/// Pure ACK-timeout decision. `elapsed` is time since the latest injection
/// (`None` = not injected yet, still waiting for the first idle);
/// `waiting_elapsed` is time since the entry started waiting for an idle
/// signal (creation / retry armed). Both boundaries are strict (`>`),
/// matching "no ACK within N seconds".
///
/// Two different waits, two different caps. An ARMED RETRY waits for the
/// Stop of a turn the agent is already known to have finished once, so
/// `timeout * STUCK_WAIT_MULTIPLIER` fits. A NEVER-INJECTED entry waits for
/// the end of whatever turn was in flight when the trigger fired — a
/// subagent wave plus a full build+test — and gets `max_turn_wait`, which is
/// sized for that. Reusing the ACK window for both is what made a normal
/// long turn look wedged.
fn timeout_verdict(
    acked: bool,
    attempts: u8,
    awaiting_retry: bool,
    elapsed: Option<Duration>,
    waiting_elapsed: Duration,
    timeout: Duration,
    max_turn_wait: Duration,
) -> TimeoutVerdict {
    if acked {
        return TimeoutVerdict::Keep; // resolved — the written phase owns it
    }
    if awaiting_retry {
        // Retry armed; idle never came (finding E: age-capped, not forever).
        return if waiting_elapsed > timeout * STUCK_WAIT_MULTIPLIER {
            TimeoutVerdict::AlertStuck
        } else {
            TimeoutVerdict::Keep
        };
    }
    let Some(elapsed) = elapsed else {
        // Trigger fired, Stop never came — the long-turn cap.
        return if waiting_elapsed > max_turn_wait {
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
///
/// `Ok(sha)` carries the repo HEAD after both checks passed — with WIP
/// committed, HEAD *is* the WIP commit — for the audit trail (issue #101).
/// `None` only when HEAD itself cannot be read (e.g. an unborn branch); a
/// missing SHA never fails an otherwise valid handoff.
fn validate_handoff(working_dir: &Path, relpath: &str) -> Result<Option<String>, String> {
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
        Ok(wip_head_sha(working_dir))
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

/// What a successful validation proved, for the audit trail (issue #101):
/// where the handoff file was left and the WIP commit HEAD pointed at.
struct ValidatedHandoff {
    relpath: String,
    wip_commit: Option<String>,
}

/// HEAD of the session's repo, for the audit trail (issue #101). Best
/// effort: any failure logs and yields `None` — the SHA is replay context,
/// never a third validation check.
fn wip_head_sha(working_dir: &Path) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(working_dir)
        .hide_console_window()
        .output()
        .map_err(|e| log::warn!("samurai injector: could not read HEAD for the audit row: {e}"))
        .ok()?;
    if !output.status.success() {
        log::warn!(
            "samurai injector: git rev-parse HEAD failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return None;
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!sha.is_empty()).then_some(sha)
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
    p.instruction = corrective_instruction_for(p.kind, &p.epic, p.generation, &failure, p.episode);
    p.attempts = 1;
    p.awaiting_retry = true;
    // The wait for the corrective's idle starts now (finding E age cap).
    p.waiting_since = AgeableInstant::now();
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
/// Test hook signature: (pending-map address, session id).
#[cfg(test)]
type ValidationGapHook = Arc<dyn Fn(usize, u32) + Send + Sync>;

#[cfg(test)]
static VALIDATION_GAP_HOOK: Mutex<Option<ValidationGapHook>> = Mutex::new(None);

#[cfg(test)]
fn validation_gap_hook() -> Option<ValidationGapHook> {
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
    outcome: Result<ValidatedHandoff, String>,
) {
    enum Next {
        Transition(PendingKind, serde_json::Value),
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
            Ok(proof) => {
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
                //
                // Issue #101: the transition row records WHERE the handoff
                // file was left and the WIP commit it validated against.
                Next::Transition(
                    p.kind,
                    json!({
                        "handoff_file": proof.relpath,
                        "wip_commit": proof.wip_commit,
                    }),
                )
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
        Next::Transition(kind, details) => {
            match kind {
                PendingKind::Handoff => {
                    log::info!(
                        "samurai injector: session {session_id} handoff validated (file present, WIP committed) — HANDOFF_WRITTEN"
                    );
                    match supervisor.transition_with_details(
                        session_id,
                        SupervisorState::HandoffWritten,
                        details,
                    ) {
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
                    match supervisor.transition_with_details(
                        session_id,
                        SupervisorState::Parked,
                        details,
                    ) {
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
                // The ack-only kinds have no written stage, so no validation
                // ever runs for them — defensive arm, never expected.
                PendingKind::SoftWinddown | PendingKind::WinddownAllClear => log::warn!(
                    "samurai injector: unexpected validation completion for an ack-only instruction (session {session_id}) — ignored"
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
    /// Delivers one instruction into a session's PTY — the replicator's
    /// exact writer contract (issue #109): text without a submit key, and a
    /// verdict callback fired once the body write lands (or fails). The
    /// production closure (lib.rs) wraps `samurai_pty::submit_instruction`
    /// with ctx `"injector"`; tests inject a recorder.
    deliver: StdinWriter,
    audit: AuditLog,
    session_dirs: SessionDirResolver,
    /// `Arc` so the spawned validation task can reach the map after the
    /// call that spawned it returned.
    pending: Arc<Mutex<HashMap<u32, PendingInstruction>>>,
    /// Sessions whose most recent signal was a Stop — idle right now (issue
    /// #54 bonus fix; see [`idle_effect`]). Holds bare u32s, so an
    /// unsupervised session costs one integer until its SessionEnd.
    idle_now: Arc<Mutex<HashSet<u32>>>,
    /// Consecutive ticks a WORKING session has had NO context reading, per
    /// session — the blindness detector behind the `context_blind` ALERT
    /// ([`note_blind_tick`](SamuraiInjector::note_blind_tick)), plus the
    /// per-episode self-heal flag (issue #118). Cleared the moment a reading
    /// lands, and pruned to the supervised set each tick.
    blind_ticks: Mutex<HashMap<u32, BlindState>>,
    /// Issue #118: the transcript-rewatch closure the blindness detector
    /// heals through before alerting. Late-bound like the parker (the
    /// watcher wiring lives in lib.rs setup); unset = alert-only behavior.
    rewatch: std::sync::OnceLock<TranscriptRewatcher>,
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
    /// Per-session wind-down EPISODE counter (issue #131 fix M7): the next
    /// number [`begin_soft_winddown`](Self::begin_soft_winddown) stamps on a
    /// FRESH wind-down entry. Outlives the entry itself (an ack-only kind is
    /// removed from `pending` the moment it is acked), so
    /// [`begin_winddown_allclear`](Self::begin_winddown_allclear) can still
    /// read the current episode to close even after the wind-down entry is
    /// long gone.
    winddown_episode: Mutex<HashMap<u32, u32>>,
}

impl SamuraiInjector {
    pub fn new(
        supervisor: Arc<Supervisor>,
        context: Arc<SamuraiContextStore>,
        config: SharedSamuraiConfig,
        deliver: StdinWriter,
        audit: AuditLog,
        session_dirs: SessionDirResolver,
        replicator: Option<Arc<SamuraiReplicator>>,
    ) -> Self {
        Self {
            supervisor,
            context,
            config,
            deliver,
            audit,
            session_dirs,
            pending: Arc::new(Mutex::new(HashMap::new())),
            idle_now: Arc::new(Mutex::new(HashSet::new())),
            blind_ticks: Mutex::new(HashMap::new()),
            rewatch: std::sync::OnceLock::new(),
            replicator,
            parker: std::sync::OnceLock::new(),
            run_configs: std::sync::OnceLock::new(),
            winddown_episode: Mutex::new(HashMap::new()),
        }
    }

    /// Bumps and returns the NEXT wind-down episode for `session_id` (fix
    /// M7) — called once per fresh [`begin_soft_winddown`](Self::begin_soft_winddown).
    fn next_winddown_episode(&self, session_id: u32) -> u32 {
        let mut episodes = self
            .winddown_episode
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let next = episodes.get(&session_id).copied().unwrap_or(0) + 1;
        episodes.insert(session_id, next);
        next
    }

    /// The CURRENT wind-down episode for `session_id` (fix M7) — the last
    /// one [`next_winddown_episode`](Self::next_winddown_episode) handed
    /// out, or `1` when none has yet (an all-clear with no prior wind-down
    /// this session, e.g. a defensive/test call).
    fn current_winddown_episode(&self, session_id: u32) -> u32 {
        self.winddown_episode
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&session_id)
            .copied()
            .unwrap_or(1)
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

    /// Issue #118: late-binds the transcript-rewatch closure the blindness
    /// detector self-heals through, same pattern as `set_parker`. Second
    /// calls are ignored.
    pub fn set_rewatcher(&self, rewatch: TranscriptRewatcher) {
        let _ = self.rewatch.set(rewatch);
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
        // Issue #103: the replicator's post-delivery watch reads
        // transcript-side turn activity (UserMessage above all) from this
        // same tee — the forwarding mirror of `observe_hook` below.
        if let Some(replicator) = &self.replicator {
            replicator.observe(event);
        }
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
            self.on_idle(session_id, "stop_hook");
        }
    }

    /// One trigger + timeout pass. Called from the spawned loop; fully
    /// synchronous (validation I/O is spawned, never run inline).
    pub fn tick(&self) {
        let (threshold_pct, timeout, max_turn_wait) = {
            let cfg = self
                .config
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (
                cfg.handoff_context_pct,
                Duration::from_secs(cfg.ack_timeout_secs),
                Duration::from_secs(cfg.max_turn_wait_secs),
            )
        };
        let written_window = timeout * WRITTEN_WINDOW_MULTIPLIER;

        // Trigger pass: WORKING sessions past the threshold request a
        // handoff. The state machine enforces one-in-flight and handoff/park
        // exclusivity and writes the HANDOFF(phase=requested) audit row; a
        // rejected transition already produced its illegal_transition ALERT.
        let mut supervised: Vec<u32> = Vec::new();
        for session in self.supervisor.list_sessions() {
            supervised.push(session.session_id);
            let percent = self.context.percent(session.session_id);
            // A WORKING session with no reading cannot ever trigger, and the
            // predicate below says so silently — which is indistinguishable
            // from "still below the threshold" in the audit trail. Blindness
            // means the transcript never reached the context store (the
            // session was never watched, or its watcher stopped), so the
            // handoff can never fire for the rest of the run: say it once.
            if session.state == SupervisorState::Working && percent.is_none() {
                self.note_blind_tick(&session);
            } else {
                self.lock_blind().remove(&session.session_id);
            }
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
                    let instruction =
                        samurai_prompts::handoff_instruction(&snapshot.epic, snapshot.generation);
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
        // Teardown leaves no callback here, so unsupervised ids would linger.
        self.lock_blind().retain(|id, _| supervised.contains(id));

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
            // Stuck-wait alerts are reported like the rest but their entries
            // are NOT removed below — the instruction is still owed.
            let mut stuck: Vec<(u32, PendingKind, String, AuditEvent)> = Vec::new();
            for (id, p) in pending.iter_mut() {
                if !p.acked {
                    // ACK phase — P2.2 plumbing, shared by the corrective
                    // round (which re-arms as attempts=1 + awaiting_retry).
                    match timeout_verdict(
                        p.acked,
                        p.attempts,
                        p.awaiting_retry,
                        p.injected_elapsed(),
                        p.waiting_elapsed(),
                        timeout,
                        max_turn_wait,
                    ) {
                        TimeoutVerdict::Keep => {}
                        TimeoutVerdict::ArmRetry => {
                            log::warn!(
                                "samurai injector: session {id} did not ACK within {timeout:?} — retrying at next idle"
                            );
                            p.awaiting_retry = true;
                            // The wait for the retry's idle starts now
                            // (finding E age cap).
                            p.waiting_since = AgeableInstant::now();
                        }
                        TimeoutVerdict::AlertStuck => {
                            // Finding E: no injection was possible yet —
                            // either the trigger's Stop never came (a very
                            // long turn) or the armed retry's idle never
                            // came. One ack_timeout ALERT with the exact
                            // flavor, then KEEP TRACKING: the turn ends
                            // eventually and the instruction is still owed.
                            // Latched so the ALERT stays one-shot.
                            if p.stuck_alerted {
                                continue;
                            }
                            p.stuck_alerted = true;
                            let flag = if p.awaiting_retry {
                                "retry_never_injected"
                            } else {
                                "never_idled"
                            };
                            let mut details = json!({
                                "kind": "ack_timeout",
                                "attempts": p.attempts,
                                "instruction": p.kind.as_str(),
                                // The entry survives this alert; nothing is
                                // abandoned. Explicit so an audit reader is
                                // not left assuming the epic was dropped.
                                "still_tracked": true,
                            });
                            details[flag] = json!(true);
                            let event = AuditEvent::now(
                                p.epic.clone(),
                                AuditEventKind::Alert,
                                p.generation,
                                *id,
                                details,
                            );
                            stuck.push((*id, p.kind, p.project.clone(), event));
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
                    p.acked_elapsed(),
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
            // state for human attention. `stuck` entries are deliberately
            // NOT removed — their one-shot guard is the `stuck_alerted` flag.
            for (id, _, _, _) in &alerts {
                pending.remove(id);
            }
            alerts.extend(stuck);
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
            self.on_idle(id, "idle_at_tick");
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
        let instruction = samurai_prompts::park_instruction(&snapshot.epic, snapshot.generation);
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
    ///
    /// Fix L6 (issue #131 review): a pending, un-acked
    /// [`PendingKind::WinddownAllClear`] left over from an EARLIER episode is
    /// the one exception — it is superseded outright (mirrors
    /// [`begin_winddown_allclear`](Self::begin_winddown_allclear) superseding
    /// a delivered wind-down), so a real new wind-down episode is never
    /// silently blocked by a stale all-clear the caller has not acked yet.
    pub fn begin_soft_winddown(&self, snapshot: &SessionSnapshot) -> bool {
        // Fix M7: a fresh episode number for this wind-down, allocated
        // before the pending lock (separate map) — see `winddown_episode`.
        let episode = self.next_winddown_episode(snapshot.session_id);
        {
            let mut pending = self.lock_pending();
            match pending.get(&snapshot.session_id) {
                Some(p) if p.kind == PendingKind::WinddownAllClear => {}
                Some(_) => return false,
                None => {}
            }
            let instruction =
                samurai_prompts::soft_winddown_instruction(snapshot.generation, episode);
            pending.insert(
                snapshot.session_id,
                PendingInstruction::new(PendingKind::SoftWinddown, snapshot, instruction)
                    .with_episode(episode),
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

    /// Issue #120: the wind-down all-clear for a WORKING session whose
    /// allowance recovered. Ack-only, like the wind-down itself. A pending
    /// entry decides the outcome:
    ///
    /// - a DELIVERED wind-down (attempts > 0) is superseded — the agent was
    ///   told to slow down, so it must be told the order is lifted;
    /// - an UNDELIVERED wind-down (attempts == 0) is cancelled silently —
    ///   the agent never saw it, so there is nothing to clear (`false`);
    /// - any other pending instruction refuses the all-clear (`false`) —
    ///   the session is already heading somewhere.
    pub fn begin_winddown_allclear(&self, snapshot: &SessionSnapshot) -> bool {
        // Fix M7: closes the SAME episode the wind-down it supersedes was
        // opened under — read, not allocated (an ack-only entry is removed
        // from `pending` the moment it is acked, so the episode number lives
        // in the separate, longer-lived `winddown_episode` map).
        let episode = self.current_winddown_episode(snapshot.session_id);
        {
            let mut pending = self.lock_pending();
            match pending.get(&snapshot.session_id) {
                Some(p) if p.kind == PendingKind::SoftWinddown && p.attempts == 0 => {
                    pending.remove(&snapshot.session_id);
                    log::info!(
                        "samurai injector: session {} undelivered wind-down cancelled by the all-clear — nothing to send",
                        snapshot.session_id,
                    );
                    return false;
                }
                Some(p) if p.kind != PendingKind::SoftWinddown => return false,
                _ => {}
            }
            let instruction =
                samurai_prompts::winddown_allclear_instruction(snapshot.generation, episode);
            pending.insert(
                snapshot.session_id,
                PendingInstruction::new(PendingKind::WinddownAllClear, snapshot, instruction)
                    .with_episode(episode),
            );
        }
        log::info!(
            "samurai injector: session {} (gen-{}) wind-down all-clear armed — awaiting idle",
            snapshot.session_id,
            snapshot.generation,
        );
        self.inject_if_idle(snapshot.session_id);
        true
    }

    /// Whether a pending instruction (any kind) is being shepherded for the
    /// session. The parker's eligibility/blocking decisions read this.
    pub fn has_pending(&self, session_id: u32) -> bool {
        // A stuck-alerted entry is still tracked (it delivers on the eventual
        // Stop) but must NOT read as pending: the parker's `blocks_completion`
        // would otherwise hold a hard park sweep open for the whole length of
        // the long turn that got it stuck.
        self.lock_pending()
            .get(&session_id)
            .is_some_and(|p| !p.stuck_alerted)
    }

    /// Whether a pending entry blocks a NEW soft wind-down (issue #131 fix
    /// L6): every kind except a [`PendingKind::WinddownAllClear`] — that one
    /// is stale the moment a real new episode is due, so `begin_soft_winddown`
    /// supersedes it instead of being blocked by it. Without this, an
    /// un-acked all-clear left over from a PRIOR episode silently ate every
    /// wind-down eligibility check for the session until it was acked (or
    /// timed out), so the session ran full speed through a real wind-down
    /// episode and then received a stale "resume full throughput".
    pub(crate) fn blocks_soft_winddown(&self, session_id: u32) -> bool {
        self.lock_pending()
            .get(&session_id)
            .is_some_and(|p| !p.stuck_alerted && p.kind != PendingKind::WinddownAllClear)
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
            self.on_idle(session_id, "already_idle");
        }
    }

    /// Idle signal for one session: decide-and-record synchronously, then
    /// hand the actual PTY write to the blocking pool. `gate` names the idle
    /// signal that let the injection through (issue #101) — it rides the
    /// INJECT audit row so the trail shows WHY Maestro typed at that moment.
    fn on_idle(&self, session_id: u32, gate: &'static str) {
        if let Some(data) = self.arm_injection_on_idle(session_id) {
            // The injection submits a prompt — the session is working again.
            self.idle_now
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&session_id);
            self.spawn_write(session_id, gate, data);
        }
    }

    /// Issue #109: everything that must only describe a REAL delivery,
    /// invoked by the writer's verdict callback. On `Ok` (the instruction
    /// body reached the PTY) it writes the one `INJECT phase=delivered`
    /// audit row per injection (issue #101 — instruction kind, bounded
    /// excerpt, attempt number, corrective flag, idle gate) and arms the
    /// replicator's Enter-resend watch (issue #103 — injector deliveries
    /// used to have none, so a swallowed Enter degraded to an ack_timeout).
    /// On `Err` it records a distinct `delivery_failed` ALERT instead — the
    /// pending entry stays, so the ACK ladder still times out and retries.
    ///
    /// Reads the entry back under its own short lock (the outcome fires
    /// right after the arm decision); a raced removal simply skips the rows.
    fn record_delivery_outcome(
        pending: &Mutex<HashMap<u32, PendingInstruction>>,
        audit: &AuditLog,
        replicator: Option<&Arc<SamuraiReplicator>>,
        session_id: u32,
        gate: &'static str,
        instruction: &str,
        result: Result<(), String>,
    ) {
        let entry = {
            let pending = pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            pending.get(&session_id).map(|p| {
                (
                    p.project.clone(),
                    p.epic.clone(),
                    p.generation,
                    p.kind,
                    p.attempts,
                    p.corrective,
                )
            })
        };
        let Some((project, epic, generation, kind, attempts, corrective)) = entry else {
            return;
        };
        match result {
            Ok(()) => {
                let (excerpt, total_chars) = super::samurai_audit::instruction_excerpt(instruction);
                audit.append(
                    &project,
                    AuditEvent::now(
                        epic.clone(),
                        AuditEventKind::Inject,
                        generation,
                        session_id,
                        json!({
                            "phase": "delivered",
                            "instruction": kind.as_str(),
                            "attempt": attempts,
                            "corrective": corrective,
                            "gate": gate,
                            "excerpt": excerpt,
                            "total_chars": total_chars,
                        }),
                    ),
                );
                if let Some(replicator) = replicator {
                    replicator.watch_delivery(&project, &epic, generation, session_id);
                }
            }
            Err(error) => {
                log::error!(
                    "samurai injector: {} instruction for session {session_id} never reached the PTY ({error}) — ALERT",
                    kind.as_str()
                );
                audit.append(
                    &project,
                    AuditEvent::now(
                        epic,
                        AuditEventKind::Alert,
                        generation,
                        session_id,
                        json!({
                            "kind": "delivery_failed",
                            "instruction": kind.as_str(),
                            "attempt": attempts,
                            "source": "injector",
                            "error": error,
                        }),
                    ),
                );
            }
        }
    }

    /// Decision + bookkeeping for an idle signal, no I/O. Returns the
    /// instruction text when an injection is due — WITHOUT a submit key:
    /// `samurai_pty::submit_instruction` sends the Enter as its own write, or
    /// the CLI reads text+CR as one paste and never submits it.
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
        p.injected_at = Some(AgeableInstant::now());
        p.awaiting_retry = false;
        // The long turn finally ended and the instruction went in: the entry
        // is live again, so it counts as pending once more and a later
        // genuine stall can raise its own stuck ALERT.
        p.stuck_alerted = false;
        log::info!(
            "samurai injector: session {session_id} idle — injecting {}{} instruction (attempt {})",
            if p.corrective { "corrective " } else { "" },
            p.kind.as_str(),
            p.attempts
        );
        Some(p.instruction.clone())
    }

    /// Write the instruction into the session's PTY through the injected
    /// writer (production: `samurai_pty::submit_instruction`, which submits
    /// with a separate Enter — a single text-plus-CR write is read as a
    /// paste and never submits). The `delivered` audit row and the
    /// Enter-resend watch ride the writer's verdict callback (issue #109),
    /// never the mere attempt.
    fn spawn_write(&self, session_id: u32, gate: &'static str, data: String) {
        let pending = self.pending.clone();
        let audit = self.audit.clone();
        let replicator = self.replicator.clone();
        let instruction = data.clone();
        let outcome: DeliveryOutcome = Box::new(move |result| {
            Self::record_delivery_outcome(
                &pending,
                &audit,
                replicator.as_ref(),
                session_id,
                gate,
                &instruction,
                result,
            );
        });
        (self.deliver)(session_id, data, outcome);
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
        let ack_row = {
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
            // Fix M7 (issue #131 review): an ACK for an entry that was never
            // actually delivered (attempts == 0) cannot be genuine — the
            // agent never saw the instruction to acknowledge. Without this,
            // a transcript replay (issue #118's byte-0 re-read) surfacing an
            // EARLIER episode's ack line before this entry's own first
            // delivery would spuriously complete a wind-down/all-clear the
            // agent never received.
            if p.attempts == 0 {
                log::warn!(
                    "samurai injector: ACK marker from session {session_id} for an undelivered instruction (attempts=0) — ignored"
                );
                return;
            }
            // Round-scoped (finding C) AND kind-scoped (issue #60): the
            // corrective round expects a DISTINCT value, so a transcript replay
            // of round 1's ACK (claude --resume rewrites history into a new
            // transcript, read from byte 0) can never consume the corrective
            // round — and a replayed handoff ACK can never consume a park.
            // Fix M7: also episode-scoped for the two ack-only kinds, whose
            // value otherwise repeats identically across episodes within one
            // generation (see `soft_winddown_ack_value`).
            let expected = expected_ack_value(p.kind, p.generation, p.corrective, p.episode);
            if value != expected {
                log::warn!(
                    "samurai injector: session {session_id} ACK value {value:?} does not match expected {expected:?} — ignored"
                );
                return;
            }
            log::info!(
                "samurai injector: session {session_id} ACKed {} (gen-{})",
                p.kind.as_str(),
                p.generation
            );
            // Issue #101: the positive ACK result, next to the delivered row
            // (the negative result stays the existing ack_timeout ALERT).
            let row = (
                p.project.clone(),
                AuditEvent::now(
                    p.epic.clone(),
                    AuditEventKind::Inject,
                    p.generation,
                    session_id,
                    json!({
                        "phase": "acked",
                        "instruction": p.kind.as_str(),
                        "attempt": p.attempts,
                        "corrective": p.corrective,
                    }),
                ),
            );
            // The ack-only kinds have no written stage: the ACK IS the
            // completion — stop tracking, the session keeps WORKING.
            if matches!(
                p.kind,
                PendingKind::SoftWinddown | PendingKind::WinddownAllClear
            ) {
                pending.remove(&session_id);
            } else {
                p.acked = true;
                p.acked_at = Some(AgeableInstant::now());
                p.awaiting_retry = false;
            }
            row
        };
        self.audit.append(&ack_row.0, ack_row.1);
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
            let Some(expected) = expected_written_value(p.kind, p.generation, p.corrective) else {
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
                validate_handoff(&dir, &relpath).map(|wip_commit| ValidatedHandoff {
                    relpath,
                    wip_commit,
                })
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

    /// Test-only view of a session's consecutive blind-tick count.
    #[cfg(test)]
    pub(crate) fn blind_ticks_view(&self, session_id: u32) -> Option<u32> {
        self.lock_blind().get(&session_id).map(|s| s.ticks)
    }

    fn lock_blind(&self) -> std::sync::MutexGuard<'_, HashMap<u32, BlindState>> {
        self.blind_ticks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Counts one tick of a WORKING session with no context reading. On the
    /// tick the count reaches [`BLIND_TICKS_BEFORE_ALERT`], blindness means
    /// the transcript stream is dead (the watch never attached, or silently
    /// died — issue #118), so the injector first tries to SELF-HEAL: one
    /// transcript rewatch per episode through the late-bound
    /// [`TranscriptRewatcher`], which resets the window so the fresh watch
    /// gets a full window to deliver a reading. The `context_blind` ALERT
    /// fires only when the reattach fails (or no rewatcher is bound), or
    /// when blindness persists a full further window after a successful
    /// reattach — exactly once per episode either way, since the count only
    /// equals the threshold once per (re)start and a reading clears the
    /// entry. The rewatch does bounded FS work inline on the tick — one
    /// `read_dir` over one directory, at most once per 5-minute episode
    /// (same budget class as the tick's per-session run-config read).
    fn note_blind_tick(&self, session: &SessionSnapshot) {
        let (ticks, rewatch_attempted) = {
            let mut blind = self.lock_blind();
            let entry = blind.entry(session.session_id).or_default();
            entry.ticks += 1;
            (entry.ticks, entry.rewatch_attempted)
        };
        if ticks != BLIND_TICKS_BEFORE_ALERT {
            return;
        }
        if !rewatch_attempted {
            if let Some(rewatch) = self.rewatch.get() {
                let healed = rewatch(session.session_id);
                {
                    let mut blind = self.lock_blind();
                    if let Some(entry) = blind.get_mut(&session.session_id) {
                        entry.rewatch_attempted = true;
                        if healed {
                            entry.ticks = 0;
                        }
                    }
                }
                if healed {
                    log::warn!(
                        "samurai injector: session {} had no context reading for {ticks} ticks — transcript watch re-attached; alerting only if blindness persists",
                        session.session_id
                    );
                    return;
                }
                log::warn!(
                    "samurai injector: session {} transcript rewatch failed — no transcript resolvable",
                    session.session_id
                );
            }
        }
        log::warn!(
            "samurai injector: session {} has had no context reading for {ticks} ticks — the handoff trigger is blind",
            session.session_id
        );
        self.audit.append(
            &session.project,
            AuditEvent::now(
                session.epic.clone(),
                AuditEventKind::Alert,
                session.generation,
                session.session_id,
                json!({ "kind": "context_blind", "ticks": ticks }),
            ),
        );
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
    ///
    /// Ages the clock by advancing its *reading* side (`AgeableInstant`'s
    /// extra elapsed time) rather than rewinding the stored `Instant` —
    /// `Instant::now().checked_sub(by)` underflows whenever machine uptime
    /// is shorter than `by` (issue #90), which made this flaky right after
    /// a reboot.
    #[cfg(test)]
    pub(crate) fn backdate_injection(&self, session_id: u32, by: Duration) {
        let mut pending = self.lock_pending();
        let p = pending.get_mut(&session_id).expect("no pending entry");
        p.injected_at
            .as_mut()
            .expect("nothing injected")
            .backdate(by);
    }

    /// Test-only: age the ACK so written-window paths run without waiting.
    /// See [`Self::backdate_injection`] for why this advances rather than
    /// rewinds the clock.
    #[cfg(test)]
    fn backdate_ack(&self, session_id: u32, by: Duration) {
        let mut pending = self.lock_pending();
        let p = pending.get_mut(&session_id).expect("no pending entry");
        p.acked_at.as_mut().expect("not acked").backdate(by);
    }

    /// Test-only: age the waiting clock so the stuck-wait cap (finding E)
    /// runs without real waiting. See [`Self::backdate_injection`] for why
    /// this advances rather than rewinds the clock.
    #[cfg(test)]
    fn backdate_waiting(&self, session_id: u32, by: Duration) {
        let mut pending = self.lock_pending();
        let p = pending.get_mut(&session_id).expect("no pending entry");
        p.waiting_since.backdate(by);
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
    /// The long-turn cap (`max_turn_wait_secs`) and one second past it. A
    /// never-injected entry waits for the END OF A TURN, so it is governed by
    /// this, not by the ACK window — a subagent wave plus a build+test run
    /// legitimately exceeds `TIMEOUT * 3`.
    const MAX_TURN_WAIT: Duration = Duration::from_secs(1800);
    const TURN_WAIT_OVER: Duration = Duration::from_secs(1801);
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
            (HandoffRequested, HandoffRequested, false, 2, true, false),  // never a third attempt
            (HandoffRequested, HandoffRequested, true, 0, false, false),  // ACKed before injection
            (HandoffRequested, HandoffRequested, true, 1, false, false),  // ACKed: done here
            (Working, HandoffRequested, false, 0, false, false),          // not in handoff
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
            // Finding E: the waiting states are age-capped, never forever —
            // but the two waits have DIFFERENT caps.
            // Never injected: a long turn (past the ACK cap, inside the
            // turn cap) is normal for an orchestrator running subagents.
            (false, 0, false, None, WAIT_OVER, Keep),
            (false, 0, false, None, TURN_WAIT_OVER, AlertStuck), // Stop never came
            // Armed retry: the agent already finished a turn once, so the
            // shorter ACK-derived cap still applies.
            (false, 1, true, OVER, WAIT_OVER, AlertStuck), // idle never came
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
                timeout_verdict(
                    acked,
                    attempts,
                    awaiting_retry,
                    elapsed,
                    waiting,
                    TIMEOUT,
                    MAX_TURN_WAIT
                ),
                expected,
                "acked={acked} attempts={attempts} awaiting_retry={awaiting_retry} elapsed={elapsed:?} waiting={waiting:?}"
            );
        }
    }

    #[test]
    fn test_timeout_boundary_is_strict() {
        // "no ACK within N seconds": exactly N is still within.
        assert_eq!(
            timeout_verdict(
                false,
                1,
                false,
                Some(TIMEOUT),
                WAIT_OK,
                TIMEOUT,
                MAX_TURN_WAIT
            ),
            TimeoutVerdict::Keep
        );
        assert_eq!(
            timeout_verdict(
                false,
                1,
                false,
                Some(TIMEOUT + Duration::from_millis(1)),
                WAIT_OK,
                TIMEOUT,
                MAX_TURN_WAIT
            ),
            TimeoutVerdict::ArmRetry
        );
        // The never-injected cap is equally strict: exactly max_turn_wait is
        // still within.
        assert_eq!(
            timeout_verdict(false, 0, false, None, MAX_TURN_WAIT, TIMEOUT, MAX_TURN_WAIT),
            TimeoutVerdict::Keep
        );
        assert_eq!(
            timeout_verdict(
                false,
                0,
                false,
                None,
                MAX_TURN_WAIT + Duration::from_millis(1),
                TIMEOUT,
                MAX_TURN_WAIT
            ),
            TimeoutVerdict::AlertStuck
        );
        // …and the armed-retry cap keeps its own strict timeout*3 boundary.
        assert_eq!(
            timeout_verdict(false, 1, true, OVER, TIMEOUT * 3, TIMEOUT, MAX_TURN_WAIT),
            TimeoutVerdict::Keep
        );
        assert_eq!(
            timeout_verdict(
                false,
                1,
                true,
                OVER,
                TIMEOUT * 3 + Duration::from_millis(1),
                TIMEOUT,
                MAX_TURN_WAIT
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

        // File present (untracked .maestro/), tree clean → valid, and the
        // WIP commit SHA (HEAD) rides along for the audit row (issue #101).
        write_handoff_file(repo, "#9", 1);
        let sha = validate_handoff(repo, &rel).unwrap().expect("HEAD sha");
        assert_eq!(sha.len(), 40, "full git SHA expected: {sha}");
        assert!(sha.chars().all(|c| c.is_ascii_hexdigit()));

        // Extra untracked files stay acceptable.
        std::fs::write(repo.join("scratch.txt"), "tmp\n").unwrap();
        assert_eq!(validate_handoff(repo, &rel), Ok(Some(sha)));

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
    /// The injected writer confirms every body write synchronously (issue
    /// #109) — tests drive the decision paths (`tick` /
    /// `arm_injection_on_idle` / `observe`) and the delivered rows behave
    /// exactly as production's post-write verdict. The dir resolver serves
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
        let deliver: StdinWriter = Arc::new(|_, _, outcome: DeliveryOutcome| outcome(Ok(())));
        let injector = SamuraiInjector::new(
            supervisor.clone(),
            context.clone(),
            config,
            deliver,
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

    /// The whole production chain, from a transcript APPEND to the requested
    /// handoff: watcher → parser → EventBus → context store → trigger. Every
    /// link is unit-tested in isolation, but nothing exercised them together,
    /// so a break in a seam (the `lib.rs` tee's shape, the notify wake-path
    /// match, the session-id key shared by watcher and supervisor) could not
    /// fail a test. Numbers are a real run's: `claude-opus-5` at 441,033
    /// context tokens = 44.1% of the 1M window, past the 40% default.
    #[tokio::test]
    async fn test_transcript_append_drives_the_trigger_end_to_end() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context, _dirs) = harness(dir.path());

        // The bus callback is the one `lib.rs` installs: the context store
        // observes every deduped event before anything else sees it.
        let context_for_bus = context.clone();
        let bus = Arc::new(crate::core::event_bus::EventBus::new(Arc::new(
            move |event: ClaudeEvent| context_for_bus.observe(&event),
        )));
        let watcher = crate::core::transcript_watcher::TranscriptWatcher::new(bus);

        let transcript = dir.path().join("session.jsonl");
        std::fs::write(&transcript, "").unwrap();
        let transcript = transcript.canonicalize().unwrap();
        watcher.start_watching(13, transcript.clone());

        supervisor
            .register_session(13, "C:/git/proj-e2e".into(), "EPic #2".into(), 1)
            .unwrap();
        injector.tick();
        assert_eq!(
            injector.session_state(13),
            Some(Working),
            "no context reading yet: the session stays WORKING"
        );

        // 4 + 1_029 + 440_000 = 441_033 tokens.
        let line = r#"{"parentUuid":"u-1","isSidechain":false,"type":"assistant","message":{"model":"claude-opus-5","id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"working"}],"usage":{"input_tokens":4,"output_tokens":120,"cache_creation_input_tokens":1029,"cache_read_input_tokens":440000}},"uuid":"u-2","timestamp":"2026-08-14T13:58:09.201Z"}"#;
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&transcript)
                .unwrap();
            writeln!(f, "{line}").unwrap();
        }

        wait_until(|| context.percent(13).is_some()).await;
        assert_eq!(
            context.percent(13),
            Some(44.1),
            "the watcher-derived percentage must match Claude Code's /context"
        );

        injector.tick();
        assert_eq!(
            injector.session_state(13),
            Some(HandoffRequested),
            "44.1% is past the 40% default: the tick must request the handoff"
        );
    }

    /// A WORKING session that never gets a context reading can never hand
    /// off. Before the blindness detector that failed in total silence — the
    /// audit trail of a blind run and of a run merely sitting under the
    /// threshold were identical, which is what made a real failure
    /// undiagnosable after the fact.
    #[tokio::test]
    async fn test_a_session_with_no_context_reading_alerts_once() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-blind";
        supervisor
            .register_session(1, project.into(), "epic-blind".into(), 1)
            .unwrap();

        let alerts = |rows: Vec<AuditEvent>| {
            rows.into_iter()
                .filter(|r| {
                    r.event == AuditEventKind::Alert && r.details["kind"] == "context_blind"
                })
                .count()
        };

        // Nine blind ticks stay quiet: a slow first assistant message must
        // never raise an alert.
        for _ in 0..(BLIND_TICKS_BEFORE_ALERT - 1) {
            injector.tick();
        }
        assert_eq!(
            alerts(audit.read(project, None, None).await.unwrap().events),
            0
        );

        // The tenth says it, once — further blind ticks stay silent.
        injector.tick();
        injector.tick();
        injector.tick();
        assert_eq!(
            alerts(audit.read(project, None, None).await.unwrap().events),
            1,
            "the blindness alert fires exactly once per session"
        );
        assert_eq!(
            injector.session_state(1),
            Some(Working),
            "alerting never moves the session"
        );

        // A reading arriving clears the count, so a later blind spell can
        // alert again rather than being masked by the first one.
        context.observe(&context_event(1, 10.0));
        injector.tick();
        assert!(injector.blind_ticks_view(1).is_none());
    }

    /// Issue #118: blindness means a dead transcript stream — observed live
    /// as zero context readings, undetected ACK markers, a false
    /// ack_timeout, and a session stuck PARKING forever. Before alerting,
    /// the injector must SELF-HEAL: re-resolve and re-attach the watch via
    /// the injected rewatcher, hold the alert while the fresh watch gets a
    /// full window, and alert only if blindness persists.
    #[tokio::test]
    async fn test_blindness_reattaches_the_watch_and_holds_the_alert() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, _context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-blind-heal";
        supervisor
            .register_session(1, project.into(), "epic-blind".into(), 1)
            .unwrap();
        let rewatched: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
        let rewatched_rec = rewatched.clone();
        injector.set_rewatcher(Arc::new(move |session_id| {
            rewatched_rec.lock().unwrap().push(session_id);
            true
        }));
        let alerts = |rows: Vec<AuditEvent>| {
            rows.into_iter()
                .filter(|r| {
                    r.event == AuditEventKind::Alert && r.details["kind"] == "context_blind"
                })
                .count()
        };

        // The blindness threshold: the rewatcher heals instead of alerting,
        // and the fresh watch gets a fresh full window.
        for _ in 0..BLIND_TICKS_BEFORE_ALERT {
            injector.tick();
        }
        assert_eq!(
            *rewatched.lock().unwrap(),
            vec![1],
            "one reattach at the threshold"
        );
        assert_eq!(
            alerts(audit.read(project, None, None).await.unwrap().events),
            0,
            "a successful reattach holds the alert"
        );
        assert_eq!(
            injector.blind_ticks_view(1),
            Some(0),
            "the reattached watch gets a full fresh window"
        );

        // Still blind a full window later: the reattach did not cure it —
        // the alert fires now, and the episode never re-heals.
        for _ in 0..BLIND_TICKS_BEFORE_ALERT {
            injector.tick();
        }
        injector.tick();
        assert_eq!(
            *rewatched.lock().unwrap(),
            vec![1],
            "one heal attempt per blind episode"
        );
        assert_eq!(
            alerts(audit.read(project, None, None).await.unwrap().events),
            1,
            "persistent blindness after the reattach alerts once"
        );
    }

    /// Issue #118: when the reattach fails (no transcript resolvable), the
    /// original `context_blind` ALERT must fire exactly as before — the
    /// self-heal replaces the alert only when it actually reattached.
    #[tokio::test]
    async fn test_blindness_alerts_when_the_reattach_fails() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, _context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-blind-fail";
        supervisor
            .register_session(1, project.into(), "epic-blind".into(), 1)
            .unwrap();
        let rewatched: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
        let rewatched_rec = rewatched.clone();
        injector.set_rewatcher(Arc::new(move |session_id| {
            rewatched_rec.lock().unwrap().push(session_id);
            false
        }));

        for _ in 0..BLIND_TICKS_BEFORE_ALERT {
            injector.tick();
        }
        injector.tick();
        assert_eq!(*rewatched.lock().unwrap(), vec![1], "reattach was tried");
        let rows = audit.read(project, None, None).await.unwrap().events;
        assert_eq!(
            rows.into_iter()
                .filter(|r| {
                    r.event == AuditEventKind::Alert && r.details["kind"] == "context_blind"
                })
                .count(),
            1,
            "a failed reattach keeps the alert, once"
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
        // Just under the PRD §7 default handoff trigger (40%).
        context.observe(&context_event(1, 39.9));

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

        // First idle → attempt 1, a single pasteable block with NO submit
        // key: samurai_pty writes the Enter separately, or the CLI reads
        // text+CR as one paste and never submits it.
        let data = injector.arm_injection_on_idle(1).expect("must inject");
        assert!(!data.contains('\r'), "no submit key in the payload");
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

    // --- issue #101: INJECT audit rows (delivery + ACK result) ---

    #[tokio::test]
    async fn test_injection_and_ack_land_inject_audit_rows() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-audit";
        supervisor
            .register_session(1, project.into(), "epic-7".into(), 3)
            .unwrap();
        context.observe(&context_event(1, 50.0));
        injector.tick(); // WORKING → HANDOFF_REQUESTED, instruction pending

        // The Stop hook gates the injection → one INJECT phase=delivered row
        // with the kind, attempt, gate and a bounded excerpt.
        injector.observe_hook(&stop_event(1));
        let rows = audit.read(project, None, None).await.unwrap().events;
        let delivered: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Inject && r.details["phase"] == "delivered")
            .collect();
        assert_eq!(delivered.len(), 1);
        let d = delivered[0];
        assert_eq!(d.epic, "epic-7");
        assert_eq!(d.generation, 3);
        assert_eq!(d.session_id, 1);
        assert_eq!(d.details["instruction"], "handoff");
        assert_eq!(d.details["attempt"], 1);
        assert_eq!(d.details["corrective"], false);
        assert_eq!(d.details["gate"], "stop_hook");
        let full = samurai_prompts::handoff_instruction("epic-7", 3);
        let excerpt = d.details["excerpt"].as_str().unwrap();
        assert!(full.starts_with(excerpt), "excerpt is a prefix of the text");
        assert!(excerpt.chars().count() <= crate::core::samurai_audit::EXCERPT_MAX_CHARS);
        assert_eq!(
            d.details["total_chars"].as_u64().unwrap() as usize,
            full.chars().count()
        );

        // The matching ACK → one INJECT phase=acked row (the positive
        // result; the negative one stays the ack_timeout ALERT).
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>handoff gen-3</samurai-ack>",
        ));
        let rows = audit.read(project, None, None).await.unwrap().events;
        let acked: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Inject && r.details["phase"] == "acked")
            .collect();
        assert_eq!(acked.len(), 1);
        assert_eq!(acked[0].session_id, 1);
        assert_eq!(acked[0].generation, 3);
        assert_eq!(acked[0].details["instruction"], "handoff");
        assert_eq!(acked[0].details["attempt"], 1);
        assert_eq!(acked[0].details["corrective"], false);

        // A wrong-value ACK never lands a row (exact-value discipline).
        let before = rows.len();
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>handoff gen-99</samurai-ack>",
        ));
        let rows = audit.read(project, None, None).await.unwrap().events;
        assert_eq!(rows.len(), before);
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
        let written = rows
            .iter()
            .find(|r| r.event == AuditEventKind::Handoff && r.details["phase"] == "written")
            .expect("HANDOFF phase=written row");
        // Issue #101: the row records WHERE the handoff file is and the WIP
        // commit the validation saw, so the trail is replayable.
        assert_eq!(
            written.details["handoff_file"],
            samurai_prompts::handoff_file_relpath("epic-9", 2)
        );
        let sha = written.details["wip_commit"].as_str().unwrap();
        assert_eq!(sha.len(), 40, "full git SHA expected: {sha}");
        assert!(sha.chars().all(|c| c.is_ascii_hexdigit()));
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
        assert!(!data.contains('\r') && !data.contains('\n'));

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
            injector
                .pending_detail(1)
                .map(|(_, validating, _)| validating),
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

        // Inside the cap: kept, still waiting. A turn long enough to blow the
        // ACK window is normal for an orchestrator running subagents, so the
        // never-injected wait is governed by max_turn_wait, not ack_timeout*3.
        injector.tick();
        assert!(injector.pending_view(1).is_some());
        injector.backdate_waiting(1, WAIT_OVER);
        injector.tick();
        assert!(
            injector.pending_view(1).is_some(),
            "a long turn is not a stall"
        );

        // Past max_turn_wait with no injection possible: single ALERT with
        // the never_idled flavor — but tracking CONTINUES. The turn ends
        // eventually and the instruction is still owed; dropping the entry
        // here used to strand the epic with no handoff, no park and no
        // recovery for the rest of the app's lifetime.
        injector.backdate_waiting(1, TURN_WAIT_OVER);
        injector.tick();
        assert!(
            injector.pending_view(1).is_some(),
            "still tracked after the stuck ALERT"
        );
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
        assert_eq!(
            alerts[0].details["still_tracked"], true,
            "the audit row says the instruction is still owed"
        );

        // Further ticks stay quiet — the ALERT is latched, not re-fired.
        injector.tick();
        let rows = audit.read(project, None, None).await.unwrap().events;
        assert_eq!(
            rows.iter()
                .filter(|r| r.details["kind"] == "ack_timeout")
                .count(),
            1
        );

        // The parker must not count a stuck entry as pending, or a hard park
        // sweep would stay open for the whole length of the long turn.
        assert!(
            !injector.has_pending(1),
            "stuck entry does not block a sweep"
        );

        // The long turn finally ends: the instruction goes in after all, and
        // the entry counts as live again.
        assert!(
            injector.arm_injection_on_idle(1).is_some(),
            "late idle delivers"
        );
        assert_eq!(injector.pending_view(1), Some((1, false, false)));
        assert!(injector.has_pending(1), "live again once injected");
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

        // An ARMED RETRY keeps the shorter ack_timeout*3 cap: the agent has
        // already finished one turn, so its next Stop is not far off.
        injector.backdate_waiting(1, WAIT_OVER);
        injector.tick();
        assert!(
            injector.pending_view(1).is_some(),
            "still tracked after the stuck ALERT"
        );

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
        assert_eq!(alerts[0].details["still_tracked"], true);

        // The retry still lands when the idle finally arrives.
        assert!(
            !injector.has_pending(1),
            "stuck entry does not block a sweep"
        );
        assert!(
            injector.arm_injection_on_idle(1).is_some(),
            "late idle delivers"
        );
        assert_eq!(injector.pending_view(1), Some((2, false, false)));
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
        assert!(!data.contains('\r') && !data.contains('\n'));

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
            injector
                .pending_detail(1)
                .map(|(_, validating, _)| validating),
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
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>park gen-2</samurai-ack>",
        ));
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
        assert_eq!(
            timers.len(),
            1,
            "the sweep's LAST park must arm its resume timer"
        );
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
        assert!(
            data.contains("<samurai-handoff-written>gen-2 park retry</samurai-handoff-written>")
        );

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
        assert!(data.contains("<samurai-ack>winddown gen-3-1</samurai-ack>"));
        assert!(!data.contains("<samurai-handoff-written>"));
        assert_eq!(injector.session_state(1), Some(Working));

        // The ACK alone completes the entry — no state change, and a later
        // idle injects nothing. The only extra audit row is the INJECT
        // phase=acked record (issue #101); the wind-down stays stateless
        // supervisor-side (no HANDOFF/PARK/ALERT rows).
        injector.observe(&assistant_message(
            1,
            "Winding down. <samurai-ack>winddown gen-3-1</samurai-ack>",
        ));
        assert!(injector.pending_view(1).is_none());
        assert_eq!(injector.session_state(1), Some(Working));
        assert!(injector.arm_injection_on_idle(1).is_none());
        let rows = audit.read(project, None, None).await.unwrap().events;
        assert_eq!(rows.len(), 2, "SPAWN + the INJECT acked record only");
        assert_eq!(rows[0].event, AuditEventKind::Spawn);
        assert_eq!(rows[1].event, AuditEventKind::Inject);
        assert_eq!(rows[1].details["phase"], "acked");
        assert_eq!(rows[1].details["instruction"], "soft_winddown");
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

    // --- issue #120: the wind-down all-clear ladder ---

    #[tokio::test]
    async fn test_winddown_allclear_ack_completes_without_any_transition() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, _context, _dirs) = harness(dir.path());
        let project = "C:/git/proj-inj-allclear";
        let snapshot = supervisor
            .register_session(1, project.into(), "epic-9".into(), 3)
            .unwrap();

        // The episode: a wind-down delivered and acked.
        assert!(injector.begin_soft_winddown(&snapshot));
        injector.arm_injection_on_idle(1).expect("winddown attempt");
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>winddown gen-3-1</samurai-ack>",
        ));
        assert!(injector.pending_view(1).is_none());

        // Recovery: the all-clear arms, injects on idle, and is ack-only.
        assert!(injector.begin_winddown_allclear(&snapshot));
        let data = injector.arm_injection_on_idle(1).expect("allclear attempt");
        assert!(data.contains("<samurai-ack>allclear gen-3-1</samurai-ack>"));
        assert!(!data.contains("<samurai-handoff-written>"));
        assert_eq!(injector.session_state(1), Some(Working));

        // The ACK alone completes it — no state change, nothing left to
        // inject, and the audit trail shows the acked all-clear.
        injector.observe(&assistant_message(
            1,
            "Back to full speed. <samurai-ack>allclear gen-3-1</samurai-ack>",
        ));
        assert!(injector.pending_view(1).is_none());
        assert_eq!(injector.session_state(1), Some(Working));
        assert!(injector.arm_injection_on_idle(1).is_none());
        let rows = audit.read(project, None, None).await.unwrap().events;
        let acked: Vec<&AuditEvent> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Inject && r.details["phase"] == "acked")
            .collect();
        assert_eq!(acked.len(), 2, "wind-down ack + all-clear ack");
        assert_eq!(acked[1].details["instruction"], "winddown_allclear");
    }

    #[tokio::test]
    async fn test_winddown_allclear_supersedes_only_a_delivered_winddown() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, _context, _dirs) = harness(dir.path());
        let snapshot = supervisor
            .register_session(1, "C:/git/proj-inj-allclear2".into(), "epic-9".into(), 2)
            .unwrap();

        // Delivered but not yet acked: the all-clear replaces it — the next
        // idle injects the all-clear, never the stale wind-down.
        assert!(injector.begin_soft_winddown(&snapshot));
        injector
            .arm_injection_on_idle(1)
            .expect("winddown delivered");
        assert!(injector.begin_winddown_allclear(&snapshot));
        let data = injector.arm_injection_on_idle(1).expect("allclear attempt");
        assert!(data.contains("<samurai-ack>allclear gen-2-1</samurai-ack>"));
        assert!(!data.contains("winddown"));
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>allclear gen-2-1</samurai-ack>",
        ));

        // Any OTHER pending instruction refuses the all-clear outright.
        let parked = supervisor.transition(1, ParkRequested).unwrap();
        injector.begin_park(&parked);
        assert!(!injector.begin_winddown_allclear(&parked));
        let data = injector.arm_injection_on_idle(1).expect("park attempt");
        assert!(data.contains("<samurai-ack>park gen-2</samurai-ack>"));
    }

    #[tokio::test]
    async fn test_winddown_allclear_cancels_an_undelivered_winddown_silently() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, _context, _dirs) = harness(dir.path());
        let snapshot = supervisor
            .register_session(1, "C:/git/proj-inj-allclear3".into(), "epic-9".into(), 2)
            .unwrap();

        // Armed but never injected: the agent never saw a wind-down, so
        // there is nothing to clear — cancel the stale entry, send nothing.
        assert!(injector.begin_soft_winddown(&snapshot));
        assert!(!injector.begin_winddown_allclear(&snapshot));
        assert!(
            injector.pending_view(1).is_none(),
            "stale wind-down cancelled"
        );
        assert!(injector.arm_injection_on_idle(1).is_none());
    }

    #[tokio::test]
    async fn test_begin_soft_winddown_supersedes_a_pending_winddown_allclear() {
        // Fix L6 (issue #131 review): a pending, un-acked all-clear left
        // over from an EARLIER episode must not block a REAL new wind-down
        // episode — the stale all-clear is superseded outright, the same
        // way an all-clear supersedes a delivered wind-down.
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, _context, _dirs) = harness(dir.path());
        let snapshot = supervisor
            .register_session(1, "C:/git/proj-inj-super2".into(), "epic-9".into(), 2)
            .unwrap();

        // Episode 1: delivered and acked wind-down, then the all-clear arms
        // but is never acked — it sits pending, un-acked, stale.
        assert!(injector.begin_soft_winddown(&snapshot));
        injector
            .arm_injection_on_idle(1)
            .expect("winddown delivered");
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>winddown gen-2-1</samurai-ack>",
        ));
        assert!(injector.begin_winddown_allclear(&snapshot));
        assert!(injector.has_pending(1), "the all-clear is armed, un-acked");

        // Episode 2's real wind-down supersedes the stale all-clear outright
        // — the next idle injects the NEW wind-down (its OWN episode-2
        // value, distinct from episode 1's), never the stale all-clear.
        assert!(injector.begin_soft_winddown(&snapshot));
        let data = injector
            .arm_injection_on_idle(1)
            .expect("the new wind-down attempt");
        assert!(data.contains("<samurai-ack>winddown gen-2-2</samurai-ack>"));
        assert!(!data.contains("allclear"));

        // Any OTHER pending instruction still refuses a new wind-down
        // outright — only WinddownAllClear is superseded.
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>winddown gen-2-2</samurai-ack>",
        ));
        assert!(injector.pending_view(1).is_none());
        let parked = supervisor.transition(1, ParkRequested).unwrap();
        injector.begin_park(&parked);
        assert!(!injector.begin_soft_winddown(&parked));
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

    // --- issue #131 fix M7: replay-safe wind-down/all-clear acks ---

    #[tokio::test]
    async fn test_scan_ack_ignores_an_undelivered_instruction() {
        // A pending entry with attempts == 0 was never actually injected —
        // the agent cannot have acked it for real, so a marker matching its
        // expected value (e.g. a transcript replay surfacing an EARLIER
        // episode's identical text before THIS entry's own delivery) must
        // not complete it.
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, _context, _dirs) = harness(dir.path());
        let snapshot = supervisor
            .register_session(1, "C:/git/proj-inj-undelivered".into(), "epic-9".into(), 5)
            .unwrap();

        assert!(injector.begin_soft_winddown(&snapshot));
        assert!(injector.has_pending(1));
        // No `arm_injection_on_idle` call — attempts stays 0.
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>winddown gen-5-1</samurai-ack>",
        ));
        assert!(
            injector.has_pending(1),
            "an ack for an undelivered instruction must not complete it"
        );

        // The NORMAL path still works once actually delivered.
        injector.arm_injection_on_idle(1).expect("now delivered");
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>winddown gen-5-1</samurai-ack>",
        ));
        assert!(
            injector.pending_view(1).is_none(),
            "the real ack completes it"
        );
    }

    #[tokio::test]
    async fn test_scan_ack_replay_of_an_earlier_episode_cannot_complete_a_later_one() {
        // Issue #118: `restart_watching`'s blind-heal re-reads the transcript
        // from byte 0. Episode 1's ack line is textually IDENTICAL across
        // episodes but for the episode number — a replay of episode 1's
        // line must never satisfy episode 2's still-pending, already-
        // delivered entry.
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, _context, _dirs) = harness(dir.path());
        let snapshot = supervisor
            .register_session(1, "C:/git/proj-inj-replay".into(), "epic-9".into(), 5)
            .unwrap();

        // Episode 1: delivered and genuinely acked — the entry is gone.
        assert!(injector.begin_soft_winddown(&snapshot));
        injector
            .arm_injection_on_idle(1)
            .expect("episode 1 delivered");
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>winddown gen-5-1</samurai-ack>",
        ));
        assert!(injector.pending_view(1).is_none());

        // Episode 2: a fresh wind-down, delivered (attempts > 0) — its
        // expected value is episode-scoped, distinct from episode 1's.
        assert!(injector.begin_soft_winddown(&snapshot));
        let data = injector
            .arm_injection_on_idle(1)
            .expect("episode 2 delivered");
        assert!(data.contains("<samurai-ack>winddown gen-5-2</samurai-ack>"));

        // The blind-heal replay: episode 1's OLD ack line resurfaces.
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>winddown gen-5-1</samurai-ack>",
        ));
        assert!(
            injector.has_pending(1),
            "a replayed EARLIER episode's ack must not complete a LATER one"
        );

        // The NORMAL path: episode 2's own, correct value still completes it.
        injector.observe(&assistant_message(
            1,
            "<samurai-ack>winddown gen-5-2</samurai-ack>",
        ));
        assert!(
            injector.pending_view(1).is_none(),
            "the real ack completes it"
        );
    }
}
