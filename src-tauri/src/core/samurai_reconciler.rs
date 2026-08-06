//! Samurai cold-start reconciliation (Phase 3, issue #62; PRD §5.6, §10).
//!
//! **A first-class flow, not a fallback** (PRD §5.6): auto-updates and
//! reboots are the *normal* multi-day events, and everything in-memory —
//! supervisor registry, injector pending, parker state — is empty when the
//! app comes back. The only persisted truth is on disk: active run configs
//! (`samurai_run_config`), the resume timers (`samurai_schedule`), the
//! handoff files in each epic's worktree, and the audit log. [`reconcile`]
//! runs ONCE at startup (spawned at the end of the lib.rs setup closure,
//! after every samurai component is constructed) and rebuilds the world from
//! those four sources: for each ACTIVE run config it either leaves the epic
//! to an owner that already exists, alerts a human, or spawns the next
//! generation through the replicator's ritual.
//!
//! Decision order per epic (first match wins — see [`decide`]):
//!
//! 1. **Timer pending** → skip, audit nothing. The schedule/resumer own the
//!    epic: a future timer re-arms on its own, and a fire time that passed
//!    during downtime fires on the loop's FIRST 30s tick (P3.1), producing a
//!    `RESUME`/defer trail from there. The timer set is a SNAPSHOT taken in
//!    the setup closure BEFORE the schedule's fire loop is spawned — reading
//!    `schedule.list()` from this async task instead would race the first
//!    tick: a past-due entry can fire and self-clean before we look, and the
//!    resumer's freshly appended RESUME row would then inflate the audit
//!    generation source into a double spawn.
//! 2. **Non-terminal supervised session** for the (project, epic) → skip. At
//!    a true cold start the registry is empty by construction, so this guard
//!    never fires then — it is what makes `reconcile` safely re-callable and
//!    tolerant of a crash-refire after a successor already registered.
//! 3. **Living orphan** ([`orphan_verdict`]) → `ALERT (reconcile_orphan)`
//!    and skip. A claude that survived the app restart may still be working
//!    in the epic's worktree; never double-spawn over a survivor — the human
//!    decides (kill it, or archive the config).
//! 4. **Prior generation found** (handoff filenames in the worktree, or the
//!    audit tail — rows persist across restarts, a legitimate source when
//!    handoff files are missing) → `RESUME {trigger: "cold_start"}` row,
//!    then [`SamuraiReplicator::spawn_generation`] with `prior + 1`. The
//!    replicator picks the ritual (handoff present → successor, missing →
//!    recovery + digest), retries the spawn event while the frontend is not
//!    ready yet, and its per-(project, epic, generation) staging guard makes
//!    a repeated call idempotent.
//! 5. **No generation anywhere** → `ALERT (reconcile_unstartable)`. An
//!    active config whose run never produced a handoff, an audit row, or a
//!    registration (e.g. a crash between the launcher's config write and the
//!    gen-1 spawn) has nothing on disk to resume from; inventing a gen-1
//!    brief is the P3.5 launcher's job, not reconciliation's — the human
//!    relaunches.
//!
//! Shape: the `allowance_watcher` split — pure decision functions
//! ([`decide`], [`orphan_verdict`]) over pre-gathered facts, table-tested
//! without processes or files, and a thin IO shell ([`reconcile`]) around
//! them. The two probes are injected closures (the `SamuraiReplicator`
//! resolver pattern) so the shell itself is harness-testable: lib.rs wires
//! `commands::claude_sessions::newest_transcript_for_project` + mtime and
//! `samurai_watchdog::scan_claude_ancestor_pids`.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_injector::strip_extended_prefix;
use super::samurai_replicator::SamuraiReplicator;
use super::samurai_resumer::latest_handoff_generation;
use super::samurai_run_config::{RunConfigStore, SamuraiRunConfig};
use super::samurai_schedule::ScheduleEntry;
use super::samurai_watchdog::TRANSCRIPT_STALE_AFTER;
use super::supervisor::Supervisor;

/// Age of the newest transcript under the given directory's encoded Claude
/// project dir (`None` = no transcript / not readable). Called with the
/// epic's `\\?\`-stripped WORKTREE path — the orchestrator's cwd, where its
/// transcripts actually live (fresh-eyes review F1). Wired in lib.rs;
/// injected so tests control it.
pub type TranscriptAgeProbe = Arc<dyn Fn(&str) -> Option<Duration> + Send + Sync>;

/// Whether any claude process is alive machine-wide (the watchdog's process
/// scan). Called at most once per pass, on the blocking pool — the scan
/// walks the whole process table.
pub type ClaudeAliveProbe = Arc<dyn Fn() -> bool + Send + Sync>;

/// How many audit rows the generation derivation reads. The tail is per
/// project and generations only grow, so the newest rows always carry the
/// maximum; 500 comfortably covers every event a multi-day run appends
/// between two launches.
const AUDIT_TAIL: usize = 500;

// ---------------------------------------------------------------------------
// Pure decisions (table-tested)
// ---------------------------------------------------------------------------

/// What reconciliation decided for one active run config.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReconcileAction {
    /// A resume timer (past-due or future) exists — the schedule owns it.
    SkipTimer,
    /// A non-terminal supervised session already exists — nothing to rebuild.
    SkipLiveSession,
    /// A pre-restart claude is probably still alive — alert, never spawn.
    AlertOrphan { transcript_age_secs: u64 },
    /// Spawn gen-`next` (= `prior + 1`) via the replicator's ritual.
    Spawn { prior: u32, next: u32 },
    /// Active config but no generation evidence anywhere — human relaunches.
    AlertUnstartable,
}

/// Facts about one epic, gathered by the IO shell. The expensive fields
/// (orphan verdict, prior generation) stay `None` when a guard already
/// skipped the epic — [`decide`] checks the guards first, so it never reads
/// them then.
#[derive(Debug)]
struct EpicFacts {
    timer_pending: bool,
    live_session: bool,
    /// `Some(age_secs)` when [`orphan_verdict`] says "probably alive".
    orphan_age_secs: Option<u64>,
    /// Highest generation across handoff filenames and the audit tail.
    prior_generation: Option<u32>,
}

/// The decision ladder of the module doc, in order.
fn decide(facts: &EpicFacts) -> ReconcileAction {
    if facts.timer_pending {
        return ReconcileAction::SkipTimer;
    }
    if facts.live_session {
        return ReconcileAction::SkipLiveSession;
    }
    if let Some(transcript_age_secs) = facts.orphan_age_secs {
        return ReconcileAction::AlertOrphan {
            transcript_age_secs,
        };
    }
    match facts.prior_generation {
        Some(prior) => ReconcileAction::Spawn {
            prior,
            next: prior + 1,
        },
        None => ReconcileAction::AlertUnstartable,
    }
}

/// `Some(age_secs)` when a claude that predates this launch is PROBABLY
/// still working the epic: the WORKTREE's newest transcript was written
/// inside `fresh_within` (the watchdog's staleness window) AND some claude
/// process is alive. Honestly imprecise by construction: the process scan is
/// machine-wide, the transcript is worktree-scoped — neither alone proves a
/// survivor, and combined they only say "probably alive". That is exactly
/// when NOT to spawn: a false skip costs one launch of delay (the watchdog
/// or the human sorts it out), a false spawn puts two orchestrators in one
/// worktree.
fn orphan_verdict(
    transcript_age: Option<Duration>,
    claude_alive: bool,
    fresh_within: Duration,
) -> Option<u64> {
    match transcript_age {
        Some(age) if claude_alive && age < fresh_within => Some(age.as_secs()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

/// The one-shot startup pass (module doc). `timers` is the pending-timer
/// snapshot taken BEFORE the schedule's fire loop was spawned — see decision
/// order step 1 for why it cannot be read here.
pub async fn reconcile(
    run_configs: Arc<RunConfigStore>,
    timers: Vec<ScheduleEntry>,
    supervisor: Arc<Supervisor>,
    replicator: Arc<SamuraiReplicator>,
    audit: AuditLog,
    transcript_ages: TranscriptAgeProbe,
    claude_alive: ClaudeAliveProbe,
) {
    let configs = run_configs.load_active();
    if configs.is_empty() {
        // The normal state until the P3.5 launcher exists, and afterwards
        // whenever no epic is live. No process scan, no audit noise.
        log::info!("samurai reconciler: no active run configs — nothing to reconcile");
        return;
    }
    log::info!(
        "samurai reconciler: reconciling {} active run config(s)",
        configs.len()
    );

    let timered: HashSet<(String, String)> = timers
        .into_iter()
        .map(|t| (t.project_path, t.epic))
        .collect();
    let sessions = supervisor.list_sessions();
    let guards = |config: &SamuraiRunConfig| -> (bool, bool) {
        let timer_pending = timered.contains(&(config.project_path.clone(), config.epic.clone()));
        let live_session = sessions.iter().any(|s| {
            s.project == config.project_path && s.epic == config.epic && !s.state.is_terminal()
        });
        (timer_pending, live_session)
    };

    // One machine-wide process scan per pass, and only when at least one
    // epic actually reaches the orphan check (the watchdog's "nothing
    // supervised: skip the scan entirely" discipline). Blocking pool: the
    // scan walks the whole process table. A join failure (probe panic) reads
    // as "not alive" — same default direction as the watchdog's tick.
    let needs_scan = configs.iter().any(|config| {
        let (timer_pending, live_session) = guards(config);
        !timer_pending && !live_session
    });
    let alive = if needs_scan {
        let probe = claude_alive.clone();
        tokio::task::spawn_blocking(move || probe())
            .await
            .unwrap_or(false)
    } else {
        false
    };

    for config in &configs {
        let (timer_pending, live_session) = guards(config);
        let facts = if timer_pending || live_session {
            EpicFacts {
                timer_pending,
                live_session,
                orphan_age_secs: None,
                prior_generation: None,
            }
        } else {
            // The orphan probe reads the WORKTREE's transcripts, not the
            // project's: the orchestrator runs with cwd = the epic worktree,
            // so its transcripts live under the worktree's encoded Claude
            // project dir. Probing the project path would miss a surviving
            // orchestrator entirely (fresh-eyes review F1). `\\?\`-stripped,
            // same as every other consumer of the stored path.
            let age = (transcript_ages)(strip_extended_prefix(&config.worktree_path));
            EpicFacts {
                timer_pending,
                live_session,
                orphan_age_secs: orphan_verdict(age, alive, TRANSCRIPT_STALE_AFTER),
                prior_generation: prior_generation(
                    &audit,
                    Path::new(strip_extended_prefix(&config.worktree_path)),
                    &config.project_path,
                    &config.epic,
                )
                .await,
            }
        };
        apply(&replicator, &audit, config, decide(&facts));
    }
}

/// Highest generation either persisted source knows: the epic's handoff
/// filenames in the worktree (`samurai_resumer::latest_handoff_generation`)
/// or the audit tail ([`audit_max_generation`]). `None` = no evidence the
/// run ever produced a generation.
async fn prior_generation(
    audit: &AuditLog,
    worktree: &Path,
    project: &str,
    epic: &str,
) -> Option<u32> {
    let files_max = latest_handoff_generation(&worktree.join(".maestro").join("handoffs"), epic);
    let audit_max = audit_max_generation(audit, project, epic).await;
    files_max.max(audit_max)
}

/// Highest generation (> 0) among the epic's rows in the audit tail.
/// Generation 0 is the "no session yet" sentinel on epic-level ALERT/PARK
/// rows — never generation evidence. Taking the literal max means a RESUME
/// row whose spawn never materialized (crash right after the append) still
/// counts: the next spawn skips a generation number rather than reuse one a
/// predecessor may have partially worked under — the conservative direction.
/// A read failure is missing evidence, not an error to die on.
async fn audit_max_generation(audit: &AuditLog, project: &str, epic: &str) -> Option<u32> {
    match audit.read(project, Some(AUDIT_TAIL), None).await {
        Ok(result) => result
            .events
            .iter()
            .filter(|e| e.epic == epic && e.generation > 0)
            .map(|e| e.generation)
            .max(),
        Err(e) => {
            log::warn!(
                "samurai reconciler: audit read for {project} failed ({e}) — no generation evidence from the log"
            );
            None
        }
    }
}

/// Acts on one decision: one structured log line each (the spec's per-epic
/// trail); the audit rows carry the user-facing story.
fn apply(
    replicator: &Arc<SamuraiReplicator>,
    audit: &AuditLog,
    config: &SamuraiRunConfig,
    action: ReconcileAction,
) {
    match action {
        ReconcileAction::SkipTimer => {
            log::info!(
                "samurai reconciler: epic {} in {} has a pending resume timer — the schedule owns it, skipping",
                config.epic,
                config.project_path,
            );
        }
        ReconcileAction::SkipLiveSession => {
            log::info!(
                "samurai reconciler: epic {} in {} already has a live supervised session — skipping",
                config.epic,
                config.project_path,
            );
        }
        ReconcileAction::AlertOrphan {
            transcript_age_secs,
        } => {
            log::warn!(
                "samurai reconciler: epic {} in {} — transcript written {transcript_age_secs}s ago and a claude process is alive: a pre-restart orchestrator probably survived, NOT spawning (ALERT, human decides)",
                config.epic,
                config.project_path,
            );
            audit.append(
                &config.project_path,
                AuditEvent::now(
                    config.epic.clone(),
                    AuditEventKind::Alert,
                    0,
                    0,
                    json!({
                        "kind": "reconcile_orphan",
                        "epic": config.epic,
                        "transcript_age_secs": transcript_age_secs,
                    }),
                ),
            );
        }
        ReconcileAction::Spawn { prior, next } => {
            log::info!(
                "samurai reconciler: epic {} in {} has no owner — spawning gen-{next} (prior gen-{prior}) in {}",
                config.epic,
                config.project_path,
                config.worktree_path,
            );
            // The RESUME row BEFORE the spawn, so the trail always explains
            // the SPAWN row that follows (the resumer's discipline).
            audit.append(
                &config.project_path,
                AuditEvent::now(
                    config.epic.clone(),
                    AuditEventKind::Resume,
                    next,
                    // 0 sentinel: the successor session does not exist yet.
                    0,
                    json!({ "trigger": "cold_start" }),
                ),
            );
            replicator.spawn_generation(
                &config.project_path,
                &config.epic,
                &config.worktree_path,
                next,
                Some(prior),
            );
        }
        ReconcileAction::AlertUnstartable => {
            log::error!(
                "samurai reconciler: epic {} in {} is ACTIVE but no handoff file, audit row, or registration knows any generation — nothing to resume from, ALERT (relaunch via the launcher)",
                config.epic,
                config.project_path,
            );
            audit.append(
                &config.project_path,
                AuditEvent::now(
                    config.epic.clone(),
                    AuditEventKind::Alert,
                    0,
                    0,
                    json!({ "kind": "reconcile_unstartable", "epic": config.epic }),
                ),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::samurai_config::{SamuraiConfig, SharedSamuraiConfig};
    use crate::core::samurai_replicator::{
        SessionTeardown, StdinWriter, SuccessorEmitter, SuccessorSpawn, TranscriptPathResolver,
    };
    use crate::core::samurai_run_config::SamuraiRunConfig;
    use crate::core::supervisor::SupervisorState;
    use crate::core::windows_process::StdCommandExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, RwLock};
    use tempfile::tempdir;

    // --- pure decisions ---

    fn facts(
        timer_pending: bool,
        live_session: bool,
        orphan_age_secs: Option<u64>,
        prior_generation: Option<u32>,
    ) -> EpicFacts {
        EpicFacts {
            timer_pending,
            live_session,
            orphan_age_secs,
            prior_generation,
        }
    }

    #[test]
    fn test_decide_table() {
        use ReconcileAction::*;
        // (facts, expected) — every branch of the ladder, including
        // precedence: an earlier guard wins however loud the later facts.
        let table = [
            // 1. Timer pending beats everything.
            (facts(true, false, None, None), SkipTimer),
            (facts(true, true, Some(3), Some(7)), SkipTimer),
            // 2. Live session beats orphan + spawn.
            (facts(false, true, None, None), SkipLiveSession),
            (facts(false, true, Some(3), Some(7)), SkipLiveSession),
            // 3. Orphan beats spawn, even with a known prior generation.
            (
                facts(false, false, Some(5), Some(2)),
                AlertOrphan {
                    transcript_age_secs: 5,
                },
            ),
            (
                facts(false, false, Some(0), None),
                AlertOrphan {
                    transcript_age_secs: 0,
                },
            ),
            // 4. Prior generation → spawn prior + 1.
            (
                facts(false, false, None, Some(2)),
                Spawn { prior: 2, next: 3 },
            ),
            (
                facts(false, false, None, Some(1)),
                Spawn { prior: 1, next: 2 },
            ),
            // 5. Nothing anywhere → unstartable.
            (facts(false, false, None, None), AlertUnstartable),
        ];
        for (f, expected) in table {
            assert_eq!(decide(&f), expected, "{f:?}");
        }
    }

    #[test]
    fn test_orphan_verdict_table() {
        const WINDOW: Duration = Duration::from_secs(120);
        let fresh = Some(Duration::from_secs(5));
        let stale = Some(Duration::from_secs(600));
        // (age, claude_alive, expected)
        let table = [
            // Both signals present and fresh → probably alive.
            (fresh, true, Some(5)),
            // Fresh transcript but no claude process: it exited cleanly
            // moments ago — no survivor to protect.
            (fresh, false, None),
            // Claude alive somewhere but THIS project's transcript is stale:
            // the live process is someone else's (machine-wide scan).
            (stale, true, None),
            (stale, false, None),
            // No transcript at all: nothing this project's claude wrote.
            (None, true, None),
            (None, false, None),
            // Boundary: age == window is stale, not fresh (the watchdog's
            // `>= stale_after` complement).
            (Some(WINDOW), true, None),
            (Some(WINDOW - Duration::from_secs(1)), true, Some(119)),
        ];
        for (age, alive, expected) in table {
            assert_eq!(
                orphan_verdict(age, alive, WINDOW),
                expected,
                "age={age:?} alive={alive}"
            );
        }
    }

    // --- prior-generation derivation (tempfile fixtures) ---

    fn write_handoff(dir: &Path, epic: &str, generation: u32) {
        let rel = crate::core::samurai_prompts::handoff_file_relpath(epic, generation);
        let path = dir.join(&rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "# Handoff\n## Repo state\nno sha recorded\n").unwrap();
    }

    fn audit_row(epic: &str, kind: AuditEventKind, generation: u32) -> AuditEvent {
        AuditEvent::now(epic, kind, generation, 0, json!({}))
    }

    #[tokio::test]
    async fn test_prior_generation_files_audit_both_neither() {
        let dir = tempdir().unwrap();
        let (audit, task) = AuditLog::new(dir.path().join("audit"), None);
        tokio::spawn(task);
        let project = "C:/git/proj-recon-prior";

        // Neither source knows anything.
        let worktree = tempdir().unwrap();
        assert_eq!(
            prior_generation(&audit, worktree.path(), project, "#37").await,
            None
        );

        // Files only.
        write_handoff(worktree.path(), "#37", 2);
        assert_eq!(
            prior_generation(&audit, worktree.path(), project, "#37").await,
            Some(2)
        );

        // Audit only (fresh epic ref with no files): rows persist across
        // restarts — a legitimate source when handoff files are missing.
        audit.append(project, audit_row("#40", AuditEventKind::Spawn, 1));
        audit.append(project, audit_row("#40", AuditEventKind::Handoff, 4));
        assert_eq!(
            prior_generation(&audit, worktree.path(), project, "#40").await,
            Some(4)
        );

        // Both: the audit tail is ahead of the last handoff on disk.
        audit.append(project, audit_row("#37", AuditEventKind::Resume, 3));
        assert_eq!(
            prior_generation(&audit, worktree.path(), project, "#37").await,
            Some(3),
            "max(files 2, audit 3)"
        );
        // And files ahead of audit.
        write_handoff(worktree.path(), "#37", 5);
        assert_eq!(
            prior_generation(&audit, worktree.path(), project, "#37").await,
            Some(5),
            "max(files 5, audit 3)"
        );
    }

    #[tokio::test]
    async fn test_audit_max_generation_filters_epic_and_zero_sentinel() {
        let dir = tempdir().unwrap();
        let (audit, task) = AuditLog::new(dir.path().to_path_buf(), None);
        tokio::spawn(task);
        let project = "C:/git/proj-recon-audit";
        // Another epic's rows and generation-0 sentinels must not count.
        audit.append(project, audit_row("#99", AuditEventKind::Handoff, 9));
        audit.append(project, audit_row("#37", AuditEventKind::Alert, 0));
        audit.append(project, audit_row("#37", AuditEventKind::Park, 0));
        assert_eq!(audit_max_generation(&audit, project, "#37").await, None);

        audit.append(project, audit_row("#37", AuditEventKind::Spawn, 2));
        assert_eq!(audit_max_generation(&audit, project, "#37").await, Some(2));
    }

    // --- IO shell (harness like the resumer's, minus schedule/parker) ---

    struct Harness {
        supervisor: Arc<Supervisor>,
        replicator: Arc<SamuraiReplicator>,
        run_configs: Arc<RunConfigStore>,
        audit: AuditLog,
        spawns: Arc<Mutex<Vec<SuccessorSpawn>>>,
    }

    fn harness(dir: &Path) -> Harness {
        let (audit, task) = AuditLog::new(dir.join("audit"), None);
        tokio::spawn(task);
        let supervisor = Arc::new(Supervisor::new(audit.clone(), None));
        let config: SharedSamuraiConfig = Arc::new(RwLock::new(SamuraiConfig::default()));
        let session_dirs: crate::core::samurai_injector::SessionDirResolver = Arc::new(|_| None);
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
            config,
            session_dirs,
            transcript_paths,
            teardown,
            emit_spawn,
            write_stdin,
        ));
        let run_configs = Arc::new(RunConfigStore::new(dir.join("runs")));
        Harness {
            supervisor,
            replicator,
            run_configs,
            audit,
            spawns,
        }
    }

    /// `git init` + one commit, so the spawn ritual's HEAD gate has a repo.
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

    fn ages(age: Option<Duration>) -> TranscriptAgeProbe {
        Arc::new(move |_| age)
    }

    fn alive(alive: bool) -> ClaudeAliveProbe {
        Arc::new(move || alive)
    }

    fn timer(project: &str, epic: &str, fire_at: &str) -> ScheduleEntry {
        ScheduleEntry {
            project_path: project.to_string(),
            epic: epic.to_string(),
            fire_at: fire_at.to_string(),
            reason: "park".to_string(),
        }
    }

    async fn run(h: &Harness, timers: Vec<ScheduleEntry>, age: Option<Duration>, live: bool) {
        reconcile(
            h.run_configs.clone(),
            timers,
            h.supervisor.clone(),
            h.replicator.clone(),
            h.audit.clone(),
            ages(age),
            alive(live),
        )
        .await;
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

    async fn rows(audit: &AuditLog, project: &str) -> Vec<AuditEvent> {
        audit.read(project, None, None).await.unwrap().events
    }

    #[tokio::test]
    async fn test_empty_store_is_a_noop_without_a_process_scan() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let scanned = Arc::new(AtomicBool::new(false));
        let scanned_probe = scanned.clone();
        let probe: ClaudeAliveProbe = Arc::new(move || {
            scanned_probe.store(true, Ordering::SeqCst);
            true
        });

        reconcile(
            h.run_configs.clone(),
            Vec::new(),
            h.supervisor.clone(),
            h.replicator.clone(),
            h.audit.clone(),
            ages(None),
            probe,
        )
        .await;

        assert!(h.spawns.lock().unwrap().is_empty());
        assert!(
            !scanned.load(Ordering::SeqCst),
            "an empty store must not trigger the machine-wide process scan"
        );
    }

    #[tokio::test]
    async fn test_timered_epic_skipped_while_its_neighbour_spawns() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-timer";
        let repo_a = tempdir().unwrap();
        let repo_b = tempdir().unwrap();
        init_repo(repo_b.path());
        write_handoff(repo_a.path(), "#1", 7);
        write_handoff(repo_b.path(), "#2", 1);
        for (epic, repo) in [("#1", &repo_a), ("#2", &repo_b)] {
            h.run_configs
                .save(&SamuraiRunConfig::new(
                    project,
                    epic,
                    repo.path().to_string_lossy().into_owned(),
                ))
                .unwrap();
        }

        // A PAST-DUE timer for #1: still in the snapshot (it fires on the
        // loop's first tick, seconds after reconciliation) — the resumer
        // owns it, reconciliation must not race it. #2 has no timer and a
        // machine-wide claude alive but NO fresh transcript → spawns.
        run(
            &h,
            vec![timer(project, "#1", "2020-01-01T00:00:00+00:00")],
            None,
            true,
        )
        .await;

        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;
        let spawns = h.spawns.lock().unwrap().clone();
        assert_eq!(spawns.len(), 1, "only the timerless epic spawns");
        assert_eq!(spawns[0].epic, "#2");
        assert_eq!(spawns[0].generation, 2, "latest handoff gen 1 + 1");

        let rows = rows(&h.audit, project).await;
        let resumes: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Resume)
            .collect();
        assert_eq!(resumes.len(), 1, "the timered epic gets NO audit row");
        assert_eq!(resumes[0].epic, "#2");
        assert_eq!(resumes[0].generation, 2);
        assert_eq!(resumes[0].session_id, 0);
        assert_eq!(resumes[0].details["trigger"], "cold_start");
    }

    #[tokio::test]
    async fn test_live_session_skips_but_terminal_leftover_does_not() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-live";
        let repo_live = tempdir().unwrap();
        let repo_parked = tempdir().unwrap();
        init_repo(repo_parked.path());
        write_handoff(repo_live.path(), "#1", 3);
        write_handoff(repo_parked.path(), "#2", 3);
        for (epic, repo) in [("#1", &repo_live), ("#2", &repo_parked)] {
            h.run_configs
                .save(&SamuraiRunConfig::new(
                    project,
                    epic,
                    repo.path().to_string_lossy().into_owned(),
                ))
                .unwrap();
        }
        // #1: a WORKING session (the re-call / crash-refire case). #2: a
        // PARKED leftover tile nobody closed — terminal, not an owner.
        h.supervisor
            .register_session(1, project.into(), "#1".into(), 4)
            .unwrap();
        h.supervisor
            .register_session(2, project.into(), "#2".into(), 3)
            .unwrap();
        h.supervisor
            .transition(2, SupervisorState::ParkRequested)
            .unwrap();
        h.supervisor.transition(2, SupervisorState::Parked).unwrap();

        run(&h, Vec::new(), None, false).await;

        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;
        let spawns = h.spawns.lock().unwrap().clone();
        assert_eq!(spawns.len(), 1, "the live epic must not double-spawn");
        assert_eq!(spawns[0].epic, "#2");
        assert_eq!(spawns[0].generation, 4, "handoff gen 3 + 1");
        let rows = rows(&h.audit, project).await;
        assert!(
            !rows
                .iter()
                .any(|r| r.event == AuditEventKind::Resume && r.epic == "#1"),
            "no RESUME row for the live epic"
        );
    }

    #[tokio::test]
    async fn test_probable_orphan_alerts_and_never_spawns() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-orphan";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        write_handoff(repo.path(), "#37", 2); // WOULD spawn gen-3 otherwise
        h.run_configs
            .save(&SamuraiRunConfig::new(
                project,
                "#37",
                repo.path().to_string_lossy().into_owned(),
            ))
            .unwrap();

        // Fresh transcript + a live claude: probably a survivor.
        run(&h, Vec::new(), Some(Duration::from_secs(5)), true).await;

        let rows = rows(&h.audit, project).await;
        let alert = rows
            .iter()
            .find(|r| r.details["kind"] == "reconcile_orphan")
            .expect("orphan ALERT must land");
        assert_eq!(alert.event, AuditEventKind::Alert);
        assert_eq!(alert.epic, "#37");
        assert_eq!(alert.details["epic"], "#37");
        assert_eq!(alert.details["transcript_age_secs"], 5);
        assert_eq!(alert.generation, 0);
        assert!(
            h.spawns.lock().unwrap().is_empty(),
            "never double-spawn over a probable survivor"
        );
        assert!(!rows.iter().any(|r| r.event == AuditEventKind::Resume));
    }

    #[tokio::test]
    async fn test_orphan_probe_reads_the_worktree_not_the_project() {
        // Fresh-eyes review F1: the orchestrator's cwd is the epic WORKTREE,
        // so its transcripts live under the worktree's encoded dir — probing
        // the project path would never see a surviving orchestrator.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-probe";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        write_handoff(repo.path(), "#37", 2);
        // Stored with the Windows `\\?\` verbatim prefix (fs::canonicalize
        // spelling) — the probe must receive the STRIPPED worktree path.
        let verbatim = format!(r"\\?\{}", repo.path().display());
        h.run_configs
            .save(&SamuraiRunConfig::new(project, "#37", verbatim))
            .unwrap();

        let probed: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let probed_rec = probed.clone();
        let probe: TranscriptAgeProbe = Arc::new(move |path: &str| {
            probed_rec.lock().unwrap().push(path.to_string());
            None
        });
        reconcile(
            h.run_configs.clone(),
            Vec::new(),
            h.supervisor.clone(),
            h.replicator.clone(),
            h.audit.clone(),
            probe,
            alive(true),
        )
        .await;

        assert_eq!(
            *probed.lock().unwrap(),
            vec![repo.path().display().to_string()],
            "the probe must get the \\\\?\\-stripped WORKTREE path, not the project path"
        );
    }

    #[tokio::test]
    async fn test_spawn_from_audit_rows_only_uses_recovery() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-auditgen";
        let repo = tempdir().unwrap();
        init_repo(repo.path()); // no handoff files at all
        h.run_configs
            .save(&SamuraiRunConfig::new(
                project,
                "#37",
                repo.path().to_string_lossy().into_owned(),
            ))
            .unwrap();
        // The only generation evidence: audit rows from before the restart.
        h.audit
            .append(project, audit_row("#37", AuditEventKind::Spawn, 4));

        run(&h, Vec::new(), None, false).await;

        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;
        let spawns = h.spawns.lock().unwrap().clone();
        assert_eq!(spawns[0].generation, 5, "audit gen 4 + 1");
        // Gen-4 wrote no handoff → the replicator stages RECOVERY.
        let details = h.replicator.spawn_details(project, "#37", 5).unwrap();
        assert_eq!(details["recovery"], true);
        assert_eq!(details["predecessor_generation"], 4);
        let rows = rows(&h.audit, project).await;
        let resume = rows
            .iter()
            .find(|r| r.event == AuditEventKind::Resume)
            .expect("RESUME row must precede the spawn");
        assert_eq!(resume.generation, 5);
        assert_eq!(resume.details["trigger"], "cold_start");
    }

    #[tokio::test]
    async fn test_unstartable_config_alerts_instead_of_guessing() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-unstartable";
        let repo = tempdir().unwrap(); // no handoffs, no audit, no registry
        h.run_configs
            .save(&SamuraiRunConfig::new(
                project,
                "#37",
                repo.path().to_string_lossy().into_owned(),
            ))
            .unwrap();

        run(&h, Vec::new(), None, false).await;

        let rows = rows(&h.audit, project).await;
        let alert = rows
            .iter()
            .find(|r| r.details["kind"] == "reconcile_unstartable")
            .expect("unstartable ALERT must land");
        assert_eq!(alert.event, AuditEventKind::Alert);
        assert_eq!(alert.details["epic"], "#37");
        assert_eq!(alert.generation, 0);
        assert!(h.spawns.lock().unwrap().is_empty(), "never guess a gen-1");
        assert!(!rows.iter().any(|r| r.event == AuditEventKind::Resume));
    }
}
