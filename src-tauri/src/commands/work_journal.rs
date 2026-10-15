//! Tauri commands for the Work Journal file: load it, and create, update and
//! delete pages and settings. The file logic lives in
//! [`crate::core::work_journal`]; these wrappers pick the app-data path,
//! serialise every read-modify-write, and run the blocking file work off the
//! async runtime.
//!
//! Every changing command returns the whole saved journal, so the frontend
//! never has to guess side effects (for example `deleted_dates` after a
//! delete).

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

use crate::commands::ai_runner::artifact_base_dir;
use crate::core::work_journal::{
    self, PageOrigin, WorkJournal, WorkJournalResult, WorkJournalSettings,
};

/// Serialises load-change-save cycles so two commands never interleave and
/// lose a write.
static JOURNAL_LOCK: Mutex<()> = Mutex::new(());

/// `<app data>/work-journal/work-journal.json`.
fn journal_path() -> PathBuf {
    work_journal::journal_path(&artifact_base_dir("work-journal"))
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

/// Replaces the journal settings.
#[tauri::command]
pub async fn update_work_journal_settings(
    settings: WorkJournalSettings,
) -> Result<WorkJournal, String> {
    with_journal(move |path| {
        work_journal::modify(&path, |j| {
            work_journal::set_settings(j, settings);
            Ok(())
        })
    })
    .await
}
