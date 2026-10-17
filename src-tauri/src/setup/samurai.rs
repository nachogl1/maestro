//! Samurai supervisor wiring: audit log, supervisor, watchdog, injector,
//! replicator, completion, journal/harvest, schedule, parker, auth and
//! allowance watchers, and cold-start reconciliation. Construction order is
//! load-bearing (see the ordering comments below).

use std::sync::Arc;

use tauri::{Emitter, Manager};

use super::events::SamuraiTees;
use crate::core;
use crate::core::samurai_audit::{AuditEvent, AuditLog};
use crate::core::samurai_injector::SamuraiInjector;
use crate::core::session_manager::SessionManager;
use crate::core::status_server::StatusServer;
use crate::core::supervisor::{SessionSnapshot, Supervisor, SupervisorState};
use crate::core::ProcessManager;
use crate::core::TranscriptWatcher;
use crate::{commands, github};

/// Constructs and manages every Samurai component and arms the event tees.
pub(super) fn setup_samurai(app: &tauri::App, tees: SamuraiTees) {
    let SamuraiTees {
        samurai_context,
        samurai_injector,
        samurai_completion,
        harvest_triage_slot,
    } = tees;

    // Samurai (Phase 1): audit log + per-session supervisor state
    // machine. The audit log is a single writer task — every append,
    // read and clear serializes through one channel (no interleaved
    // writes; see core::samurai_audit). Audit rows and supervisor
    // state changes are mirrored to the frontend as events.
    // Samurai (issue #57): the progress tracker (circuit breaker +
    // handoff churn) tees off the two callbacks below — audit appends
    // feed the per-epic breaker counter, supervisor changes feed the
    // per-generation HEAD baselines — but it is constructed further
    // down (it needs the config and the session-dir resolver). Same
    // late-bound slot pattern as the injector; both tees only QUEUE
    // work, so the synchronous callbacks are never blocked.
    let samurai_progress_slot: Arc<
        std::sync::OnceLock<Arc<core::samurai_progress::SamuraiProgress>>,
    > = Arc::new(std::sync::OnceLock::new());
    let audit_app_handle = app.handle().clone();
    let progress_for_append = samurai_progress_slot.clone();
    let (audit_log, audit_task) = AuditLog::new(
        commands::ai_runner::artifact_base_dir("audit"),
        Some(Arc::new(move |project: &str, event: &AuditEvent| {
            if let Some(progress) = progress_for_append.get() {
                progress.observe_audit(project, event);
            }
            let _ = audit_app_handle.emit(
                "samurai-audit-event",
                serde_json::json!({ "project": project, "event": event }),
            );
        })),
    );
    tauri::async_runtime::spawn(audit_task);
    // Samurai (issue #56): the replicator is constructed further
    // down (it needs the supervisor), but the supervisor's change
    // callback must reach it to chain DEAD → recovery spawn — same
    // late-bound slot pattern as the injector above. DEAD is a
    // terminal state, so the transition (and this callback) fires at
    // most once per session: the chain cannot double-spawn.
    let samurai_replicator_slot: Arc<
        std::sync::OnceLock<Arc<core::samurai_replicator::SamuraiReplicator>>,
    > = Arc::new(std::sync::OnceLock::new());
    let supervisor_app_handle = app.handle().clone();
    let replicator_for_dead = samurai_replicator_slot.clone();
    let progress_for_change = samurai_progress_slot.clone();
    let supervisor = Arc::new(Supervisor::new(
        audit_log.clone(),
        Some(Arc::new(move |snapshot: &SessionSnapshot| {
            let _ = supervisor_app_handle.emit("samurai-supervisor-event", snapshot);
            // Issue #57: registrations record a HEAD baseline,
            // terminal states drop it (queue-only, non-blocking).
            if let Some(progress) = progress_for_change.get() {
                progress.on_state_change(snapshot);
            }
            if snapshot.state == SupervisorState::Dead {
                if let Some(replicator) = replicator_for_dead.get() {
                    replicator.on_dead(snapshot);
                }
            }
        })),
    ));
    app.manage(audit_log.clone());
    app.manage(supervisor.clone());
    // Samurai (issue #52): per-session context store, fed by the
    // event tee above. Managed so later phases (and the session
    // teardown commands) reach it via `app.state()`.
    app.manage(samurai_context.clone());

    // Samurai (issue #45): thresholds config + backend allowance
    // watcher. The config is seeded from the settings store and
    // shared (Arc<RwLock<…>>) between the get/set commands and the
    // allowance loop, which polls the usage API on its own ~60s
    // timer — independent of the frontend — and emits edge-triggered
    // ALERT audit rows + `samurai-allowance-event` on threshold
    // crossings (events only; parking is Phase 3).
    // Constructed before the watchdog below: that loop reads
    // `staleness_window_secs` from it once per tick.
    let samurai_config: core::samurai_config::SharedSamuraiConfig = Arc::new(
        std::sync::RwLock::new(commands::samurai::load_config_from_store(app.handle())),
    );
    app.manage(samurai_config.clone());

    // Samurai silent-death watchdog (issue #44): one periodic tick
    // that declares a supervised session DEAD when its transcript
    // went stale AND no claude process survives under its shell.
    // The DEAD transition chains through the supervisor callback
    // above into the replicator's recovery spawn (issue #56).
    core::samurai_watchdog::spawn_watchdog(
        supervisor.clone(),
        app.state::<Arc<TranscriptWatcher>>().inner().clone(),
        app.state::<ProcessManager>().inner().clone(),
        samurai_config.clone(),
    );

    // Samurai (issue #53): injection controller. Its 30s tick moves
    // WORKING sessions past `handoff_context_pct` into
    // HANDOFF_REQUESTED; the instruction itself is only typed into
    // the terminal on the Stop-hook idle signal and must be ACKed
    // (`<samurai-ack>…</samurai-ack>`), with one timed retry and an
    // ack_timeout ALERT after that. Filling the OnceLock arms the
    // two event tees above.
    //
    // Issue #54: after the ACK the controller watches for the
    // `<samurai-handoff-written>` marker and validates the handoff
    // (file exists + WIP committed) with git run in the directory
    // the session's shell actually works in — resolved late from
    // the SessionManager (worktree/sub-repo aware, falling back to
    // the project root when no explicit working dir was recorded).
    let session_dirs_handle = app.handle().clone();
    let session_dirs: core::samurai_injector::SessionDirResolver = Arc::new(move |session_id| {
        session_dirs_handle
            .state::<SessionManager>()
            .get_session(session_id)
            .map(|s| s.working_directory.unwrap_or(s.project_path))
    });

    // Samurai (issue #57): circuit breaker + handoff churn. Progress
    // is measured in commits only for v1 (gh issue-update polling is
    // explicitly out of scope): registrations record a per-generation
    // HEAD baseline; each samurai audit event re-reads HEAD in the
    // epic's working dir on a worker task, and `breaker_events`
    // consecutive events with HEAD unchanged park the epic's WORKING
    // session with a circuit_breaker ALERT. A handoff triggered with
    // HEAD still at the generation's baseline fires a handoff_churn
    // ALERT (signal only — the handoff proceeds).
    let (samurai_progress, samurai_progress_task) = core::samurai_progress::SamuraiProgress::new(
        supervisor.clone(),
        samurai_config.clone(),
        audit_log.clone(),
        session_dirs.clone(),
    );
    tauri::async_runtime::spawn(samurai_progress_task);
    // Managed so the session-teardown commands can propagate removals
    // (fresh-eyes finding H): a session closed outside the samurai
    // pipeline must drop its baseline (and, when last, its epic's
    // breaker entry).
    app.manage(samurai_progress.clone());
    // Arms both tees (audit on_append + supervisor change callback).
    let _ = samurai_progress_slot.set(samurai_progress);

    // Samurai (issue #55): replication controller. A validated
    // handoff chains here from the injector: full teardown of gen-N
    // (the same four steps the manual kill command performs) →
    // KILLED transition (audit row + the supervisor event the
    // frontend clears the dead tile on) → `samurai-spawn-successor`
    // to the frontend, which runs its normal spawn flow and
    // registers gen-N+1. The verify-ritual prompt stays queued in
    // the backend and is typed in on the successor's first
    // SessionStarted hook signal (frontend write-timing would race
    // claude's startup).
    let teardown_pm = app.state::<ProcessManager>().inner().clone();
    let teardown_status = app.state::<Arc<StatusServer>>().inner().clone();
    let teardown_watcher = app.state::<Arc<TranscriptWatcher>>().inner().clone();
    let teardown_context = samurai_context.clone();
    let teardown: core::samurai_replicator::SessionTeardown = Arc::new(move |session_id| {
        let pm = teardown_pm.clone();
        let status = teardown_status.clone();
        let watcher = teardown_watcher.clone();
        let context = teardown_context.clone();
        Box::pin(async move {
            // Mirrors commands::terminal::kill_session: PTY tree
            // kill, status-server unregister, transcript watcher
            // release, stale-context removal.
            if let Err(e) = pm.kill_session(session_id).await {
                log::warn!("samurai replicator: kill_session({session_id}) failed: {e}");
            }
            status.unregister_session(session_id).await;
            watcher.stop_watching(session_id);
            context.remove(session_id);
        })
    });
    let spawn_event_handle = app.handle().clone();
    let emit_spawn: core::samurai_replicator::SuccessorEmitter = Arc::new(move |spawn| {
        let _ = spawn_event_handle.emit("samurai-spawn-successor", spawn);
    });
    // Issue #56: transcript resolution for the recovery digest. The
    // watcher usually still tails a DEAD session (the watchdog never
    // stops it); when it does not, fall back to the newest transcript
    // in the session's Claude project directory. The fallback does
    // blocking FS work (canonicalize + read_dir + metadata), so the
    // replicator invokes this resolver via spawn_blocking only —
    // never inline on the runtime or a notify callback.
    let transcript_watcher_for_recovery = app.state::<Arc<TranscriptWatcher>>().inner().clone();
    let recovery_dirs_handle = app.handle().clone();
    let transcript_paths: core::samurai_replicator::TranscriptPathResolver =
        Arc::new(move |session_id| {
            transcript_watcher_for_recovery
                .transcript_path(session_id)
                .or_else(|| {
                    let dir = recovery_dirs_handle
                        .state::<SessionManager>()
                        .get_session(session_id)
                        .map(|s| s.working_directory.unwrap_or(s.project_path))?;
                    commands::claude_sessions::newest_transcript_for_project(&dir)
                })
        });
    let ritual_pm = app.state::<ProcessManager>().inner().clone();
    let ritual_writer: core::samurai_replicator::StdinWriter =
        Arc::new(move |session_id, data, outcome| {
            // Text, then a separate Enter (samurai_pty) — one
            // text-plus-CR write is read as a paste and never
            // submits. Both frames go to the blocking pool. The
            // outcome callback (issue #109) reports whether the body
            // write landed — the replicator's delivered row and
            // Enter-resend watch hang off it.
            core::samurai_pty::submit_instruction(
                ritual_pm.clone(),
                session_id,
                data,
                "replicator",
                outcome,
            );
        });
    // Issue #103: the Enter-only resend for the post-delivery watch
    // — when a typed-in instruction (the gen-1 launch brief above
    // all) shows no turn activity, the replicator re-sends the lone
    // submit key. NEVER the body: it already sits in the input box.
    let resend_pm = app.state::<ProcessManager>().inner().clone();
    let enter_resender: core::samurai_replicator::EnterResender = Arc::new(move |session_id| {
        core::samurai_pty::resend_submit(resend_pm.clone(), session_id, "replicator");
    });
    // The parker (issue #60) tears parked sessions down with this
    // same closure — a PARKED terminal serves no purpose, every
    // wake-up is a fresh spawn (PRD decision #6).
    let teardown_for_parker = teardown.clone();
    // …and so does the completion watcher (issue #96): a verified
    // run ends its agent instead of leaving it idle.
    let teardown_for_completion = teardown.clone();
    let replicator = Arc::new(core::samurai_replicator::SamuraiReplicator::new(
        supervisor.clone(),
        audit_log.clone(),
        samurai_config.clone(),
        session_dirs.clone(),
        transcript_paths,
        teardown,
        emit_spawn,
        ritual_writer,
        enter_resender,
    ));
    app.manage(replicator.clone());
    // Arms the DEAD → recovery chain in the supervisor callback.
    let _ = samurai_replicator_slot.set(replicator.clone());

    // The injector delivers through the same writer contract as the
    // replicator (issue #109): body write + separate Enter, with the
    // delivered row and Enter-resend watch riding the verdict.
    let injector_pm = app.state::<ProcessManager>().inner().clone();
    let injector_writer: core::samurai_replicator::StdinWriter =
        Arc::new(move |session_id, data, outcome| {
            core::samurai_pty::submit_instruction(
                injector_pm.clone(),
                session_id,
                data,
                "injector",
                outcome,
            );
        });
    let injector = Arc::new(SamuraiInjector::new(
        supervisor.clone(),
        samurai_context.clone(),
        samurai_config.clone(),
        injector_writer,
        audit_log.clone(),
        session_dirs.clone(),
        Some(replicator.clone()),
    ));
    // Managed for the same teardown propagation as the progress
    // tracker above (finding H): pending instruction + idle flag.
    app.manage(injector.clone());
    let _ = samurai_injector.set(injector.clone());
    // Issue #118: the blindness self-heal. A session whose transcript
    // stream silently died is force-restarted on the transcript it is
    // REGISTERED against, instead of staying blind for the rest of
    // the run. Fix C3 (issue #131 review 2): only that registered
    // path — a session with none gets the `context_blind` ALERT, not
    // a guess at "the newest file in the project directory", which
    // for a multi-generation run is the PREDECESSOR's transcript.
    let rewatch_watcher = app.state::<Arc<TranscriptWatcher>>().inner().clone();
    injector.set_rewatcher(Arc::new(move |session_id| {
        rewatch_watcher.rewatch_registered(session_id)
    }));
    core::samurai_injector::spawn_injector(injector.clone());

    // Samurai (issue #59): per-epic run-config store + persisted
    // resume timers. Both managed so the later command layers reach
    // them via `app.state()`.
    let run_configs = Arc::new(core::samurai_run_config::RunConfigStore::new(
        commands::ai_runner::artifact_base_dir("runs"),
    ));
    app.manage(run_configs.clone());
    // Issue #139: PR-review run records, inside the same `runs` root
    // so they fall under the existing managed-delete guard.
    let pr_runs = Arc::new(core::samurai_pr_runs::PrRunStore::new(
        commands::ai_runner::artifact_base_dir("runs"),
    ));
    app.manage(pr_runs.clone());
    // PRD §8 row 1 (issue #45's `handoff_retention_days`): handoff
    // files auto-clean once their epic has completed — i.e. its run
    // config is ARCHIVED. One sweep per app start: it is the only
    // moment every stored config is looked at, and the window is
    // measured in days, so a periodic tick would be pure noise.
    {
        let retention_days = samurai_config
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .handoff_retention_days;
        let swept = core::samurai_files::sweep_handoff_retention(
            &run_configs.list_with_paths(),
            retention_days,
        );
        if !swept.is_empty() {
            log::info!(
                "samurai retention: removed {} handoff file(s) older than {retention_days} days from archived epics",
                swept.len()
            );
        }
        // Issue #145: the same window, same mtime basis, for the
        // briefs PR reviews leave in the user's own checkout — no run
        // config ever archives those, so nothing swept them. Startup
        // is before any terminal exists, so NO session is open: that
        // is the honest input here, and the age gate is what protects
        // a review that is genuinely still running.
        let swept_briefs = core::samurai_files::sweep_pr_review_briefs(
            &pr_runs.list_with_paths(),
            &std::collections::HashSet::new(),
            retention_days,
        );
        if !swept_briefs.is_empty() {
            log::info!(
                "samurai retention: removed {} PR review brief(s) older than {retention_days} days",
                swept_briefs.len()
            );
        }
    }
    // Review F4: the replicator resolves the per-run `model` at
    // spawn-emit time, and the injector's trigger pass consults the
    // per-run `thresholds` override (handoff trigger only — park
    // thresholds stay global, see allowance_watcher). Late-bound
    // like set_absorber/set_parker: the store is constructed after
    // both controllers.
    replicator.set_run_configs(run_configs.clone());
    injector.set_run_configs(run_configs.clone());
    // Issue #209: a circuit-breaker trip stamps `parked` on the run
    // config, so the park survives a restart and the Active Runs row
    // can offer the human's one-click resume. Late-bound for the same
    // reason as the two above — the store is built after the tracker.
    if let Some(progress) = samurai_progress_slot.get() {
        progress.set_run_configs(run_configs.clone());
    }
    // Samurai (issue #96): run completion, DECLARE + VERIFY. The
    // orchestrator's `<samurai-run-complete>` declaration (scanned on
    // the EventBus tee above) is verified against GitHub — the
    // claimed PR OPEN with every claimed issue CLOSED or linked for
    // close by it, or the PR MERGED with every claimed issue CLOSED
    // (review F3) — before the run config flips ACTIVE → COMPLETED
    // and the §5.10 COMPLETE row lands. The probes shell out via the
    // same `github::GitHub` runner as the preflight/auth checks and
    // carry the run's `--repo` pin when one is stored (review F1);
    // injected (the AuthProbe pattern) so the module never touches
    // `gh` in tests.
    let issue_state_probe: core::samurai_completion::IssueStateProbe =
        Arc::new(|project: String, repo_pin: Option<String>, number: u64| {
            Box::pin(async move {
                github::GitHub::new(project)
                    .get_issue_state(number, repo_pin.as_deref())
                    .await
                    .map_err(|e| e.to_string())
            })
        });
    let pr_state_probe: core::samurai_completion::PrStateProbe =
        Arc::new(|project: String, repo_pin: Option<String>, number: u64| {
            Box::pin(async move {
                github::GitHub::new(project)
                    .get_pull_request_completion(number, repo_pin.as_deref())
                    .await
                    .map(
                        |(state, closing_issues)| core::samurai_completion::PrProbe {
                            state,
                            closing_issues,
                        },
                    )
                    .map_err(|e| e.to_string())
            })
        });
    // A verified completion ENDS the run's agent: same teardown
    // closure the replicator and parker use (PTY tree kill, status
    // unregister, watcher release, context drop). The tile is left
    // alone on purpose — the completion path removes the supervisor
    // entry instead of transitioning to KILLED, so no
    // `samurai-supervisor-event` fires and the frontend keeps the
    // finished terminal with its scrollback.
    let _ = samurai_completion.set(Arc::new(
        core::samurai_completion::SamuraiCompletionWatcher::new(
            supervisor.clone(),
            run_configs.clone(),
            audit_log.clone(),
            issue_state_probe,
            pr_state_probe,
            teardown_for_completion,
        ),
    ));
    // Samurai journal (Phase 5, issue #69): the ops-journal store —
    // an app-data JSONL where agents and the user record
    // bottlenecks/errors/improvements/skill gaps/concerns; the
    // interactive harvest consumes and archives entries via
    // markers. Mutex-serialized like the run-config store above.
    let journal_store = Arc::new(core::samurai_journal::JournalStore::new(
        commands::ai_runner::artifact_base_dir("journal"),
    ));
    app.manage(journal_store.clone());
    // Interactive harvest triage (issue #98): "Harvest now" opens a
    // terminal through the pending-launch flow; the grid arms the
    // session via `samurai_harvest_arm`, and the SessionStarted tap
    // in hook_emit_fn above injects the journal prompt through the
    // shared samurai PTY submit (text, gap, lone Enter — issue #103).
    // Consumption commits AT that injection (pinned #98 decision) —
    // and ONLY when the body write succeeds (review F1), which is
    // why this uses the confirmed submit variant: the closure runs
    // on the blocking pool (the hook tap's spawn_blocking above).
    let harvest_pm = app.state::<ProcessManager>().inner().clone();
    let harvest_deliver: commands::harvest::DeliverFn = Arc::new(move |session_id, prompt| {
        core::samurai_pty::submit_instruction_confirmed(
            harvest_pm.clone(),
            session_id,
            prompt,
            "harvest",
        )
    });
    // Every injection outcome reaches the Journal card: the panel
    // announces "triage session opened — N entries will be injected
    // there" at click time, so a failure that only reached the log
    // left the user believing the journal was triaged.
    let harvest_app = app.handle().clone();
    let harvest_notify: commands::harvest::HarvestNotifyFn = Arc::new(move |outcome| {
        let _ = harvest_app.emit(commands::harvest::HARVEST_EVENT, outcome);
    });
    // Issue #103, harvest edition: the triage paste is one of the
    // largest Maestro types, and its entries are CONSUMED the moment
    // the body lands — so a swallowed Enter would lose them behind a
    // prompt sitting unsent in the input box. Same watch the samurai
    // briefs get: released by hook-side turn activity, re-sends only
    // the Enter. Account-wide pseudo-project (allowance convention):
    // a harvest session belongs to no run.
    let harvest_replicator = replicator.clone();
    let harvest_watch: commands::harvest::HarvestDeliveredFn = Arc::new(move |session_id| {
        harvest_replicator.watch_delivery(
            core::allowance_watcher::ACCOUNT_PROJECT,
            "harvest",
            0,
            session_id,
        );
    });
    let harvest_triage = Arc::new(
        commands::harvest::HarvestTriage::new(
            journal_store.clone(),
            commands::harvest::downloads_dir_string(),
            harvest_deliver,
        )
        .with_notify(harvest_notify)
        .with_delivery_watch(harvest_watch)
        .with_session_dirs(session_dirs.clone()),
    );
    app.manage(harvest_triage.clone());
    let _ = harvest_triage_slot.set(harvest_triage);
    // Samurai (issue #61): the resume handler — a fired park timer
    // becomes a FRESH generation spawn (ACTIVE-run gate → guards →
    // working dir → next generation → RESUME row →
    // replicator.spawn_generation).
    // Constructed before the schedule because it IS the fire
    // callback; the schedule and parker are late-bound below (the
    // construction order is circular: schedule → resumer → parker →
    // schedule).
    let samurai_resumer = core::samurai_resumer::SamuraiResumer::new(
        supervisor.clone(),
        replicator.clone(),
        run_configs.clone(),
        audit_log.clone(),
    );
    let resumer_for_fire = samurai_resumer.clone();
    // Issue #61: every schedule mutation (arm/cancel/fire) pushes
    // the full timer list to the frontend — the park-countdown chip
    // stays live without polling.
    let schedule_event_handle = app.handle().clone();
    // Issue #129: scheduled-launch timers route to the launch
    // handler (async — spawned onto the runtime, which pulls its
    // dependencies from managed state at fire time); every other
    // reason keeps going to the resumer.
    let launch_fire_handle = app.handle().clone();
    let (samurai_schedule, samurai_schedule_task) = core::samurai_schedule::SamuraiSchedule::new(
        commands::ai_runner::artifact_base_dir("samurai"),
        Arc::new(move |entry: core::samurai_schedule::ScheduleEntry| {
            if entry.reason == core::samurai_schedule::REASON_SCHEDULED_LAUNCH {
                let handle = launch_fire_handle.clone();
                tauri::async_runtime::spawn(async move {
                    commands::samurai::handle_scheduled_launch_fire(handle, entry).await;
                });
            } else {
                resumer_for_fire.on_fire(entry);
            }
        }),
        Some(Arc::new(
            move |entries: &[core::samurai_schedule::ScheduleEntry]| {
                let _ = schedule_event_handle.emit("samurai-schedule-event", entries);
            },
        )),
    );
    // Issue #62: snapshot the pending timers BEFORE the fire loop is
    // spawned — a past-due entry fires on the loop's first tick and
    // self-cleans, so reading `list()` from the reconciliation task
    // later would race it and double-spawn the fired epic. A fire
    // cannot precede its own task spawn, so this snapshot is complete.
    // The fire loop itself is spawned BELOW, after `samurai_resumer
    // .bind(...)` — fires must never precede the bind (review F2):
    // a past-due timer firing in that gap would be dropped by the
    // resumer's unset OnceLocks yet still self-clean from
    // schedule.json, stranding the epic (the reconciler snapshot
    // lists it as timer-owned, so nothing respawns it either).
    let reconcile_timers = samurai_schedule.list();
    // Fix S3 (issue #131 review 2): a corrupt/truncated
    // schedule.json used to discard every pending timer behind a
    // log line. Surviving entries are now salvaged per-entry and
    // whatever was lost gets a durable, account-wide ALERT — a
    // dropped scheduled launch has no cold-start reconciliation
    // backstop, so nothing else would ever surface it.
    if let Some(details) = samurai_schedule.load_alert() {
        log::error!("samurai schedule: entries were dropped at load — {details}");
        audit_log.append(
            core::allowance_watcher::ACCOUNT_PROJECT,
            core::samurai_audit::AuditEvent::now(
                // Issue #139: never an empty run id — a dropped
                // scheduled launch belongs to the account.
                core::allowance_watcher::ACCOUNT_RUN,
                core::samurai_audit::AuditEventKind::Alert,
                0,
                0,
                details,
            ),
        );
    }
    app.manage(samurai_schedule.clone());

    // Samurai (issue #60): the allowance parker — the backend
    // consumer of the watcher's threshold events. Soft crossing →
    // wind-down instructions through the injector's ladder; hard
    // crossing → sequential park sweep (highest context first),
    // teardown per parked session, one persisted resume timer per
    // parked/absorbed epic. The injector chains park outcomes back
    // in (set_parker) and the replicator consults the parking-
    // engaged check before staging a successor (set_absorber).
    let samurai_parker = core::samurai_parker::SamuraiParker::new(
        supervisor.clone(),
        samurai_context.clone(),
        injector.clone(),
        samurai_schedule.clone(),
        audit_log.clone(),
        teardown_for_parker,
    );
    app.manage(samurai_parker.clone());
    // Issue #208: lets a released external park (auth restored) skip
    // a run that was completed or archived while it was parked.
    samurai_parker.set_run_configs(run_configs.clone());
    injector.set_parker(samurai_parker.clone());
    let parker_for_absorb = samurai_parker.clone();
    replicator.set_absorber(Arc::new(move |project: &str, epic: &str| {
        parker_for_absorb.absorb_handoff(project, epic)
    }));
    // Issue #61: closes the circular construction order — the
    // resumer can now re-arm deferred timers and consult the
    // parking-engaged guard.
    samurai_resumer.bind(samurai_schedule.clone(), samurai_parker.clone());
    // Issue #207: a resume spawn the frontend never took (the user
    // has the project closed) re-arms the resume timer instead of
    // ending as an ALERT with nothing left on disk.
    let resumer_for_drop = samurai_resumer.clone();
    replicator.set_spawn_dropped_hook(Arc::new(
        move |project: &str, epic: &str, generation: u32, trigger: &'static str| {
            resumer_for_drop.on_spawn_dropped(project, epic, generation, trigger)
        },
    ));
    // Issue #207: a RESTORED resume runs the same survivor check
    // every other startup spawn goes through before it spawns — the
    // reconciler's `orphan_verdict` over the watchdog's two real
    // probes (the worktree's newest transcript age, and whether any
    // claude is alive). Defined here rather than with the
    // reconciliation task below because the schedule's fire loop is
    // spawned a few lines down and its first tick fires every
    // past-due timer immediately.
    let transcript_ages: core::samurai_reconciler::TranscriptAgeProbe = Arc::new(|project| {
        commands::claude_sessions::newest_transcript_for_project(project)
            .and_then(|path| core::samurai_watchdog::transcript_age(&path))
    });
    let claude_alive: core::samurai_reconciler::ClaudeAliveProbe =
        Arc::new(|| !core::samurai_watchdog::scan_claude_ancestor_pids().is_empty());
    let transcript_ages_for_resume = transcript_ages.clone();
    let claude_alive_for_resume = claude_alive.clone();
    samurai_resumer.set_orphan_probe(Arc::new(move |worktree: &str| {
        core::samurai_reconciler::orphan_verdict(
            transcript_ages_for_resume(worktree),
            claude_alive_for_resume(),
            core::samurai_watchdog::TRANSCRIPT_STALE_AFTER,
        )
    }));
    // Issue #207: which runs had a timer on disk at startup. A
    // restored timer RESUMES (the park asked to be resumed at that
    // time; the app simply was not running then) — the flag decides
    // only whether the survivor check above runs and which ALERT an
    // unrecoverable run gets. Uses the same pre-fire-loop snapshot,
    // and must run BEFORE that loop is spawned below, or a past-due
    // entry could fire unmarked in the gap.
    samurai_resumer.mark_restored(&reconcile_timers);
    // Issue #129, same rule for scheduled launches: one whose picked
    // day+time passed while the app was closed is HELD — never
    // auto-fired on reopen — and waits for the user's explicit
    // launch-or-discard. Future-dated ones stay armed and fire at
    // their time. Must run BEFORE the fire loop spawns below, or the
    // first tick would fire the overdue entry unattended.
    let overdue_launches = samurai_schedule.hold_overdue_launches();
    if !overdue_launches.is_empty() {
        log::warn!(
            "samurai schedule: {} overdue scheduled launch(es) held at startup for launch-or-discard",
            overdue_launches.len(),
        );
    }
    // Ordering invariant (review F2): the schedule's fire loop is
    // spawned only AFTER the bind above — its first tick fires every
    // past-due timer immediately, and a fire before the bind would
    // hit unset OnceLocks (dropped resume) while still self-cleaning
    // the entry from schedule.json.
    tauri::async_runtime::spawn(samurai_schedule_task);

    // Samurai (issue #63): periodic gh auth re-check while any run
    // config is ACTIVE — corporate SSO tokens expire mid-run (PRD
    // §5.8: park + ALERT, not a crash loop). The probe is injected
    // (the reconciler's closure pattern); gh runs in the active
    // config's project directory — auth is account-global, the cwd
    // only anchors it to a repo.
    let auth_probe: core::samurai_auth_watch::AuthProbe = Arc::new(|project: String| {
        Box::pin(async move {
            github::GitHub::new(project)
                .auth_status()
                .await
                .map(|status| status.logged_in)
                .map_err(|e| e.to_string())
        })
    });
    // Both account-wide watchers are edge-triggered, so their
    // latches must survive a restart: without this store, reopening
    // the app while usage was still above a park threshold (or `gh`
    // still logged out) replayed the edge — duplicate ALERT rows and
    // a real park sweep, once per launch.
    let samurai_latches = Arc::new(core::samurai_latches::LatchStore::new(
        commands::ai_runner::artifact_base_dir("samurai"),
    ));

    core::samurai_auth_watch::spawn_auth_watch(
        run_configs.clone(),
        samurai_parker.clone(),
        auth_probe.clone(),
        samurai_latches.clone(),
    );

    core::allowance_watcher::spawn_allowance_loop(
        app.handle().clone(),
        samurai_config,
        supervisor.clone(),
        audit_log.clone(),
        samurai_parker,
        samurai_latches,
    );

    // Samurai (issue #62): cold-start reconciliation — PRD §5.6's
    // first-class flow. Runs ONCE, after every samurai component
    // above is constructed: for each ACTIVE run config, skip epics a
    // pending timer or live session already owns, and ALERT on the
    // rest (probable pre-restart survivor, interrupted run, or
    // nothing to resume from). It NEVER spawns an agent — reopening
    // the app must not start work nobody asked for, so resuming an
    // interrupted run is an explicit human act. It is not even
    // handed the replicator. The probes are the watchdog's process
    // scan and the project's newest transcript age — both real IO,
    // injected so the module stays harness-testable.
    // The probes above are shared with the restored-resume survivor
    // check (issue #207) — same IO, one definition.
    // The auth probe refines the interrupted-run alert: an epic
    // parked because gh auth died is exactly the one whose manual
    // resume would fail preflight (PRD §5.8), so the row says so.
    tauri::async_runtime::spawn(core::samurai_reconciler::reconcile_with_auth(
        run_configs,
        reconcile_timers,
        supervisor,
        audit_log,
        transcript_ages,
        claude_alive,
        auth_probe,
    ));
}
