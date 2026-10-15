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

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};

use crate::core::work_journal::{
    self, PageOrigin, WorkJournal, WorkJournalError, WorkJournalResult,
};
use crate::core::work_journal_run::{self, CandidatesAdded, RunReport};

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
    Written { journal: Box<WorkJournal> },
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
        Ok(Some(journal)) => Ok(BackupIfDueOutcome::Written {
            journal: Box::new(journal),
        }),
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

/// What a candidate run did, tagged by `status` for the frontend.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CandidateRunOutcome {
    /// The run finished: how many candidates it added, the dates that got
    /// them, and the saved `last_run_at`.
    Ran {
        added: usize,
        dates: Vec<String>,
        #[serde(rename = "lastRunAt")]
        last_run_at: String,
    },
    /// Another run is still going; nothing was started.
    Busy,
    /// No project is open, so nothing was collected and `last_run_at` was
    /// left alone: the time stays covered for the next run that has projects.
    NoProjects,
    /// One or more dates failed with `message`. Candidates of the dates that
    /// succeeded were kept; `last_run_at` stopped at the earliest failed date.
    Failed {
        message: String,
        added: usize,
        dates: Vec<String>,
        #[serde(rename = "lastRunAt")]
        last_run_at: String,
    },
}

/// Maps a finished run and its saved `last_run_at` to the command's outcome.
fn candidate_run_outcome(report: RunReport, last_run_at: String) -> CandidateRunOutcome {
    match report.error {
        None => CandidateRunOutcome::Ran {
            added: report.added,
            dates: report.dates,
            last_run_at,
        },
        Some(message) => CandidateRunOutcome::Failed {
            message,
            added: report.added,
            dates: report.dates,
            last_run_at,
        },
    }
}

/// `NoProjects` when no project path is given (blank paths do not count).
/// Maestro starts with no tabs, so a run then would mark the whole time it
/// was closed as done without ever collecting it.
fn skip_without_projects(projects: &[String]) -> Option<CandidateRunOutcome> {
    projects
        .iter()
        .all(|path| path.trim().is_empty())
        .then_some(CandidateRunOutcome::NoProjects)
}

/// Runs the Work Journal candidate run over `projects` (their paths): the
/// activity since `last_run_at` (or one interval back) becomes pending
/// candidates, one headless `claude` call per date that has activity. Saves
/// `last_run_at` and emits [`work_journal_run::CANDIDATES_EVENT`] when
/// candidates were added. Only one run at a time; a second request while one
/// runs gets `Busy`. With no projects nothing runs (`NoProjects`).
#[tauri::command]
pub async fn work_journal_run_candidates(
    app: AppHandle,
    projects: Vec<String>,
) -> Result<CandidateRunOutcome, String> {
    if let Some(outcome) = skip_without_projects(&projects) {
        return Ok(outcome);
    }
    let Some(_running) = work_journal_run::try_begin_run() else {
        return Ok(CandidateRunOutcome::Busy);
    };
    let journal = with_journal(|path| work_journal::load(&path)).await?;
    let report = work_journal_run::run_candidates(&journal, &projects, Utc::now()).await;
    if report.added > 0 {
        let payload = CandidatesAdded {
            dates: report.dates.clone(),
            added: report.added,
        };
        let _ = app.emit(work_journal_run::CANDIDATES_EVENT, payload);
    }
    let last_run_at = report
        .covered_until
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    let saved = last_run_at.clone();
    with_journal(move |path| {
        work_journal::modify(&path, |j| {
            j.settings.last_run_at = Some(saved);
            Ok(())
        })
    })
    .await?;
    Ok(candidate_run_outcome(report, last_run_at))
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
    fn test_candidate_run_outcome_tags_each_case() {
        let at = "2026-10-15T12:00:00Z".to_string();
        let report = |error: Option<&str>| RunReport {
            added: 2,
            dates: vec!["2026-10-15".to_string()],
            covered_until: chrono::DateTime::parse_from_rfc3339(&at)
                .unwrap()
                .with_timezone(&Utc),
            error: error.map(str::to_string),
        };

        let ran = candidate_run_outcome(report(None), at.clone());
        assert_eq!(
            serde_json::to_value(&ran).unwrap(),
            serde_json::json!({
                "status": "ran", "added": 2, "dates": ["2026-10-15"], "lastRunAt": at
            })
        );

        let failed = candidate_run_outcome(report(Some("claude timed out")), at.clone());
        let value = serde_json::to_value(&failed).unwrap();
        assert_eq!(value["status"], "failed");
        assert_eq!(value["message"], "claude timed out");
        assert_eq!(value["added"], 2);
        assert_eq!(value["lastRunAt"], at.as_str());

        assert_eq!(
            serde_json::to_value(CandidateRunOutcome::Busy).unwrap(),
            serde_json::json!({"status": "busy"})
        );
        assert_eq!(
            serde_json::to_value(CandidateRunOutcome::NoProjects).unwrap(),
            serde_json::json!({"status": "no_projects"})
        );
    }

    #[test]
    fn test_a_run_without_projects_is_skipped() {
        assert_eq!(
            skip_without_projects(&[]),
            Some(CandidateRunOutcome::NoProjects)
        );
        assert_eq!(
            skip_without_projects(&[" ".to_string()]),
            Some(CandidateRunOutcome::NoProjects)
        );
        assert_eq!(skip_without_projects(&["C:\\git\\p".to_string()]), None);
    }
}
