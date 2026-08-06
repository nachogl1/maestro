//! Samurai per-session supervisor state machine (Phase 1).
//!
//! Every supervised orchestrator session has an explicit state
//! (`docs/samurai/prd.md` §5.2):
//!
//! ```text
//! WORKING → HANDOFF_REQUESTED → HANDOFF_WRITTEN → KILLED → (successor SPAWNED as gen N+1)
//! WORKING → PARK_REQUESTED   → PARKED (timer armed) → (successor SPAWNED at reset)
//! any     → DEAD (watchdog)  → (successor SPAWNED in recovery mode)
//! ```
//!
//! Invariants enforced here:
//! - **One in-flight instruction max** per session: entering a `*_REQUESTED`
//!   state records the instruction; no second instruction can start until the
//!   first resolves (`HANDOFF_WRITTEN` / `PARKED`) or the session dies.
//! - **HANDOFF and PARK are mutually exclusive**: if the allowance crosses
//!   mid-handoff, the handoff completes and the park timer is armed instead
//!   (the handoff file doubles as park state) — so the park transition is
//!   rejected here, and vice versa.
//! - Illegal transitions are **rejected and logged** (log + ALERT audit row),
//!   never panic.
//!
//! Phase 1 boundary: this machine takes **no actions** — no injection, no
//! kill, no spawn. It is state storage + a transition API (drivable via a
//! tauri command for manual testing) that emits every transition to (a) the
//! audit log and (b) the frontend. Phases 2–3 wire real triggers/actions
//! onto it. A successor generation arrives as a *new* session registration
//! with `generation + 1`, never as a transition of the dead session.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};

/// Supervisor states, serialized with the PRD's SCREAMING names
/// (`"HANDOFF_REQUESTED"`, …) so frontend and audit rows read like the design.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SupervisorState {
    Working,
    HandoffRequested,
    HandoffWritten,
    Killed,
    ParkRequested,
    Parked,
    Dead,
}

impl SupervisorState {
    /// Terminal states have no outgoing transitions: the session is gone and
    /// any successor is a fresh registration at the next generation.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Killed | Self::Parked | Self::Dead)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "WORKING",
            Self::HandoffRequested => "HANDOFF_REQUESTED",
            Self::HandoffWritten => "HANDOFF_WRITTEN",
            Self::Killed => "KILLED",
            Self::ParkRequested => "PARK_REQUESTED",
            Self::Parked => "PARKED",
            Self::Dead => "DEAD",
        }
    }
}

impl std::str::FromStr for SupervisorState {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "WORKING" => Ok(Self::Working),
            "HANDOFF_REQUESTED" => Ok(Self::HandoffRequested),
            "HANDOFF_WRITTEN" => Ok(Self::HandoffWritten),
            "KILLED" => Ok(Self::Killed),
            "PARK_REQUESTED" => Ok(Self::ParkRequested),
            "PARKED" => Ok(Self::Parked),
            "DEAD" => Ok(Self::Dead),
            other => Err(format!("unknown supervisor state: {other}")),
        }
    }
}

/// The instruction a `*_REQUESTED` state represents. Phase 2 turns these into
/// real terminal injections; Phase 1 only tracks that one is in flight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InstructionKind {
    Handoff,
    Park,
}

/// Snapshot of one supervised session — returned by the tauri commands and
/// emitted verbatim as the `samurai-supervisor-event` frontend payload.
#[derive(Debug, Clone, Serialize)]
pub struct SessionSnapshot {
    pub session_id: u32,
    /// Canonical project path (Windows `\\?\` prefix already stripped).
    pub project: String,
    pub epic: String,
    pub generation: u32,
    pub state: SupervisorState,
    /// State before the change that produced this snapshot; `None` for a
    /// fresh registration.
    pub previous_state: Option<SupervisorState>,
    pub in_flight: Option<InstructionKind>,
    /// RFC 3339 UTC timestamp of the change.
    pub ts: String,
}

/// Callback fired after every applied state change (registration included).
pub type StateChangeCallback = Arc<dyn Fn(&SessionSnapshot) + Send + Sync>;

struct SessionEntry {
    project: String,
    epic: String,
    generation: u32,
    state: SupervisorState,
    previous_state: Option<SupervisorState>,
    in_flight: Option<InstructionKind>,
}

impl SessionEntry {
    fn snapshot(&self, session_id: u32) -> SessionSnapshot {
        SessionSnapshot {
            session_id,
            project: self.project.clone(),
            epic: self.epic.clone(),
            generation: self.generation,
            state: self.state,
            previous_state: self.previous_state,
            in_flight: self.in_flight,
            ts: chrono::Utc::now().to_rfc3339(),
        }
    }
}

/// The per-session supervisor registry + state machine.
pub struct Supervisor {
    sessions: Mutex<HashMap<u32, SessionEntry>>,
    audit: AuditLog,
    on_change: Option<StateChangeCallback>,
}

impl Supervisor {
    pub fn new(audit: AuditLog, on_change: Option<StateChangeCallback>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            audit,
            on_change,
        }
    }

    /// Registers a session under supervision, starting in `WORKING`.
    /// Emits a `SPAWN` audit row and a frontend state event.
    ///
    /// A session id can be registered once: successor generations always run
    /// in a fresh terminal session with its own id (PRD §5.4), so a duplicate
    /// id is a caller bug, not a lifecycle event.
    pub fn register_session(
        &self,
        session_id: u32,
        project: String,
        epic: String,
        generation: u32,
    ) -> Result<SessionSnapshot, String> {
        self.register_session_with_details(
            session_id,
            project,
            epic,
            generation,
            serde_json::Value::Null,
        )
    }

    /// [`register_session`](Self::register_session) with extra key/values
    /// merged into the SPAWN audit row's `details` (issue #55: a successor's
    /// SPAWN row links it to its predecessor). Non-object `extra` values are
    /// ignored, so the plain path passes `Null`.
    pub fn register_session_with_details(
        &self,
        session_id: u32,
        project: String,
        epic: String,
        generation: u32,
        extra: serde_json::Value,
    ) -> Result<SessionSnapshot, String> {
        let snapshot = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if sessions.contains_key(&session_id) {
                return Err(format!("session {session_id} is already under supervision"));
            }
            let entry = SessionEntry {
                project,
                epic,
                generation,
                state: SupervisorState::Working,
                previous_state: None,
                in_flight: None,
            };
            let snapshot = entry.snapshot(session_id);
            sessions.insert(session_id, entry);
            snapshot
        };

        let mut details = json!({ "state": SupervisorState::Working.as_str() });
        if let (Some(map), serde_json::Value::Object(extra_map)) = (details.as_object_mut(), extra)
        {
            map.extend(extra_map);
        }
        self.audit.append(
            &snapshot.project,
            AuditEvent::now(
                snapshot.epic.clone(),
                AuditEventKind::Spawn,
                snapshot.generation,
                session_id,
                details,
            ),
        );
        self.notify(&snapshot);
        Ok(snapshot)
    }

    /// Attempts a state transition. On success the new state is stored, an
    /// audit row is appended and the frontend is notified. On rejection the
    /// state is untouched and the rejection is logged as a warning plus an
    /// `ALERT` audit row (`details.kind = "illegal_transition"`). Never panics.
    pub fn transition(
        &self,
        session_id: u32,
        to: SupervisorState,
    ) -> Result<SessionSnapshot, String> {
        let outcome = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let entry = match sessions.get_mut(&session_id) {
                Some(e) => e,
                None => {
                    let reason = format!("session {session_id} is not under supervision");
                    log::warn!("samurai: rejected transition: {reason}");
                    return Err(reason);
                }
            };
            let from = entry.state;

            match validate_transition(from, to, entry.in_flight) {
                Err(reason) => {
                    // Reject: state untouched. Emit the ALERT while still
                    // holding the entry's context (epic/generation).
                    Err((
                        entry.project.clone(),
                        AuditEvent::now(
                            entry.epic.clone(),
                            AuditEventKind::Alert,
                            entry.generation,
                            session_id,
                            json!({
                                "kind": "illegal_transition",
                                "from": from.as_str(),
                                "to": to.as_str(),
                                "reason": reason,
                            }),
                        ),
                        reason,
                    ))
                }
                Ok(()) => {
                    entry.previous_state = Some(from);
                    entry.state = to;
                    entry.in_flight = match to {
                        // Entering a requested state puts that instruction
                        // in flight …
                        SupervisorState::HandoffRequested => Some(InstructionKind::Handoff),
                        SupervisorState::ParkRequested => Some(InstructionKind::Park),
                        // … reaching its outcome (or dying) resolves it.
                        _ => None,
                    };
                    let snapshot = entry.snapshot(session_id);
                    let audit_event = audit_for_transition(&snapshot, from);
                    Ok((snapshot, audit_event))
                }
            }
        };

        match outcome {
            Ok((snapshot, audit_event)) => {
                self.audit.append(&snapshot.project, audit_event);
                self.notify(&snapshot);
                Ok(snapshot)
            }
            Err((project, alert, reason)) => {
                log::warn!("samurai: rejected transition for session {session_id}: {reason}");
                self.audit.append(&project, alert);
                Err(reason)
            }
        }
    }

    /// Drops a session from supervision without a transition (fresh-eyes
    /// finding H). This is TEARDOWN, not a state change: the terminal was
    /// closed outside the samurai pipeline (manual kill, project close,
    /// frontend reload), so no `samurai-supervisor-event` is emitted — the
    /// frontend initiated the close and already dropped its entry, and an
    /// event for a gone session would only confuse late listeners. No audit
    /// row either, deliberately: the kill paths are user-driven, visible in
    /// the UI as they happen, and the audit log records the *supervisor's*
    /// lifecycle decisions — a row per manual tile close would be noise.
    /// Returns whether an entry existed (idempotent otherwise).
    pub fn remove_session(&self, session_id: u32) -> bool {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&session_id)
            .is_some()
    }

    /// Snapshots of every supervised session, ordered by session id.
    pub fn list_sessions(&self) -> Vec<SessionSnapshot> {
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut out: Vec<SessionSnapshot> = sessions
            .iter()
            .map(|(id, entry)| entry.snapshot(*id))
            .collect();
        out.sort_by_key(|s| s.session_id);
        out
    }

    fn notify(&self, snapshot: &SessionSnapshot) {
        if let Some(cb) = &self.on_change {
            cb(snapshot);
        }
    }

    /// Test-only: force a session into an arbitrary state so every (from, to)
    /// pair can be exercised without walking the legal path each time.
    #[cfg(test)]
    fn force_state(
        &self,
        session_id: u32,
        state: SupervisorState,
        in_flight: Option<InstructionKind>,
    ) {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = sessions.get_mut(&session_id).expect("unknown session");
        entry.state = state;
        entry.in_flight = in_flight;
    }
}

/// Pure legality check for the §5.2 diagram (invariants aside).
fn is_legal(from: SupervisorState, to: SupervisorState) -> bool {
    use SupervisorState::*;
    matches!(
        (from, to),
        (Working, HandoffRequested)
            | (HandoffRequested, HandoffWritten)
            | (HandoffWritten, Killed)
            | (Working, ParkRequested)
            | (ParkRequested, Parked)
            // `any → DEAD` — "any" meaning any live state; terminal states
            // are already gone and are rejected before this table is reached.
            | (Working | HandoffRequested | HandoffWritten | ParkRequested, Dead)
    )
}

/// Full validation: terminal check, one-in-flight invariant, HANDOFF/PARK
/// exclusivity, then the legality table. Returns the rejection reason.
fn validate_transition(
    from: SupervisorState,
    to: SupervisorState,
    in_flight: Option<InstructionKind>,
) -> Result<(), String> {
    use SupervisorState::*;

    if from.is_terminal() {
        return Err(format!(
            "{} is terminal; a successor must be spawned as a new session",
            from.as_str()
        ));
    }

    // One in-flight instruction max. DEAD is exempt: the watchdog declaring a
    // session dead is an observation, not an instruction.
    let starts_instruction = matches!(to, HandoffRequested | ParkRequested);
    if starts_instruction && in_flight.is_some() {
        return Err(format!(
            "an instruction is already in flight ({:?}); one in-flight instruction max",
            in_flight.unwrap()
        ));
    }

    // HANDOFF and PARK are mutually exclusive. If the allowance crosses
    // mid-handoff, the handoff completes and the park timer is armed instead —
    // the handoff file doubles as park state (PRD §5.2).
    if to == ParkRequested && matches!(from, HandoffRequested | HandoffWritten) {
        return Err(
            "HANDOFF and PARK are mutually exclusive: the handoff completes and the \
             park timer is armed instead (the handoff file doubles as park state)"
                .to_string(),
        );
    }
    if to == HandoffRequested && from == ParkRequested {
        return Err("HANDOFF and PARK are mutually exclusive: the session is parking".to_string());
    }

    if !is_legal(from, to) {
        return Err(format!(
            "illegal transition {} → {}",
            from.as_str(),
            to.as_str()
        ));
    }
    Ok(())
}

/// Maps an applied transition to its audit row. Every transition is an audit
/// event (PRD §5.2); the six PRD kinds are kept and the transition detail
/// (phase, from-state) rides in `details`.
fn audit_for_transition(snapshot: &SessionSnapshot, from: SupervisorState) -> AuditEvent {
    use SupervisorState::*;
    let (kind, details) = match snapshot.state {
        HandoffRequested => (
            AuditEventKind::Handoff,
            json!({ "phase": "requested", "from": from.as_str() }),
        ),
        HandoffWritten => (
            AuditEventKind::Handoff,
            json!({ "phase": "written", "from": from.as_str() }),
        ),
        Killed => (
            AuditEventKind::Handoff,
            json!({ "phase": "killed", "from": from.as_str() }),
        ),
        ParkRequested => (
            AuditEventKind::Park,
            json!({ "phase": "requested", "from": from.as_str() }),
        ),
        Parked => (
            AuditEventKind::Park,
            json!({ "phase": "parked", "from": from.as_str() }),
        ),
        Dead => (
            AuditEventKind::Alert,
            json!({ "kind": "dead", "from": from.as_str() }),
        ),
        // WORKING is only ever entered by registration (SPAWN), which does
        // not go through transition() — unreachable, but never panic.
        Working => (
            AuditEventKind::Alert,
            json!({ "kind": "unexpected_transition_to_working", "from": from.as_str() }),
        ),
    };
    AuditEvent::now(
        snapshot.epic.clone(),
        kind,
        snapshot.generation,
        snapshot.session_id,
        details,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const ALL_STATES: [SupervisorState; 7] = [
        SupervisorState::Working,
        SupervisorState::HandoffRequested,
        SupervisorState::HandoffWritten,
        SupervisorState::Killed,
        SupervisorState::ParkRequested,
        SupervisorState::Parked,
        SupervisorState::Dead,
    ];

    /// A supervisor wired to a real audit log in a temp dir, plus a recorder
    /// of every frontend notification.
    fn harness(dir: &std::path::Path) -> (Supervisor, AuditLog, Arc<Mutex<Vec<SessionSnapshot>>>) {
        let (audit, task) = AuditLog::new(dir.to_path_buf(), None);
        tokio::spawn(task);
        let seen: Arc<Mutex<Vec<SessionSnapshot>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_cb = seen.clone();
        let supervisor = Supervisor::new(
            audit.clone(),
            Some(Arc::new(move |s: &SessionSnapshot| {
                seen_cb.lock().unwrap().push(s.clone());
            })),
        );
        (supervisor, audit, seen)
    }

    /// The instruction that is naturally in flight while sitting in `state`.
    fn natural_in_flight(state: SupervisorState) -> Option<InstructionKind> {
        match state {
            SupervisorState::HandoffRequested => Some(InstructionKind::Handoff),
            SupervisorState::ParkRequested => Some(InstructionKind::Park),
            _ => None,
        }
    }

    #[tokio::test]
    async fn test_handoff_chain_states_events_and_audit() {
        let dir = tempdir().unwrap();
        let (supervisor, audit, seen) = harness(dir.path());
        let project = "C:/git/proj-handoff";

        supervisor
            .register_session(1, project.into(), "epic-1".into(), 3)
            .unwrap();

        let s = supervisor
            .transition(1, SupervisorState::HandoffRequested)
            .unwrap();
        assert_eq!(s.state, SupervisorState::HandoffRequested);
        assert_eq!(s.in_flight, Some(InstructionKind::Handoff));
        assert_eq!(s.previous_state, Some(SupervisorState::Working));

        let s = supervisor
            .transition(1, SupervisorState::HandoffWritten)
            .unwrap();
        assert_eq!(
            s.in_flight, None,
            "reaching HANDOFF_WRITTEN resolves the instruction"
        );

        let s = supervisor.transition(1, SupervisorState::Killed).unwrap();
        assert_eq!(s.state, SupervisorState::Killed);
        assert_eq!(s.generation, 3);
        assert_eq!(s.epic, "epic-1");

        // Audit trail: SPAWN, then one HANDOFF row per transition.
        let rows = audit.read(project, None, None).await.unwrap().events;
        let kinds: Vec<AuditEventKind> = rows.iter().map(|r| r.event).collect();
        assert_eq!(
            kinds,
            vec![
                AuditEventKind::Spawn,
                AuditEventKind::Handoff,
                AuditEventKind::Handoff,
                AuditEventKind::Handoff,
            ]
        );
        assert_eq!(rows[1].details["phase"], "requested");
        assert_eq!(rows[2].details["phase"], "written");
        assert_eq!(rows[3].details["phase"], "killed");
        assert!(rows.iter().all(|r| r.generation == 3 && r.session_id == 1));

        // Frontend notified for the registration + all three transitions.
        assert_eq!(seen.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn test_park_chain_states_and_audit() {
        let dir = tempdir().unwrap();
        let (supervisor, audit, _seen) = harness(dir.path());
        let project = "C:/git/proj-park";

        supervisor
            .register_session(2, project.into(), "epic-2".into(), 1)
            .unwrap();
        let s = supervisor
            .transition(2, SupervisorState::ParkRequested)
            .unwrap();
        assert_eq!(s.in_flight, Some(InstructionKind::Park));
        let s = supervisor.transition(2, SupervisorState::Parked).unwrap();
        assert_eq!(s.state, SupervisorState::Parked);
        assert_eq!(s.in_flight, None);

        let rows = audit.read(project, None, None).await.unwrap().events;
        let kinds: Vec<AuditEventKind> = rows.iter().map(|r| r.event).collect();
        assert_eq!(
            kinds,
            vec![
                AuditEventKind::Spawn,
                AuditEventKind::Park,
                AuditEventKind::Park
            ]
        );
        assert_eq!(rows[1].details["phase"], "requested");
        assert_eq!(rows[2].details["phase"], "parked");
    }

    #[tokio::test]
    async fn test_dead_reachable_from_every_live_state() {
        let dir = tempdir().unwrap();
        let (supervisor, audit, _seen) = harness(dir.path());
        let project = "C:/git/proj-dead";

        let live = [
            SupervisorState::Working,
            SupervisorState::HandoffRequested,
            SupervisorState::HandoffWritten,
            SupervisorState::ParkRequested,
        ];
        for (i, from) in live.iter().enumerate() {
            let id = 10 + i as u32;
            supervisor
                .register_session(id, project.into(), "epic-d".into(), 1)
                .unwrap();
            supervisor.force_state(id, *from, natural_in_flight(*from));
            let s = supervisor.transition(id, SupervisorState::Dead).unwrap();
            assert_eq!(s.state, SupervisorState::Dead);
            assert_eq!(
                s.in_flight, None,
                "death resolves any in-flight instruction"
            );
        }

        let rows = audit.read(project, None, None).await.unwrap().events;
        let dead_alerts: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Alert && r.details["kind"] == "dead")
            .collect();
        assert_eq!(dead_alerts.len(), live.len());
    }

    #[tokio::test]
    async fn test_every_transition_pair_exhaustively() {
        // Walks all 49 (from, to) pairs with the natural in-flight instruction
        // for the from-state: exactly the §5.2 diagram must be accepted, and
        // every other pair must be rejected with Err — never a panic.
        let legal: &[(SupervisorState, SupervisorState)] = &[
            (SupervisorState::Working, SupervisorState::HandoffRequested),
            (
                SupervisorState::HandoffRequested,
                SupervisorState::HandoffWritten,
            ),
            (SupervisorState::HandoffWritten, SupervisorState::Killed),
            (SupervisorState::Working, SupervisorState::ParkRequested),
            (SupervisorState::ParkRequested, SupervisorState::Parked),
            (SupervisorState::Working, SupervisorState::Dead),
            (SupervisorState::HandoffRequested, SupervisorState::Dead),
            (SupervisorState::HandoffWritten, SupervisorState::Dead),
            (SupervisorState::ParkRequested, SupervisorState::Dead),
        ];

        let dir = tempdir().unwrap();
        let (supervisor, _audit, _seen) = harness(dir.path());
        supervisor
            .register_session(1, "C:/git/proj-x".into(), "epic-x".into(), 1)
            .unwrap();

        for from in ALL_STATES {
            for to in ALL_STATES {
                supervisor.force_state(1, from, natural_in_flight(from));
                let result = supervisor.transition(1, to);
                let expected_legal = legal.contains(&(from, to));
                assert_eq!(
                    result.is_ok(),
                    expected_legal,
                    "{} → {} should be {}",
                    from.as_str(),
                    to.as_str(),
                    if expected_legal {
                        "accepted"
                    } else {
                        "rejected"
                    },
                );
            }
        }
    }

    #[tokio::test]
    async fn test_one_in_flight_instruction_invariant() {
        let dir = tempdir().unwrap();
        let (supervisor, _audit, _seen) = harness(dir.path());
        supervisor
            .register_session(1, "C:/git/proj-i".into(), "epic-i".into(), 1)
            .unwrap();

        // Natural case: handoff instruction in flight, park instruction denied.
        supervisor
            .transition(1, SupervisorState::HandoffRequested)
            .unwrap();
        let err = supervisor
            .transition(1, SupervisorState::ParkRequested)
            .unwrap_err();
        assert!(err.contains("in flight"), "unexpected reason: {err}");

        // Direct guard test: even from WORKING, a lingering in-flight
        // instruction blocks starting another one.
        supervisor.force_state(1, SupervisorState::Working, Some(InstructionKind::Handoff));
        let err = supervisor
            .transition(1, SupervisorState::ParkRequested)
            .unwrap_err();
        assert!(err.contains("in flight"), "unexpected reason: {err}");
        supervisor.force_state(1, SupervisorState::Working, Some(InstructionKind::Park));
        let err = supervisor
            .transition(1, SupervisorState::HandoffRequested)
            .unwrap_err();
        assert!(err.contains("in flight"), "unexpected reason: {err}");
    }

    #[tokio::test]
    async fn test_handoff_park_mutual_exclusion() {
        let dir = tempdir().unwrap();
        let (supervisor, _audit, _seen) = harness(dir.path());
        supervisor
            .register_session(1, "C:/git/proj-m".into(), "epic-m".into(), 1)
            .unwrap();

        // Allowance crosses mid-handoff (handoff already written, nothing in
        // flight): the park is still refused — the handoff completes and the
        // timer is armed instead.
        supervisor.force_state(1, SupervisorState::HandoffWritten, None);
        let err = supervisor
            .transition(1, SupervisorState::ParkRequested)
            .unwrap_err();
        assert!(
            err.contains("mutually exclusive"),
            "unexpected reason: {err}"
        );

        // Mirror image: a parking session cannot start a handoff, even if the
        // instruction slot were somehow free.
        supervisor.force_state(1, SupervisorState::ParkRequested, None);
        let err = supervisor
            .transition(1, SupervisorState::HandoffRequested)
            .unwrap_err();
        assert!(
            err.contains("mutually exclusive"),
            "unexpected reason: {err}"
        );
    }

    #[tokio::test]
    async fn test_rejection_leaves_state_untouched_and_writes_alert() {
        let dir = tempdir().unwrap();
        let (supervisor, audit, seen) = harness(dir.path());
        let project = "C:/git/proj-r";
        supervisor
            .register_session(1, project.into(), "epic-r".into(), 2)
            .unwrap();
        let notifications_before = seen.lock().unwrap().len();

        // WORKING → KILLED skips the handoff flow: illegal.
        let err = supervisor
            .transition(1, SupervisorState::Killed)
            .unwrap_err();
        assert!(
            err.contains("illegal transition"),
            "unexpected reason: {err}"
        );

        // State untouched, no frontend event for a rejection.
        let sessions = supervisor.list_sessions();
        assert_eq!(sessions[0].state, SupervisorState::Working);
        assert_eq!(seen.lock().unwrap().len(), notifications_before);

        // The rejection is on the audit trail as an ALERT with full context.
        let rows = audit.read(project, None, None).await.unwrap().events;
        let alert = rows.last().unwrap();
        assert_eq!(alert.event, AuditEventKind::Alert);
        assert_eq!(alert.details["kind"], "illegal_transition");
        assert_eq!(alert.details["from"], "WORKING");
        assert_eq!(alert.details["to"], "KILLED");
        assert!(alert.details["reason"]
            .as_str()
            .unwrap()
            .contains("illegal"));
        assert_eq!(alert.generation, 2);
        assert_eq!(alert.session_id, 1);
    }

    #[tokio::test]
    async fn test_unknown_session_and_duplicate_registration_rejected() {
        let dir = tempdir().unwrap();
        let (supervisor, _audit, _seen) = harness(dir.path());

        let err = supervisor
            .transition(99, SupervisorState::HandoffRequested)
            .unwrap_err();
        assert!(
            err.contains("not under supervision"),
            "unexpected reason: {err}"
        );

        supervisor
            .register_session(5, "C:/git/proj-d".into(), "epic-d".into(), 1)
            .unwrap();
        let err = supervisor
            .register_session(5, "C:/git/proj-d".into(), "epic-d".into(), 2)
            .unwrap_err();
        assert!(
            err.contains("already under supervision"),
            "unexpected reason: {err}"
        );
    }

    #[tokio::test]
    async fn test_register_with_details_merges_into_spawn_row() {
        let dir = tempdir().unwrap();
        let (supervisor, audit, _seen) = harness(dir.path());
        let project = "C:/git/proj-details";
        supervisor
            .register_session_with_details(
                9,
                project.into(),
                "epic-s".into(),
                3,
                json!({ "predecessor_session_id": 4, "predecessor_generation": 2 }),
            )
            .unwrap();

        let rows = audit.read(project, None, None).await.unwrap().events;
        let spawn = rows
            .iter()
            .find(|r| r.event == AuditEventKind::Spawn)
            .unwrap();
        // The base detail survives and the extras ride along.
        assert_eq!(spawn.details["state"], "WORKING");
        assert_eq!(spawn.details["predecessor_session_id"], 4);
        assert_eq!(spawn.details["predecessor_generation"], 2);
        assert_eq!(spawn.generation, 3);
        assert_eq!(spawn.session_id, 9);
    }

    #[tokio::test]
    async fn test_remove_session_is_silent_teardown() {
        // Fresh-eyes finding H: removal is teardown, not a state change —
        // no frontend event, no audit row, and the entry is simply gone.
        let dir = tempdir().unwrap();
        let (supervisor, audit, seen) = harness(dir.path());
        let project = "C:/git/proj-remove";
        supervisor
            .register_session(1, project.into(), "epic-r".into(), 2)
            .unwrap();
        let notifications_before = seen.lock().unwrap().len();
        let rows_before = audit.read(project, None, None).await.unwrap().events.len();

        assert!(supervisor.remove_session(1));
        assert!(supervisor.list_sessions().is_empty());
        assert_eq!(
            seen.lock().unwrap().len(),
            notifications_before,
            "no event for teardown"
        );
        let rows = audit.read(project, None, None).await.unwrap().events;
        assert_eq!(rows.len(), rows_before, "no audit row for teardown");

        // Idempotent, and the session is genuinely unsupervised afterwards.
        assert!(!supervisor.remove_session(1));
        let err = supervisor
            .transition(1, SupervisorState::HandoffRequested)
            .unwrap_err();
        assert!(err.contains("not under supervision"));
    }

    #[tokio::test]
    async fn test_list_sessions_sorted_snapshots() {
        let dir = tempdir().unwrap();
        let (supervisor, _audit, _seen) = harness(dir.path());
        for id in [3u32, 1, 2] {
            supervisor
                .register_session(id, format!("C:/git/p{id}"), format!("epic-{id}"), id)
                .unwrap();
        }
        let sessions = supervisor.list_sessions();
        let ids: Vec<u32> = sessions.iter().map(|s| s.session_id).collect();
        assert_eq!(ids, vec![1, 2, 3]);
        assert!(sessions.iter().all(|s| s.state == SupervisorState::Working));
    }

    #[test]
    fn test_state_serialization_matches_prd_names() {
        for (state, name) in [
            (SupervisorState::Working, "WORKING"),
            (SupervisorState::HandoffRequested, "HANDOFF_REQUESTED"),
            (SupervisorState::HandoffWritten, "HANDOFF_WRITTEN"),
            (SupervisorState::Killed, "KILLED"),
            (SupervisorState::ParkRequested, "PARK_REQUESTED"),
            (SupervisorState::Parked, "PARKED"),
            (SupervisorState::Dead, "DEAD"),
        ] {
            assert_eq!(
                serde_json::to_string(&state).unwrap(),
                format!("\"{name}\"")
            );
            assert_eq!(name.parse::<SupervisorState>().unwrap(), state);
            assert_eq!(state.as_str(), name);
        }
        assert!("BOGUS".parse::<SupervisorState>().is_err());
    }
}
