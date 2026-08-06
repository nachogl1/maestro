mod commands;
mod core;
mod git;
mod github;

use std::sync::{Arc, Mutex};

use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, State};
use tauri_plugin_cli::CliExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Holds a CLI-argument project path captured at startup, before the frontend
/// has mounted. The frontend drains this via [`take_pending_cli_path`] once it
/// is ready to handle the event, which eliminates the old 500ms race.
#[derive(Default)]
struct PendingCliPath(Mutex<Option<String>>);

/// Frontend-invoked on mount to claim any project path passed on the CLI.
/// Subsequent invocations return `None`.
#[tauri::command]
fn take_pending_cli_path(state: State<'_, PendingCliPath>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

use core::marketplace_manager::MarketplaceManager;
use core::mcp_manager::McpManager;
use core::plugin_manager::PluginManager;
use core::status_server::StatusServer;
use core::samurai_audit::{AuditEvent, AuditLog};
use core::samurai_context::SamuraiContextStore;
use core::samurai_injector::SamuraiInjector;
use core::supervisor::{SessionSnapshot, Supervisor, SupervisorState};
use core::{ClaudeEvent, EventBus, TranscriptWatcher};
use core::ProcessManager;
use core::session_manager::SessionManager;
use core::worktree_manager::WorktreeManager;

/// Entry point for the Tauri application.
///
/// Registers plugins (store, dialog), injects shared state (ProcessManager,
/// SessionManager, WorktreeManager), verifies git availability at startup
/// (non-fatal -- logs an error but does not abort), and mounts all IPC
/// command handlers for the terminal, git, and session subsystems.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logger for RUST_LOG environment variable support
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    log::info!("Maestro starting up...");

    // `mut` is required on macOS (see the macos-permissions plugin block
    // below); on other platforms the cfg block is removed and `mut` becomes
    // unused, so we silence that warning explicitly.
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second instance was launched with these args — forward to the
            // existing (already-mounted) window. We scan every arg past the
            // executable for the first one that points at an existing path,
            // skipping flags. This tolerates the extra flags `open -b ...
            // --args` may prepend without letting a flag masquerade as the
            // project path.
            let resolved = args
                .iter()
                .skip(1)
                .find_map(|arg| commands::cli::resolve_existing_path_arg(arg));
            if let Some(p) = resolved {
                let _ = app.emit("cli-open-project", p.to_string_lossy().to_string());
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    // Register macOS permissions plugin (for Full Disk Access check)
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_plugin_macos_permissions::init());
    }

    builder
        .menu(|handle| {
            // App submenu (macOS standard items)
            let app_menu = SubmenuBuilder::new(handle, "Maestro")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            // Edit submenu
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            // View submenu with terminal font zoom controls
            let zoom_in = MenuItem::with_id(handle, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
            let zoom_out = MenuItem::with_id(handle, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
            let zoom_reset = MenuItem::with_id(handle, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&zoom_in)
                .item(&zoom_out)
                .separator()
                .item(&zoom_reset)
                .separator()
                .fullscreen()
                .build()?;

            // Window submenu (intentionally no Zoom/maximize item)
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .separator()
                .close_window()
                .build()?;

            MenuBuilder::new(handle)
                .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
                .build()
        })
        .on_menu_event(|app, event| {
            let id = event.id();
            match id.as_ref() {
                "zoom-in" | "zoom-out" | "zoom-reset" => {
                    if let Err(e) = app.emit("terminal-zoom", id.as_ref()) {
                        log::error!("Failed to emit terminal-zoom event: {}", e);
                    }
                }
                _ => {}
            }
        })
        .on_window_event(|window, event| {
            // Confirm before quitting while terminals are still running.
            // CloseRequested fires for the custom titlebar close button,
            // Alt+F4, and taskbar close; with zero terminals the window
            // closes silently. (The macOS app-menu Quit item bypasses
            // CloseRequested entirely — known gap.)
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let count = window.state::<ProcessManager>().session_count();
                if count == 0 {
                    return;
                }
                api.prevent_close();
                let win = window.clone();
                window
                    .dialog()
                    .message(format!(
                        "Quit Maestro? This will terminate {count} running terminal{}.",
                        if count == 1 { "" } else { "s" }
                    ))
                    .title("Quit Maestro")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::YesNo)
                    .show(move |confirmed| {
                        if !confirmed {
                            return;
                        }
                        let manager = win.state::<ProcessManager>().inner().clone();
                        tauri::async_runtime::spawn(async move {
                            // Kill the shells so they don't outlive the app,
                            // then destroy() the window — destroy bypasses
                            // CloseRequested, so this cannot re-prompt.
                            if let Err(e) = manager.kill_all_sessions().await {
                                log::warn!("Failed to kill sessions during quit: {e}");
                            }
                            if let Err(e) = win.destroy() {
                                log::error!("Failed to destroy window during quit: {e}");
                            }
                        });
                    });
            }
        })
        .manage(MarketplaceManager::new())
        .manage(McpManager::new())
        .manage(PluginManager::new())
        .manage(ProcessManager::new())
        .manage(SessionManager::new())
        .manage(WorktreeManager::new())
        .manage(commands::system::SystemMetricsState::new())
        .manage(commands::processes::ProcessScanState::new())
        .setup(|app| {
            // Generate a unique instance ID for this Maestro run
            // This prevents status pollution between different app instances
            let instance_id = uuid::Uuid::new_v4().to_string();
            log::info!("Maestro instance ID: {}", instance_id);

            // Create EventBus - emits events to frontend via Tauri.
            //
            // Events are batched rather than emitted one IPC message at a time:
            // a SessionStart hook (launch, /clear, `claude --resume`) replays the
            // whole transcript from byte 0, which pushes ~2000 events through here
            // back-to-back. Time-based coalescing mirrors the PTY output path
            // (see core::process_manager, FLUSH_INTERVAL) — accumulate into a
            // shared buffer and flush every 16ms (60fps) or once the buffer fills,
            // whichever comes first. Order is preserved: the buffer is a Vec
            // drained from the front.
            const MAX_BATCH_EVENTS: usize = 256;
            let app_handle_for_bus = app.handle().clone();
            let pending_events: Arc<Mutex<Vec<ClaudeEvent>>> = Arc::new(Mutex::new(Vec::new()));
            // `data_ready` wakes the idle drain task; `flush_now` cuts the
            // coalescing window short when the buffer is already large, so a
            // full-transcript replay ships as several medium messages instead of
            // one huge one.
            let data_ready = Arc::new(tokio::sync::Notify::new());
            let flush_now = Arc::new(tokio::sync::Notify::new());

            // Samurai (issue #52): backend tee. The context store observes
            // every deduped event before it enters the frontend batch buffer,
            // retaining the latest context % per session for Phase 2's
            // handoff trigger and ACK scanner. Observation only — the
            // batching path below is unchanged.
            let samurai_context = Arc::new(SamuraiContextStore::new());

            // Samurai (issue #53): the injection controller is constructed
            // further down (it needs the supervisor/config/audit created
            // there), but both event tees are built here — a late-bound slot
            // bridges the gap. Events arriving before it is filled concern no
            // supervised session and are safely ignored.
            let samurai_injector: Arc<std::sync::OnceLock<Arc<SamuraiInjector>>> =
                Arc::new(std::sync::OnceLock::new());

            let pending_for_emit = pending_events.clone();
            let data_ready_for_emit = data_ready.clone();
            let flush_now_for_emit = flush_now.clone();
            let samurai_context_for_emit = samurai_context.clone();
            let samurai_injector_for_emit = samurai_injector.clone();
            let emit_fn: Arc<dyn Fn(ClaudeEvent) + Send + Sync> = Arc::new(move |event: ClaudeEvent| {
                samurai_context_for_emit.observe(&event);
                // Samurai (issue #53): ACK scanning over AssistantMessage.
                if let Some(injector) = samurai_injector_for_emit.get() {
                    injector.observe(&event);
                }
                // Recover from a poisoned lock rather than dropping the event —
                // losing one silently would corrupt the frontend's activity feed.
                let len = {
                    let mut buf = pending_for_emit
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    buf.push(event);
                    buf.len()
                };
                data_ready_for_emit.notify_one();
                if len >= MAX_BATCH_EVENTS {
                    flush_now_for_emit.notify_one();
                }
            });

            tauri::async_runtime::spawn(async move {
                const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(16);
                loop {
                    // Idle: park until a producer signals there is something to
                    // send. `notify_one` stores a permit when nobody is waiting,
                    // so an event pushed mid-flush cannot be stranded.
                    data_ready.notified().await;

                    tokio::select! {
                        _ = tokio::time::sleep(FLUSH_INTERVAL) => {}
                        _ = flush_now.notified() => {}
                    }

                    // Emit in bounded chunks: a 2000-event replay becomes a
                    // handful of medium messages rather than one huge one.
                    loop {
                        let batch: Vec<ClaudeEvent> = {
                            let mut buf = pending_events
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            if buf.is_empty() {
                                break;
                            }
                            let take = buf.len().min(MAX_BATCH_EVENTS);
                            buf.drain(..take).collect()
                        };
                        let _ = app_handle_for_bus.emit("claude-events", &batch);
                    }
                }
            });

            let event_bus = Arc::new(EventBus::new(emit_fn));

            // Create TranscriptWatcher
            let transcript_watcher = Arc::new(TranscriptWatcher::new(event_bus.clone()));

            // Create hook emit callback
            // When SessionStarted events arrive via hooks, start watching the transcript
            let event_bus_for_hooks = event_bus.clone();
            let transcript_watcher_for_hooks = transcript_watcher.clone();
            let samurai_injector_for_hooks = samurai_injector.clone();
            let hook_emit_fn: Arc<dyn Fn(ClaudeEvent) + Send + Sync> = Arc::new(move |event: ClaudeEvent| {
                if let ClaudeEvent::SessionStarted { session_id, ref transcript_path, .. } = event {
                    transcript_watcher_for_hooks.start_watching(
                        session_id,
                        std::path::PathBuf::from(transcript_path),
                    );
                }
                // Samurai (issue #53): idle-gate signal (Stop hook →
                // SessionEnded reason "stop"). Tapped here, pre-dedup: the
                // EventBus dedup key for SessionEnded ignores the reason, so
                // a Stop landing within the 5s window of another SessionEnded
                // would never reach a bus-side tee.
                if let Some(injector) = samurai_injector_for_hooks.get() {
                    injector.observe_hook(&event);
                }
                event_bus_for_hooks.emit(event);
            });

            // Start the HTTP status server for MCP status reporting
            // IMPORTANT: This must be done synchronously so the server is ready
            // before any commands try to use it
            let app_handle = app.handle().clone();
            let server = tauri::async_runtime::block_on(async {
                StatusServer::start(app_handle, instance_id, Some(hook_emit_fn)).await
            });

            match server {
                Some(server) => {
                    log::info!(
                        "Status server started on port {}, URL: {}",
                        server.port(),
                        server.status_url()
                    );
                    app.manage(Arc::new(server));
                }
                None => {
                    log::error!("Failed to start status server - MCP status reporting will not work");
                    // Return error to prevent app from starting without status server
                    return Err("Failed to start status server".into());
                }
            }

            app.manage(event_bus);
            app.manage(transcript_watcher);

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

            // Samurai silent-death watchdog (issue #44): one periodic tick
            // that declares a supervised session DEAD when its transcript
            // went stale AND no claude process survives under its shell.
            // The DEAD transition chains through the supervisor callback
            // above into the replicator's recovery spawn (issue #56).
            core::samurai_watchdog::spawn_watchdog(
                supervisor.clone(),
                app.state::<Arc<TranscriptWatcher>>().inner().clone(),
                app.state::<ProcessManager>().inner().clone(),
            );

            // Samurai (issue #45): thresholds config + backend allowance
            // watcher. The config is seeded from the settings store and
            // shared (Arc<RwLock<…>>) between the get/set commands and the
            // allowance loop, which polls the usage API on its own ~60s
            // timer — independent of the frontend — and emits edge-triggered
            // ALERT audit rows + `samurai-allowance-event` on threshold
            // crossings (events only; parking is Phase 3).
            let samurai_config: core::samurai_config::SharedSamuraiConfig = Arc::new(
                std::sync::RwLock::new(commands::samurai::load_config_from_store(app.handle())),
            );
            app.manage(samurai_config.clone());

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
            let session_dirs: core::samurai_injector::SessionDirResolver =
                Arc::new(move |session_id| {
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
            let (samurai_progress, samurai_progress_task) =
                core::samurai_progress::SamuraiProgress::new(
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
            let teardown: core::samurai_replicator::SessionTeardown =
                Arc::new(move |session_id| {
                    let pm = teardown_pm.clone();
                    let status = teardown_status.clone();
                    let watcher = teardown_watcher.clone();
                    let context = teardown_context.clone();
                    Box::pin(async move {
                        // Mirrors commands::terminal::kill_session: PTY tree
                        // kill, status-server unregister, transcript watcher
                        // release, stale-context removal.
                        if let Err(e) = pm.kill_session(session_id).await {
                            log::warn!(
                                "samurai replicator: kill_session({session_id}) failed: {e}"
                            );
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
                Arc::new(move |session_id, data| {
                    // write_stdin is fully blocking (same policy as the
                    // injector's spawn_write) — blocking pool, never inline.
                    let pm = ritual_pm.clone();
                    tauri::async_runtime::spawn(async move {
                        match tokio::task::spawn_blocking(move || pm.write_stdin(session_id, &data))
                            .await
                        {
                            Ok(Ok(())) => {}
                            Ok(Err(e)) => log::warn!(
                                "samurai replicator: writing ritual to session {session_id} failed: {e}"
                            ),
                            Err(e) => log::warn!(
                                "samurai replicator: ritual write task for session {session_id} failed: {e}"
                            ),
                        }
                    });
                });
            let replicator = Arc::new(core::samurai_replicator::SamuraiReplicator::new(
                supervisor.clone(),
                audit_log.clone(),
                samurai_config.clone(),
                session_dirs.clone(),
                transcript_paths,
                teardown,
                emit_spawn,
                ritual_writer,
            ));
            app.manage(replicator.clone());
            // Arms the DEAD → recovery chain in the supervisor callback.
            let _ = samurai_replicator_slot.set(replicator.clone());

            let injector = Arc::new(SamuraiInjector::new(
                supervisor.clone(),
                samurai_context.clone(),
                samurai_config.clone(),
                app.state::<ProcessManager>().inner().clone(),
                audit_log.clone(),
                session_dirs,
                Some(replicator),
            ));
            // Managed for the same teardown propagation as the progress
            // tracker above (finding H): pending instruction + idle flag.
            app.manage(injector.clone());
            let _ = samurai_injector.set(injector.clone());
            core::samurai_injector::spawn_injector(injector);

            core::allowance_watcher::spawn_allowance_loop(
                app.handle().clone(),
                samurai_config,
                supervisor,
                audit_log,
            );

            // Samurai (issue #59): per-epic run-config store + persisted
            // resume timers. Foundation only — P3.2 (park) arms timers and
            // saves configs; P3.3 (issue #61) replaces the logging stub
            // below with the real resume spawn. Both managed so the later
            // command layers reach them via `app.state()`.
            let run_configs = Arc::new(core::samurai_run_config::RunConfigStore::new(
                commands::ai_runner::artifact_base_dir("runs"),
            ));
            app.manage(run_configs);
            let (samurai_schedule, samurai_schedule_task) =
                core::samurai_schedule::SamuraiSchedule::new(
                    commands::ai_runner::artifact_base_dir("samurai"),
                    // TODO(#61): wire to the real resume spawn (fresh gen
                    // from the handoff file). Log-only until then.
                    Arc::new(|entry: core::samurai_schedule::ScheduleEntry| {
                        log::info!(
                            "samurai schedule: resume timer fired for epic {} in {} \
                             (reason: {}) — resume spawning lands in P3.3",
                            entry.epic,
                            entry.project_path,
                            entry.reason,
                        );
                    }),
                );
            tauri::async_runtime::spawn(samurai_schedule_task);
            app.manage(samurai_schedule);

            // GitHub watchdog: background poller for review requests /
            // assigned issues across all configured projects. The frontend
            // syncs the project set via `github_watchdog_set_projects`.
            let watchdog = Arc::new(github::GitHubWatchdog::new());
            app.manage(watchdog.clone());
            github::watchdog::spawn_watchdog(watchdog, app.handle().clone());

            // Capture any CLI-supplied path into PendingCliPath state. The
            // frontend drains this on mount via `take_pending_cli_path`, which
            // avoids the fragile "wait N ms then emit" race.
            let pending = PendingCliPath::default();
            if let Ok(matches) = app.cli().matches() {
                if let Some(path_arg) = matches.args.get("path") {
                    if let Some(path_str) = path_arg.value.as_str() {
                        if !path_str.is_empty() {
                            if let Some(resolved) = commands::cli::resolve_cli_path(path_str) {
                                if let Ok(mut slot) = pending.0.lock() {
                                    *slot = Some(resolved.to_string_lossy().into_owned());
                                }
                            }
                        }
                    }
                }
            }
            app.manage(pending);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // PTY commands (existing)
            commands::terminal::spawn_shell,
            commands::terminal::write_stdin,
            commands::terminal::resize_pty,
            commands::terminal::kill_session,
            commands::terminal::kill_all_sessions,
            commands::terminal::check_cli_available,
            commands::terminal::get_backend_info,
            commands::terminal::save_pasted_image,
            // Git commands
            commands::git::git_branches,
            commands::git::git_current_branch,
            commands::git::git_uncommitted_count,
            commands::git::git_worktree_list,
            commands::git::git_worktree_add,
            commands::git::git_worktree_remove,
            commands::git::git_worktree_status,
            commands::git::git_worktrees_status,
            commands::git::git_discard_file,
            commands::git::git_remove_file,
            commands::git::git_file_diff,
            commands::git::git_commit_log,
            commands::git::git_checkout_branch,
            commands::git::git_create_branch,
            commands::git::git_delete_branch,
            commands::git::git_rename_branch,
            commands::git::git_delete_remote_branch,
            commands::git::git_commit_files,
            commands::git::git_user_config,
            commands::git::git_set_user_config,
            commands::git::git_list_remotes,
            commands::git::git_add_remote,
            commands::git::git_remove_remote,
            commands::git::git_refs_for_commit,
            commands::git::git_fetch,
            commands::git::git_fetch_all,
            commands::git::git_test_remote,
            commands::git::git_set_remote_url,
            commands::git::git_get_default_branch,
            commands::git::git_set_default_branch,
            commands::git::is_git_repository,
            commands::git::is_git_worktree,
            commands::git::detect_repositories,
            // Claude session history
            commands::claude_sessions::list_claude_sessions,
            commands::claude_sessions::delete_claude_session,
            // Session commands (new)
            commands::session::get_sessions,
            commands::session::create_session,
            commands::session::update_session_status,
            commands::session::assign_session_branch,
            commands::session::rename_session,
            commands::session::remove_session,
            commands::session::get_sessions_for_project,
            commands::session::remove_sessions_for_project,
            // Worktree commands
            commands::worktree::prepare_session_worktree,
            commands::worktree::cleanup_session_worktree,
            commands::worktree::get_default_worktree_base_dir,
            commands::worktree::has_managed_worktree,
            // MCP commands
            commands::mcp::get_project_mcp_servers,
            commands::mcp::refresh_project_mcp_servers,
            commands::mcp::get_session_mcp_servers,
            commands::mcp::set_session_mcp_servers,
            commands::mcp::get_session_mcp_count,
            commands::mcp::save_project_mcp_defaults,
            commands::mcp::load_project_mcp_defaults,
            commands::mcp::add_mcp_project,
            commands::mcp::remove_mcp_project,
            commands::mcp::remove_session_status,
            commands::mcp::write_session_mcp_config,
            commands::mcp::remove_session_mcp_config,
            commands::mcp::write_opencode_mcp_config,
            commands::mcp::remove_opencode_mcp_config,
            commands::mcp::generate_project_hash,
            commands::mcp::get_custom_mcp_servers,
            commands::mcp::save_custom_mcp_server,
            commands::mcp::delete_custom_mcp_server,
            commands::mcp::get_status_server_info,
            commands::mcp::get_mcp_status,
            commands::mcp::upsert_mcp_server,
            commands::mcp::remove_mcp_server,
            commands::mcp::set_mcp_server_enabled,
            // Plugin commands
            commands::plugin::get_project_plugins,
            commands::plugin::refresh_project_plugins,
            commands::plugin::get_session_skills,
            commands::plugin::set_session_skills,
            commands::plugin::get_session_plugins,
            commands::plugin::set_session_plugins,
            commands::plugin::get_session_skills_count,
            commands::plugin::get_session_plugins_count,
            commands::plugin::save_project_skill_defaults,
            commands::plugin::load_project_skill_defaults,
            commands::plugin::save_project_plugin_defaults,
            commands::plugin::load_project_plugin_defaults,
            commands::plugin::write_session_plugin_config,
            commands::plugin::remove_session_plugin_config,
            commands::plugin::delete_skill,
            commands::plugin::delete_plugin,
            commands::plugin::save_branch_config,
            commands::plugin::load_branch_config,
            // Marketplace commands
            commands::marketplace::load_marketplace_data,
            commands::marketplace::get_marketplace_sources,
            commands::marketplace::add_marketplace_source,
            commands::marketplace::remove_marketplace_source,
            commands::marketplace::toggle_marketplace_source,
            commands::marketplace::refresh_marketplace,
            commands::marketplace::refresh_all_marketplaces,
            commands::marketplace::get_available_plugins,
            commands::marketplace::get_installed_plugins,
            commands::marketplace::install_marketplace_plugin,
            commands::marketplace::uninstall_plugin,
            commands::marketplace::is_marketplace_plugin_installed,
            commands::marketplace::get_session_marketplace_config,
            commands::marketplace::set_marketplace_plugin_enabled,
            commands::marketplace::clear_session_marketplace_config,
            // ClaudeMd commands
            commands::claudemd::check_claude_md,
            commands::claudemd::read_claude_md,
            commands::claudemd::write_claude_md,
            commands::claudemd::list_context_docs,
            commands::claudemd::read_context_doc,
            commands::claudemd::write_context_doc,
            // Claude auto-memory commands
            commands::memory::list_memory_projects,
            commands::memory::list_memory_files,
            commands::memory::read_memory_file,
            commands::memory::write_memory_file,
            commands::memory::delete_memory_file,
            commands::memory::delete_memory_project,
            // Font detection commands
            commands::fonts::get_available_fonts,
            commands::fonts::check_font_available,
            // Usage tracking commands
            commands::usage::get_claude_usage,
            commands::usage::get_claude_account,
            // System metrics
            commands::system::get_system_metrics,
            // Dev process / container visibility (Processes sidebar section)
            commands::processes::list_dev_processes,
            commands::processes::kill_process_tree,
            commands::processes::list_docker_containers,
            commands::processes::stop_docker_container,
            // GitHub commands
            commands::github::github_auth_status,
            commands::github::github_list_prs,
            commands::github::github_get_pr,
            commands::github::github_create_pr,
            commands::github::github_merge_pr,
            commands::github::github_close_pr,
            commands::github::github_comment_pr,
            commands::github::github_list_issues,
            commands::github::github_list_discussions,
            commands::github::github_get_issue,
            commands::github::github_comment_issue,
            commands::github::github_close_issue,
            commands::github::github_reopen_issue,
            commands::github::github_get_discussion,
            commands::github::github_comment_discussion,
            commands::github::github_watchdog_set_projects,
            // Update commands
            commands::update::check_for_updates,
            commands::update::download_and_install_update,
            commands::update::get_app_version,
            // Hooks commands
            commands::hooks::write_session_hooks_config,
            commands::hooks::remove_session_hooks_config,
            // Agent graph commands
            commands::agents::export_agent_run,
            // Standup report commands
            commands::standup::generate_standup_report,
            commands::standup::get_default_standup_prompt,
            commands::standup::load_standup_report,
            // Daily plan commands (one plan across all open projects)
            commands::plan::generate_daily_plan,
            commands::plan::load_daily_plan,
            // Project feature catalogue (on-demand scan, one per project)
            commands::catalog::scan_project_catalog,
            commands::catalog::cancel_project_catalog,
            commands::catalog::load_project_catalog,
            // Samurai supervisor + audit log (Phase 1)
            commands::samurai::samurai_register_session,
            commands::samurai::samurai_transition,
            commands::samurai::samurai_list_sessions,
            commands::samurai::samurai_audit_read,
            commands::samurai::samurai_audit_clear,
            commands::samurai::samurai_get_config,
            commands::samurai::samurai_set_config,
            // CLI commands
            commands::cli::install_cli,
            commands::cli::uninstall_cli,
            commands::cli::is_cli_installed,
            take_pending_cli_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Maestro");
}

// Note: We intentionally don't check git availability at startup.
// Spawning processes during Tauri's app initialization phase can cause
// crashes on some systems (particularly macOS with certain shell configurations).
// Git availability is checked lazily when git operations are performed,
// and the GitRunner handles GitNotFound errors gracefully.
