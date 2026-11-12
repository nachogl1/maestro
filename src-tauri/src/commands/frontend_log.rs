//! IPC command that writes front-end errors into the app's log file.
//!
//! A release build has no web console, so an error thrown by a button handler
//! would otherwise vanish without a trace; the front end forwards them here.

/// Longest message kept, so a runaway error can't flood the log.
const MAX_MESSAGE_CHARS: usize = 4000;

/// The message as it is logged: trimmed to `MAX_MESSAGE_CHARS` characters.
fn bounded(message: &str) -> String {
    match message.char_indices().nth(MAX_MESSAGE_CHARS) {
        Some((cut, _)) => format!("{}… (truncated)", &message[..cut]),
        None => message.to_string(),
    }
}

/// Logs a front-end message at `level` ("error", anything else as a warning).
#[tauri::command]
pub fn log_frontend_message(level: String, message: String) {
    let message = bounded(&message);
    if level == "error" {
        log::error!("[frontend] {message}");
    } else {
        log::warn!("[frontend] {message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_short_messages_and_truncates_long_ones() {
        assert_eq!(bounded("boom"), "boom");
        let long = "é".repeat(MAX_MESSAGE_CHARS + 10);
        let kept = bounded(&long);
        assert!(kept.starts_with(&"é".repeat(MAX_MESSAGE_CHARS)));
        assert!(kept.ends_with("… (truncated)"));
    }
}
