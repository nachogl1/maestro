//! Samurai cold-start reconciliation (Phase 3, issue #62; PRD §5.6, §10).
//!
//! **A first-class flow, not a fallback** (PRD §5.6): auto-updates and
//! reboots are the *normal* multi-day events, and everything in-memory —
//! supervisor registry, injector pending, parker state — is empty when the
//! app comes back. The only persisted truth is on disk: active run configs
//! (`samurai_run_config`), the resume timers (`samurai_schedule`), the
//! handoff files in each epic's worktree, and the audit log. [`reconcile`]
//! runs ONCE at startup (spawned at the end of the lib.rs setup closure,
//! after every samurai component is constructed) and reports the world it
//! finds in those four sources: for each ACTIVE run config it either leaves
//! the epic to an owner that already exists or ALERTS a human. COMPLETED
//! configs (issue #96 — the orchestrator declared completion and Maestro
//! verified it via `gh`) and ARCHIVED ones never enter the scan at all:
//! `RunConfigStore::load_active` filters them.
//!
//! **Reconciliation NEVER spawns an agent.** It used to fresh-spawn the next
//! generation for every ownerless ACTIVE epic, which meant reopening the app
//! could start agents nobody asked for — a reboot, an auto-update, or simply
//! quitting and coming back resurrected multi-day runs unattended. Resuming
//! an interrupted run is now an explicit human act; reconciliation's whole
//! job is to make sure the human is TOLD which runs are waiting. (Runtime
//! behaviour while the app stays open is untouched: handoffs still chain
//! into successors, and park timers armed during the session still resume.)
//!
//! Decision order per epic (first match wins — see [`decide`]):
//!
//! 1. **Timer pending** → skip, audit nothing. The schedule/resumer own the
//!    epic: a future timer re-arms on its own, and a fire time that passed
//!    during downtime fires on the loop's FIRST 30s tick (P3.1) — where the
//!    resumer applies the same no-startup-spawn rule and alerts instead
//!    (`samurai_resumer`'s restored-timer gate). The timer set is a SNAPSHOT
//!    taken in the setup closure BEFORE the schedule's fire loop is spawned;
//!    reading `schedule.list()` from this async task instead would race the
//!    first tick, which can fire and self-clean an entry before we look.
//! 2. **Non-terminal supervised session** for the (project, epic) → skip. At
//!    a true cold start the registry is empty by construction, so this guard
//!    never fires then — it is what makes `reconcile` safely re-callable and
//!    tolerant of a crash-refire.
//! 3. **Living orphan** ([`orphan_verdict`]) → `ALERT (reconcile_orphan)`
//!    and skip. A claude that survived the app restart may still be working
//!    in the epic's worktree, and the human decides what to do with it (kill
//!    it, or archive the config). The verdict is a guess, so a pass that
//!    produced one is retried ONCE a staleness window later
//!    ([`reconcile_gated`]) instead of stranding the epic for the app run.
//! 4. **Prior generation found** (handoff filenames in the worktree, or the
//!    audit tail — rows persist across restarts, a legitimate source when
//!    handoff files are missing) → `ALERT (reconcile_interrupted)`: the run
//!    was interrupted at gen-`prior` and is waiting for the human to resume
//!    it from the Launch panel. Nothing is spawned, nothing is written to
//!    the worktree, and the run config stays ACTIVE. The alert is raised
//!    ONCE per interruption, not once per launch: the config is latched
//!    with `interrupted_at` (`SamuraiRunConfig::interrupted_at`) as the row
//!    is appended, and a later launch that finds the same generation stays
//!    quiet. The latch drops itself when the run moves on — a resume spawns
//!    a HIGHER generation (which alerts afresh), a relaunch writes a whole
//!    new config, and an owned run is cleared explicitly below. Without it a
//!    run nobody ever resumed collected one identical row per app start
//!    forever (22 of them over three weeks for a real parked run). Refined by
//!    `gh auth status` when the probe is wired ([`reconcile_with_auth`]):
//!    with `gh` logged out the epic gets `ALERT (reconcile_gh_auth)` instead
//!    — a manual resume would fail its preflight anyway, and an epic parked
//!    for `gh_auth_lost` reaches exactly here (that park arms no timer and
//!    leaves the config ACTIVE by design).
//! 5. **No generation anywhere** → `ALERT (reconcile_unstartable)`. An
//!    active config whose run never produced a handoff, an audit row, or a
//!    registration (e.g. a crash between the launcher's config write and the
//!    gen-1 spawn) has nothing on disk to resume from at all — the human
//!    relaunches it from scratch.
//!
//! Before any of that, every run-config file the store could not READ gets
//! `ALERT (reconcile_unreadable_config)`. A torn or locked record used to be
//! dropped inside `load_all` with a `log::warn!` and nothing else, so a
//! single unreadable ACTIVE run made the launch report "no active run
//! configs — nothing to reconcile" while the run sat on disk unowned and
//! unmentioned — the one failure mode where reconciliation says the world
//! is fine because it cannot see it. Its latch is IN MEMORY for the app run
//! ([`UNREADABLE_ALERTED`]): the config is exactly what cannot be written.
//!
//! Shape: the `allowance_watcher` split — pure decision functions
//! ([`decide`], [`orphan_verdict`]) over pre-gathered facts, table-tested
//! without processes or files, and a thin IO shell ([`reconcile`]) around
//! them. The two probes are injected closures (the `SamuraiReplicator`
//! resolver pattern) so the shell itself is harness-testable: lib.rs wires
//! `commands::claude_sessions::newest_transcript_for_project` + mtime and
//! `samurai_watchdog::scan_claude_ancestor_pids`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde_json::json;

use super::allowance_watcher::{ACCOUNT_PROJECT, ACCOUNT_RUN};
use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_auth_watch::AuthProbe;
use super::samurai_injector::strip_extended_prefix;
use super::samurai_resumer::latest_handoff_generation;
use super::samurai_run_config::{RunConfigStore, SamuraiRunConfig, UnreadableConfig};
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

/// `details.kind` of the ALERT an ownerless ACTIVE run lands at startup —
/// the row that replaced the old cold-start auto-spawn.
pub const RECONCILE_INTERRUPTED_KIND: &str = "reconcile_interrupted";

/// `details.kind` of the ALERT a run-config file that could not be READ
/// lands at startup. Distinct from every other `reconcile_*` kind on
/// purpose: those describe a run whose record was understood, this one says
/// the record itself is unreadable, so nothing about the run — not even
/// whether it is ACTIVE — is known.
pub const RECONCILE_UNREADABLE_CONFIG_KIND: &str = "reconcile_unreadable_config";

/// Config files already alerted on during THIS app run.
///
/// The `reconcile_interrupted` latch lives in the config itself (PR #185),
/// which is precisely what is not available here: the file cannot be read,
/// so it cannot be written either, and inventing a sidecar file to remember
/// a fact about an unreadable file would only add a second thing to go
/// wrong. So the latch is process-global and keyed by path. It dedupes the
/// retry pass ([`reconcile_gated`] runs [`reconcile_pass`] twice) and any
/// re-entry within one app run, and it deliberately re-arms on restart — a
/// file that is STILL unreadable at the next launch is still an unowned run
/// nobody has dealt with, and one row per launch (rather than the two per
/// launch a missing latch gives) is the honest report.
///
/// Tests are isolated by construction: every harness roots its store in its
/// own tempdir, so no two tests can ever key the same path.
static UNREADABLE_ALERTED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

/// `true` the FIRST time `path` is seen this app run, `false` afterwards.
fn latch_unreadable(path: &Path) -> bool {
    UNREADABLE_ALERTED
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(path.to_path_buf())
}

/// Appends one `reconcile_unreadable_config` ALERT per file this app run has
/// not already reported.
///
/// The row is stamped with the [`ACCOUNT_PROJECT`]/[`ACCOUNT_RUN`]
/// pseudo-entities the allowance watcher established for exactly this
/// situation — an alert whose owner is not knowable. Deriving a project
/// from the file's own directory would fabricate a path that matches no real
/// project (the directory name carries a hash of the project path, which
/// cannot be inverted) and would file the row in an audit log nothing ever
/// opens; the account scope is a real, named, viewable bucket. The path and
/// the reason travel in `details`, which is what a human needs in order to
/// go and look at the file.
fn alert_unreadable(audit: &AuditLog, unreadable: &[UnreadableConfig]) {
    for entry in unreadable {
        if !latch_unreadable(&entry.path) {
            log::info!(
                "samurai reconciler: run config {:?} is still unreadable — already reported this app run",
                entry.path,
            );
            continue;
        }
        log::error!(
            "samurai reconciler: run config {:?} could not be read ({}) — if it is an ACTIVE run, nothing here can see it, own it or resume it (ALERT, human decides)",
            entry.path,
            entry.error,
        );
        audit.append(
            ACCOUNT_PROJECT,
            AuditEvent::now(
                ACCOUNT_RUN.to_string(),
                AuditEventKind::Alert,
                0,
                0,
                json!({
                    "kind": RECONCILE_UNREADABLE_CONFIG_KIND,
                    "path": entry.path.to_string_lossy(),
                    "error": entry.error,
                    "message": format!(
                        "a samurai run config could not be read ({}) — if it is an active run it stays invisible to Maestro until the file is fixed or removed",
                        entry.error
                    ),
                }),
            ),
        );
    }
}

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
    /// The run was interrupted at gen-`prior` and has no owner: alert, so
    /// the human resumes it. Startup NEVER spawns (module doc).
    AlertInterrupted { prior: u32 },
    /// Same as [`Self::AlertInterrupted`], but `gh` is not authenticated —
    /// a manual resume needs that fixed first.
    AlertNoGhAuth,
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
        Some(prior) => ReconcileAction::AlertInterrupted { prior },
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

/// The startup reconciliation (module doc). `timers` is the pending-timer
/// snapshot taken BEFORE the schedule's fire loop was spawned — see decision
/// order step 1 for why it cannot be read here.
///
/// Without a `gh` probe the interrupted-run alert is not auth-refined;
/// prefer [`reconcile_with_auth`].
//
// No replicator reaches this module by design (module doc): startup cannot
// spawn an agent if it has no way to ask for one.
// Startup calls `reconcile_with_auth`; this ungated entry point is what the
// tests drive so they never shell out to `gh`.
#[allow(dead_code)]
pub async fn reconcile(
    run_configs: Arc<RunConfigStore>,
    timers: Vec<ScheduleEntry>,
    supervisor: Arc<Supervisor>,
    audit: AuditLog,
    transcript_ages: TranscriptAgeProbe,
    claude_alive: ClaudeAliveProbe,
) {
    reconcile_gated(
        run_configs,
        timers,
        supervisor,
        audit,
        transcript_ages,
        claude_alive,
        None,
        TRANSCRIPT_STALE_AFTER,
    )
    .await
}

/// [`reconcile`] with the auth watcher's `gh auth status` probe wired in: an
/// epic parked for `gh_auth_lost` keeps its ACTIVE run config and arms NO
/// resume timer by design, so it lands on the interrupted-run alert — and
/// that alert should tell the human the truth, that a manual resume needs
/// `gh` fixed first (the launcher's preflight refuses the same state). Data-
/// gap policy is the auth watcher's: `Ok(false)` counts as logged out, `Err`
/// (gh missing/timeout) does not.
#[allow(clippy::too_many_arguments)]
pub async fn reconcile_with_auth(
    run_configs: Arc<RunConfigStore>,
    timers: Vec<ScheduleEntry>,
    supervisor: Arc<Supervisor>,
    audit: AuditLog,
    transcript_ages: TranscriptAgeProbe,
    claude_alive: ClaudeAliveProbe,
    auth: AuthProbe,
) {
    reconcile_gated(
        run_configs,
        timers,
        supervisor,
        audit,
        transcript_ages,
        claude_alive,
        Some(auth),
        TRANSCRIPT_STALE_AFTER,
    )
    .await
}

/// One pass, plus ONE deferred retry pass when some epic ended in "probable
/// orphan". [`orphan_verdict`] is a GUESS (the process scan is machine-wide),
/// and a wrong guess used to strand every active epic for the whole app run —
/// nothing re-evaluates it: `reconcile` has a single caller in the setup
/// closure and the watchdog skips its scan when nothing is supervised. Costing
/// it one staleness window instead makes the second pass self-resolving: a
/// truly dead orchestrator's transcript is stale by then (so the human gets
/// the interrupted-run alert), a real survivor has written again (so it
/// stays an orphan alert). The live-session guard at step 2 is what makes
/// the second pass idempotent. `retry_after` is injected for the tests;
/// production is always [`TRANSCRIPT_STALE_AFTER`].
#[allow(clippy::too_many_arguments)]
async fn reconcile_gated(
    run_configs: Arc<RunConfigStore>,
    timers: Vec<ScheduleEntry>,
    supervisor: Arc<Supervisor>,
    audit: AuditLog,
    transcript_ages: TranscriptAgeProbe,
    claude_alive: ClaudeAliveProbe,
    auth: Option<AuthProbe>,
    retry_after: Duration,
) {
    let (orphaned, handled) = reconcile_pass(
        &run_configs,
        &timers,
        &supervisor,
        &audit,
        &transcript_ages,
        &claude_alive,
        auth.as_ref(),
        &HashSet::new(),
    )
    .await;
    if !orphaned {
        return;
    }
    log::info!(
        "samurai reconciler: at least one epic looked like a probable orphan — one retry pass in {}s",
        retry_after.as_secs()
    );
    tokio::time::sleep(retry_after).await;
    // `handled` keeps the retry from alerting twice for the epics pass 1
    // already decided: nothing about them changes in one staleness window,
    // and a duplicate "resume it manually" row is pure noise.
    reconcile_pass(
        &run_configs,
        &timers,
        &supervisor,
        &audit,
        &transcript_ages,
        &claude_alive,
        auth.as_ref(),
        &handled,
    )
    .await;
}

/// One reconciliation pass over every ACTIVE run config. Returns whether any
/// epic ended in [`ReconcileAction::AlertOrphan`] — the only verdict worth
/// retrying (see [`reconcile_gated`]) — plus the (project, epic) pairs this
/// pass already decided.
///
/// `already_handled` are pairs an EARLIER pass alerted on. They are treated
/// exactly like a live session: this pass must not re-decide them, or the
/// human gets the same alert twice for one launch.
#[allow(clippy::too_many_arguments)]
async fn reconcile_pass(
    run_configs: &Arc<RunConfigStore>,
    timers: &[ScheduleEntry],
    supervisor: &Arc<Supervisor>,
    audit: &AuditLog,
    transcript_ages: &TranscriptAgeProbe,
    claude_alive: &ClaudeAliveProbe,
    auth: Option<&AuthProbe>,
    already_handled: &HashSet<(String, String)>,
) -> (bool, HashSet<(String, String)>) {
    let mut handled: HashSet<(String, String)> = HashSet::new();
    let scan = run_configs.load_active_scan();
    // Before the parsed configs, and unconditionally: a file that could not
    // be read is the ONE case where "nothing to reconcile" would be a lie.
    alert_unreadable(audit, &scan.unreadable);
    let configs = scan.configs;
    if configs.is_empty() {
        // The normal state until the P3.5 launcher exists, and afterwards
        // whenever no epic is live. No process scan, no audit noise.
        log::info!(
            "samurai reconciler: no readable active run configs — nothing to reconcile ({} unreadable file(s))",
            scan.unreadable.len(),
        );
        return (false, handled);
    }
    log::info!(
        "samurai reconciler: reconciling {} active run config(s)",
        configs.len()
    );

    let timered: HashSet<(String, String)> = timers
        .iter()
        .map(|t| (t.project_path.clone(), t.epic.clone()))
        .collect();
    let sessions = supervisor.list_sessions();
    // `(timer_pending, live_session, owned)`. The third element is the
    // REAL-owner half of the first two — a pending timer or a live supervised
    // session — with `already_handled` deliberately excluded: that is this
    // launch's own earlier verdict, not evidence anybody owns the run, and
    // treating it as ownership would undo the latch pass 1 just wrote.
    let guards = |config: &SamuraiRunConfig| -> (bool, bool, bool) {
        let key = (config.project_path.clone(), config.epic.clone());
        let timer_pending = timered.contains(&key);
        let session_live = sessions.iter().any(|s| {
            s.project == config.project_path && s.epic == config.epic && !s.state.is_terminal()
        });
        // An epic an earlier pass already decided is treated as settled —
        // see `already_handled`.
        let live_session = already_handled.contains(&key) || session_live;
        (timer_pending, live_session, timer_pending || session_live)
    };

    // One machine-wide process scan per pass, and only when at least one
    // epic actually reaches the orphan check (the watchdog's "nothing
    // supervised: skip the scan entirely" discipline). Blocking pool: the
    // scan walks the whole process table. A join failure (probe panic) reads
    // as "not alive" — same default direction as the watchdog's tick.
    let needs_scan = configs.iter().any(|config| {
        let (timer_pending, live_session, _) = guards(config);
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

    // The `gh auth status` verdict for this pass: probed at most once, and
    // only when some epic actually reaches the interrupted-run alert (the
    // `needs_scan` discipline — no subprocess for a pass with nothing to
    // report).
    let mut gh_ok: Option<bool> = None;
    let mut orphaned = false;

    for config in &configs {
        let (timer_pending, live_session, owned) = guards(config);
        // The run has an owner again, so the interruption we alerted about is
        // over: drop the latch, or a LATER interruption at the SAME generation
        // would be swallowed as a repeat of the old one.
        if owned && config.interrupted_at.is_some() {
            if let Err(e) = run_configs.clear_interrupted(&config.project_path, &config.epic) {
                log::warn!(
                    "samurai reconciler: could not clear the interrupted latch on {} in {}: {e}",
                    config.epic,
                    config.project_path,
                );
            }
        }
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
            //
            // Blocking pool, like the process scan above: the probe walks the
            // encoded Claude project dir with a `metadata()` per `.jsonl`, and
            // this crate's rule for that FS work is "never inline on the
            // runtime". A join failure (probe panic) reads as "no transcript".
            let probe = transcript_ages.clone();
            let worktree = strip_extended_prefix(&config.worktree_path);
            let path = worktree.clone();
            let age = tokio::task::spawn_blocking(move || probe(&path))
                .await
                .unwrap_or(None);
            EpicFacts {
                timer_pending,
                live_session,
                orphan_age_secs: orphan_verdict(age, alive, TRANSCRIPT_STALE_AFTER),
                prior_generation: prior_generation(
                    audit,
                    Path::new(&worktree),
                    &config.project_path,
                    &config.epic,
                )
                .await,
            }
        };
        let mut action = decide(&facts);
        orphaned |= matches!(action, ReconcileAction::AlertOrphan { .. });
        if matches!(action, ReconcileAction::AlertInterrupted { .. }) {
            let ok = match gh_ok {
                Some(ok) => ok,
                None => {
                    // gh runs in the config's project directory — auth is
                    // account-global, the cwd only anchors it to a repo (the
                    // auth watcher's wiring). `Err` is a data gap, not a loss.
                    let ok = match auth {
                        Some(probe) => {
                            !matches!(probe(config.project_path.clone()).await, Ok(false))
                        }
                        None => true,
                    };
                    gh_ok = Some(ok);
                    ok
                }
            };
            if !ok {
                action = ReconcileAction::AlertNoGhAuth;
            }
        }
        // EVERY verdict the retry pass must not repeat — which is all of them
        // except AlertOrphan, whose re-decision IS the retry's purpose (see
        // `reconcile_gated`). Recording only `AlertInterrupted` here left the
        // gh-auth and unstartable rows to be appended a second time in a
        // single launch, and it had to be read AFTER the `AlertNoGhAuth`
        // reassignment above, which rewrote the very variant it matched on.
        if !matches!(action, ReconcileAction::AlertOrphan { .. }) {
            handled.insert((config.project_path.clone(), config.epic.clone()));
        }
        apply(audit, run_configs, config, action);
    }
    (orphaned, handled)
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
/// trail); the audit rows carry the user-facing story. `run_configs` is
/// written by exactly one arm — the interrupted-run latch (module doc).
fn apply(
    audit: &AuditLog,
    run_configs: &RunConfigStore,
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
        ReconcileAction::AlertInterrupted { prior } => {
            // Already reported, and the run has not moved on since (a resume
            // spawns gen prior+1, which is a NEW interruption worth a row).
            // Without this the same row landed on every app start forever.
            if let Some(stamp) = &config.interrupted_at {
                if stamp.prior_generation >= prior {
                    log::info!(
                        "samurai reconciler: run {} in {} is still interrupted at gen-{prior} — already alerted at {}, not repeating the row",
                        config.epic,
                        config.project_path,
                        stamp.at,
                    );
                    return;
                }
            }
            log::warn!(
                "samurai reconciler: run {} in {} was interrupted at gen-{prior} and has no owner — resume it manually (startup never spawns an agent); worktree {}",
                config.epic,
                config.project_path,
                config.worktree_path,
            );
            audit.append(
                &config.project_path,
                AuditEvent::now(
                    config.epic.clone(),
                    AuditEventKind::Alert,
                    0,
                    0,
                    json!({
                        "kind": RECONCILE_INTERRUPTED_KIND,
                        "epic": config.epic,
                        "prior_generation": prior,
                        "message": format!(
                            "run {} was interrupted — resume it manually",
                            config.epic
                        ),
                    }),
                ),
            );
            // Latch it so the next launch does not say the same thing again.
            // A failure here only costs a repeated row next time — never the
            // alert the human just got.
            if let Err(e) = run_configs.mark_interrupted(&config.project_path, &config.epic, prior)
            {
                log::warn!(
                    "samurai reconciler: could not latch the interrupted alert for {} in {}: {e} — it will repeat next launch",
                    config.epic,
                    config.project_path,
                );
            }
        }
        ReconcileAction::AlertNoGhAuth => {
            log::error!(
                "samurai reconciler: run {} in {} was interrupted AND `gh` is not authenticated — fix auth before resuming it manually (a successor could not read issues, comment, or open PRs)",
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
                        "kind": "reconcile_gh_auth",
                        "epic": config.epic,
                        "message": format!(
                            "run {} was interrupted — fix `gh` auth, then resume it manually",
                            config.epic
                        ),
                    }),
                ),
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
    use crate::core::samurai_run_config::SamuraiRunConfig;
    use crate::core::supervisor::SupervisorState;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;
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
            // 2. Live session beats orphan + the interrupted alert.
            (facts(false, true, None, None), SkipLiveSession),
            (facts(false, true, Some(3), Some(7)), SkipLiveSession),
            // 3. Orphan wins over the interrupted alert, even with a known
            //    prior generation.
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
            // 4. Prior generation → the run was interrupted at that gen and
            //    waits for a MANUAL resume. Startup never spawns.
            (
                facts(false, false, None, Some(2)),
                AlertInterrupted { prior: 2 },
            ),
            (
                facts(false, false, None, Some(1)),
                AlertInterrupted { prior: 1 },
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
    //
    // No replicator, deliberately: reconciliation cannot spawn an agent
    // because it is never handed anything that could. What the tests check
    // is the audit trail the human actually reads.

    struct Harness {
        supervisor: Arc<Supervisor>,
        run_configs: Arc<RunConfigStore>,
        audit: AuditLog,
    }

    fn harness(dir: &Path) -> Harness {
        let (audit, task) = AuditLog::new(dir.join("audit"), None);
        tokio::spawn(task);
        let supervisor = Arc::new(Supervisor::new(audit.clone(), None));
        let run_configs = Arc::new(RunConfigStore::new(dir.join("runs")));
        Harness {
            supervisor,
            run_configs,
            audit,
        }
    }

    fn ages(age: Option<Duration>) -> TranscriptAgeProbe {
        Arc::new(move |_| age)
    }

    fn alive(alive: bool) -> ClaudeAliveProbe {
        Arc::new(move || alive)
    }

    fn auth(result: Result<bool, &'static str>) -> AuthProbe {
        Arc::new(move |_| {
            let result = result.map_err(str::to_string);
            Box::pin(async move { result })
        })
    }

    /// The production retry wait is a whole staleness window (120s); the
    /// tests only care that the second pass happens.
    const TEST_RETRY: Duration = Duration::from_millis(10);

    fn timer(project: &str, epic: &str, fire_at: &str) -> ScheduleEntry {
        ScheduleEntry {
            project_path: project.to_string(),
            epic: epic.to_string(),
            fire_at: fire_at.to_string(),
            reason: "park".to_string(),
            launch: None,
            held: false,
        }
    }

    fn save_config(h: &Harness, project: &str, epic: &str, worktree: &Path) {
        h.run_configs
            .save(&SamuraiRunConfig::new(
                project,
                epic,
                worktree.to_string_lossy().into_owned(),
            ))
            .unwrap();
    }

    async fn run(h: &Harness, timers: Vec<ScheduleEntry>, age: Option<Duration>, live: bool) {
        reconcile_gated(
            h.run_configs.clone(),
            timers,
            h.supervisor.clone(),
            h.audit.clone(),
            ages(age),
            alive(live),
            None,
            TEST_RETRY,
        )
        .await;
    }

    async fn rows(audit: &AuditLog, project: &str) -> Vec<AuditEvent> {
        audit.read(project, None, None).await.unwrap().events
    }

    /// The epic's interrupted-run alerts, in order.
    async fn interrupted(audit: &AuditLog, project: &str) -> Vec<AuditEvent> {
        rows(audit, project)
            .await
            .into_iter()
            .filter(|r| r.details["kind"] == RECONCILE_INTERRUPTED_KIND)
            .collect()
    }

    /// The unreadable-config alerts, which land on the account scope
    /// (`alert_unreadable`: the owning project is exactly what is unknown).
    async fn unreadable(audit: &AuditLog) -> Vec<AuditEvent> {
        rows(audit, ACCOUNT_PROJECT)
            .await
            .into_iter()
            .filter(|r| r.details["kind"] == RECONCILE_UNREADABLE_CONFIG_KIND)
            .collect()
    }

    /// Tears every run-config JSON under `runs_dir`, returning the single
    /// path it wrecked. A torn write and a file the OS will not hand over
    /// (an editor, a backup agent or the app itself holding it — routine on
    /// Windows) reach `read_config` as the same `ReadError::Other`.
    fn tear_the_only_config(runs_dir: &Path) -> PathBuf {
        let mut torn = Vec::new();
        for project in std::fs::read_dir(runs_dir).unwrap().flatten() {
            for file in std::fs::read_dir(project.path()).unwrap().flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    std::fs::write(&path, "{ \"project_path\": ").unwrap();
                    torn.push(path);
                }
            }
        }
        assert_eq!(torn.len(), 1, "the harness writes exactly one config");
        torn.pop().unwrap()
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
            h.audit.clone(),
            ages(None),
            probe,
        )
        .await;

        assert!(
            !scanned.load(Ordering::SeqCst),
            "an empty store must not trigger the machine-wide process scan"
        );
    }

    #[tokio::test]
    async fn test_interrupted_run_alerts_and_never_spawns() {
        // The behaviour change: an ownerless ACTIVE run used to be
        // fresh-spawned at startup. Reopening the app must not start work
        // nobody asked for, so it lands an ALERT naming the interrupted
        // generation, and the config stays ACTIVE for a manual resume.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-interrupted";
        let repo = tempdir().unwrap();
        write_handoff(repo.path(), "#37", 2); // WOULD have spawned gen-3
        save_config(&h, project, "#37", repo.path());

        run(&h, Vec::new(), None, false).await;

        let alerts = interrupted(&h.audit, project).await;
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].event, AuditEventKind::Alert);
        assert_eq!(alerts[0].epic, "#37");
        assert_eq!(alerts[0].details["epic"], "#37");
        assert_eq!(alerts[0].details["prior_generation"], 2);
        assert_eq!(
            alerts[0].details["message"],
            "run #37 was interrupted — resume it manually"
        );
        assert_eq!(alerts[0].generation, 0);
        assert_eq!(alerts[0].session_id, 0);
        // No RESUME row either: nothing resumed, so nothing may claim it did.
        assert!(!rows(&h.audit, project)
            .await
            .iter()
            .any(|r| r.event == AuditEventKind::Resume));
        // The run stays ACTIVE — reconciliation deletes and flips nothing.
        assert!(h.run_configs.get(project, "#37").is_some());
    }

    #[tokio::test]
    async fn test_timered_epic_skipped_while_its_neighbour_alerts() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-timer";
        let repo_a = tempdir().unwrap();
        let repo_b = tempdir().unwrap();
        write_handoff(repo_a.path(), "#1", 7);
        write_handoff(repo_b.path(), "#2", 1);
        save_config(&h, project, "#1", repo_a.path());
        save_config(&h, project, "#2", repo_b.path());

        // A PAST-DUE timer for #1: still in the snapshot (it fires on the
        // schedule loop's first tick, seconds after reconciliation) — the
        // resumer owns it and applies the same no-startup-spawn rule there.
        run(
            &h,
            vec![timer(project, "#1", "2020-01-01T00:00:00+00:00")],
            None,
            true,
        )
        .await;

        let alerts = interrupted(&h.audit, project).await;
        assert_eq!(alerts.len(), 1, "the timered epic gets NO audit row");
        assert_eq!(alerts[0].epic, "#2");
        assert_eq!(alerts[0].details["prior_generation"], 1);
    }

    #[tokio::test]
    async fn test_live_session_skips_but_terminal_leftover_does_not() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-live";
        let repo_live = tempdir().unwrap();
        let repo_parked = tempdir().unwrap();
        write_handoff(repo_live.path(), "#1", 3);
        write_handoff(repo_parked.path(), "#2", 3);
        save_config(&h, project, "#1", repo_live.path());
        save_config(&h, project, "#2", repo_parked.path());
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

        let alerts = interrupted(&h.audit, project).await;
        assert_eq!(alerts.len(), 1, "the live epic is left alone");
        assert_eq!(alerts[0].epic, "#2");
        assert_eq!(alerts[0].details["prior_generation"], 3);
    }

    #[tokio::test]
    async fn test_probable_orphan_alerts_and_stays_skipped() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-orphan";
        let repo = tempdir().unwrap();
        write_handoff(repo.path(), "#37", 2);
        save_config(&h, project, "#37", repo.path());

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
        // The orphan verdict wins outright — no interrupted alert on top.
        assert!(interrupted(&h.audit, project).await.is_empty());
    }

    #[tokio::test]
    async fn test_probable_orphan_is_retried_once_a_staleness_window_later() {
        // The verdict is a guess (machine-wide process scan): a wrong one
        // must cost ONE staleness window, not the whole app run — nothing
        // else re-evaluates it. Second pass: the transcript is stale by
        // then, so the human finally gets the interrupted-run alert.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-retry";
        let repo = tempdir().unwrap();
        write_handoff(repo.path(), "#37", 2);
        save_config(&h, project, "#37", repo.path());

        // Fresh on the first pass, stale on every later one.
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_probe = calls.clone();
        let probe: TranscriptAgeProbe = Arc::new(move |_| {
            let n = calls_probe.fetch_add(1, Ordering::SeqCst);
            Some(Duration::from_secs(if n == 0 { 5 } else { 600 }))
        });

        reconcile_gated(
            h.run_configs.clone(),
            Vec::new(),
            h.supervisor.clone(),
            h.audit.clone(),
            probe,
            alive(true),
            None,
            TEST_RETRY,
        )
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 2, "exactly two passes");
        // The first pass' ALERT stays in the trail; the retry explains it.
        let rows = rows(&h.audit, project).await;
        assert_eq!(
            rows.iter()
                .filter(|r| r.details["kind"] == "reconcile_orphan")
                .count(),
            1
        );
        let alerts = interrupted(&h.audit, project).await;
        assert_eq!(alerts.len(), 1, "the retry pass alerts exactly once");
        assert_eq!(alerts[0].details["prior_generation"], 2);
    }

    #[tokio::test]
    async fn test_retry_pass_does_not_realert_an_epic_pass_one_already_decided() {
        // Two ACTIVE configs: epic A looks like a probable orphan (which is
        // what arms the retry pass at all), epic B is stale and gets its
        // interrupted alert on pass 1. The retry must NOT re-decide B — the
        // same "resume it manually" row twice for one launch is pure noise.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-double";
        let repo_a = tempdir().unwrap();
        let repo_b = tempdir().unwrap();
        write_handoff(repo_b.path(), "#78", 3);
        save_config(&h, project, "#77", repo_a.path());
        save_config(&h, project, "#78", repo_b.path());

        // Epic A's transcript stays fresh (with a live claude machine-wide it
        // reads as a probable orphan → AlertOrphan → the retry is armed);
        // epic B's is always stale.
        let a_path = repo_a.path().to_string_lossy().into_owned();
        let probe: TranscriptAgeProbe = Arc::new(move |path: &str| {
            Some(Duration::from_secs(if path == a_path { 5 } else { 600 }))
        });

        reconcile_gated(
            h.run_configs.clone(),
            Vec::new(),
            h.supervisor.clone(),
            h.audit.clone(),
            probe,
            alive(true),
            None,
            TEST_RETRY,
        )
        .await;

        let alerts = interrupted(&h.audit, project).await;
        assert_eq!(alerts.len(), 1, "epic #78 alerts exactly once, not twice");
        assert_eq!(alerts[0].epic, "#78");
        assert_eq!(alerts[0].details["prior_generation"], 3);
    }

    #[tokio::test]
    async fn test_interrupted_alert_is_latched_and_rearms_on_a_new_generation() {
        // A run nobody ever resumes stays ACTIVE forever, and every launch
        // used to append an identical "resume it manually" row — a real
        // parked run collected 22 of them over three weeks. The alert is now
        // latched onto the config, and the latch re-arms itself when the run
        // moves on: a resume spawns a HIGHER generation, which is a NEW
        // interruption worth telling the human about.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-latch";
        let repo = tempdir().unwrap();
        write_handoff(repo.path(), "#37", 2);
        save_config(&h, project, "#37", repo.path());

        // Launch 1: the human is told once, and the config remembers it.
        run(&h, Vec::new(), None, false).await;
        let alerts = interrupted(&h.audit, project).await;
        assert_eq!(alerts.len(), 1);
        let stamp = h
            .run_configs
            .get(project, "#37")
            .unwrap()
            .interrupted_at
            .expect("the alert must latch onto the run config");
        assert_eq!(stamp.prior_generation, 2);
        assert!(!stamp.at.is_empty());

        // Launches 2 and 3: nothing changed, so nothing is said again.
        run(&h, Vec::new(), None, false).await;
        run(&h, Vec::new(), None, false).await;
        assert_eq!(
            interrupted(&h.audit, project).await.len(),
            1,
            "an unresumed run must not append one identical row per launch"
        );
        // The run itself is untouched — still ACTIVE, still resumable.
        assert_eq!(
            h.run_configs.get(project, "#37").unwrap().status,
            crate::core::samurai_run_config::RunConfigStatus::Active
        );

        // The human resumes it (the resumer's RESUME row at gen prior+1) and
        // the app is closed mid-run: the NEXT launch alerts afresh.
        h.audit
            .append(project, audit_row("#37", AuditEventKind::Resume, 3));
        run(&h, Vec::new(), None, false).await;
        let alerts = interrupted(&h.audit, project).await;
        assert_eq!(alerts.len(), 2, "a later interruption must alert again");
        assert_eq!(alerts[1].details["prior_generation"], 3);
        assert_eq!(
            h.run_configs
                .get(project, "#37")
                .unwrap()
                .interrupted_at
                .unwrap()
                .prior_generation,
            3,
            "the latch moves with the run"
        );
    }

    #[tokio::test]
    async fn test_an_owned_run_drops_the_interrupted_latch() {
        // Generation advance is not the only way a run comes back: a
        // survivor already registered at the SAME generation owns it too.
        // The latch must drop then, or the next real interruption — still at
        // gen-2 — would be swallowed as a repeat of the old one.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-latch-owned";
        let repo = tempdir().unwrap();
        write_handoff(repo.path(), "#37", 2);
        save_config(&h, project, "#37", repo.path());

        run(&h, Vec::new(), None, false).await;
        assert_eq!(interrupted(&h.audit, project).await.len(), 1);
        assert!(h
            .run_configs
            .get(project, "#37")
            .unwrap()
            .interrupted_at
            .is_some());

        // A live supervised session at gen-2 owns the epic: skipped, and the
        // latch is dropped.
        h.supervisor
            .register_session(1, project.into(), "#37".into(), 2)
            .unwrap();
        run(&h, Vec::new(), None, false).await;
        assert_eq!(interrupted(&h.audit, project).await.len(), 1, "still owned");
        assert!(
            h.run_configs
                .get(project, "#37")
                .unwrap()
                .interrupted_at
                .is_none(),
            "an owned run must not stay latched as interrupted"
        );

        // That session ends without ever leaving gen-2: the interruption is
        // new, so the human hears about it.
        h.supervisor
            .transition(1, SupervisorState::ParkRequested)
            .unwrap();
        h.supervisor.transition(1, SupervisorState::Parked).unwrap();
        run(&h, Vec::new(), None, false).await;
        let alerts = interrupted(&h.audit, project).await;
        assert_eq!(alerts.len(), 2);
        assert_eq!(alerts[1].details["prior_generation"], 2);
    }

    #[tokio::test]
    async fn test_retry_pass_does_not_realert_gh_auth_or_unstartable_epics() {
        // Only `AlertInterrupted` used to be recorded as handled — and that
        // check ran AFTER the gh-auth reassignment rewrote the very variant
        // it matched on, so a logged-out epic (and every unstartable one) was
        // re-decided by the retry pass and landed a DUPLICATE row in a single
        // launch. Epic A is the probable orphan that arms the retry at all.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-retry-dupes";
        let repo_a = tempdir().unwrap();
        let repo_b = tempdir().unwrap();
        let repo_c = tempdir().unwrap();
        write_handoff(repo_b.path(), "#78", 3); // interrupted → gh-auth row
        save_config(&h, project, "#77", repo_a.path()); // orphan
        save_config(&h, project, "#78", repo_b.path());
        save_config(&h, project, "#79", repo_c.path()); // no evidence at all

        // Only epic A's transcript stays fresh, so only A reads as an orphan.
        let a_path = repo_a.path().to_string_lossy().into_owned();
        let probe: TranscriptAgeProbe = Arc::new(move |path: &str| {
            Some(Duration::from_secs(if path == a_path { 5 } else { 600 }))
        });

        reconcile_gated(
            h.run_configs.clone(),
            Vec::new(),
            h.supervisor.clone(),
            h.audit.clone(),
            probe,
            alive(true),
            Some(auth(Ok(false))),
            TEST_RETRY,
        )
        .await;

        let rows = rows(&h.audit, project).await;
        let count = |kind: &str| {
            rows.iter()
                .filter(|r| r.details["kind"] == kind)
                .collect::<Vec<_>>()
        };
        let gh = count("reconcile_gh_auth");
        assert_eq!(gh.len(), 1, "epic #78 gets ONE gh-auth row, not two");
        assert_eq!(gh[0].epic, "#78");
        let unstartable = count("reconcile_unstartable");
        assert_eq!(
            unstartable.len(),
            1,
            "epic #79 gets ONE unstartable row, not two"
        );
        assert_eq!(unstartable[0].epic, "#79");
    }

    #[tokio::test]
    async fn test_gh_auth_loss_refines_the_interrupted_alert() {
        // An epic parked for gh_auth_lost keeps its ACTIVE config and gets no
        // resume timer, so it lands here — and a manual resume would fail the
        // launcher's preflight until `gh` is healthy, which the row says.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-ghauth";
        let repo = tempdir().unwrap();
        write_handoff(repo.path(), "#37", 2);
        save_config(&h, project, "#37", repo.path());

        reconcile_gated(
            h.run_configs.clone(),
            Vec::new(),
            h.supervisor.clone(),
            h.audit.clone(),
            ages(None),
            alive(false),
            Some(auth(Ok(false))),
            TEST_RETRY,
        )
        .await;

        let rows = rows(&h.audit, project).await;
        let alert = rows
            .iter()
            .find(|r| r.details["kind"] == "reconcile_gh_auth")
            .expect("gh-auth ALERT must land");
        assert_eq!(alert.event, AuditEventKind::Alert);
        assert_eq!(alert.epic, "#37");
        assert_eq!(alert.details["epic"], "#37");
        assert_eq!(alert.generation, 0);
        assert!(alert.details["message"]
            .as_str()
            .unwrap()
            .contains("resume it manually"));
        assert!(
            interrupted(&h.audit, project).await.is_empty(),
            "the gh-auth row REPLACES the plain interrupted row"
        );

        // A transient probe failure is a data gap, not an auth loss (the auth
        // watcher's policy): the plain interrupted alert stands.
        let dir2 = tempdir().unwrap();
        let h2 = harness(dir2.path());
        let project2 = "C:/git/proj-recon-ghgap";
        let repo2 = tempdir().unwrap();
        write_handoff(repo2.path(), "#37", 2);
        save_config(&h2, project2, "#37", repo2.path());
        reconcile_gated(
            h2.run_configs.clone(),
            Vec::new(),
            h2.supervisor.clone(),
            h2.audit.clone(),
            ages(None),
            alive(false),
            Some(auth(Err("gh not found"))),
            TEST_RETRY,
        )
        .await;
        let alerts = interrupted(&h2.audit, project2).await;
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].details["prior_generation"], 2);
    }

    #[tokio::test]
    async fn test_transcript_probe_runs_on_the_blocking_pool() {
        // The probe walks the encoded Claude project dir with a metadata()
        // syscall per .jsonl — this crate's rule for that FS work is "never
        // inline on the runtime" (the sibling process scan already obeys it).
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let repo = tempdir().unwrap();
        write_handoff(repo.path(), "#37", 1);
        save_config(&h, "C:/git/proj-recon-blocking", "#37", repo.path());

        let probe_thread: Arc<Mutex<Option<std::thread::ThreadId>>> = Arc::new(Mutex::new(None));
        let probe_thread_rec = probe_thread.clone();
        let probe: TranscriptAgeProbe = Arc::new(move |_| {
            *probe_thread_rec.lock().unwrap() = Some(std::thread::current().id());
            None
        });
        reconcile(
            h.run_configs.clone(),
            Vec::new(),
            h.supervisor.clone(),
            h.audit.clone(),
            probe,
            alive(false),
        )
        .await;

        let probed = probe_thread.lock().unwrap().expect("the probe must run");
        assert_ne!(
            probed,
            std::thread::current().id(),
            "the transcript probe must run on the blocking pool, not the task's thread"
        );
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
    async fn test_audit_rows_alone_are_generation_evidence() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-auditgen";
        let repo = tempdir().unwrap(); // no handoff files at all
        save_config(&h, project, "#37", repo.path());
        // The only generation evidence: audit rows from before the restart.
        h.audit
            .append(project, audit_row("#37", AuditEventKind::Spawn, 4));

        run(&h, Vec::new(), None, false).await;

        let alerts = interrupted(&h.audit, project).await;
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].details["prior_generation"], 4);
    }

    #[tokio::test]
    async fn test_completed_config_is_skipped_entirely() {
        // Issue #96: a verified-complete run keeps its config on disk as
        // COMPLETED until the human's cleanup archives it. Reconciliation
        // must not touch it — not even an alert.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-completed";
        let repo = tempdir().unwrap();
        write_handoff(repo.path(), "#37", 2);
        save_config(&h, project, "#37", repo.path());
        h.run_configs.complete(project, "#37").unwrap();

        run(&h, Vec::new(), None, false).await;

        assert!(
            rows(&h.audit, project).await.is_empty(),
            "no trail at all for a completed run"
        );
    }

    #[tokio::test]
    async fn test_unstartable_config_alerts_instead_of_guessing() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-unstartable";
        let repo = tempdir().unwrap(); // no handoffs, no audit, no registry
        save_config(&h, project, "#37", repo.path());

        run(&h, Vec::new(), None, false).await;

        let rows = rows(&h.audit, project).await;
        let alert = rows
            .iter()
            .find(|r| r.details["kind"] == "reconcile_unstartable")
            .expect("unstartable ALERT must land");
        assert_eq!(alert.event, AuditEventKind::Alert);
        assert_eq!(alert.details["epic"], "#37");
        assert_eq!(alert.generation, 0);
        assert!(!rows.iter().any(|r| r.event == AuditEventKind::Resume));
    }

    #[tokio::test]
    async fn test_an_unreadable_config_alerts_instead_of_vanishing() {
        // The blind spot: a torn or locked record was dropped inside
        // `load_all` with a log line, so the ONLY run on disk disappeared
        // from the scan and the launch reported "nothing to reconcile" while
        // an interrupted run sat there unowned and unmentioned.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-recon-unreadable";
        let repo = tempdir().unwrap();
        write_handoff(repo.path(), "#38", 2);
        save_config(&h, project, "#38", repo.path());
        let torn = tear_the_only_config(&dir.path().join("runs"));

        run(&h, Vec::new(), None, false).await;

        let alerts = unreadable(&h.audit).await;
        assert_eq!(alerts.len(), 1, "the unreadable record must be reported");
        assert_eq!(alerts[0].event, AuditEventKind::Alert);
        assert_eq!(alerts[0].epic, ACCOUNT_RUN);
        assert_eq!(alerts[0].generation, 0);
        assert_eq!(alerts[0].session_id, 0);
        assert_eq!(
            alerts[0].details["path"].as_str().unwrap(),
            torn.to_string_lossy(),
            "the row names the file a human has to go and look at"
        );
        assert!(
            alerts[0].details["error"]
                .as_str()
                .unwrap()
                .contains("parse failed"),
            "the row carries the reason: {:?}",
            alerts[0].details["error"],
        );
        // Nothing may be claimed about the run itself — its status, its
        // generation and even its epic are what could not be read.
        assert!(
            interrupted(&h.audit, project).await.is_empty(),
            "an unreadable record is not evidence of an interruption"
        );

        // Latched in memory for the app run: a second pass over the same
        // file says nothing more (`UNREADABLE_ALERTED`).
        run(&h, Vec::new(), None, false).await;
        assert_eq!(
            unreadable(&h.audit).await.len(),
            1,
            "the alert must not repeat within one app run"
        );
    }

    #[tokio::test]
    async fn test_a_torn_config_does_not_take_down_its_healthy_neighbour() {
        // One torn file must cost exactly itself: the readable ACTIVE run
        // beside it still reaches its own verdict in the same pass.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let healthy = "C:/git/proj-recon-healthy";
        let repo = tempdir().unwrap();
        write_handoff(repo.path(), "#41", 3);
        save_config(&h, healthy, "#41", repo.path());

        // A second project whose only record is torn.
        let broken_dir = dir.path().join("runs").join("proj-recon-torn-0123456789ab");
        std::fs::create_dir_all(&broken_dir).unwrap();
        let torn = broken_dir.join("epic-99.json");
        std::fs::write(&torn, "not json at all").unwrap();

        run(&h, Vec::new(), None, false).await;

        let alerts = unreadable(&h.audit).await;
        assert_eq!(alerts.len(), 1);
        assert_eq!(
            alerts[0].details["path"].as_str().unwrap(),
            torn.to_string_lossy()
        );
        let healthy_alerts = interrupted(&h.audit, healthy).await;
        assert_eq!(
            healthy_alerts.len(),
            1,
            "the readable run must still be reconciled"
        );
        assert_eq!(healthy_alerts[0].details["prior_generation"], 3);
    }
}
