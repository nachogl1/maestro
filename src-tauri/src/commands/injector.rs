//! Injector sidebar tab: types one message into several running Maestro
//! terminals at once and presses Enter in each.
//!
//! Delivery reuses `core::samurai_pty::submit_instruction_confirmed` — the
//! same chunked body + delayed lone Enter every injected instruction uses
//! (Samurai briefs, `/rename`, harvest). A single `"{text}\r"` write does NOT
//! submit in the Claude CLI: the burst reads as a paste and the carriage
//! return lands in the input box as a newline (see that module's docs).

use tauri::State;

use crate::core::process_manager::ProcessManager;
use crate::core::samurai_pty;

/// Rejects a message that would type nothing. A whitespace-only message
/// would still send the lone Enter, which submits whatever the user had left
/// half-typed in that terminal's input box.
pub fn validate_message(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("Message is empty".to_string());
    }
    Ok(())
}

/// Types `text` into Maestro terminal `session_id` and submits it with Enter.
///
/// Returns `Ok` once the message body has reached the PTY; the Enter follows
/// after the CLI's paste-settle gap, fire-and-forget like every other
/// injected instruction (a swallowed Enter leaves the text visible in the
/// input box, which the user can submit by hand).
#[tauri::command]
pub async fn inject_message(
    processes: State<'_, ProcessManager>,
    session_id: u32,
    text: String,
) -> Result<(), String> {
    validate_message(&text)?;
    let pm = processes.inner().clone();
    // `submit_instruction_confirmed` blocks (std mutex + pipe write + sleeps
    // between frames), so it runs on the blocking pool, never on a runtime
    // worker.
    tokio::task::spawn_blocking(move || {
        samurai_pty::submit_instruction_confirmed(pm, session_id, text, "injector")
    })
    .await
    .map_err(|e| format!("inject task for session {session_id} failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_empty_or_whitespace_only_message() {
        assert!(validate_message("").is_err());
        assert!(validate_message("   \n\t ").is_err());
    }

    #[test]
    fn accepts_a_real_message() {
        assert!(validate_message("please commit your work").is_ok());
    }
}
