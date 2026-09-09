//! Samurai resume handler (Phase 3, issue #61; PRD §5.5, §5.6, §7).
//!
//! The consumer of `samurai_schedule`'s fire callback — the piece that turns
//! a due park timer into a FRESH generation spawn (PRD decision #6: every
//! wake-up is a fresh spawn from the handoff file, never `claude --resume`):
//!
//! - **Run gate first (review F2 — the #96 regression, timer edition):** a
//!   resume timer can outlive its run: completion verification can flip the
//!   config ACTIVE → COMPLETED (or the manual cleanup can archive it)
//!   between park and fire. Only an ACTIVE run config may spawn a successor
//!   — a COMPLETED/ARCHIVED/missing config drops the timer (the fired entry
//!   self-cleans) with an `ALERT (resume_run_not_active)` audit note
//!   instead of spawning into a finished worktree, mirroring the guarantee
//!   cold-start reconciliation gets from `RunConfigStore::load_active`.
//! - **Restored timers resume too (issue #207):** a timer that was already
//!   in `schedule.json` when the app started takes the SAME path as one
//!   armed this session — the run config gate, the guard rails, then the
//!   spawn — and its `RESUME` row carries `restored: true`. It used to
//!   alert `resume_interrupted_restart` and die, which turned every
//!   allowance park that outlived an app restart (the window is 5 h, so
//!   nearly all of them) into a manual chore: the fired entry self-cleaned
//!   even though the callback only alerted, and the next launch's
//!   reconciler — which had been deferring to the timer — downgraded the run
//!   to "resume it manually". The restart was DISABLING the resume, not
//!   requiring it. The restart flag now only decides which ALERT an
//!   unrecoverable run gets: see [`SamuraiResumer::mark_restored`].
//! - **Guard rails next:** while a hard park sweep is still engaged, or a
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
//! - **Working dir:** the run config's `worktree_path` (PRD §5.8) — the
//!   gate above guarantees the config exists, so nothing is ever resolved
//!   from session directories and no path is ever invented.
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

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use chrono::Utc;
use serde_json::json;

use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_auth_watch::GH_AUTH_RESTORED;
use super::samurai_injector::strip_extended_prefix;
use super::samurai_parker::SamuraiParker;
use super::samurai_prompts::{epic_slug, parse_handoff_generation};
use super::samurai_replicator::SamuraiReplicator;
use super::samurai_run_config::{ConfigLookup, RunConfigStatus, RunConfigStore, SamuraiRunConfig};
use super::samurai_schedule::{SamuraiSchedule, ScheduleEntry};
use super::supervisor::{SessionSnapshot, Supervisor};
use crate::commands::samurai::TRIGGER_MANUAL_RESUME;

/// How far a deferred resume is pushed out (module doc: parking engaged or a
/// live orchestrator already exists). 10 minutes: long enough for a park
/// sweep to finish or a live epic to keep working undisturbed, short enough
/// that a resume blocked by a transient state lands the same hour.
const DEFER_DELAY_SECS: i64 = 600;

/// The timer reason the parker arms (`samurai_parker`) for an allowance
/// park, and the `trigger` its fire records.
const REASON_PARK: &str = "park";
const TRIGGER_PARK: &str = "resume_timer";

/// The `trigger` a fired timer records, or `None` when this resumer does not
/// handle that reason (a scheduled launch, or a reason from a newer build).
/// Issue #208 added the second arm: the parker arms a
/// [`GH_AUTH_RESTORED`] entry the moment `gh auth` comes back, for the runs
/// its external park stopped — the same fire path as a park timer, so the
/// ACTIVE-run gate, the restored-timer gate and the defer guards all apply,
/// and only the recorded trigger differs.
fn trigger_for_reason(reason: &str) -> Option<&'static str> {
    match reason {
        REASON_PARK => Some(TRIGGER_PARK),
        GH_AUTH_RESTORED => Some(GH_AUTH_RESTORED),
        _ => None,
    }
}

/// The park reason behind a resume `trigger` — the inverse of
/// [`trigger_for_reason`], for [`SamuraiResumer::on_spawn_dropped`], which
/// sees only the trigger the spawn was staged with and has to rebuild the
/// schedule entry from it. Every resume trigger belongs here, not just the
/// allowance park's: a dropped `gh_auth_restored` resume (issue #208) must
/// re-arm exactly like a dropped park one, or it ends as a bare ALERT with
/// no timer — the failure #207 exists to remove.
fn reason_for_trigger(trigger: &str) -> Option<&'static str> {
    match trigger {
        TRIGGER_PARK => Some(REASON_PARK),
        GH_AUTH_RESTORED => Some(GH_AUTH_RESTORED),
        // Issue #211: a RESUME NOW is a human ending a park early, and its
        // spawn can be dropped exactly like a timer's (the project tab is
        // closed). Without an arm here that click simply vanished — the
        // failure #207 exists to remove, one surface further along. It
        // re-arms as an ordinary park timer, which is what the run was
        // before the click.
        TRIGGER_MANUAL_RESUME => Some(REASON_PARK),
        _ => None,
    }
}

/// "A pre-restart orchestrator is PROBABLY still alive in this worktree":
/// `Some(transcript_age_secs)`, for the worktree path handed in. Injected
/// (issue #207) so the restored path gets the same survivor check every
/// other startup spawn goes through — `lib.rs` composes it from the
/// reconciler's `orphan_verdict` over the watchdog's two real probes, and
/// tests supply a closure. Unset = no check (the pre-#207 behaviour, which
/// every same-process fire keeps).
pub type OrphanProbe = Arc<dyn Fn(&str) -> Option<u64> + Send + Sync>;

/// `details.kind` of the ALERT a timer RESTORED FROM DISK lands when its run
/// is UNRECOVERABLE — the only case left after issue #207 (see
/// [`SamuraiResumer::mark_restored`]).
pub const RESUME_INTERRUPTED_KIND: &str = "resume_interrupted_restart";

/// `details.kind` of the ALERT a RESTORED resume lands when the worktree
/// still looks owned by a claude that predates this launch (issue #207,
/// finding 3): the resume defers instead of putting a second orchestrator
/// in one worktree.
pub const RESUME_ORPHAN_KIND: &str = "resume_orphan";

/// The replicator's give-up ALERT kind, rate-limited here so a resume that
/// keeps being dropped (a project the user left closed) does not alert once
/// per lap — see [`ALERT_EVERY_LAPS`].
const SPAWN_DROPPED_KIND: &str = "spawn_dropped";

/// How many laps of the same repeating condition pass between ALERTs: the
/// first one is always reported, then every Nth after it.
///
/// Review 2, finding 5: the drop→defer→re-emit→drop cycle is deliberately
/// UNBOUNDED — a project the user has closed must still resume the moment
/// they open it, hours later, and capping the re-arms would put the run
/// back in the manual-chore state #207 removes. What must not be unbounded
/// is the SILENCE: latching the ALERT forever would hide a run cycling every
/// ~25 minutes behind nothing but `resume_deferred` rows. Six laps is a
/// couple of hours of quiet — long enough that a normal "opened the project
/// after lunch" recovery says it once, short enough that a genuinely stuck
/// run resurfaces the same day. The counter resets when the run resumes.
const ALERT_EVERY_LAPS: u32 = 6;

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

/// Whether this run already carries the restart ALERT's latch (#185/#196's
/// `interrupted_at` stamp, the reconciler's `already_reported` shape). Kind
/// only, no generation: an unrecoverable restored timer says nothing about a
/// generation — the run either has a config to resume or it does not — and
/// the next launch's reconciler clears the stamp as soon as the run has an
/// owner again, so a run that recovers can alert again later.
fn restart_alert_latched(config: &SamuraiRunConfig) -> bool {
    config
        .interrupted_at
        .as_ref()
        .is_some_and(|stamp| stamp.kind == RESUME_INTERRUPTED_KIND)
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
/// A candidate must reconstruct EXACTLY as `<slug>-gen<N>.md` — or, issue
/// #119's tolerated dash variant, `<slug>-gen-<N>.md` — which excludes
/// recovery digests (`…-recovery.md`) and other epics whose slug merely
/// shares a prefix. A missing/unreadable directory is `None`.
/// `pub(crate)`: cold-start reconciliation (issue #62) derives generations
/// with the same scan.
pub(crate) fn latest_handoff_generation(handoffs_dir: &Path, epic: &str) -> Option<u32> {
    scan_handoff_generation(handoffs_dir, epic).unwrap_or(None)
}

/// [`latest_handoff_generation`] with "the directory could not be read" kept
/// distinct from "no handoff matches". A missing directory is `Ok(None)` — a
/// worktree legitimately has none — but any other io error is an `Err`, so
/// the resume path can defer instead of concluding the run has nothing to
/// resume from and destroying its timer.
pub(crate) fn scan_handoff_generation(
    handoffs_dir: &Path,
    epic: &str,
) -> Result<Option<u32>, std::io::Error> {
    let prefix = format!("{}-gen", epic_slug(epic));
    let read_dir = match std::fs::read_dir(handoffs_dir) {
        Ok(read_dir) => read_dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(read_dir
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let generation = parse_handoff_generation(&name)?;
            (name == format!("{prefix}{generation}.md")
                || name == format!("{prefix}-{generation}.md"))
            .then_some(generation)
        })
        .max())
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
    /// Late-bound (module doc: circular construction order). Unset only
    /// before setup finishes — a fire that early is dropped with an error.
    schedule: OnceLock<Arc<SamuraiSchedule>>,
    parker: OnceLock<Arc<SamuraiParker>>,
    /// `(project, epic)` of the runs whose timers `schedule.json` held at
    /// startup — see [`Self::mark_restored`]. Unset in tests that never call
    /// it, which reads as "every timer was armed this session".
    ///
    /// Keyed WITHOUT `fire_at` (review finding 2): restoredness is a
    /// property of the RUN for this app run, not of one countdown. A
    /// deferral re-arms with a fresh `fire_at`, so a fire_at-keyed set lost
    /// the flag the first time a restored resume deferred — the eventual
    /// RESUME row then said `restored: false` and an unrecoverable run got
    /// the unlatched same-process note instead of the latched restart one.
    restored: Mutex<HashSet<(String, String)>>,
    /// Issue #207: the survivor check a restored resume runs before
    /// spawning. Unset = no check (see [`OrphanProbe`]).
    orphan_probe: OnceLock<OrphanProbe>,
    /// How many times each repeating condition has come round without the
    /// run resuming: `(project, epic, kind)` → laps. Drives the
    /// [`ALERT_EVERY_LAPS`] rate limit for the two repeatable restored-path
    /// alerts (a suspected orphan, a spawn the frontend never took), and is
    /// CLEARED for the run the moment it actually resumes — a fresh park
    /// hours later is a new condition and gets its own first alert (review
    /// 2, finding 2). The unrecoverable-run alert latches on disk instead,
    /// where it has to survive a restart.
    laps: Mutex<HashMap<(String, String, &'static str), u32>>,
}

impl SamuraiResumer {
    pub fn new(
        supervisor: Arc<Supervisor>,
        replicator: Arc<SamuraiReplicator>,
        run_configs: Arc<RunConfigStore>,
        audit: AuditLog,
    ) -> Arc<Self> {
        Arc::new(Self {
            supervisor,
            replicator,
            run_configs,
            audit,
            schedule: OnceLock::new(),
            parker: OnceLock::new(),
            restored: Mutex::new(HashSet::new()),
            orphan_probe: OnceLock::new(),
            laps: Mutex::new(HashMap::new()),
        })
    }

    /// Records the timers `schedule.json` already held when the app started,
    /// so [`on_fire`](Self::on_fire) can tell them apart from the ones this
    /// session armed.
    ///
    /// **A restored timer resumes (issue #207).** A park timer is persisted,
    /// and the schedule's first tick fires every entry whose `fire_at`
    /// passed during downtime — that is the feature, not a hazard: the run
    /// asked to be resumed at that time and the app simply was not running
    /// then. The flag is still recorded because it changes what an
    /// UNRECOVERABLE run gets told: a restored timer whose run config is
    /// gone/finished, or whose worktree names no generation to resume from,
    /// lands one latched `ALERT (resume_interrupted_restart)`
    /// ([`Self::alert_interrupted_restart`]) instead of the same-process
    /// `resume_run_not_active` / `resume_no_handoff` notes, because a
    /// restart is the reason a human is being asked to step in. Timers armed
    /// DURING this session (a park, a deferral re-arm) are not in this set:
    /// `arm` always writes a fresh `fire_at`.
    ///
    /// Called from the setup closure with the same pre-fire-loop snapshot
    /// cold-start reconciliation gets, and before the fire loop is spawned.
    pub fn mark_restored(&self, entries: &[ScheduleEntry]) {
        *self.restored.lock().unwrap_or_else(PoisonError::into_inner) = entries
            .iter()
            .map(|e| (e.project_path.clone(), e.epic.clone()))
            .collect();
    }

    /// Whether this run's timer was already on disk when the app started —
    /// including after a deferral re-armed it under a new `fire_at`.
    fn is_restored(&self, project: &str, epic: &str) -> bool {
        self.restored
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&(project.to_string(), epic.to_string()))
    }

    /// Late-binds the survivor check (issue #207), the `bind` pattern.
    pub fn set_orphan_probe(&self, probe: OrphanProbe) {
        let _ = self.orphan_probe.set(probe);
    }

    /// Counts one lap of `kind` for the run and says whether it should be
    /// reported: the first lap always, then every [`ALERT_EVERY_LAPS`]-th.
    fn should_report(&self, project: &str, epic: &str, kind: &'static str) -> bool {
        let mut laps = self.laps.lock().unwrap_or_else(PoisonError::into_inner);
        let lap = laps
            .entry((project.to_string(), epic.to_string(), kind))
            .or_insert(0);
        *lap += 1;
        (*lap - 1).is_multiple_of(ALERT_EVERY_LAPS)
    }

    /// Forgets every repeating condition recorded for the run, and its
    /// restored mark. Called when the run actually resumes (review 2,
    /// findings 2 and 4): the run is owned again, so a LATER drop or park —
    /// a genuinely new condition, possibly hours later — reports itself
    /// from scratch, and a timer this session arms is a same-process timer
    /// like any other. A deferral is deliberately NOT a resume: the flag
    /// must survive the defer re-arm (round 1, finding 2).
    fn on_resumed(&self, project: &str, epic: &str) {
        self.laps
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|(p, e, _), _| p != project || e != epic);
        self.restored
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&(project.to_string(), epic.to_string()));
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
    pub fn on_fire(self: &Arc<Self>, entry: ScheduleEntry) {
        let Some(trigger) = trigger_for_reason(&entry.reason) else {
            log::warn!(
                "samurai resumer: timer for epic {} has unknown reason {:?} — ignored",
                entry.epic,
                entry.reason,
            );
            return;
        };
        let (Some(schedule), Some(parker)) = (self.schedule.get(), self.parker.get()) else {
            // Cannot happen after setup; the timer survives on disk until
            // its self-clean, and cold-start reconciliation (P3.4) backstops.
            log::error!(
                "samurai resumer: timer for epic {} fired before bind() — dropped",
                entry.epic,
            );
            return;
        };

        // Issue #207: whether this exact timer was already on disk when the
        // app started. It no longer decides WHETHER to resume — only which
        // ALERT an unrecoverable run gets, and how the RESUME row reads.
        let restored = self.is_restored(&entry.project_path, &entry.epic);

        // Review F2 (the #96 regression, timer edition): a resume timer can
        // outlive its run — completion verification can flip the config
        // COMPLETED, or the manual cleanup can archive/remove it, between
        // park and fire. Anything but an ACTIVE config drops the timer (the
        // fired entry self-cleans, nothing re-arms) with an audit note
        // instead of spawning a successor into a finished worktree.
        // An UNREADABLE config is not evidence the run ended: a torn or
        // locked file used to read exactly like a missing one, so the timer
        // was dropped ("status": "MISSING") and a live parked run never
        // resumed. Defer instead — the next tick re-reads the file.
        let config = match self.run_configs.lookup(&entry.project_path, &entry.epic) {
            ConfigLookup::Found(config) => Some(*config),
            ConfigLookup::Missing => None,
            ConfigLookup::Unreadable(e) => {
                log::warn!(
                    "samurai resumer: timer for epic {} in {} fired but its run config could not be read ({e}) — deferring, not dropping",
                    entry.epic,
                    entry.project_path,
                );
                self.append_alert(
                    &entry,
                    json!({
                        "kind": "resume_config_unreadable",
                        "epic": entry.epic,
                        "error": e,
                    }),
                );
                self.defer(schedule, &entry);
                return;
            }
        };
        let status = config.as_ref().map(|c| c.status);
        // Read BEFORE the filter moves the config: the latch that keeps a
        // permanently unrecoverable run from alerting once per app launch.
        let already_alerted = config.as_ref().is_some_and(restart_alert_latched);
        let Some(config) = config.filter(|c| c.status == RunConfigStatus::Active) else {
            let status_value = match status {
                Some(s) => serde_json::to_value(s).unwrap_or_else(|_| json!("UNKNOWN")),
                None => json!("MISSING"),
            };
            // Issue #208: an auth-restore resume that finds its run finished
            // is not news. The parker skips exactly this run SILENTLY when
            // it arms the release; a run archived during the stagger's own
            // few seconds is the same run a moment later, and an ALERT there
            // would ask a human to look at a run they themselves ended.
            // A park timer keeps its ALERT: that one waited out a whole
            // allowance window, so a status change is worth the note.
            if entry.reason == GH_AUTH_RESTORED {
                log::info!(
                    "samurai resumer: {GH_AUTH_RESTORED} resume for epic {} in {} found its run {status_value} — dropped silently",
                    entry.epic,
                    entry.project_path,
                );
                return;
            }
            // Issue #207: a run whose config is finished, archived or gone
            // cannot be resumed by anyone but a human, and for a RESTORED
            // timer the restart is the story worth telling — one latched
            // `resume_interrupted_restart` instead of the same-process note.
            if restored {
                self.alert_interrupted_restart(
                    &entry,
                    already_alerted,
                    "run_not_active",
                    Some(status_value),
                );
                return;
            }
            log::warn!(
                "samurai resumer: timer for epic {} in {} fired but its run config is {status_value} — timer dropped, no successor spawned",
                entry.epic,
                entry.project_path,
            );
            self.append_alert(
                &entry,
                json!({
                    "kind": "resume_run_not_active",
                    "epic": entry.epic,
                    "status": status_value,
                }),
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

        // Always `\\?\`-stripped (fork convention); the gate above
        // guarantees the config exists, so no path is ever invented.
        let working_dir = strip_extended_prefix(&config.worktree_path);

        // Review finding 3: a RESTORED resume is the one spawn path with no
        // startup survivor check. The reconciler defers to any pending timer
        // (`SkipTimer`) and never reaches its own orphan arm, while the
        // guards above read a session registry that is EMPTY right after a
        // restart — so a claude that outlived the app could be joined by a
        // second orchestrator in the same worktree. Ask the reconciler's
        // question through the injected probe instead: a false defer costs
        // one interval, a false spawn costs the worktree.
        //
        // Off this thread (review 2, finding 1): the probe refreshes the
        // whole process table with command lines, and `on_fire` runs
        // straight from the schedule's `tokio::interval` loop — the
        // reconciler runs the identical probe under `spawn_blocking`
        // (`samurai_reconciler`), and so does this. The rest of the fire
        // resumes on that task. Only a restored fire with a probe bound
        // takes this hop; every same-process fire stays synchronous.
        if restored {
            if let Some(probe) = self.orphan_probe.get().cloned() {
                let this = self.clone();
                let dir = working_dir.clone();
                let probe_dir = working_dir.clone();
                tokio::spawn(async move {
                    let verdict = tokio::task::spawn_blocking(move || probe(&probe_dir))
                        .await
                        .unwrap_or_else(|e| {
                            log::warn!("samurai resumer: the survivor probe panicked ({e}) — treated as no survivor");
                            None
                        });
                    this.after_survivor_check(entry, dir, trigger, verdict);
                });
                return;
            }
        }

        self.resume_now(&entry, &working_dir, trigger, restored, already_alerted);
    }

    /// The second half of a RESTORED fire, once the survivor probe answered
    /// (see [`Self::on_fire`]). A probable survivor defers — putting a
    /// second orchestrator in one worktree is the one outcome worth a lost
    /// interval — otherwise the resume proceeds exactly as a same-process
    /// one does.
    fn after_survivor_check(
        self: &Arc<Self>,
        entry: ScheduleEntry,
        working_dir: String,
        trigger: &'static str,
        verdict: Option<u64>,
    ) {
        let Some(schedule) = self.schedule.get() else {
            return;
        };
        if let Some(age_secs) = verdict {
            log::warn!(
                "samurai resumer: epic {} in {working_dir} — transcript written {age_secs}s ago and a claude process is alive: a pre-restart orchestrator probably survived, deferring instead of spawning",
                entry.epic,
            );
            if self.should_report(&entry.project_path, &entry.epic, RESUME_ORPHAN_KIND) {
                self.append_alert(
                    &entry,
                    json!({
                        "kind": RESUME_ORPHAN_KIND,
                        "epic": entry.epic,
                        "transcript_age_secs": age_secs,
                    }),
                );
            }
            self.defer(schedule, &entry);
            return;
        }
        // The config was ACTIVE when the fire started and the run has no
        // live session; re-reading it here would only widen the window.
        let already_alerted = self
            .run_configs
            .get(&entry.project_path, &entry.epic)
            .is_some_and(|c| restart_alert_latched(&c));
        self.resume_now(&entry, &working_dir, trigger, true, already_alerted);
    }

    /// Everything after the gates: pick the next generation, record the
    /// `RESUME` row, and stage the spawn. Split out of [`Self::on_fire`] so
    /// the restored path can reach it from the survivor probe's task.
    fn resume_now(
        &self,
        entry: &ScheduleEntry,
        working_dir: &str,
        trigger: &'static str,
        restored: bool,
        already_alerted: bool,
    ) {
        let Some(schedule) = self.schedule.get() else {
            return;
        };
        let sessions = self.supervisor.list_sessions();
        let registry_max = sessions
            .iter()
            .filter(|s| s.project == entry.project_path && s.epic == entry.epic)
            .map(|s| s.generation)
            .max();
        // An unreadable handoffs directory is NOT "this run has no handoff":
        // with an empty registry — the normal state right after a park and
        // teardown — that conflation sent the timer down the terminal
        // `resume_no_handoff` branch, which never re-arms, destroying the
        // timer of a run whose handoff files were sitting on disk.
        let files_max = match scan_handoff_generation(
            &Path::new(&working_dir).join(".maestro").join("handoffs"),
            &entry.epic,
        ) {
            Ok(files_max) => files_max,
            Err(e) => {
                log::warn!(
                    "samurai resumer: handoffs directory for epic {} in {working_dir} could not be read ({e}) — deferring, not dropping",
                    entry.epic,
                );
                self.append_alert(
                    entry,
                    json!({
                        "kind": "resume_handoffs_unreadable",
                        "epic": entry.epic,
                        "error": e.to_string(),
                    }),
                );
                self.defer(schedule, entry);
                return;
            }
        };
        let Some((prior, generation)) = next_generation(registry_max, files_max) else {
            // Issue #207: nothing on disk names a generation, so a restored
            // timer's run really is unrecoverable — the second and last case
            // that still ALERTs about the restart, latched like the first.
            if restored {
                self.alert_interrupted_restart(entry, already_alerted, "no_handoff", None);
                return;
            }
            log::error!(
                "samurai resumer: epic {} in {working_dir} has no handoff files and no registry generations — nothing to resume from, ALERT",
                entry.epic,
            );
            self.append_alert(
                entry,
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
        // the trail always explains the SPAWN row that follows. `fire_at`
        // doubles as the timer id — the schedule keys entries by (project,
        // epic, fire_at) — and `predecessor_generation` names what gen-N+1
        // resumes from (issue #101).
        self.audit.append(
            &entry.project_path,
            AuditEvent::now(
                entry.epic.clone(),
                AuditEventKind::Resume,
                generation,
                // 0 sentinel: the successor session does not exist yet.
                0,
                json!({
                    "trigger": trigger,
                    "fire_at": entry.fire_at,
                    "predecessor_generation": prior,
                    // Issue #207: a resume the app restart used to kill.
                    "restored": restored,
                }),
            ),
        );
        // The run is owned again: forget the repeating conditions and the
        // restored mark (review 2, findings 2 and 4).
        self.on_resumed(&entry.project_path, &entry.epic);
        self.replicator.spawn_generation(
            &entry.project_path,
            &entry.epic,
            working_dir,
            generation,
            Some(prior),
            trigger,
        );
    }

    /// The replicator's `spawn_dropped` veto (issue #207, review finding 1).
    ///
    /// A resume spawn the frontend never took — the user has the project
    /// closed — used to end as an ALERT with NO timer left on disk: exactly
    /// the manual chore this issue exists to remove, just 15 minutes later
    /// than the old restored gate produced it. The schedule entry is
    /// re-armed [`DEFER_DELAY_SECS`] out instead, so the resume keeps
    /// offering itself until a tab for the project is open.
    ///
    /// Returns whether the replicator should SKIP its own ALERT: the first
    /// drop per (project, epic) this app run keeps it (it is the accurate
    /// description of what happened), every later one is suppressed — the
    /// run is not stuck, it is waiting on a re-armed timer, and one ALERT
    /// per interval would be noise. Only `resume_timer` spawns are claimed;
    /// a gen-1 launch's drop is not this module's business.
    pub fn on_spawn_dropped(
        &self,
        project: &str,
        epic: &str,
        generation: u32,
        trigger: &str,
    ) -> bool {
        let Some(reason) = reason_for_trigger(trigger) else {
            return false;
        };
        let Some(schedule) = self.schedule.get() else {
            return false;
        };
        log::warn!(
            "samurai resumer: the gen-{generation} resume spawn for epic {epic} in {project} was never taken (no project tab open?) — re-arming the resume timer instead of dropping the run",
        );
        self.defer(
            schedule,
            &ScheduleEntry {
                project_path: project.to_string(),
                epic: epic.to_string(),
                // `defer` writes the real one; the fired entry's own
                // fire_at self-cleaned when it fired.
                fire_at: String::new(),
                reason: reason.to_string(),
                launch: None,
                held: false,
            },
        );
        !self.should_report(project, epic, SPAWN_DROPPED_KIND)
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

    /// The one ALERT a RESTORED timer can still land (issue #207): the run
    /// is unrecoverable without a human — its run config is finished,
    /// archived or gone, or nothing on disk names a generation to resume
    /// from. LATCHED on the run config's `interrupted_at` stamp
    /// (#185/#196), so a run that stays unrecoverable says it once instead
    /// of once per app launch; the reconciler drops that stamp the moment
    /// the run has an owner again. A config that cannot be stamped (the
    /// MISSING case) costs at most a repeat — the fired entry self-cleans,
    /// so nothing re-fires it in this app run anyway.
    fn alert_interrupted_restart(
        &self,
        entry: &ScheduleEntry,
        already_alerted: bool,
        reason: &str,
        status: Option<serde_json::Value>,
    ) {
        if already_alerted {
            log::info!(
                "samurai resumer: run {} in {} is still unrecoverable after the restart ({reason}) — already alerted, not repeating the row",
                entry.epic,
                entry.project_path,
            );
            return;
        }
        log::warn!(
            "samurai resumer: run {} in {} had a resume timer ({}) from before this app launch and cannot be resumed ({reason}) — resume it manually",
            entry.epic,
            entry.project_path,
            entry.fire_at,
        );
        let mut details = json!({
            "kind": RESUME_INTERRUPTED_KIND,
            "epic": entry.epic,
            "fire_at": entry.fire_at,
            "reason": reason,
            "message": format!("run {} was interrupted — resume it manually", entry.epic),
        });
        if let Some(status) = status {
            details["status"] = status;
        }
        self.append_alert(entry, details);
        // Generation 0: this alert is about the run being unresumable at
        // all, not about a generation (see `restart_alert_latched`).
        if let Err(e) = self.run_configs.mark_interrupted(
            &entry.project_path,
            &entry.epic,
            0,
            RESUME_INTERRUPTED_KIND,
        ) {
            log::warn!(
                "samurai resumer: could not latch the {RESUME_INTERRUPTED_KIND} alert for {} in {}: {e} — it may repeat",
                entry.epic,
                entry.project_path,
            );
        }
    }

    /// Epic-level ALERT row (generation/session 0, like the parker's
    /// `park_no_reset_time`). Deliberately NOT re-armed: every alert path
    /// here either needs a human (`resume_no_handoff`,
    /// `resume_interrupted_restart`) or documents a stale timer for a run
    /// that is over (`resume_run_not_active`) — a rearmed timer would alert
    /// again forever. Everything RECOVERABLE defers instead (see
    /// [`Self::defer`]), which re-arms and leaves the entry on disk.
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
    use crate::core::allowance_watcher::{AllowanceEvent, AllowanceWindow, ThresholdKind};
    use crate::core::claude_event::ClaudeEvent;
    use crate::core::samurai_config::{SamuraiConfig, SharedSamuraiConfig};
    use crate::core::samurai_context::SamuraiContextStore;
    use crate::core::samurai_injector::SamuraiInjector;
    use crate::core::samurai_injector::SessionDirResolver;
    use crate::core::samurai_replicator::{
        EnterResender, SessionTeardown, StdinWriter, SuccessorEmitter, SuccessorSpawn,
        TranscriptPathResolver,
    };
    use crate::core::samurai_run_config::SamuraiRunConfig;
    use crate::core::samurai_schedule::jitter_secs;
    use crate::core::samurai_test_wait::{
        new_tick, tick_on_append, wait_for_row, wait_for_rows, wait_until, HarnessTick,
    };
    use crate::core::supervisor::SupervisorState;
    use crate::core::windows_process::StdCommandExt;
    use chrono::{DateTime, Duration as ChronoDuration};
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

    #[test]
    fn test_latest_handoff_generation_accepts_the_gen_dash_variant() {
        // #119 tolerant discovery: a deviating orchestrator spelled the
        // generation `-gen-<N>` — accept that variant inside the canonical
        // directory so a relaunch still finds the run's state.
        let dir = tempdir().unwrap();
        let handoffs = dir.path().join(".maestro").join("handoffs");
        std::fs::create_dir_all(&handoffs).unwrap();
        for name in ["37-gen1.md", "37-gen-4.md", "37-gen-x.md"] {
            std::fs::write(handoffs.join(name), "x").unwrap();
        }
        assert_eq!(latest_handoff_generation(&handoffs, "#37"), Some(4));
    }

    // --- integration (real supervisor + replicator + schedule + parker) ---

    struct Harness {
        resumer: Arc<SamuraiResumer>,
        supervisor: Arc<Supervisor>,
        replicator: Arc<SamuraiReplicator>,
        run_configs: Arc<RunConfigStore>,
        schedule: Arc<SamuraiSchedule>,
        audit: AuditLog,
        spawns: Arc<Mutex<Vec<SuccessorSpawn>>>,
        /// The park half of the seam test: the injector delivers the park
        /// ladder, the context store orders the sweep, the parker arms the
        /// timer this module's resumer then fires.
        injector: Arc<SamuraiInjector>,
        context: Arc<SamuraiContextStore>,
        parker: Arc<SamuraiParker>,
        /// session id → working dir, for the park validation's file+WIP
        /// checks. Empty for every test that never registers one, which is
        /// the previous `|_| None` behaviour unchanged.
        dirs: Arc<Mutex<HashMap<u32, String>>>,
        /// Every waiter's wake-up source (see [`HarnessTick`]).
        tick: HarnessTick,
    }

    fn harness(dir: &Path) -> Harness {
        let tick: HarnessTick = new_tick();
        let (audit, task) = AuditLog::new(dir.to_path_buf(), Some(tick_on_append(&tick)));
        tokio::spawn(task);
        let supervisor = Arc::new(Supervisor::new(audit.clone(), None));
        let config: SharedSamuraiConfig = Arc::new(RwLock::new(SamuraiConfig::default()));
        let context = Arc::new(SamuraiContextStore::new());
        // The replicator/injector still resolve session dirs; the resumer no
        // longer does (review F2 — the working dir comes from the gated run
        // config alone).
        let dirs: Arc<Mutex<HashMap<u32, String>>> = Arc::new(Mutex::new(HashMap::new()));
        let dirs_for_resolver = dirs.clone();
        let session_dirs: SessionDirResolver =
            Arc::new(move |id| dirs_for_resolver.lock().unwrap().get(&id).cloned());
        let transcript_paths: TranscriptPathResolver = Arc::new(|_| None);
        let teardown: SessionTeardown = Arc::new(|_| Box::pin(async {}));
        let spawns: Arc<Mutex<Vec<SuccessorSpawn>>> = Arc::new(Mutex::new(Vec::new()));
        let spawns_rec = spawns.clone();
        let tick_for_spawn = tick.clone();
        let emit_spawn: SuccessorEmitter = Arc::new(move |s| {
            spawns_rec.lock().unwrap().push(s.clone());
            tick_for_spawn.notify_one();
        });
        let write_stdin: StdinWriter = Arc::new(|_, _, outcome| outcome(Ok(())));
        let resend_enter: EnterResender = Arc::new(|_| {});
        let replicator = Arc::new(SamuraiReplicator::new(
            supervisor.clone(),
            audit.clone(),
            config.clone(),
            session_dirs.clone(),
            transcript_paths,
            teardown.clone(),
            emit_spawn,
            write_stdin,
            resend_enter,
        ));
        let injector = Arc::new(SamuraiInjector::new(
            supervisor.clone(),
            context.clone(),
            config,
            // Issue #109: the injected writer confirms every body write, so
            // delivered rows behave as production's post-write verdict.
            Arc::new(|_, _, outcome: crate::core::samurai_pty::DeliveryOutcome| outcome(Ok(()))),
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
        );
        let resumer_for_fire = resumer.clone();
        let (schedule, _task) = SamuraiSchedule::new(
            dir.join("schedule"),
            Arc::new(move |entry| resumer_for_fire.on_fire(entry)),
            None,
        );
        let parker = SamuraiParker::new(
            supervisor.clone(),
            context.clone(),
            injector.clone(),
            schedule.clone(),
            audit.clone(),
            teardown,
        );
        injector.set_parker(parker.clone());
        resumer.bind(schedule.clone(), parker.clone());
        // Issue #207: the same veto lib.rs wires, so the drop path is
        // exercised end to end here.
        let resumer_for_drop = resumer.clone();
        replicator.set_spawn_dropped_hook(Arc::new(
            move |project: &str, epic: &str, generation: u32, trigger: &'static str| {
                resumer_for_drop.on_spawn_dropped(project, epic, generation, trigger)
            },
        ));
        Harness {
            resumer,
            supervisor,
            replicator,
            run_configs,
            schedule,
            audit,
            spawns,
            injector,
            context,
            parker,
            dirs,
            tick,
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
            launch: None,
            held: false,
        }
    }

    // The waits below are the shared, event-driven ones — see
    // [`crate::core::samurai_test_wait`] for why a fixed sleep budget was
    // the wrong mechanism here (issues #197, #198).

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

        wait_until(&h.tick, || !h.spawns.lock().unwrap().is_empty()).await;
        let spawns = h.spawns.lock().unwrap().clone();
        assert_eq!(spawns[0].generation, 3, "latest handoff gen 2 + 1");
        assert_eq!(spawns[0].epic, "#37");
        assert_eq!(
            spawns[0].working_dir,
            repo.path().to_string_lossy().into_owned()
        );

        // The RESUME row (first producer of the kind) preceded the spawn.
        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
            r.event == AuditEventKind::Resume
        })
        .await;
        let resume: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Resume)
            .collect();
        assert_eq!(resume.len(), 1);
        assert_eq!(resume[0].epic, "#37");
        assert_eq!(resume[0].generation, 3);
        assert_eq!(resume[0].session_id, 0);
        assert_eq!(resume[0].details["fire_at"], "2026-08-06T12:00:00+00:00");
        // Issue #101: the row names its trigger (fire_at doubles as the
        // timer id) and the generation it resumes from.
        assert_eq!(resume[0].details["trigger"], "resume_timer");
        assert_eq!(resume[0].details["predecessor_generation"], 2);
        // Issue #207: a same-session timer is not a restored one.
        assert_eq!(resume[0].details["restored"], false);

        // The handoff exists → the staged ritual is the normal successor
        // one (verify required — the fixture handoff has no SHA), never
        // recovery.
        let staged = h
            .replicator
            .spawn_details(project, "#37", 3)
            .expect("gen-3 must be staged");
        assert_eq!(staged["predecessor_generation"], 2);
        assert_eq!(staged["predecessor_session_id"], 0);
        assert_eq!(staged["trigger"], "resume_timer");
    }

    #[tokio::test]
    async fn test_restored_timer_resumes_the_run_instead_of_alerting() {
        // Issue #207: an allowance park's timer outlives the app (the window
        // is 5 h). The restored gate used to ALERT and die here, and because
        // the fired entry self-cleaned anyway the run was left for a human.
        // A restored timer now takes the ordinary path: spawn, with the
        // RESUME row saying it came back from disk.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-restored";
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

        let restored = entry(project, "#37");
        h.resumer.mark_restored(std::slice::from_ref(&restored));
        h.resumer.on_fire(restored);

        wait_until(&h.tick, || !h.spawns.lock().unwrap().is_empty()).await;
        assert_eq!(h.spawns.lock().unwrap()[0].generation, 3);
        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
            r.event == AuditEventKind::Resume
        })
        .await;
        let resume = rows
            .iter()
            .find(|r| r.event == AuditEventKind::Resume)
            .unwrap();
        assert_eq!(resume.details["restored"], true);
        assert_eq!(resume.details["predecessor_generation"], 2);
        assert!(
            !rows
                .iter()
                .any(|r| r.details["kind"] == RESUME_INTERRUPTED_KIND),
            "a resumable restored run must not be reported as interrupted"
        );
    }

    #[tokio::test]
    async fn test_restored_timer_defers_and_stays_on_disk_when_the_run_is_busy() {
        // The recoverable half of #207, driven through the SCHEDULE so the
        // fired entry's self-clean is part of the test: a deferred fire
        // re-arms (+DEFER_DELAY_SECS) and the entry is still on disk
        // afterwards, because the self-clean matches on the OLD fire_at.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-restored-busy";
        h.run_configs
            .save(&SamuraiRunConfig::new(
                project,
                "#37",
                format!("{project}-wt"),
            ))
            .unwrap();
        // A live orchestrator for the epic — the guard rail that defers.
        h.supervisor
            .register_session(1, project.into(), "#37".into(), 3)
            .unwrap();
        h.schedule.arm(entry(project, "#37")).unwrap();
        h.resumer.mark_restored(&h.schedule.list());

        h.schedule.fire_due();

        let timers = h.schedule.list();
        assert_eq!(timers.len(), 1, "the deferred entry must stay on disk");
        let deferred = DateTime::parse_from_rfc3339(&timers[0].fire_at).unwrap();
        assert!(
            deferred > DateTime::parse_from_rfc3339("2026-08-06T12:00:00+00:00").unwrap(),
            "re-armed past the original fire time"
        );
        let persisted: Vec<ScheduleEntry> = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("schedule").join("schedule.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(persisted, timers, "the re-arm reached schedule.json");
        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
            r.event == AuditEventKind::Park && r.details["phase"] == "resume_deferred"
        })
        .await;
        assert_eq!(
            rows.iter()
                .filter(|r| r.details["kind"] == RESUME_INTERRUPTED_KIND)
                .count(),
            0,
            "a deferral is not an interruption"
        );
        assert!(h.spawns.lock().unwrap().is_empty());

        // Review finding 2: the re-armed entry carries a FRESH fire_at, so a
        // fire_at-keyed restored set lost the flag right here. The eventual
        // resume must still know it came back from disk.
        h.supervisor
            .transition(1, SupervisorState::ParkRequested)
            .unwrap();
        h.supervisor.transition(1, SupervisorState::Parked).unwrap();
        h.resumer.on_fire(timers[0].clone());
        wait_until(&h.tick, || !h.spawns.lock().unwrap().is_empty()).await;
        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
            r.event == AuditEventKind::Resume
        })
        .await;
        let resume = rows
            .iter()
            .find(|r| r.event == AuditEventKind::Resume)
            .unwrap();
        assert_eq!(
            resume.details["restored"], true,
            "the restored flag must survive a deferral re-arm"
        );
    }

    #[tokio::test]
    async fn test_dropped_resume_spawn_rearms_the_timer_and_alerts_once() {
        // Review finding 1: the frontend drops a spawn event when no tab for
        // the project is open, and the replicator's ladder used to end that
        // with a `spawn_dropped` ALERT and NO timer on disk — the same manual
        // chore #207 removes, 15 minutes later. The resume timer is re-armed
        // instead, and only the FIRST drop this app run keeps the ALERT.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-dropped";
        h.run_configs
            .save(&SamuraiRunConfig::new(
                project,
                "#37",
                format!("{project}-wt"),
            ))
            .unwrap();

        assert!(
            !h.resumer
                .on_spawn_dropped(project, "#37", 4, "resume_timer"),
            "the first drop keeps the replicator's own ALERT"
        );
        let timers = h.schedule.list();
        assert_eq!(timers.len(), 1, "the resume timer is back on disk");
        assert_eq!(timers[0].reason, REASON_PARK);
        assert!(
            DateTime::parse_from_rfc3339(&timers[0].fire_at).unwrap() > Utc::now(),
            "re-armed into the future"
        );

        assert!(
            h.resumer
                .on_spawn_dropped(project, "#37", 5, "resume_timer"),
            "a repeat drop is handled quietly — the run is waiting on a timer"
        );
        assert_eq!(h.schedule.list().len(), 1, "still exactly one timer");
        // A gen-1 launch's drop is not this module's business.
        assert!(!h.resumer.on_spawn_dropped(project, "#37", 1, "launch"));

        // Review 2, finding 3: a dropped gh_auth_restored resume (issue
        // #208) re-arms too, under ITS reason — not the park one.
        assert!(!h
            .resumer
            .on_spawn_dropped(project, "#99", 2, GH_AUTH_RESTORED));
        let released = h
            .schedule
            .list()
            .into_iter()
            .find(|t| t.epic == "#99")
            .expect("the auth-restore resume is re-armed as well");
        assert_eq!(released.reason, GH_AUTH_RESTORED);

        wait_for_rows(&h.tick, &h.audit, project, |rows| {
            rows.iter()
                .filter(|r| {
                    r.epic == "#37"
                        && r.event == AuditEventKind::Park
                        && r.details["phase"] == "resume_deferred"
                })
                .count()
                == 2
        })
        .await;
    }

    #[tokio::test]
    async fn test_survivor_probe_does_not_run_on_the_fire_thread() {
        // Review 2, finding 1: the probe refreshes the whole process table
        // with command lines, and `on_fire` is called straight from the
        // schedule's interval loop — the reconciler runs the identical probe
        // under `spawn_blocking`. A probe that BLOCKS proves the hop: if it
        // ran inline, `on_fire` could not return until it was released.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-probe-thread";
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
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let entered = Arc::new(Mutex::new(false));
        let entered_probe = entered.clone();
        let release_rx = Mutex::new(release_rx);
        h.resumer.set_orphan_probe(Arc::new(move |_| {
            *entered_probe.lock().unwrap() = true;
            let _ = release_rx.lock().unwrap().recv();
            None
        }));

        let restored = entry(project, "#37");
        h.resumer.mark_restored(std::slice::from_ref(&restored));
        h.resumer.on_fire(restored);
        // Returned while the probe is still blocked — the fire thread is free.
        assert!(
            h.spawns.lock().unwrap().is_empty(),
            "the resume cannot have completed while the probe is blocked"
        );

        release_tx.send(()).unwrap();
        wait_until(&h.tick, || !h.spawns.lock().unwrap().is_empty()).await;
        assert!(*entered.lock().unwrap(), "the probe was consulted");
        assert_eq!(h.spawns.lock().unwrap()[0].generation, 3);
    }

    #[tokio::test]
    async fn test_a_resume_clears_the_restored_mark_and_the_alert_counters() {
        // Review 2, findings 2 and 4. Once the run resumes it is owned
        // again: a park armed AFTER that is a same-process timer like any
        // other (no survivor probe, no latched restart ALERT), and a LATER
        // drop is a new condition that reports itself instead of being
        // swallowed by the first one's latch.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-sticky";
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
        let probe_calls = Arc::new(Mutex::new(0u32));
        let probe_rec = probe_calls.clone();
        h.resumer.set_orphan_probe(Arc::new(move |_| {
            *probe_rec.lock().unwrap() += 1;
            None
        }));
        // One drop before the resume: reported (the first lap).
        assert!(!h.resumer.on_spawn_dropped(project, "#37", 2, TRIGGER_PARK));

        let restored = entry(project, "#37");
        h.resumer.mark_restored(std::slice::from_ref(&restored));
        h.resumer.on_fire(restored);
        wait_until(&h.tick, || !h.spawns.lock().unwrap().is_empty()).await;
        assert_eq!(*probe_calls.lock().unwrap(), 1, "the restored fire probed");

        // A drop AFTER the resume is a new condition — reported again, not
        // swallowed by the pre-resume latch.
        assert!(
            !h.resumer.on_spawn_dropped(project, "#37", 3, TRIGGER_PARK),
            "a drop after a successful resume must alert again"
        );

        // And a timer armed in THIS session, for a run whose config has
        // since been archived, gets the same-process note — not the
        // restored one — and never touches the probe.
        h.run_configs.archive(project, "#37").unwrap();
        h.resumer.on_fire(ScheduleEntry {
            fire_at: "2026-08-06T13:00:00+00:00".to_string(),
            ..entry(project, "#37")
        });
        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
            r.details["kind"] == "resume_run_not_active"
        })
        .await;
        assert!(
            !rows
                .iter()
                .any(|r| r.details["kind"] == RESUME_INTERRUPTED_KIND),
            "restoredness must not outlive the resume"
        );
        assert_eq!(
            *probe_calls.lock().unwrap(),
            1,
            "no probe for a same-process fire"
        );
    }

    #[tokio::test]
    async fn test_a_run_stuck_dropping_resurfaces_instead_of_being_silent_forever() {
        // Review 2, finding 5: the drop -> defer -> re-emit -> drop cycle is
        // deliberately unbounded (a project opened tomorrow must still
        // resume), so the SILENCE is what gets bounded. The first lap
        // reports, then every ALERT_EVERY_LAPS-th, so a run cycling every
        // ~25 minutes resurfaces instead of hiding behind PARK rows.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-stuck";
        let reported: Vec<bool> = (1..=ALERT_EVERY_LAPS + 1)
            .map(|gen| {
                !h.resumer
                    .on_spawn_dropped(project, "#37", gen, TRIGGER_PARK)
            })
            .collect();
        let mut expected = vec![false; ALERT_EVERY_LAPS as usize + 1];
        expected[0] = true;
        expected[ALERT_EVERY_LAPS as usize] = true;
        assert_eq!(
            reported,
            expected,
            "lap 1 and lap {} report",
            ALERT_EVERY_LAPS + 1
        );
        assert_eq!(h.schedule.list().len(), 1, "every lap re-armed the timer");
    }

    #[tokio::test]
    async fn test_restored_timer_defers_when_an_orphan_probably_survived() {
        // Review finding 3: the reconciler defers to a pending timer
        // (`SkipTimer`) and the resumer's registry is empty right after a
        // restart, so a restored resume was the one spawn path with no
        // survivor check. A probable survivor defers instead of putting a
        // second orchestrator in the worktree — and says so once.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-orphan";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        write_handoff(repo.path(), "#37", 2);
        let worktree = repo.path().to_string_lossy().into_owned();
        h.run_configs
            .save(&SamuraiRunConfig::new(project, "#37", worktree.clone()))
            .unwrap();
        let asked: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let asked_rec = asked.clone();
        h.resumer.set_orphan_probe(Arc::new(move |dir: &str| {
            asked_rec.lock().unwrap().push(dir.to_string());
            Some(42)
        }));

        let restored = entry(project, "#37");
        h.resumer.mark_restored(std::slice::from_ref(&restored));
        h.resumer.on_fire(restored.clone());

        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
            r.details["kind"] == RESUME_ORPHAN_KIND
        })
        .await;
        assert_eq!(*asked.lock().unwrap(), vec![worktree]);
        let alert = rows
            .iter()
            .find(|r| r.details["kind"] == RESUME_ORPHAN_KIND)
            .unwrap();
        assert_eq!(alert.event, AuditEventKind::Alert);
        assert_eq!(alert.details["transcript_age_secs"], 42);
        assert!(
            h.spawns.lock().unwrap().is_empty(),
            "no second orchestrator"
        );
        assert_eq!(h.schedule.list().len(), 1, "deferred, not dropped");

        // Said once per app run, not once per defer interval: the second
        // deferral row is the barrier that proves the second fire finished.
        h.resumer.on_fire(restored);
        let rows = wait_for_rows(&h.tick, &h.audit, project, |rows| {
            rows.iter()
                .filter(|r| r.details["phase"] == "resume_deferred")
                .count()
                == 2
        })
        .await;
        assert_eq!(
            rows.iter()
                .filter(|r| r.details["kind"] == RESUME_ORPHAN_KIND)
                .count(),
            1,
            "the orphan alert is latched in memory for the app run"
        );
        assert!(h.spawns.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_restored_timer_for_an_archived_run_alerts_once_and_latches() {
        // The unrecoverable case #207 keeps: the run config is archived, so
        // no resume is possible. Exactly ONE resume_interrupted_restart, and
        // the `interrupted_at` stamp (#185/#196) keeps a repeat quiet.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-restored-archived";
        h.run_configs
            .save(&SamuraiRunConfig::new(
                project,
                "#37",
                format!("{project}-wt"),
            ))
            .unwrap();
        h.run_configs.archive(project, "#37").unwrap();

        let restored = entry(project, "#37");
        h.resumer.mark_restored(std::slice::from_ref(&restored));
        h.resumer.on_fire(restored.clone());

        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
            r.details["kind"] == RESUME_INTERRUPTED_KIND
        })
        .await;
        let alert = rows
            .iter()
            .find(|r| r.details["kind"] == RESUME_INTERRUPTED_KIND)
            .unwrap();
        assert_eq!(alert.event, AuditEventKind::Alert);
        assert_eq!(alert.details["reason"], "run_not_active");
        assert_eq!(alert.details["status"], "ARCHIVED");
        assert_eq!(
            alert.details["message"],
            "run #37 was interrupted — resume it manually"
        );
        // Latched onto the config, by this module's own kind.
        let stamp = h
            .run_configs
            .get(project, "#37")
            .unwrap()
            .interrupted_at
            .expect("the restart alert must latch onto the run config");
        assert_eq!(stamp.kind, RESUME_INTERRUPTED_KIND);

        // A second fire (the next app launch's restored entry) stays quiet.
        // The barrier below is what makes "quiet" observable: a row appended
        // AFTER it would still be counted, because the audit writer is FIFO
        // per project — so waiting for the barrier waits out the second fire.
        h.resumer.on_fire(restored);
        h.resumer.on_fire(entry(project, "#barrier"));
        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
            r.details["kind"] == "resume_run_not_active" && r.epic == "#barrier"
        })
        .await;
        assert_eq!(
            rows.iter()
                .filter(|r| r.details["kind"] == RESUME_INTERRUPTED_KIND)
                .count(),
            1,
            "the restart alert is latched — one row, not one per launch"
        );
        assert!(h.spawns.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_fire_defers_when_a_live_orchestrator_exists() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-defer";
        // An ACTIVE run config (the F2 gate lets only these through) plus a
        // WORKING session for the epic — e.g. the crash-refire case where
        // the resumed successor already registered.
        h.run_configs
            .save(&SamuraiRunConfig::new(
                project,
                "#37",
                format!("{project}-wt"),
            ))
            .unwrap();
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
        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
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
    async fn test_fire_proceeds_past_terminal_leftovers_using_registry_generation() {
        // A PARKED leftover in the registry does not defer, and its
        // generation drives the next one; the working dir always comes from
        // the run config (review F2 — session-dir fallbacks are gone).
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-leftover";
        let repo = tempdir().unwrap();
        init_repo(repo.path()); // no handoff files
        h.run_configs
            .save(&SamuraiRunConfig::new(
                project,
                "#37",
                repo.path().to_string_lossy().into_owned(),
            ))
            .unwrap();
        h.supervisor
            .register_session(5, project.into(), "#37".into(), 4)
            .unwrap();
        h.supervisor
            .transition(5, SupervisorState::ParkRequested)
            .unwrap();
        h.supervisor.transition(5, SupervisorState::Parked).unwrap();

        h.resumer.on_fire(entry(project, "#37"));

        wait_until(&h.tick, || !h.spawns.lock().unwrap().is_empty()).await;
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

    /// Review F2 (the #96 regression, timer edition): a fired timer whose
    /// run config is COMPLETED, ARCHIVED or missing must never spawn a
    /// successor into the finished worktree — it drops with an
    /// `ALERT (resume_run_not_active)` note and never re-arms.
    async fn assert_fire_dropped_as_not_active(
        prepare: impl FnOnce(&Harness, &str),
        project: &str,
        expected_status: &str,
    ) {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        prepare(&h, project);

        h.resumer.on_fire(entry(project, "#37"));

        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
            r.details["kind"] == "resume_run_not_active"
        })
        .await;
        let alert = rows
            .iter()
            .find(|r| r.details["kind"] == "resume_run_not_active")
            .unwrap();
        assert_eq!(alert.event, AuditEventKind::Alert);
        assert_eq!(alert.details["epic"], "#37");
        assert_eq!(alert.details["status"], expected_status);
        // Stale timer: no re-arm, no spawn, no RESUME row.
        assert!(h.schedule.list().is_empty());
        assert!(h.spawns.lock().unwrap().is_empty());
        assert!(!rows.iter().any(|r| r.event == AuditEventKind::Resume));
    }

    #[tokio::test]
    async fn test_fire_for_completed_run_is_dropped_with_audit_note() {
        assert_fire_dropped_as_not_active(
            |h, project| {
                h.run_configs
                    .save(&SamuraiRunConfig::new(
                        project,
                        "#37",
                        format!("{project}-wt"),
                    ))
                    .unwrap();
                h.run_configs.complete(project, "#37").unwrap();
            },
            "C:/git/proj-res-completed",
            "COMPLETED",
        )
        .await;
    }

    #[tokio::test]
    async fn test_fire_for_archived_run_is_dropped_with_audit_note() {
        assert_fire_dropped_as_not_active(
            |h, project| {
                h.run_configs
                    .save(&SamuraiRunConfig::new(
                        project,
                        "#37",
                        format!("{project}-wt"),
                    ))
                    .unwrap();
                h.run_configs.archive(project, "#37").unwrap();
            },
            "C:/git/proj-res-archived",
            "ARCHIVED",
        )
        .await;
    }

    #[tokio::test]
    async fn test_fire_without_any_run_config_is_dropped_with_audit_note() {
        // A cleanup can delete the config outright; a timer without a run
        // is stale by definition.
        assert_fire_dropped_as_not_active(|_, _| {}, "C:/git/proj-res-noconfig", "MISSING").await;
    }

    #[tokio::test]
    async fn test_fire_with_unreadable_run_config_defers_instead_of_dropping() {
        // A torn or locked config file used to read exactly like a deleted
        // one, so the timer was dropped as "MISSING" and a live parked run
        // never resumed. Unreadable is not evidence the run ended: defer.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-torn-config";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        h.run_configs
            .save(&SamuraiRunConfig::new(
                project,
                "#37",
                repo.path().to_string_lossy().into_owned(),
            ))
            .unwrap();
        let (config_path, _) = h.run_configs.list_with_paths().into_iter().next().unwrap();
        std::fs::write(&config_path, "{ this is not json").unwrap();

        h.resumer.on_fire(entry(project, "#37"));

        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
            r.details["kind"] == "resume_config_unreadable"
        })
        .await;
        assert!(rows
            .iter()
            .any(|r| r.details["kind"] == "resume_config_unreadable"));
        assert!(
            !rows
                .iter()
                .any(|r| r.details["kind"] == "resume_run_not_active"),
            "an unreadable config must never be reported as a finished run"
        );
        assert_eq!(
            h.schedule.list().len(),
            1,
            "the timer is re-armed, not destroyed"
        );
        assert!(h.spawns.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_fire_with_unreadable_handoffs_dir_defers_instead_of_dropping() {
        // Same conflation one layer down: an unreadable handoffs directory
        // read as "this run has no handoff", which is a TERMINAL branch —
        // the timer of a run whose handoffs were on disk was destroyed.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-res-torn-handoffs";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        h.run_configs
            .save(&SamuraiRunConfig::new(
                project,
                "#37",
                repo.path().to_string_lossy().into_owned(),
            ))
            .unwrap();
        // A FILE where the handoffs directory belongs: read_dir errors with
        // something other than NotFound.
        std::fs::create_dir_all(repo.path().join(".maestro")).unwrap();
        std::fs::write(repo.path().join(".maestro").join("handoffs"), "not a dir").unwrap();

        h.resumer.on_fire(entry(project, "#37"));

        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
            r.details["kind"] == "resume_handoffs_unreadable"
        })
        .await;
        assert!(rows
            .iter()
            .any(|r| r.details["kind"] == "resume_handoffs_unreadable"));
        assert!(
            !rows
                .iter()
                .any(|r| r.details["kind"] == "resume_no_handoff"),
            "an unreadable directory must never be reported as 'nothing to resume from'"
        );
        assert_eq!(
            h.schedule.list().len(),
            1,
            "the timer is re-armed, not destroyed"
        );
        assert!(h.spawns.lock().unwrap().is_empty());
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

        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
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

    // --- the park → armed timer → fire → resume seam ---

    /// `git init` + one commit + the epic's handoff file for `generation`,
    /// so the park ladder's file+WIP validation passes (the handoff lands
    /// untracked, which `validate_handoff` accepts — only modified/staged
    /// TRACKED files count as uncommitted WIP).
    fn init_parkable_repo(dir: &Path, epic: &str, generation: u32) {
        init_repo(dir);
        write_handoff(dir, epic, generation);
    }

    /// Drives session `id` through the park ladder's happy path: the Stop
    /// hook injects the instruction, then the ACK, then the written marker.
    fn complete_park(h: &Harness, id: u32, generation: u32) {
        h.injector.observe_hook(&ClaudeEvent::SessionEnded {
            session_id: id,
            reason: "stop".into(),
            timestamp: "t".into(),
        });
        let msg = |text: String| ClaudeEvent::AssistantMessage {
            session_id: id,
            uuid: format!("uuid-{id}-{}", text.len()),
            text,
            model: "claude-opus-4".to_string(),
            token_usage: None,
            timestamp: "t".to_string(),
        };
        h.injector.observe(&msg(format!(
            "<samurai-ack>park gen-{generation}</samurai-ack>"
        )));
        h.injector.observe(&msg(format!(
            "<samurai-handoff-written>gen-{generation} park</samurai-handoff-written>"
        )));
    }

    #[tokio::test]
    async fn test_hard_crossing_parks_then_the_armed_timer_fires_and_resumes_the_epic() {
        // The seam neither half's tests cover: the parker's own tests stop at
        // "timer armed" and every resumer test above hands `on_fire` an entry
        // by hand. This one runs the whole chain through the real components
        // — allowance event → sweep → park ladder → armed timer → the
        // schedule's own due check → resume spawn — so a break anywhere in
        // between (a fire_at nobody can parse, a reason mismatch, an epic
        // spelling that stops matching) fails here instead of in production.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-seam";
        let epic = "#42";
        let repo = tempdir().unwrap();
        init_parkable_repo(repo.path(), epic, 1);
        let worktree = repo.path().to_string_lossy().into_owned();
        h.dirs.lock().unwrap().insert(1, worktree.clone());
        // The ACTIVE run config is what lets the fired timer spawn at all
        // (the F2 gate) and where the successor's working dir comes from.
        h.run_configs
            .save(&SamuraiRunConfig::new(project, epic, worktree.clone()))
            .unwrap();
        h.supervisor
            .register_session(1, project.into(), epic.into(), 1)
            .unwrap();
        h.context.observe(&ClaudeEvent::ContextUsageUpdate {
            session_id: 1,
            model: "claude-opus-4".to_string(),
            context_tokens: 90_000,
            context_window: 200_000,
            percent: 55.0,
            timestamp: "2026-08-06T00:00:00Z".to_string(),
        });

        // A reset time chosen so the parker's REAL arithmetic
        // (`resets_at + 5 min + per-epic jitter`) lands ~1s from now: the
        // wait is compressed, the computation is not faked.
        // 300 = the parker's own `RESUME_DELAY_SECS` (PRD §7's 5 minutes),
        // pinned there by `test_fire_at_adds_five_minutes_plus_epic_jitter`
        // — so a drift in that constant fails loudly rather than silently
        // skewing this test's fire time.
        let lead = ChronoDuration::seconds(1);
        let resets_at = Utc::now() + lead - ChronoDuration::seconds(300 + jitter_secs(epic) as i64);
        h.parker
            .on_allowance_event(&AllowanceEvent::ThresholdCrossed {
                window: AllowanceWindow::FiveHour,
                threshold_kind: ThresholdKind::Hard,
                value: 91.0,
                threshold: 90.0,
                resets_at: Some(resets_at.to_rfc3339()),
            });

        // --- park half ---
        assert!(
            h.parker.parking_engaged(),
            "hard crossing engages the sweep"
        );
        assert_eq!(
            h.supervisor
                .list_sessions()
                .iter()
                .find(|s| s.session_id == 1)
                .map(|s| s.state),
            Some(SupervisorState::ParkRequested)
        );
        complete_park(&h, 1, 1);
        wait_until(&h.tick, || {
            h.supervisor
                .list_sessions()
                .iter()
                .any(|s| s.session_id == 1 && s.state == SupervisorState::Parked)
        })
        .await;
        // Sweep completion is what arms the timer — never the park itself.
        wait_until(&h.tick, || !h.parker.parking_engaged()).await;

        let timers = h.schedule.list();
        assert_eq!(timers.len(), 1, "exactly one resume timer armed");
        assert_eq!(timers[0].epic, epic);
        assert_eq!(timers[0].project_path, project);
        assert_eq!(timers[0].reason, REASON_PARK);
        wait_for_row(&h.tick, &h.audit, project, |r| {
            r.event == AuditEventKind::Park && r.details["phase"] == "timer_armed"
        })
        .await;
        // Nothing has resumed yet: the timer is armed, not due.
        h.schedule.fire_due();
        assert!(
            h.spawns.lock().unwrap().is_empty(),
            "a future timer must not fire early"
        );

        // --- the wait, compressed ---
        let fire_at = DateTime::parse_from_rfc3339(&timers[0].fire_at).unwrap();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(
            Utc::now() >= fire_at.with_timezone(&Utc),
            "the armed fire time must have passed before the tick"
        );

        // --- resume half: the schedule's own due check drives it ---
        h.schedule.fire_due();
        wait_until(&h.tick, || !h.spawns.lock().unwrap().is_empty()).await;
        let spawns = h.spawns.lock().unwrap().clone();
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0].epic, epic);
        assert_eq!(spawns[0].generation, 2, "gen-1 handoff on disk + 1");
        assert_eq!(spawns[0].working_dir, worktree);

        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
            r.event == AuditEventKind::Resume
        })
        .await;
        let resume: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Resume)
            .collect();
        assert_eq!(resume.len(), 1);
        assert_eq!(resume[0].epic, epic);
        assert_eq!(resume[0].generation, 2);
        assert_eq!(resume[0].details["trigger"], "resume_timer");
        assert_eq!(resume[0].details["fire_at"], timers[0].fire_at);
        // Self-clean: a fired timer leaves no countdown behind.
        assert!(
            h.schedule.list().is_empty(),
            "the fired timer must self-clean"
        );
    }

    /// Review finding 3: the parker skips a finished run SILENTLY when it
    /// arms a release, but the run can also end during the stagger's own few
    /// seconds — and the fire-time gate used to ALERT for it, asking a human
    /// to look at a run they themselves archived. A PARK timer keeps that
    /// ALERT: it waited out a whole allowance window.
    #[tokio::test]
    async fn test_an_auth_restore_whose_run_ended_during_the_wait_drops_silently() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-auth-late-archive";
        let repo = tempdir().unwrap();
        init_parkable_repo(repo.path(), "#180", 1);
        let mut config =
            SamuraiRunConfig::new(project, "#180", repo.path().to_string_lossy().into_owned());
        config.status = RunConfigStatus::Archived;
        h.run_configs.save(&config).unwrap();

        let mut released = entry(project, "#180");
        released.reason = GH_AUTH_RESTORED.to_string();
        h.resumer.on_fire(released);

        // A PARK timer for an equally-finished run DOES alert — and the
        // audit is append-ordered, so once its row is readable any row the
        // release would have written is already there too. That ordering is
        // the negative assertion: no sleep, no quiet window.
        let mut archived_park = entry(project, "#180");
        archived_park.fire_at = "2026-08-06T13:00:00+00:00".to_string();
        h.resumer.on_fire(archived_park);

        let rows = wait_for_row(&h.tick, &h.audit, project, |r| {
            r.details["kind"] == "resume_run_not_active"
        })
        .await;
        let alerts: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Alert)
            .collect();
        assert_eq!(
            alerts.len(),
            1,
            "only the park timer may alert; the release drops silently: {alerts:?}"
        );
        assert_eq!(alerts[0].details["status"], "ARCHIVED");
        assert!(
            h.spawns.lock().unwrap().is_empty(),
            "neither timer may spawn into an archived run"
        );
    }

    /// Issue #208, the other half of that seam: an EXTERNAL park (gh auth
    /// loss) arms nothing by design, so before this the runs it stopped sat
    /// parked until a human found them. The restored edge releases them —
    /// and this runs the whole chain through the real components: external
    /// park → park ladder → release → the schedule's own due check → two
    /// fresh spawns.
    ///
    /// The two epics are picked because their real per-epic jitter COLLIDES
    /// (both hash to 1s, so the de-duplication spaces them 1s and 2s): the
    /// stagger arithmetic is production's, and the wait is short enough to
    /// drive from a test.
    #[tokio::test]
    async fn test_an_auth_restore_resumes_both_parked_runs_through_the_schedule() {
        use crate::core::samurai_auth_watch::GH_AUTH_LOST;

        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-auth-seam";
        // The parker's own ACTIVE-run check on release (issue #208) — the
        // wiring `lib.rs` does at startup.
        h.parker.set_run_configs(h.run_configs.clone());

        let runs = [(1u32, "#180"), (2u32, "#532")];
        let mut repos = Vec::new();
        for (id, epic) in runs {
            let repo = tempdir().unwrap();
            init_parkable_repo(repo.path(), epic, 1);
            let worktree = repo.path().to_string_lossy().into_owned();
            h.dirs.lock().unwrap().insert(id, worktree.clone());
            h.run_configs
                .save(&SamuraiRunConfig::new(project, epic, worktree))
                .unwrap();
            h.supervisor
                .register_session(id, project.into(), epic.into(), 1)
                .unwrap();
            repos.push(repo);
        }

        h.parker.engage_external_park(GH_AUTH_LOST);
        // Sequential sweep: session 1 first (both contexts unknown, so the
        // tiebreak is the session id), then session 2.
        for (id, _) in runs {
            wait_until(&h.tick, || {
                h.supervisor
                    .list_sessions()
                    .iter()
                    .any(|s| s.session_id == id && s.state == SupervisorState::ParkRequested)
            })
            .await;
            complete_park(&h, id, 1);
        }
        wait_until(&h.tick, || !h.parker.parking_engaged()).await;
        assert!(
            h.schedule.list().is_empty(),
            "an external park arms nothing while auth is still broken"
        );

        // `gh auth` comes back — the watch's restored edge.
        assert_eq!(h.parker.release_external_park(GH_AUTH_LOST), 2);
        let timers = h.schedule.list();
        assert_eq!(timers.len(), 2);
        let mut fire_ats: Vec<String> = timers.iter().map(|t| t.fire_at.clone()).collect();
        fire_ats.sort();
        fire_ats.dedup();
        assert_eq!(fire_ats.len(), 2, "the two resumes fire at distinct times");

        // Nothing resumes before its time.
        h.schedule.fire_due();
        assert!(
            h.spawns.lock().unwrap().is_empty(),
            "a future resume must not fire early"
        );

        // The armed times are seconds out (the epics' real jitter), so the
        // schedule's own due check is re-driven until both have passed. No
        // budget: `wait_until` only gives up at the hang backstop, so a
        // loaded box costs wall time instead of a red test (issues
        // #197/#198, and the fixed sleep this replaced).
        let latest = timers
            .iter()
            .map(|t| {
                DateTime::parse_from_rfc3339(&t.fire_at)
                    .unwrap()
                    .with_timezone(&Utc)
            })
            .max()
            .unwrap();
        wait_until(&h.tick, || {
            h.schedule.fire_due();
            h.spawns.lock().unwrap().len() == 2
        })
        .await;
        assert!(Utc::now() >= latest, "both armed fire times had to pass");
        let mut spawned: Vec<(String, u32)> = h
            .spawns
            .lock()
            .unwrap()
            .iter()
            .map(|s| (s.epic.clone(), s.generation))
            .collect();
        spawned.sort();
        assert_eq!(
            spawned,
            vec![("#180".to_string(), 2), ("#532".to_string(), 2)],
            "each parked run spawns its own next generation"
        );

        let rows = wait_for_rows(&h.tick, &h.audit, project, |rows| {
            rows.iter()
                .filter(|r| r.event == AuditEventKind::Resume)
                .count()
                == 2
        })
        .await;
        let resume: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Resume)
            .collect();
        assert_eq!(resume.len(), 2);
        for row in &resume {
            assert_eq!(
                row.details["trigger"], "gh_auth_restored",
                "the row names what was FIXED, not what broke"
            );
            assert_eq!(row.details["predecessor_generation"], 1);
        }
        assert!(h.schedule.list().is_empty(), "both fired timers self-clean");
    }
}
