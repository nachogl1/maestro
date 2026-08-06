//! Samurai resume handler (Phase 3, issue #61; PRD §5.5, §5.6, §7).
//!
//! The consumer of `samurai_schedule`'s fire callback — the piece that turns
//! a due park timer into a FRESH generation spawn (PRD decision #6: every
//! wake-up is a fresh spawn from the handoff file, never `claude --resume`):
//!
//! - **Guard rails first:** while a hard park sweep is still engaged, or a
//!   non-terminal supervised session already exists for the (project, epic),
//!   spawning would fight the parker or duplicate a live orchestrator — the
//!   timer is re-armed [`DEFER_DELAY_SECS`] out with a
//!   `PARK {phase: "resume_deferred"}` audit row instead. Because the
//!   schedule's self-clean matches on `fire_at`, the re-armed entry (a new
//!   `fire_at`) survives the fired entry's removal. The same guard is the
//!   idempotence story for a crash-mid-callback re-fire: a successor that
//!   already registered is a non-terminal session, so the re-fire defers
//!   (and the replicator's per-(project, epic, generation) staging guard
//!   backstops the window before registration).
//! - **Working dir:** the run config's `worktree_path` (PRD §5.8) — absent
//!   for epics parked before the P3.5 launcher exists — then any supervised
//!   session for the epic whose directory still resolves (terminal by now;
//!   non-terminal ones deferred above). Nothing resolvable →
//!   `ALERT (resume_no_worktree)` and NO re-arm: paths are never invented,
//!   a human re-launches.
//! - **Next generation:** highest generation across the supervisor registry
//!   and the handoff files on disk, plus one. The highest is also the
//!   `prior_generation` handed to the replicator, which picks the ritual by
//!   whether that generation's handoff file exists (present → successor
//!   ritual, HEAD-gated; missing → recovery). Neither source knows any
//!   generation → `ALERT (resume_no_handoff)`, no re-arm — there is nothing
//!   on disk to resume from.
//! - **Happy path:** append the `RESUME {generation, fire_at}` audit row
//!   (the kind's first producer), then
//!   `SamuraiReplicator::spawn_generation` — which stages the ritual, emits
//!   `samurai-spawn-successor`, and re-emits while no registration arrives
//!   (the frontend drops the event when no project tab is open).
//!
//! Shape: decisions as pure functions with table tests (the
//! `allowance_watcher` split); [`SamuraiResumer::on_fire`] itself is
//! synchronous — its file I/O is one small run-config read and one
//! filename-only directory listing, the same weight the parker already puts
//! on its tick path — so the schedule's crash-refire window stays as small
//! as possible. The spawn's heavier I/O runs inside `spawn_generation`.
//! Construction order in `lib.rs` is circular (schedule → resumer → parker →
//! schedule), so the schedule and parker are late-bound via [`bind`].
//!
//! [`bind`]: SamuraiResumer::bind

use std::path::Path;
use std::sync::{Arc, OnceLock};

use chrono::Utc;
use serde_json::json;

use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_injector::{strip_extended_prefix, SessionDirResolver};
use super::samurai_parker::SamuraiParker;
use super::samurai_prompts::{epic_slug, parse_handoff_generation};
use super::samurai_replicator::SamuraiReplicator;
use super::samurai_run_config::RunConfigStore;
use super::samurai_schedule::{SamuraiSchedule, ScheduleEntry};
use super::supervisor::{SessionSnapshot, Supervisor};

/// How far a deferred resume is pushed out (module doc: parking engaged or a
/// live orchestrator already exists). 10 minutes: long enough for a park
/// sweep to finish or a live epic to keep working undisturbed, short enough
/// that a resume blocked by a transient state lands the same hour.
const DEFER_DELAY_SECS: i64 = 600;

/// The timer reason the parker arms (`samurai_parker`); the only reason a
/// fire currently means anything.
const REASON_PARK: &str = "park";

// ---------------------------------------------------------------------------
// Pure decisions (table-tested)
// ---------------------------------------------------------------------------

/// Whether a fired timer must be deferred instead of spawning: a hard park
/// sweep is still engaged (spawning would burn the exhausted allowance), or
/// a NON-terminal supervised session already exists for the (project, epic)
/// — a live orchestrator this spawn would duplicate. Terminal leftovers
/// (KILLED / PARKED / DEAD entries whose tiles nobody closed) do not defer.
fn should_defer(
    parking_engaged: bool,
    sessions: &[SessionSnapshot],
    project: &str,
    epic: &str,
) -> bool {
    parking_engaged
        || sessions
            .iter()
            .any(|s| s.project == project && s.epic == epic && !s.state.is_terminal())
}

/// `(prior, next)` generation for a fresh spawn: the highest generation
/// either source knows, plus one. `None` when neither the registry nor the
/// handoff files know any generation — nothing to resume from.
fn next_generation(registry_max: Option<u32>, files_max: Option<u32>) -> Option<(u32, u32)> {
    let prior = registry_max.max(files_max)?;
    Some((prior, prior + 1))
}

/// Highest generation among the epic's handoff files in `handoffs_dir`
/// (`<working_dir>/.maestro/handoffs`). Filenames only — no file is read.
/// A candidate must reconstruct EXACTLY as `<slug>-gen<N>.md`, which
/// excludes recovery digests (`…-recovery.md`) and other epics whose slug
/// merely shares a prefix. A missing/unreadable directory is `None`.
fn latest_handoff_generation(handoffs_dir: &Path, epic: &str) -> Option<u32> {
    let prefix = format!("{}-gen", epic_slug(epic));
    std::fs::read_dir(handoffs_dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let generation = parse_handoff_generation(&name)?;
            (name == format!("{prefix}{generation}.md")).then_some(generation)
        })
        .max()
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// The resume handler. One instance, constructed at app setup; the schedule's
/// fire callback calls [`Self::on_fire`].
pub struct SamuraiResumer {
    supervisor: Arc<Supervisor>,
    replicator: Arc<SamuraiReplicator>,
    run_configs: Arc<RunConfigStore>,
    audit: AuditLog,
    session_dirs: SessionDirResolver,
    /// Late-bound (module doc: circular construction order). Unset only
    /// before setup finishes — a fire that early is dropped with an error.
    schedule: OnceLock<Arc<SamuraiSchedule>>,
    parker: OnceLock<Arc<SamuraiParker>>,
}

impl SamuraiResumer {
    pub fn new(
        supervisor: Arc<Supervisor>,
        replicator: Arc<SamuraiReplicator>,
        run_configs: Arc<RunConfigStore>,
        audit: AuditLog,
        session_dirs: SessionDirResolver,
    ) -> Arc<Self> {
        Arc::new(Self {
            supervisor,
            replicator,
            run_configs,
            audit,
            session_dirs,
            schedule: OnceLock::new(),
            parker: OnceLock::new(),
        })
    }

    /// Late-binds the schedule (for deferral re-arms) and the parker (for
    /// the parking-engaged guard). Second calls are ignored, like every
    /// OnceLock slot in setup.
    pub fn bind(&self, schedule: Arc<SamuraiSchedule>, parker: Arc<SamuraiParker>) {
        let _ = self.schedule.set(schedule);
        let _ = self.parker.set(parker);
    }

    /// The schedule's fire callback (issue #61): decide, then either defer,
    /// alert, or spawn the next generation. Synchronous — see module doc.
    pub fn on_fire(&self, entry: ScheduleEntry) {
        if entry.reason != REASON_PARK {
            log::warn!(
                "samurai resumer: timer for epic {} has unknown reason {:?} — ignored",
                entry.epic,
                entry.reason,
            );
            return;
        }
        let (Some(schedule), Some(parker)) = (self.schedule.get(), self.parker.get()) else {
            // Cannot happen after setup; the timer survives on disk until
            // its self-clean, and cold-start reconciliation (P3.4) backstops.
            log::error!(
                "samurai resumer: timer for epic {} fired before bind() — dropped",
                entry.epic,
            );
            return;
        };

        let sessions = self.supervisor.list_sessions();
        if should_defer(
            parker.parking_engaged(),
            &sessions,
            &entry.project_path,
            &entry.epic,
        ) {
            self.defer(schedule, &entry);
            return;
        }

        let Some(working_dir) = self.resolve_working_dir(&entry, &sessions) else {
            log::error!(
                "samurai resumer: no worktree known for epic {} in {} (no run config, no resolvable session) — ALERT, human attention",
                entry.epic,
                entry.project_path,
            );
            self.append_alert(
                &entry,
                json!({ "kind": "resume_no_worktree", "epic": entry.epic }),
            );
            return;
        };

        let registry_max = sessions
            .iter()
            .filter(|s| s.project == entry.project_path && s.epic == entry.epic)
            .map(|s| s.generation)
            .max();
        let files_max = latest_handoff_generation(
            &Path::new(&working_dir).join(".maestro").join("handoffs"),
            &entry.epic,
        );
        let Some((prior, generation)) = next_generation(registry_max, files_max) else {
            log::error!(
                "samurai resumer: epic {} in {working_dir} has no handoff files and no registry generations — nothing to resume from, ALERT",
                entry.epic,
            );
            self.append_alert(
                &entry,
                json!({ "kind": "resume_no_handoff", "epic": entry.epic }),
            );
            return;
        };

        log::info!(
            "samurai resumer: resuming epic {} in {working_dir} — spawning gen-{generation} (prior gen-{prior}; timer was {})",
            entry.epic,
            entry.fire_at,
        );
        // The RESUME row (this kind's first producer) BEFORE the spawn, so
        // the trail always explains the SPAWN row that follows.
        self.audit.append(
            &entry.project_path,
            AuditEvent::now(
                entry.epic.clone(),
                AuditEventKind::Resume,
                generation,
                // 0 sentinel: the successor session does not exist yet.
                0,
                json!({ "fire_at": entry.fire_at }),
            ),
        );
        self.replicator.spawn_generation(
            &entry.project_path,
            &entry.epic,
            &working_dir,
            generation,
            Some(prior),
        );
    }

    /// Re-arms the entry [`DEFER_DELAY_SECS`] out and records why. The new
    /// `fire_at` is what lets the re-arm survive the fired entry's
    /// self-clean (P3.1 removes by (project, epic, fire_at)).
    fn defer(&self, schedule: &Arc<SamuraiSchedule>, entry: &ScheduleEntry) {
        let fire_at = (Utc::now() + chrono::Duration::seconds(DEFER_DELAY_SECS)).to_rfc3339();
        log::info!(
            "samurai resumer: resume for epic {} deferred to {fire_at} (parking engaged or a live orchestrator exists)",
            entry.epic,
        );
        let deferred = ScheduleEntry {
            fire_at: fire_at.clone(),
            ..entry.clone()
        };
        if let Err(e) = schedule.arm(deferred) {
            log::error!(
                "samurai resumer: failed to re-arm the deferred timer for epic {}: {e}",
                entry.epic,
            );
        }
        self.audit.append(
            &entry.project_path,
            AuditEvent::now(
                entry.epic.clone(),
                AuditEventKind::Park,
                0,
                0,
                json!({ "phase": "resume_deferred", "fire_at": fire_at }),
            ),
        );
    }

    /// Fallback order (module doc): run config's worktree, then any
    /// supervised session for the epic whose directory still resolves.
    /// Always `\\?\`-stripped (fork convention).
    fn resolve_working_dir(
        &self,
        entry: &ScheduleEntry,
        sessions: &[SessionSnapshot],
    ) -> Option<String> {
        if let Some(config) = self.run_configs.get(&entry.project_path, &entry.epic) {
            return Some(strip_extended_prefix(&config.worktree_path).to_string());
        }
        sessions
            .iter()
            .filter(|s| s.project == entry.project_path && s.epic == entry.epic)
            .find_map(|s| (self.session_dirs)(s.session_id))
            .map(|dir| strip_extended_prefix(&dir).to_string())
    }

    /// Epic-level ALERT row (generation/session 0, like the parker's
    /// `park_no_reset_time`). Deliberately NOT re-armed: both alert paths
    /// need a human, and a rearmed timer would alert again forever.
    fn append_alert(&self, entry: &ScheduleEntry, details: serde_json::Value) {
        self.audit.append(
            &entry.project_path,
            AuditEvent::now(entry.epic.clone(), AuditEventKind::Alert, 0, 0, details),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::process_manager::ProcessManager;
    use crate::core::samurai_config::{SamuraiConfig, SharedSamuraiConfig};
    use crate::core::samurai_context::SamuraiContextStore;
    use crate::core::samurai_injector::SamuraiInjector;
    use crate::core::samurai_replicator::{
        SessionTeardown, StdinWriter, SuccessorEmitter, SuccessorSpawn, TranscriptPathResolver,
    };
    use crate::core::samurai_run_config::SamuraiRunConfig;
    use crate::core::supervisor::SupervisorState;
    use crate::core::windows_process::StdCommandExt;
    use chrono::DateTime;
    use std::collections::HashMap;
    use std::sync::{Mutex, RwLock};
    use std::time::Duration;
    use tempfile::tempdir;

    // --- pure decisions ---

    fn snapshot(
        project: &str,
        epic: &str,
        generation: u32,
        state: SupervisorState,
    ) -> SessionSnapshot {
        SessionSnapshot {
            session_id: 1,
            project: project.to_string(),
            epic: epic.to_string(),
            generation,
            state,
            previous_state: None,
            in_flight: None,
            ts: "2026-08-06T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn test_should_defer_table() {
        use SupervisorState::*;
        let p = "C:/git/p";
        // Parking engaged always defers, sessions or not.
        assert!(should_defer(true, &[], p, "#1"));
        // Non-terminal session for the SAME (project, epic) defers.
        for state in [Working, HandoffRequested, HandoffWritten, ParkRequested] {
            assert!(
                should_defer(false, &[snapshot(p, "#1", 2, state)], p, "#1"),
                "{state:?} must defer"
            );
        }
        // Terminal leftovers do not.
        for state in [Killed, Parked, Dead] {
            assert!(
                !should_defer(false, &[snapshot(p, "#1", 2, state)], p, "#1"),
                "{state:?} must not defer"
            );
        }
        // Other epics / projects are not this timer's business.
        assert!(!should_defer(
            false,
            &[snapshot(p, "#2", 2, Working)],
            p,
            "#1"
        ));
        assert!(!should_defer(
            false,
            &[snapshot("C:/git/other", "#1", 2, Working)],
            p,
            "#1"
        ));
        // Nothing supervised, not parking: proceed.
        assert!(!should_defer(false, &[], p, "#1"));
    }

    #[test]
    fn test_next_generation_table() {
        // (registry, files, expected (prior, next))
        let table = [
            (None, None, None),
            (Some(3), None, Some((3, 4))),
            (None, Some(2), Some((2, 3))),
            (Some(3), Some(2), Some((3, 4))), // registry ahead (no handoff written)
            (Some(2), Some(5), Some((5, 6))), // files ahead (registry torn down mid-run)
            (Some(4), Some(4), Some((4, 5))),
        ];
        for (registry, files, expected) in table {
            assert_eq!(
                next_generation(registry, files),
                expected,
                "registry={registry:?} files={files:?}"
            );
        }
    }

    #[test]
    fn test_latest_handoff_generation_scans_only_this_epics_handoffs() {
        let dir = tempdir().unwrap();
        let handoffs = dir.path().join(".maestro").join("handoffs");
        std::fs::create_dir_all(&handoffs).unwrap();
        for name in [
            "37-gen1.md",
            "37-gen3.md",
            "37-gen2-recovery.md", // digest — not a handoff
            "37-gen5-gen2.md",     // ANOTHER epic ("37-gen5") — not epic #37's
            "epic-12-gen9.md",     // another epic entirely
            "notes.txt",
        ] {
            std::fs::write(handoffs.join(name), "x").unwrap();
        }

        assert_eq!(latest_handoff_generation(&handoffs, "#37"), Some(3));
        assert_eq!(latest_handoff_generation(&handoffs, "Epic 12"), Some(9));
        // And the prefix-sharing epic sees only its own file.
        assert_eq!(latest_handoff_generation(&handoffs, "37-gen5"), Some(2));
        // No files for the epic / no directory at all.
        assert_eq!(latest_handoff_generation(&handoffs, "#99"), None);
        assert_eq!(
            latest_handoff_generation(&dir.path().join("missing"), "#37"),
            None
        );
    }

    // --- integration (real supervisor + replicator + schedule + parker) ---

    struct Harness {
        resumer: Arc<SamuraiResumer>,
        supervisor: Arc<Supervisor>,
        replicator: Arc<SamuraiReplicator>,
        run_configs: Arc<RunConfigStore>,
        schedule: Arc<SamuraiSchedule>,
        audit: AuditLog,
        dirs: Arc<Mutex<HashMap<u32, String>>>,
        spawns: Arc<Mutex<Vec<SuccessorSpawn>>>,
    }

    fn harness(dir: &Path) -> Harness {
        let (audit, task) = AuditLog::new(dir.to_path_buf(), None);
        tokio::spawn(task);
        let supervisor = Arc::new(Supervisor::new(audit.clone(), None));
        let config: SharedSamuraiConfig = Arc::new(RwLock::new(SamuraiConfig::default()));
        let context = Arc::new(SamuraiContextStore::new());
        let dirs: Arc<Mutex<HashMap<u32, String>>> = Arc::new(Mutex::new(HashMap::new()));
        let dirs_for_resolver = dirs.clone();
        let session_dirs: SessionDirResolver =
            Arc::new(move |id| dirs_for_resolver.lock().unwrap().get(&id).cloned());
        let transcript_paths: TranscriptPathResolver = Arc::new(|_| None);
        let teardown: SessionTeardown = Arc::new(|_| Box::pin(async {}));
        let spawns: Arc<Mutex<Vec<SuccessorSpawn>>> = Arc::new(Mutex::new(Vec::new()));
        let spawns_rec = spawns.clone();
        let emit_spawn: SuccessorEmitter = Arc::new(move |s| {
            spawns_rec.lock().unwrap().push(s.clone());
        });
        let write_stdin: StdinWriter = Arc::new(|_, _| {});
        let replicator = Arc::new(SamuraiReplicator::new(
            supervisor.clone(),
            audit.clone(),
            config.clone(),
            session_dirs.clone(),
            transcript_paths,
            teardown.clone(),
            emit_spawn,
            write_stdin,
        ));
        let injector = Arc::new(SamuraiInjector::new(
            supervisor.clone(),
            context.clone(),
            config,
            ProcessManager::new(),
            audit.clone(),
            session_dirs.clone(),
            Some(replicator.clone()),
        ));
        let run_configs = Arc::new(RunConfigStore::new(dir.join("runs")));
        let resumer = SamuraiResumer::new(
            supervisor.clone(),
            replicator.clone(),
            run_configs.clone(),
            audit.clone(),
            session_dirs,
        );
        let resumer_for_fire = resumer.clone();
        let (schedule, _task) = SamuraiSchedule::new(
            dir.join("schedule"),
            Arc::new(move |entry| resumer_for_fire.on_fire(entry)),
            None,
        );
        let parker = SamuraiParker::new(
            supervisor.clone(),
            context,
            injector.clone(),
            schedule.clone(),
            audit.clone(),
            teardown,
        );
        injector.set_parker(parker.clone());
        resumer.bind(schedule.clone(), parker);
        Harness {
            resumer,
            supervisor,
            replicator,
            run_configs,
            schedule,
            audit,
            dirs,
            spawns,
        }
    }

    /// `git init` + one commit, so the HEAD gate has a repo to read.
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

    fn write_handoff(dir: &Path, epic: &str, generation: u32) {
        let rel = crate::core::samurai_prompts::handoff_file_relpath(epic, generation);
        let path = dir.join(&rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "# Handoff\n## Repo state\nno sha recorded\n").unwrap();
    }

    fn entry(project: &str, epic: &str) -> ScheduleEntry {
        ScheduleEntry {
            project_path: project.to_string(),
            epic: epic.to_string(),
            fire_at: "2026-08-06T12:00:00+00:00".to_string(),
            reason: "park".to_string(),
        }
    }

    /// Polls until `cond` holds or ~2s pass (spawn staging finishes on the
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

    /// Polls the audit log until a row matches, returning all rows.
    async fn wait_for_row(
        audit: &AuditLog,
        project: &str,
        mut pred: impl FnMut(&AuditEvent) -> bool,
    ) -> Vec<AuditEvent> {
        let mut rows = Vec::new();
        for _ in 0..200 {
            rows = audit.read(project, None, None).await.unwrap().events;
            if rows.iter().any(&mut pred) {
                return rows;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("expected audit row never landed; have: {rows:?}");
    }

    #[tokio::test]
    async fn test_fire_with_run_config_spawns_next_generation_and_audits_resume() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-happy";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        write_handoff(repo.path(), "#37", 2);
        h.run_configs
            .save(&SamuraiRunConfig::new(
                project,
                "#37",
                repo.path().to_string_lossy().into_owned(),
            ))
            .unwrap();

        h.resumer.on_fire(entry(project, "#37"));

        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;
        let spawns = h.spawns.lock().unwrap().clone();
        assert_eq!(spawns[0].generation, 3, "latest handoff gen 2 + 1");
        assert_eq!(spawns[0].epic, "#37");
        assert_eq!(
            spawns[0].working_dir,
            repo.path().to_string_lossy().into_owned()
        );

        // The RESUME row (first producer of the kind) preceded the spawn.
        let rows = wait_for_row(&h.audit, project, |r| r.event == AuditEventKind::Resume).await;
        let resume: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Resume)
            .collect();
        assert_eq!(resume.len(), 1);
        assert_eq!(resume[0].epic, "#37");
        assert_eq!(resume[0].generation, 3);
        assert_eq!(resume[0].session_id, 0);
        assert_eq!(resume[0].details["fire_at"], "2026-08-06T12:00:00+00:00");

        // The handoff exists → the staged ritual is the normal successor
        // one (verify required — the fixture handoff has no SHA), never
        // recovery.
        let staged = h
            .replicator
            .spawn_details(project, "#37", 3)
            .expect("gen-3 must be staged");
        assert_eq!(staged["predecessor_generation"], 2);
        assert_eq!(staged["predecessor_session_id"], 0);
    }

    #[tokio::test]
    async fn test_fire_defers_when_a_live_orchestrator_exists() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-defer";
        // A WORKING session for the epic — e.g. the crash-refire case where
        // the resumed successor already registered.
        h.supervisor
            .register_session(1, project.into(), "#37".into(), 3)
            .unwrap();

        h.resumer.on_fire(entry(project, "#37"));

        // Re-armed ~10 min out, with the PARK resume_deferred row; no spawn.
        let timers = h.schedule.list();
        assert_eq!(timers.len(), 1);
        assert_eq!(timers[0].epic, "#37");
        assert_eq!(timers[0].reason, "park");
        let fired = DateTime::parse_from_rfc3339("2026-08-06T12:00:00+00:00").unwrap();
        let deferred = DateTime::parse_from_rfc3339(&timers[0].fire_at).unwrap();
        assert!(deferred > fired, "deferred past the original fire time");
        let rows = wait_for_row(&h.audit, project, |r| {
            r.event == AuditEventKind::Park && r.details["phase"] == "resume_deferred"
        })
        .await;
        let row = rows
            .iter()
            .find(|r| r.details["phase"] == "resume_deferred")
            .unwrap();
        assert_eq!(row.details["fire_at"], timers[0].fire_at);
        assert!(h.spawns.lock().unwrap().is_empty());
        assert!(!rows.iter().any(|r| r.event == AuditEventKind::Resume));
    }

    #[tokio::test]
    async fn test_fire_proceeds_past_terminal_leftovers_and_uses_their_dir() {
        // No run config (parked before P3.5 exists) — fallback (b): a
        // PARKED session still in the registry resolves the working dir,
        // and its generation drives the next one.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-fallback";
        let repo = tempdir().unwrap();
        init_repo(repo.path()); // no handoff files
        h.supervisor
            .register_session(5, project.into(), "#37".into(), 4)
            .unwrap();
        h.supervisor
            .transition(5, SupervisorState::ParkRequested)
            .unwrap();
        h.supervisor.transition(5, SupervisorState::Parked).unwrap();
        h.dirs
            .lock()
            .unwrap()
            .insert(5, repo.path().to_string_lossy().into_owned());

        h.resumer.on_fire(entry(project, "#37"));

        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;
        let spawns = h.spawns.lock().unwrap().clone();
        assert_eq!(spawns[0].generation, 5, "registry gen 4 + 1");
        assert_eq!(
            spawns[0].working_dir,
            repo.path().to_string_lossy().into_owned()
        );
        // Gen-4 wrote no handoff → the replicator stages RECOVERY.
        let details = h.replicator.spawn_details(project, "#37", 5).unwrap();
        assert_eq!(details["recovery"], true);
        assert_eq!(details["predecessor_generation"], 4);
    }

    #[tokio::test]
    async fn test_fire_without_any_worktree_alerts_and_does_not_rearm() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-nowt";

        h.resumer.on_fire(entry(project, "#37"));

        let rows = wait_for_row(&h.audit, project, |r| {
            r.details["kind"] == "resume_no_worktree"
        })
        .await;
        let alert = rows
            .iter()
            .find(|r| r.details["kind"] == "resume_no_worktree")
            .unwrap();
        assert_eq!(alert.event, AuditEventKind::Alert);
        assert_eq!(alert.details["epic"], "#37");
        // Human attention: no re-arm, no spawn, no RESUME row.
        assert!(h.schedule.list().is_empty());
        assert!(h.spawns.lock().unwrap().is_empty());
        assert!(!rows.iter().any(|r| r.event == AuditEventKind::Resume));
    }

    #[tokio::test]
    async fn test_fire_with_worktree_but_no_state_alerts_resume_no_handoff() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-nostate";
        let repo = tempdir().unwrap();
        init_repo(repo.path()); // worktree exists, but no handoffs, no registry
        h.run_configs
            .save(&SamuraiRunConfig::new(
                project,
                "#37",
                repo.path().to_string_lossy().into_owned(),
            ))
            .unwrap();

        h.resumer.on_fire(entry(project, "#37"));

        let rows = wait_for_row(&h.audit, project, |r| {
            r.details["kind"] == "resume_no_handoff"
        })
        .await;
        assert!(h.schedule.list().is_empty(), "no re-arm");
        assert!(h.spawns.lock().unwrap().is_empty(), "no spawn");
        assert!(!rows.iter().any(|r| r.event == AuditEventKind::Resume));
    }

    #[tokio::test]
    async fn test_non_park_reason_is_ignored() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let mut e = entry("C:/git/proj-res-reason", "#37");
        e.reason = "mystery".to_string();

        h.resumer.on_fire(e);

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(h.spawns.lock().unwrap().is_empty());
        assert!(h.schedule.list().is_empty());
    }
}
