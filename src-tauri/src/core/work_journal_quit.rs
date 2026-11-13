//! Quitting Maestro saves the Work Journal text still waiting in its windows.
//!
//! The main window's quit path destroys the windows, which skips the pop-out
//! window's close-requested save. So before the windows go, the backend asks
//! every Work Journal window to save (see `answerWorkJournalQuitFlush` in
//! `src/lib/workJournalWindow.ts`) and waits a short while for each answer.
//! A window that never answers (hung, or still loading) cannot hold up
//! quitting for longer than [`QUIT_FLUSH_TIMEOUT`].
//!
//! After that save, [`backup_before_quit`] writes the backup once more, so
//! the day's last writing reaches it (issue #568). It waits at most
//! [`QUIT_BACKUP_TIMEOUT`]; a failure is logged and Maestro closes anyway.

use std::collections::HashSet;
use std::future::Future;
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

/// The longest closing waits for the close backup. A local or synced folder
/// takes milliseconds; a folder that hangs (an offline network drive) must
/// not keep Maestro open.
pub const QUIT_BACKUP_TIMEOUT: Duration = Duration::from_secs(2);

/// How the close backup went.
#[derive(Debug, PartialEq)]
enum CloseBackup {
    Written,
    /// No backup folder set: nothing to do.
    NoFolder,
    /// Refused or failed; the error's own text.
    Failed(String),
    TimedOut,
}

/// Writes the Work Journal backup before Maestro closes (when a folder is
/// set), waiting at most [`QUIT_BACKUP_TIMEOUT`]. Never fails: the result is
/// only logged, so closing always goes on.
pub async fn backup_before_quit() {
    let outcome = bounded_backup(
        crate::commands::work_journal::backup_on_close(),
        QUIT_BACKUP_TIMEOUT,
    )
    .await;
    if let Some((level, message)) = close_backup_log(&outcome) {
        log::log!(level, "{message}");
    }
}

/// Runs `backup`, giving up after `timeout`. A backup still writing then
/// finishes on its own thread or stops when the app exits; its
/// temp-then-rename write leaves the old backup or the new one, never half.
async fn bounded_backup(
    backup: impl Future<Output = Result<bool, String>>,
    timeout: Duration,
) -> CloseBackup {
    match tokio::time::timeout(timeout, backup).await {
        Ok(Ok(true)) => CloseBackup::Written,
        Ok(Ok(false)) => CloseBackup::NoFolder,
        Ok(Err(e)) => CloseBackup::Failed(e),
        Err(_) => CloseBackup::TimedOut,
    }
}

/// The log line for a close backup; none when no folder is set.
fn close_backup_log(outcome: &CloseBackup) -> Option<(log::Level, String)> {
    match outcome {
        CloseBackup::Written => Some((
            log::Level::Info,
            "Work Journal backed up on close".to_string(),
        )),
        CloseBackup::NoFolder => None,
        CloseBackup::Failed(e) => Some((
            log::Level::Warn,
            format!("Work Journal backup on close not written; Maestro closes anyway: {e}"),
        )),
        CloseBackup::TimedOut => Some((
            log::Level::Warn,
            format!(
                "Work Journal backup on close did not finish within {} s; Maestro closes anyway",
                QUIT_BACKUP_TIMEOUT.as_secs()
            ),
        )),
    }
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

    #[tokio::test]
    async fn test_close_backup_reports_written_no_folder_and_failure() {
        let cases = [
            (Ok(true), CloseBackup::Written),
            (Ok(false), CloseBackup::NoFolder),
            (
                Err("Backup failed: disk full".to_string()),
                CloseBackup::Failed("Backup failed: disk full".to_string()),
            ),
        ];
        for (result, expected) in cases {
            let outcome = bounded_backup(async { result }, QUIT_BACKUP_TIMEOUT).await;
            assert_eq!(outcome, expected);
        }
    }

    #[tokio::test]
    async fn test_close_backup_that_hangs_gives_up_after_the_timeout() {
        let timeout = Duration::from_millis(50);
        let started = std::time::Instant::now();
        let outcome = bounded_backup(std::future::pending(), timeout).await;
        assert_eq!(outcome, CloseBackup::TimedOut);
        assert!(started.elapsed() >= timeout);
        assert!(
            started.elapsed() < QUIT_BACKUP_TIMEOUT,
            "closing is not held up"
        );
    }

    #[test]
    fn test_close_backup_failure_is_logged_as_a_warning_and_closing_goes_on() {
        let failed =
            CloseBackup::Failed("Backup failed: the backup folder X: does not exist".into());
        let (level, line) = close_backup_log(&failed).unwrap();
        assert_eq!(level, log::Level::Warn);
        assert_eq!(
            line,
            "Work Journal backup on close not written; Maestro closes anyway: Backup failed: the \
             backup folder X: does not exist"
        );
        let (level, line) = close_backup_log(&CloseBackup::TimedOut).unwrap();
        assert_eq!(level, log::Level::Warn);
        assert!(line.contains("did not finish within 2 s"), "{line}");
        assert_eq!(
            close_backup_log(&CloseBackup::NoFolder),
            None,
            "no folder: silent"
        );
        let (level, _) = close_backup_log(&CloseBackup::Written).unwrap();
        assert_eq!(level, log::Level::Info);
    }

    #[test]
    fn test_answer_payload_reads_the_window_label() {
        let payload: QuitFlushedPayload =
            serde_json::from_str(r#"{"label":"work-journal"}"#).unwrap();
        assert_eq!(payload.label.as_deref(), Some("work-journal"));
    }
}
