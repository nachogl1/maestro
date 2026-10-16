mod commands;
mod core;
mod git;
mod github;
mod setup;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, State};
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
use core::session_manager::SessionManager;
use core::worktree_manager::WorktreeManager;
use core::ProcessManager;

/// Set once quitting is committed. The main window then stays up while the
/// Work Journal saves (up to 1.5 s); later close requests are ignored so a
/// second click cannot start a second save and destroy.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Entry point for the Tauri application.
///
/// Registers plugins (store, dialog), injects shared state (ProcessManager,
/// SessionManager, WorktreeManager), verifies git availability at startup
/// (non-fatal -- logs an error but does not abort), and mounts all IPC
/// The log level the file/stdout logger runs at. `RUST_LOG` still overrides
/// it, as it did under `env_logger`, but only as a bare level name (`debug`,
/// `trace`, …) — the per-module filter syntax is not carried over, since
/// nothing in this app used it.
fn log_level_from_env() -> log::LevelFilter {
    std::env::var("RUST_LOG")
        .ok()
        .and_then(|raw| raw.trim().parse::<log::LevelFilter>().ok())
        .unwrap_or(log::LevelFilter::Info)
}

/// command handlers for the terminal, git, and session subsystems.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Windows: an MSI-updater relaunch hands the app a PATH without the
    // user's entries, so `claude` is "not found" for every child process.
    // Repair it before anything is spawned (see core::cli_path).
    #[cfg(windows)]
    core::cli_path::adopt_user_path();

    // `mut` is required on macOS (see the macos-permissions plugin block
    // below); on other platforms the cfg block is removed and `mut` becomes
    // unused, so we silence that warning explicitly.
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        // Logging goes to a FILE, not just the console. A packaged Windows
        // build has no console attached, so the previous stderr-only logger
        // discarded every line — which is why a Samurai run that silently
        // failed to hand off left nothing to diagnose afterwards. The log
        // dir is the OS one for the bundle identifier
        // (`%LOCALAPPDATA%\com.maestro.app\logs\maestro.log` on Windows).
        // Stdout is kept so `tauri dev` still prints as before.
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("maestro".to_string()),
                    },
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .level(log_level_from_env())
                .max_file_size(10 * 1024 * 1024)
                // Three files of history: long enough to cover an overnight
                // autonomous run, bounded enough to never need a sweep.
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                // Timestamps must line up with what the user sees in the
                // audit panel and in their own terminal.
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
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
        .plugin(tauri_plugin_notification::init())
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
            // Only the main window quits the app; secondary windows (the
            // issue map) close silently and go away with the main one.
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::Destroyed = event {
                for (label, other) in window.app_handle().webview_windows() {
                    if label != "main" {
                        let _ = other.destroy();
                    }
                }
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    return;
                }
                let count = window.state::<ProcessManager>().session_count();
                if count == 0 {
                    // Work journal: save the text still waiting in its windows
                    // first; destroying them skips their own close-time save.
                    api.prevent_close();
                    if QUITTING.swap(true, Ordering::SeqCst) {
                        return;
                    }
                    let win = window.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::join!(
                            crate::core::work_journal_run::kill_running_runs(),
                            crate::core::work_journal_quit::flush_before_quit(win.app_handle())
                        );
                        if let Err(e) = win.destroy() {
                            log::error!("Failed to destroy window during quit: {e}");
                            // Let the user try again rather than ignore every later close.
                            QUITTING.store(false, Ordering::SeqCst);
                            crate::core::work_journal_run::reopen_runs();
                        }
                    });
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
                        // Cancel leaves the flag clear; a second confirmed
                        // dialog does nothing once quitting has started.
                        if !confirmed || QUITTING.swap(true, Ordering::SeqCst) {
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
                            // Work journal: record the close before the app goes.
                            crate::core::work_journal_activity::close_all_terminals().await;
                            // ...end its suggestion runs with their helper processes,
                            // and save the text still waiting in its windows.
                            tokio::join!(
                                crate::core::work_journal_run::kill_running_runs(),
                                crate::core::work_journal_quit::flush_before_quit(
                                    win.app_handle()
                                )
                            );
                            if let Err(e) = win.destroy() {
                                log::error!("Failed to destroy window during quit: {e}");
                                // Let the user try again rather than ignore every later close.
                                QUITTING.store(false, Ordering::SeqCst);
                                crate::core::work_journal_run::reopen_runs();
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
        // Issue #106 review F1: the per-(project, epic) in-flight launch
        // slots — the backend guard against a double Launch click while the
        // test gate still runs.
        .manage(std::sync::Arc::new(
            commands::samurai::LaunchInFlight::default(),
        ))
        .setup(setup::run_setup)
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
            commands::git::git_worktree_list,
            commands::git::git_worktree_add,
            commands::git::git_worktree_remove,
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
            commands::agent_names::list_live_agent_names,
            commands::agent_names::rename_agent,
            commands::session_summary::summarize_claude_session,
            // Work Journal file (load, pages, settings, backup)
            commands::work_journal::load_work_journal,
            commands::work_journal::create_work_journal_page,
            commands::work_journal::update_work_journal_page,
            commands::work_journal::delete_work_journal_page,
            commands::work_journal::update_work_journal_settings,
            commands::work_journal::work_journal_backup_now,
            commands::work_journal::work_journal_backup_if_due,
            commands::work_journal::work_journal_ensure_pages,
            commands::work_journal::work_journal_run_candidates,
            commands::work_journal::work_journal_granola_status,
            commands::work_journal::restore_work_journal,
            commands::work_journal::undo_work_journal_restore,
            commands::work_journal::work_journal_restore_state,
            commands::work_journal::list_work_journal_candidates,
            commands::work_journal::work_journal_pending_counts,
            commands::work_journal::reject_work_journal_candidate,
            commands::work_journal::accept_work_journal_candidate,
            commands::work_journal::work_journal_generate_report,
            // Session commands (new)
            commands::session::get_sessions,
            commands::session::create_session,
            commands::session::assign_session_branch,
            commands::session::rename_session,
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
            commands::mcp::write_session_mcp_config,
            commands::mcp::remove_session_mcp_config,
            commands::mcp::write_opencode_mcp_config,
            commands::mcp::remove_opencode_mcp_config,
            commands::mcp::generate_project_hash,
            commands::mcp::get_custom_mcp_servers,
            commands::mcp::save_custom_mcp_server,
            commands::mcp::delete_custom_mcp_server,
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
            commands::github::github_pr_for_branch,
            commands::github::github_create_pr,
            commands::github::github_list_issues,
            commands::github::github_issue_links,
            commands::github::github_list_assignees,
            commands::github::github_update_issue_assignees,
            commands::github::github_list_discussions,
            commands::github::github_get_issue,
            commands::github::github_comment_issue,
            commands::github::github_close_issue,
            commands::github::github_reopen_issue,
            commands::github::github_get_discussion,
            commands::github::github_comment_discussion,
            commands::github::github_watchdog_set_projects,
            commands::github::export_issue_map,
            // Update commands
            commands::update::check_for_updates,
            commands::update::download_and_install_update,
            commands::update::get_app_version,
            // Hooks commands
            commands::hooks::write_session_hooks_config,
            commands::hooks::remove_session_hooks_config,
            // Agent graph commands
            commands::agents::export_agent_run,
            // Samurai supervisor + audit log (Phase 1)
            commands::samurai::samurai_register_session,
            commands::samurai::samurai_revert_launch_line_prompt,
            commands::samurai::samurai_list_sessions,
            commands::samurai::samurai_audit_read,
            commands::samurai::samurai_audit_clear,
            commands::samurai::samurai_schedule_list,
            commands::samurai::samurai_schedule_launch,
            commands::samurai::samurai_recover_run,
            commands::samurai::samurai_resume_now,
            commands::samurai::samurai_get_config,
            commands::samurai::samurai_set_config,
            // Samurai run launcher (issue #63) + workflow graph (issue #91)
            commands::samurai::samurai_preflight,
            commands::samurai::samurai_launch_run,
            commands::samurai::samurai_default_workflow,
            commands::samurai::samurai_list_runs,
            commands::samurai::samurai_cleanup_epic,
            commands::samurai::samurai_abandon_run,
            // Samurai Second Brain file inventory (issue #65)
            commands::samurai::samurai_files_list,
            commands::samurai::samurai_file_delete,
            // Guarded read of any listed Samurai file (issue #82)
            commands::samurai::samurai_file_read,
            commands::samurai::samurai_timer_cancel,
            // Samurai journal (Phase 5, issue #69)
            commands::samurai::samurai_journal_add,
            commands::samurai::samurai_journal_list,
            // Per-entry journal delete (issue #100)
            commands::samurai::samurai_journal_delete,
            // Samurai harvest (issue #98: interactive triage session; the
            // read command keeps serving previously generated reports, and
            // samurai_harvest_list surfaces them to the Journal panel —
            // issue #142)
            commands::harvest::samurai_harvest_arm,
            commands::harvest::samurai_harvest_preview,
            commands::harvest::samurai_harvest_read,
            commands::harvest::samurai_harvest_list,
            // Generic "launch a terminal with an initial prompt" injection
            commands::initial_prompt::terminal_arm_initial_prompt,
            // Injector sidebar tab: one message into many terminals
            commands::injector::inject_message,
            commands::terminal::terminal_shell_family,
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
