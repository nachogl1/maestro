//! Samurai allowance parker (Phase 3, issue #60; PRD §5.5, §5.2, §7).
//!
//! The backend consumer of the allowance watcher's events — the piece that
//! turns a threshold crossing into action:
//!
//! - **Soft crossing** (5h ≥ soft): every supervised WORKING session with no
//!   in-flight instruction and no pending injection gets the one-line
//!   wind-down instruction (stop spawning subagents, wrap up, a park may
//!   follow). ACK-tracked through the injector's ladder; no state change.
//! - **Hard crossing** (5h ≥ hard or 7d ≥ hard): a **sequential park sweep**
//!   — one session at a time, highest context % first (unknown % last):
//!   `PARK_REQUESTED` → park instruction on idle → ACK → written tag → the
//!   same file+WIP validation as a handoff → `PARKED` → session teardown →
//!   next session. A session whose ladder ALERTs is skipped (it stays in
//!   PARK_REQUESTED with its audit trail — human attention) and the sweep
//!   continues; sessions that register mid-sweep get parked too.
//! - **Mutual exclusion** (PRD §5.2): a session mid-handoff is never sent a
//!   park instruction — its handoff completes and the file doubles as park
//!   state. While the sweep is engaged the replicator consults
//!   [`absorb_handoff`](SamuraiParker::absorb_handoff) just before staging a
//!   successor: instead of spawning into an exhausted allowance, the
//!   completed handoff is *absorbed* (teardown already ran; a
//!   `PARK phase=handoff_absorbed` audit row explains the missing successor)
//!   and the epic still gets its resume timer.
//! - **Timer arming** (PRD §7): when the sweep completes, each distinct
//!   (project, epic) that parked or absorbed gets a persisted timer at
//!   `resets_at + 5 min + per-epic jitter` (`reason: "park"`). Both hard
//!   windows crossing in one sweep → the LATER `resets_at` wins; an armed
//!   timer with a LATER fire time is kept; no `resets_at` at all → an
//!   `ALERT (park_no_reset_time)` instead of a guessed timer. The
//!   "parking engaged" flag clears only after the timers are armed.
//!
//! Resume itself — the fresh spawn when a timer fires — is P3.3 (issue #61);
//! this module only arms the timers. The circuit breaker's park
//! (`samurai_progress`) is an ALERT-and-stop and deliberately arms nothing.
//!
//! Shape: decisions as pure functions with table tests; the sweep advances
//! under one mutex from every edge (allowance event, park outcome, absorbed
//! handoff, the injector's 30s tick), so a second Hard event mid-sweep can
//! never start a second sweep.

use std::collections::{BTreeSet, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::json;

use super::allowance_watcher::{AllowanceEvent, ThresholdKind, ACCOUNT_PROJECT};
use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_context::SamuraiContextStore;
use super::samurai_injector::SamuraiInjector;
use super::samurai_replicator::SessionTeardown;
use super::samurai_schedule::{jitter_secs, SamuraiSchedule, ScheduleEntry};
use super::supervisor::{InstructionKind, SessionSnapshot, Supervisor, SupervisorState};

/// Resume delay past the window reset (PRD §7: `resets_at + 5 min + jitter`).
const RESUME_DELAY_SECS: i64 = 300;

// ---------------------------------------------------------------------------
// Pure decisions (table-tested)
// ---------------------------------------------------------------------------

/// Soft-crossing eligibility: only a WORKING session with no in-flight
/// supervisor instruction and no pending injector entry gets the wind-down —
/// everything else is already heading somewhere (mid-handoff, mid-park, or
/// already instructed).
fn soft_eligible(
    state: SupervisorState,
    in_flight: Option<InstructionKind>,
    has_pending: bool,
) -> bool {
    state == SupervisorState::Working && in_flight.is_none() && !has_pending
}

/// Hard-sweep candidate order: highest context % first, unknown % last,
/// session id ascending as the deterministic tiebreak.
fn candidate_order(a: &(u32, Option<f64>), b: &(u32, Option<f64>)) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    let by_percent = match (a.1, b.1) {
        (Some(pa), Some(pb)) => pb.partial_cmp(&pa).unwrap_or(Equal),
        (Some(_), None) => Less,
        (None, Some(_)) => Greater,
        (None, None) => Equal,
    };
    by_percent.then(a.0.cmp(&b.0))
}

/// Whether one non-terminal session holds the sweep open. `has_pending` is
/// the injector still shepherding an instruction for it; `failed` marks a
/// session whose park ladder ALERTed (skipped — human attention).
fn blocks_completion(state: SupervisorState, has_pending: bool, failed: bool) -> bool {
    match state {
        // Still to park (or a raced transition — retried next advance).
        SupervisorState::Working => !failed,
        // A park in flight blocks; an ALERTed or abandoned one does not.
        SupervisorState::ParkRequested => !failed && has_pending,
        // A completing handoff is absorbed on completion — wait for it. An
        // ALERTed handoff (no pending entry) needs a human; never wait.
        SupervisorState::HandoffRequested => has_pending,
        // Validation → kill is in flight; moments away from terminal.
        SupervisorState::HandoffWritten => true,
        // Terminal states are done.
        SupervisorState::Killed | SupervisorState::Parked | SupervisorState::Dead => false,
    }
}

/// Folds one hard event's `resets_at` into the sweep's: the LATER known
/// reset wins; `None` / unparseable never erases a known one.
fn merge_resets_at(
    current: Option<DateTime<Utc>>,
    event_resets_at: Option<&str>,
) -> Option<DateTime<Utc>> {
    let parsed = event_resets_at.and_then(|s| match DateTime::parse_from_rfc3339(s) {
        Ok(d) => Some(d.with_timezone(&Utc)),
        Err(e) => {
            log::warn!("samurai parker: unparseable resets_at {s:?} ({e}) — ignored");
            None
        }
    });
    match (current, parsed) {
        (Some(c), Some(p)) => Some(c.max(p)),
        (c, p) => c.or(p),
    }
}

/// `resets_at + 5 min + per-epic jitter` (PRD §7).
fn fire_at_for(resets_at: DateTime<Utc>, epic: &str) -> DateTime<Utc> {
    resets_at + ChronoDuration::seconds(RESUME_DELAY_SECS + jitter_secs(epic) as i64)
}

/// Whether the new timer should replace what is already armed for the
/// (project, epic). `arm` replaces unconditionally, so the caller checks
/// first: an existing LATER fire time is kept; an earlier or unparseable one
/// is replaced.
fn should_arm(existing_fire_at: Option<&str>, new_fire_at: DateTime<Utc>) -> bool {
    match existing_fire_at.and_then(|s| DateTime::parse_from_rfc3339(s).ok()) {
        Some(existing) => existing.with_timezone(&Utc) < new_fire_at,
        None => true,
    }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/// Mutable sweep state, all behind one mutex so concurrent edges (allowance
/// events, park outcomes, ticks) serialize.
#[derive(Default)]
struct SweepState {
    /// Sessions whose park ladder ALERTed this sweep — skipped, never
    /// re-targeted; they sit in PARK_REQUESTED for a human.
    failed: HashSet<u32>,
    /// Every (project, epic) parked or absorbed this sweep — the timer set.
    /// BTreeSet for a deterministic arming order.
    parked_epics: BTreeSet<(String, String)>,
    /// The latest known reset among the sweep's triggering hard events.
    resets_at: Option<DateTime<Utc>>,
    /// Issue #63: this sweep was engaged EXTERNALLY (e.g. gh auth loss) — a
    /// condition with no reset time by design, so completion arms NO resume
    /// timers and emits NO per-epic `park_no_reset_time` noise (a human
    /// fixes the cause and resumes manually). Cleared when a real hard
    /// allowance crossing joins the sweep: that brings a reset story, and
    /// its timers must arm normally.
    suppress_timers: bool,
    /// Fix C1 (issue #131 review 2): a `SoftRecovered` edge arrived while
    /// this sweep held the all-clear back. That edge is a strict ONE-SHOT
    /// falling edge (`allowance_watcher`: fired only when `above_soft_5h`
    /// goes true→false), so there is no second edge to re-drive it —
    /// remembering it here is what makes the deferral a DEFERRAL and not a
    /// silent drop. Consumed by [`SamuraiParker::complete_sweep`].
    pending_allclear: bool,
}

/// The allowance parker. Fed by the allowance loop (events), the injector
/// (park outcomes + tick) and the replicator (absorbed handoffs).
pub struct SamuraiParker {
    supervisor: Arc<Supervisor>,
    context: Arc<SamuraiContextStore>,
    injector: Arc<SamuraiInjector>,
    schedule: Arc<SamuraiSchedule>,
    audit: AuditLog,
    /// The same full-teardown closure the replicator uses: a PARKED session's
    /// terminal serves no purpose (PRD decision #6 — every wake-up is a
    /// fresh spawn), so it is torn down like a killed one.
    teardown: SessionTeardown,
    /// The "parking engaged" flag (issue #60 point 3): set on the first hard
    /// crossing, cleared only after the sweep completed AND timers armed.
    engaged: AtomicBool,
    state: Mutex<SweepState>,
    /// Issue #120: sessions holding an un-cleared soft wind-down episode —
    /// inserted when their wind-down is armed, drained on the allowance's
    /// recovery edge so each episode all-clears at most once.
    wound_down: Mutex<HashSet<u32>>,
}

impl SamuraiParker {
    pub fn new(
        supervisor: Arc<Supervisor>,
        context: Arc<SamuraiContextStore>,
        injector: Arc<SamuraiInjector>,
        schedule: Arc<SamuraiSchedule>,
        audit: AuditLog,
        teardown: SessionTeardown,
    ) -> Arc<Self> {
        Arc::new(Self {
            supervisor,
            context,
            injector,
            schedule,
            audit,
            teardown,
            engaged: AtomicBool::new(false),
            state: Mutex::new(SweepState::default()),
            wound_down: Mutex::new(HashSet::new()),
        })
    }

    /// Backend-direct consumer of the allowance watcher's events (the loop
    /// calls this per event — never a Tauri event listener).
    pub fn on_allowance_event(&self, event: &AllowanceEvent) {
        match event {
            AllowanceEvent::ThresholdCrossed {
                threshold_kind: ThresholdKind::Soft,
                ..
            } => self.soft_winddown(),
            AllowanceEvent::ThresholdCrossed {
                threshold_kind: ThresholdKind::Hard,
                window,
                resets_at,
                ..
            } => {
                log::warn!(
                    "samurai parker: hard allowance threshold crossed ({window:?}) — engaging sequential park sweep"
                );
                self.engage_hard(resets_at.as_deref());
            }
            // Issue #120: the soft falling edge — window reset or usage
            // decay, whichever came first — lifts the wind-down.
            AllowanceEvent::SoftRecovered { .. } => self.winddown_allclear(),
            // Preflight's business (P3.5); never a parking decision.
            AllowanceEvent::NoGoverningWindow => {}
        }
    }

    /// Whether a hard park sweep is currently engaged. P3.3's resume and any
    /// other spawner can consult this before starting new work.
    pub fn parking_engaged(&self) -> bool {
        self.engaged.load(Ordering::SeqCst)
    }

    /// Issue #63: engages a hard park sweep for an EXTERNAL, non-allowance
    /// condition — currently gh auth loss (`reason = "gh_auth_lost"`, PRD
    /// §5.8: corporate SSO tokens expire mid-run → park + ALERT, not a crash
    /// loop). Reuses the whole sequential sweep; the differences from an
    /// allowance crossing:
    ///
    /// - **No resume timers.** The condition has no reset time — the human
    ///   fixes auth and resumes manually — so this sweep's completion arms
    ///   nothing and stays silent about it (no `park_no_reset_time` ALERT
    ///   per epic; see [`SweepState::suppress_timers`]).
    /// - **One `ALERT {kind: reason}`** is appended per project with a
    ///   supervised session ([`ACCOUNT_PROJECT`] fallback — the
    ///   `allowance_watcher` row-placement policy), BEFORE the sweep's PARK
    ///   rows so the trail explains them. Once per call — the caller latches
    ///   (the auth watcher only calls on the lost EDGE, never per tick).
    ///
    /// While a sweep is already engaged the ALERT still lands but the sweep
    /// keeps its own timer behavior: an allowance sweep's timers are not
    /// suppressed retroactively.
    pub fn engage_external_park(&self, reason: &str) {
        log::error!("samurai parker: external park engaged ({reason}) — parking every supervised session, no resume timers");
        {
            // Engagement decision and flag write in ONE critical section: a
            // concurrent `engage_hard` landing between the two would leave
            // the "was engaged" answer stale here and re-suppress the timers
            // that crossing just un-suppressed — every epic it parks would
            // then get no resume timer at all. The guard still drops before
            // `advance()`, exactly as before.
            let mut state = self.lock_state();
            if !self.engaged.swap(true, Ordering::SeqCst) {
                state.suppress_timers = true;
            }
        }
        let mut projects: Vec<String> = self
            .supervisor
            .list_sessions()
            .into_iter()
            .map(|s| s.project)
            .collect();
        projects.sort();
        projects.dedup();
        if projects.is_empty() {
            projects.push(ACCOUNT_PROJECT.to_string());
        }
        for project in &projects {
            // Epic-less account-wide row (generation/session 0), same shape
            // as the allowance ALERTs.
            self.audit.append(
                project,
                AuditEvent::now("", AuditEventKind::Alert, 0, 0, json!({ "kind": reason })),
            );
        }
        self.advance();
    }

    /// Consulted by the replicator just before staging a successor for a
    /// completed handoff. `true` = the sweep is engaged: the handoff is
    /// absorbed as park state (PRD §5.2 — the file doubles as park state),
    /// the epic is recorded for a resume timer, and NO successor spawns.
    pub fn absorb_handoff(&self, project: &str, epic: &str) -> bool {
        if !self.parking_engaged() {
            return false;
        }
        log::info!(
            "samurai parker: absorbing completed handoff for epic {epic} in {project} — parking engaged, no successor"
        );
        self.lock_state()
            .parked_epics
            .insert((project.to_string(), epic.to_string()));
        self.advance();
        true
    }

    /// Chained from the injector once a park validated and the session
    /// reached PARKED: record the epic, tear the session down (fresh-spawn
    /// rule), then advance the sweep to the next session.
    pub fn on_parked(self: &Arc<Self>, snapshot: &SessionSnapshot) {
        log::info!(
            "samurai parker: session {} (gen-{}) parked for epic {} — tearing down",
            snapshot.session_id,
            snapshot.generation,
            snapshot.epic,
        );
        self.lock_state()
            .parked_epics
            .insert((snapshot.project.clone(), snapshot.epic.clone()));
        let this = self.clone();
        let session_id = snapshot.session_id;
        tauri::async_runtime::spawn(async move {
            (this.teardown)(session_id).await;
            this.advance();
        });
    }

    /// Chained from the injector when a park ladder exhausted its retries
    /// (ALERT already appended): skip the session and keep sweeping.
    pub fn on_park_failed(&self, session_id: u32) {
        log::warn!(
            "samurai parker: session {session_id} could not be parked — skipping it, sweep continues"
        );
        self.lock_state().failed.insert(session_id);
        self.advance();
    }

    /// Rides the injector's 30s tick: the edge-tolerance that re-evaluates
    /// the sweep after races (mid-sweep registrations, raced transitions,
    /// handoffs resolving between notifications).
    pub fn tick(&self) {
        self.advance();
    }

    /// Soft crossing: wind down every eligible session, log the skips.
    fn soft_winddown(&self) {
        for session in self.supervisor.list_sessions() {
            // Fix L6: a pending, un-acked WinddownAllClear left over from an
            // earlier episode must not block THIS eligibility check —
            // `begin_soft_winddown` supersedes it outright.
            let has_pending = self.injector.blocks_soft_winddown(session.session_id);
            if soft_eligible(session.state, session.in_flight, has_pending) {
                if self.injector.begin_soft_winddown(&session) {
                    // Issue #120: remember the episode so the recovery edge
                    // can all-clear exactly the sessions it wound down.
                    self.lock_wound_down().insert(session.session_id);
                } else {
                    // Raced an instruction armed between the check and here.
                    log::info!(
                        "samurai parker: session {} gained an instruction mid-decision — wind-down skipped",
                        session.session_id
                    );
                }
            } else {
                log::info!(
                    "samurai parker: soft wind-down skipped for session {} (state {}, in-flight {:?}, pending {}) — already heading somewhere",
                    session.session_id,
                    session.state.as_str(),
                    session.in_flight,
                    has_pending,
                );
            }
        }
    }

    /// Issue #120: the allowance recovered. Every session wound down this
    /// episode that is still WORKING (never parked, never handed off) gets
    /// the ack-only all-clear; the episode set drains so the edge triggers
    /// at most once per wind-down episode.
    fn winddown_allclear(&self) {
        // Fix M6 (issue #131 review): a hard park sweep walks WORKING
        // sessions toward ParkRequested one at a time — a session still
        // queued for that sweep is still WORKING right up to the moment its
        // turn comes, so without this guard a 5h-window reset mid-sweep
        // would inject "resume full throughput" into a session the sweep is
        // about to park anyway, against a 7d allowance that is still
        // exhausted. DEFER rather than drop: the wound-down episode set is
        // left intact (not drained) AND the edge itself is remembered
        // (`pending_allclear`), because `SoftRecovered` is a strict one-shot
        // falling edge — waiting for "the next edge" would wait forever and
        // leave the sweep's skipped sessions wound down for the rest of the
        // window (fix C1, the bug #120 shape). `complete_sweep` re-drives
        // this function the moment parking disengages.
        if self.parking_engaged() {
            log::info!(
                "samurai parker: soft all-clear deferred — a hard park sweep is engaged; it will be re-driven when the sweep completes"
            );
            self.lock_state().pending_allclear = true;
            return;
        }
        let wound: HashSet<u32> = std::mem::take(&mut *self.lock_wound_down());
        if wound.is_empty() {
            return;
        }
        for session in self.supervisor.list_sessions() {
            if !wound.contains(&session.session_id) {
                continue;
            }
            if session.state != SupervisorState::Working {
                log::info!(
                    "samurai parker: session {} left WORKING ({}) since its wind-down — no all-clear",
                    session.session_id,
                    session.state.as_str(),
                );
                continue;
            }
            if !self.injector.begin_winddown_allclear(&session) {
                log::info!(
                    "samurai parker: session {} busy with another instruction (or its wind-down never delivered) — all-clear skipped",
                    session.session_id,
                );
            }
        }
    }

    fn lock_wound_down(&self) -> std::sync::MutexGuard<'_, HashSet<u32>> {
        self.wound_down
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Hard crossing: engage (idempotent — a second event mid-sweep only
    /// merges its reset time) and advance.
    fn engage_hard(&self, resets_at: Option<&str>) {
        // One critical section (see `engage_external_park`): the swap must
        // not be observable before this sweep's reset story is written.
        let was_engaged = {
            let mut state = self.lock_state();
            let was = self.engaged.swap(true, Ordering::SeqCst);
            state.resets_at = merge_resets_at(state.resets_at, resets_at);
            // A real allowance crossing brings a reset story — even when it
            // joins an externally engaged sweep (issue #63), its timers must
            // arm normally.
            state.suppress_timers = false;
            was
        };
        if was_engaged {
            log::info!(
                "samurai parker: hard crossing while a sweep is engaged — reset time merged"
            );
        }
        self.advance();
    }

    /// One sweep step, serialized by the state mutex: keep waiting while a
    /// park (or a completing handoff) is in flight, otherwise target the
    /// next candidate, otherwise complete the sweep (arm timers, disengage).
    fn advance(&self) {
        if !self.parking_engaged() {
            return;
        }
        let mut state = self.lock_state();
        let sessions = self.supervisor.list_sessions();

        // Sequential parking: one park in flight at a time.
        let park_in_flight = sessions.iter().any(|s| {
            s.state == SupervisorState::ParkRequested
                && !state.failed.contains(&s.session_id)
                && self.injector.has_pending(s.session_id)
        });
        if park_in_flight {
            return;
        }

        // Next candidate: WORKING, nothing in flight, not already skipped —
        // highest context first (unknown last).
        let mut candidates: Vec<(u32, Option<f64>)> = sessions
            .iter()
            .filter(|s| {
                s.state == SupervisorState::Working
                    && s.in_flight.is_none()
                    && !state.failed.contains(&s.session_id)
            })
            .map(|s| (s.session_id, self.context.percent(s.session_id)))
            .collect();
        candidates.sort_by(candidate_order);
        for (session_id, percent) in candidates {
            match self
                .supervisor
                .transition(session_id, SupervisorState::ParkRequested)
            {
                Ok(snapshot) => {
                    log::info!(
                        "samurai parker: parking session {session_id} next (context {})",
                        percent.map_or("unknown".to_string(), |p| format!("{p:.1}%")),
                    );
                    self.injector.begin_park(&snapshot);
                    return;
                }
                // E.g. the session raced into a handoff between the list and
                // the transition (mutual exclusion) — re-evaluated next
                // advance; try the next candidate meanwhile.
                Err(e) => log::warn!(
                    "samurai parker: park transition for session {session_id} rejected ({e}) — trying the next candidate"
                ),
            }
        }

        // Nothing parkable right now: blocked (something is completing) or
        // done (every session terminal, skipped, or abandoned).
        let blocked = sessions.iter().any(|s| {
            blocks_completion(
                s.state,
                self.injector.has_pending(s.session_id),
                state.failed.contains(&s.session_id),
            )
        });
        if !blocked {
            let deferred_allclear = self.complete_sweep(&mut state);
            // The state guard must be gone before the all-clear runs: it
            // re-enters `winddown_allclear`, which takes this same lock when
            // it has to defer again (a fresh sweep engaged in between).
            drop(state);
            if deferred_allclear {
                log::info!(
                    "samurai parker: park sweep disengaged — re-driving the all-clear it deferred"
                );
                self.winddown_allclear();
            }
        }
    }

    /// Sweep complete: arm one timer per parked/absorbed (project, epic),
    /// then — and only then — clear the engaged flag (issue #60 point 6).
    ///
    /// A timer CAN be armed here for a run whose config is already
    /// COMPLETED (verification can flip it while the orchestrator's session
    /// is still live and parkable). That is deliberate: every park timer
    /// funnels through `SamuraiResumer::on_fire`, whose ACTIVE-run gate
    /// (review F2) drops stale timers instead of spawning — duplicating
    /// that gate here would only add a run-config dependency for noise
    /// reduction.
    ///
    /// Returns whether an all-clear was DEFERRED by this sweep and must now
    /// be re-driven (fix C1) — the caller does that after dropping the state
    /// guard.
    fn complete_sweep(&self, state: &mut SweepState) -> bool {
        let parked_epics = std::mem::take(&mut state.parked_epics);
        let resets_at = state.resets_at.take();
        let suppress_timers = std::mem::take(&mut state.suppress_timers);
        let pending_allclear = std::mem::take(&mut state.pending_allclear);
        state.failed.clear();

        // Issue #63: an externally engaged sweep (gh auth loss) arms nothing
        // — the condition has no reset time BY DESIGN, so the per-epic
        // park_no_reset_time ALERT would be noise on top of the one
        // `gh_auth_lost` ALERT already appended at engagement.
        if suppress_timers {
            log::info!(
                "samurai parker: external park sweep complete — {} epic(s) parked, no resume timers by design (human resumes after fixing the cause)",
                parked_epics.len()
            );
            self.engaged.store(false, Ordering::SeqCst);
            return pending_allclear;
        }

        log::info!(
            "samurai parker: park sweep complete — {} epic(s) to arm resume timers for",
            parked_epics.len()
        );
        let armed = self.schedule.list();
        for (project, epic) in parked_epics {
            match resets_at {
                None => {
                    // A guessed timer is worse than a human look (issue #60
                    // point 4): ALERT instead of arming.
                    log::error!(
                        "samurai parker: no reset time known for epic {epic} — resume timer NOT armed (park_no_reset_time)"
                    );
                    self.audit.append(
                        &project,
                        AuditEvent::now(
                            epic.clone(),
                            AuditEventKind::Alert,
                            0,
                            0,
                            json!({ "kind": "park_no_reset_time", "epic": epic }),
                        ),
                    );
                }
                Some(resets_at) => {
                    let fire_at = fire_at_for(resets_at, &epic);
                    let existing = armed
                        .iter()
                        .find(|e| e.project_path == project && e.epic == epic)
                        .map(|e| e.fire_at.as_str());
                    if !should_arm(existing, fire_at) {
                        log::info!(
                            "samurai parker: epic {epic} already has a later resume timer ({}) — kept",
                            existing.unwrap_or_default()
                        );
                        continue;
                    }
                    let fire_at = fire_at.to_rfc3339();
                    let entry = ScheduleEntry {
                        project_path: project.clone(),
                        epic: epic.clone(),
                        fire_at: fire_at.clone(),
                        reason: "park".to_string(),
                        launch: None,
                        held: false,
                    };
                    match self.schedule.arm(entry) {
                        Ok(()) => {
                            log::info!(
                                "samurai parker: resume timer armed for epic {epic} at {fire_at}"
                            );
                            // Epic-level row (generation/session 0, like the
                            // allowance ALERTs): the trail shows WHEN work
                            // resumes without opening schedule.json.
                            self.audit.append(
                                &project,
                                AuditEvent::now(
                                    epic.clone(),
                                    AuditEventKind::Park,
                                    0,
                                    0,
                                    json!({ "phase": "timer_armed", "fire_at": fire_at }),
                                ),
                            );
                        }
                        Err(e) => log::error!(
                            "samurai parker: failed to arm the resume timer for epic {epic}: {e}"
                        ),
                    }
                }
            }
        }
        self.engaged.store(false, Ordering::SeqCst);
        pending_allclear
    }

    /// Recover from a poisoned lock rather than panicking — event-path
    /// policy, same as the injector and context store.
    fn lock_state(&self) -> std::sync::MutexGuard<'_, SweepState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::claude_event::ClaudeEvent;
    use crate::core::samurai_config::{SamuraiConfig, SharedSamuraiConfig};
    use crate::core::samurai_injector::SessionDirResolver;
    use crate::core::windows_process::StdCommandExt;
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::RwLock;
    use std::time::Duration;
    use tempfile::tempdir;

    use crate::core::allowance_watcher::AllowanceWindow;

    const RESETS_AT: &str = "2030-01-01T00:00:00Z";
    /// Default ack_timeout_secs, for backdating the injector's clocks.
    const TIMEOUT: Duration = Duration::from_secs(180);

    // --- pure decisions ---

    #[test]
    fn test_candidate_order_highest_context_first_unknown_last() {
        let mut candidates = [
            (4, None),
            (2, Some(80.0)),
            (3, Some(80.0)),
            (1, Some(30.0)),
            (5, None),
        ];
        candidates.sort_by(candidate_order);
        let ids: Vec<u32> = candidates.iter().map(|(id, _)| *id).collect();
        // Highest % first; equal % by id; unknown % last, by id.
        assert_eq!(ids, vec![2, 3, 1, 4, 5]);
    }

    #[test]
    fn test_soft_eligibility_table() {
        use SupervisorState::*;
        // (state, in_flight, has_pending, expected)
        let table = [
            (Working, None, false, true),
            (Working, None, true, false), // already instructed
            (Working, Some(InstructionKind::Handoff), false, false),
            (
                HandoffRequested,
                Some(InstructionKind::Handoff),
                false,
                false,
            ),
            (HandoffWritten, None, false, false),
            (ParkRequested, Some(InstructionKind::Park), false, false),
            (Parked, None, false, false),
            (Killed, None, false, false),
            (Dead, None, false, false),
        ];
        for (state, in_flight, has_pending, expected) in table {
            assert_eq!(
                soft_eligible(state, in_flight, has_pending),
                expected,
                "{state:?} in_flight={in_flight:?} pending={has_pending}"
            );
        }
    }

    #[test]
    fn test_blocks_completion_table() {
        use SupervisorState::*;
        // (state, has_pending, failed, expected)
        let table = [
            (Working, false, false, true),           // still to park
            (Working, true, false, true),            // wind-down pending; still to park
            (Working, false, true, false),           // skipped
            (ParkRequested, true, false, true),      // park in flight
            (ParkRequested, false, true, false),     // ALERTed — human attention
            (ParkRequested, false, false, false),    // abandoned/transient — never wait
            (HandoffRequested, true, false, true),   // completing handoff — absorbed later
            (HandoffRequested, false, false, false), // ALERTed handoff — never wait
            (HandoffWritten, false, false, true),    // replication in flight
            (Killed, false, false, false),
            (Parked, false, false, false),
            (Dead, false, false, false),
        ];
        for (state, has_pending, failed, expected) in table {
            assert_eq!(
                blocks_completion(state, has_pending, failed),
                expected,
                "{state:?} pending={has_pending} failed={failed}"
            );
        }
    }

    #[test]
    fn test_merge_resets_at_keeps_the_later_known_reset() {
        let t1 = "2030-01-01T00:00:00Z";
        let t2 = "2030-01-03T00:00:00Z";
        let parse = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc);
        assert_eq!(merge_resets_at(None, Some(t1)), Some(parse(t1)));
        // Later event wins; an earlier one never regresses the sweep's reset.
        assert_eq!(merge_resets_at(Some(parse(t1)), Some(t2)), Some(parse(t2)));
        assert_eq!(merge_resets_at(Some(parse(t2)), Some(t1)), Some(parse(t2)));
        // None / unparseable never erase a known reset.
        assert_eq!(merge_resets_at(Some(parse(t1)), None), Some(parse(t1)));
        assert_eq!(
            merge_resets_at(Some(parse(t1)), Some("not-a-time")),
            Some(parse(t1))
        );
        assert_eq!(merge_resets_at(None, None), None);
    }

    #[test]
    fn test_fire_at_adds_five_minutes_plus_epic_jitter() {
        let resets = DateTime::parse_from_rfc3339(RESETS_AT)
            .unwrap()
            .with_timezone(&Utc);
        let fire = fire_at_for(resets, "#37");
        let offset = (fire - resets).num_seconds();
        assert_eq!(offset, 300 + jitter_secs("#37") as i64);
        // Deterministic per epic, distinct between neighbors.
        assert_eq!(fire, fire_at_for(resets, "#37"));
        assert_ne!(fire_at_for(resets, "#37"), fire_at_for(resets, "#38"));
    }

    #[test]
    fn test_should_arm_keeps_a_later_existing_timer() {
        let new = DateTime::parse_from_rfc3339("2030-01-01T00:05:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(should_arm(None, new)); // nothing armed
        assert!(should_arm(Some("2030-01-01T00:00:00Z"), new)); // earlier → replace
        assert!(!should_arm(Some("2030-01-02T00:00:00Z"), new)); // later → keep
        assert!(!should_arm(Some("2030-01-01T00:05:00Z"), new)); // equal → keep
        assert!(should_arm(Some("garbage"), new)); // unparseable → replace
    }

    // --- sweep integration (real supervisor + injector + schedule) ---

    struct Harness {
        parker: Arc<SamuraiParker>,
        injector: Arc<SamuraiInjector>,
        supervisor: Arc<Supervisor>,
        context: Arc<SamuraiContextStore>,
        schedule: Arc<SamuraiSchedule>,
        audit: AuditLog,
        dirs: Arc<Mutex<HashMap<u32, String>>>,
        torn_down: Arc<Mutex<Vec<u32>>>,
    }

    fn harness(dir: &Path) -> Harness {
        let (audit, task) = AuditLog::new(dir.to_path_buf(), None);
        tokio::spawn(task);
        let supervisor = Arc::new(Supervisor::new(audit.clone(), None));
        let context = Arc::new(SamuraiContextStore::new());
        let config: SharedSamuraiConfig = Arc::new(RwLock::new(SamuraiConfig::default()));
        let dirs: Arc<Mutex<HashMap<u32, String>>> = Arc::new(Mutex::new(HashMap::new()));
        let dirs_for_resolver = dirs.clone();
        let resolver: SessionDirResolver =
            Arc::new(move |id| dirs_for_resolver.lock().unwrap().get(&id).cloned());
        let injector = Arc::new(SamuraiInjector::new(
            supervisor.clone(),
            context.clone(),
            config,
            // Issue #109: the injected writer confirms every body write, so
            // delivered rows behave as production's post-write verdict.
            Arc::new(|_, _, outcome: crate::core::samurai_pty::DeliveryOutcome| outcome(Ok(()))),
            audit.clone(),
            resolver,
            None,
        ));
        // The fire loop is irrelevant here — arm/list are synchronous.
        let (schedule, _task) = SamuraiSchedule::new(dir.join("schedule"), Arc::new(|_| {}), None);
        let torn_down: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
        let torn_down_rec = torn_down.clone();
        let teardown: SessionTeardown = Arc::new(move |id| {
            let rec = torn_down_rec.clone();
            Box::pin(async move {
                rec.lock().unwrap().push(id);
            })
        });
        let parker = SamuraiParker::new(
            supervisor.clone(),
            context.clone(),
            injector.clone(),
            schedule.clone(),
            audit.clone(),
            teardown,
        );
        injector.set_parker(parker.clone());
        Harness {
            parker,
            injector,
            supervisor,
            context,
            schedule,
            audit,
            dirs,
            torn_down,
        }
    }

    fn hard_event(resets_at: Option<&str>) -> AllowanceEvent {
        AllowanceEvent::ThresholdCrossed {
            window: AllowanceWindow::FiveHour,
            threshold_kind: ThresholdKind::Hard,
            value: 91.0,
            threshold: 90.0,
            resets_at: resets_at.map(str::to_string),
        }
    }

    fn soft_event() -> AllowanceEvent {
        AllowanceEvent::ThresholdCrossed {
            window: AllowanceWindow::FiveHour,
            threshold_kind: ThresholdKind::Soft,
            value: 80.0,
            threshold: 78.0,
            resets_at: Some(RESETS_AT.to_string()),
        }
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

    /// The Stop hook — the idle signal that lets the ladder inject.
    fn stop_event(session_id: u32) -> ClaudeEvent {
        ClaudeEvent::SessionEnded {
            session_id,
            reason: "stop".into(),
            timestamp: "t".into(),
        }
    }

    /// `git init` + one committed file (repo-local identity), plus the
    /// standard handoff file for `epic`/`generation` so park validation
    /// passes.
    fn init_parkable_repo(dir: &Path, epic: &str, generation: u32) {
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
        let rel = crate::core::samurai_prompts::handoff_file_relpath(epic, generation);
        let path = dir.join(&rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "# Handoff\n").unwrap();
    }

    /// Polls until `cond` holds or ~2s pass (teardown/advance run on the
    /// tauri runtime, not this test's).
    async fn wait_until(mut cond: impl FnMut() -> bool) {
        for _ in 0..200 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not reached within 2s");
    }

    fn state_of(supervisor: &Supervisor, session_id: u32) -> Option<SupervisorState> {
        supervisor
            .list_sessions()
            .into_iter()
            .find(|s| s.session_id == session_id)
            .map(|s| s.state)
    }

    /// Drives session `id` (gen `generation`) through the park ladder's
    /// happy path: the Stop hook injects, then ACK, then the written marker.
    fn complete_park(h: &Harness, id: u32, generation: u32) {
        h.injector.observe_hook(&stop_event(id));
        assert!(
            h.injector
                .pending_view(id)
                .is_some_and(|(attempts, _, _)| attempts >= 1),
            "park instruction must inject on the idle signal"
        );
        h.injector.observe(&assistant_message(
            id,
            &format!("<samurai-ack>park gen-{generation}</samurai-ack>"),
        ));
        h.injector.observe(&assistant_message(
            id,
            &format!("<samurai-handoff-written>gen-{generation} park</samurai-handoff-written>"),
        ));
    }

    #[tokio::test]
    async fn test_soft_event_winds_down_only_eligible_sessions() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        // Session 1: WORKING, clean → eligible. Session 2: mid-handoff.
        h.supervisor
            .register_session(1, "C:/git/p".into(), "#1".into(), 1)
            .unwrap();
        h.supervisor
            .register_session(2, "C:/git/p".into(), "#2".into(), 1)
            .unwrap();
        h.supervisor
            .transition(2, SupervisorState::HandoffRequested)
            .unwrap();

        h.parker.on_allowance_event(&soft_event());

        assert!(h.injector.has_pending(1), "eligible session wound down");
        assert!(!h.injector.has_pending(2), "mid-handoff session skipped");
        assert_eq!(state_of(&h.supervisor, 1), Some(SupervisorState::Working));
        assert!(!h.parker.parking_engaged(), "soft never engages the sweep");

        // A second soft crossing while the first wind-down is pending is a
        // no-op for that session (no duplicate entry, attempts untouched).
        h.parker.on_allowance_event(&soft_event());
        assert_eq!(h.injector.pending_view(1), Some((0, false, false)));
    }

    /// Issue #120: the watcher's soft falling edge — window reset or usage
    /// decay, whichever came first.
    fn recovered_event() -> AllowanceEvent {
        AllowanceEvent::SoftRecovered {
            window: AllowanceWindow::FiveHour,
            value: 10.0,
            threshold: 78.0,
        }
    }

    #[tokio::test]
    async fn test_soft_recovery_all_clears_wound_down_sessions_once() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        // Session 1: WORKING, wound down. Session 2: mid-handoff, skipped.
        h.supervisor
            .register_session(1, "C:/git/p".into(), "#1".into(), 1)
            .unwrap();
        h.supervisor
            .register_session(2, "C:/git/p".into(), "#2".into(), 1)
            .unwrap();
        h.supervisor
            .transition(2, SupervisorState::HandoffRequested)
            .unwrap();

        // The episode: wind-down delivered and acked.
        h.parker.on_allowance_event(&soft_event());
        h.injector.observe_hook(&stop_event(1));
        h.injector.observe(&assistant_message(
            1,
            "<samurai-ack>winddown gen-1-1</samurai-ack>",
        ));
        assert!(!h.injector.has_pending(1));

        // Recovery: only the wound-down, never-parked session gets the
        // ack-only all-clear; nothing transitions.
        h.parker.on_allowance_event(&recovered_event());
        assert!(
            h.injector.has_pending(1),
            "wound-down session gets the all-clear"
        );
        assert!(
            !h.injector.has_pending(2),
            "never-wound-down session gets nothing"
        );
        assert_eq!(state_of(&h.supervisor, 1), Some(SupervisorState::Working));
        h.injector.observe_hook(&stop_event(1));
        h.injector.observe(&assistant_message(
            1,
            "<samurai-ack>allclear gen-1-1</samurai-ack>",
        ));
        assert!(!h.injector.has_pending(1));
        assert_eq!(state_of(&h.supervisor, 1), Some(SupervisorState::Working));

        // Edge-trigger once per episode: a second recovery without a new
        // wind-down sends nothing.
        h.parker.on_allowance_event(&recovered_event());
        assert!(!h.injector.has_pending(1));
    }

    #[tokio::test]
    async fn test_soft_recovery_defers_all_clear_while_parking_engaged() {
        // Fix M6: a hard park sweep in flight walks WORKING sessions toward
        // ParkRequested one at a time — a session still queued for its turn
        // is still WORKING, so a 5h-window reset mid-sweep must not inject
        // "resume full throughput" into it while the 7d allowance the sweep
        // exists to protect is still exhausted.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-defer";

        // Session 2 winds down first, then ALERTs its (unrelated, prior)
        // park attempt — excluded from every future sweep's candidates, so
        // it stays WORKING for the sweep's whole life without ever being
        // targeted.
        h.supervisor
            .register_session(2, project.into(), "#2".into(), 1)
            .unwrap();
        h.parker.on_allowance_event(&soft_event());
        assert!(h.injector.has_pending(2), "session 2 wound down");
        h.parker.on_park_failed(2);

        // Session 1 is the sweep's real, parkable target.
        let repo = tempdir().unwrap();
        init_parkable_repo(repo.path(), "#1", 1);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        h.supervisor
            .register_session(1, project.into(), "#1".into(), 1)
            .unwrap();

        h.parker.on_allowance_event(&hard_event(Some(RESETS_AT)));
        assert!(h.parker.parking_engaged());
        assert_eq!(
            state_of(&h.supervisor, 1),
            Some(SupervisorState::ParkRequested)
        );
        assert_eq!(state_of(&h.supervisor, 2), Some(SupervisorState::Working));

        // The 5h window resets mid-sweep: deferred, not delivered — session
        // 2's ORIGINAL wind-down entry is untouched (acking it with the
        // wind-down value, not an all-clear value, still completes it
        // normally, proving nothing overwrote it).
        h.parker.on_allowance_event(&recovered_event());
        assert!(h.parker.parking_engaged(), "sweep still in flight");
        h.injector.observe_hook(&stop_event(2));
        h.injector.observe(&assistant_message(
            2,
            "<samurai-ack>winddown gen-1-1</samurai-ack>",
        ));
        assert!(
            !h.injector.has_pending(2),
            "the deferred all-clear never overwrote the wind-down entry"
        );

        // Complete the sweep: session 1 parks, its timer arms, engaged
        // clears. Session 2 was never touched.
        complete_park(&h, 1, 1);
        wait_until(|| !h.parker.parking_engaged()).await;
        assert_eq!(
            state_of(&h.supervisor, 2),
            Some(SupervisorState::Working),
            "the failed, excluded session was never targeted"
        );

        // Fix C1: DEFERRED, not DROPPED — and the deferral is re-driven by
        // the SWEEP's completion, with NO second allowance event. That is
        // the whole point: `SoftRecovered` is a one-shot falling edge
        // (`allowance_watcher`: only when above_soft_5h goes true→false), so
        // a second event the real watcher can never emit must not be what
        // rescues the episode.
        wait_until(|| h.injector.has_pending(2)).await;
        h.injector.observe_hook(&stop_event(2));
        h.injector.observe(&assistant_message(
            2,
            "<samurai-ack>allclear gen-1-1</samurai-ack>",
        ));
        assert!(
            !h.injector.has_pending(2),
            "the re-driven instruction is the all-clear (its ack value clears it)"
        );
        assert_eq!(state_of(&h.supervisor, 2), Some(SupervisorState::Working));
    }

    /// Fix T1 (issue #131 review 2): the parker-seam proof for fix L6 —
    /// `soft_winddown` must consult `blocks_soft_winddown`, not `has_pending`.
    /// A session sitting on an un-acked all-clear from a PRIOR episode is
    /// still eligible for a NEW wind-down; reverting the check to
    /// `has_pending` makes this test fail.
    #[tokio::test]
    async fn test_soft_crossing_winds_down_over_a_pending_unacked_all_clear() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        h.supervisor
            .register_session(1, "C:/git/p".into(), "#1".into(), 1)
            .unwrap();

        // Episode 1: wind down, ack it, then all-clear — and leave the
        // all-clear UN-ACKED (the agent never replied).
        h.parker.on_allowance_event(&soft_event());
        h.injector.observe_hook(&stop_event(1));
        h.injector.observe(&assistant_message(
            1,
            "<samurai-ack>winddown gen-1-1</samurai-ack>",
        ));
        h.parker.on_allowance_event(&recovered_event());
        assert!(h.injector.has_pending(1), "all-clear is pending, un-acked");

        // Episode 2: usage climbs back over soft. The stale all-clear must
        // NOT eat this crossing — the session winds down again.
        h.parker.on_allowance_event(&soft_event());
        h.injector.observe_hook(&stop_event(1));
        h.injector.observe(&assistant_message(
            1,
            "<samurai-ack>winddown gen-1-2</samurai-ack>",
        ));
        assert!(
            !h.injector.has_pending(1),
            "the pending entry is episode 2's WIND-DOWN (only its ack value clears it), \
             not the superseded all-clear"
        );
    }

    #[tokio::test]
    async fn test_hard_sweep_parks_sequentially_highest_context_first() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-sweep";
        let repo1 = tempdir().unwrap();
        let repo2 = tempdir().unwrap();
        init_parkable_repo(repo1.path(), "#1", 1);
        init_parkable_repo(repo2.path(), "#2", 1);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo1.path().to_string_lossy().into_owned());
        h.dirs
            .lock()
            .unwrap()
            .insert(2, repo2.path().to_string_lossy().into_owned());
        h.supervisor
            .register_session(1, project.into(), "#1".into(), 1)
            .unwrap();
        h.supervisor
            .register_session(2, project.into(), "#2".into(), 1)
            .unwrap();
        h.context.observe(&context_event(1, 30.0));
        h.context.observe(&context_event(2, 80.0));

        h.parker.on_allowance_event(&hard_event(Some(RESETS_AT)));

        // Sequential: the HIGHER-context session 2 goes first; session 1
        // is untouched until session 2 finishes.
        assert!(h.parker.parking_engaged());
        assert_eq!(
            state_of(&h.supervisor, 2),
            Some(SupervisorState::ParkRequested)
        );
        assert_eq!(state_of(&h.supervisor, 1), Some(SupervisorState::Working));

        complete_park(&h, 2, 1);
        wait_until(|| state_of(&h.supervisor, 2) == Some(SupervisorState::Parked)).await;
        // Teardown ran for session 2, then the sweep advanced to session 1.
        wait_until(|| state_of(&h.supervisor, 1) == Some(SupervisorState::ParkRequested)).await;
        assert_eq!(*h.torn_down.lock().unwrap(), vec![2]);

        complete_park(&h, 1, 1);
        wait_until(|| state_of(&h.supervisor, 1) == Some(SupervisorState::Parked)).await;
        // Sweep completes: timers armed for BOTH epics, engaged cleared.
        wait_until(|| !h.parker.parking_engaged()).await;
        assert_eq!(*h.torn_down.lock().unwrap(), vec![2, 1]);

        let mut timers = h.schedule.list();
        timers.sort_by(|a, b| a.epic.cmp(&b.epic));
        assert_eq!(timers.len(), 2);
        let resets = DateTime::parse_from_rfc3339(RESETS_AT)
            .unwrap()
            .with_timezone(&Utc);
        for timer in &timers {
            assert_eq!(timer.project_path, project);
            assert_eq!(timer.reason, "park");
            let fire = DateTime::parse_from_rfc3339(&timer.fire_at)
                .unwrap()
                .with_timezone(&Utc);
            assert_eq!(fire, fire_at_for(resets, &timer.epic));
        }
        // The trail carries one timer_armed PARK row per epic.
        let rows = h.audit.read(project, None, None).await.unwrap().events;
        let armed: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Park && r.details["phase"] == "timer_armed")
            .collect();
        assert_eq!(armed.len(), 2);
    }

    #[tokio::test]
    async fn test_second_hard_event_mid_sweep_merges_reset_and_never_double_targets() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-merge";
        let repo = tempdir().unwrap();
        init_parkable_repo(repo.path(), "#1", 1);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        h.supervisor
            .register_session(1, project.into(), "#1".into(), 1)
            .unwrap();

        h.parker.on_allowance_event(&hard_event(Some(RESETS_AT)));
        assert_eq!(
            state_of(&h.supervisor, 1),
            Some(SupervisorState::ParkRequested)
        );
        assert_eq!(h.injector.pending_view(1), Some((0, false, false)));

        // The 7d hard crossing lands mid-sweep with a LATER reset: no second
        // sweep, no re-arm of the ladder — only the reset time merges.
        let later = "2030-01-03T00:00:00Z";
        h.parker
            .on_allowance_event(&AllowanceEvent::ThresholdCrossed {
                window: AllowanceWindow::SevenDay,
                threshold_kind: ThresholdKind::Hard,
                value: 96.0,
                threshold: 95.0,
                resets_at: Some(later.to_string()),
            });
        assert_eq!(h.injector.pending_view(1), Some((0, false, false)));

        complete_park(&h, 1, 1);
        wait_until(|| !h.parker.parking_engaged()).await;

        let timers = h.schedule.list();
        assert_eq!(timers.len(), 1);
        let fire = DateTime::parse_from_rfc3339(&timers[0].fire_at)
            .unwrap()
            .with_timezone(&Utc);
        let later_reset = DateTime::parse_from_rfc3339(later)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(fire, fire_at_for(later_reset, "#1"), "LATER reset wins");
    }

    #[tokio::test]
    async fn test_failed_park_is_skipped_and_sweep_continues() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-fail";
        let repo = tempdir().unwrap();
        init_parkable_repo(repo.path(), "#2", 1);
        h.dirs
            .lock()
            .unwrap()
            .insert(2, repo.path().to_string_lossy().into_owned());
        h.supervisor
            .register_session(1, project.into(), "#1".into(), 1)
            .unwrap();
        h.supervisor
            .register_session(2, project.into(), "#2".into(), 1)
            .unwrap();
        h.context.observe(&context_event(1, 90.0));
        h.context.observe(&context_event(2, 10.0));

        h.parker.on_allowance_event(&hard_event(Some(RESETS_AT)));
        assert_eq!(
            state_of(&h.supervisor, 1),
            Some(SupervisorState::ParkRequested)
        );

        // Session 1 never ACKs: retry, then the ladder ALERTs — the parker
        // skips it and moves to session 2.
        h.injector.observe_hook(&stop_event(1)); // attempt 1
        assert_eq!(h.injector.pending_view(1), Some((1, false, false)));
        h.injector
            .backdate_injection(1, TIMEOUT + Duration::from_secs(1));
        h.injector.observe_hook(&stop_event(1)); // replied without the marker
        h.injector.tick(); // arms the retry + injects attempt 2 (idle now)
        assert_eq!(h.injector.pending_view(1), Some((2, false, false)));
        h.injector
            .backdate_injection(1, TIMEOUT + Duration::from_secs(1));
        h.injector.tick(); // attempt 2 expired → ALERT → parker skips it

        wait_until(|| state_of(&h.supervisor, 2) == Some(SupervisorState::ParkRequested)).await;
        // The failed session stays in PARK_REQUESTED for a human.
        assert_eq!(
            state_of(&h.supervisor, 1),
            Some(SupervisorState::ParkRequested)
        );

        complete_park(&h, 2, 1);
        wait_until(|| !h.parker.parking_engaged()).await;

        // Only the PARKED epic got a timer; the failed one has its ALERT.
        let timers = h.schedule.list();
        assert_eq!(timers.len(), 1);
        assert_eq!(timers[0].epic, "#2");
        let rows = h.audit.read(project, None, None).await.unwrap().events;
        assert!(rows.iter().any(|r| {
            r.event == AuditEventKind::Alert
                && r.details["kind"] == "ack_timeout"
                && r.details["instruction"] == "park"
        }));
        assert_eq!(*h.torn_down.lock().unwrap(), vec![2]);
    }

    #[tokio::test]
    async fn test_mid_handoff_session_is_absorbed_not_parked() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-absorb";
        // Session 1 is mid-handoff WITH a live ladder entry (the injector's
        // trigger created it) when the hard threshold crosses.
        h.supervisor
            .register_session(1, project.into(), "#1".into(), 1)
            .unwrap();
        h.context.observe(&context_event(1, 50.0));
        h.injector.tick();
        assert_eq!(
            state_of(&h.supervisor, 1),
            Some(SupervisorState::HandoffRequested)
        );

        h.parker.on_allowance_event(&hard_event(Some(RESETS_AT)));
        // Mutual exclusion: no park instruction for it — the sweep waits.
        assert!(h.parker.parking_engaged());
        assert_eq!(
            state_of(&h.supervisor, 1),
            Some(SupervisorState::HandoffRequested)
        );
        h.parker.tick();
        assert!(
            h.parker.parking_engaged(),
            "completing handoff holds the sweep open"
        );

        // The handoff completes; the replicator (simulated here) kills the
        // session and consults the parker instead of spawning a successor.
        h.supervisor
            .transition(1, SupervisorState::HandoffWritten)
            .unwrap();
        h.supervisor.transition(1, SupervisorState::Killed).unwrap();
        assert!(
            h.parker.absorb_handoff(project, "#1"),
            "engaged sweep absorbs"
        );

        // Absorption completes the sweep: the epic still gets its timer.
        wait_until(|| !h.parker.parking_engaged()).await;
        let timers = h.schedule.list();
        assert_eq!(timers.len(), 1);
        assert_eq!(timers[0].epic, "#1");
        assert_eq!(timers[0].reason, "park");

        // Disengaged afterwards: absorption reverts to a plain "no".
        assert!(!h.parker.absorb_handoff(project, "#1"));
    }

    #[tokio::test]
    async fn test_missing_resets_at_alerts_instead_of_arming() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-noreset";
        let repo = tempdir().unwrap();
        init_parkable_repo(repo.path(), "#1", 1);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        h.supervisor
            .register_session(1, project.into(), "#1".into(), 1)
            .unwrap();

        h.parker.on_allowance_event(&hard_event(None));
        complete_park(&h, 1, 1);
        wait_until(|| !h.parker.parking_engaged()).await;

        assert!(h.schedule.list().is_empty(), "no guessed timer");
        let mut alerted = false;
        for _ in 0..200 {
            let rows = h.audit.read(project, None, None).await.unwrap().events;
            alerted = rows.iter().any(|r| {
                r.event == AuditEventKind::Alert
                    && r.details["kind"] == "park_no_reset_time"
                    && r.details["epic"] == "#1"
            });
            if alerted {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(alerted, "park_no_reset_time ALERT must fire");
    }

    #[tokio::test]
    async fn test_existing_later_timer_is_kept() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-keep";
        let repo = tempdir().unwrap();
        init_parkable_repo(repo.path(), "#1", 1);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        h.supervisor
            .register_session(1, project.into(), "#1".into(), 1)
            .unwrap();
        // A LATER timer already armed for the epic (e.g. an earlier 7d park).
        let later = "2031-06-01T00:00:00+00:00";
        h.schedule
            .arm(ScheduleEntry {
                project_path: project.to_string(),
                epic: "#1".to_string(),
                fire_at: later.to_string(),
                reason: "park".to_string(),
                launch: None,
                held: false,
            })
            .unwrap();

        h.parker.on_allowance_event(&hard_event(Some(RESETS_AT)));
        complete_park(&h, 1, 1);
        wait_until(|| !h.parker.parking_engaged()).await;

        let timers = h.schedule.list();
        assert_eq!(timers.len(), 1);
        assert_eq!(timers[0].fire_at, later, "the later timer survives");
    }

    // --- issue #63: external park (gh auth loss) ---

    #[tokio::test]
    async fn test_external_park_sweeps_without_timers_or_noise() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-ext";
        let repo = tempdir().unwrap();
        init_parkable_repo(repo.path(), "#1", 1);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        h.supervisor
            .register_session(1, project.into(), "#1".into(), 1)
            .unwrap();

        h.parker.engage_external_park("gh_auth_lost");

        // The sweep engages exactly like a hard allowance crossing.
        assert!(h.parker.parking_engaged());
        assert_eq!(
            state_of(&h.supervisor, 1),
            Some(SupervisorState::ParkRequested)
        );

        complete_park(&h, 1, 1);
        wait_until(|| !h.parker.parking_engaged()).await;
        assert_eq!(*h.torn_down.lock().unwrap(), vec![1]);

        // No reset time BY DESIGN: no resume timer, and no per-epic
        // park_no_reset_time noise — only the one gh_auth_lost ALERT on the
        // supervised project.
        assert!(h.schedule.list().is_empty(), "no guessed timer");
        let rows = h.audit.read(project, None, None).await.unwrap().events;
        assert_eq!(
            rows.iter()
                .filter(|r| {
                    r.event == AuditEventKind::Alert && r.details["kind"] == "gh_auth_lost"
                })
                .count(),
            1
        );
        assert!(
            !rows
                .iter()
                .any(|r| r.details["kind"] == "park_no_reset_time"),
            "external park must not emit park_no_reset_time per epic"
        );
    }

    #[tokio::test]
    async fn test_external_park_alerts_account_project_when_nothing_supervised() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());

        h.parker.engage_external_park("gh_auth_lost");

        // Nothing supervised: the ALERT still lands (ACCOUNT_PROJECT
        // fallback, the allowance watcher's placement policy) and the empty
        // sweep completes without arming anything.
        wait_until(|| !h.parker.parking_engaged()).await;
        assert!(h.schedule.list().is_empty());
        let rows = h.audit.read(ACCOUNT_PROJECT, None, None).await.unwrap().events;
        assert_eq!(
            rows.iter()
                .filter(|r| r.details["kind"] == "gh_auth_lost")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn test_hard_crossing_joining_an_external_sweep_arms_timers_again() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-ext-merge";
        let repo = tempdir().unwrap();
        init_parkable_repo(repo.path(), "#1", 1);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        h.supervisor
            .register_session(1, project.into(), "#1".into(), 1)
            .unwrap();

        h.parker.engage_external_park("gh_auth_lost");
        // A real allowance crossing joins mid-sweep: it brings a reset
        // story, so timer suppression lifts and its timer arms normally.
        h.parker.on_allowance_event(&hard_event(Some(RESETS_AT)));

        complete_park(&h, 1, 1);
        wait_until(|| !h.parker.parking_engaged()).await;
        let timers = h.schedule.list();
        assert_eq!(timers.len(), 1, "the allowance crossing's timer arms");
        assert_eq!(timers[0].epic, "#1");
    }

    #[tokio::test]
    async fn test_external_park_joining_a_hard_sweep_keeps_its_timers() {
        // The mirror of the test above, and the invariant the engage/lock
        // atomicity protects: an external park that arrives while an
        // allowance sweep is already engaged must NOT re-suppress that
        // sweep's timers (a stale "was engaged" answer used to be able to).
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-hard-then-ext";
        let repo = tempdir().unwrap();
        init_parkable_repo(repo.path(), "#1", 1);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        h.supervisor
            .register_session(1, project.into(), "#1".into(), 1)
            .unwrap();

        h.parker.on_allowance_event(&hard_event(Some(RESETS_AT)));
        h.parker.engage_external_park("gh_auth_lost");

        complete_park(&h, 1, 1);
        wait_until(|| !h.parker.parking_engaged()).await;
        let timers = h.schedule.list();
        assert_eq!(
            timers.len(),
            1,
            "the allowance sweep's timer survives a joining external park"
        );
        assert_eq!(timers[0].epic, "#1");
        let resets = DateTime::parse_from_rfc3339(RESETS_AT)
            .unwrap()
            .with_timezone(&Utc);
        let fire = DateTime::parse_from_rfc3339(&timers[0].fire_at)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(fire, fire_at_for(resets, "#1"));
    }

    #[tokio::test]
    async fn test_session_registered_mid_sweep_gets_parked_too() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-late";
        let repo1 = tempdir().unwrap();
        let repo3 = tempdir().unwrap();
        init_parkable_repo(repo1.path(), "#1", 1);
        init_parkable_repo(repo3.path(), "#3", 2);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo1.path().to_string_lossy().into_owned());
        h.dirs
            .lock()
            .unwrap()
            .insert(3, repo3.path().to_string_lossy().into_owned());
        h.supervisor
            .register_session(1, project.into(), "#1".into(), 1)
            .unwrap();

        h.parker.on_allowance_event(&hard_event(Some(RESETS_AT)));
        assert_eq!(
            state_of(&h.supervisor, 1),
            Some(SupervisorState::ParkRequested)
        );

        // A new session registers mid-sweep (e.g. a recovery successor).
        h.supervisor
            .register_session(3, project.into(), "#3".into(), 2)
            .unwrap();

        complete_park(&h, 1, 1);
        // The sweep reaches the newcomer instead of completing around it.
        wait_until(|| state_of(&h.supervisor, 3) == Some(SupervisorState::ParkRequested)).await;
        assert!(h.parker.parking_engaged());

        complete_park(&h, 3, 2);
        wait_until(|| !h.parker.parking_engaged()).await;
        let mut epics: Vec<String> = h.schedule.list().into_iter().map(|e| e.epic).collect();
        epics.sort();
        assert_eq!(epics, vec!["#1".to_string(), "#3".to_string()]);
    }
}
