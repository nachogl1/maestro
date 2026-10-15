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

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use chrono::{DateTime, Duration, Local, NaiveDate, NaiveTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::commands::ai_runner::artifact_base_dir;
use crate::core::samurai_files::canonical_key;
use crate::core::samurai_injector::strip_extended_prefix;
use crate::git::Git;

/// File name inside the work-journal app-data folder.
const ACTIVITY_FILE: &str = "activity.json";

/// How long an entry is kept after it stops being current.
const RETENTION_HOURS: i64 = 24;

/// Project name used when no path is known for a terminal.
const UNKNOWN_PROJECT: &str = "unknown";

/// Serialises every read-modify-write of the file inside this process, so two
/// terminals opening at once cannot drop each other's record.
static FILE_LOCK: Mutex<()> = Mutex::const_new(());

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
    pub id: String,
    /// The day page it belongs to, ISO `YYYY-MM-DD`.
    pub date: String,
    /// When the activity happened, `HH:MM` (none for an untimed meeting).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    /// One line of text.
    pub text: String,
    pub source: CandidateSource,
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
    pub id: String,
    /// The app launch that opened it. Session ids restart every launch, so
    /// (`launch_id`, `session_id`) is the record's identity.
    pub launch_id: String,
    pub session_id: u32,
    pub project_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// RFC 3339, local offset.
    pub opened_at: String,
    /// RFC 3339, local offset. Absent while open, and for a terminal whose
    /// app launch ended without closing it (crash, force-quit).
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

/// Drops every expired entry. A terminal still open in `launch` is kept; any
/// other terminal ages from its close (or, if it never closed, its open).
/// Returns whether anything was removed.
fn prune(file: &mut ActivityFile, now: DateTime<Utc>, launch: &str) -> bool {
    let before = file.candidates.len() + file.terminals.len();
    file.candidates.retain(|c| !expired(&c.created_at, now));
    file.terminals.retain(|t| {
        if t.closed_at.is_none() && t.launch_id == launch {
            return true;
        }
        !expired(t.closed_at.as_deref().unwrap_or(&t.opened_at), now)
    });
    before != file.candidates.len() + file.terminals.len()
}

fn file_path(dir: &Path) -> PathBuf {
    dir.join(ACTIVITY_FILE)
}

/// Reads the file, pruned. A missing file is empty; an unparseable one is
/// logged and treated as empty (it only holds day-old scratch data, and the
/// next write replaces it). Persists the prune when it removed anything.
/// Callers hold [`FILE_LOCK`].
async fn load(dir: &Path, now: DateTime<Utc>, launch: &str) -> Result<ActivityFile, String> {
    let path = file_path(dir);
    let mut file = match tokio::fs::read_to_string(&path).await {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            log::warn!("work journal: {path:?} is unreadable ({e}); starting it afresh");
            ActivityFile::default()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ActivityFile::default(),
        Err(e) => return Err(format!("failed to read {path:?}: {e}")),
    };
    if prune(&mut file, now, launch) {
        save(dir, &mut file, now, launch).await?;
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
) -> Result<(), String> {
    prune(file, now, launch);
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("failed to create {dir:?}: {e}"))?;
    let path = file_path(dir);
    let tmp = dir.join(format!("{ACTIVITY_FILE}.tmp.{}", std::process::id()));
    let json = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
    let result = crate::core::atomic_write::atomic_write_async(path, tmp.clone(), json).await;
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[allow(dead_code)] // reached through `add_candidates` (issue #313)
fn validate_new(candidate: &NewCandidate) -> Result<(String, Option<String>), String> {
    NaiveDate::parse_from_str(&candidate.date, "%Y-%m-%d")
        .map_err(|_| format!("candidate date '{}' is not YYYY-MM-DD", candidate.date))?;
    if let Some(time) = &candidate.time {
        NaiveTime::parse_from_str(time, "%H:%M")
            .map_err(|_| format!("candidate time '{time}' is not HH:MM"))?;
    }
    let text = candidate
        .text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        return Err("candidate text is empty".to_string());
    }
    Ok((text, candidate.time.clone()))
}

/// Adds candidates (all pending) and returns them with their new ids.
/// Nothing is written if any candidate is invalid.
#[allow(dead_code)] // first used by issue #313 (scheduled candidate run)
pub async fn add_candidates(dir: &Path, new: Vec<NewCandidate>) -> Result<Vec<Candidate>, String> {
    let now = Local::now();
    let mut added = Vec::with_capacity(new.len());
    for candidate in &new {
        let (text, time) = validate_new(candidate)?;
        added.push(Candidate {
            id: uuid::Uuid::new_v4().to_string(),
            date: candidate.date.clone(),
            time,
            text,
            source: candidate.source,
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
) -> Result<Candidate, String> {
    let now = Utc::now();
    let launch = current_launch_id();
    let _guard = FILE_LOCK.lock().await;
    let mut file = load(dir, now, launch).await?;
    let candidate = file
        .candidates
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("no work journal candidate with id {id}"))?;
    candidate.state = state;
    let updated = candidate.clone();
    save(dir, &mut file, now, launch).await?;
    Ok(updated)
}

/// Every candidate (pending and rejected) for one `YYYY-MM-DD` date.
#[allow(dead_code)] // first used by issues #313 and #314
pub async fn list_candidates(dir: &Path, date: &str) -> Result<Vec<Candidate>, String> {
    let _guard = FILE_LOCK.lock().await;
    let file = load(dir, Utc::now(), current_launch_id()).await?;
    Ok(file
        .candidates
        .into_iter()
        .filter(|c| c.date == date)
        .collect())
}

/// Terminal records that were open at any moment in `[from, to]`: opened by
/// `to`, and not closed before `from` (a record with no close counts as
/// still running).
#[allow(dead_code)] // first used by issue #308 (activity time window)
pub async fn list_terminal_records(
    dir: &Path,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<TerminalRecord>, String> {
    let _guard = FILE_LOCK.lock().await;
    let file = load(dir, Utc::now(), current_launch_id()).await?;
    Ok(file
        .terminals
        .into_iter()
        .filter(|t| {
            let opened_by_end = parse_stamp(&t.opened_at).is_some_and(|o| o <= to);
            let open_at_start = match t.closed_at.as_deref() {
                None => true,
                Some(c) => parse_stamp(c).is_some_and(|c| c >= from),
            };
            opened_by_end && open_at_start
        })
        .collect())
}

/// Records a terminal opening. If its close was already recorded (the close
/// raced ahead of this write), only the open time and any missing details
/// are filled in.
async fn record_opened(
    dir: &Path,
    launch: &str,
    session_id: u32,
    project_name: String,
    branch: Option<String>,
    opened_at: DateTime<Local>,
) -> Result<(), String> {
    let now = Utc::now();
    let _guard = FILE_LOCK.lock().await;
    let mut file = load(dir, now, launch).await?;
    match file
        .terminals
        .iter_mut()
        .find(|t| t.launch_id == launch && t.session_id == session_id)
    {
        Some(existing) => {
            existing.opened_at = stamp(opened_at);
            if existing.project_name == UNKNOWN_PROJECT {
                existing.project_name = project_name;
            }
            if existing.branch.is_none() {
                existing.branch = branch;
            }
        }
        None => file.terminals.push(TerminalRecord {
            id: uuid::Uuid::new_v4().to_string(),
            launch_id: launch.to_string(),
            session_id,
            project_name,
            branch,
            opened_at: stamp(opened_at),
            closed_at: None,
        }),
    }
    save(dir, &mut file, now, launch).await
}

/// Records a terminal closing. `project_path` and `branch` come from the
/// session registry when it still knows the session; they replace what was
/// guessed at open time. A close with no open record creates one that opens
/// and closes at the same moment.
async fn record_closed(
    dir: &Path,
    launch: &str,
    session_id: u32,
    project_path: Option<&str>,
    branch: Option<String>,
    closed_at: DateTime<Local>,
) -> Result<(), String> {
    let now = Utc::now();
    let _guard = FILE_LOCK.lock().await;
    let mut file = load(dir, now, launch).await?;
    let index = match file
        .terminals
        .iter()
        .position(|t| t.launch_id == launch && t.session_id == session_id)
    {
        Some(index) => index,
        None => {
            file.terminals.push(TerminalRecord {
                id: uuid::Uuid::new_v4().to_string(),
                launch_id: launch.to_string(),
                session_id,
                project_name: UNKNOWN_PROJECT.to_string(),
                branch: None,
                opened_at: stamp(closed_at),
                closed_at: None,
            });
            file.terminals.len() - 1
        }
    };
    let record = &mut file.terminals[index];
    if record.closed_at.is_none() {
        record.closed_at = Some(stamp(closed_at));
    }
    if let Some(path) = project_path {
        record.project_name = project_name_from_path(path);
    }
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
) -> Result<(), String> {
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

/// Project name and branch for a terminal's working directory, from git: the
/// project is the folder holding the shared `.git` (so a worktree reports
/// its main repo, not the worktree folder) and the branch is the checked-out
/// one. Outside a git repo, the folder name and no branch.
async fn resolve_project_and_branch(cwd: &str) -> (String, Option<String>) {
    let git = Git::new(cwd);
    let branch = git.current_branch().await.ok().filter(|b| !b.is_empty());
    let project = match git.run(&["rev-parse", "--git-common-dir"]).await {
        Ok(output) => {
            let common = Path::new(cwd).join(output.trimmed());
            canonical_key(&common).ok().and_then(|common| {
                let common = Path::new(&common);
                (common.file_name()? == ".git")
                    .then(|| common.parent())
                    .flatten()
                    .map(|repo| project_name_from_path(&repo.to_string_lossy()))
            })
        }
        Err(_) => None,
    };
    (
        project.unwrap_or_else(|| project_name_from_path(cwd)),
        branch,
    )
}

/// Notes a newly spawned terminal in the background, so a launch is never
/// delayed or failed by the journal; errors are only logged.
pub fn note_terminal_opened(session_id: u32, cwd: Option<String>) {
    let opened_at = Local::now();
    tauri::async_runtime::spawn(async move {
        let (project, branch) = match cwd.as_deref() {
            Some(dir) => resolve_project_and_branch(dir).await,
            None => (UNKNOWN_PROJECT.to_string(), None),
        };
        let launch = current_launch_id();
        if let Err(e) = record_opened(
            &activity_dir(),
            launch,
            session_id,
            project,
            branch,
            opened_at,
        )
        .await
        {
            log::warn!("work journal: could not record terminal {session_id} opening: {e}");
        }
    });
}

/// Notes a killed terminal in the background; errors are only logged.
pub fn note_terminal_closed(session_id: u32, project_path: Option<String>, branch: Option<String>) {
    let closed_at = Local::now();
    tauri::async_runtime::spawn(async move {
        let launch = current_launch_id();
        if let Err(e) = record_closed(
            &activity_dir(),
            launch,
            session_id,
            project_path.as_deref(),
            branch,
            closed_at,
        )
        .await
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
        record_opened(
            dir.path(),
            LAUNCH,
            7,
            "guess".into(),
            Some("feat/x".into()),
            opened,
        )
        .await
        .unwrap();
        record_closed(
            dir.path(),
            LAUNCH,
            7,
            Some(r"\\?\C:\git\maestro"),
            None,
            Local::now(),
        )
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
    async fn test_close_uses_registry_branch_when_known() {
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
        record_closed(
            dir.path(),
            LAUNCH,
            1,
            None,
            Some("feat/y".into()),
            Local::now(),
        )
        .await
        .unwrap();
        let record = &read_raw(dir.path()).terminals[0];
        assert_eq!(record.branch.as_deref(), Some("feat/y"));
        assert_eq!(
            record.project_name, "p",
            "no registry path keeps the open-time name"
        );
    }

    #[tokio::test]
    async fn test_close_racing_ahead_of_open_still_yields_one_record() {
        let dir = tempdir().unwrap();
        let opened = Local::now() - Duration::seconds(5);
        record_closed(dir.path(), LAUNCH, 3, Some("/x/proj"), None, Local::now())
            .await
            .unwrap();
        record_opened(
            dir.path(),
            LAUNCH,
            3,
            "proj".into(),
            Some("main".into()),
            opened,
        )
        .await
        .unwrap();
        let file = read_raw(dir.path());
        assert_eq!(file.terminals.len(), 1);
        let record = &file.terminals[0];
        assert_eq!(record.opened_at, stamp(opened));
        assert!(record.closed_at.is_some());
        assert_eq!(record.branch.as_deref(), Some("main"));
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
        record_closed(dir.path(), LAUNCH, 1, None, None, Local::now())
            .await
            .unwrap();
        let file = read_raw(dir.path());
        assert_eq!(file.terminals.len(), 2);
        let old = file
            .terminals
            .iter()
            .find(|t| t.launch_id == "old")
            .unwrap();
        assert!(
            old.closed_at.is_none(),
            "closing in this launch never touches another launch"
        );
    }

    #[tokio::test]
    async fn test_close_all_closes_only_this_launch_open_records() {
        let dir = tempdir().unwrap();
        let earlier = hours_ago(1);
        write_raw(
            dir.path(),
            &ActivityFile {
                candidates: vec![],
                terminals: vec![
                    terminal(LAUNCH, 1, &earlier, None),
                    terminal(LAUNCH, 2, &earlier, Some(&earlier)),
                    terminal("old", 1, &earlier, None),
                ],
            },
        );
        record_all_closed(dir.path(), LAUNCH, Local::now())
            .await
            .unwrap();
        let file = read_raw(dir.path());
        let get = |launch: &str, id: u32| {
            file.terminals
                .iter()
                .find(|t| t.launch_id == launch && t.session_id == id)
                .unwrap()
                .clone()
        };
        assert!(get(LAUNCH, 1).closed_at.is_some());
        assert_eq!(get(LAUNCH, 2).closed_at.as_deref(), Some(earlier.as_str()));
        assert!(get("old", 1).closed_at.is_none());
    }

    #[test]
    fn test_prune_removes_old_entries_and_keeps_open_terminals() {
        let now = Utc::now();
        let old = hours_ago(25);
        let fresh = hours_ago(23);
        let mut file = ActivityFile {
            candidates: vec![
                Candidate {
                    id: "old".into(),
                    date: "2026-10-14".into(),
                    time: None,
                    text: "t".into(),
                    source: CandidateSource::Claude,
                    state: CandidateState::Pending,
                    created_at: old.clone(),
                },
                Candidate {
                    id: "fresh".into(),
                    date: "2026-10-14".into(),
                    time: None,
                    text: "t".into(),
                    source: CandidateSource::Claude,
                    state: CandidateState::Rejected,
                    created_at: fresh.clone(),
                },
            ],
            terminals: vec![
                // Open in this launch for 30 hours: kept.
                terminal(LAUNCH, 1, &hours_ago(30), None),
                // Closed 25 hours ago: pruned.
                terminal(LAUNCH, 2, &hours_ago(30), Some(&old)),
                // Opened long ago but closed recently: kept.
                terminal(LAUNCH, 3, &hours_ago(30), Some(&fresh)),
                // Left open by an earlier launch, opened 25 hours ago: pruned.
                terminal("old", 4, &old, None),
                // Left open by an earlier launch, opened recently: kept.
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
        assert!(
            set_candidate_state(dir.path(), "nope", CandidateState::Pending)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn test_list_terminal_records_in_window() {
        let dir = tempdir().unwrap();
        // Use the current launch so the open record survives pruning.
        let launch = current_launch_id();
        let now = Local::now();
        let base = now - Duration::hours(12);
        let rel = |h: i64| base + Duration::hours(h);
        write_raw(
            dir.path(),
            &ActivityFile {
                candidates: vec![],
                terminals: vec![
                    // Before the window.
                    terminal(launch, 1, &stamp(rel(0)), Some(&stamp(rel(1)))),
                    // Overlaps the window start.
                    terminal(launch, 2, &stamp(rel(1)), Some(&stamp(rel(3)))),
                    // Inside the window.
                    terminal(launch, 3, &stamp(rel(3)), Some(&stamp(rel(4)))),
                    // Still open.
                    terminal(launch, 4, &stamp(rel(4)), None),
                    // After the window.
                    terminal(launch, 5, &stamp(rel(6)), Some(&stamp(rel(7)))),
                ],
            },
        );
        let from = rel(2).with_timezone(&Utc);
        let to = rel(5).with_timezone(&Utc);
        let records = list_terminal_records(dir.path(), from, to).await.unwrap();
        let sessions: Vec<u32> = records.iter().map(|t| t.session_id).collect();
        assert_eq!(sessions, vec![2, 3, 4]);
    }

    #[tokio::test]
    async fn test_corrupt_file_is_treated_as_empty() {
        let dir = tempdir().unwrap();
        std::fs::write(file_path(dir.path()), "{ not json").unwrap();
        assert!(list_candidates(dir.path(), "2026-10-15")
            .await
            .unwrap()
            .is_empty());
        add_candidates(dir.path(), vec![new_candidate("2026-10-15", None, "x")])
            .await
            .unwrap();
        assert_eq!(read_raw(dir.path()).candidates.len(), 1);
    }

    #[test]
    fn test_serialized_shape_uses_lowercase_tags_and_omits_empty_fields() {
        let candidate = Candidate {
            id: "c".into(),
            date: "2026-10-15".into(),
            time: None,
            text: "t".into(),
            source: CandidateSource::Github,
            state: CandidateState::Pending,
            created_at: "2026-10-15T10:00:00+01:00".into(),
        };
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
    async fn test_resolve_reports_main_repo_name_for_a_worktree() {
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

        let (project, branch) = resolve_project_and_branch(&repo.to_string_lossy()).await;
        assert_eq!(project, "myrepo");
        assert_eq!(branch.as_deref(), Some("main"));

        let wt = root.path().join("wt-folder");
        let (project, branch) = resolve_project_and_branch(&wt.to_string_lossy()).await;
        assert_eq!(project, "myrepo", "a worktree reports its main repo");
        assert_eq!(branch.as_deref(), Some("feat/wt"));
    }

    #[tokio::test]
    async fn test_resolve_outside_git_uses_folder_name() {
        let root = tempdir().unwrap();
        let plain = root.path().join("plain-folder");
        std::fs::create_dir(&plain).unwrap();
        let (project, branch) = resolve_project_and_branch(&plain.to_string_lossy()).await;
        assert_eq!(project, "plain-folder");
        assert_eq!(branch, None);
    }
}
