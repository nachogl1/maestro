//! The body of the Tauri `.setup` hook, split by subsystem. The phases run
//! in the same order the single closure used to: event bus → terminal/status
//! server → PR review records → GitHub watchdog → CLI path capture.

mod events;
mod terminal;

use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_cli::CliExt;

use crate::{commands, github, PendingCliPath};

/// Runs every startup initialization step. Called from `run()`'s `.setup`.
pub(crate) fn run_setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // First line of every run: the logger is attached by the plugin's
    // own setup, so anything logged before this point is dropped.
    log::info!("Maestro starting up...");

    // Generate a unique instance ID for this Maestro run
    // This prevents status pollution between different app instances
    let instance_id = uuid::Uuid::new_v4().to_string();
    log::info!("Maestro instance ID: {}", instance_id);
    #[cfg(windows)]
    crate::core::cli_path::log_adopted_path();

    let event_bus = events::build_event_bus(app);
    terminal::setup_terminal(app, instance_id, event_bus)?;
    // Issue #139: PR-review run records, inside the app-data `runs` root.
    let pr_runs = Arc::new(crate::core::pr_runs::PrRunStore::new(
        commands::ai_runner::artifact_base_dir("runs"),
    ));
    // Issue #145: old PR review briefs are removed once per app start; the
    // window is measured in days, so a periodic tick would be pure noise.
    let swept_briefs = pr_runs.sweep_expired_briefs();
    if !swept_briefs.is_empty() {
        log::info!(
            "PR review retention: removed {} brief(s) older than {} days",
            swept_briefs.len(),
            crate::core::pr_runs::PR_REVIEW_BRIEF_RETENTION_DAYS
        );
    }
    app.manage(pr_runs);

    // Issue #615: on the first start without Samurai, remove what it left on
    // disk in the background; the front end asks which worktrees were kept.
    let cleanup_notice = Arc::new(crate::core::legacy_cleanup::CleanupNotice::default());
    app.manage(cleanup_notice.clone());
    let cleanup_roots = crate::core::legacy_cleanup::CleanupRoots {
        data_dir: commands::ai_runner::app_data_root(),
        settings_dir: app.path().app_data_dir().ok(),
    };
    // Its own thread: the deletes and link scans are blocking file work.
    let spawned = std::thread::Builder::new()
        .name("samurai-cleanup".to_string())
        .spawn(move || {
            let cleanup = crate::core::legacy_cleanup::run_once(&cleanup_roots);
            cleanup_notice.publish(tauri::async_runtime::block_on(cleanup));
        });
    if let Err(e) = spawned {
        log::warn!("samurai cleanup: could not start its thread: {e}");
    }

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
}
