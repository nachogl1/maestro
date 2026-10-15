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

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};

use crate::core::work_journal::{
    self, AutoBackupAfterRestore, PageOrigin, WorkJournal, WorkJournalError, WorkJournalResult,
};
use crate::core::work_journal_activity::{
    self, ActivityError, ActivityResult, Candidate, CandidateState,
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

/// Whether Granola is connected in the user's Claude setup, for the
/// suggestions box's one-time opt-in question.
#[derive(Debug, PartialEq, Serialize)]
pub struct GranolaStatus {
    pub connected: bool,
}

/// Runs the Granola preflight (`claude mcp list`; see
/// [`work_journal_run::granola_preflight`]). Reads no meeting; any failure
/// is "not connected", never an error.
#[tauri::command]
pub async fn work_journal_granola_status() -> Result<GranolaStatus, String> {
    Ok(GranolaStatus {
        connected: work_journal_run::granola_preflight().await,
    })
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

/// Every candidate (pending and rejected) for `date` (`YYYY-MM-DD`); the
/// suggestions box shows the pending ones.
#[tauri::command]
pub async fn list_work_journal_candidates(date: String) -> Result<Vec<Candidate>, String> {
    work_journal_activity::list_candidates(&work_journal_activity::activity_dir(), &date)
        .await
        .map_err(|e| e.to_string())
}

/// Rejects a candidate: it leaves the suggestions box but stays in the
/// activity file as rejected, so later runs that day do not propose it again.
#[tauri::command]
pub async fn reject_work_journal_candidate(id: String) -> Result<Candidate, String> {
    work_journal_activity::set_candidate_state(
        &work_journal_activity::activity_dir(),
        &id,
        CandidateState::Rejected,
    )
    .await
    .map_err(|e| e.to_string())
}

/// A removal of a candidate that is already gone (pruned, or removed by an
/// earlier accept whose reply was lost) is done, not an error: `None`.
fn removed_or_gone(result: ActivityResult<Candidate>) -> ActivityResult<Option<Candidate>> {
    match result {
        Ok(candidate) => Ok(Some(candidate)),
        Err(ActivityError::CandidateNotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Accepts a candidate: removes it from the activity file and returns it,
/// or `None` when it was already gone. The frontend has already added its
/// line to the page through the open editor; from then on the page text
/// carries it (and the run reads the page text, so it is not proposed again).
#[tauri::command]
pub async fn accept_work_journal_candidate(id: String) -> Result<Option<Candidate>, String> {
    removed_or_gone(
        work_journal_activity::remove_candidate(&work_journal_activity::activity_dir(), &id).await,
    )
    .map_err(|e| e.to_string())
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
    fn test_granola_status_is_a_connected_flag() {
        assert_eq!(
            serde_json::to_value(GranolaStatus { connected: true }).unwrap(),
            serde_json::json!({"connected": true})
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

    #[test]
    fn test_accepting_a_candidate_that_is_already_gone_is_done() {
        assert_eq!(
            removed_or_gone(Err(ActivityError::CandidateNotFound("x".into()))).unwrap(),
            None
        );
        assert!(matches!(
            removed_or_gone(Err(ActivityError::Write("disk full".into()))),
            Err(ActivityError::Write(_))
        ));
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
