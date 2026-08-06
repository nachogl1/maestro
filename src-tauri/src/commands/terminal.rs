use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::core::samurai_context::SamuraiContextStore;
use crate::core::session_manager::SessionManager;
use crate::core::status_server::StatusServer;
use crate::core::transcript_watcher::TranscriptWatcher;
use crate::core::{BackendCapabilities, BackendType, ProcessManager, PtyError};

/// Backend information returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    /// The active backend type.
    pub backend_type: BackendType,
    /// Backend capabilities.
    pub capabilities: BackendCapabilitiesDto,
}

/// DTO for backend capabilities (frontend-friendly naming).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendCapabilitiesDto {
    pub enhanced_state: bool,
    pub text_reflow: bool,
    pub kitty_graphics: bool,
    pub shell_integration: bool,
    pub backend_name: String,
}

impl From<BackendCapabilities> for BackendCapabilitiesDto {
    fn from(caps: BackendCapabilities) -> Self {
        Self {
            enhanced_state: caps.enhanced_state,
            text_reflow: caps.text_reflow,
            kitty_graphics: caps.kitty_graphics,
            shell_integration: caps.shell_integration,
            backend_name: caps.backend_name.to_string(),
        }
    }
}

/// Returns information about the active terminal backend.
///
/// The frontend can use this to enable/disable features based on
/// backend capabilities (e.g., enhanced terminal state queries).
#[tauri::command]
pub fn get_backend_info() -> BackendInfo {
    let backend_type = BackendType::platform_default();

    let capabilities = match backend_type {
        BackendType::XtermPassthrough => BackendCapabilities {
            enhanced_state: false,
            text_reflow: false,
            kitty_graphics: false,
            shell_integration: false,
            backend_name: "xterm-passthrough",
        },
        BackendType::VteParser => BackendCapabilities {
            enhanced_state: true,
            text_reflow: false,
            kitty_graphics: false,
            shell_integration: false,
            backend_name: "vte-parser",
        },
    };

    BackendInfo {
        backend_type,
        capabilities: capabilities.into(),
    }
}

/// Exposes `ProcessManager::spawn_shell` to the frontend.
///
/// Validates that `cwd` (if provided) exists and is a directory before
/// forwarding to the process manager. Returns the new session ID.
/// The frontend should listen on `pty-output-{id}` for shell output events.
///
/// # Environment Variables
/// The `env` parameter allows passing environment variables to the shell process.
/// These are inherited by all child processes (including Claude CLI → MCP server).
/// Common usage: `{ "MAESTRO_PROJECT_HASH": "<hash>" }` for MCP status identification.
/// Note: `MAESTRO_SESSION_ID` is automatically set by the process manager.
#[tauri::command]
pub async fn spawn_shell(
    app_handle: AppHandle,
    state: State<'_, ProcessManager>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<u32, PtyError> {
    // Validate cwd if provided: must exist and be a directory
    let canonical_cwd = if let Some(ref dir) = cwd {
        let path = std::path::Path::new(dir);
        let canonical = path
            .canonicalize()
            .map_err(|e| PtyError::spawn_failed(format!("Invalid cwd '{dir}': {e}")))?;
        if !canonical.is_dir() {
            return Err(PtyError::spawn_failed(format!(
                "cwd '{dir}' is not a directory"
            )));
        }
        // On Windows, canonicalize() prepends \\?\ (the Win32 extended-length
        // path prefix). cmd.exe treats that as a UNC path and refuses to use it
        // as a working directory, falling back to C:\Windows instead.
        // Strip the prefix so the shell receives a normal path.
        #[cfg(windows)]
        let canonical = {
            let s = canonical.to_string_lossy();
            match s.strip_prefix(r"\\?\") {
                Some(stripped) => std::path::PathBuf::from(stripped),
                None => canonical,
            }
        };

        Some(canonical.to_string_lossy().into_owned())
    } else {
        None
    };
    let pm = state.inner().clone();
    pm.spawn_shell(app_handle, canonical_cwd, env).await
}

/// Exposes `ProcessManager::write_stdin` to the frontend.
/// Sends raw text (including control sequences like `\r`) to the PTY.
///
/// The body is fully blocking — it takes a `std::sync::Mutex` guard and calls
/// `write_all` + `flush` on the PTY input pipe, which has no bounded completion
/// time when the child is not draining stdin. Running that inline would occupy
/// a tokio runtime worker, so it is handed to the blocking pool instead.
/// Ordering is unaffected: the frontend awaits each write before issuing the
/// next one for a given session.
#[tauri::command]
pub async fn write_stdin(
    state: State<'_, ProcessManager>,
    session_id: u32,
    data: String,
) -> Result<(), PtyError> {
    let pm = state.inner().clone();
    tokio::task::spawn_blocking(move || pm.write_stdin(session_id, &data))
        .await
        .map_err(|e| PtyError::write_failed(format!("Write task failed: {e}")))?
}

/// Exposes `ProcessManager::resize_pty` to the frontend.
/// Rejects dimensions that are zero or exceed 500 to prevent misuse.
///
/// Like `write_stdin`, the body is blocking (`ResizePseudoConsole` under a
/// `std::sync::Mutex`), so it runs on the blocking pool rather than holding a
/// tokio runtime worker.
#[tauri::command]
pub async fn resize_pty(
    state: State<'_, ProcessManager>,
    session_id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), PtyError> {
    if rows == 0 || cols == 0 || rows > 500 || cols > 500 {
        return Err(PtyError::resize_failed("Invalid dimensions"));
    }
    let pm = state.inner().clone();
    tokio::task::spawn_blocking(move || pm.resize_pty(session_id, rows, cols))
        .await
        .map_err(|e| PtyError::resize_failed(format!("Resize task failed: {e}")))?
}

/// Exposes `ProcessManager::kill_session` to the frontend.
/// Gracefully terminates the PTY session (SIGTERM, then SIGKILL after 3s).
/// Also unregisters the session from the status server and stops the
/// transcript watcher so its notify handle and tokio task are released
/// (entries otherwise accumulate until the watcher cap refuses new sessions).
#[tauri::command]
pub async fn kill_session(
    state: State<'_, ProcessManager>,
    session_mgr: State<'_, SessionManager>,
    status_server: State<'_, Arc<StatusServer>>,
    transcript_watcher: State<'_, Arc<TranscriptWatcher>>,
    samurai_context: State<'_, Arc<SamuraiContextStore>>,
    session_id: u32,
) -> Result<(), PtyError> {
    // Kill the PTY session
    let pm = state.inner().clone();
    let result = pm.kill_session(session_id).await;

    // Unregister the session from the status server so it stops accepting updates
    status_server.unregister_session(session_id).await;

    // Release the transcript watcher entry for this terminal
    transcript_watcher.stop_watching(session_id);

    // Drop the samurai context entry — a stale percentage for a gone
    // session must never arm a handoff (issue #52)
    samurai_context.remove(session_id);

    // Log for debugging
    let _project_path = session_mgr
        .all_sessions()
        .into_iter()
        .find(|s| s.id == session_id)
        .map(|s| s.project_path);

    result
}

/// Saves image data from the frontend clipboard to a temporary file.
///
/// Called by the frontend when the user pastes an image into the terminal.
/// The image bytes are written to a temp file and the absolute path is returned
/// so the frontend can insert it into the terminal input for Claude to read.
///
/// The bytes arrive as the raw IPC request body (`application/octet-stream`)
/// rather than a JSON field: as JSON, Tauri renders every image byte as a
/// decimal-digit string (~4x expansion) on the webview's main thread, which
/// froze the UI for large screenshots. The media type rides in a header.
#[tauri::command]
pub async fn save_pasted_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    const MAX_IMAGE_SIZE: usize = 50 * 1024 * 1024; // 50 MB

    // Normally the bytes arrive raw. Tauri falls back to `postMessage` when the
    // custom protocol is unavailable (e.g. a restrictive CSP), and that path
    // JSON-encodes the payload into an array of numbers — so accept both, or
    // pasting an image fails outright on the fallback.
    let data: std::borrow::Cow<'_, [u8]> = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => std::borrow::Cow::Borrowed(data.as_slice()),
        tauri::ipc::InvokeBody::Json(value) => {
            let array = value
                .as_array()
                .ok_or_else(|| "Expected image bytes in the request body".to_string())?;
            let mut bytes = Vec::with_capacity(array.len());
            for entry in array {
                let byte = entry
                    .as_u64()
                    .filter(|n| *n <= u8::MAX as u64)
                    .ok_or_else(|| "Image body contained a non-byte value".to_string())?;
                bytes.push(byte as u8);
            }
            std::borrow::Cow::Owned(bytes)
        }
    };
    if data.len() > MAX_IMAGE_SIZE {
        return Err(format!(
            "Image too large: {} bytes (max {MAX_IMAGE_SIZE})",
            data.len()
        ));
    }

    let media_type = request
        .headers()
        .get("media-type")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Missing media-type header".to_string())?;

    let extension = match media_type {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => {
            return Err(format!("Unsupported media type: {media_type}"));
        }
    };

    let filename = format!("maestro-paste-{}.{}", uuid::Uuid::new_v4(), extension);
    let path = std::env::temp_dir().join(filename);

    tokio::fs::write(&path, data)
        .await
        .map_err(|e| format!("Failed to save pasted image: {e}"))?;

    log::info!("Saved pasted image to {}", path.display());
    Ok(path.to_string_lossy().into_owned())
}

/// Kills all active PTY sessions and clears the session registry.
///
/// Used to clean up orphaned sessions when the frontend reloads.
/// Clears both PTY processes (ProcessManager) and session metadata
/// (SessionManager) to prevent stale "idle" sessions from appearing
/// in the sidebar after a page reload.
/// Returns the number of PTY sessions that were killed.
#[tauri::command]
pub async fn kill_all_sessions(
    state: State<'_, ProcessManager>,
    session_state: State<'_, SessionManager>,
    transcript_watcher: State<'_, Arc<TranscriptWatcher>>,
    samurai_context: State<'_, Arc<SamuraiContextStore>>,
) -> Result<u32, PtyError> {
    let pm = state.inner().clone();
    let killed = pm.kill_all_sessions().await?;
    let cleared = session_state.clear_all();
    // Release every transcript watcher too: watchers are capped, and a
    // frontend reload that leaks them eventually starves new sessions of
    // their activity feed.
    for session_id in transcript_watcher.watched_sessions() {
        transcript_watcher.stop_watching(session_id);
    }
    // Every session is gone: clear the whole samurai context store, which
    // may hold entries for sessions whose watcher already stopped (issue #52)
    samurai_context.clear();
    log::info!(
        "Cleanup: killed {} PTY session(s), cleared {} session entries",
        killed,
        cleared
    );
    Ok(killed)
}

/// Checks if a command is available in the user's PATH.
///
/// On macOS/Linux, when the app is launched from GUI launchers (Raycast, Spotlight),
/// the PATH is minimal and doesn't include user installations. This function searches
/// common installation directories directly without spawning a shell (which can cause
/// issues with shell plugins like powerlevel10k).
///
/// On Windows, uses `where.exe` to check.
#[tauri::command]
pub async fn check_cli_available(command: String) -> Result<bool, String> {
    #[cfg(unix)]
    {
        // Search the augmented PATH (env PATH + common install dirs missed by
        // GUI launchers). We avoid spawning a shell because shell plugins
        // (oh-my-zsh, powerlevel10k) can hang or abort when run without a TTY.
        use crate::core::cli_path::augmented_path;

        for dir in augmented_path().split(':').filter(|s| !s.is_empty()) {
            let cmd_path = format!("{}/{}", dir, command);
            if std::path::Path::new(&cmd_path).exists() {
                log::debug!("Found {} at {}", command, cmd_path);
                return Ok(true);
            }
        }

        log::debug!("Command {} not found in PATH", command);
        Ok(false)
    }

    #[cfg(windows)]
    {
        use crate::core::windows_process::TokioCommandExt;
        let output = tokio::process::Command::new("where.exe")
            .arg(&command)
            .hide_console_window()
            .output()
            .await
            .map_err(|e| format!("Failed to check CLI: {}", e))?;
        Ok(output.status.success())
    }
}
