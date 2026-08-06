//! Watches Claude Code transcript JSONL files for new content and feeds
//! parsed events into the [`EventBus`].
//!
//! Each session gets a dedicated tokio task that reads new lines incrementally,
//! parses them via
//! [`parse_transcript_line`](super::transcript_parser::parse_transcript_line),
//! and emits the resulting [`ClaudeEvent`]s. The [`notify`] filesystem watch
//! that wakes those tasks is shared: one per transcript *directory*, however
//! many sessions tail files inside it.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use notify::{Event as NotifyEvent, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::claude_event::ClaudeEvent;
use super::event_bus::EventBus;
use super::transcript_parser::parse_transcript_line;

/// Upper bound on concurrently watched sessions. Each one costs a tokio task
/// (and, for the first session in a directory, an OS file-watch handle), so an
/// unbounded count is a resource-exhaustion vector when watch requests can be
/// triggered by an unauthenticated caller. Far above any realistic number of
/// live Claude sessions.
const MAX_WATCHED_SESSIONS: usize = 256;

/// Sessions listening to one directory: transcript file -> the sessions tailing
/// it. Shared with that directory's `notify` callback, its only other holder.
type Subscribers = Arc<Mutex<HashMap<PathBuf, HashMap<u32, mpsc::Sender<()>>>>>;

/// One OS-level watch on one directory, feeding every session that tails a
/// transcript inside it.
struct DirWatcher {
    _watcher: RecommendedWatcher,
    subscribers: Subscribers,
}

/// Manages filesystem watchers for Claude Code transcript JSONL files.
///
/// Each watched session gets a tokio task that reads new lines as they are
/// appended. The `notify` watch that wakes it is held per directory, not per
/// session.
pub struct TranscriptWatcher {
    watchers: DashMap<u32, WatcherState>,
    /// One watch per transcript DIRECTORY. Claude Code keeps every conversation
    /// for a given cwd in one directory, so N Maestro terminals on the same
    /// project all watch the same one — which used to mean N OS watch handles
    /// and N watcher threads on it, each handed every write only for N-1 of
    /// them to discard it.
    dir_watchers: Mutex<HashMap<PathBuf, DirWatcher>>,
    event_bus: Arc<EventBus>,
}

struct WatcherState {
    task_handle: JoinHandle<()>,
    /// The transcript file this watcher tails — compared on re-registration
    /// so a session that mints a NEW transcript (e.g. `/clear`, or exiting and
    /// relaunching `claude` in the same terminal) replaces the stale watcher
    /// instead of being ignored. Also names the directory to unsubscribe from
    /// when the session stops.
    transcript_path: PathBuf,
}

/// The directory whose watch covers `transcript_path`. The parent is watched
/// rather than the file itself so file *creation* is caught too.
fn watch_dir_of(transcript_path: &Path) -> PathBuf {
    transcript_path
        .parent()
        .unwrap_or(transcript_path)
        .to_path_buf()
}

impl TranscriptWatcher {
    /// Create a new `TranscriptWatcher` that will emit parsed events to `event_bus`.
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self {
            watchers: DashMap::new(),
            dir_watchers: Mutex::new(HashMap::new()),
            event_bus,
        }
    }

    /// Register `session_id`'s wake-up channel against the watch on `dir`,
    /// creating that watch if this is the directory's first session.
    ///
    /// Returns `false` only when the OS refuses a new watcher, which is the one
    /// case where the caller must give up on watching this session.
    fn subscribe(
        &self,
        dir: &Path,
        session_id: u32,
        transcript_path: &Path,
        tx: mpsc::Sender<()>,
    ) -> bool {
        let mut dirs = self.dir_watchers.lock().unwrap_or_else(|e| e.into_inner());

        if let Some(existing) = dirs.get(dir) {
            existing
                .subscribers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry(transcript_path.to_path_buf())
                .or_default()
                .insert(session_id, tx);
            return true;
        }

        let subscribers: Subscribers = Arc::new(Mutex::new(HashMap::new()));
        subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(transcript_path.to_path_buf())
            .or_default()
            .insert(session_id, tx);

        let callback_subscribers = Arc::clone(&subscribers);
        let watcher_result =
            notify::recommended_watcher(move |res: Result<NotifyEvent, notify::Error>| {
                match res {
                    Ok(event) => {
                        // Collect under the lock, wake after releasing it: one
                        // thread now serves every session in this directory, so
                        // it must not sit on the lock while it wakes them.
                        let targets: Vec<mpsc::Sender<()>> = {
                            let subs = callback_subscribers
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            event
                                .paths
                                .iter()
                                .filter_map(|p| subs.get(p))
                                .flat_map(|sessions| sessions.values().cloned())
                                .collect()
                        };
                        for tx in targets {
                            // A full channel already holds unread wake-ups and
                            // the reader always reads to EOF, so a dropped
                            // signal loses nothing — whereas blocking here
                            // would stall every other session in this
                            // directory behind one slow reader.
                            let _ = tx.try_send(());
                        }
                    }
                    Err(e) => {
                        log::error!("TranscriptWatcher: notify error: {e}");
                    }
                }
            });

        // Don't panic if the OS refuses another watcher (e.g. inotify limit);
        // just skip watching this session so a flood of requests can't crash
        // the process.
        let mut watcher = match watcher_result {
            Ok(w) => w,
            Err(e) => {
                log::error!("TranscriptWatcher: failed to create filesystem watcher: {e}");
                return false;
            }
        };

        // Bail without caching if the watch itself fails. Caching a dead
        // DirWatcher would make every later session in this directory join a
        // watch that delivers nothing — their activity feed and agent graph
        // would stay empty until the last subscriber left. Returning false
        // contains the failure to this attempt, so the next session in this
        // directory creates a fresh watcher rather than inheriting a dead one.
        // This session is not itself retried until the next SessionStarted.
        if let Err(e) = watcher.watch(dir, RecursiveMode::NonRecursive) {
            log::error!(
                "TranscriptWatcher: failed to watch directory {}: {e}",
                dir.display()
            );
            return false;
        }

        dirs.insert(
            dir.to_path_buf(),
            DirWatcher {
                _watcher: watcher,
                subscribers,
            },
        );
        true
    }

    /// Drop `session_id`'s registration, and the directory's watch along with
    /// it once no session is left listening there.
    fn unsubscribe(&self, session_id: u32, transcript_path: &Path) {
        let dir = watch_dir_of(transcript_path);
        let mut dirs = self.dir_watchers.lock().unwrap_or_else(|e| e.into_inner());

        let dir_is_idle = match dirs.get(&dir) {
            Some(existing) => {
                let mut subs = existing
                    .subscribers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                if let Some(sessions) = subs.get_mut(transcript_path) {
                    sessions.remove(&session_id);
                    if sessions.is_empty() {
                        subs.remove(transcript_path);
                    }
                }
                subs.is_empty()
            }
            None => false,
        };

        // Dropping the entry drops the RecommendedWatcher, releasing the OS
        // handle. The next session opened here recreates it.
        if dir_is_idle {
            dirs.remove(&dir);
        }
    }

    /// Start watching a transcript JSONL file for a given session.
    ///
    /// Reads any existing content first (catch-up), then watches for new
    /// writes using `notify`. Re-registering the same session with the same
    /// path is a no-op; re-registering with a DIFFERENT path (Claude Code
    /// minted a new transcript for this terminal — `/clear`, or exit + rerun
    /// `claude`) replaces the stale watcher so the activity feed keeps
    /// working.
    pub fn start_watching(&self, session_id: u32, transcript_path: PathBuf) {
        // Clone the stored path out so the DashMap read guard is released
        // before stop_watching removes the entry (same-key remove while
        // holding a Ref would deadlock).
        let existing_path = self
            .watchers
            .get(&session_id)
            .map(|state| state.transcript_path.clone());
        if let Some(old_path) = existing_path {
            if old_path == transcript_path {
                log::debug!(
                    "TranscriptWatcher: session {session_id} already watching this transcript, ignoring"
                );
                return;
            }
            log::info!(
                "TranscriptWatcher: session {session_id} switched transcript ({} -> {}), replacing watcher",
                old_path.display(),
                transcript_path.display()
            );
            self.stop_watching(session_id);
        }

        if self.watchers.len() >= MAX_WATCHED_SESSIONS {
            log::warn!(
                "TranscriptWatcher: refusing to watch session {session_id}; \
                 at capacity ({MAX_WATCHED_SESSIONS} sessions)"
            );
            return;
        }

        let (tx, rx) = mpsc::channel::<()>(64);

        // Join the watch on this transcript's directory, creating it if this is
        // the first session to tail a file there.
        let watch_dir = watch_dir_of(&transcript_path);
        if !self.subscribe(&watch_dir, session_id, &transcript_path, tx.clone()) {
            return;
        }

        // Spawn a tokio task that reads new lines whenever notified.
        let event_bus = Arc::clone(&self.event_bus);
        let path = transcript_path.clone();
        let task_handle = tokio::spawn(async move {
            reader_task(session_id, path, rx, event_bus).await;
        });

        self.watchers.insert(
            session_id,
            WatcherState {
                task_handle,
                transcript_path: transcript_path.clone(),
            },
        );

        // Send an initial signal so the task does a catch-up read of any
        // existing content.
        let _ = tx.try_send(());

        log::info!(
            "TranscriptWatcher: started watching session {session_id} at {}",
            transcript_path.display()
        );
    }

    /// Stop watching a session's transcript file and clean up resources.
    pub fn stop_watching(&self, session_id: u32) {
        if let Some((_, state)) = self.watchers.remove(&session_id) {
            state.task_handle.abort();
            self.unsubscribe(session_id, &state.transcript_path);
            log::info!("TranscriptWatcher: stopped watching session {session_id}");
        }
    }

    /// The transcript file `session_id` is currently tailing, if any. Used by
    /// the Samurai watchdog for its transcript-staleness (mtime) check.
    pub fn transcript_path(&self, session_id: u32) -> Option<PathBuf> {
        self.watchers
            .get(&session_id)
            .map(|state| state.transcript_path.clone())
    }

    /// Return the list of session IDs currently being watched.
    pub fn watched_sessions(&self) -> Vec<u32> {
        self.watchers.iter().map(|entry| *entry.key()).collect()
    }
}

impl Drop for TranscriptWatcher {
    fn drop(&mut self) {
        for entry in self.watchers.iter() {
            entry.value().task_handle.abort();
        }
    }
}

// ---------------------------------------------------------------------------
// Internal: reader task
// ---------------------------------------------------------------------------

/// Long-running task that drains filesystem notifications and reads new lines.
async fn reader_task(
    session_id: u32,
    path: PathBuf,
    mut rx: mpsc::Receiver<()>,
    event_bus: Arc<EventBus>,
) {
    let mut byte_offset: u64 = 0;
    // tool_use ids of Task invocations whose result hasn't been seen yet;
    // lets us turn a generic tool_result into a SubagentCompleted event.
    let mut pending_task_ids: HashSet<String> = HashSet::new();
    // Subset of the above that Claude launched in the background: their
    // tool_result already came back with "async_launched", so the generic
    // completion must not be mistaken for the agent finishing.
    let mut async_task_ids: HashSet<String> = HashSet::new();
    // Agents whose completion already went out: a resumed background agent
    // can notify again under the same id with a fresh report, and that
    // repeat must reach the bus too (the store updates it in place).
    let mut completed_task_ids: HashSet<String> = HashSet::new();

    while rx.recv().await.is_some() {
        // Coalesce rapid notifications: drain any buffered signals so we
        // only read once per burst.
        while rx.try_recv().is_ok() {}

        // The read pass is synchronous file I/O + JSON parsing; the initial
        // catch-up can chew through a transcript of tens of MB. Run it on the
        // blocking pool so N sessions catching up at once can't starve the
        // async runtime (frozen terminals, hung commands) — and so abort()
        // can take effect between passes.
        let path_for_read = path.clone();
        let bus = event_bus.clone();
        let mut pending = std::mem::take(&mut pending_task_ids);
        let mut asyncs = std::mem::take(&mut async_task_ids);
        let mut completed = std::mem::take(&mut completed_task_ids);
        let read_result = tokio::task::spawn_blocking(move || {
            let offset = read_new_lines(
                session_id,
                &path_for_read,
                byte_offset,
                &bus,
                &mut pending,
                &mut asyncs,
                &mut completed,
            );
            (offset, pending, asyncs, completed)
        })
        .await;
        match read_result {
            Ok((offset, pending, asyncs, completed)) => {
                byte_offset = offset;
                pending_task_ids = pending;
                async_task_ids = asyncs;
                completed_task_ids = completed;
            }
            Err(e) => {
                log::error!("TranscriptWatcher: read pass for session {session_id} failed: {e}");
            }
        }
    }

    log::debug!("TranscriptWatcher: reader task for session {session_id} exiting");
}

// ---------------------------------------------------------------------------
// Internal: incremental line reader
// ---------------------------------------------------------------------------

/// Read new lines from `path` starting at `byte_offset`, parse each one, and
/// emit the resulting events on `event_bus`.
///
/// `pending_task_ids` carries the Task tool_use ids spawned earlier in this
/// transcript. A `ToolUseCompleted` whose id matches becomes a
/// `SubagentCompleted`; all other `ToolUseCompleted` events are dropped here —
/// the parser emits one per tool_result of every tool, and putting those on
/// the bus would crowd real activity out of the frontend's capped event feed.
/// `async_task_ids` holds the background agents among them, whose tool_result
/// says only "launched", so their generic completion is skipped and the real one
/// comes from the task notification the parser turns into `SubagentCompleted`.
///
/// Returns the updated byte offset (pointing just past the last byte read).
/// If the file does not exist, returns the same `byte_offset` without error.
fn read_new_lines(
    session_id: u32,
    path: &PathBuf,
    byte_offset: u64,
    event_bus: &EventBus,
    pending_task_ids: &mut HashSet<String>,
    async_task_ids: &mut HashSet<String>,
    completed_task_ids: &mut HashSet<String>,
) -> u64 {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::error!(
                    "TranscriptWatcher: failed to open {}: {e}",
                    path.display()
                );
            }
            return byte_offset;
        }
    };

    let mut reader = BufReader::new(file);

    if byte_offset > 0 {
        if let Err(e) = reader.seek(SeekFrom::Start(byte_offset)) {
            log::error!("TranscriptWatcher: seek error: {e}");
            return byte_offset;
        }
    }

    let mut current_offset = byte_offset;
    let mut line_buf = String::new();

    loop {
        line_buf.clear();
        match reader.read_line(&mut line_buf) {
            Ok(0) => break, // EOF
            Ok(n) => {
                // A line without a trailing newline is an entry the writer is
                // still appending (notify fires on every modification, so we
                // routinely wake mid-write). Consuming it would advance the
                // offset past a fragment that parses as nothing, silently
                // losing the whole entry's events — leave the offset at the
                // line start and re-read once the writer finishes it.
                if !line_buf.ends_with('\n') {
                    break;
                }
                current_offset += n as u64;
                let trimmed = line_buf.trim();
                if !trimmed.is_empty() {
                    let events = parse_transcript_line(session_id, trimmed);
                    for event in events {
                        match event {
                            ClaudeEvent::SubagentSpawned { ref agent_id, .. } => {
                                pending_task_ids.insert(agent_id.clone());
                                event_bus.emit(event);
                            }
                            // A background agent's tool_result comes back at
                            // once, so the id stays pending: its completion
                            // arrives later as a task notification.
                            ClaudeEvent::SubagentLaunched { ref agent_id, .. } => {
                                if pending_task_ids.contains(agent_id) {
                                    async_task_ids.insert(agent_id.clone());
                                    event_bus.emit(event);
                                }
                            }
                            // The parser already resolved the outcome from the
                            // transcript's own metadata; trust it over the
                            // generic tool_result that follows.
                            ClaudeEvent::SubagentCompleted { ref agent_id, .. } => {
                                if pending_task_ids.remove(agent_id) {
                                    async_task_ids.remove(agent_id);
                                    completed_task_ids.insert(agent_id.clone());
                                    event_bus.emit(event);
                                } else if completed_task_ids.contains(agent_id) {
                                    // Repeat notification from a resumed
                                    // background agent — carries a fresh
                                    // report the store updates in place.
                                    event_bus.emit(event);
                                }
                            }
                            ClaudeEvent::ToolUseCompleted {
                                tool_use_id,
                                success,
                                timestamp,
                                ..
                            } => {
                                // Fallback for results carrying no sub-agent
                                // metadata: a bare completion with no detail.
                                // Skipped for background agents, which are still
                                // running at this point.
                                if !async_task_ids.contains(&tool_use_id)
                                    && pending_task_ids.remove(&tool_use_id)
                                {
                                    event_bus.emit(ClaudeEvent::SubagentCompleted {
                                        session_id,
                                        agent_id: tool_use_id,
                                        success,
                                        report: String::new(),
                                        status: None,
                                        agent_type: None,
                                        model: None,
                                        duration_ms: None,
                                        total_tokens: None,
                                        tool_use_count: None,
                                        tool_stats: None,
                                        agent_run_id: None,
                                        timestamp,
                                    });
                                }
                            }
                            other => event_bus.emit(other),
                        }
                    }
                }
            }
            Err(e) => {
                log::error!("TranscriptWatcher: read error: {e}");
                break;
            }
        }
    }

    current_offset
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    /// Test JSONL line representing a user message.
    const USER_MSG_LINE: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]},"uuid":"u1","timestamp":"2026-02-24T10:00:00Z"}"#;

    /// Create an EventBus that captures emitted events into a shared Vec.
    fn test_event_bus() -> (Arc<EventBus>, Arc<std::sync::Mutex<Vec<ClaudeEvent>>>) {
        let collected = Arc::new(std::sync::Mutex::new(Vec::<ClaudeEvent>::new()));
        let collected_clone = Arc::clone(&collected);
        let bus = EventBus::new(Arc::new(move |event: ClaudeEvent| {
            collected_clone.lock().unwrap().push(event);
        }));
        (Arc::new(bus), collected)
    }

    #[test]
    fn test_read_new_lines_empty_file() {
        let file = NamedTempFile::new().expect("create temp file");
        let path = file.path().to_path_buf();
        let (bus, collected) = test_event_bus();

        let new_offset = read_new_lines(1, &path, 0, &bus, &mut HashSet::new(), &mut HashSet::new(), &mut HashSet::new());

        assert_eq!(new_offset, 0, "empty file should keep offset at 0");
        assert!(
            collected.lock().unwrap().is_empty(),
            "empty file should produce no events"
        );
    }

    #[test]
    fn test_read_new_lines_with_content() {
        let mut file = NamedTempFile::new().expect("create temp file");
        writeln!(file, "{}", USER_MSG_LINE).expect("write line");
        file.flush().expect("flush");

        let path = file.path().to_path_buf();
        let (bus, collected) = test_event_bus();

        let new_offset = read_new_lines(1, &path, 0, &bus, &mut HashSet::new(), &mut HashSet::new(), &mut HashSet::new());

        assert!(new_offset > 0, "offset should advance past the written line");

        let events = collected.lock().unwrap();
        assert_eq!(events.len(), 1, "one JSONL line should produce one event");

        match &events[0] {
            ClaudeEvent::UserMessage {
                session_id,
                uuid,
                text,
                ..
            } => {
                assert_eq!(*session_id, 1);
                assert_eq!(uuid, "u1");
                assert_eq!(text, "hello");
            }
            other => panic!("expected UserMessage, got {other:?}"),
        }
    }

    #[test]
    fn test_read_new_lines_incremental() {
        let mut file = NamedTempFile::new().expect("create temp file");

        // Write first line.
        writeln!(file, "{}", USER_MSG_LINE).expect("write first line");
        file.flush().expect("flush");

        let path = file.path().to_path_buf();
        let (bus, collected) = test_event_bus();
        let mut task_ids = HashSet::new();

        // First read picks up the first line.
        let offset1 = read_new_lines(1, &path, 0, &bus, &mut task_ids, &mut HashSet::new(), &mut HashSet::new());
        assert_eq!(
            collected.lock().unwrap().len(),
            1,
            "first read should yield 1 event"
        );

        // Write a second line (different uuid to avoid dedup).
        let second_line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"world"}]},"uuid":"u2","timestamp":"2026-02-24T10:01:00Z"}"#;
        writeln!(file, "{}", second_line).expect("write second line");
        file.flush().expect("flush");

        // Second read starts from offset1 and should only pick up the new line.
        let offset2 = read_new_lines(1, &path, offset1, &bus, &mut task_ids, &mut HashSet::new(), &mut HashSet::new());
        assert!(
            offset2 > offset1,
            "offset should advance after reading second line"
        );

        let events = collected.lock().unwrap();
        assert_eq!(
            events.len(),
            2,
            "second read should add exactly 1 more event (total 2)"
        );

        // Verify the second event has the right text.
        match &events[1] {
            ClaudeEvent::UserMessage { text, uuid, .. } => {
                assert_eq!(text, "world");
                assert_eq!(uuid, "u2");
            }
            other => panic!("expected UserMessage for second event, got {other:?}"),
        }
    }

    #[test]
    fn test_task_tool_result_becomes_subagent_completed() {
        let mut file = NamedTempFile::new().expect("create temp file");
        // A Task spawn, its tool_result, and an unrelated (Read) tool_result.
        let task_line = r#"{"type":"assistant","message":{"model":"claude-opus-4-6","content":[{"type":"tool_use","id":"toolu_task9","name":"Task","input":{"description":"explore","subagent_type":"Explore"}}],"usage":{"input_tokens":10,"output_tokens":5}},"uuid":"a1","timestamp":"2026-07-13T10:00:00Z"}"#;
        let task_result_line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_task9","content":"done"}]},"uuid":"u1","timestamp":"2026-07-13T10:01:00Z"}"#;
        let read_result_line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_read1","content":"file body"}]},"uuid":"u2","timestamp":"2026-07-13T10:02:00Z"}"#;
        writeln!(file, "{task_line}").unwrap();
        writeln!(file, "{task_result_line}").unwrap();
        writeln!(file, "{read_result_line}").unwrap();
        file.flush().unwrap();

        let (bus, collected) = test_event_bus();
        read_new_lines(7, &file.path().to_path_buf(), 0, &bus, &mut HashSet::new(), &mut HashSet::new(), &mut HashSet::new());

        let events = collected.lock().unwrap();
        // The Task's result surfaces as SubagentCompleted…
        assert!(
            events.iter().any(|e| matches!(
                e,
                ClaudeEvent::SubagentCompleted { agent_id, success: true, .. } if agent_id == "toolu_task9"
            )),
            "Expected SubagentCompleted for toolu_task9, got {:?}",
            *events
        );
        // …and no raw ToolUseCompleted reaches the bus (non-Task results are dropped).
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, ClaudeEvent::ToolUseCompleted { .. })),
            "ToolUseCompleted must not be emitted on the bus, got {:?}",
            *events
        );
    }

    /// A background agent must stay RUNNING between its launch acknowledgement
    /// and its task notification. Emitting a completion off the immediate
    /// `async_launched` result would mark it done the moment it started.
    #[test]
    fn test_background_agent_completes_only_on_notification() {
        let mut file = NamedTempFile::new().expect("create temp file");
        let spawn = r#"{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"tool_use","id":"toolu_bg","name":"Agent","input":{"description":"Summarize docs","prompt":"Read the docs","run_in_background":true}}]},"uuid":"a1","timestamp":"2026-08-03T10:00:00Z"}"#;
        let launched = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_bg","content":"launched"}]},"toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"a11070c","resolvedModel":"claude-opus-4-8[1m]","prompt":"Read the docs"},"uuid":"u1","timestamp":"2026-08-03T10:00:05Z"}"#;
        let notification = r#"{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>a11070c</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<result>All done.</result>\n</task-notification>"},"uuid":"u2","timestamp":"2026-08-03T10:09:18Z"}"#;

        let (bus, collected) = test_event_bus();
        let mut pending = HashSet::new();
        let mut async_ids = HashSet::new();
        let mut completed = HashSet::new();

        // The spawn and the launch ack: still running, no completion yet.
        writeln!(file, "{spawn}").unwrap();
        writeln!(file, "{launched}").unwrap();
        file.flush().unwrap();
        let offset = read_new_lines(
            3,
            &file.path().to_path_buf(),
            0,
            &bus,
            &mut pending,
            &mut async_ids,
            &mut completed,
        );

        {
            let events = collected.lock().unwrap();
            assert!(
                !events
                    .iter()
                    .any(|e| matches!(e, ClaudeEvent::SubagentCompleted { .. })),
                "background agent must not be completed by its launch ack: {:?}",
                *events
            );
            assert!(
                events.iter().any(|e| matches!(
                    e,
                    ClaudeEvent::SubagentLaunched { agent_id, model, .. }
                        if agent_id == "toolu_bg" && model == "claude-opus-4-8[1m]"
                )),
                "expected SubagentLaunched, got {:?}",
                *events
            );
        }
        assert!(
            pending.contains("toolu_bg"),
            "the id stays pending while the agent runs"
        );

        // The notification: now, and only now, it completes — with its report.
        writeln!(file, "{notification}").unwrap();
        file.flush().unwrap();
        read_new_lines(
            3,
            &file.path().to_path_buf(),
            offset,
            &bus,
            &mut pending,
            &mut async_ids,
            &mut completed,
        );

        let events = collected.lock().unwrap();
        let completions: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, ClaudeEvent::SubagentCompleted { .. }))
            .collect();
        assert_eq!(completions.len(), 1, "exactly one completion: {:?}", *events);
        if let ClaudeEvent::SubagentCompleted {
            agent_id,
            report,
            success,
            ..
        } = completions[0]
        {
            assert_eq!(agent_id, "toolu_bg");
            assert_eq!(report, "All done.");
            assert!(*success);
        }
        assert!(pending.is_empty(), "the id is cleared once it completes");
        assert!(async_ids.is_empty());
    }

    /// The rich completion the parser builds from transcript metadata replaces
    /// the bare one the fallback would synthesise — not both.
    #[test]
    fn test_foreground_agent_completes_once_with_detail() {
        let mut file = NamedTempFile::new().expect("create temp file");
        let spawn = r#"{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"tool_use","id":"toolu_fg","name":"Agent","input":{"description":"Review diff","prompt":"Review it","subagent_type":"general-purpose"}}]},"uuid":"a1","timestamp":"2026-08-03T10:00:00Z"}"#;
        let result = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_fg","content":[{"type":"text","text":"3 findings"}]}]},"toolUseResult":{"status":"completed","agentId":"aca8815","agentType":"general-purpose","resolvedModel":"claude-fable-5","content":[{"type":"text","text":"3 findings"}],"totalDurationMs":835000,"totalTokens":198699,"totalToolUseCount":49},"uuid":"u1","timestamp":"2026-08-03T10:14:00Z"}"#;
        writeln!(file, "{spawn}").unwrap();
        writeln!(file, "{result}").unwrap();
        file.flush().unwrap();

        let (bus, collected) = test_event_bus();
        read_new_lines(
            4,
            &file.path().to_path_buf(),
            0,
            &bus,
            &mut HashSet::new(),
            &mut HashSet::new(),
            &mut HashSet::new(),
        );

        let events = collected.lock().unwrap();
        let completions: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, ClaudeEvent::SubagentCompleted { .. }))
            .collect();
        assert_eq!(
            completions.len(),
            1,
            "the detailed completion must not be duplicated by the fallback: {:?}",
            *events
        );
        if let ClaudeEvent::SubagentCompleted {
            report,
            total_tokens,
            model,
            ..
        } = completions[0]
        {
            assert_eq!(report, "3 findings");
            assert_eq!(*total_tokens, Some(198_699));
            assert_eq!(model.as_deref(), Some("claude-fable-5"));
        }
    }

    /// A trailing line without '\n' is an entry still being written: the
    /// reader must leave the offset at the line start and pick the whole
    /// entry up once the writer finishes it — consuming the fragment loses
    /// the entry's events permanently.
    #[test]
    fn test_partial_trailing_line_is_not_consumed() {
        let mut file = NamedTempFile::new().expect("create temp file");
        let (bus, collected) = test_event_bus();
        let path = file.path().to_path_buf();

        // First half of the JSONL entry, no newline: mid-write snapshot.
        let (first_half, second_half) = USER_MSG_LINE.split_at(40);
        write!(file, "{first_half}").unwrap();
        file.flush().unwrap();

        let offset = read_new_lines(1, &path, 0, &bus, &mut HashSet::new(), &mut HashSet::new(), &mut HashSet::new());
        assert_eq!(offset, 0, "offset must stay at the unfinished line's start");
        assert!(collected.lock().unwrap().is_empty(), "no events from a fragment");

        // The writer finishes the line.
        writeln!(file, "{second_half}").unwrap();
        file.flush().unwrap();

        let offset = read_new_lines(1, &path, offset, &bus, &mut HashSet::new(), &mut HashSet::new(), &mut HashSet::new());
        assert!(offset > 0, "offset advances once the line is complete");
        let events = collected.lock().unwrap();
        assert_eq!(events.len(), 1, "the completed line parses exactly once");
        assert!(matches!(&events[0], ClaudeEvent::UserMessage { text, .. } if text == "hello"));
    }

    #[test]
    fn test_read_nonexistent_file() {
        let path = PathBuf::from("/tmp/nonexistent_transcript_test_file_12345.jsonl");
        let (bus, collected) = test_event_bus();

        let new_offset = read_new_lines(1, &path, 0, &bus, &mut HashSet::new(), &mut HashSet::new(), &mut HashSet::new());

        assert_eq!(
            new_offset, 0,
            "nonexistent file should return offset 0"
        );
        assert!(
            collected.lock().unwrap().is_empty(),
            "nonexistent file should produce no events"
        );
    }

    /// Integration test: verifies the full TranscriptWatcher + EventBus flow
    /// end-to-end by writing JSONL transcript data, starting a watcher, and
    /// asserting that events are parsed and emitted through the EventBus.
    #[tokio::test]
    async fn test_full_transcript_watcher_flow() {
        use std::time::Duration;

        // 1. Set up EventBus with event capture
        let (event_bus, captured) = test_event_bus();

        // 2. Create TranscriptWatcher
        let watcher = TranscriptWatcher::new(event_bus);

        // 3. Create a temp directory and transcript file with initial content.
        //    Using tempdir() + explicit file ensures the notify watcher can
        //    reliably detect changes on macOS FSEvents.
        let dir = tempfile::tempdir().unwrap();
        let transcript_path = dir.path().join("transcript.jsonl");
        {
            let line1 = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello world"}]},"uuid":"msg-001","timestamp":"2026-02-24T10:00:00Z"}"#;
            let mut f = std::fs::File::create(&transcript_path).unwrap();
            writeln!(f, "{}", line1).unwrap();
            f.flush().unwrap();
        }

        // 4. Start watching the transcript file.
        //    Canonicalize the path so that on macOS the notify watcher's path
        //    comparison works correctly (/var/folders -> /private/var/folders).
        let canonical_path = transcript_path.canonicalize().unwrap();
        watcher.start_watching(1, canonical_path.clone());

        // 5. Wait for the initial catch-up read to process existing content
        tokio::time::sleep(Duration::from_millis(500)).await;

        // 6. Verify the initial UserMessage was parsed and emitted
        {
            let events = captured.lock().unwrap();
            assert!(
                events.iter().any(|e| matches!(
                    e,
                    ClaudeEvent::UserMessage { text, .. } if text == "hello world"
                )),
                "Expected UserMessage with 'hello world', got {:?}",
                *events
            );
        }

        // 7. Append an assistant message with an Edit tool_use.
        //    Open-append-close to produce a distinct filesystem event.
        {
            let line2 = r#"{"type":"assistant","message":{"model":"claude-opus-4-6","content":[{"type":"tool_use","id":"toolu_001","name":"Edit","input":{"file_path":"/src/main.rs","old_string":"old","new_string":"new"}}],"usage":{"input_tokens":100,"output_tokens":50}},"uuid":"msg-002","timestamp":"2026-02-24T10:00:05Z"}"#;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&canonical_path)
                .unwrap();
            writeln!(f, "{}", line2).unwrap();
            f.flush().unwrap();
        }

        // 8. Poll for the expected event with a generous timeout.
        //    macOS FSEvents can have variable latency, so we poll rather than
        //    doing a single fixed sleep.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let events = captured.lock().unwrap();
            let has_file_edited = events.iter().any(|e| matches!(
                e,
                ClaudeEvent::FileEdited { file_path, .. } if file_path == "/src/main.rs"
            ));
            if has_file_edited {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!(
                    "Timed out waiting for FileEdited event. Got {:?}",
                    *events
                );
            }
        }

        // 9. Verify all expected events were emitted
        {
            let events = captured.lock().unwrap();
            assert!(
                events.iter().any(|e| matches!(
                    e,
                    ClaudeEvent::FileEdited { file_path, .. } if file_path == "/src/main.rs"
                )),
                "Expected FileEdited for /src/main.rs, got {:?}",
                *events
            );
            assert!(
                events.iter().any(|e| matches!(
                    e,
                    ClaudeEvent::ToolUseStarted { tool_name, .. } if tool_name == "Edit"
                )),
                "Expected ToolUseStarted for Edit, got {:?}",
                *events
            );
        }

        // 10. Verify watched sessions tracking
        assert_eq!(watcher.watched_sessions(), vec![1]);

        // 11. Cleanup: stop watching and verify it was removed
        watcher.stop_watching(1);
        assert!(watcher.watched_sessions().is_empty());
    }

    /// Two sessions on one project share a single directory watch, so stopping
    /// one must not take its siblings' notifications down with it — and the
    /// last one leaving must release the watch cleanly rather than leak it.
    #[tokio::test]
    async fn test_sessions_sharing_a_directory_are_independent() {
        use std::time::Duration;

        let (event_bus, captured) = test_event_bus();
        let watcher = TranscriptWatcher::new(event_bus);

        // Both transcripts live in ONE directory, as Claude Code writes them.
        let dir = tempfile::tempdir().unwrap();
        let path_a = dir.path().join("a.jsonl");
        let path_b = dir.path().join("b.jsonl");
        std::fs::write(&path_a, "").unwrap();
        std::fs::write(&path_b, "").unwrap();
        let path_a = path_a.canonicalize().unwrap();
        let path_b = path_b.canonicalize().unwrap();

        watcher.start_watching(1, path_a.clone());
        watcher.start_watching(2, path_b.clone());
        assert_eq!(watcher.dir_watchers.lock().unwrap().len(), 1, "one watch for the directory");

        // Session 1 stops; session 2 must keep receiving.
        watcher.stop_watching(1);
        assert_eq!(
            watcher.dir_watchers.lock().unwrap().len(),
            1,
            "the surviving session keeps the directory watch alive"
        );

        {
            let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"sibling lives"}]},"uuid":"msg-b1","timestamp":"2026-02-24T10:00:00Z"}"#;
            let mut f = std::fs::OpenOptions::new().append(true).open(&path_b).unwrap();
            writeln!(f, "{}", line).unwrap();
            f.flush().unwrap();
        }

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            {
                let events = captured.lock().unwrap();
                if events.iter().any(|e| matches!(
                    e,
                    ClaudeEvent::UserMessage { text, .. } if text == "sibling lives"
                )) {
                    break;
                }
                if tokio::time::Instant::now() >= deadline {
                    panic!(
                        "stopping session 1 killed session 2's notifications. Got {:?}",
                        *events
                    );
                }
            }
        }

        // The last session leaving releases the OS watch…
        watcher.stop_watching(2);
        assert!(
            watcher.dir_watchers.lock().unwrap().is_empty(),
            "the directory watch is dropped once nobody is listening"
        );

        // …and re-adding a session recreates it rather than watching nothing.
        watcher.start_watching(3, path_a);
        assert_eq!(watcher.dir_watchers.lock().unwrap().len(), 1);
        watcher.stop_watching(3);
    }

    /// Regression: re-registering a session with a NEW transcript path (what
    /// happens on `/clear` or exiting and relaunching `claude` in the same
    /// terminal) must replace the stale watcher — it used to be ignored,
    /// permanently killing the activity feed for that terminal.
    #[tokio::test]
    async fn test_start_watching_replaces_watcher_on_new_transcript_path() {
        use std::time::Duration;

        let (event_bus, captured) = test_event_bus();
        let watcher = TranscriptWatcher::new(event_bus);

        let dir = tempfile::tempdir().unwrap();
        let path_a = dir.path().join("a.jsonl");
        std::fs::write(&path_a, "").unwrap();
        let path_a = path_a.canonicalize().unwrap();
        watcher.start_watching(1, path_a.clone());

        // Same path again: no-op, still exactly one watcher.
        watcher.start_watching(1, path_a);
        assert_eq!(watcher.watched_sessions(), vec![1]);

        // New transcript file for the same Maestro session.
        let path_b = dir.path().join("b.jsonl");
        {
            let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"after clear"}]},"uuid":"msg-b1","timestamp":"2026-02-24T10:00:00Z"}"#;
            let mut f = std::fs::File::create(&path_b).unwrap();
            writeln!(f, "{}", line).unwrap();
            f.flush().unwrap();
        }
        let path_b = path_b.canonicalize().unwrap();
        watcher.start_watching(1, path_b);
        assert_eq!(watcher.watched_sessions(), vec![1]);

        // The catch-up read of the REPLACEMENT file must deliver its events.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            {
                let events = captured.lock().unwrap();
                if events.iter().any(|e| matches!(
                    e,
                    ClaudeEvent::UserMessage { text, .. } if text == "after clear"
                )) {
                    break;
                }
                if tokio::time::Instant::now() >= deadline {
                    panic!(
                        "Timed out waiting for event from replacement transcript. Got {:?}",
                        *events
                    );
                }
            }
        }

        watcher.stop_watching(1);
    }
}
