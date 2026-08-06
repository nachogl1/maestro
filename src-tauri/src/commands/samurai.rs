//! Tauri commands for the Samurai supervisor state machine and audit log
//! (Phase 1 — see `docs/samurai/prd.md` §5.2 and §5.10).
//!
//! The register/transition commands exist so transitions can be driven
//! manually from the frontend for testing; Phases 2–3 wire real triggers.
//! Project paths are canonicalized (and the Windows `\\?\` prefix stripped)
//! at this boundary so every layer below sees one spelling per project.

use std::sync::Arc;

use tauri::State;

use crate::commands::ai_runner::canonical_project_path;
use crate::core::samurai_audit::{AuditLog, AuditReadResult};
use crate::core::supervisor::{SessionSnapshot, Supervisor, SupervisorState};

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
