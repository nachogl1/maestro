//! Samurai injection controller (Phase 2, issue #53; PRD §5.3/§5.4).
//!
//! Turns the context-percentage signal (P2.1's [`SamuraiContextStore`]) into
//! the first real supervisor *action*: when a WORKING session crosses
//! `handoff_context_pct`, request a handoff and type the instruction into
//! the session's terminal. Maestro types blindly (PRD §5.3), so two guards
//! apply:
//!
//! 1. **Idle gate** — the instruction is written only after the Stop hook
//!    reports the agent finished its turn (`SessionEnded { reason: "stop" }`),
//!    never on trigger alone. The signal is tapped in `lib.rs`'s
//!    `hook_emit_fn` chain via [`observe_hook`](SamuraiInjector::observe_hook),
//!    NOT the EventBus tee: the bus dedup key for `SessionEnded` ignores
//!    `reason` (5s window, see `claude_event.rs`), so a Stop landing shortly
//!    after a SessionEnd — or after another Stop — could be swallowed before
//!    it ever reached a bus-side tee.
//! 2. **ACK protocol** — the instruction requires the orchestrator to reply
//!    with `<samurai-ack>handoff gen-N</samurai-ack>`; the scanner reads
//!    every `AssistantMessage` from the EventBus tee (same spot as the
//!    context store) via [`observe`](SamuraiInjector::observe). No ACK
//!    within `ack_timeout_secs` → one retry at the next idle → still
//!    nothing → `ALERT` audit row (`details.kind = "ack_timeout"`) and the
//!    session stays in HANDOFF_REQUESTED for human attention.
//!
//! Loop shape mirrors `samurai_watchdog`: one periodic tick, decisions as
//! pure functions with table tests, I/O at the edges. Advancing beyond
//! HANDOFF_REQUESTED (handoff file, HANDOFF_WRITTEN) is P2.3.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;

use super::claude_event::ClaudeEvent;
use super::process_manager::ProcessManager;
use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_config::SharedSamuraiConfig;
use super::samurai_context::SamuraiContextStore;
use super::samurai_prompts;
use super::supervisor::{Supervisor, SupervisorState};

/// How often the trigger/timeout pass runs (same cadence as the watchdog).
pub const TICK_INTERVAL: Duration = Duration::from_secs(30);

/// The ACK marker tag the injected instruction requires in the reply.
pub const ACK_TAG: &str = "samurai-ack";

/// One instruction the controller is shepherding from trigger to ACK.
/// Created when the trigger transitions a session into HANDOFF_REQUESTED;
/// dropped when the session leaves that state or the final timeout ALERTs.
struct PendingInstruction {
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
    /// The orchestrator replied with the expected ACK marker.
    acked: bool,
    /// Attempt 1 timed out; re-inject at the next idle signal.
    awaiting_retry: bool,
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

/// Whether an idle signal should inject now. First idle after the trigger →
/// attempt 1; after attempt 1 times out (never on an idle alone — a reply
/// without the marker must not burn the retry), the next idle → attempt 2;
/// beyond that, or once ACKed, never.
fn should_inject_on_idle(
    state: SupervisorState,
    acked: bool,
    attempts: u8,
    awaiting_retry: bool,
) -> bool {
    if state != SupervisorState::HandoffRequested || acked {
        return false;
    }
    match attempts {
        0 => true,
        1 => awaiting_retry,
        _ => false,
    }
}

/// What the tick's timeout pass concluded about one pending instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimeoutVerdict {
    /// Nothing to do this tick.
    Keep,
    /// Attempt 1 ran out of time: arm the retry for the next idle signal.
    ArmRetry,
    /// The retry ran out of time too: ALERT once and stop tracking.
    Alert,
}

/// Pure timeout decision. `elapsed` is time since the latest injection
/// (`None` = not injected yet, still waiting for the first idle). The
/// timeout is strict (`> timeout`), matching "no ACK within N seconds".
fn timeout_verdict(
    acked: bool,
    attempts: u8,
    awaiting_retry: bool,
    elapsed: Option<Duration>,
    timeout: Duration,
) -> TimeoutVerdict {
    if acked || awaiting_retry {
        return TimeoutVerdict::Keep; // resolved, or already waiting for idle
    }
    let Some(elapsed) = elapsed else {
        return TimeoutVerdict::Keep; // nothing injected yet — no clock running
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

/// Pull the inner text of the first `<samurai-ack>…</samurai-ack>` pair out
/// of an assistant message. Same deliberate plain string scan as
/// `transcript_parser::tag_value` — no XML parser, and a malformed blob
/// simply yields `None`.
fn ack_value(text: &str) -> Option<String> {
    let open = format!("<{ACK_TAG}>");
    let close = format!("</{ACK_TAG}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].trim().to_string())
}

/// The injection controller. Fed from three directions: the periodic tick
/// (trigger + timeouts), the hook chain (idle signals), and the EventBus tee
/// (ACK scanning). All state lives behind one uncontended `Mutex`; no lock
/// is ever held across an await point.
pub struct SamuraiInjector {
    supervisor: Arc<Supervisor>,
    context: Arc<SamuraiContextStore>,
    config: SharedSamuraiConfig,
    processes: ProcessManager,
    audit: AuditLog,
    pending: Mutex<HashMap<u32, PendingInstruction>>,
}

impl SamuraiInjector {
    pub fn new(
        supervisor: Arc<Supervisor>,
        context: Arc<SamuraiContextStore>,
        config: SharedSamuraiConfig,
        processes: ProcessManager,
        audit: AuditLog,
    ) -> Self {
        Self {
            supervisor,
            context,
            config,
            processes,
            audit,
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// EventBus tee (same spot as `SamuraiContextStore::observe`): scan
    /// assistant replies for the ACK marker. Every other variant is ignored,
    /// so the tee can pass the whole stream without filtering.
    pub fn observe(&self, event: &ClaudeEvent) {
        if let ClaudeEvent::AssistantMessage {
            session_id, text, ..
        } = event
        {
            self.scan_ack(*session_id, text);
        }
    }

    /// Hook-chain tee (`hook_emit_fn` in `lib.rs`, pre-dedup — see module
    /// doc for why the idle signal cannot ride the EventBus tee).
    pub fn observe_hook(&self, event: &ClaudeEvent) {
        if let Some(session_id) = idle_session_id(event) {
            self.on_idle(session_id);
        }
    }

    /// One trigger + timeout pass. Called from the spawned loop; fully
    /// synchronous.
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

        // Trigger pass: WORKING sessions past the threshold request a
        // handoff. The state machine enforces one-in-flight and handoff/park
        // exclusivity and writes the HANDOFF(phase=requested) audit row; a
        // rejected transition already produced its illegal_transition ALERT.
        for session in self.supervisor.list_sessions() {
            let percent = self.context.percent(session.session_id);
            if !should_request_handoff(session.state, percent, threshold_pct) {
                continue;
            }
            match self
                .supervisor
                .transition(session.session_id, SupervisorState::HandoffRequested)
            {
                Ok(snapshot) => {
                    log::info!(
                        "samurai injector: session {} at {:.1}% (threshold {threshold_pct}%) — handoff requested, awaiting idle",
                        snapshot.session_id,
                        percent.unwrap_or_default(),
                    );
                    self.lock_pending().insert(
                        snapshot.session_id,
                        PendingInstruction {
                            project: snapshot.project.clone(),
                            epic: snapshot.epic.clone(),
                            generation: snapshot.generation,
                            instruction: samurai_prompts::handoff_instruction(
                                snapshot.generation,
                            ),
                            attempts: 0,
                            injected_at: None,
                            acked: false,
                            awaiting_retry: false,
                        },
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

        let alerts: Vec<(String, AuditEvent)> = {
            let mut pending = self.lock_pending();

            // An entry is only meaningful while its session sits in
            // HANDOFF_REQUESTED: P2.3 advancing it, the watchdog declaring it
            // DEAD, or teardown unregistering it all end the tracking.
            pending.retain(|id, _| {
                let keep = state_of.get(id) == Some(&SupervisorState::HandoffRequested);
                if !keep {
                    log::info!(
                        "samurai injector: session {id} left HANDOFF_REQUESTED — dropping pending instruction"
                    );
                }
                keep
            });

            let mut alerts = Vec::new();
            for (id, p) in pending.iter_mut() {
                match timeout_verdict(
                    p.acked,
                    p.attempts,
                    p.awaiting_retry,
                    p.injected_at.map(|t| t.elapsed()),
                    timeout,
                ) {
                    TimeoutVerdict::Keep => {}
                    TimeoutVerdict::ArmRetry => {
                        log::warn!(
                            "samurai injector: session {id} did not ACK within {timeout:?} — retrying at next idle"
                        );
                        p.awaiting_retry = true;
                    }
                    TimeoutVerdict::Alert => {
                        alerts.push((
                            *id,
                            p.project.clone(),
                            AuditEvent::now(
                                p.epic.clone(),
                                AuditEventKind::Alert,
                                p.generation,
                                *id,
                                json!({ "kind": "ack_timeout", "attempts": p.attempts }),
                            ),
                        ));
                    }
                }
            }
            // Alerted sessions stop being tracked (the removal is what makes
            // the ALERT fire exactly once); they stay in HANDOFF_REQUESTED
            // for human attention.
            for (id, _, _) in &alerts {
                pending.remove(id);
            }
            alerts
                .into_iter()
                .map(|(_, project, event)| (project, event))
                .collect()
        };

        for (project, event) in alerts {
            log::error!(
                "samurai injector: session {} never ACKed after {} attempts — ALERT (ack_timeout), leaving in HANDOFF_REQUESTED",
                event.session_id,
                event.details["attempts"],
            );
            self.audit.append(&project, event);
        }
    }

    /// Idle signal for one session: decide-and-record synchronously, then
    /// hand the actual PTY write to the blocking pool.
    fn on_idle(&self, session_id: u32) {
        if let Some(data) = self.arm_injection_on_idle(session_id) {
            self.spawn_write(session_id, data);
        }
    }

    /// Decision + bookkeeping for an idle signal, no I/O. Returns the exact
    /// bytes to write (instruction + `\r`) when an injection is due.
    fn arm_injection_on_idle(&self, session_id: u32) -> Option<String> {
        let state = self.session_state(session_id)?;
        let mut pending = self.lock_pending();
        let p = pending.get_mut(&session_id)?;
        if !should_inject_on_idle(state, p.acked, p.attempts, p.awaiting_retry) {
            return None;
        }
        p.attempts += 1;
        p.injected_at = Some(Instant::now());
        p.awaiting_retry = false;
        log::info!(
            "samurai injector: session {session_id} idle — injecting handoff instruction (attempt {})",
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
                Err(e) => log::warn!(
                    "samurai injector: write task for session {session_id} failed: {e}"
                ),
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
        let expected = samurai_prompts::handoff_ack_value(p.generation);
        if value == expected {
            log::info!(
                "samurai injector: session {session_id} ACKed handoff (gen-{})",
                p.generation
            );
            p.acked = true;
            p.awaiting_retry = false;
        } else {
            log::warn!(
                "samurai injector: session {session_id} ACK value {value:?} does not match expected {expected:?} — ignored"
            );
        }
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
    #[cfg(test)]
    fn pending_view(&self, session_id: u32) -> Option<(u8, bool, bool)> {
        self.lock_pending()
            .get(&session_id)
            .map(|p| (p.attempts, p.acked, p.awaiting_retry))
    }

    /// Test-only: age the latest injection so timeout paths run without
    /// real waiting.
    #[cfg(test)]
    fn backdate_injection(&self, session_id: u32, by: Duration) {
        let mut pending = self.lock_pending();
        let p = pending.get_mut(&session_id).expect("no pending entry");
        p.injected_at = p
            .injected_at
            .expect("nothing injected")
            .checked_sub(by);
        assert!(p.injected_at.is_some(), "backdate underflowed Instant");
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
    fn test_inject_on_idle_sequencing() {
        // (state, acked, attempts, awaiting_retry, expected)
        let table = [
            (HandoffRequested, false, 0, false, true), // first idle → attempt 1
            (HandoffRequested, false, 1, true, true),  // timed out → retry at idle
            (HandoffRequested, false, 1, false, false), // reply w/o marker: hold for timeout
            (HandoffRequested, false, 2, false, false), // both attempts spent
            (HandoffRequested, false, 2, true, false), // never a third attempt
            (HandoffRequested, true, 0, false, false), // ACKed before injection
            (HandoffRequested, true, 1, false, false), // ACKed: done here
            (Working, false, 0, false, false),         // not in handoff
            (HandoffWritten, false, 0, false, false),
            (Dead, false, 1, true, false),
        ];
        for (state, acked, attempts, awaiting_retry, expected) in table {
            assert_eq!(
                should_inject_on_idle(state, acked, attempts, awaiting_retry),
                expected,
                "{state:?} acked={acked} attempts={attempts} awaiting_retry={awaiting_retry}"
            );
        }
    }

    #[test]
    fn test_timeout_verdict_sequencing() {
        use TimeoutVerdict::*;
        // (acked, attempts, awaiting_retry, elapsed, expected)
        let table = [
            (false, 0, false, None, Keep),  // not injected: no clock running
            (false, 1, false, UNDER, Keep), // inside the window
            (false, 1, false, OVER, ArmRetry), // attempt 1 expired → arm retry
            (false, 1, true, OVER, Keep),   // retry already armed: wait for idle
            (false, 2, false, UNDER, Keep), // attempt 2 still inside the window
            (false, 2, false, OVER, Alert), // attempt 2 expired → ALERT once
            (true, 1, false, OVER, Keep),   // ACKed: nothing times out
            (true, 2, false, OVER, Keep),
        ];
        for (acked, attempts, awaiting_retry, elapsed, expected) in table {
            assert_eq!(
                timeout_verdict(acked, attempts, awaiting_retry, elapsed, TIMEOUT),
                expected,
                "acked={acked} attempts={attempts} awaiting_retry={awaiting_retry} elapsed={elapsed:?}"
            );
        }
    }

    #[test]
    fn test_timeout_boundary_is_strict() {
        // "no ACK within N seconds": exactly N is still within.
        assert_eq!(
            timeout_verdict(false, 1, false, Some(TIMEOUT), TIMEOUT),
            TimeoutVerdict::Keep
        );
        assert_eq!(
            timeout_verdict(
                false,
                1,
                false,
                Some(TIMEOUT + Duration::from_millis(1)),
                TIMEOUT
            ),
            TimeoutVerdict::ArmRetry
        );
    }

    #[test]
    fn test_ack_value_extraction() {
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
    }

    // --- controller against a real supervisor + audit log ---

    /// An injector wired to a real supervisor and audit log in a temp dir.
    /// The ProcessManager holds no sessions — tests drive the decision paths
    /// (`tick` / `arm_injection_on_idle` / `observe`) and never write a PTY.
    fn harness(
        dir: &std::path::Path,
    ) -> (
        SamuraiInjector,
        AuditLog,
        Arc<Supervisor>,
        Arc<SamuraiContextStore>,
    ) {
        let (audit, task) = AuditLog::new(dir.to_path_buf(), None);
        tokio::spawn(task);
        let supervisor = Arc::new(Supervisor::new(audit.clone(), None));
        let context = Arc::new(SamuraiContextStore::new());
        let config: SharedSamuraiConfig = Arc::new(RwLock::new(SamuraiConfig::default()));
        let injector = SamuraiInjector::new(
            supervisor.clone(),
            context.clone(),
            config,
            ProcessManager::new(),
            audit.clone(),
        );
        (injector, audit, supervisor, context)
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

    #[tokio::test]
    async fn test_trigger_tick_requests_handoff_and_tracks_instruction() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, context) = harness(dir.path());
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
        let (injector, _audit, supervisor, context) = harness(dir.path());
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
    async fn test_idle_injects_once_and_holds_until_timeout() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, context) = harness(dir.path());
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
        assert_eq!(injector.pending_view(1), Some((1, false, false)));

        // Another idle before the timeout (agent replied without the marker):
        // the retry is not armed, so nothing is injected.
        assert!(injector.arm_injection_on_idle(1).is_none());
        assert_eq!(injector.pending_view(1), Some((1, false, false)));
    }

    #[tokio::test]
    async fn test_idle_without_pending_or_before_trigger_does_nothing() {
        let dir = tempdir().unwrap();
        let (injector, _audit, supervisor, _context) = harness(dir.path());
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
        let (injector, _audit, supervisor, context) = harness(dir.path());
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

        // The real ACK: acked, state stays HANDOFF_REQUESTED (P2.3 advances
        // it), and no further idle ever injects again.
        injector.observe(&assistant_message(
            1,
            "Understood. <samurai-ack>handoff gen-4</samurai-ack>",
        ));
        assert_eq!(injector.pending_view(1), Some((1, true, false)));
        assert_eq!(injector.session_state(1), Some(HandoffRequested));
        assert!(injector.arm_injection_on_idle(1).is_none());

        // And the timeout pass leaves an ACKed instruction alone.
        injector.backdate_injection(1, TIMEOUT + Duration::from_secs(5));
        injector.tick();
        assert_eq!(injector.pending_view(1), Some((1, true, false)));
    }

    #[tokio::test]
    async fn test_timeout_retry_then_alert_once_and_stay_for_human() {
        let dir = tempdir().unwrap();
        let (injector, audit, supervisor, context) = harness(dir.path());
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
        let (injector, _audit, supervisor, context) = harness(dir.path());
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
        let (injector, _audit, supervisor, _context) = harness(dir.path());
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
}
