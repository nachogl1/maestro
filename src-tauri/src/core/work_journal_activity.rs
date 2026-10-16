//! The Work Journal's temporary activity file: `<app data>/work-journal/activity.json`.
//!
//! It holds three kinds of short-lived entries (PRD "Candidates" → "Temporary
//! file", and "Data model"):
//!
//! - **Candidates** a candidate run proposed for a day page, while they are
//!   still pending or after the user rejected them (kept for same-day
//!   duplicate removal).
//! - **Terminal records**: one per terminal — project name, branch, opened-at
//!   and closed-at. Nothing typed in a terminal is ever stored.
//! - **Sent activity**: which activity items a candidate run already gave
//!   `claude` for a date (identity and a short hash, never the text), so the
//!   next run does not send them again.
//!
//! Every entry is deleted 24 hours after it stops being current, on every
//! load and every write. A terminal that is still open in this app launch, or
//! in another Maestro instance that is still running, is never pruned. This
//! file is NOT `work-journal.json` and is never backed up.
//!
//! The file's folder is shared by every Maestro instance on the machine (a
//! devtest copy next to the installed app), so each read-modify-write also
//! holds an OS lock on a sibling lock file (see [`lock`]).
//!
//! Every function takes the base directory so tests can point it at a temp
//! dir; the app passes [`activity_dir`].

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use chrono::{DateTime, Duration, Local, NaiveDate, NaiveTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tokio::sync::{Mutex, MutexGuard};

use crate::core::samurai_injector::strip_extended_prefix;
use crate::core::session_manager::SessionConfig;
use crate::core::work_journal::work_journal_dir;
use crate::git::Git;

/// File name inside the work-journal app-data folder.
const ACTIVITY_FILE: &str = "activity.json";

/// Where an unparseable `activity.json` is moved before starting afresh.
const DAMAGED_FILE: &str = "activity.json.damaged";

/// How long an entry is kept after it stops being current.
const RETENTION_HOURS: i64 = 24;

/// Project name used when a path has no usable last component.
const UNKNOWN_PROJECT: &str = "unknown";

/// Sibling file whose OS lock serialises read-modify-writes of
/// `activity.json` across Maestro instances. It stays empty and is never
/// deleted, so every instance locks the same file.
const LOCK_FILE: &str = "activity.json.lock";

/// Serialises every read-modify-write of the file inside this process, so two
/// terminals opening at once cannot drop each other's record. Other Maestro
/// instances are kept out by [`LOCK_FILE`]; take both with [`lock`].
static FILE_LOCK: Mutex<()> = Mutex::const_new(());

/// How long to wait for another instance to release [`LOCK_FILE`].
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Pause between tries while another instance holds [`LOCK_FILE`].
const LOCK_RETRY: std::time::Duration = std::time::Duration::from_millis(50);

/// Hard privacy ceiling: another launch's terminal record that is still open
/// is dropped once it was opened more than this many days ago, even while
/// that launch still runs.
const OPEN_CEILING_DAYS: i64 = 7;

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
    #[error("Failed to lock {path:?}: {source}")]
    Lock {
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
    #[error("Meeting candidate text is longer than {MAX_CANDIDATE_CHARS} characters")]
    MeetingTextTooLong,
    #[error("No work journal candidate with id {0}")]
    CandidateNotFound(String),
}

/// The longest candidate text kept, in characters (not bytes).
pub const MAX_CANDIDATE_CHARS: usize = 200;

/// Caps candidate text at [`MAX_CANDIDATE_CHARS`] characters. Longer
/// Granola text is dropped (`None`): a cut note excerpt is still an excerpt.
/// Other text is cut at the last space within the first
/// [`MAX_CANDIDATE_CHARS`] characters and ends with `…`; when that space is
/// in the first half (a long URL or word), it is cut mid-word instead, so
/// little is lost. Never splits a UTF-8 character.
pub fn cap_candidate_text(text: &str, source: CandidateSource) -> Option<String> {
    if text.chars().count() <= MAX_CANDIDATE_CHARS {
        return Some(text.to_string());
    }
    if source == CandidateSource::Granola {
        return None;
    }
    let head: Vec<char> = text.chars().take(MAX_CANDIDATE_CHARS).collect();
    let at_word = head
        .iter()
        .rposition(|c| c.is_whitespace())
        .filter(|&at| at >= MAX_CANDIDATE_CHARS / 2)
        .map(|at| head[..at].iter().collect::<String>().trim_end().to_string())
        .filter(|cut| !cut.is_empty());
    let cut = at_word.unwrap_or_else(|| head[..MAX_CANDIDATE_CHARS - 1].iter().collect());
    Some(format!("{cut}\u{2026}"))
}

/// Result type for activity-file operations.
pub type ActivityResult<T> = Result<T, ActivityError>;

/// Where a candidate's activity came from (one source tag each).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCandidate {
    /// The day page it belongs to, `YYYY-MM-DD` (loose forms such as
    /// `2026-1-5` are accepted and stored zero-padded).
    pub date: String,
    /// When the activity happened, `HH:MM`; none for an untimed meeting.
    #[serde(default)]
    pub time: Option<String>,
    /// The proposed line; folded to one line when stored.
    pub text: String,
    /// Which activity source proposed it.
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
    /// The PTY session id in that launch (restarts at 1 every launch).
    pub session_id: u32,
    /// Last component of the session's project path, `\\?\` stripped. Set
    /// once at open and never changed.
    pub project_name: String,
    /// The folder the session's shell ran in (its working directory, so the
    /// selected repo of a multi-repo workspace, else its project path),
    /// `\\?\` stripped, so a candidate run covers that repo even after its
    /// tab was closed. Absent in records written before it was added.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
    /// The session's branch, or the checked-out git branch when the session
    /// has none; absent outside git and on a detached HEAD.
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
    /// The process behind each app launch that opened a listed terminal, by
    /// launch id, so another instance can tell whether that launch still
    /// runs. Launches written before it was added have no entry.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub launches: BTreeMap<String, LaunchProcess>,
    /// The activity items a candidate run already gave `claude` for a date
    /// whose run succeeded, so later runs do not send them again. Files
    /// written before it was added have none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sent: Vec<SentRecord>,
}

/// One activity item as sent to a candidate run: never its text, only a
/// short hash of it, so a changed item (a conversation with a new summary)
/// is told apart from one already sent.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentItem {
    /// The date it was sent for, `YYYY-MM-DD`. An item spanning midnight is
    /// that date's own activity on each date.
    pub date: String,
    pub source: CandidateSource,
    /// The item's stable identity (session id, commit hash, ...).
    pub key: String,
    /// Short hash of what the item said.
    pub hash: String,
}

/// A [`SentItem`] and when it was recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentRecord {
    #[serde(flatten)]
    pub item: SentItem,
    /// When it was recorded (RFC 3339) — the pruning clock.
    pub sent_at: String,
}

/// The process of one app launch: its pid and start time. A pid alone is not
/// enough, because the OS reuses pids after a process ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProcess {
    pub pid: u32,
    /// Seconds since the Unix epoch, as the OS reports it.
    pub start_time: u64,
}

/// The folder that holds `activity.json`: the Work Journal's folder, so it
/// follows the same `MAESTRO_WORK_JOURNAL_DIR` override as `work-journal.json`.
pub fn activity_dir() -> PathBuf {
    work_journal_dir()
}

/// This app launch's id, made once per process.
pub fn current_launch_id() -> &'static str {
    static LAUNCH_ID: OnceLock<String> = OnceLock::new();
    LAUNCH_ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

/// The start time of each listed pid that is running, from one sysinfo
/// snapshot of just those pids. Blocking: call it off the async runtime.
fn start_times(pids: &[u32]) -> HashMap<u32, u64> {
    let pids: Vec<Pid> = pids.iter().map(|&pid| Pid::from_u32(pid)).collect();
    let mut sys = System::new();
    // A fresh `System` has nothing dead to remove; and with removal on,
    // sysinfo 0.32 drops a pid that is listed twice.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        false,
        ProcessRefreshKind::new(),
    );
    pids.iter()
        .filter_map(|pid| sys.process(*pid).map(|p| (pid.as_u32(), p.start_time())))
        .collect()
}

/// This process's pid and start time, read once. `None` when the start time
/// cannot be read; such a launch's records are treated as before (closed by
/// the next launch). Blocking on the first call.
fn current_launch_process() -> Option<LaunchProcess> {
    static PROCESS: OnceLock<Option<LaunchProcess>> = OnceLock::new();
    *PROCESS.get_or_init(|| {
        let pid = std::process::id();
        let start_time = start_times(&[pid]).get(&pid).copied()?;
        (start_time != 0).then_some(LaunchProcess { pid, start_time })
    })
}

/// Which of `processes` are still running (same pid, same start time).
/// Blocking: call it off the async runtime.
fn running(processes: HashSet<LaunchProcess>) -> HashSet<LaunchProcess> {
    let pids: Vec<u32> = processes.iter().map(|p| p.pid).collect();
    let times = start_times(&pids);
    processes
        .into_iter()
        .filter(|p| times.get(&p.pid) == Some(&p.start_time))
        .collect()
}

/// When this process last saw each other launch's process running (the
/// `now` of that load). Used as the close time of its open records once it
/// is gone, since it ran at least until then.
fn last_seen_running() -> &'static std::sync::Mutex<HashMap<LaunchProcess, DateTime<Utc>>> {
    type Seen = std::sync::Mutex<HashMap<LaunchProcess, DateTime<Utc>>>;
    static SEEN: OnceLock<Seen> = OnceLock::new();
    SEEN.get_or_init(Default::default)
}

/// The launch processes of `file` whose launch is not `launch`, that still
/// have an open terminal record and are running right now; each is noted as
/// seen running at `now`. Errors count as not running, which keeps the old
/// behaviour (the records get closed).
async fn running_other_launches(
    file: &ActivityFile,
    launch: &str,
    now: DateTime<Utc>,
) -> HashSet<LaunchProcess> {
    let wanted: HashSet<LaunchProcess> = file
        .terminals
        .iter()
        .filter(|t| t.launch_id != launch && t.closed_at.is_none())
        .filter_map(|t| file.launches.get(&t.launch_id).copied())
        .collect();
    if wanted.is_empty() {
        return HashSet::new();
    }
    let alive = tokio::task::spawn_blocking(move || running(wanted))
        .await
        .unwrap_or_else(|e| {
            log::warn!("work journal: could not check which Maestro launches still run: {e}");
            HashSet::new()
        });
    let mut seen = last_seen_running()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    for process in &alive {
        seen.insert(*process, now);
    }
    alive
}

/// Holds the OS lock on [`LOCK_FILE`] until dropped, on every path.
struct CrossProcessLock(std::fs::File);

impl CrossProcessLock {
    /// Waits up to `wait` for no other process to hold the lock, then fails
    /// with [`std::io::ErrorKind::TimedOut`], so a paused or hung instance
    /// cannot hang this one (callers log the error and carry on). Creates
    /// the folder and the lock file when missing. Blocking.
    fn acquire(dir: &Path, wait: std::time::Duration) -> ActivityResult<Self> {
        std::fs::create_dir_all(dir).map_err(|source| ActivityError::CreateDir {
            path: dir.to_path_buf(),
            source,
        })?;
        let path = dir.join(LOCK_FILE);
        let file = std::fs::File::options()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .map_err(|source| ActivityError::Lock {
                path: path.clone(),
                source,
            })?;
        let started = std::time::Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Self(file)),
                Err(std::fs::TryLockError::WouldBlock) if started.elapsed() < wait => {
                    std::thread::sleep(LOCK_RETRY);
                }
                Err(std::fs::TryLockError::WouldBlock) => {
                    let source = std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!("another Maestro held it for more than {wait:?}"),
                    );
                    return Err(ActivityError::Lock { path, source });
                }
                Err(std::fs::TryLockError::Error(source)) => {
                    return Err(ActivityError::Lock { path, source });
                }
            }
        }
    }
}

impl Drop for CrossProcessLock {
    fn drop(&mut self) {
        // Closing the handle releases the lock too; unlocking first is explicit.
        let _ = self.0.unlock();
    }
}

/// Takes the cross-process lock on a blocking thread, so waiting for another
/// instance never stalls the async runtime.
async fn lock_cross_process(dir: &Path) -> ActivityResult<CrossProcessLock> {
    let owned = dir.to_path_buf();
    tokio::task::spawn_blocking(move || CrossProcessLock::acquire(&owned, LOCK_WAIT))
        .await
        .map_err(|e| ActivityError::Lock {
            path: dir.join(LOCK_FILE),
            source: std::io::Error::other(e),
        })?
}

/// Both locks for one read-modify-write of the file, released when dropped:
/// [`FILE_LOCK`] inside this process, then [`LOCK_FILE`] across instances.
struct Locked {
    _across_instances: CrossProcessLock,
    _in_process: MutexGuard<'static, ()>,
}

/// Takes [`FILE_LOCK`], then the cross-process lock. Every read-modify-write
/// holds it around [`load`] and [`save`].
async fn lock(dir: &Path) -> ActivityResult<Locked> {
    let in_process = FILE_LOCK.lock().await;
    let across_instances = lock_cross_process(dir).await?;
    Ok(Locked {
        _across_instances: across_instances,
        _in_process: in_process,
    })
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
/// close is kept if it belongs to `launch` (still open) or to another launch
/// with a known process and a readable open time ([`close_stale`] has
/// already closed those whose process is gone, so the rest still run) and
/// opened at most [`OPEN_CEILING_DAYS`] ago, and otherwise ages from its
/// open (reachable when [`close_stale`] could not read it, or past the
/// ceiling). A launch entry goes once no record refers to it. Returns
/// whether anything was removed.
fn prune(file: &mut ActivityFile, now: DateTime<Utc>, launch: &str) -> bool {
    let before =
        file.candidates.len() + file.terminals.len() + file.launches.len() + file.sent.len();
    file.candidates.retain(|c| !expired(&c.created_at, now));
    file.sent.retain(|s| !expired(&s.sent_at, now));
    let launches = &file.launches;
    let within_ceiling = |opened: &str| {
        parse_stamp(opened).is_some_and(|o| now - o <= Duration::days(OPEN_CEILING_DAYS))
    };
    file.terminals.retain(|t| match t.closed_at.as_deref() {
        Some(closed) => !expired(closed, now),
        None if t.launch_id == launch => true,
        None if launches.contains_key(&t.launch_id) && within_ceiling(&t.opened_at) => true,
        None => !expired(&t.opened_at, now),
    });
    let terminals = &file.terminals;
    file.launches
        .retain(|id, _| terminals.iter().any(|t| &t.launch_id == id));
    before != file.candidates.len() + file.terminals.len() + file.launches.len() + file.sent.len()
}

/// Closes every record left open by another app launch that is no longer
/// running (a crash, a force-kill, or a quit that skipped the close handler
/// such as macOS Cmd+Q). A launch whose process is in `running` is another
/// Maestro instance still using its terminals, so its records stay open; a
/// launch with no known process (written before processes were stored) is
/// treated as gone. The real close time is unknown, so it is estimated:
///
/// - When this process saw that launch running before (`last_seen`, from an
///   earlier load), it ran at least until then, so that time is the end.
/// - Otherwise `bound` is the file's last-modified time as this launch first saw it,
///   before this launch wrote anything. The earlier launch cannot have run
///   a terminal much past its last write to this file, so it is a bounded,
///   plausible end time — not an exact one.
/// - It is floored at the record's own open time, so a close never precedes
///   its open. With no `bound` (no file yet) the close equals the open.
///
/// Without this, such a record would be listed as still running in every
/// later time window. Returns whether anything was closed.
fn close_stale(
    file: &mut ActivityFile,
    launch: &str,
    bound: Option<DateTime<Utc>>,
    running: &HashSet<LaunchProcess>,
    last_seen: &HashMap<LaunchProcess, DateTime<Utc>>,
) -> bool {
    let mut changed = false;
    let launches = &file.launches;
    let still_running = |id: &str| launches.get(id).is_some_and(|p| running.contains(p));
    for record in file
        .terminals
        .iter_mut()
        .filter(|t| t.launch_id != launch && t.closed_at.is_none())
        .filter(|t| !still_running(&t.launch_id))
    {
        let Some(opened) = parse_stamp(&record.opened_at) else {
            continue; // unreadable: prune removes it
        };
        let seen = launches
            .get(&record.launch_id)
            .and_then(|p| last_seen.get(p))
            .copied();
        let end = seen.or(bound).map_or(opened, |b| b.max(opened));
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

/// Deletes [`DAMAGED_FILE`] once its modified time is more than
/// [`RETENTION_HOURS`] before `now`, so a set-aside copy cannot keep raw
/// activity past the one-day limit. A fresh one stays for inspection. A time
/// that cannot be read counts as old (like an unreadable stamp in
/// [`expired`]); a missing file is fine; a failed delete is only logged.
async fn prune_damaged(dir: &Path, now: DateTime<Utc>) {
    let damaged = dir.join(DAMAGED_FILE);
    let modified = match tokio::fs::metadata(&damaged).await {
        Ok(meta) => meta.modified().ok().map(DateTime::<Utc>::from),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => None,
    };
    if modified.is_some_and(|t| now - t <= Duration::hours(RETENTION_HOURS)) {
        return;
    }
    match tokio::fs::remove_file(&damaged).await {
        Ok(()) => log::info!("work journal: deleted {damaged:?}, older than a day"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("work journal: could not delete the old {damaged:?}: {e}"),
    }
}

/// Reads the file, closes stale records and prunes. A missing file is
/// empty; an unparseable one is set aside and treated as empty. A damaged
/// copy older than a day is deleted first (see [`prune_damaged`]). When
/// anything changed, writes it back; a failed write-back is logged and the
/// cleaned data is still returned. Callers hold [`lock`].
async fn load(dir: &Path, now: DateTime<Utc>, launch: &str) -> ActivityResult<ActivityFile> {
    let path = file_path(dir);
    let bound = pre_launch_mtime(&path);
    prune_damaged(dir, now).await;
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
    let running = running_other_launches(&file, launch, now).await;
    let last_seen = last_seen_running()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let closed = close_stale(&mut file, launch, bound, &running, &last_seen);
    let pruned = prune(&mut file, now, launch);
    if closed || pruned {
        if let Err(e) = save(dir, &mut file, now, launch).await {
            log::warn!("work journal: could not write back the cleaned activity file: {e}");
        }
    }
    Ok(file)
}

/// Prunes, then writes the file with the shared temp-then-rename helper.
/// Callers hold [`lock`].
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
/// become `2026-01-05` and `09:05`), text folded to one non-empty line and
/// capped by [`cap_candidate_text`] (an over-long meeting line is an error).
/// Use it to drop bad lines before [`add_candidates`], which rejects a whole
/// batch if any one is invalid.
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
    let text =
        cap_candidate_text(&text, candidate.source).ok_or(ActivityError::MeetingTextTooLong)?;
    Ok(NewCandidate {
        date: date.format("%Y-%m-%d").to_string(),
        time,
        text,
        source: candidate.source,
    })
}

/// Adds candidates (all pending) and returns them with their new ids.
/// Nothing is written if any candidate is invalid.
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
    let _guard = lock(dir).await?;
    let mut file = load(dir, now, launch).await?;
    file.candidates.extend(added.iter().cloned());
    save(dir, &mut file, now, launch).await?;
    Ok(added)
}

/// Sets one candidate's state; errors if no candidate has that id.
pub async fn set_candidate_state(
    dir: &Path,
    id: &str,
    state: CandidateState,
) -> ActivityResult<Candidate> {
    let now = Utc::now();
    let launch = current_launch_id();
    let _guard = lock(dir).await?;
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

/// Removes one candidate and returns it; errors if no candidate has that id.
/// Used on accept: the accepted line lives in the page text from then on.
pub async fn remove_candidate(dir: &Path, id: &str) -> ActivityResult<Candidate> {
    let now = Utc::now();
    let launch = current_launch_id();
    let _guard = lock(dir).await?;
    let mut file = load(dir, now, launch).await?;
    let index = file
        .candidates
        .iter()
        .position(|c| c.id == id)
        .ok_or_else(|| ActivityError::CandidateNotFound(id.to_string()))?;
    let removed = file.candidates.remove(index);
    save(dir, &mut file, now, launch).await?;
    Ok(removed)
}

/// Every candidate (pending and rejected) for one `YYYY-MM-DD` date.
pub async fn list_candidates(dir: &Path, date: &str) -> ActivityResult<Vec<Candidate>> {
    let _guard = lock(dir).await?;
    let file = load(dir, Utc::now(), current_launch_id()).await?;
    Ok(file
        .candidates
        .into_iter()
        .filter(|c| c.date == date)
        .collect())
}

/// How many pending candidates each date has (dates with none are left
/// out), in one read for the pop-out window's day list.
pub async fn pending_counts(dir: &Path) -> ActivityResult<HashMap<String, usize>> {
    let _guard = lock(dir).await?;
    let file = load(dir, Utc::now(), current_launch_id()).await?;
    let mut counts = HashMap::new();
    for candidate in file.candidates {
        if candidate.state == CandidateState::Pending {
            *counts.entry(candidate.date).or_insert(0) += 1;
        }
    }
    Ok(counts)
}

/// Every activity item a candidate run already sent (see
/// [`ActivityFile::sent`]), for the last [`RETENTION_HOURS`].
pub async fn list_sent(dir: &Path) -> ActivityResult<HashSet<SentItem>> {
    let _guard = lock(dir).await?;
    let file = load(dir, Utc::now(), current_launch_id()).await?;
    Ok(file.sent.into_iter().map(|s| s.item).collect())
}

/// Records `items` as sent, now. An item already recorded for the same
/// date, source and key is replaced, so only its latest hash is kept.
pub async fn record_sent(dir: &Path, items: Vec<SentItem>) -> ActivityResult<()> {
    if items.is_empty() {
        return Ok(());
    }
    let now = Local::now();
    let sent_at = stamp(now);
    let now = now.with_timezone(&Utc);
    let launch = current_launch_id();
    let _guard = lock(dir).await?;
    let mut file = load(dir, now, launch).await?;
    let same =
        |a: &SentItem, b: &SentItem| a.date == b.date && a.source == b.source && a.key == b.key;
    file.sent
        .retain(|old| !items.iter().any(|new| same(&old.item, new)));
    file.sent.extend(items.into_iter().map(|item| SentRecord {
        item,
        sent_at: sent_at.clone(),
    }));
    save(dir, &mut file, now, launch).await
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
    let _guard = lock(dir).await?;
    let file = load(dir, Utc::now(), current_launch_id()).await?;
    Ok(file
        .terminals
        .into_iter()
        .filter(|t| in_window(t, start, end))
        .collect())
}

/// Records a terminal opening. A record that already exists for this
/// session is left untouched, so a closed record is never reopened. For this
/// process's own launch the launch's pid and start time are stored too, so
/// another Maestro instance keeps the record open while this one runs.
async fn record_opened(
    dir: &Path,
    launch: &str,
    session_id: u32,
    project_path: &str,
    repo_path: &str,
    branch: Option<String>,
    opened_at: DateTime<Local>,
) -> ActivityResult<()> {
    let now = Utc::now();
    let process = if launch == current_launch_id() {
        tokio::task::spawn_blocking(current_launch_process)
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    let _guard = lock(dir).await?;
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
        project_name: project_name_from_path(project_path),
        repo_path: Some(strip_extended_prefix(repo_path)).filter(|p| !p.trim().is_empty()),
        branch,
        opened_at: stamp(opened_at),
        closed_at: None,
    });
    if let Some(process) = process {
        file.launches.insert(launch.to_string(), process);
    }
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
    let _guard = lock(dir).await?;
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
    let _guard = lock(dir).await?;
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
    let _guard = lock(dir).await?;
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

/// The checked-out git branch in `dir`, or `None` outside git or on a
/// detached HEAD.
async fn resolve_branch(dir: &str) -> Option<String> {
    // `symbolic-ref` fails on a detached HEAD, so no commit hash is ever
    // stored as a branch name.
    Git::new(dir)
        .run(&["symbolic-ref", "--short", "HEAD"])
        .await
        .ok()
        .map(|output| output.trimmed().to_string())
        .filter(|b| !b.is_empty())
}

/// The folder a terminal's shell runs in: its working directory (for a
/// multi-repo workspace the selected repo, never a git repo's parent
/// workspace root), else its project path.
fn terminal_repo_path(config: &SessionConfig) -> &str {
    config
        .working_directory
        .as_deref()
        .unwrap_or(&config.project_path)
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
        &config.project_path,
        terminal_repo_path(config),
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
            repo_path: None,
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
        let path = r"\\?\C:\git\maestro";
        record_opened(
            dir.path(),
            LAUNCH,
            7,
            path,
            path,
            Some("feat/x".into()),
            opened,
        )
        .await
        .unwrap();
        record_closed(dir.path(), LAUNCH, 7, None, Local::now())
            .await
            .unwrap();

        let file = read_raw(dir.path());
        assert_eq!(file.terminals.len(), 1);
        let record = &file.terminals[0];
        assert_eq!(record.project_name, "maestro");
        assert_eq!(record.repo_path.as_deref(), Some(r"C:\git\maestro"));
        assert_eq!(record.branch.as_deref(), Some("feat/x"));
        assert_eq!(record.opened_at, stamp(opened));
        assert!(record.closed_at.is_some());
    }

    #[tokio::test]
    async fn test_a_multi_repo_terminal_records_the_repo_it_ran_in() {
        let dir = tempdir().unwrap();
        let config = SessionConfig {
            id: 4,
            mode: crate::core::session_manager::AiMode::Claude,
            name: None,
            branch: Some("main".into()),
            worktree_path: None,
            project_path: r"\\?\C:\ws".into(),
            working_directory: Some(r"\\?\C:\ws\api".into()),
        };
        record_opened(
            dir.path(),
            LAUNCH,
            config.id,
            &config.project_path,
            terminal_repo_path(&config),
            config.branch.clone(),
            Local::now(),
        )
        .await
        .unwrap();

        let record = &read_raw(dir.path()).terminals[0];
        assert_eq!(record.project_name, "ws", "the name stays the workspace's");
        assert_eq!(record.repo_path.as_deref(), Some(r"C:\ws\api"));
        let single_repo = SessionConfig {
            working_directory: None,
            ..config
        };
        assert_eq!(terminal_repo_path(&single_repo), r"\\?\C:\ws");
    }

    #[test]
    fn test_an_old_terminal_record_without_a_repo_path_still_parses() {
        let record: TerminalRecord = serde_json::from_value(serde_json::json!({
            "id": "t1",
            "launchId": "l1",
            "sessionId": 2,
            "projectName": "maestro",
            "openedAt": "2026-10-15T09:00:00+01:00"
        }))
        .unwrap();
        assert_eq!(record.repo_path, None);
        assert_eq!(record.project_name, "maestro");
    }

    #[tokio::test]
    async fn test_close_uses_registry_branch_and_keeps_the_name() {
        let dir = tempdir().unwrap();
        record_opened(
            dir.path(),
            LAUNCH,
            1,
            "p",
            "p",
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
        record_opened(dir.path(), LAUNCH, 3, "proj", "proj", None, Local::now())
            .await
            .unwrap();
        record_all_closed(dir.path(), LAUNCH, Local::now())
            .await
            .unwrap();
        // git answers late; the late open must not reopen the record.
        record_branch(dir.path(), LAUNCH, 3, "main".into())
            .await
            .unwrap();
        record_opened(dir.path(), LAUNCH, 3, "proj", "proj", None, Local::now())
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
        record_opened(dir.path(), "old", 1, "a", "a", None, Local::now())
            .await
            .unwrap();
        record_opened(dir.path(), LAUNCH, 1, "b", "b", None, Local::now())
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
                launches: BTreeMap::new(),
                sent: Vec::new(),
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
                launches: BTreeMap::new(),
                sent: Vec::new(),
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
                launches: BTreeMap::new(),
                sent: Vec::new(),
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
    fn test_two_instances_writing_at_once_lose_nothing() {
        // Each thread stands in for another Maestro instance: its own
        // runtime and only the cross-process lock (an instance's in-process
        // lock does not reach the other instance).
        const WRITES: usize = 20;
        let dir = tempdir().unwrap();
        let writers: Vec<_> = ["a", "b"]
            .into_iter()
            .map(|name| {
                let dir = dir.path().to_path_buf();
                std::thread::spawn(move || {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .unwrap();
                    runtime.block_on(async {
                        for i in 0..WRITES {
                            let _lock = lock_cross_process(&dir).await.unwrap();
                            let now = Utc::now();
                            let mut file = load(&dir, now, LAUNCH).await.unwrap();
                            tokio::task::yield_now().await;
                            let id = format!("{name}-{i}");
                            file.candidates
                                .push(candidate_created(&id, &stamp(Local::now())));
                            save(&dir, &mut file, now, LAUNCH).await.unwrap();
                        }
                    });
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let file = read_raw(dir.path());
        assert_eq!(file.candidates.len(), 2 * WRITES, "no write was lost");
    }

    #[tokio::test]
    async fn test_load_keeps_records_of_a_running_launch_open_and_closes_dead_ones() {
        let dir = tempdir().unwrap();
        let me = current_launch_process().expect("this process's start time");
        let launches = BTreeMap::from([
            // Another instance that is still running (this test process).
            ("running".to_string(), me),
            // The pid was reused by a later process: a different start time.
            (
                "reused".to_string(),
                LaunchProcess {
                    pid: me.pid,
                    start_time: me.start_time - 1000,
                },
            ),
            // No such process (Windows pids are multiples of 4).
            (
                "gone".to_string(),
                LaunchProcess {
                    pid: 4_294_967_294,
                    start_time: me.start_time,
                },
            ),
        ]);
        write_raw(
            dir.path(),
            &ActivityFile {
                candidates: vec![],
                terminals: vec![
                    // Open for 30 hours in a running instance: kept, not pruned.
                    terminal("running", 1, &hours_ago(30), None),
                    // Open for 8 days: past the privacy ceiling, dropped.
                    terminal("running", 5, &hours_ago(8 * 24), None),
                    terminal("reused", 2, &hours_ago(3), None),
                    terminal("gone", 3, &hours_ago(3), None),
                    // Written before launches were stored: closed as before.
                    terminal("old-format", 4, &hours_ago(3), None),
                ],
                launches: launches.clone(),
                sent: Vec::new(),
            },
        );
        let _guard = FILE_LOCK.lock().await;
        load(dir.path(), Utc::now(), LAUNCH).await.unwrap();

        let file = read_raw(dir.path());
        let closed = |id: u32| {
            file.terminals
                .iter()
                .find(|t| t.session_id == id)
                .unwrap()
                .closed_at
                .is_some()
        };
        assert!(!closed(1), "the running instance's terminal stays open");
        assert!(closed(2), "a reused pid is not the same launch");
        assert!(closed(3), "a launch whose process is gone is closed");
        assert!(closed(4), "an old record without a process is closed");
        assert!(
            !file.terminals.iter().any(|t| t.session_id == 5),
            "an open record older than the ceiling is dropped"
        );
        assert_eq!(file.launches, launches, "launch entries are kept");
    }

    #[test]
    fn test_waiting_for_the_lock_times_out_while_another_handle_holds_it() {
        let dir = tempdir().unwrap();
        let wait = std::time::Duration::from_millis(200);
        let holder = CrossProcessLock::acquire(dir.path(), wait).unwrap();
        let started = std::time::Instant::now();
        match CrossProcessLock::acquire(dir.path(), wait) {
            Err(ActivityError::Lock { source, .. }) => {
                assert_eq!(source.kind(), std::io::ErrorKind::TimedOut)
            }
            other => panic!("expected a lock timeout, got {:?}", other.map(|_| ())),
        }
        assert!(started.elapsed() >= wait, "it waited before giving up");
        drop(holder);
        assert!(
            CrossProcessLock::acquire(dir.path(), wait).is_ok(),
            "free again once the holder lets go"
        );
    }

    #[tokio::test]
    async fn test_a_launch_seen_running_then_gone_closes_at_its_last_seen_time() {
        // A real process stands in for another running Maestro.
        let mut child = if cfg!(windows) {
            let mut ping = std::process::Command::new("ping");
            ping.args(["-n", "60", "127.0.0.1"]);
            ping
        } else {
            let mut sleep = std::process::Command::new("sleep");
            sleep.arg("60");
            sleep
        }
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
        let pid = child.id();
        let start_time = start_times(&[pid])[&pid];
        let other = LaunchProcess { pid, start_time };

        let dir = tempdir().unwrap();
        write_raw(
            dir.path(),
            &ActivityFile {
                candidates: vec![],
                terminals: vec![terminal("other", 1, &hours_ago(6), None)],
                launches: BTreeMap::from([("other".to_string(), other)]),
                sent: Vec::new(),
            },
        );
        // This launch first saw the file 5 hours ago: the old fallback end.
        set_mtime(dir.path(), Local::now() - Duration::hours(5));
        let _guard = FILE_LOCK.lock().await;
        let seen_at = Utc::now();
        load(dir.path(), seen_at, LAUNCH).await.unwrap();
        assert!(read_raw(dir.path()).terminals[0].closed_at.is_none());

        child.kill().unwrap();
        child.wait().unwrap();
        load(dir.path(), Utc::now(), LAUNCH).await.unwrap();
        let record = &read_raw(dir.path()).terminals[0];
        let closed = parse_stamp(record.closed_at.as_deref().unwrap()).unwrap();
        // Stamps keep whole seconds, so allow the truncated fraction.
        assert!(
            closed >= seen_at - Duration::seconds(1),
            "closed at {closed}, last seen running at {seen_at}"
        );
    }

    #[tokio::test]
    async fn test_opening_a_terminal_stores_this_launch_process_only() {
        let dir = tempdir().unwrap();
        let mine = current_launch_id();
        record_opened(dir.path(), mine, 1, "p", "p", None, Local::now())
            .await
            .unwrap();
        record_opened(dir.path(), LAUNCH, 2, "p", "p", None, Local::now())
            .await
            .unwrap();
        let file = read_raw(dir.path());
        assert_eq!(
            file.launches,
            BTreeMap::from([(mine.to_string(), current_launch_process().unwrap())])
        );

        // A launch entry goes with the last record that refers to it.
        let mut file = file;
        file.terminals.retain(|t| t.launch_id != mine);
        assert!(prune(&mut file, Utc::now(), LAUNCH));
        assert!(file.launches.is_empty());
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
            launches: BTreeMap::new(),
            sent: Vec::new(),
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
                launches: BTreeMap::new(),
                sent: Vec::new(),
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
                launches: BTreeMap::new(),
                sent: Vec::new(),
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
            launches: BTreeMap::new(),
            sent: Vec::new(),
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
                launches: BTreeMap::new(),
                sent: Vec::new(),
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

    fn sent_item(date: &str, key: &str, hash: &str) -> SentItem {
        SentItem {
            date: date.to_string(),
            source: CandidateSource::Terminal,
            key: key.to_string(),
            hash: hash.to_string(),
        }
    }

    #[tokio::test]
    async fn test_record_sent_lists_items_and_keeps_only_the_latest_hash() {
        let dir = tempdir().unwrap();
        record_sent(
            dir.path(),
            vec![
                sent_item("2026-10-15", "t-1", "aaaa"),
                sent_item("2026-10-16", "t-1", "aaaa"),
            ],
        )
        .await
        .unwrap();
        record_sent(dir.path(), vec![sent_item("2026-10-15", "t-1", "bbbb")])
            .await
            .unwrap();
        let sent = list_sent(dir.path()).await.unwrap();
        assert_eq!(
            sent,
            HashSet::from([
                sent_item("2026-10-15", "t-1", "bbbb"),
                sent_item("2026-10-16", "t-1", "aaaa"),
            ])
        );
        // Stored flat, next to the time it was sent.
        let raw = std::fs::read_to_string(file_path(dir.path())).unwrap();
        assert!(raw.contains("\"sentAt\""), "{raw}");
    }

    #[tokio::test]
    async fn test_sent_items_are_pruned_after_a_day() {
        let dir = tempdir().unwrap();
        let record = |key: &str, sent_at: &str| SentRecord {
            item: sent_item("2026-10-15", key, "aaaa"),
            sent_at: sent_at.to_string(),
        };
        write_raw(
            dir.path(),
            &ActivityFile {
                sent: vec![
                    record("old", &hours_ago(25)),
                    record("fresh", &hours_ago(23)),
                    record("damaged", "not a time"),
                ],
                ..ActivityFile::default()
            },
        );
        let sent = list_sent(dir.path()).await.unwrap();
        assert_eq!(
            sent,
            HashSet::from([sent_item("2026-10-15", "fresh", "aaaa")])
        );
        assert_eq!(read_raw(dir.path()).sent.len(), 1, "pruned on disk too");
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

    #[test]
    fn test_cap_keeps_200_chars_and_cuts_201_at_a_word_with_an_ellipsis() {
        let exact = "a".repeat(MAX_CANDIDATE_CHARS);
        assert_eq!(
            cap_candidate_text(&exact, CandidateSource::Git),
            Some(exact.clone())
        );
        assert_eq!(
            cap_candidate_text(&exact, CandidateSource::Granola),
            Some(exact.clone())
        );
        let long = format!("{} tail", "word ".repeat(40));
        let capped = cap_candidate_text(&long, CandidateSource::Git).unwrap();
        assert!(capped.chars().count() <= MAX_CANDIDATE_CHARS);
        assert!(capped.ends_with("word\u{2026}"), "cut at a word: {capped}");
        let one_word = "x".repeat(MAX_CANDIDATE_CHARS + 1);
        let capped = cap_candidate_text(&one_word, CandidateSource::Claude).unwrap();
        assert_eq!(capped.chars().count(), MAX_CANDIDATE_CHARS);
        assert!(capped.ends_with('\u{2026}'));
    }

    #[test]
    fn test_cap_cuts_mid_word_when_the_last_space_is_in_the_first_half() {
        let long = format!("Fixed https://example.com/{}", "a".repeat(250));
        let capped = cap_candidate_text(&long, CandidateSource::Git).unwrap();
        assert_eq!(capped.chars().count(), MAX_CANDIDATE_CHARS);
        assert!(capped.starts_with("Fixed https://example.com/aaa"));
        assert!(capped.ends_with("a\u{2026}"));
    }

    #[test]
    fn test_cap_keeps_a_whole_last_word_when_char_200_is_a_space() {
        let long = format!("{} {} tail", "x".repeat(99), "y".repeat(99));
        assert_eq!(long.chars().nth(MAX_CANDIDATE_CHARS - 1), Some(' '));
        let capped = cap_candidate_text(&long, CandidateSource::Git).unwrap();
        assert_eq!(
            capped,
            format!("{} {}\u{2026}", "x".repeat(99), "y".repeat(99))
        );
        assert_eq!(capped.chars().count(), MAX_CANDIDATE_CHARS);
    }

    #[test]
    fn test_cap_counts_characters_not_bytes_and_never_splits_one() {
        let exact = "é".repeat(MAX_CANDIDATE_CHARS);
        assert!(
            exact.len() > MAX_CANDIDATE_CHARS,
            "more bytes than characters"
        );
        assert_eq!(
            cap_candidate_text(&exact, CandidateSource::Git),
            Some(exact.clone())
        );
        let long = "日本語 ".repeat(60);
        let capped = cap_candidate_text(&long, CandidateSource::Git).unwrap();
        assert!(capped.chars().count() <= MAX_CANDIDATE_CHARS);
        assert!(capped.ends_with("日本語\u{2026}"), "{capped}");
    }

    #[test]
    fn test_cap_drops_an_over_long_granola_line() {
        let long = "Meeting - ".to_string() + &"note ".repeat(50);
        assert_eq!(cap_candidate_text(&long, CandidateSource::Granola), None);
    }

    #[tokio::test]
    async fn test_storage_guard_caps_text_and_refuses_a_long_meeting() {
        let dir = tempdir().unwrap();
        let long = "word ".repeat(60);
        let added = add_candidates(dir.path(), vec![new_candidate("2026-10-15", None, &long)])
            .await
            .unwrap();
        assert!(added[0].text.chars().count() <= MAX_CANDIDATE_CHARS);
        assert!(added[0].text.ends_with('\u{2026}'));
        let stored = list_candidates(dir.path(), "2026-10-15").await.unwrap();
        assert_eq!(
            stored[0].text, added[0].text,
            "the capped text is what is stored"
        );

        let mut meeting = new_candidate("2026-10-15", None, &long);
        meeting.source = CandidateSource::Granola;
        assert!(matches!(
            validate_candidate(&meeting),
            Err(ActivityError::MeetingTextTooLong)
        ));
        assert!(add_candidates(dir.path(), vec![meeting]).await.is_err());
        let stored = list_candidates(dir.path(), "2026-10-15").await.unwrap();
        assert_eq!(stored.len(), 1, "the long meeting never reached the file");
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
    async fn test_pending_counts_count_pending_candidates_per_date() {
        let dir = tempdir().unwrap();
        let added = add_candidates(
            dir.path(),
            vec![
                new_candidate("2026-10-14", Some("09:00"), "a"),
                new_candidate("2026-10-14", Some("10:00"), "b"),
                new_candidate("2026-10-15", Some("11:00"), "c"),
                new_candidate("2026-10-15", Some("12:00"), "rejected"),
            ],
        )
        .await
        .unwrap();
        set_candidate_state(dir.path(), &added[3].id, CandidateState::Rejected)
            .await
            .unwrap();
        let counts = pending_counts(dir.path()).await.unwrap();
        assert_eq!(counts.len(), 2);
        assert_eq!(counts["2026-10-14"], 2);
        assert_eq!(counts["2026-10-15"], 1);
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
    async fn test_remove_candidate_drops_only_that_one_and_returns_it() {
        let dir = tempdir().unwrap();
        let added = add_candidates(
            dir.path(),
            vec![
                new_candidate("2026-10-15", Some("09:00"), "keep"),
                new_candidate("2026-10-15", Some("10:00"), "accept me"),
            ],
        )
        .await
        .unwrap();
        let removed = remove_candidate(dir.path(), &added[1].id).await.unwrap();
        assert_eq!(removed, added[1]);
        let listed = list_candidates(dir.path(), "2026-10-15").await.unwrap();
        assert_eq!(listed, vec![added[0].clone()]);
        assert_eq!(read_raw(dir.path()).candidates, vec![added[0].clone()]);
    }

    #[tokio::test]
    async fn test_remove_candidate_errors_on_unknown_id_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let added = add_candidates(dir.path(), vec![new_candidate("2026-10-15", None, "x")])
            .await
            .unwrap();
        let before = std::fs::read_to_string(file_path(dir.path())).unwrap();
        assert!(matches!(
            remove_candidate(dir.path(), "nope").await,
            Err(ActivityError::CandidateNotFound(_))
        ));
        assert_eq!(
            std::fs::read_to_string(file_path(dir.path())).unwrap(),
            before
        );
        // Removing twice: the second is unknown.
        remove_candidate(dir.path(), &added[0].id).await.unwrap();
        assert!(matches!(
            remove_candidate(dir.path(), &added[0].id).await,
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
                launches: BTreeMap::new(),
                sent: Vec::new(),
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

    fn write_damaged(dir: &Path, modified: DateTime<Local>) -> PathBuf {
        let damaged = dir.join(DAMAGED_FILE);
        std::fs::write(&damaged, "raw activity").unwrap();
        let file = std::fs::File::options().write(true).open(&damaged).unwrap();
        file.set_modified(modified.into()).unwrap();
        damaged
    }

    #[tokio::test]
    async fn test_load_deletes_a_damaged_copy_older_than_a_day() {
        let dir = tempdir().unwrap();
        let damaged = write_damaged(dir.path(), Local::now() - Duration::hours(25));
        let _guard = FILE_LOCK.lock().await;
        load(dir.path(), Utc::now(), LAUNCH).await.unwrap();
        assert!(!damaged.exists(), "a day-old damaged copy is deleted");
    }

    #[tokio::test]
    async fn test_load_keeps_a_fresh_damaged_copy() {
        let dir = tempdir().unwrap();
        let damaged = write_damaged(dir.path(), Local::now() - Duration::hours(23));
        let _guard = FILE_LOCK.lock().await;
        load(dir.path(), Utc::now(), LAUNCH).await.unwrap();
        assert_eq!(std::fs::read_to_string(&damaged).unwrap(), "raw activity");

        // The same file is deleted once "now" is more than a day past it.
        load(dir.path(), Utc::now() + Duration::hours(2), LAUNCH)
            .await
            .unwrap();
        assert!(!damaged.exists());
    }

    #[tokio::test]
    async fn test_a_copy_set_aside_from_an_old_file_survives_one_load_then_goes() {
        let dir = tempdir().unwrap();
        std::fs::write(file_path(dir.path()), "{ not json").unwrap();
        set_mtime(dir.path(), Local::now() - Duration::hours(30));
        let damaged = dir.path().join(DAMAGED_FILE);
        let _guard = FILE_LOCK.lock().await;

        // Cleanup runs before the read, so the copy set aside now survives this load.
        load(dir.path(), Utc::now(), LAUNCH).await.unwrap();
        assert_eq!(std::fs::read_to_string(&damaged).unwrap(), "{ not json");

        // The rename kept the original's old modified time, so the next load deletes it.
        load(dir.path(), Utc::now(), LAUNCH).await.unwrap();
        assert!(!damaged.exists());
    }

    #[tokio::test]
    async fn test_load_without_a_damaged_copy_is_fine() {
        let dir = tempdir().unwrap();
        let _guard = FILE_LOCK.lock().await;
        let file = load(dir.path(), Utc::now(), LAUNCH).await.unwrap();
        assert!(file.candidates.is_empty() && file.terminals.is_empty());
        assert!(!dir.path().join(DAMAGED_FILE).exists());
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

        git(&repo, &["checkout", "-q", "--detach"]);
        let branch = resolve_branch(&repo.to_string_lossy()).await;
        assert_eq!(branch, None, "a detached HEAD has no branch name");
    }

    #[tokio::test]
    async fn test_resolve_branch_outside_git_is_none() {
        let root = tempdir().unwrap();
        assert_eq!(resolve_branch(&root.path().to_string_lossy()).await, None);
    }
}
