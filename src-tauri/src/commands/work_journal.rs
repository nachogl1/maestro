//! Tauri commands for the Work Journal file: load it, and create, update and
//! delete pages and settings, and back it up. The file logic lives in
//! [`crate::core::work_journal`]; these wrappers pick the app-data path,
//! serialise every read-modify-write, and run the blocking file work off the
//! async runtime.
//!
//! Every changing command returns the whole saved journal, so the frontend
//! never has to guess side effects (for example `deleted_dates` after a
//! delete).

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::core::work_journal::{self, PageOrigin, WorkJournal, WorkJournalResult};

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

/// Writes the journal to `<backup folder>/work-journal.json` now and records
/// `last_backup_at`. Refused when no folder is set or the folder is missing;
/// the journal is then left untouched.
#[tauri::command]
pub async fn work_journal_backup_now() -> Result<WorkJournal, String> {
    with_journal(|path| work_journal::backup_now(&path, chrono::Utc::now())).await
}

/// Backs up when a folder is set and the last backup is a day old (or
/// missing); returns `None` and writes nothing otherwise. Called on start
/// and by the in-app timer.
#[tauri::command]
pub async fn work_journal_backup_if_due() -> Result<Option<WorkJournal>, String> {
    with_journal(|path| work_journal::backup_if_due(&path, chrono::Utc::now())).await
}

/// Makes sure every day has its page up to `today` (`YYYY-MM-DD`, the
/// caller's local date): gap-fills from the last auto-created date, skips
/// deleted dates and existing pages, and saves only when something changed.
/// Returns the journal.
#[tauri::command]
pub async fn work_journal_ensure_pages(today: String) -> Result<WorkJournal, String> {
    with_journal(move |path| work_journal::ensure_pages_in_file(&path, &today)).await
}
