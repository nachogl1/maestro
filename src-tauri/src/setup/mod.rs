//! The body of the Tauri `.setup` hook, split by subsystem. The phases run
//! in the same order the single closure used to: event bus → terminal/status
//! server → Samurai → GitHub watchdog → CLI path capture.

mod events;
mod samurai;
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

    let (event_bus, tees) = events::build_event_bus(app);
    terminal::setup_terminal(app, instance_id, event_bus, &tees)?;
    samurai::setup_samurai(app, tees);

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
