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
//! **Bounded, not trimmed:** audit records are still never aged out or
//! selectively deleted (PRD decision #15) — the only thing that removes a
//! chosen row is the user's `clear`. What the file does now is ROLL: once the
//! live file passes [`ROTATE_AT_BYTES`] it becomes `<name>.1.jsonl` and a new
//! live file starts, and exactly ONE previous generation is kept. Every
//! reader here spans the pair, so the roll is invisible from the outside —
//! including a tail read, which continues backwards into the rolled file when
//! the live one is shorter than the tail asked for (the reconciler's
//! `AUDIT_TAIL` read decides whether an interrupted run is resumable, and
//! must not lose the SPAWN rows carrying its generation to a roll).
//! Without the cap the file grew forever and a filtered read parsed every
//! line of it inside the single writer task. The file size is reported on
//! every read (both generations summed) so the panel can still warn on it.

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

/// Roll the live audit file once it passes this many bytes, keeping exactly
/// one previous generation.
///
/// Chosen against `SamuraiConfig::size_warn_bytes` (5 MiB — the point at
/// which the Second Brain calls a file too big): two generations of 2 MiB
/// keep a project's whole audit history just under that line, so a rolling
/// log never trips the warning that only ever existed because the log could
/// not stop growing. It is also the bound on the work a filtered read does
/// inside the single writer task — at most ~4 MiB parsed, not "everything
/// this run has ever written".
pub(crate) const ROTATE_AT_BYTES: u64 = 2 * 1024 * 1024;

/// Suffix of a rolled generation: `<name>-<hash12>.jsonl` rolls to
/// `<name>-<hash12>.1.jsonl`.
pub(crate) const ROTATED_SUFFIX: &str = ".1.jsonl";

/// The rolled generation's path for a live audit file.
pub(crate) fn rotated_audit_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = name.strip_suffix(".jsonl").unwrap_or(&name);
    path.with_file_name(format!("{stem}{ROTATED_SUFFIX}"))
}

/// Is this audit file name a rolled generation rather than a live log?
/// The Second Brain's directory scan keys groups off the hash embedded in the
/// live name, which a rolled name would parse wrong — it counts the rolled
/// rows through its live sibling instead (`samurai_files::count_audit_rows`).
pub(crate) fn is_rotated_audit_file(name: &str) -> bool {
    name.ends_with(ROTATED_SUFFIX)
}

/// [`audit_file_path`] plus the one-shot #161 heal, called only from the
/// writer task (the sole IO owner): a UNC project's log written before #161
/// sits under the name its mangled relative spelling (`UNC\server\share\…`)
/// hashed to, and every op now keys on the repaired `\\server\share\…` form.
/// When the modern file is absent and that legacy file exists, the legacy
/// file is RENAMED to the modern name — history stays readable and new
/// events keep appending to it. When both exist (a post-#161 file already
/// started), the legacy file is left alone: still visible in the Second
/// Brain's directory scan, never merged into or deleted over.
async fn resolve_audit_file(base_dir: &Path, project: &str) -> PathBuf {
    let path = audit_file_path(base_dir, project);
    // Only a repaired UNC spelling can have a legacy twin; `project` arrives
    // normalized, so a verbatim `\\?\` prefix cannot occur here.
    let Some(rest) = project.strip_prefix(r"\\") else {
        return path;
    };
    if tokio::fs::metadata(&path).await.is_ok() {
        return path;
    }
    let legacy = audit_file_path(base_dir, &format!(r"UNC\{rest}"));
    if tokio::fs::metadata(&legacy).await.is_ok() {
        match tokio::fs::rename(&legacy, &path).await {
            Ok(()) => log::info!("samurai audit: re-keyed {legacy:?} to {path:?} (#161)"),
            Err(e) => log::warn!("samurai audit: could not re-key {legacy:?}: {e}"),
        }
    }
    path
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
                let path = resolve_audit_file(&base_dir, &project).await;
                match append_line(&path, &event, ROTATE_AT_BYTES).await {
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
                let path = resolve_audit_file(&base_dir, &project).await;
                let _ = reply.send(read_events(&path, tail, since_ts).await);
            }
            AuditOp::Clear { project, reply } => {
                let path = resolve_audit_file(&base_dir, &project).await;
                // Both generations: "clear the audit log" means the history
                // is gone, and a surviving `.1.jsonl` would come straight
                // back on the next read.
                let mut result = Ok(());
                for target in [rotated_audit_path(&path), path.clone()] {
                    match tokio::fs::remove_file(&target).await {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => {
                            result = Err(format!("failed to clear audit log {:?}: {}", target, e))
                        }
                    }
                }
                let _ = reply.send(result);
            }
        }
    }
}

/// Appends one whole line, then rolls the file if it has outgrown
/// `rotate_at`. `rotate_at` is a parameter only so the tests can roll a
/// two-line file; production always passes [`ROTATE_AT_BYTES`].
async fn append_line(path: &Path, event: &AuditEvent, rotate_at: u64) -> Result<(), String> {
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
    // The roll happens AFTER a complete, flushed record and before the next
    // append opens the file again — the rolled generation therefore always
    // ends on a whole line, and no record can be torn by it. An unreadable
    // size or a failed rename is not an error for the caller: the event IS
    // written, the file just keeps its name and the next append retries the
    // roll.
    let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    drop(file);
    if size > rotate_at {
        let rolled = rotated_audit_path(path);
        match tokio::fs::rename(path, &rolled).await {
            Ok(()) => log::info!("samurai audit: rolled {:?} to {:?}", path, rolled),
            Err(e) => log::warn!("samurai audit: could not roll {:?}: {}", path, e),
        }
    }
    Ok(())
}

async fn read_events(
    path: &Path,
    tail: Option<usize>,
    since_ts: Option<String>,
) -> Result<AuditReadResult, String> {
    let rolled = rotated_audit_path(path);
    let live_size = match tokio::fs::metadata(path).await {
        Ok(m) => Some(m.len()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("failed to stat audit file: {}", e)),
    };
    // The rolled generation is history: a stat that fails for any reason is
    // read as "no previous generation" rather than failing the whole read.
    let rolled_size = tokio::fs::metadata(&rolled).await.ok().map(|m| m.len());
    if live_size.is_none() && rolled_size.is_none() {
        return Ok(AuditReadResult {
            events: Vec::new(),
            file_size_bytes: 0,
        });
    }
    let content = match live_size {
        Some(_) => tokio::fs::read_to_string(path)
            .await
            .map_err(|e| format!("failed to read audit file: {}", e))?,
        None => String::new(),
    };
    // Read lazily: a tail the live file alone can satisfy never touches the
    // rolled generation, which is the whole point of the tail fast path.
    let mut rolled_content = String::new();

    let mut events: Vec<AuditEvent> = Vec::new();
    // A malformed line should never exist (single writer, whole-line appends)
    // — skip it rather than failing the whole read.
    let parse =
        |line: &str, out: &mut Vec<AuditEvent>| match serde_json::from_str::<AuditEvent>(line) {
            Ok(event) => out.push(event),
            Err(e) => log::warn!("skipping malformed audit line in {:?}: {}", path, e),
        };
    match (tail, &since_ts) {
        // The panel's default read (a plain tail): parse only the last n
        // lines. This runs inside the single writer task, so parsing every
        // row would hold up appends by an amount that grows with the run's
        // lifetime. When the live file holds fewer than n rows the read
        // continues BACKWARDS into the rolled generation, so a tail spans the
        // roll transparently — `samurai_reconciler`'s `AUDIT_TAIL` read finds
        // the SPAWN rows carrying a run's highest generation whether or not
        // the file rolled since (without that, a rolled run would be
        // downgraded to unstartable).
        (Some(n), None) => {
            let mut last = tail_lines(&content, n);
            if last.len() < n && rolled_size.is_some() {
                rolled_content = read_rolled(&rolled).await;
                let mut older = tail_lines(&rolled_content, n - last.len());
                older.extend(last);
                last = older;
            }
            for line in last {
                parse(line, &mut events);
            }
        }
        // since_ts filters on a parsed field, so it must parse everything —
        // bounded now at both generations, not at the run's whole lifetime.
        _ => {
            if rolled_size.is_some() {
                rolled_content = read_rolled(&rolled).await;
            }
            let lines = rolled_content
                .lines()
                .chain(content.lines())
                .filter(|l| !l.trim().is_empty());
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
        // Both generations: the panel's size figure is what this project's
        // audit history costs on disk, and `clear` removes exactly that.
        file_size_bytes: live_size.unwrap_or(0) + rolled_size.unwrap_or(0),
    })
}

/// The last `n` non-empty lines of `content`, in file order.
fn tail_lines(content: &str, n: usize) -> VecDeque<&str> {
    let mut last: VecDeque<&str> = VecDeque::new();
    for line in content.lines().filter(|l| !l.trim().is_empty()) {
        last.push_back(line);
        if last.len() > n {
            last.pop_front();
        }
    }
    last
}

/// A rolled generation's content. History, so an unreadable file is logged
/// and read as empty rather than failing the read of the live one.
async fn read_rolled(path: &Path) -> String {
    match tokio::fs::read_to_string(path).await {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            log::warn!("skipping unreadable rolled audit file {:?}: {}", path, e);
            String::new()
        }
    }
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
    /// n lines (the read runs inside the writer task). It must still return
    /// exactly what a full parse returns.
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
    async fn test_ops_heal_a_pre_161_unc_audit_file() {
        // A UNC project's log written before #161 sits under the name its
        // mangled relative spelling hashed to. The first op on the repaired
        // spelling renames it, so history stays readable and new events keep
        // appending to the same file.
        let dir = tempdir().unwrap();
        let legacy = audit_file_path(dir.path(), r"UNC\server\share\maestro");
        let line = serde_json::to_string(&event(AuditEventKind::Spawn, 7, json!({}))).unwrap();
        std::fs::write(&legacy, format!("{line}\n")).unwrap();

        let log = spawn_log(dir.path().to_path_buf());
        let read = log
            .read(r"\\server\share\maestro", None, None)
            .await
            .unwrap();
        assert_eq!(read.events.len(), 1, "pre-#161 history must stay readable");
        assert!(!legacy.exists(), "the legacy file is re-keyed, not copied");

        log.append(
            r"\\server\share\maestro",
            event(AuditEventKind::Alert, 8, json!({})),
        );
        let read = log
            .read(r"\\server\share\maestro", None, None)
            .await
            .unwrap();
        assert_eq!(read.events.len(), 2, "appends continue the healed file");

        // When a post-#161 file already exists, the legacy one is left in
        // place — never merged into or deleted over.
        std::fs::write(&legacy, format!("{line}\n")).unwrap();
        let read = log
            .read(r"\\server\share\maestro", None, None)
            .await
            .unwrap();
        assert_eq!(read.events.len(), 2);
        assert!(legacy.exists());
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

    // ---- rotation (the log used to grow forever) --------------------------

    /// `NEVER` is a cap no test row can reach, `NOW` one every row passes —
    /// together they make a roll land on an exact, chosen append instead of
    /// on whatever byte count the row serialization happens to produce.
    const NEVER: u64 = u64::MAX;
    const NOW: u64 = 0;

    /// Appends `count` rows of `generation`, numbered from `from`, rolling
    /// the file on the LAST of them when `roll` is set.
    async fn append_rows(path: &Path, from: u32, count: u32, generation: u32, roll: bool) {
        for i in from..from + count {
            let mut e = event(AuditEventKind::Spawn, i, json!({"seq": i}));
            e.generation = generation;
            let last = i + 1 == from + count;
            append_line(path, &e, if roll && last { NOW } else { NEVER })
                .await
                .unwrap();
        }
    }

    fn seqs(result: &AuditReadResult) -> Vec<u64> {
        result
            .events
            .iter()
            .map(|e| e.details["seq"].as_u64().unwrap())
            .collect()
    }

    #[tokio::test]
    async fn test_append_rolls_the_file_keeping_exactly_one_previous_generation() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("rolls-0123456789ab.jsonl");
        let rolled = rotated_audit_path(&path);
        assert_eq!(
            rolled.file_name().unwrap().to_string_lossy(),
            "rolls-0123456789ab.1.jsonl"
        );

        // Under the cap: one file, no generations.
        append_rows(&path, 0, 3, 1, false).await;
        assert!(path.exists());
        assert!(!rolled.exists());

        // The append that crosses the cap rolls the whole file away, leaving
        // the live name free for the next one.
        append_rows(&path, 3, 1, 1, true).await;
        assert!(!path.exists(), "the live file is rolled, not copied");
        assert_eq!(std::fs::read_to_string(&rolled).unwrap().lines().count(), 4);

        // A second roll keeps exactly ONE previous generation: the first
        // one's rows go, the second one's take its place.
        append_rows(&path, 4, 2, 1, true).await;
        let kept = std::fs::read_to_string(&rolled).unwrap();
        assert_eq!(kept.lines().count(), 2, "one previous generation, not two");
        for line in kept.lines() {
            let e: AuditEvent = serde_json::from_str(line)
                .unwrap_or_else(|err| panic!("a roll tore a record: {line:?}: {err}"));
            assert!(e.details["seq"].as_u64().unwrap() >= 4);
        }
    }

    /// The constraint behind the whole rotation: `samurai_reconciler`'s
    /// `audit_max_generation` reads `Some(AUDIT_TAIL)` rows and decides from
    /// them whether an interrupted run is resumable or is downgraded to
    /// unstartable. A roll must therefore be invisible to a tail read: when
    /// the live file is shorter than the tail asked for, the read continues
    /// backwards into the rolled generation.
    #[tokio::test]
    async fn test_a_tail_read_spans_the_rotation_boundary() {
        const AUDIT_TAIL: usize = 500; // samurai_reconciler.rs
        let dir = tempdir().unwrap();
        let path = dir.path().join("spans-0123456789ab.jsonl");

        // gen-3 SPAWNs land first and are rolled away; only gen-1 rows are
        // left in the live file.
        append_rows(&path, 0, 4, 3, false).await;
        append_rows(&path, 4, 1, 3, true).await;
        append_rows(&path, 5, 3, 1, false).await;

        let tail = read_events(&path, Some(AUDIT_TAIL), None).await.unwrap();
        assert_eq!(seqs(&tail), (0..8).collect::<Vec<u64>>());
        assert_eq!(
            tail.events
                .iter()
                .filter(|e| e.epic == "epic-12")
                .map(|e| e.generation)
                .max(),
            Some(3),
            "the run's highest generation must survive a roll, or an \
             interrupted run is downgraded to unstartable"
        );

        // A tail the live file alone satisfies is unchanged, and one that
        // crosses the boundary takes exactly as many older rows as it needs.
        assert_eq!(
            seqs(&read_events(&path, Some(2), None).await.unwrap()),
            [6, 7]
        );
        assert_eq!(
            seqs(&read_events(&path, Some(5), None).await.unwrap()),
            [3, 4, 5, 6, 7]
        );
        // A tail longer than both generations keeps everything, and a zero
        // tail still keeps none.
        assert_eq!(
            read_events(&path, Some(50), None)
                .await
                .unwrap()
                .events
                .len(),
            8
        );
        assert!(read_events(&path, Some(0), None)
            .await
            .unwrap()
            .events
            .is_empty());
    }

    #[tokio::test]
    async fn test_full_and_since_reads_span_the_rotation_boundary() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("filtered-0123456789ab.jsonl");
        for i in 0..6u32 {
            let mut e = event(AuditEventKind::Alert, i, json!({"seq": i}));
            e.ts = format!("2026-09-08T00:00:0{i}+00:00");
            // Roll after the third row: 0,1,2 land in the rolled generation.
            append_line(&path, &e, if i == 2 { NOW } else { NEVER })
                .await
                .unwrap();
        }

        let all = read_events(&path, None, None).await.unwrap();
        assert_eq!(seqs(&all), (0..6).collect::<Vec<u64>>());
        // The size is BOTH generations — what this history costs on disk.
        let live = std::fs::metadata(&path).unwrap().len();
        let rolled = std::fs::metadata(rotated_audit_path(&path)).unwrap().len();
        assert_eq!(all.file_size_bytes, live + rolled);

        // since_ts still filters across the boundary, tail included.
        let since = read_events(&path, None, Some("2026-09-08T00:00:01+00:00".into()))
            .await
            .unwrap();
        assert_eq!(seqs(&since), [2, 3, 4, 5]);
        let both = read_events(&path, Some(2), Some("2026-09-08T00:00:00+00:00".into()))
            .await
            .unwrap();
        assert_eq!(seqs(&both), [4, 5]);
    }

    #[tokio::test]
    async fn test_clear_removes_the_rolled_generation_too() {
        let dir = tempdir().unwrap();
        let log = spawn_log(dir.path().to_path_buf());
        let project = "C:/git/clear-rolled".to_string();
        let path = audit_file_path(dir.path(), &project);

        append_rows(&path, 0, 2, 1, true).await;
        append_rows(&path, 2, 2, 1, false).await;
        assert_eq!(
            read_events(&path, None, None).await.unwrap().events.len(),
            4
        );

        log.clear(&project).await.unwrap();
        assert!(
            !rotated_audit_path(&path).exists(),
            "a cleared log leaves no history behind"
        );
        let after = log.read(&project, None, None).await.unwrap();
        assert!(after.events.is_empty());
        assert_eq!(after.file_size_bytes, 0);
    }

    #[tokio::test]
    async fn test_a_roll_that_cannot_rename_degrades_to_a_plain_append() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("blocked-0123456789ab.jsonl");
        // A directory squatting on the rolled name: the rename fails, and
        // the event must still be written and readable.
        std::fs::create_dir(rotated_audit_path(&path)).unwrap();

        append_rows(&path, 0, 2, 1, true).await;
        append_rows(&path, 2, 1, 1, false).await;

        assert!(path.exists(), "the log keeps its name when the roll fails");
        let read = read_events(&path, Some(500), None).await.unwrap();
        assert_eq!(seqs(&read), [0, 1, 2], "no event is lost to a failed roll");
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
