//! The Work Journal's temporary activity file: `<app data>/work-journal/activity.json`.
//!
//! It holds two kinds of short-lived entries (PRD "Candidates" → "Temporary
//! file", and "Data model"):
//!
//! - **Candidates** a candidate run proposed for a day page, while they are
//!   still pending or after the user rejected them (kept for same-day
//!   duplicate removal).
//! - **Terminal records**: one per terminal — project name, branch, opened-at
//!   and closed-at. Nothing typed in a terminal is ever stored.
//!
//! Every entry is deleted 24 hours after it stops being current, on every
//! load and every write. A terminal that is still open in this app launch is
//! never pruned. This file is NOT `work-journal.json` and is never backed up.
//!
//! Every function takes the base directory so tests can point it at a temp
//! dir; the app passes [`activity_dir`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use chrono::{DateTime, Duration, Local, NaiveDate, NaiveTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::commands::ai_runner::artifact_base_dir;
use crate::core::samurai_injector::strip_extended_prefix;
use crate::core::session_manager::SessionConfig;
use crate::git::Git;

/// File name inside the work-journal app-data folder.
const ACTIVITY_FILE: &str = "activity.json";

/// Where an unparseable `activity.json` is moved before starting afresh.
const DAMAGED_FILE: &str = "activity.json.damaged";

/// How long an entry is kept after it stops being current.
const RETENTION_HOURS: i64 = 24;

/// Project name used when a path has no usable last component.
const UNKNOWN_PROJECT: &str = "unknown";

/// Serialises every read-modify-write of the file inside this process, so two
/// terminals opening at once cannot drop each other's record.
static FILE_LOCK: Mutex<()> = Mutex::const_new(());

/// Errors from reading, changing or saving the activity file.
#[derive(Debug, thiserror::Error)]
pub enum ActivityError {
    #[error("Failed to read {path:?}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Failed to create the work journal folder {path:?}: {source}")]
    CreateDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Failed to serialize the activity file: {0}")]
    Serialize(#[source] serde_json::Error),
    /// Message from the shared `atomic_write` helper, which reports `String`.
    #[error("{0}")]
    Write(String),
    #[error("Candidate date '{0}' is not YYYY-MM-DD")]
    InvalidDate(String),
    #[error("Candidate time '{0}' is not HH:MM")]
    InvalidTime(String),
    #[error("Candidate text is empty")]
    EmptyText,
    #[error("No work journal candidate with id {0}")]
    CandidateNotFound(String),
}

/// Result type for activity-file operations.
pub type ActivityResult<T> = Result<T, ActivityError>;

/// Where a candidate's activity came from (one source tag each).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CandidateSource {
    Github,
    Git,
    Claude,
    Terminal,
    Granola,
}

/// A candidate still waiting for the user, or one the user rejected.
/// Accepted candidates become page text in `work-journal.json` instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CandidateState {
    Pending,
    Rejected,
}

/// One proposed journal line for a date.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// Unique id (UUID v4), made when the candidate is added.
    pub id: String,
    /// The day page it belongs to, ISO `YYYY-MM-DD`.
    pub date: String,
    /// When the activity happened, `HH:MM` (none for an untimed meeting).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    /// One line of text.
    pub text: String,
    /// Which activity source proposed it (its source tag).
    pub source: CandidateSource,
    /// Pending (waiting for the user) or rejected.
    pub state: CandidateState,
    /// When the candidate was added (RFC 3339) — the pruning clock.
    pub created_at: String,
}

/// The caller-supplied part of a new candidate; it always starts pending.
// First used by the candidate run (issue #313 scheduled candidate run).
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCandidate {
    pub date: String,
    #[serde(default)]
    pub time: Option<String>,
    pub text: String,
    pub source: CandidateSource,
}

/// One terminal: where it ran and when. Never what was typed in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRecord {
    /// Unique id (UUID v4), made when the record is created.
    pub id: String,
    /// The app launch that opened it. Session ids restart every launch, so
    /// (`launch_id`, `session_id`) is the record's identity.
    pub launch_id: String,
    pub session_id: u32,
    /// Last component of the session's project path, `\\?\` stripped. Set
    /// once at open and never changed.
    pub project_name: String,
    /// The session's branch, or the checked-out git branch when the session
    /// has none; absent outside git.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// RFC 3339, local offset.
    pub opened_at: String,
    /// RFC 3339, local offset. Absent while open. For a terminal whose app
    /// launch ended without closing it, filled with an estimate by the next
    /// launch (see [`close_stale`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
}

/// The whole `activity.json` document.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityFile {
    #[serde(default)]
    pub candidates: Vec<Candidate>,
    #[serde(default)]
    pub terminals: Vec<TerminalRecord>,
}

/// The app-data folder that holds `activity.json`.
pub fn activity_dir() -> PathBuf {
    artifact_base_dir("work-journal")
}

/// This app launch's id, made once per process.
pub fn current_launch_id() -> &'static str {
    static LAUNCH_ID: OnceLock<String> = OnceLock::new();
    LAUNCH_ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

/// Project name for a path: its last component, with any Windows `\\?\`
/// prefix stripped. Splits on both separators so the result does not depend
/// on the host OS.
pub fn project_name_from_path(path: &str) -> String {
    let stripped = strip_extended_prefix(path);
    stripped
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(UNKNOWN_PROJECT)
        .to_string()
}

fn stamp(at: DateTime<Local>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, false)
}

fn parse_stamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// Whether `stamp` is more than [`RETENTION_HOURS`] before `now`. An
/// unreadable stamp counts as expired, so a damaged entry cannot linger.
fn expired(stamp: &str, now: DateTime<Utc>) -> bool {
    match parse_stamp(stamp) {
        Some(t) => now - t > Duration::hours(RETENTION_HOURS),
        None => true,
    }
}

/// Drops every expired entry. A terminal ages from its close; one with no
/// close is kept if it belongs to `launch` (still open), and otherwise ages
/// from its open (only reachable when [`close_stale`] could not read it).
/// Returns whether anything was removed.
fn prune(file: &mut ActivityFile, now: DateTime<Utc>, launch: &str) -> bool {
    let before = file.candidates.len() + file.terminals.len();
    file.candidates.retain(|c| !expired(&c.created_at, now));
    file.terminals.retain(|t| match t.closed_at.as_deref() {
        Some(closed) => !expired(closed, now),
        None if t.launch_id == launch => true,
        None => !expired(&t.opened_at, now),
    });
    before != file.candidates.len() + file.terminals.len()
}

/// Closes every record left open by another app launch (a crash, a
/// force-kill, or a quit that skipped the close handler such as macOS
/// Cmd+Q). The real close time is unknown, so it is estimated:
///
/// - `bound` is the file's last-modified time as this launch first saw it,
///   before this launch wrote anything. The earlier launch cannot have run
///   a terminal much past its last write to this file, so it is a bounded,
///   plausible end time — not an exact one.
/// - It is floored at the record's own open time, so a close never precedes
///   its open. With no `bound` (no file yet) the close equals the open.
///
/// Without this, such a record would be listed as still running in every
/// later time window. Returns whether anything was closed.
fn close_stale(file: &mut ActivityFile, launch: &str, bound: Option<DateTime<Utc>>) -> bool {
    let mut changed = false;
    for record in file
        .terminals
        .iter_mut()
        .filter(|t| t.launch_id != launch && t.closed_at.is_none())
    {
        let Some(opened) = parse_stamp(&record.opened_at) else {
            continue; // unreadable: prune removes it
        };
        let end = bound.map_or(opened, |b| b.max(opened));
        record.closed_at = Some(stamp(end.with_timezone(&Local)));
        changed = true;
    }
    changed
}

/// The file's modification time as this process first saw it, i.e. before
/// this launch wrote to it. Remembered per path for the process lifetime.
fn pre_launch_mtime(path: &Path) -> Option<DateTime<Utc>> {
    type Seen = std::sync::Mutex<HashMap<PathBuf, Option<DateTime<Utc>>>>;
    static SEEN: OnceLock<Seen> = OnceLock::new();
    let mut seen = SEEN
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *seen.entry(path.to_path_buf()).or_insert_with(|| {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .map(DateTime::<Utc>::from)
    })
}

fn file_path(dir: &Path) -> PathBuf {
    dir.join(ACTIVITY_FILE)
}

/// Moves an unparseable file aside to [`DAMAGED_FILE`] (replacing an older
/// damaged copy) so it can be inspected, and logs it.
async fn set_aside_damaged(dir: &Path, error: &serde_json::Error) {
    let path = file_path(dir);
    let damaged = dir.join(DAMAGED_FILE);
    match tokio::fs::rename(&path, &damaged).await {
        Ok(()) => log::warn!(
            "work journal: {path:?} is unreadable ({error}); moved it to {damaged:?} and started afresh"
        ),
        Err(e) => log::warn!(
            "work journal: {path:?} is unreadable ({error}) and could not be moved to {damaged:?} ({e}); starting afresh"
        ),
    }
}

/// Reads the file, closes stale records and prunes. A missing file is
/// empty; an unparseable one is set aside and treated as empty. When
/// anything changed, writes it back; a failed write-back is logged and the
/// cleaned data is still returned. Callers hold [`FILE_LOCK`].
async fn load(dir: &Path, now: DateTime<Utc>, launch: &str) -> ActivityResult<ActivityFile> {
    let path = file_path(dir);
    let bound = pre_launch_mtime(&path);
    let mut file = match tokio::fs::read_to_string(&path).await {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(file) => file,
            Err(e) => {
                set_aside_damaged(dir, &e).await;
                ActivityFile::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ActivityFile::default(),
        Err(source) => return Err(ActivityError::Read { path, source }),
    };
    let closed = close_stale(&mut file, launch, bound);
    let pruned = prune(&mut file, now, launch);
    if closed || pruned {
        if let Err(e) = save(dir, &mut file, now, launch).await {
            log::warn!("work journal: could not write back the cleaned activity file: {e}");
        }
    }
    Ok(file)
}

/// Prunes, then writes the file with the shared temp-then-rename helper.
/// Callers hold [`FILE_LOCK`].
async fn save(
    dir: &Path,
    file: &mut ActivityFile,
    now: DateTime<Utc>,
    launch: &str,
) -> ActivityResult<()> {
    prune(file, now, launch);
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|source| ActivityError::CreateDir {
            path: dir.to_path_buf(),
            source,
        })?;
    let path = file_path(dir);
    let tmp = dir.join(format!("{ACTIVITY_FILE}.tmp.{}", std::process::id()));
    let json = serde_json::to_vec_pretty(file).map_err(ActivityError::Serialize)?;
    let result = crate::core::atomic_write::atomic_write_async(path, tmp.clone(), json).await;
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(ActivityError::Write)
}

/// Checks one new candidate and returns it normalised: `date` as
/// `YYYY-MM-DD` and `time` as `HH:MM` (zero-padded, so `2026-1-5` and `9:5`
/// become `2026-01-05` and `09:05`), text folded to one non-empty line. Use
/// it to drop bad lines before [`add_candidates`], which rejects a whole
/// batch if any one is invalid.
#[allow(dead_code)] // first used by issue #313 (scheduled candidate run)
pub fn validate_candidate(candidate: &NewCandidate) -> ActivityResult<NewCandidate> {
    let date = NaiveDate::parse_from_str(&candidate.date, "%Y-%m-%d")
        .map_err(|_| ActivityError::InvalidDate(candidate.date.clone()))?;
    let time = match &candidate.time {
        Some(time) => Some(
            NaiveTime::parse_from_str(time, "%H:%M")
                .map_err(|_| ActivityError::InvalidTime(time.clone()))?
                .format("%H:%M")
                .to_string(),
        ),
        None => None,
    };
    let text = candidate
        .text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        return Err(ActivityError::EmptyText);
    }
    Ok(NewCandidate {
        date: date.format("%Y-%m-%d").to_string(),
        time,
        text,
        source: candidate.source,
    })
}

/// Adds candidates (all pending) and returns them with their new ids.
/// Nothing is written if any candidate is invalid.
#[allow(dead_code)] // first used by issue #313 (scheduled candidate run)
pub async fn add_candidates(dir: &Path, new: Vec<NewCandidate>) -> ActivityResult<Vec<Candidate>> {
    let now = Local::now();
    let mut added = Vec::with_capacity(new.len());
    for candidate in &new {
        let valid = validate_candidate(candidate)?;
        added.push(Candidate {
            id: uuid::Uuid::new_v4().to_string(),
            date: valid.date,
            time: valid.time,
            text: valid.text,
            source: valid.source,
            state: CandidateState::Pending,
            created_at: stamp(now),
        });
    }
    let launch = current_launch_id();
    let now = now.with_timezone(&Utc);
    let _guard = FILE_LOCK.lock().await;
    let mut file = load(dir, now, launch).await?;
    file.candidates.extend(added.iter().cloned());
    save(dir, &mut file, now, launch).await?;
    Ok(added)
}

/// Sets one candidate's state; errors if no candidate has that id.
#[allow(dead_code)] // first used by issue #314 (accept / reject)
pub async fn set_candidate_state(
    dir: &Path,
    id: &str,
    state: CandidateState,
) -> ActivityResult<Candidate> {
    let now = Utc::now();
    let launch = current_launch_id();
    let _guard = FILE_LOCK.lock().await;
    let mut file = load(dir, now, launch).await?;
    let candidate = file
        .candidates
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| ActivityError::CandidateNotFound(id.to_string()))?;
    candidate.state = state;
    let updated = candidate.clone();
    save(dir, &mut file, now, launch).await?;
    Ok(updated)
}

/// Every candidate (pending and rejected) for one `YYYY-MM-DD` date.
#[allow(dead_code)] // first used by issues #313 and #314
pub async fn list_candidates(dir: &Path, date: &str) -> ActivityResult<Vec<Candidate>> {
    let _guard = FILE_LOCK.lock().await;
    let file = load(dir, Utc::now(), current_launch_id()).await?;
    Ok(file
        .candidates
        .into_iter()
        .filter(|c| c.date == date)
        .collect())
}

/// Whether a record was running at some moment in the half-open window
/// `[start, end)`: the record covers `[opened, closed)`, or is still running
/// with no close. A record that opens and closes in the same second is a
/// point at its open time. A terminal closed exactly on a window boundary is
/// therefore listed in one window only.
fn in_window(record: &TerminalRecord, start: DateTime<Utc>, end: DateTime<Utc>) -> bool {
    let Some(opened) = parse_stamp(&record.opened_at) else {
        return false;
    };
    match record.closed_at.as_deref() {
        None => opened < end,
        Some(closed) => match parse_stamp(closed) {
            Some(closed) if closed > opened => opened < end && closed > start,
            Some(_) => start <= opened && opened < end,
            None => false,
        },
    }
}

/// Terminal records that were running at any moment in `[start, end)`.
#[allow(dead_code)] // first used by issue #308 (activity time window)
pub async fn list_terminal_records(
    dir: &Path,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> ActivityResult<Vec<TerminalRecord>> {
    let _guard = FILE_LOCK.lock().await;
    let file = load(dir, Utc::now(), current_launch_id()).await?;
    Ok(file
        .terminals
        .into_iter()
        .filter(|t| in_window(t, start, end))
        .collect())
}

/// Records a terminal opening. A record that already exists for this
/// session is left untouched, so a closed record is never reopened.
async fn record_opened(
    dir: &Path,
    launch: &str,
    session_id: u32,
    project_name: String,
    branch: Option<String>,
    opened_at: DateTime<Local>,
) -> ActivityResult<()> {
    let now = Utc::now();
    let _guard = FILE_LOCK.lock().await;
    let mut file = load(dir, now, launch).await?;
    if file
        .terminals
        .iter()
        .any(|t| t.launch_id == launch && t.session_id == session_id)
    {
        return Ok(());
    }
    file.terminals.push(TerminalRecord {
        id: uuid::Uuid::new_v4().to_string(),
        launch_id: launch.to_string(),
        session_id,
        project_name,
        branch,
        opened_at: stamp(opened_at),
        closed_at: None,
    });
    save(dir, &mut file, now, launch).await
}

/// Fills in a record's branch from git once it answers, if it still has
/// none. Never touches the close time.
async fn record_branch(
    dir: &Path,
    launch: &str,
    session_id: u32,
    branch: String,
) -> ActivityResult<()> {
    let now = Utc::now();
    let _guard = FILE_LOCK.lock().await;
    let mut file = load(dir, now, launch).await?;
    let Some(record) = file
        .terminals
        .iter_mut()
        .find(|t| t.launch_id == launch && t.session_id == session_id && t.branch.is_none())
    else {
        return Ok(());
    };
    record.branch = Some(branch);
    save(dir, &mut file, now, launch).await
}

/// Records a terminal closing; `branch` comes from the session registry
/// when it still knows one. Does nothing when no open record exists.
async fn record_closed(
    dir: &Path,
    launch: &str,
    session_id: u32,
    branch: Option<String>,
    closed_at: DateTime<Local>,
) -> ActivityResult<()> {
    let now = Utc::now();
    let _guard = FILE_LOCK.lock().await;
    let mut file = load(dir, now, launch).await?;
    let Some(record) = file
        .terminals
        .iter_mut()
        .find(|t| t.launch_id == launch && t.session_id == session_id && t.closed_at.is_none())
    else {
        log::debug!("work journal: no open record for terminal {session_id}; nothing to close");
        return Ok(());
    };
    record.closed_at = Some(stamp(closed_at));
    if branch.is_some() {
        record.branch = branch;
    }
    save(dir, &mut file, now, launch).await
}

/// Closes every terminal still open in `launch` (all PTYs were killed).
/// Writes nothing when none is open.
async fn record_all_closed(
    dir: &Path,
    launch: &str,
    closed_at: DateTime<Local>,
) -> ActivityResult<()> {
    let now = Utc::now();
    let _guard = FILE_LOCK.lock().await;
    let mut file = load(dir, now, launch).await?;
    let mut changed = false;
    for record in file
        .terminals
        .iter_mut()
        .filter(|t| t.launch_id == launch && t.closed_at.is_none())
    {
        record.closed_at = Some(stamp(closed_at));
        changed = true;
    }
    if changed {
        save(dir, &mut file, now, launch).await?;
    }
    Ok(())
}

/// The checked-out git branch in `dir`, or `None` outside git.
async fn resolve_branch(dir: &str) -> Option<String> {
    Git::new(dir)
        .current_branch()
        .await
        .ok()
        .filter(|b| !b.is_empty())
}

/// Notes a newly registered terminal. The open record is written first
/// (name from the session's project path, branch from the session if set),
/// so a close that follows always finds it; when the session has no branch,
/// git is asked in the background and the record updated when it answers.
/// Errors are only logged: a launch never fails because of the journal.
pub async fn note_terminal_opened(config: &SessionConfig) {
    let session_id = config.id;
    let opened = record_opened(
        &activity_dir(),
        current_launch_id(),
        session_id,
        project_name_from_path(&config.project_path),
        config.branch.clone(),
        Local::now(),
    )
    .await;
    if let Err(e) = opened {
        log::warn!("work journal: could not record terminal {session_id} opening: {e}");
        return;
    }
    if config.branch.is_some() {
        return;
    }
    let cwd = config
        .working_directory
        .clone()
        .unwrap_or_else(|| config.project_path.clone());
    tauri::async_runtime::spawn(async move {
        let Some(branch) = resolve_branch(&cwd).await else {
            return;
        };
        if let Err(e) =
            record_branch(&activity_dir(), current_launch_id(), session_id, branch).await
        {
            log::warn!("work journal: could not record terminal {session_id} branch: {e}");
        }
    });
}

/// Notes a killed terminal in the background; errors are only logged.
pub fn note_terminal_closed(session_id: u32, branch: Option<String>) {
    let closed_at = Local::now();
    tauri::async_runtime::spawn(async move {
        let launch = current_launch_id();
        if let Err(e) = record_closed(&activity_dir(), launch, session_id, branch, closed_at).await
        {
            log::warn!("work journal: could not record terminal {session_id} closing: {e}");
        }
    });
}

/// Closes every open terminal record of this launch and waits for the write
/// (used on quit, where a background task would die with the app). Errors
/// are only logged.
pub async fn close_all_terminals() {
    if let Err(e) = record_all_closed(&activity_dir(), current_launch_id(), Local::now()).await {
        log::warn!("work journal: could not record terminals closing: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const LAUNCH: &str = "launch-a";

    fn new_candidate(date: &str, time: Option<&str>, text: &str) -> NewCandidate {
        NewCandidate {
            date: date.to_string(),
            time: time.map(str::to_string),
            text: text.to_string(),
            source: CandidateSource::Git,
        }
    }

    fn write_raw(dir: &Path, file: &ActivityFile) {
        std::fs::write(file_path(dir), serde_json::to_string(file).unwrap()).unwrap();
    }

    fn read_raw(dir: &Path) -> ActivityFile {
        serde_json::from_str(&std::fs::read_to_string(file_path(dir)).unwrap()).unwrap()
    }

    fn set_mtime(dir: &Path, at: DateTime<Local>) {
        let file = std::fs::File::options()
            .write(true)
            .open(file_path(dir))
            .unwrap();
        file.set_modified(at.into()).unwrap();
    }

    fn terminal(
        launch: &str,
        session_id: u32,
        opened: &str,
        closed: Option<&str>,
    ) -> TerminalRecord {
        TerminalRecord {
            id: format!("t-{launch}-{session_id}"),
            launch_id: launch.to_string(),
            session_id,
            project_name: "proj".to_string(),
            branch: Some("main".to_string()),
            opened_at: opened.to_string(),
            closed_at: closed.map(str::to_string),
        }
    }

    fn hours_ago(hours: i64) -> String {
        stamp(Local::now() - Duration::hours(hours))
    }

    fn candidate_created(id: &str, created_at: &str) -> Candidate {
        Candidate {
            id: id.into(),
            date: "2026-10-14".into(),
            time: Some("09:00".into()),
            text: "t".into(),
            source: CandidateSource::Git,
            state: CandidateState::Pending,
            created_at: created_at.into(),
        }
    }

    #[test]
    fn test_project_name_strips_extended_prefix_and_trailing_separator() {
        assert_eq!(project_name_from_path(r"\\?\C:\git\maestro"), "maestro");
        assert_eq!(project_name_from_path(r"C:\git\maestro\"), "maestro");
        assert_eq!(project_name_from_path("/home/me/maestro/"), "maestro");
        assert_eq!(project_name_from_path(r"\\?\UNC\server\share\repo"), "repo");
        assert_eq!(project_name_from_path(""), UNKNOWN_PROJECT);
    }

    #[tokio::test]
    async fn test_terminal_spawned_then_killed_leaves_one_full_record() {
        let dir = tempdir().unwrap();
        let opened = Local::now() - Duration::minutes(10);
        let name = project_name_from_path(r"\\?\C:\git\maestro");
        record_opened(dir.path(), LAUNCH, 7, name, Some("feat/x".into()), opened)
            .await
            .unwrap();
        record_closed(dir.path(), LAUNCH, 7, None, Local::now())
            .await
            .unwrap();

        let file = read_raw(dir.path());
        assert_eq!(file.terminals.len(), 1);
        let record = &file.terminals[0];
        assert_eq!(record.project_name, "maestro");
        assert_eq!(record.branch.as_deref(), Some("feat/x"));
        assert_eq!(record.opened_at, stamp(opened));
        assert!(record.closed_at.is_some());
    }

    #[tokio::test]
    async fn test_close_uses_registry_branch_and_keeps_the_name() {
        let dir = tempdir().unwrap();
        record_opened(
            dir.path(),
            LAUNCH,
            1,
            "p".into(),
            Some("main".into()),
            Local::now(),
        )
        .await
        .unwrap();
        record_closed(dir.path(), LAUNCH, 1, Some("feat/y".into()), Local::now())
            .await
            .unwrap();
        let record = &read_raw(dir.path()).terminals[0];
        assert_eq!(record.branch.as_deref(), Some("feat/y"));
        assert_eq!(record.project_name, "p", "the name never changes at close");
    }

    #[tokio::test]
    async fn test_close_before_git_answers_still_ends_closed() {
        let dir = tempdir().unwrap();
        record_opened(dir.path(), LAUNCH, 3, "proj".into(), None, Local::now())
            .await
            .unwrap();
        record_all_closed(dir.path(), LAUNCH, Local::now())
            .await
            .unwrap();
        // git answers late; the late open must not reopen the record.
        record_branch(dir.path(), LAUNCH, 3, "main".into())
            .await
            .unwrap();
        record_opened(dir.path(), LAUNCH, 3, "proj".into(), None, Local::now())
            .await
            .unwrap();
        let file = read_raw(dir.path());
        assert_eq!(file.terminals.len(), 1);
        let record = &file.terminals[0];
        assert!(record.closed_at.is_some());
        assert_eq!(record.branch.as_deref(), Some("main"));
    }

    #[tokio::test]
    async fn test_close_for_unknown_terminal_creates_nothing() {
        let dir = tempdir().unwrap();
        record_closed(dir.path(), LAUNCH, 42, Some("main".into()), Local::now())
            .await
            .unwrap();
        assert!(!file_path(dir.path()).exists());
    }

    #[tokio::test]
    async fn test_same_session_id_in_another_launch_is_a_separate_record() {
        let dir = tempdir().unwrap();
        record_opened(dir.path(), "old", 1, "a".into(), None, Local::now())
            .await
            .unwrap();
        record_opened(dir.path(), LAUNCH, 1, "b".into(), None, Local::now())
            .await
            .unwrap();
        record_closed(dir.path(), LAUNCH, 1, None, Local::now())
            .await
            .unwrap();
        let file = read_raw(dir.path());
        assert_eq!(file.terminals.len(), 2);
        let mine = file
            .terminals
            .iter()
            .find(|t| t.launch_id == LAUNCH)
            .unwrap();
        assert_eq!(mine.project_name, "b");
        assert!(mine.closed_at.is_some());
    }

    #[tokio::test]
    async fn test_close_all_closes_this_launch_open_records() {
        let dir = tempdir().unwrap();
        let earlier = hours_ago(1);
        write_raw(
            dir.path(),
            &ActivityFile {
                candidates: vec![],
                terminals: vec![
                    terminal(LAUNCH, 1, &earlier, None),
                    terminal(LAUNCH, 2, &earlier, Some(&earlier)),
                ],
            },
        );
        record_all_closed(dir.path(), LAUNCH, Local::now())
            .await
            .unwrap();
        let file = read_raw(dir.path());
        assert!(file.terminals[0].closed_at.is_some());
        assert_eq!(
            file.terminals[1].closed_at.as_deref(),
            Some(earlier.as_str())
        );
    }

    #[tokio::test]
    async fn test_stale_open_record_from_another_launch_is_closed_at_file_mtime() {
        let dir = tempdir().unwrap();
        let last_write = Local::now() - Duration::hours(1);
        write_raw(
            dir.path(),
            &ActivityFile {
                candidates: vec![],
                terminals: vec![
                    terminal("crashed", 1, &hours_ago(3), None),
                    terminal(current_launch_id(), 2, &hours_ago(3), None),
                ],
            },
        );
        set_mtime(dir.path(), last_write);

        let start = (Local::now() - Duration::minutes(30)).with_timezone(&Utc);
        let end = (Local::now() + Duration::minutes(1)).with_timezone(&Utc);
        let listed = list_terminal_records(dir.path(), start, end).await.unwrap();
        let sessions: Vec<u32> = listed.iter().map(|t| t.session_id).collect();
        assert_eq!(sessions, vec![2], "the stale record is no longer running");

        let file = read_raw(dir.path());
        let stale = file.terminals.iter().find(|t| t.session_id == 1).unwrap();
        let closed = parse_stamp(stale.closed_at.as_deref().unwrap()).unwrap();
        let expected = last_write.with_timezone(&Utc);
        assert!(
            (closed - expected).num_seconds().abs() <= 1,
            "closed at {closed}"
        );
        let current = file.terminals.iter().find(|t| t.session_id == 2).unwrap();
        assert!(
            current.closed_at.is_none(),
            "this launch's record stays open"
        );
    }

    #[tokio::test]
    async fn test_stale_close_is_floored_at_the_open_time() {
        let dir = tempdir().unwrap();
        let opened = hours_ago(1);
        write_raw(
            dir.path(),
            &ActivityFile {
                candidates: vec![],
                terminals: vec![terminal("crashed", 1, &opened, None)],
            },
        );
        set_mtime(dir.path(), Local::now() - Duration::hours(2));
        let _guard = FILE_LOCK.lock().await;
        let file = load(dir.path(), Utc::now(), LAUNCH).await.unwrap();
        assert_eq!(
            file.terminals[0].closed_at.as_deref(),
            Some(opened.as_str())
        );
    }

    #[test]
    fn test_prune_removes_old_entries_and_keeps_open_terminals() {
        let now = Utc::now();
        let old = hours_ago(25);
        let fresh = hours_ago(23);
        let mut file = ActivityFile {
            candidates: vec![
                candidate_created("old", &old),
                candidate_created("fresh", &fresh),
            ],
            terminals: vec![
                // Open in this launch for 30 hours: kept.
                terminal(LAUNCH, 1, &hours_ago(30), None),
                // Closed 25 hours ago: pruned.
                terminal(LAUNCH, 2, &hours_ago(30), Some(&old)),
                // Opened long ago but closed recently: kept.
                terminal(LAUNCH, 3, &hours_ago(30), Some(&fresh)),
                // Another launch, no close, opened 25 hours ago: pruned.
                terminal("old", 4, &old, None),
                // Another launch, no close, opened recently: kept.
                terminal("old", 5, &fresh, None),
                // Unreadable time: pruned.
                terminal("old", 6, "not a time", Some("not a time")),
            ],
        };
        assert!(prune(&mut file, now, LAUNCH));
        let ids: Vec<&str> = file.candidates.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["fresh"]);
        let sessions: Vec<u32> = file.terminals.iter().map(|t| t.session_id).collect();
        assert_eq!(sessions, vec![1, 3, 5]);
        assert!(
            !prune(&mut file, now, LAUNCH),
            "a second prune removes nothing"
        );
    }

    #[tokio::test]
    async fn test_load_prunes_and_persists_the_prune() {
        let dir = tempdir().unwrap();
        write_raw(
            dir.path(),
            &ActivityFile {
                candidates: vec![],
                terminals: vec![
                    terminal("old", 1, &hours_ago(30), Some(&hours_ago(26))),
                    terminal(LAUNCH, 2, &hours_ago(30), None),
                ],
            },
        );
        let _guard = FILE_LOCK.lock().await;
        let file = load(dir.path(), Utc::now(), LAUNCH).await.unwrap();
        assert_eq!(file.terminals.len(), 1);
        assert_eq!(
            read_raw(dir.path()).terminals.len(),
            1,
            "the prune is written back"
        );
    }

    #[tokio::test]
    async fn test_load_returns_pruned_data_when_write_back_fails() {
        let dir = tempdir().unwrap();
        write_raw(
            dir.path(),
            &ActivityFile {
                candidates: vec![candidate_created("old", &hours_ago(25))],
                terminals: vec![],
            },
        );
        // A folder where the temp file must go makes the write-back fail.
        let tmp = dir
            .path()
            .join(format!("{ACTIVITY_FILE}.tmp.{}", std::process::id()));
        std::fs::create_dir(&tmp).unwrap();

        let _guard = FILE_LOCK.lock().await;
        let file = load(dir.path(), Utc::now(), LAUNCH).await.unwrap();
        assert!(
            file.candidates.is_empty(),
            "the read still returns pruned data"
        );
        assert_eq!(read_raw(dir.path()).candidates.len(), 1, "the write failed");
    }

    #[tokio::test]
    async fn test_write_prunes_old_entries() {
        let dir = tempdir().unwrap();
        let mut file = ActivityFile {
            candidates: vec![
                candidate_created("old", &hours_ago(25)),
                candidate_created("fresh", &hours_ago(1)),
            ],
            terminals: vec![terminal("old", 1, &hours_ago(30), Some(&hours_ago(25)))],
        };
        save(dir.path(), &mut file, Utc::now(), LAUNCH)
            .await
            .unwrap();
        let written = read_raw(dir.path());
        let ids: Vec<&str> = written.candidates.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["fresh"]);
        assert!(written.terminals.is_empty());
    }

    #[tokio::test]
    async fn test_adding_a_candidate_drops_day_old_ones() {
        let dir = tempdir().unwrap();
        write_raw(
            dir.path(),
            &ActivityFile {
                candidates: vec![candidate_created("old", &hours_ago(25))],
                terminals: vec![],
            },
        );
        add_candidates(
            dir.path(),
            vec![new_candidate("2026-10-15", None, "new one")],
        )
        .await
        .unwrap();
        let written = read_raw(dir.path());
        assert_eq!(written.candidates.len(), 1);
        assert_eq!(written.candidates[0].text, "new one");
    }

    #[tokio::test]
    async fn test_add_candidates_starts_pending_and_lists_by_date() {
        let dir = tempdir().unwrap();
        let added = add_candidates(
            dir.path(),
            vec![
                new_candidate("2026-10-15", Some("14:05"), "Merged the\nlogin fix"),
                new_candidate("2026-10-14", None, "Meeting - Design sync"),
            ],
        )
        .await
        .unwrap();
        assert_eq!(added.len(), 2);
        assert!(added.iter().all(|c| c.state == CandidateState::Pending));
        assert_ne!(added[0].id, added[1].id);
        assert_eq!(
            added[0].text, "Merged the login fix",
            "text is kept to one line"
        );

        let today = list_candidates(dir.path(), "2026-10-15").await.unwrap();
        assert_eq!(today.len(), 1);
        assert_eq!(today[0].time.as_deref(), Some("14:05"));
        assert!(list_candidates(dir.path(), "2026-10-13")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn test_loose_date_and_time_are_stored_normalised() {
        let dir = tempdir().unwrap();
        let added = add_candidates(
            dir.path(),
            vec![new_candidate("2026-1-5", Some("9:5"), "x")],
        )
        .await
        .unwrap();
        assert_eq!(added[0].date, "2026-01-05");
        assert_eq!(added[0].time.as_deref(), Some("09:05"));
        let listed = list_candidates(dir.path(), "2026-01-05").await.unwrap();
        assert_eq!(listed.len(), 1, "an exact-string lookup finds it");
    }

    #[test]
    fn test_validate_candidate_normalises_and_reports_each_problem() {
        let ok =
            validate_candidate(&new_candidate("2026-10-5", Some("7:00"), "  a \n b ")).unwrap();
        assert_eq!(ok.date, "2026-10-05");
        assert_eq!(ok.time.as_deref(), Some("07:00"));
        assert_eq!(ok.text, "a b");
        assert!(matches!(
            validate_candidate(&new_candidate("15/10/2026", None, "x")),
            Err(ActivityError::InvalidDate(_))
        ));
        assert!(matches!(
            validate_candidate(&new_candidate("2026-10-15", Some("2pm"), "x")),
            Err(ActivityError::InvalidTime(_))
        ));
        assert!(matches!(
            validate_candidate(&new_candidate("2026-10-15", None, "   ")),
            Err(ActivityError::EmptyText)
        ));
    }

    #[tokio::test]
    async fn test_add_candidates_rejects_bad_input_and_writes_nothing() {
        let dir = tempdir().unwrap();
        for bad in [
            new_candidate("15/10/2026", None, "x"),
            new_candidate("2026-10-15", Some("2pm"), "x"),
            new_candidate("2026-10-15", None, "   "),
        ] {
            let ok = new_candidate("2026-10-15", None, "fine");
            assert!(add_candidates(dir.path(), vec![ok, bad]).await.is_err());
        }
        assert!(!file_path(dir.path()).exists());
    }

    #[tokio::test]
    async fn test_set_candidate_state_updates_and_errors_on_unknown_id() {
        let dir = tempdir().unwrap();
        let added = add_candidates(dir.path(), vec![new_candidate("2026-10-15", None, "x")])
            .await
            .unwrap();
        let updated = set_candidate_state(dir.path(), &added[0].id, CandidateState::Rejected)
            .await
            .unwrap();
        assert_eq!(updated.state, CandidateState::Rejected);
        let listed = list_candidates(dir.path(), "2026-10-15").await.unwrap();
        assert_eq!(listed[0].state, CandidateState::Rejected);
        assert!(matches!(
            set_candidate_state(dir.path(), "nope", CandidateState::Pending).await,
            Err(ActivityError::CandidateNotFound(_))
        ));
    }

    #[tokio::test]
    async fn test_list_terminal_records_in_window() {
        let dir = tempdir().unwrap();
        // Use the current launch so the open record survives pruning.
        let launch = current_launch_id();
        let base = Local::now() - Duration::hours(12);
        let rel = |h: i64| stamp(base + Duration::hours(h));
        write_raw(
            dir.path(),
            &ActivityFile {
                candidates: vec![],
                terminals: vec![
                    // Before the window.
                    terminal(launch, 1, &rel(0), Some(&rel(1))),
                    // Overlaps the window start.
                    terminal(launch, 2, &rel(1), Some(&rel(3))),
                    // Inside the window.
                    terminal(launch, 3, &rel(3), Some(&rel(4))),
                    // Still open.
                    terminal(launch, 4, &rel(4), None),
                    // After the window.
                    terminal(launch, 5, &rel(6), Some(&rel(7))),
                ],
            },
        );
        let start = (base + Duration::hours(2)).with_timezone(&Utc);
        let end = (base + Duration::hours(5)).with_timezone(&Utc);
        let records = list_terminal_records(dir.path(), start, end).await.unwrap();
        let sessions: Vec<u32> = records.iter().map(|t| t.session_id).collect();
        assert_eq!(sessions, vec![2, 3, 4]);
    }

    #[test]
    fn test_window_is_half_open_at_the_boundaries() {
        // Whole seconds, the precision the file stores.
        let t = parse_stamp(&hours_ago(2)).unwrap().with_timezone(&Local);
        let boundary = t.with_timezone(&Utc);
        let before = (t - Duration::hours(1)).with_timezone(&Utc);
        let after = (t + Duration::hours(1)).with_timezone(&Utc);
        let earlier = stamp(t - Duration::minutes(30));
        let later = stamp(t + Duration::minutes(30));

        // Closed exactly on the boundary: only the earlier window.
        let closed_on = terminal(LAUNCH, 1, &earlier, Some(&stamp(t)));
        assert!(in_window(&closed_on, before, boundary));
        assert!(!in_window(&closed_on, boundary, after));

        // Opened exactly on the boundary: only the later window.
        let opened_on = terminal(LAUNCH, 2, &stamp(t), Some(&later));
        assert!(!in_window(&opened_on, before, boundary));
        assert!(in_window(&opened_on, boundary, after));

        // Opened and closed in the same second, on the boundary: one window.
        let point = terminal(LAUNCH, 3, &stamp(t), Some(&stamp(t)));
        assert!(!in_window(&point, before, boundary));
        assert!(in_window(&point, boundary, after));
    }

    #[tokio::test]
    async fn test_damaged_file_is_set_aside_and_treated_as_empty() {
        let dir = tempdir().unwrap();
        let damaged = dir.path().join(DAMAGED_FILE);
        std::fs::write(&damaged, "an older damaged copy").unwrap();
        std::fs::write(file_path(dir.path()), "{ not json").unwrap();

        assert!(list_candidates(dir.path(), "2026-10-15")
            .await
            .unwrap()
            .is_empty());
        assert_eq!(std::fs::read_to_string(&damaged).unwrap(), "{ not json");
        assert!(!file_path(dir.path()).exists());

        add_candidates(dir.path(), vec![new_candidate("2026-10-15", None, "x")])
            .await
            .unwrap();
        assert_eq!(read_raw(dir.path()).candidates.len(), 1);
    }

    #[test]
    fn test_serialized_shape_uses_lowercase_tags_and_omits_empty_fields() {
        let mut candidate = candidate_created("c", "2026-10-15T10:00:00+01:00");
        candidate.source = CandidateSource::Github;
        candidate.time = None;
        let json = serde_json::to_value(&candidate).unwrap();
        assert_eq!(json["source"], "github");
        assert_eq!(json["state"], "pending");
        assert!(json.get("time").is_none());
        let record = terminal(LAUNCH, 1, "2026-10-15T10:00:00+01:00", None);
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["projectName"], "proj");
        assert!(json.get("closedAt").is_none());
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    #[tokio::test]
    async fn test_resolve_branch_reads_the_checked_out_branch() {
        let root = tempdir().unwrap();
        let repo = root.path().join("myrepo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(
            &repo,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
        git(
            &repo,
            &["worktree", "add", "-q", "-b", "feat/wt", "../wt-folder"],
        );

        let branch = resolve_branch(&repo.to_string_lossy()).await;
        assert_eq!(branch.as_deref(), Some("main"));
        let wt = root.path().join("wt-folder");
        let branch = resolve_branch(&wt.to_string_lossy()).await;
        assert_eq!(branch.as_deref(), Some("feat/wt"));
    }

    #[tokio::test]
    async fn test_resolve_branch_outside_git_is_none() {
        let root = tempdir().unwrap();
        assert_eq!(resolve_branch(&root.path().to_string_lossy()).await, None);
    }
}
