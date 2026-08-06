//! Tauri commands for the Samurai supervisor state machine and audit log
//! (Phase 1 — see `docs/samurai/prd.md` §5.2 and §5.10).
//!
//! The register/transition commands exist so transitions can be driven
//! manually from the frontend for testing; Phases 2–3 wire real triggers.
//! Project paths are canonicalized (and the Windows `\\?\` prefix stripped)
//! at this boundary so every layer below sees one spelling per project.

use std::sync::Arc;

use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

use crate::commands::ai_runner::canonical_project_path;
use crate::core::samurai_audit::{AuditLog, AuditReadResult};
use crate::core::samurai_config::{SamuraiConfig, SharedSamuraiConfig};
use crate::core::supervisor::{SessionSnapshot, Supervisor, SupervisorState};

/// Store filename for the Samurai config (app-data settings pattern, same
/// as `commands/marketplace.rs`).
const SAMURAI_CONFIG_STORE: &str = "samurai-config.json";
/// The single key the whole config object lives under.
const SAMURAI_CONFIG_KEY: &str = "config";

/// Loads the persisted Samurai config, falling back to PRD §7 defaults for
/// a missing/partial/unreadable store. Called once at startup (`lib.rs`) to
/// seed the shared state the allowance loop and the commands read.
pub fn load_config_from_store(app: &AppHandle) -> SamuraiConfig {
    let stored = app
        .store(SAMURAI_CONFIG_STORE)
        .ok()
        .and_then(|store| store.get(SAMURAI_CONFIG_KEY))
        .and_then(|v| serde_json::from_value::<SamuraiConfig>(v).ok())
        .unwrap_or_default();
    // A hand-edited store file could hold out-of-range values the set
    // command would have rejected — fall back to defaults rather than run
    // the watcher on garbage.
    if let Err(e) = stored.validate() {
        log::warn!("samurai: stored config invalid ({e}); using defaults");
        return SamuraiConfig::default();
    }
    stored
}

/// Current Samurai thresholds (PRD §7 defaults until the user edits them).
#[tauri::command]
pub fn samurai_get_config(config: State<'_, SharedSamuraiConfig>) -> SamuraiConfig {
    config
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

/// Validates, persists and applies a new Samurai config. The allowance
/// loop reads the shared state every tick, so changes take effect within
/// one poll interval — no restart (that immediacy is the test mode, PRD
/// decision #7).
#[tauri::command]
pub fn samurai_set_config(
    app: AppHandle,
    state: State<'_, SharedSamuraiConfig>,
    config: SamuraiConfig,
) -> Result<SamuraiConfig, String> {
    config.validate()?;

    let store = app
        .store(SAMURAI_CONFIG_STORE)
        .map_err(|e| format!("failed to open settings store: {e}"))?;
    store.set(
        SAMURAI_CONFIG_KEY,
        serde_json::to_value(&config).map_err(|e| e.to_string())?,
    );
    store
        .save()
        .map_err(|e| format!("failed to save settings store: {e}"))?;

    *state
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = config.clone();
    Ok(config)
}

/// Places a session under supervision, starting in `WORKING` at `generation`
/// (default 1). Emits a `SPAWN` audit row and a `samurai-supervisor-event`.
#[tauri::command]
pub fn samurai_register_session(
    supervisor: State<'_, Arc<Supervisor>>,
    session_id: u32,
    project_path: String,
    epic: String,
    generation: Option<u32>,
) -> Result<SessionSnapshot, String> {
    let project = canonical_project_path(&project_path);
    supervisor.register_session(session_id, project, epic, generation.unwrap_or(1))
}

/// Drives one state transition, e.g. `to_state = "HANDOFF_REQUESTED"`.
/// Illegal transitions return an error (and land on the audit log as ALERT
/// rows); they never panic.
#[tauri::command]
pub fn samurai_transition(
    supervisor: State<'_, Arc<Supervisor>>,
    session_id: u32,
    to_state: String,
) -> Result<SessionSnapshot, String> {
    let to: SupervisorState = to_state.parse()?;
    supervisor.transition(session_id, to)
}

/// Snapshots of every supervised session, ordered by session id.
#[tauri::command]
pub fn samurai_list_sessions(supervisor: State<'_, Arc<Supervisor>>) -> Vec<SessionSnapshot> {
    supervisor.list_sessions()
}

/// Reads a project's audit rows — optionally only those strictly after
/// `since_ts` (RFC 3339), optionally only the last `tail` of those — plus the
/// current audit file size in bytes.
#[tauri::command]
pub async fn samurai_audit_read(
    audit: State<'_, AuditLog>,
    project_path: String,
    tail: Option<usize>,
    since_ts: Option<String>,
) -> Result<AuditReadResult, String> {
    let project = canonical_project_path(&project_path);
    audit.read(&project, tail, since_ts).await
}

/// Deletes a project's audit log. User-initiated only — nothing in the
/// backend calls this, and there is no automatic trimming (PRD decision #15).
#[tauri::command]
pub async fn samurai_audit_clear(
    audit: State<'_, AuditLog>,
    project_path: String,
) -> Result<(), String> {
    let project = canonical_project_path(&project_path);
    audit.clear(&project).await
}
