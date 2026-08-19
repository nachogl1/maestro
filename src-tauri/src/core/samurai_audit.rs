//! Samurai audit log: per-project JSONL of everything the supervisor does.
//!
//! The audit log is the durable record and the user's oversight surface for
//! the Samurai autonomous supervisor (see `docs/samurai/prd.md` §5.10, §8).
//! One file per project under `<app data>/audit/`, one JSON event per line:
//! `{ts, epic, event, generation, session_id, details}`.
//!
//! **Single writer:** every operation — append, read, clear — is routed
//! through one mpsc channel consumed by one writer task. This fork has been
//! burned by interleaved concurrent file writes before (see the locking in
//! `core/hook_config_writer.rs`); serializing through a single task makes
//! interleaved/corrupt lines impossible and gives `clear` a well-defined
//! position in the append stream, so post-clear appends are never lost.
//!
//! **No auto-trim:** audit records are deleted manually by the user only
//! (PRD decision #15). The file size is reported on every read so later
//! phases can warn when it grows.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot};

use super::samurai_files::normalize_project;
use super::status_server::StatusServer;

/// The audit event kinds (PRD §5.10). Sub-kinds (ack-timeout, breaker-tripped,
/// threshold-crossed, illegal_transition, …) live in the free-form `details`.
/// `INJECT` (issue #101) records every instruction Maestro types into an
/// orchestrator terminal — delivery and ACK — so an unattended run can be
/// replayed from the Audit panel alone.
/// `KILL` records the DEATH of a supervised agent — every path that ends one
/// (handoff kill, watchdog death, the user closing the tile, a verified run
/// completion) — with a `details.cause` naming which
/// (`supervisor::KILL_CAUSE_*`). Without it the panel showed an agent as
/// SPAWN forever, long after its process was gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuditEventKind {
    Spawn,
    Handoff,
    Park,
    Resume,
    Complete,
    Alert,
    Inject,
    Kill,
}

/// Cap on instruction excerpts recorded in `details` (issue #101): long
/// enough to recognize the instruction, bounded so the append-only log never
/// swallows a full multi-KB brief per injection.
pub const EXCERPT_MAX_CHARS: usize = 200;

/// `(excerpt, total_chars)` of an injected instruction for audit `details`:
/// the first [`EXCERPT_MAX_CHARS`] characters (char-boundary safe) plus the
/// full length, so the row shows what was said AND how much was elided.
pub fn instruction_excerpt(text: &str) -> (String, usize) {
    let total = text.chars().count();
    let excerpt = if total > EXCERPT_MAX_CHARS {
        text.chars().take(EXCERPT_MAX_CHARS).collect()
    } else {
        text.to_string()
    };
    (excerpt, total)
}

/// One audit row. Serialized as a single JSONL line:
/// `{"ts":..,"epic":..,"event":..,"generation":..,"session_id":..,"details":..}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditEvent {
    /// RFC 3339 UTC timestamp. Same-format timestamps compare correctly as
    /// strings, which is what the `since_ts` read filter relies on.
    pub ts: String,
    /// Epic reference (e.g. a GitHub epic issue ref). Empty when unknown.
    pub epic: String,
    pub event: AuditEventKind,
    /// Orchestrator generation number (gen-N).
    pub generation: u32,
    /// Maestro session id of the supervised orchestrator session.
    pub session_id: u32,
    /// Free-form detail object for sub-kinds and context.
    pub details: Value,
}

impl AuditEvent {
    /// Builds an event stamped with the current UTC time.
    ///
    /// Issue #139's invariant — every row names the run it belongs to — is
    /// swept for at the SOURCE (`test_no_audit_writer_stamps_an_empty_run_id`),
    /// but that sweep only recognises the literal `""` / `String::new()`
    /// spellings: a writer forwarding a variable that happens to be empty
    /// walks straight past it. The debug assertion is the runtime half, so a
    /// dev build trips where the sweep cannot look.
    pub fn now(
        epic: impl Into<String>,
        event: AuditEventKind,
        generation: u32,
        session_id: u32,
        details: Value,
    ) -> Self {
        let epic = epic.into();
        debug_assert!(
            !epic.is_empty(),
            "an audit row must name the run it belongs to (issue #139) — stamp the run id, or \
             `allowance_watcher::ACCOUNT_RUN` for a genuinely account-wide row"
        );
        Self {
            ts: chrono::Utc::now().to_rfc3339(),
            epic,
            event,
            generation,
            session_id,
            details,
        }
    }
}

/// Result of a read: the matching events plus the current file size, so the
/// frontend can display it (and Phase 4 can warn on growth).
#[derive(Debug, Clone, Serialize)]
pub struct AuditReadResult {
    pub events: Vec<AuditEvent>,
    pub file_size_bytes: u64,
}

/// Callback fired by the writer task after each successful append, so the
/// frontend can live-stream audit rows without polling the file.
pub type AppendCallback = Arc<dyn Fn(&str, &AuditEvent) + Send + Sync>;

/// Operations routed through the single writer task.
enum AuditOp {
    Append {
        project: String,
        event: AuditEvent,
    },
    Read {
        project: String,
        tail: Option<usize>,
        since_ts: Option<String>,
        reply: oneshot::Sender<Result<AuditReadResult, String>>,
    },
    Clear {
        project: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

/// Handle to the audit log. Cheap to clone; all clones feed the same writer
/// task, preserving the single-writer guarantee.
#[derive(Clone)]
pub struct AuditLog {
    tx: mpsc::UnboundedSender<AuditOp>,
}

impl AuditLog {
    /// Creates the log rooted at `base_dir` and returns the handle plus the
    /// writer-task future. The caller spawns the future on its runtime
    /// (`tauri::async_runtime::spawn` in the app, `tokio::spawn` in tests) —
    /// this keeps the module free of any runtime assumption.
    pub fn new(
        base_dir: PathBuf,
        on_append: Option<AppendCallback>,
    ) -> (Self, impl std::future::Future<Output = ()> + Send) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx }, writer_task(base_dir, rx, on_append))
    }

    /// Queues an append (fire-and-forget; backend-internal). Failures inside
    /// the writer task are logged — there is no reply channel by design, so
    /// state-machine transitions never block on disk.
    pub fn append(&self, project: &str, event: AuditEvent) {
        let op = AuditOp::Append {
            project: normalize_project(project),
            event,
        };
        if self.tx.send(op).is_err() {
            log::error!("audit writer task is gone; dropping audit event");
        }
    }

    /// Reads events for `project`: optionally only those with `ts` strictly
    /// after `since_ts`, optionally only the last `tail` of those. Because the
    /// read is queued on the same channel as appends, it observes every append
    /// sent before it — awaiting a read doubles as a durability barrier.
    pub async fn read(
        &self,
        project: &str,
        tail: Option<usize>,
        since_ts: Option<String>,
    ) -> Result<AuditReadResult, String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(AuditOp::Read {
                project: normalize_project(project),
                tail,
                since_ts,
                reply,
            })
            .map_err(|_| "audit writer task is gone".to_string())?;
        rx.await
            .map_err(|_| "audit writer task dropped the reply".to_string())?
    }

    /// Deletes the project's audit file. **User-initiated only** — never
    /// called automatically (PRD decision #15). Serialized with appends, so
    /// an append queued after the clear always survives it.
    pub async fn clear(&self, project: &str) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(AuditOp::Clear {
                project: normalize_project(project),
                reply,
            })
            .map_err(|_| "audit writer task is gone".to_string())?;
        rx.await
            .map_err(|_| "audit writer task dropped the reply".to_string())?
    }
}

/// File name for a project's audit log: `<sanitized-basename>-<hash12>.jsonl`.
/// Same naming convention as `commands/ai_runner.rs::project_artifact_dir` —
/// the hash disambiguates same-named projects in different locations.
/// `pub(crate)` so the file inventory (`samurai_files`, issue #65) can
/// associate audit files back to their projects.
pub(crate) fn audit_file_name(project: &str) -> String {
    let name = Path::new(project)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "project".to_string());
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let hash = StatusServer::generate_project_hash(project);
    format!("{}-{}.jsonl", sanitized, hash)
}

fn audit_file_path(base_dir: &Path, project: &str) -> PathBuf {
    base_dir.join(audit_file_name(project))
}

/// The single writer task. Owns all file IO; processes operations strictly in
/// channel order.
async fn writer_task(
    base_dir: PathBuf,
    mut rx: mpsc::UnboundedReceiver<AuditOp>,
    on_append: Option<AppendCallback>,
) {
    while let Some(op) = rx.recv().await {
        match op {
            AuditOp::Append { project, event } => {
                let path = audit_file_path(&base_dir, &project);
                match append_line(&path, &event).await {
                    Ok(()) => {
                        if let Some(cb) = &on_append {
                            cb(&project, &event);
                        }
                    }
                    Err(e) => log::error!("audit append failed for {:?}: {}", path, e),
                }
            }
            AuditOp::Read {
                project,
                tail,
                since_ts,
                reply,
            } => {
                let path = audit_file_path(&base_dir, &project);
                let _ = reply.send(read_events(&path, tail, since_ts).await);
            }
            AuditOp::Clear { project, reply } => {
                let path = audit_file_path(&base_dir, &project);
                let result = match tokio::fs::remove_file(&path).await {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(format!("failed to clear audit log {:?}: {}", path, e)),
                };
                let _ = reply.send(result);
            }
        }
    }
}

async fn append_line(path: &Path, event: &AuditEvent) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("failed to create audit dir: {}", e))?;
    }
    let mut line = serde_json::to_string(event)
        .map_err(|e| format!("failed to serialize audit event: {}", e))?;
    line.push('\n');
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .map_err(|e| format!("failed to open audit file: {}", e))?;
    file.write_all(line.as_bytes())
        .await
        .map_err(|e| format!("failed to append audit event: {}", e))?;
    file.flush()
        .await
        .map_err(|e| format!("failed to flush audit file: {}", e))?;
    Ok(())
}

async fn read_events(
    path: &Path,
    tail: Option<usize>,
    since_ts: Option<String>,
) -> Result<AuditReadResult, String> {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AuditReadResult {
                events: Vec::new(),
                file_size_bytes: 0,
            });
        }
        Err(e) => return Err(format!("failed to stat audit file: {}", e)),
    };
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| format!("failed to read audit file: {}", e))?;

    let mut events: Vec<AuditEvent> = Vec::new();
    // A malformed line should never exist (single writer, whole-line appends)
    // — skip it rather than failing the whole read.
    let parse =
        |line: &str, out: &mut Vec<AuditEvent>| match serde_json::from_str::<AuditEvent>(line) {
            Ok(event) => out.push(event),
            Err(e) => log::warn!("skipping malformed audit line in {:?}: {}", path, e),
        };
    let lines = content.lines().filter(|l| !l.trim().is_empty());
    match (tail, &since_ts) {
        // The panel's default read (a plain tail): parse only the last n
        // lines. The log is never auto-trimmed (see the module docs), and
        // this runs inside the single writer task, so parsing every row would
        // hold up appends by an amount that grows with the run's lifetime.
        (Some(n), None) => {
            let mut last: VecDeque<&str> = VecDeque::with_capacity(n);
            for line in lines {
                last.push_back(line);
                if last.len() > n {
                    last.pop_front();
                }
            }
            for line in last {
                parse(line, &mut events);
            }
        }
        // since_ts filters on a parsed field, so it must parse everything.
        _ => {
            for line in lines {
                parse(line, &mut events);
            }
            if let Some(since) = &since_ts {
                events.retain(|e| e.ts.as_str() > since.as_str());
            }
            if let Some(n) = tail {
                if events.len() > n {
                    events.drain(..events.len() - n);
                }
            }
        }
    }

    Ok(AuditReadResult {
        events,
        file_size_bytes: metadata.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn spawn_log(base: PathBuf) -> AuditLog {
        let (log, task) = AuditLog::new(base, None);
        tokio::spawn(task);
        log
    }

    fn event(kind: AuditEventKind, session_id: u32, details: Value) -> AuditEvent {
        AuditEvent::now("epic-12", kind, 1, session_id, details)
    }

    #[tokio::test]
    async fn test_append_read_roundtrip_shape() {
        let dir = tempdir().unwrap();
        let log = spawn_log(dir.path().to_path_buf());
        let project = dir.path().join("proj").to_string_lossy().into_owned();

        log.append(
            &project,
            event(AuditEventKind::Spawn, 7, json!({"state": "WORKING"})),
        );
        let result = log.read(&project, None, None).await.unwrap();

        assert_eq!(result.events.len(), 1);
        let e = &result.events[0];
        assert_eq!(e.epic, "epic-12");
        assert_eq!(e.event, AuditEventKind::Spawn);
        assert_eq!(e.generation, 1);
        assert_eq!(e.session_id, 7);
        assert_eq!(e.details, json!({"state": "WORKING"}));
        assert!(result.file_size_bytes > 0, "file size must be reported");

        // The on-disk line must carry the agreed field names and the
        // SCREAMING event kind — dependent issues consume this shape.
        let path = audit_file_path(dir.path(), &project);
        let content = std::fs::read_to_string(&path).unwrap();
        let raw: Value = serde_json::from_str(content.lines().next().unwrap()).unwrap();
        for key in ["ts", "epic", "event", "generation", "session_id", "details"] {
            assert!(raw.get(key).is_some(), "missing key {key} in {raw}");
        }
        assert_eq!(raw["event"], "SPAWN");
    }

    #[test]
    fn test_inject_kind_wire_spelling_and_excerpt_bounds() {
        // Issue #101: the INJECT kind serializes SCREAMING like the rest.
        assert_eq!(
            serde_json::to_string(&AuditEventKind::Inject).unwrap(),
            "\"INJECT\""
        );

        // Short text: verbatim, exact length.
        assert_eq!(
            instruction_excerpt("do the thing"),
            ("do the thing".to_string(), 12)
        );
        // Long text: capped at EXCERPT_MAX_CHARS, total length preserved.
        let long = "x".repeat(EXCERPT_MAX_CHARS + 300);
        let (excerpt, total) = instruction_excerpt(&long);
        assert_eq!(excerpt.chars().count(), EXCERPT_MAX_CHARS);
        assert_eq!(total, EXCERPT_MAX_CHARS + 300);
        // Multibyte safety: chars, not bytes.
        let accented = "é".repeat(EXCERPT_MAX_CHARS + 50);
        let (excerpt, total) = instruction_excerpt(&accented);
        assert_eq!(excerpt.chars().count(), EXCERPT_MAX_CHARS);
        assert_eq!(total, EXCERPT_MAX_CHARS + 50);
        assert!(accented.starts_with(&excerpt));
    }

    /// Every `.rs` file under `src/`, recursively.
    fn rust_sources(dir: &Path) -> Vec<PathBuf> {
        let mut files = Vec::new();
        for entry in std::fs::read_dir(dir)
            .expect("readable source dir")
            .flatten()
        {
            let path = entry.path();
            if path.is_dir() {
                files.extend(rust_sources(&path));
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                files.push(path);
            }
        }
        files
    }

    /// Issue #139, the invariant behind the Second Brain's grouping: EVERY
    /// audit row names the run it belongs to. Rows written with an empty
    /// `epic` are the only reason a generic "Unattributed" bucket would ever
    /// be needed — so the writers are fixed and this sweep keeps them fixed.
    ///
    /// A source sweep rather than a runtime assertion on purpose: an empty
    /// run id is a bug at the CALL SITE, and the call sites are spread across
    /// a dozen modules whose writers no single test can drive. Test fixtures
    /// are exempt (they build rows of every shape deliberately), so each
    /// file's `#[cfg(test)] mod tests` is cut before the scan.
    #[test]
    fn test_no_audit_writer_stamps_an_empty_run_id() {
        const CTOR: &str = "AuditEvent::now(";
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut sites = 0usize;
        let mut offenders: Vec<String> = Vec::new();

        for file in rust_sources(&src) {
            let content = std::fs::read_to_string(&file).expect("readable source");
            let production = content
                .split("\n#[cfg(test)]\nmod tests {")
                .next()
                .unwrap_or(&content)
                .to_string();
            for (offset, _) in production.match_indices(CTOR) {
                sites += 1;
                let epic = production[offset + CTOR.len()..].trim_start();
                if epic.starts_with("\"\"") || epic.starts_with("String::new()") {
                    let line = production[..offset].lines().count();
                    offenders.push(format!("{}:{}", file.display(), line + 1));
                }
            }
            // The struct-literal spelling of the same bug.
            for empty in ["epic: String::new()", "epic: \"\".to_string()"] {
                if production.contains(empty) {
                    offenders.push(format!("{} ({empty})", file.display()));
                }
            }
        }

        assert!(
            sites >= 10,
            "the sweep found only {sites} `{CTOR}` sites — it has stopped scanning what it thinks \
             it scans (renamed constructor?), so it can no longer catch an unattributed row"
        );
        assert!(
            offenders.is_empty(),
            "audit rows written with an empty run id — stamp the run (or \
             `allowance_watcher::ACCOUNT_RUN` for a genuinely account-wide row):\n{}",
            offenders.join("\n")
        );
    }

    /// Issue #139 c10, runtime half (review B9): the source sweep above only
    /// recognises the literal empty spellings, so a writer forwarding a
    /// variable that happens to be empty passes it untouched. A dev build
    /// trips instead of writing a row no group can ever claim.
    #[cfg(debug_assertions)]
    #[test]
    #[should_panic(expected = "must name the run it belongs to")]
    fn test_an_empty_run_id_trips_the_debug_assertion() {
        let forwarded = String::new();
        AuditEvent::now(forwarded, AuditEventKind::Alert, 1, 1, json!({}));
    }

    #[test]
    fn test_kill_kind_wire_spelling() {
        // The frontend's `SamuraiAuditEventKind` union and the audit panel's
        // badge map key off this exact spelling.
        assert_eq!(
            serde_json::to_string(&AuditEventKind::Kill).unwrap(),
            "\"KILL\""
        );
        assert_eq!(
            serde_json::from_str::<AuditEventKind>("\"KILL\"").unwrap(),
            AuditEventKind::Kill
        );
    }

    #[tokio::test]
    async fn test_tail_and_since_filters() {
        let dir = tempdir().unwrap();
        let log = spawn_log(dir.path().to_path_buf());
        let project = "C:/git/some-project".to_string();

        for i in 0..10u32 {
            let mut e = event(AuditEventKind::Alert, i, json!({"seq": i}));
            // Deterministic, ordered timestamps.
            e.ts = format!("2026-08-06T00:00:0{}+00:00", i);
            log.append(&project, e);
        }

        let tail = log.read(&project, Some(3), None).await.unwrap();
        assert_eq!(tail.events.len(), 3);
        assert_eq!(tail.events[0].details["seq"], 7);
        assert_eq!(tail.events[2].details["seq"], 9);

        // since_ts is strictly-after.
        let since = log
            .read(&project, None, Some("2026-08-06T00:00:07+00:00".into()))
            .await
            .unwrap();
        assert_eq!(since.events.len(), 2);
        assert_eq!(since.events[0].details["seq"], 8);

        // Combined: since leaves 8,9; tail 1 keeps 9.
        let both = log
            .read(&project, Some(1), Some("2026-08-06T00:00:07+00:00".into()))
            .await
            .unwrap();
        assert_eq!(both.events.len(), 1);
        assert_eq!(both.events[0].details["seq"], 9);
    }

    /// The panel's default read is a plain tail, and it parses only the last
    /// n lines (the log is never auto-trimmed and the read runs inside the
    /// writer task). It must still return exactly what a full parse returns.
    #[tokio::test]
    async fn test_tail_only_read_matches_full_read_tail() {
        let dir = tempdir().unwrap();
        let log = spawn_log(dir.path().to_path_buf());
        let project = "C:/git/tail-fast-path".to_string();

        for i in 0..25u32 {
            log.append(&project, event(AuditEventKind::Alert, i, json!({"seq": i})));
        }

        let all = log.read(&project, None, None).await.unwrap();
        assert_eq!(all.events.len(), 25);

        let tail = log.read(&project, Some(5), None).await.unwrap();
        assert_eq!(tail.events, all.events[all.events.len() - 5..].to_vec());
        assert_eq!(tail.file_size_bytes, all.file_size_bytes);

        // A tail longer than the log keeps everything; a zero tail keeps none.
        let over = log.read(&project, Some(100), None).await.unwrap();
        assert_eq!(over.events, all.events);
        let none = log.read(&project, Some(0), None).await.unwrap();
        assert!(none.events.is_empty());
    }

    #[tokio::test]
    async fn test_clear_removes_file_and_reports_zero_size() {
        let dir = tempdir().unwrap();
        let log = spawn_log(dir.path().to_path_buf());
        let project = "C:/git/clear-me".to_string();

        log.append(&project, event(AuditEventKind::Park, 1, json!({})));
        let before = log.read(&project, None, None).await.unwrap();
        assert_eq!(before.events.len(), 1);
        assert!(before.file_size_bytes > 0);

        log.clear(&project).await.unwrap();
        let after = log.read(&project, None, None).await.unwrap();
        assert!(after.events.is_empty());
        assert_eq!(after.file_size_bytes, 0);

        // Clearing an already-missing file is a no-op, not an error.
        log.clear(&project).await.unwrap();
    }

    #[tokio::test]
    async fn test_projects_get_separate_files() {
        let dir = tempdir().unwrap();
        let log = spawn_log(dir.path().to_path_buf());

        // Same basename, different locations — must not collide.
        let a = "C:/git/maestro".to_string();
        let b = "C:/other/maestro".to_string();
        log.append(&a, event(AuditEventKind::Spawn, 1, json!({"which": "a"})));
        log.append(&b, event(AuditEventKind::Spawn, 2, json!({"which": "b"})));

        let read_a = log.read(&a, None, None).await.unwrap();
        let read_b = log.read(&b, None, None).await.unwrap();
        assert_eq!(read_a.events.len(), 1);
        assert_eq!(read_a.events[0].details["which"], "a");
        assert_eq!(read_b.events.len(), 1);
        assert_eq!(read_b.events[0].details["which"], "b");
        assert_ne!(audit_file_name(&a), audit_file_name(&b));
    }

    #[test]
    fn test_verbatim_prefix_maps_to_same_file() {
        // Windows `\\?\` canonicalized spelling and the plain spelling must
        // encode to the same audit file (fork convention: strip before
        // encoding/comparing).
        assert_eq!(
            audit_file_name(&normalize_project(r"\\?\C:\git\maestro")),
            audit_file_name(&normalize_project(r"C:\git\maestro")),
        );
        // And the UNC pair (issue #161): the verbatim spelling of a
        // share-hosted checkout keys the same audit file as its plain
        // absolute spelling.
        assert_eq!(
            audit_file_name(&normalize_project(r"\\?\UNC\server\share\maestro")),
            audit_file_name(&normalize_project(r"\\server\share\maestro")),
        );
    }

    #[tokio::test]
    async fn test_concurrent_append_hammer_no_interleaving() {
        let dir = tempdir().unwrap();
        let log = spawn_log(dir.path().to_path_buf());
        let project = "C:/git/hammer".to_string();

        const TASKS: u32 = 8;
        const PER_TASK: u32 = 50;

        let mut handles = Vec::new();
        for t in 0..TASKS {
            let log = log.clone();
            let project = project.clone();
            handles.push(tokio::spawn(async move {
                for i in 0..PER_TASK {
                    log.append(
                        &project,
                        event(AuditEventKind::Alert, t, json!({"task": t, "seq": i})),
                    );
                    // Yield so tasks genuinely interleave their sends.
                    tokio::task::yield_now().await;
                }
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        // Read the raw file and parse every line strictly: any interleaved or
        // torn write would produce a line that fails to parse.
        let read = log.read(&project, None, None).await.unwrap();
        assert_eq!(read.events.len(), (TASKS * PER_TASK) as usize);

        let path = audit_file_path(dir.path(), &project);
        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), (TASKS * PER_TASK) as usize);
        let mut last_seq_per_task = vec![-1i64; TASKS as usize];
        for line in lines {
            let e: AuditEvent = serde_json::from_str(line)
                .unwrap_or_else(|err| panic!("corrupt audit line {line:?}: {err}"));
            let task = e.details["task"].as_u64().unwrap() as usize;
            let seq = e.details["seq"].as_i64().unwrap();
            // Per-sender FIFO: each task's events must appear in send order.
            assert!(
                seq > last_seq_per_task[task],
                "task {task} events out of order: {seq} after {}",
                last_seq_per_task[task]
            );
            last_seq_per_task[task] = seq;
        }
    }

    #[tokio::test]
    async fn test_clear_between_appends_keeps_post_clear_events() {
        let dir = tempdir().unwrap();
        let log = spawn_log(dir.path().to_path_buf());
        let project = "C:/git/clear-mid-run".to_string();

        // Deterministic ordering via the single channel: 50 appends, then a
        // clear, then 50 more — the clear must drop exactly the first 50.
        for i in 0..50u32 {
            log.append(&project, event(AuditEventKind::Alert, 1, json!({"seq": i})));
        }
        log.clear(&project).await.unwrap();
        for i in 50..100u32 {
            log.append(&project, event(AuditEventKind::Alert, 1, json!({"seq": i})));
        }

        let read = log.read(&project, None, None).await.unwrap();
        assert_eq!(read.events.len(), 50);
        assert_eq!(read.events[0].details["seq"], 50);
        assert_eq!(read.events[49].details["seq"], 99);
        assert!(read.file_size_bytes > 0);
    }

    #[tokio::test]
    async fn test_clear_racing_a_live_appender_loses_nothing_after_clear() {
        let dir = tempdir().unwrap();
        let log = spawn_log(dir.path().to_path_buf());
        let project = "C:/git/clear-race".to_string();

        // A run appending continuously while the user clears mid-flight.
        let appender = {
            let log = log.clone();
            let project = project.clone();
            tokio::spawn(async move {
                for i in 0..200u32 {
                    log.append(&project, event(AuditEventKind::Alert, 1, json!({"seq": i})));
                    tokio::task::yield_now().await;
                }
            })
        };
        // Let some appends land, then clear while the appender is still going.
        tokio::task::yield_now().await;
        log.clear(&project).await.unwrap();
        appender.await.unwrap();

        // Wherever the clear landed in the stream, the surviving file must be
        // uncorrupted and hold a contiguous tail ending at seq 199 — i.e. no
        // post-clear event was lost.
        let read = log.read(&project, None, None).await.unwrap();
        assert!(
            !read.events.is_empty(),
            "appends after the clear must survive"
        );
        let seqs: Vec<u64> = read
            .events
            .iter()
            .map(|e| e.details["seq"].as_u64().unwrap())
            .collect();
        let first = seqs[0];
        let expected: Vec<u64> = (first..200).collect();
        assert_eq!(seqs, expected, "surviving events must be a contiguous tail");
    }
}
