//! Tauri commands for the Work Journal file: load it, and create, update and
//! delete pages and settings, back it up, and restore it from a backup. The
//! file logic lives in [`crate::core::work_journal`]; these wrappers pick the
//! app-data path, serialise every read-modify-write, and run the blocking
//! file work off the async runtime.
//!
//! Every changing command returns the whole saved journal, so the frontend
//! never has to guess side effects (for example `deleted_dates` after a
//! delete), and emits [`CHANGED_EVENT`], so every other window showing the
//! journal (the pane and the pop-out window) re-reads it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, WebviewWindow};

use crate::core::work_journal::{
    self, AutoBackupAfterRestore, CandidateRetry, PageOrigin, WorkJournal, WorkJournalError,
    WorkJournalResult,
};
use crate::core::work_journal_activity::{
    self, ActivityError, ActivityResult, Candidate, CandidateState,
};
use crate::core::work_journal_report::{self, ReportError, ReportResult};
use crate::core::work_journal_run::{self, CandidatesAdded, RunReport};

/// Serialises load-change-save cycles so two commands never interleave and
/// lose a write.
static JOURNAL_LOCK: Mutex<()> = Mutex::new(());

/// Emitted after every command that changed the journal file or the
/// candidates, so the pane and the pop-out window show the same data.
pub const CHANGED_EVENT: &str = "work-journal:changed";

/// Payload of [`CHANGED_EVENT`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JournalChanged {
    /// Label of the window whose command made the change (it already shows
    /// it); `None` when the backend made it on its own (a candidate run).
    pub source: Option<String>,
    /// The whole journal was replaced (restore or undo), not edited.
    pub replaced: bool,
}

/// Tells every window that `window`'s command changed the journal.
fn notify_changed(window: &WebviewWindow, replaced: bool) {
    let payload = JournalChanged {
        source: Some(window.label().to_string()),
        replaced,
    };
    let _ = window.emit(CHANGED_EVENT, payload);
}

/// Emitted before a restore or undo replaces the journal (`active: true`),
/// so every other window sends its unsaved text and stops editing, and after
/// one that failed (`active: false`), so they edit again. A successful one
/// ends with [`CHANGED_EVENT`] (`replaced: true`) instead.
pub const REPLACING_EVENT: &str = "work-journal:replacing";

/// Payload of [`REPLACING_EVENT`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JournalReplacing {
    /// Label of the window that started the restore or undo.
    pub source: Option<String>,
    /// The journal is about to be replaced; false: the replace failed.
    pub active: bool,
}

/// Tells every window that `window`'s restore or undo starts or failed.
fn notify_replacing(window: &WebviewWindow, active: bool) {
    let payload = JournalReplacing {
        source: Some(window.label().to_string()),
        active,
    };
    let _ = window.emit(REPLACING_EVENT, payload);
}

/// How long a restore or undo waits after [`REPLACING_EVENT`] before it
/// starts: the other windows' unsaved text lands meanwhile, so it is in the
/// safety copy. A save arriving later is refused, never written over.
const REPLACE_GRACE: Duration = Duration::from_millis(300);

/// Restores and undos running now; page writes are refused while it is
/// above zero.
static REPLACES_RUNNING: AtomicUsize = AtomicUsize::new(0);

/// Bumped when a restore or undo starts. A write that began before it and
/// only gets [`JOURNAL_LOCK`] after it is refused too, since its text
/// belongs to the replaced journal.
static REPLACE_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Marks a restore or undo as running until dropped.
struct ReplaceGuard;

impl ReplaceGuard {
    fn begin() -> Self {
        REPLACES_RUNNING.fetch_add(1, Ordering::SeqCst);
        REPLACE_GENERATION.fetch_add(1, Ordering::SeqCst);
        ReplaceGuard
    }
}

impl Drop for ReplaceGuard {
    fn drop(&mut self) {
        REPLACES_RUNNING.fetch_sub(1, Ordering::SeqCst);
    }
}

fn replace_generation() -> u64 {
    REPLACE_GENERATION.load(Ordering::SeqCst)
}

/// Refuses a write while a restore or undo runs, or when one started since
/// `since` (the generation when the write began).
fn refuse_while_replacing(since: u64) -> WorkJournalResult<()> {
    if REPLACES_RUNNING.load(Ordering::SeqCst) > 0 || replace_generation() != since {
        return Err(WorkJournalError::RestoreInProgress);
    }
    Ok(())
}

/// Runs a page write `op` on `path` unless a restore or undo refuses it (see
/// [`refuse_while_replacing`]). Call it with [`JOURNAL_LOCK`] held.
fn write_unless_replaced<T>(
    since: u64,
    path: PathBuf,
    op: impl FnOnce(PathBuf) -> WorkJournalResult<T>,
) -> WorkJournalResult<T> {
    refuse_while_replacing(since)?;
    op(path)
}

/// [`with_journal`] for a page write, which a restore or undo refuses. The
/// check runs under the lock, so a write that waited for a restore cannot
/// land on the restored journal.
async fn with_journal_write<T: Send + 'static>(
    op: impl FnOnce(PathBuf) -> WorkJournalResult<T> + Send + 'static,
) -> Result<T, String> {
    let since = replace_generation();
    with_journal(move |path| write_unless_replaced(since, path, op)).await
}

/// Runs a restore or undo `op`: tells every other window first and gives
/// them [`REPLACE_GRACE`] to send their unsaved text, then replaces the
/// journal while page writes are refused. On failure the windows are told
/// to edit again.
async fn replace_journal<T: Send + 'static>(
    window: &WebviewWindow,
    op: impl FnOnce(PathBuf) -> WorkJournalResult<T> + Send + 'static,
) -> Result<T, String> {
    notify_replacing(window, true);
    tokio::time::sleep(REPLACE_GRACE).await;
    let result = {
        let _replacing = ReplaceGuard::begin();
        with_journal(op).await
    };
    if result.is_err() {
        notify_replacing(window, false);
    }
    result
}

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
    window: WebviewWindow,
    date: String,
    title: String,
    body: Value,
    origin: Option<PageOrigin>,
) -> Result<WorkJournal, String> {
    let origin = origin.unwrap_or(PageOrigin::Manual);
    let journal = with_journal_write(move |path| {
        work_journal::modify(&path, |j| {
            work_journal::create_page(j, &date, title, body, origin)
        })
    })
    .await?;
    notify_changed(&window, false);
    Ok(journal)
}

/// Changes the title and/or body of the page for `date`.
#[tauri::command]
pub async fn update_work_journal_page(
    window: WebviewWindow,
    date: String,
    title: Option<String>,
    body: Option<Value>,
) -> Result<WorkJournal, String> {
    let journal = with_journal_write(move |path| {
        work_journal::modify(&path, |j| work_journal::update_page(j, &date, title, body))
    })
    .await?;
    notify_changed(&window, false);
    Ok(journal)
}

/// Deletes the page for `date` and records the date in `deleted_dates` when
/// `delete_page` decides it must. `today` is the frontend's local date; when
/// sent, it counts as already reached by the auto pass.
#[tauri::command]
pub async fn delete_work_journal_page(
    window: WebviewWindow,
    date: String,
    today: Option<String>,
) -> Result<WorkJournal, String> {
    let journal = with_journal_write(move |path| {
        work_journal::modify(&path, |j| {
            work_journal::delete_page(j, &date, today.as_deref())
        })
    })
    .await?;
    notify_changed(&window, false);
    Ok(journal)
}

/// Shallow-merges `settings` into the journal settings: each top-level key
/// sent overwrites or adds that key; keys not sent are kept. The journal's
/// own folder is refused as the backup folder.
#[tauri::command]
pub async fn update_work_journal_settings(
    window: WebviewWindow,
    settings: Map<String, Value>,
) -> Result<WorkJournal, String> {
    let journal = with_journal(move |path| work_journal::update_settings(&path, settings)).await?;
    notify_changed(&window, false);
    Ok(journal)
}

/// "Back up now": writes the journal to `<backup folder>/work-journal.json`
/// and records `last_backup_at`, replacing any file there (the explicit
/// override of the automatic guard). Refused when no folder is set or the
/// folder is missing; the journal is then left untouched.
#[tauri::command]
pub async fn work_journal_backup_now(window: WebviewWindow) -> Result<WorkJournal, String> {
    let journal = with_journal(|path| work_journal::backup_now(&path, chrono::Utc::now())).await?;
    notify_changed(&window, false);
    Ok(journal)
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
pub async fn work_journal_backup_if_due(
    window: WebviewWindow,
) -> Result<BackupIfDueOutcome, String> {
    let outcome = with_journal(|path| {
        backup_if_due_outcome(work_journal::backup_if_due(&path, chrono::Utc::now()))
    })
    .await?;
    if matches!(outcome, BackupIfDueOutcome::Written { .. }) {
        notify_changed(&window, false);
    }
    Ok(outcome)
}

/// Makes sure every day has its page up to `today` (`YYYY-MM-DD`, the
/// caller's local date): gap-fills from the last auto-created date, skips
/// deleted dates and existing pages, and saves only when something changed.
/// Returns the journal. Always notifies: the other windows only re-read it.
#[tauri::command]
pub async fn work_journal_ensure_pages(
    window: WebviewWindow,
    today: String,
) -> Result<WorkJournal, String> {
    let journal =
        with_journal(move |path| work_journal::ensure_pages_in_file(&path, &today)).await?;
    notify_changed(&window, false);
    Ok(journal)
}

/// What a candidate run did, tagged by `status` for the frontend.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CandidateRunOutcome {
    /// The run finished: how many candidates it added, the dates that got
    /// them, the saved `last_run_at` and `last_attempt_at`, and where the
    /// catch-up would have started when the 7-day cap cut it.
    Ran {
        added: usize,
        dates: Vec<String>,
        #[serde(rename = "lastRunAt")]
        last_run_at: String,
        #[serde(rename = "lastAttemptAt")]
        last_attempt_at: String,
        #[serde(rename = "truncatedFrom", skip_serializing_if = "Option::is_none")]
        truncated_from: Option<String>,
    },
    /// Another run is still going; nothing was started.
    Busy,
    /// No project is known (none open, none covered by an earlier run, no
    /// terminal in the window), so nothing was collected and `last_run_at`
    /// was left alone: the time stays covered for the next run that has
    /// projects.
    NoProjects,
    /// One or more dates failed with `message`. Candidates of the dates that
    /// succeeded were kept and `last_run_at` still moved on; a failed date is
    /// tried again by the next runs, up to
    /// [`work_journal_run::MAX_DATE_TRIES`] times in all.
    Failed {
        message: String,
        added: usize,
        dates: Vec<String>,
        #[serde(rename = "lastRunAt")]
        last_run_at: String,
        #[serde(rename = "lastAttemptAt")]
        last_attempt_at: String,
        #[serde(rename = "truncatedFrom", skip_serializing_if = "Option::is_none")]
        truncated_from: Option<String>,
    },
}

/// Maps a finished run, its saved `last_run_at` and the `last_attempt_at`
/// saved when it started to the command's outcome.
fn candidate_run_outcome(
    report: RunReport,
    last_run_at: String,
    last_attempt_at: String,
) -> CandidateRunOutcome {
    let truncated_from = report
        .truncated_from
        .map(|at| at.to_rfc3339_opts(SecondsFormat::Secs, true));
    match report.error {
        None => CandidateRunOutcome::Ran {
            added: report.added,
            dates: report.dates,
            last_run_at,
            last_attempt_at,
            truncated_from,
        },
        Some(message) => CandidateRunOutcome::Failed {
            message,
            added: report.added,
            dates: report.dates,
            last_run_at,
            last_attempt_at,
            truncated_from,
        },
    }
}

/// `NoProjects` when no project path is given (blank paths do not count).
/// A run without projects would mark its whole window as done without ever
/// collecting it.
fn skip_without_projects(projects: &[String]) -> Option<CandidateRunOutcome> {
    projects
        .iter()
        .all(|path| path.trim().is_empty())
        .then_some(CandidateRunOutcome::NoProjects)
}

/// The dedupe key of a project path: no Windows `\\?\` prefix, one kind of
/// separator, no trailing separator. Case is kept, so the result does not
/// depend on the host OS.
fn project_key(path: &str) -> String {
    crate::core::samurai_injector::strip_extended_prefix(path.trim())
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

/// Every project a candidate run covers, in order: the open tabs' repos,
/// the projects of terminals open inside the run's window, then every
/// project an earlier run covered. Deduplicated by [`project_key`] (the
/// first spelling wins, `\\?\` stripped); blank paths are dropped.
fn run_projects(open: &[String], terminals: &[String], known: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    open.iter()
        .chain(terminals)
        .chain(known)
        .map(|path| crate::core::samurai_injector::strip_extended_prefix(path.trim()))
        .filter(|path| !path.is_empty() && seen.insert(project_key(path)))
        .collect()
}

/// Whether a remembered project folder is gone for good: it is missing while
/// its parent folder is there. A folder that cannot be reached right now (an
/// unplugged drive or an offline share, whose parent is missing too, or any
/// other error) is not gone; a run only skips it. Blocking.
fn folder_gone(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            path.parent().is_some_and(|parent| parent.is_dir())
        }
        _ => false,
    }
}

/// A run's projects: the ones it collects from, and the list saved as
/// `known_projects` after it.
#[derive(Debug, PartialEq)]
struct RunProjects {
    /// Every listed project whose folder is reachable now.
    run: Vec<String>,
    /// Every listed project except those gone for good (see [`folder_gone`]).
    save: Vec<String>,
}

/// Plans a run over `open` (the open tabs' repos), `terminals` (the repos of
/// terminals open inside the window) and `known` (the journal's
/// `known_projects`), see [`run_projects`]. Checks folders, so it blocks:
/// run it off the async runtime.
fn plan_run_projects(open: &[String], terminals: &[String], known: &[String]) -> RunProjects {
    let save: Vec<String> = run_projects(open, terminals, known)
        .into_iter()
        .filter(|path| !folder_gone(Path::new(path)))
        .collect();
    let run = save
        .iter()
        .filter(|path| Path::new(path).is_dir())
        .cloned()
        .collect();
    RunProjects { run, save }
}

/// Saves a finished run: the end of its window, the projects to remember
/// and the dates to try again.
fn save_run(
    path: &Path,
    last_run_at: String,
    known_projects: Vec<String>,
    retry_dates: BTreeMap<String, CandidateRetry>,
) -> WorkJournalResult<WorkJournal> {
    work_journal::modify(path, |j| {
        j.settings.last_run_at = Some(last_run_at);
        j.settings.known_projects = known_projects;
        j.settings.retry_dates = retry_dates;
        Ok(())
    })
}

/// Saves when a candidate run started, before it runs, so the time shows
/// even when the run then fails. The caller logs a failure and runs anyway.
fn save_attempt(path: &Path, last_attempt_at: String) -> WorkJournalResult<WorkJournal> {
    work_journal::modify(path, |j| {
        j.settings.last_attempt_at = Some(last_attempt_at);
        Ok(())
    })
}

/// Runs the Work Journal candidate run over every project Maestro knows
/// (see [`plan_run_projects`]; `projects` are the open tabs' repo paths): the
/// activity since `last_run_at` (or one interval back) becomes pending
/// candidates, one headless `claude` call per date that has activity (with
/// Granola on, per date of the window, see [`work_journal_run`]). Saves
/// `last_run_at` and emits [`work_journal_run::CANDIDATES_EVENT`] when
/// candidates were added. Only one run at a time; a second request while one
/// runs gets `Busy`. The covered projects are saved for later runs. With no
/// project at all nothing runs (`NoProjects`).
#[tauri::command]
pub async fn work_journal_run_candidates(
    app: AppHandle,
    projects: Vec<String>,
) -> Result<CandidateRunOutcome, String> {
    let Some(_running) = work_journal_run::try_begin_run() else {
        return Ok(CandidateRunOutcome::Busy);
    };
    let journal = with_journal(|path| work_journal::load(&path)).await?;
    let now = Utc::now();
    let settings = &journal.settings;
    let (start, end) = work_journal_run::run_window(
        settings.last_run_at.as_deref(),
        settings.run_every_hours,
        now,
    );
    let terminals: Vec<String> = match work_journal_activity::list_terminal_records(
        &work_journal_activity::activity_dir(),
        start,
        end,
    )
    .await
    {
        Ok(records) => records.into_iter().filter_map(|r| r.repo_path).collect(),
        Err(e) => {
            log::warn!("Work journal: reading terminal records for the run failed: {e}");
            Vec::new()
        }
    };
    let known = settings.known_projects.clone();
    let plan =
        tokio::task::spawn_blocking(move || plan_run_projects(&projects, &terminals, &known))
            .await
            .map_err(|e| format!("Work journal task failed: {e}"))?;
    if let Some(outcome) = skip_without_projects(&plan.run) {
        return Ok(outcome);
    }
    let last_attempt_at = now.to_rfc3339_opts(SecondsFormat::Secs, true);
    let attempt = last_attempt_at.clone();
    // Only for display: a failed save is logged and the run goes on.
    if let Err(e) = with_journal(move |path| save_attempt(&path, attempt)).await {
        log::warn!("Work journal: saving the run start time failed: {e}");
    }
    let report = work_journal_run::run_candidates(&journal, &plan.run, now).await;
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
    let retry_dates = report.retry_dates.clone();
    with_journal(move |path| save_run(&path, saved, plan.save, retry_dates)).await?;
    // From no window: the new candidates and run time are news to all of them.
    let _ = app.emit(
        CHANGED_EVENT,
        JournalChanged {
            source: None,
            replaced: false,
        },
    );
    Ok(candidate_run_outcome(report, last_run_at, last_attempt_at))
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
/// `None`, after saving the current journal as the safety copy. Keeps all of
/// this machine's settings and clears the last backup time, so automatic
/// backups leave the backup folder alone until "Back up now".
#[tauri::command]
pub async fn restore_work_journal(
    window: WebviewWindow,
    file: Option<String>,
) -> Result<WorkJournalRestoreReply, String> {
    let reply = replace_journal(&window, move |path| {
        let source = match file {
            Some(file) => PathBuf::from(file),
            None => work_journal::default_restore_source(&path)?,
        };
        let journal = work_journal::restore_from(&path, &source)?;
        Ok(restore_reply(&path, journal))
    })
    .await?;
    notify_changed(&window, true);
    Ok(reply)
}

/// "Undo restore": keeps the current journal as the before-undo copy, puts
/// the safety copy back and removes it (undo works once). Refused when there
/// is no safety copy.
#[tauri::command]
pub async fn undo_work_journal_restore(
    window: WebviewWindow,
) -> Result<WorkJournalRestoreReply, String> {
    let reply = replace_journal(&window, |path| {
        let journal = work_journal::undo_restore(&path)?;
        Ok(restore_reply(&path, journal))
    })
    .await?;
    notify_changed(&window, true);
    Ok(reply)
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

/// Pending candidates per date (dates with none left out), for the pop-out
/// window's day list: one read instead of one list per date.
#[tauri::command]
pub async fn work_journal_pending_counts() -> Result<HashMap<String, usize>, String> {
    work_journal_activity::pending_counts(&work_journal_activity::activity_dir())
        .await
        .map_err(|e| e.to_string())
}

/// Rejects a candidate: it leaves the suggestions box but stays in the
/// activity file as rejected, so later runs that day do not propose it again.
#[tauri::command]
pub async fn reject_work_journal_candidate(
    window: WebviewWindow,
    id: String,
) -> Result<Candidate, String> {
    let candidate = work_journal_activity::set_candidate_state(
        &work_journal_activity::activity_dir(),
        &id,
        CandidateState::Rejected,
    )
    .await
    .map_err(|e| e.to_string())?;
    notify_changed(&window, false);
    Ok(candidate)
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
pub async fn accept_work_journal_candidate(
    window: WebviewWindow,
    id: String,
) -> Result<Option<Candidate>, String> {
    let removed = removed_or_gone(
        work_journal_activity::remove_candidate(&work_journal_activity::activity_dir(), &id).await,
    )
    .map_err(|e| e.to_string())?;
    notify_changed(&window, false);
    Ok(removed)
}

/// What `work_journal_generate_report` did, tagged by `status` for the
/// frontend.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ReportOutcome {
    /// The report was written to `path` (replacing the same range's file).
    Saved { path: String },
    /// No page in the range has text worth a report; no file was written.
    NothingToReport,
    /// No report folder is set yet; the dialog asks for one.
    NoFolder,
    /// The saved report folder is gone or is a file; the dialog offers to
    /// choose another. `message` is a plain sentence naming the folder.
    FolderMissing { message: String },
    /// Another report is still being made; nothing was started.
    Busy,
}

/// Maps the core result to the command's outcome.
fn report_outcome(result: ReportResult) -> ReportOutcome {
    match result {
        ReportResult::Saved(path) => ReportOutcome::Saved {
            path: path.display().to_string(),
        },
        ReportResult::NothingToReport => ReportOutcome::NothingToReport,
        ReportResult::NoFolder => ReportOutcome::NoFolder,
    }
}

/// Maps a failed report: a missing (or not-a-folder) report folder becomes
/// the `FolderMissing` outcome so the dialog can offer the picker; any
/// other failure stays a plain error message.
fn report_error_outcome(error: ReportError) -> Result<ReportOutcome, String> {
    match error {
        ReportError::FolderMissing(_) | ReportError::FolderNotAFolder(_) => {
            Ok(ReportOutcome::FolderMissing {
                message: error.to_string(),
            })
        }
        other => Err(other.to_string()),
    }
}

/// Writes the supervisor report for `from..=to` (`YYYY-MM-DD`, inclusive)
/// to `<report folder>/work-report_<from>_to_<to>.html` (see
/// [`work_journal_report`]). One report at a time (its own lock, not the
/// candidate run's); a second request while one runs gets `Busy`. A missing
/// report folder is never created; it comes back as `FolderMissing`.
#[tauri::command]
pub async fn work_journal_generate_report(
    from: String,
    to: String,
) -> Result<ReportOutcome, String> {
    let Some(_running) = work_journal_report::try_begin_report() else {
        return Ok(ReportOutcome::Busy);
    };
    let journal = with_journal(|path| work_journal::load(&path)).await?;
    let generated_on = chrono::Local::now()
        .format("%-d %b %Y at %H:%M")
        .to_string();
    work_journal_report::generate_report(&journal, &from, &to, &generated_on)
        .await
        .map(report_outcome)
        .or_else(report_error_outcome)
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

        let own_folder = backup_if_due_outcome(Err(WorkJournalError::BackupFolderIsJournalFolder));
        assert!(matches!(
            own_folder,
            Err(WorkJournalError::BackupFolderIsJournalFolder)
        ));
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
            retry_dates: BTreeMap::new(),
            error: error.map(str::to_string),
            truncated_from: None,
        };
        let tried = "2026-10-15T11:59:00Z".to_string();

        let ran = candidate_run_outcome(report(None), at.clone(), tried.clone());
        assert_eq!(
            serde_json::to_value(&ran).unwrap(),
            serde_json::json!({
                "status": "ran", "added": 2, "dates": ["2026-10-15"], "lastRunAt": at,
                "lastAttemptAt": tried
            })
        );

        let failed =
            candidate_run_outcome(report(Some("claude timed out")), at.clone(), tried.clone());
        let value = serde_json::to_value(&failed).unwrap();
        assert_eq!(value["status"], "failed");
        assert_eq!(value["message"], "claude timed out");
        assert_eq!(value["added"], 2);
        assert_eq!(value["lastRunAt"], at.as_str());
        assert_eq!(value["lastAttemptAt"], tried.as_str());
        assert!(value.get("truncatedFrom").is_none());

        let mut capped = report(None);
        capped.truncated_from = Some(
            chrono::DateTime::parse_from_rfc3339("2026-10-05T12:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
        );
        let value = serde_json::to_value(candidate_run_outcome(capped, at.clone(), tried)).unwrap();
        assert_eq!(value["truncatedFrom"], "2026-10-05T12:00:00Z");

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
    fn test_run_projects_keep_closed_tabs_and_terminal_projects() {
        let open = vec![r"C:\git\a".to_string()];
        let terminals = vec![r"\\?\C:\git\b".to_string(), r"C:\git\a\".to_string()];
        let known = vec![
            "C:/git/a".to_string(),
            r"C:\git\closed".to_string(),
            " ".to_string(),
        ];
        assert_eq!(
            run_projects(&open, &terminals, &known),
            vec![
                r"C:\git\a".to_string(),
                r"C:\git\b".to_string(),
                r"C:\git\closed".to_string(),
            ]
        );
    }

    #[test]
    fn test_run_projects_with_no_open_tab_still_cover_known_projects() {
        let projects = run_projects(&[], &[], &["/home/me/repo".to_string()]);
        assert_eq!(projects, vec!["/home/me/repo".to_string()]);
        assert_eq!(skip_without_projects(&projects), None);
        assert_eq!(
            skip_without_projects(&run_projects(&[], &[], &[])),
            Some(CandidateRunOutcome::NoProjects)
        );
    }

    /// `dir/name` as a string, created as a folder.
    fn folder(dir: &Path, name: &str) -> String {
        let path = dir.join(name);
        std::fs::create_dir_all(&path).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn test_a_saved_run_is_read_back_by_the_next_run_without_open_tabs() {
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join("app").join("work-journal.json");
        let repo = folder(dir.path(), "closed-tab");

        let first = plan_run_projects(std::slice::from_ref(&repo), &[], &[]);
        assert_eq!(first.run, vec![repo.clone()]);
        save_run(
            &journal,
            "2026-10-15T10:00:00Z".into(),
            first.save,
            BTreeMap::new(),
        )
        .unwrap();

        let loaded = work_journal::load(&journal).unwrap();
        assert_eq!(
            loaded.settings.last_run_at.as_deref(),
            Some("2026-10-15T10:00:00Z")
        );
        let next = plan_run_projects(&[], &[], &loaded.settings.known_projects);
        assert_eq!(
            next.run,
            vec![repo.clone()],
            "the closed tab is still covered"
        );
        assert_eq!(next.save, vec![repo]);
    }

    #[test]
    fn test_the_attempt_time_is_saved_first_and_kept_when_the_run_fails() {
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join("app").join("work-journal.json");

        save_attempt(&journal, "2026-10-15T12:00:00Z".into()).unwrap();
        let started = work_journal::load(&journal).unwrap();
        assert_eq!(
            started.settings.last_attempt_at.as_deref(),
            Some("2026-10-15T12:00:00Z")
        );
        assert_eq!(
            started.settings.last_run_at, None,
            "the schedule time is untouched"
        );

        // A failed run is still saved, with the window start it got to.
        let mut retry_dates = BTreeMap::new();
        retry_dates.insert(
            "2026-10-15".to_string(),
            CandidateRetry {
                since: "2026-10-14T22:00:00Z".into(),
                failures: 1,
            },
        );
        save_run(
            &journal,
            "2026-10-15T00:00:00Z".into(),
            Vec::new(),
            retry_dates,
        )
        .unwrap();
        let after = work_journal::load(&journal).unwrap();
        assert_eq!(
            after.settings.last_attempt_at.as_deref(),
            Some("2026-10-15T12:00:00Z"),
            "the attempt time stays the real start time"
        );
        assert_eq!(
            after.settings.last_run_at.as_deref(),
            Some("2026-10-15T00:00:00Z")
        );
    }

    #[test]
    fn test_a_failed_attempt_save_is_an_error_the_caller_can_log() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("not-a-folder");
        std::fs::write(&blocker, "x").unwrap();
        let journal = blocker.join("work-journal.json");

        assert!(save_attempt(&journal, "2026-10-15T12:00:00Z".into()).is_err());
        assert!(!journal.exists());
    }

    #[test]
    fn test_an_unreachable_folder_is_skipped_but_kept_and_a_gone_one_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let here = folder(dir.path(), "here");
        let unreachable = dir
            .path()
            .join("unplugged-drive")
            .join("repo")
            .to_string_lossy()
            .into_owned();
        let gone = dir.path().join("deleted").to_string_lossy().into_owned();

        let plan = plan_run_projects(
            std::slice::from_ref(&here),
            &[],
            &[unreachable.clone(), gone],
        );

        assert_eq!(plan.run, vec![here.clone()]);
        assert_eq!(plan.save, vec![here, unreachable]);
    }

    #[test]
    fn test_an_old_journal_without_known_projects_still_parses() {
        let text = serde_json::json!({
            "layout_version": 1,
            "settings": {"last_run_at": "2026-10-15T10:00:00Z", "run_every_hours": 2}
        })
        .to_string();
        let journal = work_journal::parse_journal(&text).unwrap();
        assert!(journal.settings.known_projects.is_empty());
        assert_eq!(journal.settings.run_every_hours, Some(2));
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

    #[test]
    fn test_changed_event_names_the_source_window() {
        assert_eq!(CHANGED_EVENT, "work-journal:changed");
        let changed = JournalChanged {
            source: Some("work-journal".to_string()),
            replaced: true,
        };
        assert_eq!(
            serde_json::to_value(&changed).unwrap(),
            serde_json::json!({"source": "work-journal", "replaced": true})
        );
        let from_backend = JournalChanged {
            source: None,
            replaced: false,
        };
        assert_eq!(
            serde_json::to_value(&from_backend).unwrap(),
            serde_json::json!({"source": null, "replaced": false})
        );
    }

    #[test]
    fn test_update_page_is_refused_while_the_replacing_flag_is_set() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("work-journal.json");
        let date = "2026-10-15";
        work_journal::modify(&path, |j| {
            let body = serde_json::json!({"type": "doc"});
            work_journal::create_page(j, date, "Restored".into(), body, PageOrigin::Manual)
        })
        .unwrap();
        let update = |since: u64| {
            write_unless_replaced(since, path.clone(), |path| {
                work_journal::modify(&path, |j| {
                    work_journal::update_page(j, date, Some("Old text".into()), None)
                })
            })
        };
        let title = || work_journal::load(&path).unwrap().pages[date].title.clone();

        let before = replace_generation();
        let replacing = ReplaceGuard::begin();
        assert!(matches!(
            update(replace_generation()),
            Err(WorkJournalError::RestoreInProgress)
        ));
        drop(replacing);
        // A write that began before the restore stays refused after it.
        assert!(matches!(
            update(before),
            Err(WorkJournalError::RestoreInProgress)
        ));
        assert_eq!(title(), "Restored");

        update(replace_generation()).unwrap();
        assert_eq!(title(), "Old text");
        // The frontend matches this code (`WORK_JOURNAL_RESTORE_IN_PROGRESS_CODE`).
        assert!(WorkJournalError::RestoreInProgress
            .to_string()
            .starts_with("RESTORE_IN_PROGRESS: "));
    }

    #[test]
    fn test_replacing_event_names_the_source_window() {
        assert_eq!(REPLACING_EVENT, "work-journal:replacing");
        let replacing = JournalReplacing {
            source: Some("main".to_string()),
            active: true,
        };
        assert_eq!(
            serde_json::to_value(&replacing).unwrap(),
            serde_json::json!({"source": "main", "active": true})
        );
    }

    #[test]
    fn test_report_outcome_tags_each_case() {
        let saved = report_outcome(ReportResult::Saved(PathBuf::from("reports/a.html")));
        assert_eq!(
            serde_json::to_value(&saved).unwrap(),
            serde_json::json!({"status": "saved", "path": "reports/a.html"})
        );
        assert_eq!(
            serde_json::to_value(report_outcome(ReportResult::NothingToReport)).unwrap(),
            serde_json::json!({"status": "nothing_to_report"})
        );
        assert_eq!(
            serde_json::to_value(report_outcome(ReportResult::NoFolder)).unwrap(),
            serde_json::json!({"status": "no_folder"})
        );
        assert_eq!(
            serde_json::to_value(ReportOutcome::Busy).unwrap(),
            serde_json::json!({"status": "busy"})
        );
    }

    #[test]
    fn test_report_error_outcome_tags_a_missing_folder_and_keeps_other_errors() {
        for error in [
            ReportError::FolderMissing("C:/gone".into()),
            ReportError::FolderNotAFolder("C:/a-file".into()),
        ] {
            let text = error.to_string();
            let value = serde_json::to_value(report_error_outcome(error).unwrap()).unwrap();
            assert_eq!(
                value,
                serde_json::json!({"status": "folder_missing", "message": text})
            );
        }
        assert_eq!(
            report_error_outcome(ReportError::UnusableReply).unwrap_err(),
            ReportError::UnusableReply.to_string()
        );
    }
}
