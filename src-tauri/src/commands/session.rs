use std::path::Path;
use std::sync::Arc;

use tauri::State;

use crate::core::mcp_config_writer;
use crate::core::mcp_manager::McpManager;
use crate::core::plugin_manager::PluginManager;
use crate::core::process_manager::ProcessManager;
use crate::core::samurai_context::SamuraiContextStore;
use crate::core::samurai_injector::SamuraiInjector;
use crate::core::samurai_progress::SamuraiProgress;
use crate::core::session_manager::{AiMode, SessionConfig, SessionManager};
use crate::core::status_server::StatusServer;
use crate::core::supervisor::Supervisor;
use crate::core::transcript_watcher::TranscriptWatcher;

/// Exposes `SessionManager::all_sessions` to the frontend.
/// Returns a snapshot of all active sessions in arbitrary order.
#[tauri::command]
pub async fn get_sessions(state: State<'_, SessionManager>) -> Result<Vec<SessionConfig>, String> {
    Ok(state.all_sessions())
}

/// Exposes `SessionManager::create_session` to the frontend.
/// Registers a new session. Returns an error if the session ID already exists.
#[tauri::command]
pub async fn create_session(
    state: State<'_, SessionManager>,
    id: u32,
    mode: AiMode,
    project_path: String,
    working_directory: Option<String>,
) -> Result<SessionConfig, String> {
    // Canonicalize path for consistent storage
    let canonical = std::fs::canonicalize(&project_path)
        .map_err(|e| format!("Invalid project path '{}': {}", project_path, e))?
        .to_string_lossy()
        .into_owned();

    // Canonicalize working_directory too when provided — it may point at a
    // worktree or a sub-repo that differs from the workspace root.
    let canonical_wd = match working_directory {
        Some(wd) => {
            let c = std::fs::canonicalize(&wd)
                .map_err(|e| format!("Invalid working directory '{}': {}", wd, e))?
                .to_string_lossy()
                .into_owned();
            Some(c)
        }
        None => None,
    };

    state
        .create_session(id, mode, canonical, canonical_wd)
        .map_err(|existing| format!("Session {} already exists", existing.id))
}

/// Exposes `SessionManager::assign_branch` to the frontend.
/// Links a session to a branch and optional worktree path. Returns an error
/// string if the session does not exist.
#[tauri::command]
pub async fn assign_session_branch(
    state: State<'_, SessionManager>,
    session_id: u32,
    branch: String,
    worktree_path: Option<String>,
) -> Result<SessionConfig, String> {
    state
        .assign_branch(session_id, branch, worktree_path)
        .ok_or_else(|| format!("Session {} not found", session_id))
}

/// Renames a session. Empty or whitespace-only names are treated as `None`,
/// which resets the display name to the default `{provider} #{id}` format.
///
/// Issue #175: when the session is samurai-supervised, the name is ALSO
/// persisted onto the run's config (`display_name`), so every later
/// generation's spawn inherits it — a rename made on gen-1 survives into
/// gen-2 instead of dying with the killed session. Best effort: a config
/// that cannot be updated (legacy run, torn file) never fails the rename
/// itself. A reset (`None`) restores the run's default `Samurai-N`.
#[tauri::command]
pub async fn rename_session(
    state: State<'_, SessionManager>,
    supervisor: State<'_, Arc<Supervisor>>,
    run_configs: State<'_, Arc<crate::core::samurai_run_config::RunConfigStore>>,
    session_id: u32,
    name: Option<String>,
) -> Result<SessionConfig, String> {
    let normalized = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    let renamed = state
        .rename_session(session_id, normalized.clone())
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    if let Some(supervised) = supervisor
        .list_sessions()
        .into_iter()
        .find(|s| s.session_id == session_id)
    {
        if let Err(e) =
            run_configs.set_display_name(&supervised.project, &supervised.epic, normalized)
        {
            log::warn!(
                "rename: session {session_id} is supervised for epic {} but its run config could not store the name ({e}) — the rename will not survive a handoff",
                supervised.epic
            );
        }
    }
    Ok(renamed)
}

/// Gets all sessions for a specific project.
#[tauri::command]
pub async fn get_sessions_for_project(
    state: State<'_, SessionManager>,
    project_path: String,
) -> Result<Vec<SessionConfig>, String> {
    let canonical = std::fs::canonicalize(&project_path)
        .map_err(|e| format!("Invalid project path '{}': {}", project_path, e))?
        .to_string_lossy()
        .into_owned();

    Ok(state.get_sessions_for_project(&canonical))
}

/// Removes all sessions for a project (used when closing a project tab).
/// Also kills the associated PTY sessions and cleans up MCP/plugin state.
// Tauri resolves each `State` by type — closing a project has to tear down
// every subsystem that holds per-session state, and they arrive as injected
// parameters or not at all.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn remove_sessions_for_project(
    state: State<'_, SessionManager>,
    process_manager: State<'_, ProcessManager>,
    mcp_manager: State<'_, McpManager>,
    status_server: State<'_, Arc<StatusServer>>,
    plugin_manager: State<'_, PluginManager>,
    transcript_watcher: State<'_, Arc<TranscriptWatcher>>,
    samurai_context: State<'_, Arc<SamuraiContextStore>>,
    supervisor: State<'_, Arc<Supervisor>>,
    samurai_injector: State<'_, Arc<SamuraiInjector>>,
    samurai_progress: State<'_, Arc<SamuraiProgress>>,
    project_path: String,
) -> Result<Vec<SessionConfig>, String> {
    let canonical = std::fs::canonicalize(&project_path)
        .map_err(|e| format!("Invalid project path '{}': {}", project_path, e))?
        .to_string_lossy()
        .into_owned();

    let removed = state.remove_sessions_for_project(&canonical);

    // Clean up MCP, plugin, and PTY state for each removed session
    for session in &removed {
        // Clean up in-memory MCP and plugin state
        mcp_manager.remove_session(&canonical, session.id);
        plugin_manager.remove_session(&canonical, session.id);

        // Unregister session from status server
        status_server.unregister_session(session.id).await;

        // Release the transcript watcher (watchers are capped; leaked ones
        // eventually block new sessions from getting an activity feed)
        transcript_watcher.stop_watching(session.id);

        // Drop the samurai context entry — a stale percentage for a gone
        // session must never arm a handoff (issue #52)
        samurai_context.remove(session.id);

        // A supervised session closed by the project-close path leaves the
        // supervisor too (fresh-eyes finding H) — teardown, not a
        // transition: no event, no audit row (user-driven, UI-visible).
        supervisor.remove_session(session.id);
        samurai_injector.remove_session(session.id);
        samurai_progress.remove_session(session.id);

        // Clean up .mcp.json entry (use worktree_path if set, otherwise project_path)
        let working_dir = session
            .worktree_path
            .as_deref()
            .unwrap_or(&session.project_path);
        if let Err(e) =
            mcp_config_writer::remove_session_mcp_config(Path::new(working_dir), session.id).await
        {
            log::warn!(
                "Failed to remove MCP config for session {}: {}",
                session.id,
                e
            );
        }

        // Fire-and-forget kill -- log errors but don't fail the removal
        if let Err(e) = process_manager.kill_session(session.id).await {
            log::warn!("Failed to kill PTY for session {}: {}", session.id, e);
        }
    }

    log::debug!(
        "Removed {} sessions for project {}",
        removed.len(),
        canonical
    );

    Ok(removed)
}
