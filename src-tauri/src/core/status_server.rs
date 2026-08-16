//! HTTP-based status server for receiving MCP status reports.
//!
//! Replaces the file-polling approach with an HTTP endpoint that receives
//! status updates from the Rust MCP server. Provides real-time updates
//! and eliminates race conditions.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use chrono::Utc;
use log::info;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use super::claude_event::ClaudeEvent;

/// Maximum number of pending statuses to buffer (prevents memory leaks).
const MAX_PENDING_STATUSES: usize = 100;

/// Synthetic state used by the Stop hook to say "the agent ended its turn".
///
/// It is not an MCP state an agent can report — it exists so a turn end can
/// travel through the same emit/buffer/flush plumbing as a real status report
/// (see [`handle_hook_stop`]), and maps to the `AwaitingInput` status the
/// frontend normalizes into `NeedsInput`.
const AWAITING_INPUT_STATE: &str = "awaiting_input";

/// Issue #109 (item 4): how long a Notification's `NeedsInput` shields a
/// session from a LATE async PreToolUse `Working` repaint.
///
/// Both hooks are near-simultaneous localhost POSTs when a gated tool
/// starts, and PreToolUse is fire-and-forget — so the tool's `Working`
/// could land AFTER the permission prompt's `NeedsInput` and paint the
/// session blue while the dialog is up. Within this window a PreToolUse for
/// the same session does not downgrade the status; a LATER PreToolUse (a
/// fresh tool start, i.e. the prompt was approved) does. Two seconds is an
/// order of magnitude above the observed localhost race (<100ms) and well
/// under any human approve-and-continue turnaround.
const NOTIFICATION_SHIELD_WINDOW: Duration = Duration::from_secs(2);

/// The issue #109 window rule, pure for the table test: may a PreToolUse
/// `Working` overwrite the status, given when the session's last
/// Notification (`NeedsInput`) fired? Strict boundary (`>`), matching every
/// samurai timeout.
fn pre_tool_may_downgrade(notified_at: Option<Instant>, now: Instant) -> bool {
    match notified_at {
        None => true,
        Some(at) => now.saturating_duration_since(at) > NOTIFICATION_SHIELD_WINDOW,
    }
}

/// Callback for emitting status events. In production this wraps `AppHandle::emit`;
/// in tests it captures events into a `Vec`.
type EmitFn = Arc<dyn Fn(SessionStatusPayload) + Send + Sync>;

/// Callback for emitting hook-sourced ClaudeEvents.
type HookEmitFn = Arc<dyn Fn(ClaudeEvent) + Send + Sync>;

/// Status payload received from MCP server.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StatusRequest {
    pub session_id: u32,
    pub instance_id: String,
    pub state: String,
    pub message: String,
    pub needs_input_prompt: Option<String>,
    #[allow(dead_code)]
    pub timestamp: String,
}

/// Payload emitted to the frontend for status changes.
#[derive(Debug, Clone, Serialize)]
pub struct SessionStatusPayload {
    pub session_id: u32,
    pub project_path: String,
    pub status: String,
    pub message: String,
    pub needs_input_prompt: Option<String>,
}

/// Request payload for the session-start hook.
// `hook_event_name` is part of Claude's hook contract; it is accepted and
// validated by serde even though this handler routes on the URL instead.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct HookSessionStartRequest {
    pub session_id: String,
    pub transcript_path: String,
    pub cwd: String,
    pub hook_event_name: String,
}

/// Generic request payload for hooks that don't need special fields.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct HookGenericRequest {
    pub session_id: String,
    pub hook_event_name: String,
    #[serde(flatten)]
    pub extra: serde_json::Value,
}

/// State shared with the HTTP handler.
struct ServerState {
    emit_fn: EmitFn,
    hook_emit_fn: Option<HookEmitFn>,
    instance_id: String,
    /// Maps session_id -> project_path for routing status updates
    session_projects: Arc<RwLock<HashMap<u32, String>>>,
    /// Buffers status requests that arrive before session registration
    pending_statuses: Arc<RwLock<HashMap<u32, StatusRequest>>>,
    /// When each session's last Notification (`NeedsInput`) fired — the
    /// issue #109 shield against a late async PreToolUse repainting the
    /// permission dialog blue (see [`NOTIFICATION_SHIELD_WINDOW`]). Entries
    /// are cleared by the signals that genuinely end the wait (PostToolUse,
    /// UserPromptSubmit, Stop, SessionEnd), so the map stays session-bounded.
    notified_at: Arc<RwLock<HashMap<u32, Instant>>>,
}

/// HTTP status server that receives status updates from MCP servers.
pub struct StatusServer {
    port: u16,
    instance_id: String,
    emit_fn: EmitFn,
    session_projects: Arc<RwLock<HashMap<u32, String>>>,
    pending_statuses: Arc<RwLock<HashMap<u32, StatusRequest>>>,
}

/// Build the axum router with the given shared state.
fn build_router(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/status", post(handle_status))
        .route("/hook/session-start", post(handle_hook_session_start))
        .route("/hook/session-end", post(handle_hook_session_end))
        .route("/hook/pre-tool", post(handle_hook_pre_tool))
        .route("/hook/post-tool", post(handle_hook_post_tool))
        .route("/hook/stop", post(handle_hook_stop))
        .route("/hook/notification", post(handle_hook_notification))
        .route("/hook/user-prompt", post(handle_hook_user_prompt_submit))
        .with_state(state)
}

/// Create an `EmitFn` from a Tauri `AppHandle`.
fn emit_fn_from_app_handle(app_handle: AppHandle) -> EmitFn {
    Arc::new(move |payload: SessionStatusPayload| {
        if let Err(e) = app_handle.emit("session-status-changed", &payload) {
            eprintln!("[STATUS] EMIT FAILED: {}", e);
        } else {
            eprintln!("[STATUS] EMIT SUCCESS");
        }
    })
}

impl StatusServer {
    /// Find and bind to an available port in the given range.
    /// Returns the bound listener to avoid race conditions.
    async fn find_and_bind_port(
        range_start: u16,
        range_end: u16,
    ) -> Option<(u16, tokio::net::TcpListener)> {
        for port in range_start..=range_end {
            let addr = format!("127.0.0.1:{}", port);
            if let Ok(listener) = tokio::net::TcpListener::bind(&addr).await {
                return Some((port, listener));
            }
        }
        None
    }

    /// Generate a stable hash for a project path.
    /// Uses first 12 characters of SHA256 hex for uniqueness.
    pub fn generate_project_hash(project_path: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(project_path.as_bytes());
        let result = hasher.finalize();
        hex::encode(&result[..6])
    }

    /// Start the HTTP status server.
    ///
    /// Returns the server instance with the port it's listening on.
    pub async fn start(
        app_handle: AppHandle,
        instance_id: String,
        hook_emit_fn: Option<Arc<dyn Fn(ClaudeEvent) + Send + Sync>>,
    ) -> Option<Self> {
        // Find and bind in one step to avoid race conditions where another
        // process grabs the port between checking and binding
        let (port, listener) = Self::find_and_bind_port(9900, 9999).await?;
        let session_projects = Arc::new(RwLock::new(HashMap::new()));
        let pending_statuses = Arc::new(RwLock::new(HashMap::new()));
        let emit_fn = emit_fn_from_app_handle(app_handle);

        let state = Arc::new(ServerState {
            emit_fn: emit_fn.clone(),
            hook_emit_fn,
            instance_id: instance_id.clone(),
            session_projects: session_projects.clone(),
            pending_statuses: pending_statuses.clone(),
            notified_at: Arc::new(RwLock::new(HashMap::new())),
        });

        let app = build_router(state);

        let addr = format!("127.0.0.1:{}", port);
        eprintln!("[STATUS SERVER] Started on http://{}", addr);
        eprintln!("[STATUS SERVER] Instance ID: {}", instance_id);

        // Spawn the server in the background
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("[STATUS SERVER] Error: {}", e);
            }
        });

        Some(Self {
            port,
            instance_id,
            emit_fn,
            session_projects,
            pending_statuses,
        })
    }

    /// Get the port the server is listening on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Get the instance ID for this server.
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    /// Get the status URL for MCP servers to report to.
    pub fn status_url(&self) -> String {
        format!("http://127.0.0.1:{}/status", self.port)
    }

    /// Register a session with its project path.
    /// This allows routing status updates to the correct project.
    /// Also flushes any buffered status that arrived before registration.
    pub async fn register_session(&self, session_id: u32, project_path: &str) {
        {
            let mut projects = self.session_projects.write().await;
            projects.insert(session_id, project_path.to_string());
        }
        eprintln!(
            "[STATUS SERVER] Registered session {} for project '{}'",
            session_id, project_path
        );

        // Check for and flush any buffered status for this session
        let buffered = {
            let mut pending = self.pending_statuses.write().await;
            pending.remove(&session_id)
        };

        if let Some(payload) = buffered {
            eprintln!(
                "[STATUS SERVER] Flushing buffered status for session {}: state={}",
                session_id, payload.state
            );
            emit_status(&self.emit_fn, session_id, project_path, &payload);
        }
    }

    /// Unregister a session when it's killed.
    pub async fn unregister_session(&self, session_id: u32) {
        let mut projects = self.session_projects.write().await;
        if projects.remove(&session_id).is_some() {
            log::debug!("Unregistered session {}", session_id);
        }
        // Also clean up any buffered status
        drop(projects);
        let mut pending = self.pending_statuses.write().await;
        pending.remove(&session_id);
    }

    /// Get list of registered session IDs (for debugging).
    pub async fn registered_sessions(&self) -> Vec<u32> {
        let projects = self.session_projects.read().await;
        projects.keys().copied().collect()
    }
}

/// Map MCP state string to session status string and call the emit function.
fn emit_status(emit_fn: &EmitFn, session_id: u32, project_path: &str, payload: &StatusRequest) {
    let status = match payload.state.as_str() {
        "idle" => "Idle",
        "working" => "Working",
        "needs_input" => "NeedsInput",
        "finished" => "Done",
        "error" => "Error",
        AWAITING_INPUT_STATE => "AwaitingInput",
        other => {
            log::warn!("Unknown status state: {}", other);
            "Unknown"
        }
    };

    eprintln!(
        "[STATUS] EMITTING: session={} status={} project={}",
        session_id, status, project_path
    );

    let event_payload = SessionStatusPayload {
        session_id,
        project_path: project_path.to_string(),
        status: status.to_string(),
        message: payload.message.clone(),
        needs_input_prompt: payload.needs_input_prompt.clone(),
    };

    (emit_fn)(event_payload);
}

/// Handle incoming status POST requests.
async fn handle_status(
    State(state): State<Arc<ServerState>>,
    Json(payload): Json<StatusRequest>,
) -> StatusCode {
    eprintln!(
        "[STATUS] Received: session_id={}, instance_id={}, state={}",
        payload.session_id, payload.instance_id, payload.state
    );

    // Look up session registration first.
    // A registered session is always accepted — even if the instance_id doesn't
    // match. This handles the case where Claude Code reuses an MCP server process
    // across Maestro restarts: the process still has the old MAESTRO_INSTANCE_ID
    // in its env, but the session is legitimately registered with this server.
    let project_path = {
        let projects = state.session_projects.read().await;
        projects.get(&payload.session_id).cloned()
    };

    if let Some(project_path) = project_path {
        if payload.instance_id != state.instance_id {
            eprintln!(
                "[STATUS] Accepted with stale instance_id for registered session {} (expected {}, got {})",
                payload.session_id, state.instance_id, payload.instance_id
            );
        }
        emit_status(&state.emit_fn, payload.session_id, &project_path, &payload);
        return StatusCode::OK;
    }

    // Session not registered — only buffer if the instance_id matches this server.
    // A mismatched instance_id here means it's from a different Maestro instance's
    // stale MCP process posting for a session we don't own.
    if payload.instance_id != state.instance_id {
        eprintln!(
            "[STATUS] REJECTED - unknown session {} with wrong instance (expected {}, got {})",
            payload.session_id, state.instance_id, payload.instance_id
        );
        return StatusCode::FORBIDDEN;
    }

    // Session not registered yet but instance matches — buffer for when it registers
    eprintln!(
        "[STATUS] BUFFERED - unknown session {}, will flush on registration",
        payload.session_id
    );
    let mut pending = state.pending_statuses.write().await;
    if pending.len() < MAX_PENDING_STATUSES {
        pending.insert(payload.session_id, payload);
    } else {
        eprintln!(
            "[STATUS] WARNING - pending buffer full ({}), dropping status for session {}",
            MAX_PENDING_STATUSES, payload.session_id
        );
    }
    StatusCode::ACCEPTED
}

// ── Hook helpers ─────────────────────────────────────────────────────

/// Extract the Maestro session ID from the `X-Maestro-Session` header.
fn extract_maestro_session_id(headers: &HeaderMap) -> Option<u32> {
    headers
        .get("X-Maestro-Session")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u32>().ok())
}

/// Verify the `X-Maestro-Instance` header matches this server's instance id.
///
/// The legitimate hook commands (written by `hook_config_writer`) always send
/// this per-instance secret. Without this check the hook routes would accept
/// requests from any local process, letting it inject fabricated events or
/// point the transcript watcher at an arbitrary path.
fn instance_id_matches(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get("X-Maestro-Instance")
        .and_then(|v| v.to_str().ok())
        .map(|got| got == expected)
        .unwrap_or(false)
}

/// Confines a hook-supplied transcript path to the Claude projects directory.
///
/// `transcript_path` arrives in a hook request body; without confinement a
/// caller could make Maestro open, read, and watch an arbitrary file/directory.
/// Returns `true` when the (lexically normalized) path stays under
/// `~/.claude/projects`.
fn is_within_claude_projects(transcript_path: &str) -> bool {
    use std::path::{Component, Path};

    // Reject traversal components outright rather than trusting canonicalization
    // (the file may not exist yet).
    let path = Path::new(transcript_path);
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }

    let Some(base_dirs) = directories::BaseDirs::new() else {
        return false;
    };
    let projects = base_dirs.home_dir().join(".claude").join("projects");
    path.starts_with(&projects)
}

/// Look up a registered session's project and emit a status payload for it.
///
/// Hook-sourced statuses are moment-in-time signals: for a session that is
/// not registered (yet, or any more) they are logged and dropped rather than
/// buffered — replaying "was asking a question 30s ago" at registration time
/// would be wrong more often than right.
async fn emit_hook_status(
    state: &Arc<ServerState>,
    session_id: u32,
    status: &str,
    message: &str,
    needs_input_prompt: Option<String>,
) {
    let project_path = {
        let projects = state.session_projects.read().await;
        projects.get(&session_id).cloned()
    };
    match project_path {
        Some(project_path) => {
            (state.emit_fn)(SessionStatusPayload {
                session_id,
                project_path,
                status: status.to_string(),
                message: message.to_string(),
                needs_input_prompt,
            });
        }
        None => {
            info!(
                "[HOOK] status '{}': session {} not registered, skipping status emit",
                status, session_id
            );
        }
    }
}

// ── Hook handlers ────────────────────────────────────────────────────

/// Handle the SessionStart hook callback.
async fn handle_hook_session_start(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(payload): Json<HookSessionStartRequest>,
) -> StatusCode {
    if !instance_id_matches(&headers, &state.instance_id) {
        eprintln!("[HOOK] session-start: rejected - missing/invalid X-Maestro-Instance");
        return StatusCode::FORBIDDEN;
    }

    let maestro_session_id = match extract_maestro_session_id(&headers) {
        Some(id) => id,
        None => {
            eprintln!("[HOOK] session-start: missing or invalid X-Maestro-Session header");
            return StatusCode::BAD_REQUEST;
        }
    };

    // Confine the watched transcript to ~/.claude/projects so a hook cannot
    // point the filesystem watcher at an arbitrary path.
    if !is_within_claude_projects(&payload.transcript_path) {
        eprintln!(
            "[HOOK] session-start: rejected transcript_path outside Claude projects dir: {}",
            payload.transcript_path
        );
        return StatusCode::BAD_REQUEST;
    }

    info!(
        "[HOOK] session-start: maestro_session={}, claude_session={}, cwd={}",
        maestro_session_id, payload.session_id, payload.cwd
    );

    let event = ClaudeEvent::SessionStarted {
        session_id: maestro_session_id,
        claude_session_uuid: payload.session_id,
        transcript_path: payload.transcript_path,
        timestamp: Utc::now().to_rfc3339(),
    };

    if let Some(ref hook_emit) = state.hook_emit_fn {
        (hook_emit)(event);
    }

    // A freshly (re)started CLI sits at its input prompt — it is NOT working
    // (issue #105 class 1/2: this used to emit "Working", which stuck until
    // some other signal arrived). The UserPromptSubmit hook flips the session
    // to Working the moment a prompt (typed or injected) is actually
    // submitted.
    emit_hook_status(&state, maestro_session_id, "Idle", "Session started", None).await;

    StatusCode::OK
}

/// Handle the SessionEnd hook callback.
async fn handle_hook_session_end(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(payload): Json<HookGenericRequest>,
) -> StatusCode {
    if !instance_id_matches(&headers, &state.instance_id) {
        eprintln!("[HOOK] session-end: rejected - missing/invalid X-Maestro-Instance");
        return StatusCode::FORBIDDEN;
    }

    let maestro_session_id = match extract_maestro_session_id(&headers) {
        Some(id) => id,
        None => {
            eprintln!("[HOOK] session-end: missing or invalid X-Maestro-Session header");
            return StatusCode::BAD_REQUEST;
        }
    };

    let reason = payload
        .extra
        .get("exit_reason")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    info!(
        "[HOOK] session-end: maestro_session={}, reason={}",
        maestro_session_id, reason
    );

    // The session is gone — drop its issue #109 notification shield stamp.
    state.notified_at.write().await.remove(&maestro_session_id);

    let event = ClaudeEvent::SessionEnded {
        session_id: maestro_session_id,
        reason,
        timestamp: Utc::now().to_rfc3339(),
    };

    if let Some(ref hook_emit) = state.hook_emit_fn {
        (hook_emit)(event);
    }

    // The claude process is gone — whatever status the session showed
    // (Working, NeedsInput, …) is stale the instant this hook fires (issue
    // #105 class 2: previously nothing was emitted here, so the last status
    // stuck forever). "SessionEnded" is a wire-only signal: the frontend
    // normalizes it to Idle unless the agent already reported a terminal
    // Done/Error, which stays visible.
    emit_hook_status(
        &state,
        maestro_session_id,
        "SessionEnded",
        "Claude session ended",
        None,
    )
    .await;

    StatusCode::OK
}

/// Handle the PreTool hook callback.
async fn handle_hook_pre_tool(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(payload): Json<HookGenericRequest>,
) -> StatusCode {
    if !instance_id_matches(&headers, &state.instance_id) {
        eprintln!("[HOOK] pre-tool: rejected - missing/invalid X-Maestro-Instance");
        return StatusCode::FORBIDDEN;
    }

    let maestro_session_id = match extract_maestro_session_id(&headers) {
        Some(id) => id,
        None => {
            eprintln!("[HOOK] pre-tool: missing or invalid X-Maestro-Session header");
            return StatusCode::BAD_REQUEST;
        }
    };

    let tool_name = payload
        .extra
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let tool_use_id = payload
        .extra
        .get("tool_use_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // tool_input carries the tool's ENTIRE input — a Write call embeds the
    // whole file body. Cap it like the transcript parser does (char-based,
    // never mid-codepoint): the event crosses IPC on every tool call and is
    // retained in the frontend's activity store.
    let tool_input = payload
        .extra
        .get("tool_input")
        .map(|v| {
            let s = v.to_string();
            if s.chars().count() <= 200 {
                s
            } else {
                let truncated: String = s.chars().take(200).collect();
                format!("{truncated}...")
            }
        })
        .unwrap_or_default();

    info!(
        "[HOOK] pre-tool: maestro_session={}, tool={}",
        maestro_session_id, tool_name
    );

    let event = ClaudeEvent::ToolUseStarted {
        session_id: maestro_session_id,
        tool_name: tool_name.clone(),
        tool_use_id,
        input_summary: tool_input,
        timestamp: Utc::now().to_rfc3339(),
    };

    if let Some(ref hook_emit) = state.hook_emit_fn {
        (hook_emit)(event);
    }

    // A tool call is hard evidence of what the CLI is doing right now, so
    // surface it as a status too (the ClaudeEvent above only feeds the
    // activity feed, not the status indicator):
    // - AskUserQuestion renders an interactive question dialog and blocks on
    //   the user → NeedsInput (issue #105 classes 1/3: mid-turn questions
    //   previously produced no needs-input signal at all — only PTY output,
    //   which the frontend heuristic read as "Working").
    // - Any other tool means the agent is actively working → Working. This
    //   also repairs the status after a permission prompt is approved via a
    //   digit shortcut (no Enter keypress for the frontend to observe), and
    //   keeps the PTY heuristic inside its "authoritative signal is fresh"
    //   grace window during tool-dense turns.
    if tool_name == "AskUserQuestion" {
        emit_hook_status(
            &state,
            maestro_session_id,
            "NeedsInput",
            "Waiting for you to answer a question",
            Some("The agent asked a question in the terminal".to_string()),
        )
        .await;
    } else {
        // Issue #109 window rule: this hook is async fire-and-forget, so a
        // gated tool's Working can arrive AFTER the permission prompt's
        // Notification NeedsInput. Within the shield window the repaint is
        // suppressed (the dialog is up — the session IS waiting); a later
        // PreToolUse is a fresh tool start after approval and paints
        // Working as before.
        let notified = {
            state
                .notified_at
                .read()
                .await
                .get(&maestro_session_id)
                .copied()
        };
        if !pre_tool_may_downgrade(notified, Instant::now()) {
            info!(
                "[HOOK] pre-tool: session {} showed a permission prompt <{:?} ago — keeping NeedsInput (issue #109)",
                maestro_session_id, NOTIFICATION_SHIELD_WINDOW
            );
            return StatusCode::OK;
        }
        emit_hook_status(
            &state,
            maestro_session_id,
            "Working",
            &format!("Running {}", tool_name),
            None,
        )
        .await;
    }

    StatusCode::OK
}

/// Handle the PostToolUse hook callback (issue #109).
///
/// Fires when a tool finishes. Its one status job is closing the
/// digit-shortcut gap: approving a permission prompt with a digit shortcut
/// just runs the tool — no hook fires on the approval itself — so when the
/// approved tool is the turn's LAST one, the status stayed `NeedsInput` for
/// that tool's whole runtime. The tool having RUN to completion is proof
/// the prompt was answered, so this clears `NeedsInput` unconditionally —
/// deliberately not consulting the issue-#109 notification shield (a
/// PostToolUse is exactly the "fresh signal after approval" the shield must
/// let through) and clearing the shield stamp itself.
async fn handle_hook_post_tool(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(payload): Json<HookGenericRequest>,
) -> StatusCode {
    if !instance_id_matches(&headers, &state.instance_id) {
        eprintln!("[HOOK] post-tool: rejected - missing/invalid X-Maestro-Instance");
        return StatusCode::FORBIDDEN;
    }

    let maestro_session_id = match extract_maestro_session_id(&headers) {
        Some(id) => id,
        None => {
            eprintln!("[HOOK] post-tool: missing or invalid X-Maestro-Session header");
            return StatusCode::BAD_REQUEST;
        }
    };

    let tool_name = payload
        .extra
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    info!(
        "[HOOK] post-tool: maestro_session={}, tool={}",
        maestro_session_id, tool_name
    );

    // The wait (if any) is over — a later PreToolUse must repaint freely.
    state.notified_at.write().await.remove(&maestro_session_id);

    emit_hook_status(
        &state,
        maestro_session_id,
        "Working",
        &format!("Finished {}", tool_name),
        None,
    )
    .await;

    StatusCode::OK
}

/// Handle the Notification hook callback.
///
/// Claude Code fires Notification precisely when it is waiting on the human:
/// permission prompts ("Claude needs your permission to use Bash") and the
/// idle-prompt reminder (input sat unanswered for 60+ seconds). Both mean
/// NeedsInput. This is the reliable mid-turn needs-input signal issue #105
/// classes 1 and 3 were missing: a permission prompt produces PTY output
/// (which the frontend heuristic read as "Working") but, before this hook,
/// no event at all.
async fn handle_hook_notification(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(payload): Json<HookGenericRequest>,
) -> StatusCode {
    if !instance_id_matches(&headers, &state.instance_id) {
        eprintln!("[HOOK] notification: rejected - missing/invalid X-Maestro-Instance");
        return StatusCode::FORBIDDEN;
    }

    let maestro_session_id = match extract_maestro_session_id(&headers) {
        Some(id) => id,
        None => {
            eprintln!("[HOOK] notification: missing or invalid X-Maestro-Session header");
            return StatusCode::BAD_REQUEST;
        }
    };

    let message = payload
        .extra
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("Claude is waiting for your input")
        .to_string();

    info!(
        "[HOOK] notification: maestro_session={}, message={}",
        maestro_session_id, message
    );

    // Issue #109: stamp the shield BEFORE emitting, so the gated tool's late
    // async PreToolUse can never slip between the emit and the stamp.
    state
        .notified_at
        .write()
        .await
        .insert(maestro_session_id, Instant::now());

    emit_hook_status(
        &state,
        maestro_session_id,
        "NeedsInput",
        &message,
        Some(message.clone()),
    )
    .await;

    StatusCode::OK
}

/// Handle the UserPromptSubmit hook callback.
///
/// Fires the moment a prompt is submitted to the CLI — typed by the human or
/// injected by Maestro (samurai launches type the brief into the PTY). This
/// is the authoritative "a turn started, the agent is working" signal: it
/// replaces the old reliance on the PTY-output heuristic (≥500ms of output)
/// and, crucially, it is the only signal that moves a session out of a
/// terminal Done/Error once a NEW turn begins (issue #105 class 2: a session
/// that once reported Done used to stay Done forever).
async fn handle_hook_user_prompt_submit(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(payload): Json<HookGenericRequest>,
) -> StatusCode {
    if !instance_id_matches(&headers, &state.instance_id) {
        eprintln!("[HOOK] user-prompt: rejected - missing/invalid X-Maestro-Instance");
        return StatusCode::FORBIDDEN;
    }

    let maestro_session_id = match extract_maestro_session_id(&headers) {
        Some(id) => id,
        None => {
            eprintln!("[HOOK] user-prompt: missing or invalid X-Maestro-Session header");
            return StatusCode::BAD_REQUEST;
        }
    };

    info!(
        "[HOOK] user-prompt: maestro_session={}, claude_session={}",
        maestro_session_id, payload.session_id
    );

    // A submitted prompt ends whatever wait the last Notification announced
    // (issue #109 shield hygiene).
    state.notified_at.write().await.remove(&maestro_session_id);

    emit_hook_status(
        &state,
        maestro_session_id,
        "Working",
        "Processing your request",
        None,
    )
    .await;

    StatusCode::OK
}

/// Handle the Stop hook callback.
async fn handle_hook_stop(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(payload): Json<HookGenericRequest>,
) -> StatusCode {
    if !instance_id_matches(&headers, &state.instance_id) {
        eprintln!("[HOOK] stop: rejected - missing/invalid X-Maestro-Instance");
        return StatusCode::FORBIDDEN;
    }

    let maestro_session_id = match extract_maestro_session_id(&headers) {
        Some(id) => id,
        None => {
            eprintln!("[HOOK] stop: missing or invalid X-Maestro-Session header");
            return StatusCode::BAD_REQUEST;
        }
    };

    info!(
        "[HOOK] stop: maestro_session={}, claude_session={}",
        maestro_session_id, payload.session_id
    );

    // Turn over — drop the issue #109 notification shield stamp.
    state.notified_at.write().await.remove(&maestro_session_id);

    let event = ClaudeEvent::SessionEnded {
        session_id: maestro_session_id,
        reason: "stop".to_string(),
        timestamp: Utc::now().to_rfc3339(),
    };

    if let Some(ref hook_emit) = state.hook_emit_fn {
        (hook_emit)(event);
    }

    // The Stop hook fires when the agent ends its turn and control returns to
    // the user. Surface that as an "AwaitingInput" status so the UI can flag
    // the terminal as waiting for a reply. The frontend normalizes it to
    // NeedsInput unless the agent already reported a terminal state
    // (Done/Error) via MCP, or it handed work off to running subagents.
    let project_path = {
        let projects = state.session_projects.read().await;
        projects.get(&maestro_session_id).cloned()
    };
    if let Some(project_path) = project_path {
        (state.emit_fn)(SessionStatusPayload {
            session_id: maestro_session_id,
            project_path,
            status: "AwaitingInput".to_string(),
            message: "Waiting for your input".to_string(),
            needs_input_prompt: None,
        });
    } else {
        // Not registered (yet): the CLI can end a turn before session
        // registration completes, and a Maestro restart re-registers sessions
        // whose MCP process is already alive. Dropping the emit left the UI
        // with no turn-end signal at all — the session simply looked idle — so
        // buffer it exactly like an MCP status: `register_session` flushes it
        // as soon as the session appears.
        let mut pending = state.pending_statuses.write().await;
        if pending.len() < MAX_PENDING_STATUSES {
            info!(
                "[HOOK] stop: session {} not registered, buffering turn end",
                maestro_session_id
            );
            pending.insert(
                maestro_session_id,
                StatusRequest {
                    session_id: maestro_session_id,
                    instance_id: state.instance_id.clone(),
                    state: AWAITING_INPUT_STATE.to_string(),
                    message: "Waiting for your input".to_string(),
                    needs_input_prompt: None,
                    timestamp: Utc::now().to_rfc3339(),
                },
            );
        } else {
            info!(
                "[HOOK] stop: pending buffer full, dropping turn end for session {}",
                maestro_session_id
            );
        }
    }

    StatusCode::OK
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Collected events from the test emit function.
    type EventLog = Arc<std::sync::Mutex<Vec<SessionStatusPayload>>>;

    /// Create a test EmitFn that captures events into a shared Vec.
    fn test_emit_fn() -> (EmitFn, EventLog) {
        let events: EventLog = Arc::new(std::sync::Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let emit_fn: EmitFn = Arc::new(move |payload| {
            events_clone.lock().unwrap().push(payload);
        });
        (emit_fn, events)
    }

    /// Create a test StatusServer (no real port, no AppHandle).
    fn test_server(instance_id: &str, emit_fn: EmitFn) -> StatusServer {
        StatusServer {
            port: 0,
            instance_id: instance_id.to_string(),
            emit_fn,
            session_projects: Arc::new(RwLock::new(HashMap::new())),
            pending_statuses: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Spin up a real HTTP server backed by our handler, returning its
    /// address and the full shared state (the issue #109 shield tests reach
    /// `notified_at` through it).
    async fn start_test_http_server_with_state(
        instance_id: &str,
        emit_fn: EmitFn,
    ) -> (std::net::SocketAddr, Arc<ServerState>) {
        let state = Arc::new(ServerState {
            emit_fn,
            hook_emit_fn: None,
            instance_id: instance_id.to_string(),
            session_projects: Arc::new(RwLock::new(HashMap::new())),
            pending_statuses: Arc::new(RwLock::new(HashMap::new())),
            notified_at: Arc::new(RwLock::new(HashMap::new())),
        });

        let app = build_router(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        (addr, state)
    }

    /// Spin up a real HTTP server backed by our handler, returning its address.
    async fn start_test_http_server(
        instance_id: &str,
        emit_fn: EmitFn,
    ) -> (
        std::net::SocketAddr,
        Arc<RwLock<HashMap<u32, String>>>,
        Arc<RwLock<HashMap<u32, StatusRequest>>>,
    ) {
        let (addr, state) = start_test_http_server_with_state(instance_id, emit_fn).await;
        (
            addr,
            state.session_projects.clone(),
            state.pending_statuses.clone(),
        )
    }

    /// Helper: POST a status request to the test server.
    async fn post_status(addr: std::net::SocketAddr, payload: &StatusRequest) -> u16 {
        reqwest::Client::new()
            .post(format!("http://{}/status", addr))
            .json(payload)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }

    /// Helper: build a StatusRequest for testing.
    fn make_status(
        session_id: u32,
        instance_id: &str,
        state: &str,
        message: &str,
    ) -> StatusRequest {
        StatusRequest {
            session_id,
            instance_id: instance_id.to_string(),
            state: state.to_string(),
            message: message.to_string(),
            needs_input_prompt: None,
            timestamp: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    // ── Auth / confinement unit tests ───────────────────────────────

    #[test]
    fn instance_id_matches_requires_exact_header() {
        let mut headers = HeaderMap::new();
        assert!(!instance_id_matches(&headers, "secret")); // missing header
        headers.insert("X-Maestro-Instance", "wrong".parse().unwrap());
        assert!(!instance_id_matches(&headers, "secret"));
        headers.insert("X-Maestro-Instance", "secret".parse().unwrap());
        assert!(instance_id_matches(&headers, "secret"));
    }

    #[test]
    fn transcript_path_confinement_rejects_traversal_and_outside_paths() {
        assert!(!is_within_claude_projects("/etc/passwd"));
        assert!(!is_within_claude_projects("C:/Windows/System32/config"));
        // Even a path nominally under the dir but using traversal is rejected.
        let base = directories::BaseDirs::new().unwrap();
        let escaped = base.home_dir().join(".claude/projects/../../secret.jsonl");
        assert!(!is_within_claude_projects(&escaped.to_string_lossy()));
        // A genuine transcript path is accepted.
        let ok = base.home_dir().join(".claude/projects/enc/abc.jsonl");
        assert!(is_within_claude_projects(&ok.to_string_lossy()));
    }

    /// Helper: POST a JSON body to a hook route with optional instance header.
    async fn post_hook(
        addr: std::net::SocketAddr,
        route: &str,
        instance_header: Option<&str>,
        body: serde_json::Value,
    ) -> u16 {
        let mut req = reqwest::Client::new()
            .post(format!("http://{}{}", addr, route))
            .header("X-Maestro-Session", "1")
            .json(&body);
        if let Some(inst) = instance_header {
            req = req.header("X-Maestro-Instance", inst);
        }
        req.send().await.unwrap().status().as_u16()
    }

    #[tokio::test]
    async fn hook_routes_reject_missing_instance_header() {
        let (emit_fn, _events) = test_emit_fn();
        let (addr, _p, _pend) = start_test_http_server("inst-secret", emit_fn).await;

        let body = serde_json::json!({
            "session_id": "claude-uuid",
            "transcript_path": "/tmp/x.jsonl",
            "cwd": "/tmp",
            "hook_event_name": "SessionStart",
        });
        // No instance header → 403 for every hook route.
        assert_eq!(
            post_hook(addr, "/hook/session-start", None, body.clone()).await,
            403
        );
        assert_eq!(
            post_hook(addr, "/hook/session-end", None, body.clone()).await,
            403
        );
        assert_eq!(
            post_hook(addr, "/hook/pre-tool", None, body.clone()).await,
            403
        );
        assert_eq!(
            post_hook(addr, "/hook/post-tool", None, body.clone()).await,
            403
        );
        assert_eq!(
            post_hook(addr, "/hook/notification", None, body.clone()).await,
            403
        );
        assert_eq!(
            post_hook(addr, "/hook/user-prompt", None, body.clone()).await,
            403
        );
        assert_eq!(post_hook(addr, "/hook/stop", None, body).await, 403);
    }

    #[tokio::test]
    async fn hook_session_start_rejects_transcript_path_outside_projects() {
        let (emit_fn, _events) = test_emit_fn();
        let (addr, _p, _pend) = start_test_http_server("inst-secret", emit_fn).await;

        let body = serde_json::json!({
            "session_id": "claude-uuid",
            "transcript_path": "/etc/passwd",
            "cwd": "/tmp",
            "hook_event_name": "SessionStart",
        });
        // Correct instance header but attacker-chosen path → 400.
        assert_eq!(
            post_hook(addr, "/hook/session-start", Some("inst-secret"), body).await,
            400
        );
    }

    #[tokio::test]
    async fn stop_hook_emits_awaiting_input_for_registered_session() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, _pend) = start_test_http_server("inst-secret", emit_fn).await;

        // post_hook always sends X-Maestro-Session: 1
        projects
            .write()
            .await
            .insert(1, "/path/project".to_string());

        let body = serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "Stop",
        });
        assert_eq!(
            post_hook(addr, "/hook/stop", Some("inst-secret"), body).await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].session_id, 1);
        assert_eq!(emitted[0].project_path, "/path/project");
        assert_eq!(emitted[0].status, "AwaitingInput");
        assert_eq!(emitted[0].needs_input_prompt, None);
    }

    // ── Hook → status mapping tests (issue #105) ────────────────────

    #[tokio::test]
    async fn session_start_hook_emits_idle_for_registered_session() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, _pend) = start_test_http_server("inst-secret", emit_fn).await;
        projects
            .write()
            .await
            .insert(1, "/path/project".to_string());

        // Must be inside ~/.claude/projects to pass the confinement check.
        let base = directories::BaseDirs::new().unwrap();
        let transcript = base.home_dir().join(".claude/projects/enc/t.jsonl");
        let body = serde_json::json!({
            "session_id": "claude-uuid",
            "transcript_path": transcript.to_string_lossy(),
            "cwd": "/tmp",
            "hook_event_name": "SessionStart",
        });
        assert_eq!(
            post_hook(addr, "/hook/session-start", Some("inst-secret"), body).await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        // A freshly started CLI sits at its prompt: Idle, not Working.
        assert_eq!(emitted[0].status, "Idle");
        assert_eq!(emitted[0].message, "Session started");
    }

    #[tokio::test]
    async fn session_end_hook_emits_session_ended_for_registered_session() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, _pend) = start_test_http_server("inst-secret", emit_fn).await;
        projects
            .write()
            .await
            .insert(1, "/path/project".to_string());

        let body = serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "SessionEnd",
            "exit_reason": "prompt_input_exit",
        });
        assert_eq!(
            post_hook(addr, "/hook/session-end", Some("inst-secret"), body).await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].status, "SessionEnded");
        assert_eq!(emitted[0].needs_input_prompt, None);
    }

    #[tokio::test]
    async fn pre_tool_hook_emits_working_for_ordinary_tools() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, _pend) = start_test_http_server("inst-secret", emit_fn).await;
        projects
            .write()
            .await
            .insert(1, "/path/project".to_string());

        let body = serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_use_id": "tu-1",
            "tool_input": {"command": "ls"},
        });
        assert_eq!(
            post_hook(addr, "/hook/pre-tool", Some("inst-secret"), body).await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].status, "Working");
        assert_eq!(emitted[0].message, "Running Bash");
        assert_eq!(emitted[0].needs_input_prompt, None);
    }

    #[tokio::test]
    async fn pre_tool_hook_emits_needs_input_for_ask_user_question() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, _pend) = start_test_http_server("inst-secret", emit_fn).await;
        projects
            .write()
            .await
            .insert(1, "/path/project".to_string());

        let body = serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "PreToolUse",
            "tool_name": "AskUserQuestion",
            "tool_use_id": "tu-2",
            "tool_input": {"questions": []},
        });
        assert_eq!(
            post_hook(addr, "/hook/pre-tool", Some("inst-secret"), body).await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].status, "NeedsInput");
        assert!(emitted[0].needs_input_prompt.is_some());
    }

    #[tokio::test]
    async fn notification_hook_emits_needs_input_with_message_as_prompt() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, _pend) = start_test_http_server("inst-secret", emit_fn).await;
        projects
            .write()
            .await
            .insert(1, "/path/project".to_string());

        let body = serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "Notification",
            "message": "Claude needs your permission to use Bash",
        });
        assert_eq!(
            post_hook(addr, "/hook/notification", Some("inst-secret"), body).await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].status, "NeedsInput");
        assert_eq!(
            emitted[0].message,
            "Claude needs your permission to use Bash"
        );
        assert_eq!(
            emitted[0].needs_input_prompt.as_deref(),
            Some("Claude needs your permission to use Bash")
        );
    }

    #[tokio::test]
    async fn notification_hook_defaults_message_when_absent() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, _pend) = start_test_http_server("inst-secret", emit_fn).await;
        projects
            .write()
            .await
            .insert(1, "/path/project".to_string());

        let body = serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "Notification",
        });
        assert_eq!(
            post_hook(addr, "/hook/notification", Some("inst-secret"), body).await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].status, "NeedsInput");
        assert_eq!(emitted[0].message, "Claude is waiting for your input");
    }

    #[tokio::test]
    async fn user_prompt_hook_emits_working() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, _pend) = start_test_http_server("inst-secret", emit_fn).await;
        projects
            .write()
            .await
            .insert(1, "/path/project".to_string());

        let body = serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "UserPromptSubmit",
            "prompt": "do the thing",
        });
        assert_eq!(
            post_hook(addr, "/hook/user-prompt", Some("inst-secret"), body).await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].status, "Working");
        assert_eq!(emitted[0].message, "Processing your request");
    }

    // ── Issue #109: notification shield + PostToolUse ───────────────

    #[test]
    fn notification_shield_window_rule_table() {
        let at = Instant::now();
        // No notification on record: PreToolUse paints Working freely.
        assert!(pre_tool_may_downgrade(None, at));
        // Inside the window (strict boundary — exactly 2s still shields):
        // the permission dialog is up, the repaint is suppressed.
        assert!(!pre_tool_may_downgrade(Some(at), at));
        assert!(!pre_tool_may_downgrade(
            Some(at),
            at + Duration::from_secs(1)
        ));
        assert!(!pre_tool_may_downgrade(
            Some(at),
            at + NOTIFICATION_SHIELD_WINDOW
        ));
        // Past the window: a fresh tool start after approval repaints.
        assert!(pre_tool_may_downgrade(
            Some(at),
            at + NOTIFICATION_SHIELD_WINDOW + Duration::from_millis(1)
        ));
        assert!(pre_tool_may_downgrade(
            Some(at),
            at + Duration::from_millis(2500)
        ));
    }

    /// A PreToolUse body for an ordinary (non-question) tool.
    fn bash_pre_tool_body() -> serde_json::Value {
        serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_use_id": "tu-1",
            "tool_input": {"command": "ls"},
        })
    }

    #[tokio::test]
    async fn late_pre_tool_within_window_keeps_needs_input() {
        // Issue #109 item 4, sequence 1: notification → pretooluse
        // immediately after → the NeedsInput stays (no Working emitted
        // while the permission dialog is up).
        let (emit_fn, events) = test_emit_fn();
        let (addr, state) = start_test_http_server_with_state("inst-secret", emit_fn).await;
        state
            .session_projects
            .write()
            .await
            .insert(1, "/path/project".to_string());

        let notification = serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "Notification",
            "message": "Claude needs your permission to use Bash",
        });
        assert_eq!(
            post_hook(
                addr,
                "/hook/notification",
                Some("inst-secret"),
                notification
            )
            .await,
            200
        );
        assert_eq!(
            post_hook(
                addr,
                "/hook/pre-tool",
                Some("inst-secret"),
                bash_pre_tool_body()
            )
            .await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1, "the late PreToolUse emitted no status");
        assert_eq!(emitted[0].status, "NeedsInput");
    }

    #[tokio::test]
    async fn pre_tool_after_the_window_repaints_working() {
        // Issue #109 item 4, sequence 2: notification → (2.5s) → pretooluse
        // → Working (a fresh tool start after the approval). The 2.5s is
        // simulated by backdating the shield stamp, not by sleeping.
        let (emit_fn, events) = test_emit_fn();
        let (addr, state) = start_test_http_server_with_state("inst-secret", emit_fn).await;
        state
            .session_projects
            .write()
            .await
            .insert(1, "/path/project".to_string());

        let notification = serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "Notification",
            "message": "Claude needs your permission to use Bash",
        });
        assert_eq!(
            post_hook(
                addr,
                "/hook/notification",
                Some("inst-secret"),
                notification
            )
            .await,
            200
        );
        // Age the stamp to 2.5s ago (machine uptime dwarfs 2.5s).
        let aged = Instant::now()
            .checked_sub(Duration::from_millis(2500))
            .expect("uptime > 2.5s");
        state.notified_at.write().await.insert(1, aged);

        assert_eq!(
            post_hook(
                addr,
                "/hook/pre-tool",
                Some("inst-secret"),
                bash_pre_tool_body()
            )
            .await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 2);
        assert_eq!(emitted[0].status, "NeedsInput");
        assert_eq!(emitted[1].status, "Working");
        assert_eq!(emitted[1].message, "Running Bash");
    }

    #[tokio::test]
    async fn ask_user_question_needs_input_is_never_shielded() {
        // The shield only suppresses DOWNGRADES to Working — a mid-turn
        // question right after a notification still paints NeedsInput.
        let (emit_fn, events) = test_emit_fn();
        let (addr, state) = start_test_http_server_with_state("inst-secret", emit_fn).await;
        state
            .session_projects
            .write()
            .await
            .insert(1, "/path/project".to_string());
        state.notified_at.write().await.insert(1, Instant::now());

        let body = serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "PreToolUse",
            "tool_name": "AskUserQuestion",
            "tool_use_id": "tu-2",
            "tool_input": {},
        });
        assert_eq!(
            post_hook(addr, "/hook/pre-tool", Some("inst-secret"), body).await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].status, "NeedsInput");
    }

    #[tokio::test]
    async fn post_tool_hook_emits_working_and_clears_the_shield() {
        // Issue #109 item 5: PostToolUse → Working, unconditionally — a
        // completed tool proves the permission prompt was answered, so it
        // must not consult the shield, and it clears the stamp so the next
        // PreToolUse repaints freely too.
        let (emit_fn, events) = test_emit_fn();
        let (addr, state) = start_test_http_server_with_state("inst-secret", emit_fn).await;
        state
            .session_projects
            .write()
            .await
            .insert(1, "/path/project".to_string());

        let notification = serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "Notification",
            "message": "Claude needs your permission to use Bash",
        });
        assert_eq!(
            post_hook(
                addr,
                "/hook/notification",
                Some("inst-secret"),
                notification
            )
            .await,
            200
        );

        // The digit-shortcut scenario: no signal between the notification
        // and the approved tool FINISHING (well inside the shield window).
        let post_tool = serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_use_id": "tu-1",
        });
        assert_eq!(
            post_hook(addr, "/hook/post-tool", Some("inst-secret"), post_tool).await,
            200
        );
        // Shield cleared: an immediate next PreToolUse paints Working too.
        assert_eq!(
            post_hook(
                addr,
                "/hook/pre-tool",
                Some("inst-secret"),
                bash_pre_tool_body()
            )
            .await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 3);
        assert_eq!(emitted[0].status, "NeedsInput");
        assert_eq!(emitted[1].status, "Working");
        assert_eq!(emitted[1].message, "Finished Bash");
        assert_eq!(emitted[2].status, "Working");
        assert_eq!(emitted[2].message, "Running Bash");
    }

    #[tokio::test]
    async fn hook_status_emits_skip_unregistered_sessions() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, _p, _pend) = start_test_http_server("inst-secret", emit_fn).await;
        // Session 1 NOT registered.

        for (route, body) in [
            (
                "/hook/notification",
                serde_json::json!({"session_id": "u", "hook_event_name": "Notification", "message": "m"}),
            ),
            (
                "/hook/user-prompt",
                serde_json::json!({"session_id": "u", "hook_event_name": "UserPromptSubmit"}),
            ),
            (
                "/hook/session-end",
                serde_json::json!({"session_id": "u", "hook_event_name": "SessionEnd"}),
            ),
            (
                "/hook/pre-tool",
                serde_json::json!({"session_id": "u", "hook_event_name": "PreToolUse", "tool_name": "Bash"}),
            ),
        ] {
            assert_eq!(post_hook(addr, route, Some("inst-secret"), body).await, 200);
        }

        assert!(events.lock().unwrap().is_empty());
    }

    /// Issue #77 cause 3: a turn end for a session the server does not know
    /// about yet used to be logged and thrown away, so the UI never learned the
    /// agent had stopped. It is buffered now, and registration flushes it.
    #[tokio::test]
    async fn stop_hook_buffers_turn_end_for_unregistered_session() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, pending) =
            start_test_http_server("inst-secret", emit_fn.clone()).await;

        let body = serde_json::json!({
            "session_id": "claude-uuid",
            "hook_event_name": "Stop",
        });
        assert_eq!(
            post_hook(addr, "/hook/stop", Some("inst-secret"), body).await,
            200
        );

        // Nothing emitted yet — there is no project path to route it to…
        assert!(events.lock().unwrap().is_empty());
        {
            let buf = pending.read().await;
            assert_eq!(buf[&1].state, AWAITING_INPUT_STATE);
        }

        // …but the moment the session registers, the turn end reaches the UI.
        let server = StatusServer {
            port: 0,
            instance_id: "inst-secret".to_string(),
            emit_fn,
            session_projects: projects,
            pending_statuses: pending.clone(),
        };
        server.register_session(1, "/path/project").await;

        {
            let emitted = events.lock().unwrap();
            assert_eq!(emitted.len(), 1);
            assert_eq!(emitted[0].session_id, 1);
            assert_eq!(emitted[0].project_path, "/path/project");
            assert_eq!(emitted[0].status, "AwaitingInput");
        }
        assert!(pending.read().await.is_empty());
    }

    // ── Hash tests ──────────────────────────────────────────────────

    #[test]
    fn test_generate_project_hash() {
        let hash = StatusServer::generate_project_hash("/Users/test/project");
        assert_eq!(hash.len(), 12);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_hash_consistency() {
        let hash1 = StatusServer::generate_project_hash("/Users/test/project");
        let hash2 = StatusServer::generate_project_hash("/Users/test/project");
        assert_eq!(hash1, hash2);
    }

    // ── HTTP handler tests (multi-session routing) ──────────────────

    #[tokio::test]
    async fn test_multi_session_different_projects() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, _) = start_test_http_server("inst-1", emit_fn).await;

        // Register two sessions for different projects
        projects
            .write()
            .await
            .insert(1, "/path/project-a".to_string());
        projects
            .write()
            .await
            .insert(2, "/path/project-b".to_string());

        // Send status for each
        assert_eq!(
            post_status(addr, &make_status(1, "inst-1", "working", "Building")).await,
            200
        );
        assert_eq!(
            post_status(addr, &make_status(2, "inst-1", "idle", "Ready")).await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 2);

        assert_eq!(emitted[0].session_id, 1);
        assert_eq!(emitted[0].project_path, "/path/project-a");
        assert_eq!(emitted[0].status, "Working");

        assert_eq!(emitted[1].session_id, 2);
        assert_eq!(emitted[1].project_path, "/path/project-b");
        assert_eq!(emitted[1].status, "Idle");
    }

    #[tokio::test]
    async fn test_multi_session_same_project() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, _) = start_test_http_server("inst-1", emit_fn).await;

        // Two sessions sharing the same project (e.g. worktrees of same repo)
        projects
            .write()
            .await
            .insert(1, "/path/shared-project".to_string());
        projects
            .write()
            .await
            .insert(2, "/path/shared-project".to_string());

        assert_eq!(
            post_status(addr, &make_status(1, "inst-1", "working", "Task A")).await,
            200
        );
        assert_eq!(
            post_status(addr, &make_status(2, "inst-1", "idle", "Waiting")).await,
            200
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 2);

        // Both routed to the same project but tagged with different session IDs
        assert_eq!(emitted[0].session_id, 1);
        assert_eq!(emitted[0].project_path, "/path/shared-project");
        assert_eq!(emitted[0].status, "Working");

        assert_eq!(emitted[1].session_id, 2);
        assert_eq!(emitted[1].project_path, "/path/shared-project");
        assert_eq!(emitted[1].status, "Idle");
    }

    #[tokio::test]
    async fn test_stale_instance_accepted_for_registered_session() {
        // MCP server processes can be reused across Maestro restarts.
        // A registered session should be accepted even when the instance_id is stale.
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, _) = start_test_http_server("inst-current", emit_fn).await;

        projects
            .write()
            .await
            .insert(1, "/path/project".to_string());

        // Send with stale instance ID — should succeed because session is registered
        let code = post_status(addr, &make_status(1, "inst-old", "working", "Stale")).await;
        assert_eq!(code, 200);

        // Event should still be emitted
        let evts = events.lock().unwrap();
        assert_eq!(evts.len(), 1);
    }

    #[tokio::test]
    async fn test_wrong_instance_unregistered_session_returns_403() {
        // An unregistered session with a foreign instance_id is from a different
        // Maestro instance — reject it to prevent cross-instance pollution.
        let (emit_fn, events) = test_emit_fn();
        let (addr, _, _) = start_test_http_server("inst-current", emit_fn).await;
        // Session NOT registered

        let code = post_status(addr, &make_status(99, "inst-foreign", "idle", "Foreign")).await;
        assert_eq!(code, 403);

        assert!(events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_unregistered_session_returns_202_and_buffers() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, _, pending) = start_test_http_server("inst-1", emit_fn).await;

        // Send status before registering session
        let code = post_status(addr, &make_status(5, "inst-1", "idle", "Early bird")).await;
        assert_eq!(code, 202);

        // No event emitted (not yet registered)
        assert!(events.lock().unwrap().is_empty());

        // Status should be buffered
        let buf = pending.read().await;
        assert!(buf.contains_key(&5));
        assert_eq!(buf[&5].state, "idle");
        assert_eq!(buf[&5].message, "Early bird");
    }

    #[tokio::test]
    async fn test_unregister_does_not_affect_other_sessions() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, _) = start_test_http_server("inst-1", emit_fn).await;

        projects.write().await.insert(1, "/path/a".to_string());
        projects.write().await.insert(2, "/path/b".to_string());

        // Unregister session 1
        projects.write().await.remove(&1);

        // Session 2 should still work
        assert_eq!(
            post_status(addr, &make_status(2, "inst-1", "working", "Still here")).await,
            200
        );

        // Session 1 should be buffered (no longer registered)
        assert_eq!(
            post_status(addr, &make_status(1, "inst-1", "idle", "Gone")).await,
            202
        );

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].session_id, 2);
    }

    // ── StatusServer method tests (buffering / flushing) ────────────

    #[tokio::test]
    async fn test_register_flushes_buffered_status() {
        let (emit_fn, events) = test_emit_fn();
        let server = test_server("inst-1", emit_fn);

        // Simulate a buffered status (arrived before registration)
        server
            .pending_statuses
            .write()
            .await
            .insert(7, make_status(7, "inst-1", "idle", "Buffered hello"));

        // Register the session — should flush
        server.register_session(7, "/path/project-x").await;

        // Scoped so the std MutexGuard is dropped before the await below —
        // holding a blocking guard across an await point is how an async task
        // deadlocks itself once anything else contends for the same lock.
        {
            let emitted = events.lock().unwrap();
            assert_eq!(emitted.len(), 1);
            assert_eq!(emitted[0].session_id, 7);
            assert_eq!(emitted[0].project_path, "/path/project-x");
            assert_eq!(emitted[0].status, "Idle");
            assert_eq!(emitted[0].message, "Buffered hello");
        }

        // Buffer should be cleared
        assert!(server.pending_statuses.read().await.is_empty());
    }

    #[tokio::test]
    async fn test_register_without_buffer_emits_nothing() {
        let (emit_fn, events) = test_emit_fn();
        let server = test_server("inst-1", emit_fn);

        server.register_session(1, "/path/project").await;

        assert!(events.lock().unwrap().is_empty());
        assert_eq!(server.registered_sessions().await, vec![1]);
    }

    #[tokio::test]
    async fn test_unregister_cleans_up_buffer() {
        let (emit_fn, _events) = test_emit_fn();
        let server = test_server("inst-1", emit_fn);

        // Buffer a status, then register, then unregister
        server
            .pending_statuses
            .write()
            .await
            .insert(3, make_status(3, "inst-1", "working", "Will be cleaned"));
        server.register_session(3, "/path/project").await;
        server.unregister_session(3).await;

        assert!(server.session_projects.read().await.is_empty());
        assert!(server.pending_statuses.read().await.is_empty());
    }

    #[tokio::test]
    async fn test_multiple_projects_register_unregister_isolation() {
        let (emit_fn, events) = test_emit_fn();
        let server = test_server("inst-1", emit_fn);

        // Register 3 sessions across 2 projects
        server.register_session(1, "/project/alpha").await;
        server.register_session(2, "/project/beta").await;
        server.register_session(3, "/project/alpha").await;

        // Buffer a status for session 4 (not yet registered)
        server
            .pending_statuses
            .write()
            .await
            .insert(4, make_status(4, "inst-1", "idle", "Waiting"));

        // Unregister session 1 (project alpha)
        server.unregister_session(1).await;

        // Session 3 (also project alpha) should still be registered
        let registered = server.registered_sessions().await;
        assert!(registered.contains(&2));
        assert!(registered.contains(&3));
        assert!(!registered.contains(&1));

        // Register session 4 — should flush its buffer
        server.register_session(4, "/project/gamma").await;

        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].session_id, 4);
        assert_eq!(emitted[0].project_path, "/project/gamma");
    }

    #[tokio::test]
    async fn test_all_state_mappings() {
        let (emit_fn, events) = test_emit_fn();
        let (addr, projects, _) = start_test_http_server("inst-1", emit_fn).await;

        projects.write().await.insert(1, "/path/p".to_string());

        for (mcp_state, expected_status) in [
            ("idle", "Idle"),
            ("working", "Working"),
            ("needs_input", "NeedsInput"),
            ("finished", "Done"),
            ("error", "Error"),
            // Synthetic Stop-hook state — buffered turn ends flush through here.
            (AWAITING_INPUT_STATE, "AwaitingInput"),
        ] {
            post_status(addr, &make_status(1, "inst-1", mcp_state, "msg")).await;
            let emitted = events.lock().unwrap();
            let last = emitted.last().unwrap();
            assert_eq!(
                last.status, expected_status,
                "state '{}' should map to '{}'",
                mcp_state, expected_status
            );
        }

        assert_eq!(events.lock().unwrap().len(), 6);
    }

    // ── Hook endpoint tests ──────────────────────────────────────────

    /// Collected hook events.
    type HookEventLog = Arc<std::sync::Mutex<Vec<ClaudeEvent>>>;

    /// Spin up a test HTTP server with a hook_emit_fn that captures ClaudeEvents.
    async fn start_test_http_server_with_hooks() -> (HookEventLog, u16) {
        let hook_events: HookEventLog = Arc::new(std::sync::Mutex::new(Vec::new()));
        let hook_events_clone = hook_events.clone();

        let hook_emit_fn: HookEmitFn = Arc::new(move |event| {
            hook_events_clone.lock().unwrap().push(event);
        });

        let (emit_fn, _) = test_emit_fn();

        let state = Arc::new(ServerState {
            emit_fn,
            hook_emit_fn: Some(hook_emit_fn),
            instance_id: "test-instance".to_string(),
            session_projects: Arc::new(RwLock::new(HashMap::new())),
            pending_statuses: Arc::new(RwLock::new(HashMap::new())),
            notified_at: Arc::new(RwLock::new(HashMap::new())),
        });

        let app = build_router(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        (hook_events, port)
    }

    #[tokio::test]
    async fn test_hook_session_start() {
        let (hook_events, port) = start_test_http_server_with_hooks().await;

        // Must be inside ~/.claude/projects to pass the confinement check.
        let base = directories::BaseDirs::new().unwrap();
        let transcript = base
            .home_dir()
            .join(".claude/projects/enc/transcript.jsonl");
        let transcript_str = transcript.to_string_lossy().to_string();

        let body = serde_json::json!({
            "session_id": "claude-uuid-123",
            "transcript_path": transcript_str,
            "cwd": "/home/user/project",
            "hook_event_name": "SessionStart"
        });

        let resp = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{}/hook/session-start", port))
            .header("X-Maestro-Session", "42")
            .header("X-Maestro-Instance", "test-instance")
            .json(&body)
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status().as_u16(), 200);

        let events = hook_events.lock().unwrap();
        assert_eq!(events.len(), 1);

        match &events[0] {
            ClaudeEvent::SessionStarted {
                session_id,
                claude_session_uuid,
                transcript_path,
                ..
            } => {
                assert_eq!(*session_id, 42);
                assert_eq!(claude_session_uuid, "claude-uuid-123");
                assert_eq!(transcript_path, &transcript_str);
            }
            other => panic!("Expected SessionStarted, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_hook_missing_session_header() {
        let (_hook_events, port) = start_test_http_server_with_hooks().await;

        let base = directories::BaseDirs::new().unwrap();
        let transcript = base
            .home_dir()
            .join(".claude/projects/enc/transcript.jsonl");

        let body = serde_json::json!({
            "session_id": "claude-uuid-123",
            "transcript_path": transcript.to_string_lossy(),
            "cwd": "/home/user/project",
            "hook_event_name": "SessionStart"
        });

        // Valid instance header but no X-Maestro-Session header → 400.
        let resp = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{}/hook/session-start", port))
            .header("X-Maestro-Instance", "test-instance")
            .json(&body)
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status().as_u16(), 400);
    }
}
