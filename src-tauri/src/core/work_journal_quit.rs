//! Quitting Maestro saves the Work Journal text still waiting in its windows.
//!
//! The main window's quit path destroys the windows, which skips the pop-out
//! window's close-requested save. So before the windows go, the backend asks
//! every Work Journal window to save (see `answerWorkJournalQuitFlush` in
//! `src/lib/workJournalWindow.ts`) and waits a short while for each answer.
//! A window that never answers (hung, or still loading) cannot hold up
//! quitting for longer than [`QUIT_FLUSH_TIMEOUT`].

use std::collections::HashSet;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

/// Backend → every window: save the Work Journal text still waiting.
pub const QUIT_FLUSH_EVENT: &str = "work-journal:quit-flush";
/// Window → backend: that window's saves have finished.
pub const QUIT_FLUSHED_EVENT: &str = "work-journal:quit-flushed";
/// The longest quitting waits for the windows' answers.
pub const QUIT_FLUSH_TIMEOUT: Duration = Duration::from_millis(1500);

/// The windows that can hold Work Journal text: the main window's pane and
/// the pop-out window.
const JOURNAL_WINDOW_LABELS: [&str; 2] = ["main", "work-journal"];

/// Payload of [`QUIT_FLUSHED_EVENT`].
#[derive(Deserialize)]
struct QuitFlushedPayload {
    label: Option<String>,
}

/// Asks every open Work Journal window to save its waiting text, and returns
/// once each has answered or [`QUIT_FLUSH_TIMEOUT`] passed.
pub async fn flush_before_quit(app: &AppHandle) {
    let expected: HashSet<String> = JOURNAL_WINDOW_LABELS
        .iter()
        .filter(|label| app.get_webview_window(label).is_some())
        .map(|label| label.to_string())
        .collect();
    if expected.is_empty() {
        return;
    }
    let (tx, rx) = unbounded_channel();
    let id = app.listen(QUIT_FLUSHED_EVENT, move |event| {
        if let Ok(QuitFlushedPayload { label: Some(label) }) = serde_json::from_str(event.payload())
        {
            let _ = tx.send(label);
        }
    });
    match app.emit(QUIT_FLUSH_EVENT, ()) {
        Ok(()) => {
            if !wait_for_answers(rx, expected, QUIT_FLUSH_TIMEOUT).await {
                log::warn!("Work Journal windows did not confirm their saves before quitting");
            }
        }
        Err(e) => log::warn!("Failed to ask the Work Journal windows to save: {e}"),
    }
    app.unlisten(id);
}

/// Whether every `expected` window label arrived on `answers` within `timeout`.
async fn wait_for_answers(
    mut answers: UnboundedReceiver<String>,
    mut expected: HashSet<String>,
    timeout: Duration,
) -> bool {
    let all = async move {
        while !expected.is_empty() {
            match answers.recv().await {
                Some(label) => {
                    expected.remove(&label);
                }
                None => return false,
            }
        }
        true
    };
    tokio::time::timeout(timeout, all).await.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(list: &[&str]) -> HashSet<String> {
        list.iter().map(|l| l.to_string()).collect()
    }

    #[tokio::test]
    async fn test_wait_returns_once_every_window_answered() {
        let (tx, rx) = unbounded_channel();
        tx.send("work-journal".to_string()).unwrap();
        tx.send("main".to_string()).unwrap();
        let started = std::time::Instant::now();
        assert!(wait_for_answers(rx, labels(&["main", "work-journal"]), QUIT_FLUSH_TIMEOUT).await);
        assert!(started.elapsed() < QUIT_FLUSH_TIMEOUT);
    }

    #[tokio::test]
    async fn test_wait_gives_up_after_the_timeout_when_a_window_never_answers() {
        let (tx, rx) = unbounded_channel();
        tx.send("main".to_string()).unwrap();
        // Another window's answer does not count for the missing one.
        tx.send("issue-map".to_string()).unwrap();
        let timeout = Duration::from_millis(50);
        let started = std::time::Instant::now();
        assert!(!wait_for_answers(rx, labels(&["main", "work-journal"]), timeout).await);
        assert!(started.elapsed() >= timeout);
        drop(tx);
    }

    #[tokio::test]
    async fn test_wait_stops_when_no_answer_can_come_any_more() {
        let (tx, rx) = unbounded_channel::<String>();
        drop(tx);
        assert!(!wait_for_answers(rx, labels(&["main"]), QUIT_FLUSH_TIMEOUT).await);
    }

    #[test]
    fn test_answer_payload_reads_the_window_label() {
        let payload: QuitFlushedPayload =
            serde_json::from_str(r#"{"label":"work-journal"}"#).unwrap();
        assert_eq!(payload.label.as_deref(), Some("work-journal"));
    }
}
