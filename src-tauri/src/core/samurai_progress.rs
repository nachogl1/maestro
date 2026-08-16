//! Samurai progress tracker: circuit breaker + handoff churn detection
//! (Phase 2, issue #57; PRD §5.7 + §7).
//!
//! **The progress signal is commits** — the repo HEAD moving in the epic's
//! working directory. The PRD says "zero commits/issue-updates"; issue-update
//! polling via `gh` is explicitly OUT of scope for v1 — commits only.
//!
//! Two consumers of that signal:
//!
//! 1. **Circuit breaker (runaway burn):** per epic (key: project + epic),
//!    count consecutive samurai audit events with HEAD unchanged. On each
//!    appended event for a tracked epic, HEAD is re-read in the epic's
//!    working dir: equal to the last observed → increment; different →
//!    progress, reset the counter. The counter reaching the configurable
//!    `breaker_events` trips ONCE: the epic's live WORKING session is parked
//!    (`PARK_REQUESTED` → `PARKED`) and one ALERT audit row
//!    (`details.kind = "circuit_breaker"`) fires. A session mid-handoff is
//!    never parked (HANDOFF/PARK mutual exclusion — the supervisor enforces
//!    it, see `validate_transition`); the trip stays latched and re-evaluates
//!    on the epic's next event, or when a successor registers.
//! 2. **Handoff churn:** at handoff-trigger time — the `HANDOFF
//!    phase=requested` audit row that the injector's trigger tick (or a
//!    manual transition) writes — the current HEAD is compared against the
//!    generation's `baseline_head`, recorded when the session registered.
//!    Equal (zero commits this generation) → ALERT
//!    (`details.kind = "handoff_churn"`). The handoff still proceeds — churn
//!    is a signal, not a block.
//!
//! **Phase-2 meaning of PARKED:** a supervisor state + a frontend badge, and
//! the injector leaves the session alone — its trigger predicate
//! (`should_request_handoff`) fires only for WORKING sessions, per its table
//! test. No wind-down instruction is typed in, no resume timer is armed, no
//! resume exists: that machinery is Phase 3.
//!
//! **Unknown evidence never trips.** An unresolvable working dir or a failed
//! `git rev-parse` leaves the HEAD unknown; unknown HEADs are skipped by the
//! counter and produce no churn alert. False trips are worse than misses —
//! same philosophy as the silent-death watchdog.
//!
//! **Never blocks the audit callback.** `AuditLog`'s `on_append` is
//! synchronous and fire-and-forget, so [`observe_audit`] /
//! [`on_state_change`] only queue a job on an unbounded channel; a single
//! worker task does the git reads (`spawn_blocking`) and state updates,
//! strictly in queue order — same single-consumer shape as the audit writer.
//!
//! [`observe_audit`]: SamuraiProgress::observe_audit
//! [`on_state_change`]: SamuraiProgress::on_state_change

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::sync::mpsc;

use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_config::SharedSamuraiConfig;
use super::samurai_injector::{strip_extended_prefix, SessionDirResolver};
use super::samurai_replicator::read_repo_head;
use super::supervisor::{SessionSnapshot, Supervisor, SupervisorState};

/// Per-generation baseline, recorded when the session registers. `None`
/// baseline = HEAD was unknowable at registration → churn never alarms for
/// this generation. Carries its epic key so a removal (fresh-eyes finding H)
/// can tell whether it was the epic's LAST baseline (finding I's prune).
struct SessionBaseline {
    project: String,
    epic: String,
    generation: u32,
    baseline_head: Option<String>,
}

/// Per-epic breaker state. `observed_head` is the HEAD the counter is
/// counting against; `latched` marks a due trip that could not park anybody
/// yet (mid-handoff / between generations) and re-evaluates on the epic's
/// next event or registration.
struct EpicBreaker {
    working_dir: String,
    observed_head: Option<String>,
    count: u32,
    latched: bool,
}

/// (project, epic) — the breaker's counting key.
type EpicKey = (String, String);

#[derive(Default)]
struct ProgressState {
    baselines: HashMap<u32, SessionBaseline>,
    epics: HashMap<EpicKey, EpicBreaker>,
}

/// Work items for the single worker task.
enum Job {
    /// A session registered (any generation, successors included).
    Register {
        session_id: u32,
        project: String,
        epic: String,
        generation: u32,
        /// Resolved at queue time, while the session certainly exists.
        working_dir: Option<String>,
    },
    /// A session reached a terminal state — its baseline is gone with it.
    /// The epic's breaker entry deliberately SURVIVES this: the killed→
    /// successor window has zero baselines, and the counter/latch must
    /// persist across it (zero progress across a handoff stays visible).
    Terminal { session_id: u32 },
    /// A session was torn down outside the samurai pipeline (fresh-eyes
    /// finding H — manual kill / project close / frontend reload). Drops the
    /// baseline, and when it was the epic's LAST baseline the (project,
    /// epic) breaker entry is pruned too (finding I): no successor is coming
    /// through the supervisor for a torn-down epic.
    Removed { session_id: u32 },
    /// One appended audit row (already durable) to count/evaluate.
    Audit { project: String, event: AuditEvent },
    /// Test-only barrier: replied to once every prior job is processed.
    #[cfg(test)]
    Flush(tokio::sync::oneshot::Sender<()>),
}

// ---------------------------------------------------------------------------
// Pure decisions (table-tested)
// ---------------------------------------------------------------------------

/// Guard against self-amplification: events this module itself produces must
/// NOT advance the breaker counter, or one trip (2 PARK rows + 1 ALERT)
/// would immediately push the next epic's-worth of "events" and cascade.
/// Filtered by event type / `details.kind`:
/// - every `PARK` row — in Phase 2 a park is exactly what a trip produces
///   (and Phase 3's allowance parks are equally not evidence of burn);
/// - this module's own ALERT kinds (`circuit_breaker`, `handoff_churn`).
fn is_self_event(event: &AuditEvent) -> bool {
    match event.event {
        AuditEventKind::Park => true,
        // INJECT rows (issue #101) record Maestro's OWN typing — replay
        // telemetry, not evidence of orchestrator burn. Counting them would
        // add two rows per handoff cycle and trip the breaker faster for
        // the same behavior.
        AuditEventKind::Inject => true,
        AuditEventKind::Alert => matches!(
            event.details["kind"].as_str(),
            Some("circuit_breaker") | Some("handoff_churn")
        ),
        _ => false,
    }
}

/// Handoff-trigger time, as seen from the audit stream: the `HANDOFF
/// phase=requested` row is written by the very `WORKING →
/// HANDOFF_REQUESTED` transition the injector's trigger tick performs.
fn is_handoff_trigger(event: &AuditEvent) -> bool {
    event.event == AuditEventKind::Handoff && event.details["phase"] == "requested"
}

/// One HEAD observation applied to the breaker counter:
/// `(observed, count, latched) → (observed, count, latched)`.
///
/// - Unknown HEAD → skip entirely (nothing counted, nothing reset): an epic
///   whose HEAD cannot be read NEVER trips.
/// - HEAD equal to the last observed → one more consecutive zero-progress
///   event: increment.
/// - HEAD different (including the very first observation) → progress:
///   reset the counter, update the observed HEAD, clear any latch.
fn next_breaker(
    observed: Option<&str>,
    count: u32,
    latched: bool,
    head: Option<&str>,
) -> (Option<String>, u32, bool) {
    match (observed, head) {
        (_, None) => (observed.map(str::to_string), count, latched),
        (Some(o), Some(h)) if o == h => (Some(o.to_string()), count.saturating_add(1), latched),
        (_, Some(h)) => (Some(h.to_string()), 0, false),
    }
}

/// Churn: the generation is handing off with its baseline HEAD (recorded at
/// registration) still equal to the current HEAD — zero commits. Unknown on
/// either side → `false`: never false-alarm.
fn is_churn(baseline: Option<&str>, head: Option<&str>) -> bool {
    matches!((baseline, head), (Some(b), Some(h)) if b == h)
}

/// Which live `(session_id, generation, state)` a due trip should park: the
/// highest-generation WORKING session. `None` defers the trip (latched):
/// mid-handoff sessions must not be parked (HANDOFF/PARK mutual exclusion),
/// a PARK_REQUESTED session is already parking, and an empty list means the
/// epic is between generations — the successor's registration re-evaluates.
fn park_candidate(live: &[(u32, u32, SupervisorState)]) -> Option<u32> {
    live.iter()
        .filter(|(_, _, state)| *state == SupervisorState::Working)
        .max_by_key(|(_, generation, _)| *generation)
        .map(|(session_id, _, _)| *session_id)
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/// The progress tracker. Fed from two synchronous tees in `lib.rs` — the
/// audit log's `on_append` and the supervisor's change callback — both of
/// which only queue; all real work happens on the single worker task.
pub struct SamuraiProgress {
    supervisor: Arc<Supervisor>,
    config: SharedSamuraiConfig,
    audit: AuditLog,
    session_dirs: SessionDirResolver,
    tx: mpsc::UnboundedSender<Job>,
    state: Mutex<ProgressState>,
}

impl SamuraiProgress {
    /// Builds the tracker and returns the handle plus the worker-task future
    /// for the caller to spawn (`tauri::async_runtime::spawn` in the app,
    /// `tokio::spawn` in tests) — same runtime-free pattern as `AuditLog`.
    pub fn new(
        supervisor: Arc<Supervisor>,
        config: SharedSamuraiConfig,
        audit: AuditLog,
        session_dirs: SessionDirResolver,
    ) -> (Arc<Self>, impl std::future::Future<Output = ()> + Send) {
        let (tx, rx) = mpsc::unbounded_channel();
        let this = Arc::new(Self {
            supervisor,
            config,
            audit,
            session_dirs,
            tx,
            state: Mutex::new(ProgressState::default()),
        });
        let worker = worker_task(this.clone(), rx);
        (this, worker)
    }

    /// Supervisor change tee (sync, queue-only). A fresh registration
    /// (`previous_state: None`) starts baseline tracking — the working dir is
    /// resolved NOW, while the session certainly exists; the HEAD read is the
    /// worker's job. A terminal state drops the session's baseline.
    pub fn on_state_change(&self, snapshot: &SessionSnapshot) {
        if snapshot.previous_state.is_none() {
            self.send(Job::Register {
                session_id: snapshot.session_id,
                project: snapshot.project.clone(),
                epic: snapshot.epic.clone(),
                generation: snapshot.generation,
                working_dir: (self.session_dirs)(snapshot.session_id),
            });
        } else if snapshot.state.is_terminal() {
            self.send(Job::Terminal {
                session_id: snapshot.session_id,
            });
        }
    }

    /// Audit `on_append` tee (sync, fire-and-forget — MUST not block):
    /// queue-only; the worker reads HEAD and counts.
    pub fn observe_audit(&self, project: &str, event: &AuditEvent) {
        self.send(Job::Audit {
            project: project.to_string(),
            event: event.clone(),
        });
    }

    /// Teardown propagation (fresh-eyes finding H): the session was closed
    /// outside the samurai pipeline, so its baseline must go — and, when it
    /// was the epic's last one, the breaker entry with it (finding I).
    /// Queue-only, same non-blocking discipline as the tees.
    pub fn remove_session(&self, session_id: u32) {
        self.send(Job::Removed { session_id });
    }

    fn send(&self, job: Job) {
        if self.tx.send(job).is_err() {
            log::error!("samurai progress: worker task is gone; dropping job");
        }
    }

    /// Register: read the baseline HEAD (unknowable → `None`, which can
    /// never alarm), store the baseline + epic entry, then re-evaluate a
    /// latched trip — "or its successor registers" is this call.
    async fn handle_register(
        &self,
        session_id: u32,
        project: String,
        epic: String,
        generation: u32,
        working_dir: Option<String>,
    ) {
        let baseline_head = match &working_dir {
            Some(dir) => read_head(dir.clone()).await,
            None => {
                log::warn!(
                    "samurai progress: session {session_id} has no resolvable working directory — no progress baseline (breaker/churn will never alarm for it)"
                );
                None
            }
        };
        {
            let mut state = self.lock_state();
            state.baselines.insert(
                session_id,
                SessionBaseline {
                    project: project.clone(),
                    epic: epic.clone(),
                    generation,
                    baseline_head,
                },
            );
            if let Some(dir) = working_dir {
                // The epic worktree is stable across generations (PRD §5.9);
                // a successor refreshes the dir but keeps the counter — zero
                // progress across a handoff stays visible.
                let entry = state
                    .epics
                    .entry((project.clone(), epic.clone()))
                    .or_insert_with(|| EpicBreaker {
                        working_dir: dir.clone(),
                        observed_head: None,
                        count: 0,
                        latched: false,
                    });
                entry.working_dir = dir;
                // gen-1 is a LAUNCH, never a successor: `spawn_first_
                // generation` hardcodes 1, successors are `generation + 1`
                // and a resume's `next_generation` is `prior + 1` — both
                // always >= 2. A terminal transition deliberately KEEPS the
                // epic entry and `handle_removed` bails out once the
                // baseline is already gone, so without this reset the
                // previous run's count/latch would park a freshly launched
                // orchestrator on sight (`evaluate_trip` below).
                if generation == 1 {
                    entry.observed_head = None;
                    entry.count = 0;
                    entry.latched = false;
                }
            }
        }
        self.evaluate_trip(&project, &epic);
    }

    fn handle_terminal(&self, session_id: u32) {
        self.lock_state().baselines.remove(&session_id);
    }

    /// Finding H/I: baseline gone; when it was the epic's LAST baseline, the
    /// (project, epic) breaker entry is pruned with it. Only the REMOVAL
    /// path prunes — a terminal *transition* (see [`Job::Terminal`]) leaves
    /// the entry so the counter/latch survive the killed→successor window.
    fn handle_removed(&self, session_id: u32) {
        let mut state = self.lock_state();
        let Some(baseline) = state.baselines.remove(&session_id) else {
            return;
        };
        let key: EpicKey = (baseline.project, baseline.epic);
        let epic_has_baselines = state
            .baselines
            .values()
            .any(|b| b.project == key.0 && b.epic == key.1);
        if !epic_has_baselines && state.epics.remove(&key).is_some() {
            log::info!(
                "samurai progress: last baseline for epic {} removed — pruning its breaker entry",
                key.1
            );
        }
    }

    /// One appended audit row: filter self-produced events, then (for a
    /// tracked epic) read HEAD once and feed both the churn check and the
    /// breaker counter with it.
    async fn handle_audit(&self, project: String, event: AuditEvent) {
        if is_self_event(&event) {
            return;
        }
        let key: EpicKey = (project.clone(), event.epic.clone());
        let (dir, churn_baseline) = {
            let state = self.lock_state();
            let dir = state.epics.get(&key).map(|e| e.working_dir.clone());
            // The baseline is per generation, keyed by session id (session
            // ids are never reused across generations — the supervisor
            // rejects duplicate registrations). The generation check is
            // defensive: stale data must never alarm.
            let churn_baseline = if is_handoff_trigger(&event) {
                state
                    .baselines
                    .get(&event.session_id)
                    .filter(|b| b.generation == event.generation)
                    .and_then(|b| b.baseline_head.clone())
            } else {
                None
            };
            (dir, churn_baseline)
        };
        // No epic entry: the event's epic was never registered here (e.g.
        // the allowance watcher's account-wide rows) — nothing to count.
        // Baselines and epic entries are written by the same Register job,
        // so a baseline without an epic entry cannot exist.
        let Some(dir) = dir else {
            return;
        };
        let head = read_head(dir).await;

        if is_churn(churn_baseline.as_deref(), head.as_deref()) {
            let baseline = churn_baseline.unwrap_or_default();
            log::warn!(
                "samurai progress: epic {} gen-{} is handing off with zero commits (HEAD still {baseline}) — ALERT (handoff_churn)",
                event.epic,
                event.generation,
            );
            self.audit.append(
                &project,
                AuditEvent::now(
                    event.epic.clone(),
                    AuditEventKind::Alert,
                    event.generation,
                    event.session_id,
                    json!({
                        "kind": "handoff_churn",
                        "baseline_head": baseline,
                        "commits_this_generation": 0,
                    }),
                ),
            );
        }

        let count_due = {
            let breaker_events = self.breaker_events();
            let mut state = self.lock_state();
            let Some(entry) = state.epics.get_mut(&key) else {
                return;
            };
            let (observed, count, latched) = next_breaker(
                entry.observed_head.as_deref(),
                entry.count,
                entry.latched,
                head.as_deref(),
            );
            entry.observed_head = observed;
            entry.count = count;
            entry.latched = latched;
            latched || count >= breaker_events
        };
        if count_due {
            self.evaluate_trip(&project, &event.epic);
        }
    }

    /// Attempts a due trip for one epic. Synchronous: transitions and the
    /// audit append are non-blocking. A trip that cannot park anybody stays
    /// latched; a successful park resets the counter and latch, so the
    /// breaker trips exactly once per zero-progress streak.
    fn evaluate_trip(&self, project: &str, epic: &str) {
        let key: EpicKey = (project.to_string(), epic.to_string());
        let breaker_events = self.breaker_events();
        let due = {
            let state = self.lock_state();
            state
                .epics
                .get(&key)
                .filter(|e| e.latched || e.count >= breaker_events)
                .map(|e| (e.count, e.observed_head.clone()))
        };
        let Some((count, observed_head)) = due else {
            return;
        };

        let live: Vec<(u32, u32, SupervisorState)> = self
            .supervisor
            .list_sessions()
            .into_iter()
            .filter(|s| s.project == project && s.epic == epic && !s.state.is_terminal())
            .map(|s| (s.session_id, s.generation, s.state))
            .collect();
        let Some(session_id) = park_candidate(&live) else {
            self.latch(&key);
            return;
        };

        // Phase-2 meaning of PARKED (see module doc): state + badge +
        // injector-ignores-it. The real wind-down instruction, park timers
        // and resume are Phase 3.
        let parked = self
            .supervisor
            .transition(session_id, SupervisorState::ParkRequested)
            .and_then(|_| {
                self.supervisor
                    .transition(session_id, SupervisorState::Parked)
            });
        match parked {
            Ok(snapshot) => {
                log::error!(
                    "samurai progress: circuit breaker tripped for epic {epic} — {count} consecutive events with HEAD unchanged; session {session_id} parked — ALERT"
                );
                self.audit.append(
                    project,
                    AuditEvent::now(
                        epic,
                        AuditEventKind::Alert,
                        snapshot.generation,
                        session_id,
                        json!({
                            "kind": "circuit_breaker",
                            "epic": epic,
                            "events": count,
                            "head": observed_head,
                        }),
                    ),
                );
                let mut state = self.lock_state();
                if let Some(entry) = state.epics.get_mut(&key) {
                    entry.count = 0;
                    entry.latched = false;
                }
            }
            Err(e) => {
                // E.g. the session started a handoff between the list and
                // the transition. The rejection wrote its own ALERT; keep
                // the trip latched and re-evaluate on the next event.
                log::warn!(
                    "samurai progress: breaker park for session {session_id} rejected ({e}) — trip stays latched"
                );
                self.latch(&key);
            }
        }
    }

    /// Marks a due-but-unparkable trip; logged once per latch, not per event.
    fn latch(&self, key: &EpicKey) {
        let mut state = self.lock_state();
        if let Some(entry) = state.epics.get_mut(key) {
            if !entry.latched {
                log::warn!(
                    "samurai progress: circuit breaker for epic {} is due but no session is parkable (mid-handoff or between generations) — latched, will re-evaluate",
                    key.1
                );
                entry.latched = true;
            }
        }
    }

    fn breaker_events(&self) -> u32 {
        self.config
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .breaker_events
    }

    /// Recover from a poisoned lock rather than panicking — event-path
    /// policy, same as the injector and context store.
    fn lock_state(&self) -> std::sync::MutexGuard<'_, ProgressState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Test-only barrier: resolves once every job queued before it has been
    /// fully processed (the worker is strictly sequential).
    #[cfg(test)]
    async fn flush(&self) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let _ = self.tx.send(Job::Flush(tx));
        let _ = rx.await;
    }

    /// Test-only view of one session's baseline: (generation, baseline_head).
    #[cfg(test)]
    fn baseline_view(&self, session_id: u32) -> Option<(u32, Option<String>)> {
        self.lock_state()
            .baselines
            .get(&session_id)
            .map(|b| (b.generation, b.baseline_head.clone()))
    }

    /// Test-only view of one epic's breaker: (observed_head, count, latched).
    #[cfg(test)]
    fn breaker_view(&self, project: &str, epic: &str) -> Option<(Option<String>, u32, bool)> {
        self.lock_state()
            .epics
            .get(&(project.to_string(), epic.to_string()))
            .map(|e| (e.observed_head.clone(), e.count, e.latched))
    }
}

/// The single worker task: processes jobs strictly in queue order, so the
/// whole tracker is a sequential state machine — no torn interleavings.
async fn worker_task(this: Arc<SamuraiProgress>, mut rx: mpsc::UnboundedReceiver<Job>) {
    while let Some(job) = rx.recv().await {
        match job {
            Job::Register {
                session_id,
                project,
                epic,
                generation,
                working_dir,
            } => {
                this.handle_register(session_id, project, epic, generation, working_dir)
                    .await
            }
            Job::Terminal { session_id } => this.handle_terminal(session_id),
            Job::Removed { session_id } => this.handle_removed(session_id),
            Job::Audit { project, event } => this.handle_audit(project, event).await,
            #[cfg(test)]
            Job::Flush(reply) => {
                let _ = reply.send(());
            }
        }
    }
}

/// `git rev-parse HEAD` off the runtime (`spawn_blocking` — git has no
/// bounded completion time). Any failure → `None` = unknown HEAD.
async fn read_head(dir: String) -> Option<String> {
    let dir = PathBuf::from(strip_extended_prefix(&dir));
    match tokio::task::spawn_blocking(move || read_repo_head(&dir)).await {
        Ok(Ok(head)) => Some(head),
        Ok(Err(e)) => {
            log::warn!("samurai progress: {e} — HEAD unknown, skipping");
            None
        }
        Err(e) => {
            log::warn!("samurai progress: HEAD read task failed: {e} — HEAD unknown, skipping");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::samurai_config::SamuraiConfig;
    use crate::core::windows_process::StdCommandExt;
    use std::path::Path;
    use std::sync::{OnceLock, RwLock};
    use tempfile::tempdir;

    use SupervisorState::*;

    // --- pure decision tables ---

    fn alert(kind: &str) -> AuditEvent {
        AuditEvent::now(
            "epic-1",
            AuditEventKind::Alert,
            1,
            1,
            json!({ "kind": kind }),
        )
    }

    #[test]
    fn test_self_event_filter() {
        // (event, is_self) — the anti-cascade filter.
        let park = AuditEvent::now(
            "epic-1",
            AuditEventKind::Park,
            1,
            1,
            json!({ "phase": "requested", "from": "WORKING" }),
        );
        let table = [
            (park, true),                         // any PARK row
            (alert("circuit_breaker"), true),     // the breaker's own ALERT
            (alert("handoff_churn"), true),       // the churn ALERT
            (alert("ack_timeout"), false),        // injector ALERTs count
            (alert("illegal_transition"), false), // rejections count
            (alert("dead"), false),               // watchdog ALERTs count
            (
                AuditEvent::now("epic-1", AuditEventKind::Spawn, 1, 1, json!({})),
                false,
            ),
            (
                AuditEvent::now(
                    "epic-1",
                    AuditEventKind::Handoff,
                    1,
                    1,
                    json!({ "phase": "requested" }),
                ),
                false,
            ),
        ];
        for (event, expected) in table {
            assert_eq!(is_self_event(&event), expected, "{event:?}");
        }
    }

    #[test]
    fn test_handoff_trigger_detection() {
        let requested = AuditEvent::now(
            "e",
            AuditEventKind::Handoff,
            1,
            1,
            json!({ "phase": "requested" }),
        );
        assert!(is_handoff_trigger(&requested));
        let written = AuditEvent::now(
            "e",
            AuditEventKind::Handoff,
            1,
            1,
            json!({ "phase": "written" }),
        );
        assert!(!is_handoff_trigger(&written));
        assert!(!is_handoff_trigger(&alert("handoff_churn")));
    }

    #[test]
    fn test_breaker_counter_increment_reset_and_skip() {
        // (observed, count, latched, head) → (observed, count, latched)
        let table = [
            // First observation: sets the HEAD, counts nothing.
            (None, 0u32, false, Some("aaa"), (Some("aaa"), 0u32, false)),
            // Unchanged HEAD: consecutive zero-progress events increment.
            (Some("aaa"), 0, false, Some("aaa"), (Some("aaa"), 1, false)),
            (Some("aaa"), 4, false, Some("aaa"), (Some("aaa"), 5, false)),
            // Progress: reset, re-observe, clear the latch.
            (Some("aaa"), 4, false, Some("bbb"), (Some("bbb"), 0, false)),
            (Some("aaa"), 9, true, Some("bbb"), (Some("bbb"), 0, false)),
            // Unknown HEAD: skip — nothing counted, nothing reset.
            (Some("aaa"), 3, false, None, (Some("aaa"), 3, false)),
            (Some("aaa"), 3, true, None, (Some("aaa"), 3, true)),
            (None, 0, false, None, (None, 0, false)),
        ];
        for (observed, count, latched, head, expected) in table {
            let (o, c, l) = next_breaker(observed, count, latched, head);
            let expected = (expected.0.map(str::to_string), expected.1, expected.2);
            assert_eq!(
                (o, c, l),
                expected,
                "observed={observed:?} count={count} latched={latched} head={head:?}"
            );
        }
    }

    #[test]
    fn test_churn_decision() {
        // (baseline, head, churn) — unknown on either side never alarms.
        let table = [
            (Some("aaa"), Some("aaa"), true),
            (Some("aaa"), Some("bbb"), false),
            (None, Some("aaa"), false),
            (Some("aaa"), None, false),
            (None, None, false),
        ];
        for (baseline, head, expected) in table {
            assert_eq!(
                is_churn(baseline, head),
                expected,
                "baseline={baseline:?} head={head:?}"
            );
        }
    }

    #[test]
    fn test_park_candidate_table() {
        // Only a WORKING session is parkable; the highest generation wins.
        assert_eq!(park_candidate(&[(1, 1, Working)]), Some(1));
        assert_eq!(park_candidate(&[(1, 1, Working), (2, 2, Working)]), Some(2));
        // Mid-handoff sessions defer (mutual exclusion), as does an
        // already-parking one and an empty list (between generations).
        assert_eq!(park_candidate(&[(1, 1, HandoffRequested)]), None);
        assert_eq!(park_candidate(&[(1, 1, HandoffWritten)]), None);
        assert_eq!(park_candidate(&[(1, 1, ParkRequested)]), None);
        assert_eq!(park_candidate(&[]), None);
        assert_eq!(
            park_candidate(&[(1, 1, HandoffRequested), (2, 2, Working)]),
            Some(2)
        );
    }

    // --- integration: real Supervisor + AuditLog + git repos on tempdirs ---

    struct Harness {
        progress: Arc<SamuraiProgress>,
        supervisor: Arc<Supervisor>,
        audit: AuditLog,
        dirs: Arc<Mutex<HashMap<u32, String>>>,
    }

    /// Wires the same tees `lib.rs` sets up: audit `on_append` and the
    /// supervisor change callback both feed the tracker via a late-bound
    /// slot (the tracker needs the audit log it tees off).
    fn harness(base: &Path, breaker_events: u32) -> Harness {
        let slot: Arc<OnceLock<Arc<SamuraiProgress>>> = Arc::new(OnceLock::new());
        let slot_for_append = slot.clone();
        let (audit, task) = AuditLog::new(
            base.to_path_buf(),
            Some(Arc::new(move |project: &str, event: &AuditEvent| {
                if let Some(p) = slot_for_append.get() {
                    p.observe_audit(project, event);
                }
            })),
        );
        tokio::spawn(task);
        let slot_for_change = slot.clone();
        let supervisor = Arc::new(Supervisor::new(
            audit.clone(),
            Some(Arc::new(move |s: &SessionSnapshot| {
                if let Some(p) = slot_for_change.get() {
                    p.on_state_change(s);
                }
            })),
        ));
        let config: SharedSamuraiConfig = Arc::new(RwLock::new(SamuraiConfig {
            breaker_events,
            ..SamuraiConfig::default()
        }));
        let dirs: Arc<Mutex<HashMap<u32, String>>> = Arc::new(Mutex::new(HashMap::new()));
        let dirs_for_resolver = dirs.clone();
        let session_dirs: SessionDirResolver =
            Arc::new(move |id| dirs_for_resolver.lock().unwrap().get(&id).cloned());
        let (progress, worker) =
            SamuraiProgress::new(supervisor.clone(), config, audit.clone(), session_dirs);
        tokio::spawn(worker);
        let _ = slot.set(progress.clone());
        Harness {
            progress,
            supervisor,
            audit,
            dirs,
        }
    }

    /// Drains the whole pipeline deterministically: the audit writer has
    /// processed every queued append and fired `on_append` (the read is a
    /// durability barrier), then the tracker's worker has processed every
    /// job those callbacks queued. No sleeps.
    async fn settle(h: &Harness, project: &str) {
        let _ = h.audit.read(project, None, None).await.unwrap();
        h.progress.flush().await;
    }

    /// All audit rows for `project` (settled first, so worker-produced
    /// ALERTs are included).
    async fn rows(h: &Harness, project: &str) -> Vec<AuditEvent> {
        settle(h, project).await;
        h.audit.read(project, None, None).await.unwrap().events
    }

    fn run_git(dir: &Path, args: &[&str]) {
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
    }

    /// `git init` + one commit; identity is repo-local.
    fn init_repo(dir: &Path) {
        run_git(dir, &["init", "-q"]);
        run_git(dir, &["config", "user.email", "test@example.com"]);
        run_git(dir, &["config", "user.name", "Test"]);
        std::fs::write(dir.join("tracked.txt"), "v1\n").unwrap();
        run_git(dir, &["add", "tracked.txt"]);
        run_git(dir, &["commit", "-q", "-m", "init"]);
    }

    /// One more commit — the progress signal.
    fn commit_progress(dir: &Path) {
        std::fs::write(dir.join("tracked.txt"), "v2\n").unwrap();
        run_git(dir, &["add", "tracked.txt"]);
        run_git(dir, &["commit", "-q", "-m", "progress"]);
    }

    fn state_of(h: &Harness, session_id: u32) -> SupervisorState {
        h.supervisor
            .list_sessions()
            .into_iter()
            .find(|s| s.session_id == session_id)
            .expect("session not found")
            .state
    }

    /// A countable (non-self) samurai audit event for the epic.
    fn countable(epic: &str, session_id: u32) -> AuditEvent {
        AuditEvent::now(
            epic,
            AuditEventKind::Alert,
            1,
            session_id,
            json!({ "kind": "ack_timeout" }),
        )
    }

    fn alerts_of_kind(rows: &[AuditEvent], kind: &str) -> Vec<AuditEvent> {
        rows.iter()
            .filter(|r| r.event == AuditEventKind::Alert && r.details["kind"] == kind)
            .cloned()
            .collect()
    }

    #[tokio::test]
    async fn test_breaker_trips_working_session_once_with_alert() {
        let base = tempdir().unwrap();
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let project = repo.path().to_string_lossy().into_owned();
        let h = harness(base.path(), 3);

        h.dirs.lock().unwrap().insert(1, project.clone());
        h.supervisor
            .register_session(1, project.clone(), "epic-b".into(), 1)
            .unwrap();
        settle(&h, &project).await;

        // Baseline recorded; the SPAWN row made the first HEAD observation.
        let (generation, baseline) = h.progress.baseline_view(1).unwrap();
        assert_eq!(generation, 1);
        let head = baseline.expect("baseline HEAD must be known in a real repo");
        assert_eq!(
            h.progress.breaker_view(&project, "epic-b").unwrap(),
            (Some(head.clone()), 0, false)
        );

        // Three consecutive events with HEAD unchanged → trip at the third.
        for _ in 0..3 {
            h.audit.append(&project, countable("epic-b", 1));
        }
        let all = rows(&h, &project).await;

        assert_eq!(state_of(&h, 1), Parked, "the breaker must park gen-1");
        let trips = alerts_of_kind(&all, "circuit_breaker");
        assert_eq!(trips.len(), 1, "the trip fires exactly one ALERT");
        assert_eq!(trips[0].details["events"], 3);
        assert_eq!(trips[0].details["head"], head.as_str());
        assert_eq!(trips[0].details["epic"], "epic-b");
        assert_eq!(trips[0].session_id, 1);
        // A successful trip resets counter and latch. The trip's own PARK
        // rows + ALERT flowed back through the tee and were filtered — the
        // counter must not have advanced from them (no cascade).
        assert_eq!(
            h.progress.breaker_view(&project, "epic-b").unwrap(),
            (Some(head.clone()), 0, false)
        );

        // Zero progress continues, but the only session is PARKED (terminal)
        // — the trip latches and never double-fires.
        for _ in 0..3 {
            h.audit.append(&project, countable("epic-b", 1));
        }
        let all = rows(&h, &project).await;
        assert_eq!(alerts_of_kind(&all, "circuit_breaker").len(), 1);
        assert_eq!(state_of(&h, 1), Parked);
        let (_, _, latched) = h.progress.breaker_view(&project, "epic-b").unwrap();
        assert!(latched, "a due trip with nobody parkable stays latched");
    }

    #[tokio::test]
    async fn test_self_events_never_advance_the_counter() {
        let base = tempdir().unwrap();
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let project = repo.path().to_string_lossy().into_owned();
        let h = harness(base.path(), 2);

        h.dirs.lock().unwrap().insert(1, project.clone());
        h.supervisor
            .register_session(1, project.clone(), "epic-s".into(), 1)
            .unwrap();
        settle(&h, &project).await;
        let (_, count, _) = h.progress.breaker_view(&project, "epic-s").unwrap();
        assert_eq!(count, 0);

        // Park rows and this module's own ALERT kinds must not count — one
        // trip's output is exactly this set, so counting it would cascade
        // straight into the next trip.
        h.audit.append(
            &project,
            AuditEvent::now(
                "epic-s",
                AuditEventKind::Park,
                1,
                1,
                json!({ "phase": "requested", "from": "WORKING" }),
            ),
        );
        h.audit.append(
            &project,
            AuditEvent::now(
                "epic-s",
                AuditEventKind::Alert,
                1,
                1,
                json!({ "kind": "circuit_breaker" }),
            ),
        );
        h.audit.append(
            &project,
            AuditEvent::now(
                "epic-s",
                AuditEventKind::Alert,
                1,
                1,
                json!({ "kind": "handoff_churn" }),
            ),
        );
        settle(&h, &project).await;

        let (_, count, latched) = h.progress.breaker_view(&project, "epic-s").unwrap();
        assert_eq!(count, 0, "self events must not advance the counter");
        assert!(!latched);
        assert_eq!(state_of(&h, 1), Working, "no trip from self events");
    }

    #[tokio::test]
    async fn test_mid_handoff_defers_then_successor_registration_trips() {
        let base = tempdir().unwrap();
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let project = repo.path().to_string_lossy().into_owned();
        let h = harness(base.path(), 2);

        h.dirs.lock().unwrap().insert(1, project.clone());
        h.supervisor
            .register_session(1, project.clone(), "epic-m".into(), 1)
            .unwrap();
        settle(&h, &project).await;

        // The handoff-requested row itself is countable (count 1)…
        h.supervisor.transition(1, HandoffRequested).unwrap();
        // …and one more zero-progress event makes the trip due (count 2).
        h.audit.append(&project, countable("epic-m", 1));
        let all = rows(&h, &project).await;

        // Mid-handoff: park/handoff are mutually exclusive — no park, no
        // ALERT, the trip is latched for later.
        assert_eq!(state_of(&h, 1), HandoffRequested);
        assert!(alerts_of_kind(&all, "circuit_breaker").is_empty());
        let (_, _, latched) = h.progress.breaker_view(&project, "epic-m").unwrap();
        assert!(latched, "a due trip mid-handoff must latch, not park");

        // The handoff completes and gen-2 registers — still zero progress,
        // so the latched trip re-evaluates and parks the successor.
        h.supervisor.transition(1, HandoffWritten).unwrap();
        h.supervisor.transition(1, Killed).unwrap();
        settle(&h, &project).await;
        h.dirs.lock().unwrap().insert(2, project.clone());
        h.supervisor
            .register_session(2, project.clone(), "epic-m".into(), 2)
            .unwrap();
        let all = rows(&h, &project).await;

        assert_eq!(state_of(&h, 2), Parked, "the successor inherits the trip");
        let trips = alerts_of_kind(&all, "circuit_breaker");
        assert_eq!(trips.len(), 1);
        assert_eq!(trips[0].session_id, 2);
        assert_eq!(trips[0].generation, 2);
        // The trip reset the counter and latch; the successor's own SPAWN
        // row (still zero progress) then counted 1 — proving the reset
        // happened, since the pre-trip streak was already past that.
        let (_, count, latched) = h.progress.breaker_view(&project, "epic-m").unwrap();
        assert!(
            count <= 1,
            "a successful trip resets the counter (got {count})"
        );
        assert!(!latched);
        // Gen-1 went terminal (KILLED): its baseline entry is cleaned up.
        assert!(h.progress.baseline_view(1).is_none());
    }

    #[tokio::test]
    async fn test_unknown_head_never_trips() {
        let base = tempdir().unwrap();
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        // The resolver points into a directory that does not exist — every
        // HEAD read fails, so HEAD is permanently unknown for this epic.
        let bogus = repo.path().join("missing").to_string_lossy().into_owned();
        let project = repo.path().to_string_lossy().into_owned();
        let h = harness(base.path(), 1);

        h.dirs.lock().unwrap().insert(1, bogus);
        h.supervisor
            .register_session(1, project.clone(), "epic-u".into(), 1)
            .unwrap();
        for _ in 0..5 {
            h.audit.append(&project, countable("epic-u", 1));
        }
        let all = rows(&h, &project).await;

        // Even with breaker_events = 1, unknown HEAD never counts and never
        // trips (false trips are worse than misses).
        assert_eq!(state_of(&h, 1), Working);
        assert!(alerts_of_kind(&all, "circuit_breaker").is_empty());
        assert_eq!(h.progress.baseline_view(1).unwrap(), (1, None));
        assert_eq!(
            h.progress.breaker_view(&project, "epic-u").unwrap(),
            (None, 0, false)
        );

        // A session with NO resolvable dir at all: no epic entry, no
        // baseline HEAD — equally silent.
        let project2 = "C:/git/never-resolved".to_string();
        h.supervisor
            .register_session(2, project2.clone(), "epic-n".into(), 1)
            .unwrap();
        h.audit.append(&project2, countable("epic-n", 2));
        let all2 = rows(&h, &project2).await;
        assert_eq!(state_of(&h, 2), Working);
        assert!(alerts_of_kind(&all2, "circuit_breaker").is_empty());
        assert_eq!(h.progress.baseline_view(2).unwrap(), (1, None));
        assert!(h.progress.breaker_view(&project2, "epic-n").is_none());
    }

    #[tokio::test]
    async fn test_removal_prunes_breaker_only_when_last_baseline_drops() {
        // Fresh-eyes finding I (+ H propagation): tearing sessions down
        // outside the samurai pipeline prunes the epic's breaker entry once
        // the LAST baseline for that (project, epic) is gone — and not a
        // moment earlier.
        let base = tempdir().unwrap();
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let project = repo.path().to_string_lossy().into_owned();
        let h = harness(base.path(), 100);

        h.dirs.lock().unwrap().insert(1, project.clone());
        h.dirs.lock().unwrap().insert(2, project.clone());
        h.supervisor
            .register_session(1, project.clone(), "epic-x".into(), 1)
            .unwrap();
        h.supervisor
            .register_session(2, project.clone(), "epic-x".into(), 2)
            .unwrap();
        settle(&h, &project).await;
        assert!(h.progress.breaker_view(&project, "epic-x").is_some());

        // First removal: a baseline for the epic remains → entry kept.
        h.progress.remove_session(1);
        h.progress.flush().await;
        assert!(h.progress.baseline_view(1).is_none());
        assert!(h.progress.breaker_view(&project, "epic-x").is_some());

        // Second removal: the epic's last baseline drops → entry pruned.
        h.progress.remove_session(2);
        h.progress.flush().await;
        assert!(h.progress.baseline_view(2).is_none());
        assert!(h.progress.breaker_view(&project, "epic-x").is_none());

        // Idempotent for unknown sessions.
        h.progress.remove_session(99);
        h.progress.flush().await;
    }

    #[tokio::test]
    async fn test_relaunched_epic_gen_1_starts_from_a_clean_breaker() {
        // A latched breaker must not survive into a RELAUNCH. `Job::Terminal`
        // deliberately keeps the epic entry, and `handle_removed` bails out
        // once the baseline is already gone — so after a normal
        // KILLED/PARKED/DEAD lifecycle nothing prunes it. gen-1 is only ever
        // a launch (successors and resumes are >= 2), so it resets.
        let base = tempdir().unwrap();
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let project = repo.path().to_string_lossy().into_owned();
        let h = harness(base.path(), 3);

        h.dirs.lock().unwrap().insert(1, project.clone());
        h.supervisor
            .register_session(1, project.clone(), "epic-r".into(), 1)
            .unwrap();
        settle(&h, &project).await;

        // Go mid-handoff so the due trip cannot park anybody → latched.
        h.supervisor.transition(1, HandoffRequested).unwrap();
        for _ in 0..2 {
            h.audit.append(&project, countable("epic-r", 1));
        }
        settle(&h, &project).await;
        let (_, _, latched) = h.progress.breaker_view(&project, "epic-r").unwrap();
        assert!(latched, "a due-but-unparkable trip must latch");

        // Normal end of life: terminal transition, then teardown. The
        // baseline is already gone, so the removal cannot prune the entry.
        h.supervisor.transition(1, Dead).unwrap();
        settle(&h, &project).await;
        h.progress.remove_session(1);
        h.progress.flush().await;
        assert!(
            h.progress.breaker_view(&project, "epic-r").is_some(),
            "the epic entry survives a normal lifecycle — this is the leak"
        );

        // Relaunch: a fresh gen-1 for the same (project, epic).
        h.dirs.lock().unwrap().insert(2, project.clone());
        h.supervisor
            .register_session(2, project.clone(), "epic-r".into(), 1)
            .unwrap();
        let all = rows(&h, &project).await;

        assert_eq!(
            state_of(&h, 2),
            Working,
            "a freshly launched orchestrator must not be parked on sight"
        );
        let (_, count, latched) = h.progress.breaker_view(&project, "epic-r").unwrap();
        assert_eq!((count, latched), (0, false), "gen-1 resets the breaker");
        assert!(
            alerts_of_kind(&all, "circuit_breaker").is_empty(),
            "no trip belongs to the relaunched run"
        );
    }

    #[tokio::test]
    async fn test_successor_generation_keeps_the_breaker_counter() {
        // The other side of the gen-1 reset: a gen-2 successor registering
        // after its predecessor was killed must KEEP the counter — zero
        // progress across a handoff has to stay visible (module doc).
        let base = tempdir().unwrap();
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let project = repo.path().to_string_lossy().into_owned();
        let h = harness(base.path(), 100);

        h.dirs.lock().unwrap().insert(1, project.clone());
        h.supervisor
            .register_session(1, project.clone(), "epic-s".into(), 1)
            .unwrap();
        settle(&h, &project).await;
        for _ in 0..2 {
            h.audit.append(&project, countable("epic-s", 1));
        }
        settle(&h, &project).await;
        let (_, before, _) = h.progress.breaker_view(&project, "epic-s").unwrap();
        assert_eq!(before, 2);

        h.supervisor.transition(1, HandoffRequested).unwrap();
        h.supervisor.transition(1, HandoffWritten).unwrap();
        h.supervisor.transition(1, Killed).unwrap();
        h.dirs.lock().unwrap().insert(2, project.clone());
        h.supervisor
            .register_session(2, project.clone(), "epic-s".into(), 2)
            .unwrap();
        settle(&h, &project).await;

        let (_, after, _) = h.progress.breaker_view(&project, "epic-s").unwrap();
        assert!(
            after >= before,
            "a successor must not reset the counter (before={before}, after={after})"
        );
    }

    #[tokio::test]
    async fn test_churn_alert_on_zero_commit_generation() {
        let base = tempdir().unwrap();
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let project = repo.path().to_string_lossy().into_owned();
        // High threshold: the breaker stays quiet, churn is isolated.
        let h = harness(base.path(), 100);

        h.dirs.lock().unwrap().insert(1, project.clone());
        h.supervisor
            .register_session(1, project.clone(), "epic-c".into(), 1)
            .unwrap();
        settle(&h, &project).await;
        let (_, baseline) = h.progress.baseline_view(1).unwrap();
        let baseline = baseline.unwrap();

        // Handoff triggered with zero commits this generation → churn ALERT,
        // and the handoff proceeds (signal, not block).
        h.supervisor.transition(1, HandoffRequested).unwrap();
        let all = rows(&h, &project).await;
        let churn = alerts_of_kind(&all, "handoff_churn");
        assert_eq!(churn.len(), 1);
        assert_eq!(churn[0].details["baseline_head"], baseline.as_str());
        assert_eq!(churn[0].details["commits_this_generation"], 0);
        assert_eq!(churn[0].generation, 1);
        assert_eq!(churn[0].session_id, 1);
        assert_eq!(
            state_of(&h, 1),
            HandoffRequested,
            "churn must not block the handoff"
        );
    }

    #[tokio::test]
    async fn test_no_churn_after_progress_or_with_unknown_baseline() {
        let base = tempdir().unwrap();
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let project = repo.path().to_string_lossy().into_owned();
        let h = harness(base.path(), 100);

        // Generation with a commit: no churn.
        h.dirs.lock().unwrap().insert(1, project.clone());
        h.supervisor
            .register_session(1, project.clone(), "epic-p".into(), 1)
            .unwrap();
        settle(&h, &project).await;
        commit_progress(repo.path());
        h.supervisor.transition(1, HandoffRequested).unwrap();
        let all = rows(&h, &project).await;
        assert!(
            alerts_of_kind(&all, "handoff_churn").is_empty(),
            "a generation that shipped a commit is not churn"
        );

        // Unknown baseline (unresolvable dir at registration): no churn,
        // even though the handoff fires — never false-alarm.
        let project2 = "C:/git/no-baseline".to_string();
        h.supervisor
            .register_session(2, project2.clone(), "epic-q".into(), 1)
            .unwrap();
        settle(&h, &project2).await;
        h.supervisor.transition(2, HandoffRequested).unwrap();
        let all2 = rows(&h, &project2).await;
        assert!(alerts_of_kind(&all2, "handoff_churn").is_empty());
    }
}
