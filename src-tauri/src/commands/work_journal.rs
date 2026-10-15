//! Tauri commands for the Work Journal file: load it, and create, update and
//! delete pages and settings, back it up, and restore it from a backup. The
//! file logic lives in [`crate::core::work_journal`]; these wrappers pick the
//! app-data path, serialise every read-modify-write, and run the blocking
//! file work off the async runtime.
//!
//! Every changing command returns the whole saved journal, so the frontend
//! never has to guess side effects (for example `deleted_dates` after a
//! delete).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::core::work_journal::{
    self, AutoBackupAfterRestore, PageOrigin, WorkJournal, WorkJournalError, WorkJournalResult,
};

/// Serialises load-change-save cycles so two commands never interleave and
/// lose a write.
static JOURNAL_LOCK: Mutex<()> = Mutex::new(());

/// `<work journal dir>/work-journal.json` (see
/// [`work_journal::work_journal_dir`] for the devtest override).
fn journal_path() -> PathBuf {
    work_journal::journal_path(&work_journal::work_journal_dir())
}

/// Runs `op` on a blocking thread while holding [`JOURNAL_LOCK`].
async fn with_journal<T: Send + 'static>(
    op: impl FnOnce(PathBuf) -> WorkJournalResult<T> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = JOURNAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        op(journal_path()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Work journal task failed: {e}"))?
}

/// Loads the journal; an empty one when no file exists yet (nothing written).
#[tauri::command]
pub async fn load_work_journal() -> Result<WorkJournal, String> {
    with_journal(|path| work_journal::load(&path)).await
}

/// Creates a page for `date` (`YYYY-MM-DD`); refused when it already has one.
/// `origin` defaults to manual.
#[tauri::command]
pub async fn create_work_journal_page(
    date: String,
    title: String,
    body: Value,
    origin: Option<PageOrigin>,
) -> Result<WorkJournal, String> {
    let origin = origin.unwrap_or(PageOrigin::Manual);
    with_journal(move |path| {
        work_journal::modify(&path, |j| {
            work_journal::create_page(j, &date, title, body, origin)
        })
    })
    .await
}

/// Changes the title and/or body of the page for `date`.
#[tauri::command]
pub async fn update_work_journal_page(
    date: String,
    title: Option<String>,
    body: Option<Value>,
) -> Result<WorkJournal, String> {
    with_journal(move |path| {
        work_journal::modify(&path, |j| work_journal::update_page(j, &date, title, body))
    })
    .await
}

/// Deletes the page for `date` and records the date in `deleted_dates`.
#[tauri::command]
pub async fn delete_work_journal_page(date: String) -> Result<WorkJournal, String> {
    with_journal(move |path| work_journal::modify(&path, |j| work_journal::delete_page(j, &date)))
        .await
}

/// Shallow-merges `settings` into the journal settings: each top-level key
/// sent overwrites or adds that key; keys not sent are kept.
#[tauri::command]
pub async fn update_work_journal_settings(
    settings: Map<String, Value>,
) -> Result<WorkJournal, String> {
    with_journal(move |path| {
        work_journal::modify(&path, |j| work_journal::merge_settings(j, settings))
    })
    .await
}

/// "Back up now": writes the journal to `<backup folder>/work-journal.json`
/// and records `last_backup_at`, replacing any file there (the explicit
/// override of the automatic guard). Refused when no folder is set or the
/// folder is missing; the journal is then left untouched.
#[tauri::command]
pub async fn work_journal_backup_now() -> Result<WorkJournal, String> {
    with_journal(|path| work_journal::backup_now(&path, chrono::Utc::now())).await
}

/// What the automatic backup did, tagged by `status` for the frontend.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BackupIfDueOutcome {
    /// A backup was written; the saved journal.
    Written { journal: WorkJournal },
    /// Nothing to do: no folder set, or not due yet.
    Idle,
    /// The guard refused to replace a backup this Maestro has not written.
    Skipped { message: String },
}

/// Maps the core result to the command's outcome: the guard's refusal is a
/// `Skipped` outcome, every other error stays an error.
fn backup_if_due_outcome(
    result: WorkJournalResult<Option<WorkJournal>>,
) -> WorkJournalResult<BackupIfDueOutcome> {
    match result {
        Ok(Some(journal)) => Ok(BackupIfDueOutcome::Written { journal }),
        Ok(None) => Ok(BackupIfDueOutcome::Idle),
        Err(e @ WorkJournalError::AutoBackupWouldReplaceUnknownBackup) => {
            Ok(BackupIfDueOutcome::Skipped {
                message: e.to_string(),
            })
        }
        Err(e) => Err(e),
    }
}

/// Backs up when a folder is set and the last backup is a day old (or
/// missing). Never replaces a backup file this Maestro has not written (see
/// [`work_journal::backup_if_due`]); that comes back as `Skipped`. Called on
/// start, by the in-app timer and after a folder is chosen.
#[tauri::command]
pub async fn work_journal_backup_if_due() -> Result<BackupIfDueOutcome, String> {
    with_journal(|path| {
        backup_if_due_outcome(work_journal::backup_if_due(&path, chrono::Utc::now()))
    })
    .await
}

/// Makes sure every day has its page up to `today` (`YYYY-MM-DD`, the
/// caller's local date): gap-fills from the last auto-created date, skips
/// deleted dates and existing pages, and saves only when something changed.
/// Returns the journal.
#[tauri::command]
pub async fn work_journal_ensure_pages(today: String) -> Result<WorkJournal, String> {
    with_journal(move |path| work_journal::ensure_pages_in_file(&path, &today)).await
}

/// A restore or undo reply: the whole saved journal, whether a readable
/// safety copy is there for "Undo restore", and what the automatic backup
/// does next (for the notice).
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkJournalRestoreReply {
    pub journal: WorkJournal,
    pub can_undo: bool,
    pub auto_backup: AutoBackupAfterRestore,
}

/// Builds the reply for a journal a restore or undo just saved at `path`.
fn restore_reply(path: &std::path::Path, journal: WorkJournal) -> WorkJournalRestoreReply {
    WorkJournalRestoreReply {
        can_undo: work_journal::can_undo_restore(path),
        auto_backup: work_journal::auto_backup_after_restore(&journal),
        journal,
    }
}

/// Whether "Undo restore" has a safety copy to put back.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkJournalRestoreState {
    pub can_undo: bool,
}

/// "Restore from backup": replaces the whole journal with the backup file
/// `file`, or with the backup in the configured folder when `file` is
/// `None`, after saving the current journal as the safety copy. Keeps the
/// local backup folder and clears the last backup time, so automatic
/// backups leave the backup folder alone until "Back up now".
#[tauri::command]
pub async fn restore_work_journal(file: Option<String>) -> Result<WorkJournalRestoreReply, String> {
    with_journal(move |path| {
        let source = match file {
            Some(file) => PathBuf::from(file),
            None => work_journal::default_restore_source(&path)?,
        };
        let journal = work_journal::restore_from(&path, &source)?;
        Ok(restore_reply(&path, journal))
    })
    .await
}

/// "Undo restore": puts the safety copy back and deletes it (undo works
/// once). Refused when there is no safety copy.
#[tauri::command]
pub async fn undo_work_journal_restore() -> Result<WorkJournalRestoreReply, String> {
    with_journal(|path| {
        let journal = work_journal::undo_restore(&path)?;
        Ok(restore_reply(&path, journal))
    })
    .await
}

/// Whether "Undo restore" is available (a readable safety copy exists).
#[tauri::command]
pub async fn work_journal_restore_state() -> Result<WorkJournalRestoreState, String> {
    with_journal(|path| {
        Ok(WorkJournalRestoreState {
            can_undo: work_journal::can_undo_restore(&path),
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backup_if_due_outcome_tags_each_case() {
        let written = backup_if_due_outcome(Ok(Some(WorkJournal::default()))).unwrap();
        assert_eq!(serde_json::to_value(&written).unwrap()["status"], "written");

        let idle = backup_if_due_outcome(Ok(None)).unwrap();
        assert_eq!(
            serde_json::to_value(&idle).unwrap(),
            serde_json::json!({"status": "idle"})
        );

        let skipped =
            backup_if_due_outcome(Err(WorkJournalError::AutoBackupWouldReplaceUnknownBackup))
                .unwrap();
        let value = serde_json::to_value(&skipped).unwrap();
        assert_eq!(value["status"], "skipped");
        assert!(value["message"]
            .as_str()
            .unwrap()
            .starts_with("Automatic backup skipped"));

        let failed = backup_if_due_outcome(Err(WorkJournalError::NoBackupFolder));
        assert!(matches!(failed, Err(WorkJournalError::NoBackupFolder)));
    }

    #[test]
    fn test_restore_replies_use_camel_case_for_the_frontend() {
        let reply = WorkJournalRestoreReply {
            journal: WorkJournal::default(),
            can_undo: true,
            auto_backup: AutoBackupAfterRestore::NoFolder,
        };
        let value = serde_json::to_value(&reply).unwrap();
        assert_eq!(value["canUndo"], true);
        assert_eq!(value["autoBackup"], "no_folder");
        assert_eq!(value["journal"]["layout_version"], 1);

        let state = WorkJournalRestoreState { can_undo: false };
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            serde_json::json!({"canUndo": false})
        );
    }
}
