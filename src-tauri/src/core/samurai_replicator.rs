//! Samurai replication controller (Phase 2, issue #55; PRD §5.4 + §5.6).
//!
//! Closes the loop the injector opens: once a handoff is VALIDATED (P2.3
//! transitioned the session to `HANDOFF_WRITTEN`), this module
//!
//! 1. **Kills gen-N** with the same full teardown the manual
//!    `commands::terminal::kill_session` path performs (tree-scoped PTY
//!    kill, status-server unregister, transcript-watcher stop, context-store
//!    remove — injected as one [`SessionTeardown`] closure so the module
//!    stays constructible in tests), then `transition(Killed)` — the audit
//!    row (`HANDOFF phase=killed`) and the `samurai-supervisor-event` the
//!    frontend uses to clear the dead tile both fire from the transition.
//! 2. **Computes the HEAD gate** (PRD §5.6, never trusted to the model):
//!    parses the predecessor's HEAD SHA out of the just-validated handoff
//!    file and compares it against `git rev-parse HEAD` in the session's
//!    working directory. Match → the successor's ritual prompt says verify
//!    is already satisfied; mismatch (or unparseable) → the prompt requires
//!    running the handoff's Verify commands first.
//! 3. **Stages the successor**: queues the ritual prompt keyed by
//!    (project, epic, generation N+1) and emits the `samurai-spawn-successor`
//!    event; the frontend runs its existing spawn flow and registers the new
//!    session via `samurai_register_session`. The registration is matched
//!    against the queue ([`Self::on_registered`]) and the prompt is typed in
//!    on that session's FIRST `SessionStarted` hook signal — claude is up
//!    and sitting at its prompt, so a blind `write_stdin` is safe. No ACK is
//!    required (nothing is watching for a handoff yet), but a successor that
//!    never starts within `ack_timeout_secs` raises an `ALERT`
//!    (`details.kind = "successor_no_start"`).
//!
//! Issue #56 adds **recovery mode** (PRD §5.6/§5.7) — the one path that
//! covers every death without a valid handoff:
//!
//! - **Trigger (a), DEAD:** the watchdog's `Dead` transition reaches
//!   [`Self::on_dead`] through the supervisor's change callback (lib.rs).
//!   The dead session's terminal is left alone (the tile already shows the
//!   error; a human dismisses it) and a RECOVERY successor is staged for
//!   gen-N+1 through the exact same queue/spawn/arm/deliver machinery.
//!   DEAD is terminal — the transition, and therefore the callback, can
//!   fire at most once per session — and staging is guarded by the
//!   (project, epic, generation) key anyway, so one dead generation stages
//!   exactly one recovery.
//! - **Trigger (b), vanished handoff:** the handoff was validated moments
//!   before [`Self::replicate`] re-reads it for the HEAD gate, but it can
//!   be deleted in that window. A missing/unreadable file at prep time
//!   selects the recovery prompt instead of the normal ritual; everything
//!   downstream is unchanged.
//!
//! Both triggers write a **pre-digested transcript summary** (bounded tail
//! of the predecessor's transcript, no model call) next to the handoffs;
//! the recovery prompt references that file instead of inlining kilobytes
//! through `write_stdin`. A missing transcript still produces the file,
//! with a note — git + GitHub are the primary reconstruction sources.
//!
//! Same shape as the watchdog/injector: decisions as pure functions, I/O at
//! the edges, one periodic timeout pass (driven by the injector's tick).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;

use crate::commands::ai_runner::{strip_ansi, truncate_chars};

use super::claude_event::ClaudeEvent;
use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_config::SharedSamuraiConfig;
use super::samurai_injector::{strip_extended_prefix, SessionDirResolver};
use super::samurai_prompts;
use super::supervisor::{SessionSnapshot, Supervisor, SupervisorState};
use super::transcript_parser;
use super::windows_process::StdCommandExt;

/// Full teardown of one terminal session, mirroring the manual kill command:
/// `ProcessManager::kill_session` + status-server unregister + transcript
/// watcher stop + samurai context remove. Injected as a boxed-future closure
/// because two of those steps are async and the whole sequence must complete
/// BEFORE the `Killed` transition writes its audit row.
pub type SessionTeardown =
    Arc<dyn Fn(u32) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// Emits the `samurai-spawn-successor` event to the frontend.
pub type SuccessorEmitter = Arc<dyn Fn(&SuccessorSpawn) + Send + Sync>;

/// Types one line + `\r` into a session's PTY (the ritual delivery). The
/// production closure routes through `spawn_blocking` + `write_stdin`, the
/// same policy as the injector's writes.
pub type StdinWriter = Arc<dyn Fn(u32, String) + Send + Sync>;

/// Resolves a session's transcript file for the recovery digest (issue #56).
/// The production closure (lib.rs) asks the transcript watcher first — it is
/// usually still attached to a DEAD session — and falls back to the newest
/// `*.jsonl` in the session's Claude project directory. `None` means no
/// transcript could be found; the digest then records that instead of
/// blocking the spawn.
pub type TranscriptPathResolver = Arc<dyn Fn(u32) -> Option<PathBuf> + Send + Sync>;

/// Issue #60: consulted with (project, epic) just before a successor is
/// staged for a completed handoff. `true` = a hard park sweep is engaged;
/// the handoff is absorbed as park state (the parker records the epic for a
/// resume timer) and NO successor spawns. The production closure wraps
/// `SamuraiParker::absorb_handoff`; late-bound because the parker is
/// constructed after this controller.
pub type HandoffAbsorber = Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;

/// Payload of the `samurai-spawn-successor` event. Deliberately does NOT
/// carry the ritual prompt: frontend write-timing is unreliable (claude may
/// not be up yet), so the prompt stays queued here and is delivered on the
/// successor's first `SessionStarted` hook signal.
#[derive(Debug, Clone, Serialize)]
pub struct SuccessorSpawn {
    /// Canonical project path (`\\?\` prefix stripped).
    pub project: String,
    pub epic: String,
    /// The successor's generation (predecessor + 1).
    pub generation: u32,
    /// Directory the predecessor worked in — the epic worktree is stable
    /// across generations (PRD §5.9), so the successor spawns right there.
    pub working_dir: String,
    /// Display name for the new terminal, e.g. `samurai gen-3 37`.
    pub session_name: String,
}

/// One staged ritual prompt, from kill to delivery (or the no-start ALERT).
struct PendingRitual {
    project: String,
    epic: String,
    /// Successor generation — the (project, epic, generation) triple is the
    /// key `samurai_register_session` is matched against.
    generation: u32,
    instruction: String,
    predecessor_session_id: u32,
    predecessor_generation: u32,
    /// True for a RECOVERY successor (issue #56): the predecessor died or
    /// its handoff vanished. Rides into the SPAWN audit row's details.
    recovery: bool,
    queued_at: Instant,
    /// Set when the frontend registered the successor: (session id, when).
    /// The no-start clock runs from here; before registration it runs from
    /// `queued_at` so a spawn flow that never happens still ALERTs.
    registered: Option<(u32, Instant)>,
    /// The no-start timeout fired for this entry (fresh-eyes finding G).
    /// Latched instead of deleted: a successor registered LATE (frontend
    /// stall past the timeout) must still get its ritual armed and
    /// delivered. Never re-alerts; pruned when the ritual is claimed or when
    /// no supervised session remains for the (project, epic).
    alerted: bool,
}

/// HEAD gate (PRD §5.4/§5.6): verify is skippable only when both the
/// handoff's recorded SHA and the current HEAD are known and equal. Git
/// prints SHAs lowercase but models re-type them, so compare
/// case-insensitively.
fn head_matches(handoff_sha: Option<&str>, current_head: Option<&str>) -> bool {
    match (handoff_sha, current_head) {
        (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
        _ => false,
    }
}

/// Whether one pending ritual has waited too long for its successor to
/// start. Strict boundary, same discipline as the injector's timeouts.
fn no_start_expired(
    queued_at: Instant,
    registered_at: Option<Instant>,
    timeout: Duration,
) -> bool {
    registered_at.unwrap_or(queued_at).elapsed() > timeout
}

/// `git rev-parse HEAD` in `dir` — fixed argv, no shell, hidden console.
/// Blocking: only ever called inside `spawn_blocking`. `pub(crate)`: the
/// progress tracker (issue #57) reads baseline/current HEADs through this
/// same helper.
pub(crate) fn read_repo_head(dir: &Path) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(dir)
        .hide_console_window()
        .output()
        .map_err(|e| format!("could not run git rev-parse: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git rev-parse HEAD failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// `git remote get-url origin` in `dir` — fixed argv, no shell, hidden
/// console (same pattern as [`read_repo_head`]). Blocking: only ever called
/// inside `spawn_blocking`.
fn read_repo_origin(dir: &Path) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(dir)
        .hide_console_window()
        .output()
        .map_err(|e| format!("could not run git remote get-url: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git remote get-url origin failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Parses a git remote URL to the `owner/repo` form `gh --repo` accepts.
/// Tolerant of the common spellings — HTTPS (`https://github.com/o/r.git`,
/// credentials included), SSH scp-like (`git@github.com:o/r.git`) and
/// `ssh://` — and returns `None` for anything else (local paths, deeper
/// forge paths like GitLab subgroups): an unparseable remote must fall back
/// to the unpinned wording, never to a wrong pin.
fn parse_owner_repo(url: &str) -> Option<String> {
    let url = url.trim();
    let path = if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .or_else(|| url.strip_prefix("ssh://"))
    {
        // Drop `user:pass@host` / `host` — everything up to the first slash.
        rest.split_once('/')?.1
    } else if let Some((head, tail)) = url.split_once(':') {
        // scp-like `git@host:owner/repo`. A single-letter head is a Windows
        // drive (`C:\…`), not a host — reject it.
        if head.len() < 2 {
            return None;
        }
        tail
    } else {
        return None;
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/').filter(|s| !s.is_empty());
    let owner = parts.next()?;
    let repo = parts.next()?;
    if parts.next().is_some() {
        return None; // deeper than owner/repo — not a pin gh would accept
    }
    if [owner, repo]
        .iter()
        .any(|s| s.chars().any(char::is_whitespace))
    {
        return None; // never let a pathological remote smuggle whitespace
    }
    Some(format!("{owner}/{repo}"))
}

/// The `--repo owner/repo` pin for recovery prompts (fresh-eyes finding D;
/// PRD §10: successors run with `--dangerously-skip-permissions`, so every
/// orchestrator prompt pins `--repo`). `None` (logged) when the remote is
/// missing or unparseable — recovery is never blocked on it; the prompt then
/// carries an explicit caution instead.
fn derive_repo_pin(dir: &Path) -> Option<String> {
    match read_repo_origin(dir) {
        Ok(url) => match parse_owner_repo(&url) {
            Some(pin) => Some(pin),
            None => {
                log::warn!(
                    "samurai replicator: origin remote {url:?} does not parse to owner/repo — recovery prompt stays unpinned"
                );
                None
            }
        },
        Err(e) => {
            log::warn!(
                "samurai replicator: could not read the origin remote ({e}) — recovery prompt stays unpinned"
            );
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Recovery digest (issue #56): bounded, model-free transcript extraction
// ---------------------------------------------------------------------------

/// How much of the transcript's END is read for the digest. Transcripts run
/// to many MB; the last quarter-MB comfortably covers the final exchanges
/// without ever loading the file whole.
const DIGEST_TAIL_BYTES: u64 = 256 * 1024;
/// How many of the most recent assistant text messages the digest keeps.
const DIGEST_ASSISTANT_SNIPPETS: usize = 10;
/// How many of the most recent subagent completions the digest keeps.
const DIGEST_SUBAGENT_LINES: usize = 5;
/// Per-snippet character cap (via `truncate_chars`).
const DIGEST_SNIPPET_CHARS: usize = 500;
/// Hard cap on the whole digest file's characters.
const DIGEST_MAX_CHARS: usize = 4000;

/// Reads at most [`DIGEST_TAIL_BYTES`] from the end of `path`. When the read
/// started mid-file, the first (almost certainly partial) line is dropped so
/// every remaining line parses on its own.
fn read_transcript_tail(path: &Path) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(DIGEST_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf)?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        match text.find('\n') {
            Some(i) => {
                text.drain(..=i);
            }
            None => text.clear(),
        }
    }
    Ok(text)
}

/// What the digest extracts from a transcript tail. Assistant snippets and
/// subagent lines are kept most-recent-first: the whole-digest cap truncates
/// the end of the file, and the most recent activity is the most valuable.
struct TranscriptDigest {
    last_user_message: Option<String>,
    assistant_snippets: Vec<String>,
    subagent_lines: Vec<String>,
}

/// ANSI-strip + per-snippet truncation for any model/user text kept.
fn digest_clean(text: &str) -> String {
    truncate_chars(strip_ansi(text).trim(), DIGEST_SNIPPET_CHARS)
}

/// Walks the tail's lines through the existing transcript parser (no
/// parallel JSONL machinery) and keeps: the last real user message, the last
/// [`DIGEST_ASSISTANT_SNIPPETS`] assistant texts, and the last
/// [`DIGEST_SUBAGENT_LINES`] subagent completions.
fn extract_digest(tail: &str) -> TranscriptDigest {
    let mut last_user: Option<String> = None;
    let mut assistant: Vec<String> = Vec::new();
    let mut agents: Vec<String> = Vec::new();
    for line in tail.lines() {
        // Session id 0 is a placeholder: the parser only threads it through.
        for event in transcript_parser::parse_transcript_line(0, line) {
            match event {
                ClaudeEvent::UserMessage { text, .. } => {
                    // tool_result-only entries parse to empty text, and
                    // task notifications are system-injected, not the user.
                    if !text.trim().is_empty() && !text.contains("<task-notification>") {
                        last_user = Some(digest_clean(&text));
                    }
                }
                ClaudeEvent::AssistantMessage { text, .. } => {
                    if !text.trim().is_empty() {
                        assistant.push(digest_clean(&text));
                    }
                }
                ClaudeEvent::SubagentCompleted {
                    agent_id,
                    success,
                    status,
                    report,
                    ..
                } => {
                    let status = status.unwrap_or_else(|| {
                        if success { "completed" } else { "failed" }.to_string()
                    });
                    let brief: String = report
                        .lines()
                        .find(|l| !l.trim().is_empty())
                        .map(|l| strip_ansi(l).chars().take(120).collect())
                        .unwrap_or_default();
                    agents.push(format!("- agent {agent_id} ({status}): {brief}"));
                }
                _ => {}
            }
        }
    }
    // Keep the last N of each, most recent first (see struct doc).
    assistant.reverse();
    assistant.truncate(DIGEST_ASSISTANT_SNIPPETS);
    agents.reverse();
    agents.truncate(DIGEST_SUBAGENT_LINES);
    TranscriptDigest {
        last_user_message: last_user,
        assistant_snippets: assistant,
        subagent_lines: agents,
    }
}

/// Renders the digest file: a small header naming the predecessor plus the
/// extracted content (or a no-transcript note), hard-capped at
/// [`DIGEST_MAX_CHARS`]. Pure so tests drive it with fixture tails.
fn recovery_digest_content(
    epic: &str,
    predecessor_generation: u32,
    predecessor_session_id: u32,
    ended_at: &str,
    transcript_path: Option<&Path>,
    tail: Option<&str>,
) -> String {
    let successor = predecessor_generation + 1;
    let source = transcript_path
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "none".to_string());
    let mut out = format!(
        "# Samurai recovery digest — epic {epic} — for gen {successor}\n\n\
         - Predecessor: generation {predecessor_generation}, session {predecessor_session_id}\n\
         - Ended at: {ended_at}\n\
         - Source transcript: {source}\n\n"
    );
    match tail {
        None => out.push_str(
            "No transcript available — reconstruct from `git log` and the epic's \
             GitHub issue instead.\n",
        ),
        Some(tail) => {
            let digest = extract_digest(tail);
            out.push_str("## Last user message\n\n");
            match &digest.last_user_message {
                Some(message) => {
                    out.push_str(message);
                    out.push('\n');
                }
                None => out.push_str("(none found in the transcript tail)\n"),
            }
            out.push_str("\n## Last assistant messages (most recent first)\n\n");
            if digest.assistant_snippets.is_empty() {
                out.push_str("(none found in the transcript tail)\n");
            }
            for (i, snippet) in digest.assistant_snippets.iter().enumerate() {
                out.push_str(&format!("--- assistant [{}] ---\n{snippet}\n\n", i + 1));
            }
            if !digest.subagent_lines.is_empty() {
                out.push_str("## Subagent completions (most recent first)\n\n");
                for line in &digest.subagent_lines {
                    out.push_str(line);
                    out.push('\n');
                }
            }
        }
    }
    truncate_chars(&out, DIGEST_MAX_CHARS)
}

/// The replication controller. Fed from three directions: the injector's
/// validated-handoff chain ([`Self::on_handoff_written`]), the registration
/// command ([`Self::spawn_details`] / [`Self::on_registered`]) and the hook
/// chain ([`Self::observe_hook`], forwarded by the injector). All state
/// lives behind one uncontended `Mutex`; no lock is held across an await.
pub struct SamuraiReplicator {
    supervisor: Arc<Supervisor>,
    audit: AuditLog,
    config: SharedSamuraiConfig,
    session_dirs: SessionDirResolver,
    transcript_paths: TranscriptPathResolver,
    teardown: SessionTeardown,
    emit_spawn: SuccessorEmitter,
    write_stdin: StdinWriter,
    pending: Mutex<Vec<PendingRitual>>,
    /// Issue #60: the parking-engaged check (see [`HandoffAbsorber`]).
    /// Unset (tests without a parker, or before setup finishes) = never
    /// absorb — successors spawn as in Phase 2.
    absorber: std::sync::OnceLock<HandoffAbsorber>,
}

impl SamuraiReplicator {
    pub fn new(
        supervisor: Arc<Supervisor>,
        audit: AuditLog,
        config: SharedSamuraiConfig,
        session_dirs: SessionDirResolver,
        transcript_paths: TranscriptPathResolver,
        teardown: SessionTeardown,
        emit_spawn: SuccessorEmitter,
        write_stdin: StdinWriter,
    ) -> Self {
        Self {
            supervisor,
            audit,
            config,
            session_dirs,
            transcript_paths,
            teardown,
            emit_spawn,
            write_stdin,
            pending: Mutex::new(Vec::new()),
            absorber: std::sync::OnceLock::new(),
        }
    }

    /// Issue #60: late-binds the parking-engaged check (the parker is
    /// constructed after this controller). Second calls are ignored, like
    /// every OnceLock slot in setup.
    pub fn set_absorber(&self, absorber: HandoffAbsorber) {
        let _ = self.absorber.set(absorber);
    }

    /// One `successor_spawn_failed` ALERT (P2.4 pattern): the successor for
    /// `snapshot` cannot be spawned, a human has to step in.
    fn alert_spawn_failed(&self, snapshot: &SessionSnapshot, failure: &str) {
        log::error!(
            "samurai replicator: cannot spawn successor for session {} ({failure}) — ALERT",
            snapshot.session_id
        );
        self.audit.append(
            &snapshot.project,
            AuditEvent::now(
                snapshot.epic.clone(),
                AuditEventKind::Alert,
                snapshot.generation,
                snapshot.session_id,
                json!({
                    "kind": "successor_spawn_failed",
                    "failure": failure,
                }),
            ),
        );
    }

    /// Entry point, called by the injector right after its two-check
    /// validation moved `snapshot.session_id` into `HANDOFF_WRITTEN`. Runs
    /// the whole kill → gate → stage sequence on the async runtime; every
    /// step logs instead of panicking.
    pub fn on_handoff_written(self: &Arc<Self>, snapshot: &SessionSnapshot) {
        // Resolve the working dir NOW, while the session definitely still
        // exists — it is needed for the HEAD gate and the successor spawn.
        let Some(dir) = (self.session_dirs)(snapshot.session_id) else {
            // Cannot happen on the normal path (validation just ran git in
            // this very directory), but never kill a session we could not
            // replace: leave it in HANDOFF_WRITTEN for a human.
            self.alert_spawn_failed(snapshot, "the session's working directory is unknown");
            return;
        };
        let this = self.clone();
        let snapshot = snapshot.clone();
        tauri::async_runtime::spawn(async move {
            this.replicate(snapshot, dir).await;
        });
    }

    /// kill gen-N → `Killed` → queue ritual → emit spawn event.
    async fn replicate(self: Arc<Self>, snapshot: SessionSnapshot, dir: String) {
        let working_dir = strip_extended_prefix(&dir).to_string();

        // HEAD gate first (pure reads; the kill changes nothing git-side but
        // the session's metadata is guaranteed alive here). File I/O + git
        // have no bounded completion time → blocking pool. `None` means the
        // just-validated handoff file is missing/unreadable — it vanished in
        // the validation→prep window (issue #56 trigger b) — and selects
        // recovery mode below.
        let relpath =
            samurai_prompts::handoff_file_relpath(&snapshot.epic, snapshot.generation);
        let gate_dir = PathBuf::from(working_dir.clone());
        let head_gate: Option<bool> = tokio::task::spawn_blocking(move || {
            let handoff = std::fs::read_to_string(gate_dir.join(&relpath))
                .map_err(|e| {
                    log::warn!("samurai replicator: could not re-read handoff {relpath}: {e}");
                })
                .ok()?;
            let handoff_sha = samurai_prompts::handoff_head_sha(&handoff);
            let head = read_repo_head(&gate_dir)
                .map_err(|e| log::warn!("samurai replicator: {e}"))
                .ok();
            Some(head_matches(handoff_sha.as_deref(), head.as_deref()))
        })
        .await
        // An internal join failure is not evidence the handoff vanished:
        // stay on the normal ritual, verify required.
        .unwrap_or(Some(false));

        // Recovery needs the predecessor's transcript, and the teardown
        // below stops the transcript watcher — resolve the path NOW. The
        // resolver's fallback does blocking FS work (canonicalize + read_dir
        // + metadata), so it runs on the blocking pool, never inline on the
        // runtime (fresh-eyes finding K).
        let transcript = if head_gate.is_none() {
            let resolver = self.transcript_paths.clone();
            let session_id = snapshot.session_id;
            tokio::task::spawn_blocking(move || resolver(session_id))
                .await
                .unwrap_or(None)
        } else {
            None
        };

        // Full teardown, mirroring the manual kill command path, BEFORE the
        // Killed transition so the audit row records an accomplished fact.
        (self.teardown)(snapshot.session_id).await;

        // HANDOFF_WRITTEN → KILLED: writes the `HANDOFF phase=killed` audit
        // row and emits the supervisor event the frontend clears the dead
        // tile on. A rejection (e.g. the watchdog declared the session DEAD
        // mid-teardown) aborts the successor — DEAD has its own recovery
        // path and must not race a second spawn.
        let killed = match self
            .supervisor
            .transition(snapshot.session_id, SupervisorState::Killed)
        {
            Ok(killed) => killed,
            Err(e) => {
                log::warn!(
                    "samurai replicator: Killed transition for session {} rejected ({e}) — successor not staged",
                    snapshot.session_id
                );
                return;
            }
        };

        // Issue #60: while a hard park sweep is engaged, a completed handoff
        // is ABSORBED instead of replicated — the handoff file already IS the
        // park state (PRD §5.2) and a successor would burn the exhausted
        // allowance. Teardown and the Killed transition above already
        // happened; ONLY the successor staging + spawn emit are suppressed.
        // The PARK row explains why no successor appears; the parker records
        // the epic and arms its resume timer when the sweep completes.
        if let Some(absorber) = self.absorber.get() {
            if absorber(&snapshot.project, &snapshot.epic) {
                log::info!(
                    "samurai replicator: parking engaged — gen-{} handoff for epic {} absorbed as park state, no successor staged",
                    snapshot.generation,
                    snapshot.epic,
                );
                self.audit.append(
                    &snapshot.project,
                    AuditEvent::now(
                        snapshot.epic.clone(),
                        AuditEventKind::Park,
                        snapshot.generation,
                        snapshot.session_id,
                        json!({ "phase": "handoff_absorbed" }),
                    ),
                );
                return;
            }
        }

        let generation = snapshot.generation + 1;
        let (instruction, recovery) = match head_gate {
            Some(head_matched) => {
                log::info!(
                    "samurai replicator: session {} (gen-{}) killed for epic {} — staging gen-{generation} (HEAD gate: {})",
                    snapshot.session_id,
                    snapshot.generation,
                    snapshot.epic,
                    if head_matched { "match, verify skipped" } else { "mismatch, verify required" },
                );
                (
                    samurai_prompts::successor_ritual_instruction(
                        &snapshot.epic,
                        snapshot.generation,
                        head_matched,
                    ),
                    false,
                )
            }
            None => {
                log::warn!(
                    "samurai replicator: gen-{} handoff for epic {} vanished between validation and prep — staging gen-{generation} in RECOVERY mode",
                    snapshot.generation,
                    snapshot.epic,
                );
                self.write_recovery_digest(&snapshot, &working_dir, &killed.ts, transcript)
                    .await;
                // Finding D: pin `--repo` in the recovery prompt (PRD §10).
                // Blocking git → blocking pool; failure never blocks recovery.
                let pin_dir = PathBuf::from(working_dir.clone());
                let repo_pin = tokio::task::spawn_blocking(move || derive_repo_pin(&pin_dir))
                    .await
                    .unwrap_or(None);
                (
                    samurai_prompts::recovery_ritual_instruction(
                        &snapshot.epic,
                        snapshot.generation,
                        repo_pin.as_deref(),
                    ),
                    true,
                )
            }
        };
        let spawn = SuccessorSpawn {
            project: snapshot.project.clone(),
            epic: snapshot.epic.clone(),
            generation,
            working_dir,
            session_name: samurai_prompts::successor_session_name(&snapshot.epic, generation),
        };
        self.lock_pending().push(PendingRitual {
            project: snapshot.project.clone(),
            epic: snapshot.epic.clone(),
            generation,
            instruction,
            predecessor_session_id: snapshot.session_id,
            predecessor_generation: snapshot.generation,
            recovery,
            queued_at: Instant::now(),
            registered: None,
            alerted: false,
        });
        (self.emit_spawn)(&spawn);
    }

    /// Issue #56 trigger (a): a session the watchdog declared DEAD gets a
    /// RECOVERY successor. Chained from the supervisor's change callback
    /// (lib.rs) — DEAD is terminal, so that callback fires at most once per
    /// session; the (project, epic, generation) guard below makes staging
    /// idempotent even against a repeated notification. The dead session's
    /// terminal is deliberately NOT torn down: the tile already shows the
    /// error and demands attention, and the human dismisses it.
    pub fn on_dead(self: &Arc<Self>, snapshot: &SessionSnapshot) {
        if snapshot.state != SupervisorState::Dead {
            return;
        }
        let Some(dir) = (self.session_dirs)(snapshot.session_id) else {
            self.alert_spawn_failed(snapshot, "the session's working directory is unknown");
            return;
        };
        let working_dir = strip_extended_prefix(&dir).to_string();
        let generation = snapshot.generation + 1;
        // Stage synchronously, under the one lock, so a second DEAD
        // notification for the same generation can never double-stage.
        {
            let mut pending = self.lock_pending();
            if pending.iter().any(|p| {
                p.generation == generation
                    && p.epic == snapshot.epic
                    && p.project == snapshot.project
            }) {
                log::warn!(
                    "samurai replicator: recovery successor gen-{generation} for epic {} is already staged — ignoring repeated DEAD notification",
                    snapshot.epic
                );
                return;
            }
            log::info!(
                "samurai replicator: session {} (gen-{}) is DEAD for epic {} — staging gen-{generation} in RECOVERY mode",
                snapshot.session_id,
                snapshot.generation,
                snapshot.epic,
            );
            pending.push(PendingRitual {
                project: snapshot.project.clone(),
                epic: snapshot.epic.clone(),
                generation,
                // Staged UNPINNED (this synchronous path must not run git);
                // the async task below swaps in the `--repo`-pinned wording
                // before the spawn event fires. If that task ever dies, the
                // unpinned prompt already carries its caution (finding D).
                instruction: samurai_prompts::recovery_ritual_instruction(
                    &snapshot.epic,
                    snapshot.generation,
                    None,
                ),
                predecessor_session_id: snapshot.session_id,
                predecessor_generation: snapshot.generation,
                recovery: true,
                queued_at: Instant::now(),
                registered: None,
                alerted: false,
            });
        }
        let spawn = SuccessorSpawn {
            project: snapshot.project.clone(),
            epic: snapshot.epic.clone(),
            generation,
            working_dir: working_dir.clone(),
            session_name: samurai_prompts::successor_session_name(&snapshot.epic, generation),
        };
        let this = self.clone();
        let snapshot = snapshot.clone();
        tauri::async_runtime::spawn(async move {
            // Finding D: derive the `--repo` pin (blocking git → blocking
            // pool) and swap the staged instruction to the pinned wording.
            // Safe ordering: the ritual is only ever delivered on the
            // successor's SessionStarted, which cannot precede the spawn
            // event emitted at the end of this task.
            let pin_dir = PathBuf::from(working_dir.clone());
            let repo_pin = tokio::task::spawn_blocking(move || derive_repo_pin(&pin_dir))
                .await
                .unwrap_or(None);
            if let Some(pin) = repo_pin {
                let mut pending = this.lock_pending();
                if let Some(p) = pending.iter_mut().find(|p| {
                    p.generation == generation
                        && p.epic == snapshot.epic
                        && p.project == snapshot.project
                }) {
                    p.instruction = samurai_prompts::recovery_ritual_instruction(
                        &snapshot.epic,
                        snapshot.generation,
                        Some(&pin),
                    );
                }
            }
            // The watchdog does not stop the transcript watcher, so the dead
            // session's file usually still resolves. The resolver's fallback
            // does blocking FS work, so it runs on the blocking pool — and
            // off the supervisor's synchronous change callback entirely
            // (fresh-eyes finding K).
            let resolver = this.transcript_paths.clone();
            let session_id = snapshot.session_id;
            let transcript = tokio::task::spawn_blocking(move || resolver(session_id))
                .await
                .unwrap_or(None);
            // Digest before the spawn event so the file exists before the
            // successor can look; failure never blocks the spawn.
            this.write_recovery_digest(&snapshot, &working_dir, &snapshot.ts, transcript)
                .await;
            (this.emit_spawn)(&spawn);
        });
    }

    /// Builds and writes the recovery digest file for `snapshot`'s successor
    /// (`<working_dir>/.maestro/handoffs/<slug>-gen<N+1>-recovery.md`). Best
    /// effort: failures are logged, never propagated — git + GitHub are the
    /// primary reconstruction sources, the digest is only hints.
    async fn write_recovery_digest(
        &self,
        snapshot: &SessionSnapshot,
        working_dir: &str,
        ended_at: &str,
        transcript: Option<PathBuf>,
    ) {
        let epic = snapshot.epic.clone();
        let predecessor_generation = snapshot.generation;
        let predecessor_session_id = snapshot.session_id;
        let ended_at = ended_at.to_string();
        let dir = PathBuf::from(working_dir);
        let result = tokio::task::spawn_blocking(move || {
            let tail = transcript.as_deref().and_then(|path| {
                read_transcript_tail(path)
                    .map_err(|e| {
                        log::warn!(
                            "samurai replicator: could not read transcript {}: {e}",
                            path.display()
                        );
                    })
                    .ok()
            });
            let content = recovery_digest_content(
                &epic,
                predecessor_generation,
                predecessor_session_id,
                &ended_at,
                transcript.as_deref(),
                tail.as_deref(),
            );
            let path = dir.join(samurai_prompts::recovery_digest_relpath(
                &epic,
                predecessor_generation + 1,
            ));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("create {}: {e}", parent.display()))?;
            }
            std::fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => log::warn!("samurai replicator: recovery digest not written ({e})"),
            Err(e) => log::warn!("samurai replicator: recovery digest task failed ({e})"),
        }
    }

    /// Audit-linking details for a registration that matches a staged
    /// successor (issue #55 acceptance: the SPAWN row must name its
    /// predecessor). Consulted by the `samurai_register_session` command
    /// BEFORE it registers; `None` for ordinary manual registrations.
    pub fn spawn_details(
        &self,
        project: &str,
        epic: &str,
        generation: u32,
    ) -> Option<serde_json::Value> {
        self.lock_pending()
            .iter()
            .find(|p| {
                p.registered.is_none()
                    && p.generation == generation
                    && p.epic == epic
                    && p.project == project
            })
            .map(|p| {
                let mut details = json!({
                    "predecessor_session_id": p.predecessor_session_id,
                    "predecessor_generation": p.predecessor_generation,
                });
                // Issue #56: mark RECOVERY successors on their SPAWN row;
                // normal successors keep the exact P2.4 shape.
                if p.recovery {
                    details["recovery"] = json!(true);
                }
                details
            })
    }

    /// Called after every `samurai_register_session`. A registration that
    /// matches a staged (project, epic, generation) arms the ritual delivery
    /// for that session id and starts the no-start clock; everything else is
    /// a no-op.
    pub fn on_registered(&self, snapshot: &SessionSnapshot) {
        let mut pending = self.lock_pending();
        if let Some(p) = pending.iter_mut().find(|p| {
            p.registered.is_none()
                && p.generation == snapshot.generation
                && p.epic == snapshot.epic
                && p.project == snapshot.project
        }) {
            p.registered = Some((snapshot.session_id, Instant::now()));
            if p.alerted {
                // Finding G: the successor_no_start ALERT already fired, but
                // the entry was latched — a late registration still gets the
                // ritual. The alert stands as history; this recovers it.
                log::warn!(
                    "samurai replicator: LATE successor registration for epic {} gen-{} (session {}) after its successor_no_start ALERT — ritual re-armed, the stall recovered",
                    snapshot.epic,
                    snapshot.generation,
                    snapshot.session_id,
                );
            }
            log::info!(
                "samurai replicator: successor session {} registered for epic {} gen-{} — ritual armed for its first SessionStarted",
                snapshot.session_id,
                snapshot.epic,
                snapshot.generation
            );
        }
    }

    /// Hook-chain tap (forwarded by the injector's `observe_hook`, pre-dedup
    /// — same reasoning as the idle signal): an armed successor's FIRST
    /// `SessionStarted` means claude is up and sitting at its prompt, so the
    /// ritual is typed in and the entry completes. Later SessionStarted
    /// events for the same id find no entry and do nothing.
    pub fn observe_hook(&self, event: &ClaudeEvent) {
        let ClaudeEvent::SessionStarted { session_id, .. } = event else {
            return;
        };
        let ritual = {
            let mut pending = self.lock_pending();
            let index = pending
                .iter()
                .position(|p| p.registered.map(|(id, _)| id) == Some(*session_id));
            index.map(|i| pending.remove(i))
        };
        if let Some(p) = ritual {
            log::info!(
                "samurai replicator: successor session {session_id} started — delivering the gen-{} verify ritual",
                p.generation
            );
            (self.write_stdin)(*session_id, format!("{}\r", p.instruction));
        }
    }

    /// Timeout pass, driven by the injector's 30s tick: a staged successor
    /// that has not produced its `SessionStarted` within `ack_timeout_secs`
    /// (of registration — or of staging, when the frontend never registered
    /// one at all) raises a single `successor_no_start` ALERT. The entry is
    /// then KEPT, latched as alerted (fresh-eyes finding G): a successor
    /// registered late — a frontend stall past the timeout — must still get
    /// its ritual armed and delivered. Latched entries are pruned when the
    /// ritual is claimed (delivery) or when NO supervised session remains
    /// for the (project, epic) — i.e. the user tore the epic's sessions
    /// down; merely-terminal states are NOT pruned on, because
    /// killed-predecessor-and-no-successor-yet is exactly the state a late
    /// registration arrives in.
    pub fn tick(&self) {
        let timeout = Duration::from_secs(
            self.config
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .ack_timeout_secs,
        );
        // Snapshot supervised sessions BEFORE taking the pending lock — the
        // supervisor has its own lock and never calls back in here.
        let sessions = self.supervisor.list_sessions();
        struct NoStartAlert {
            project: String,
            epic: String,
            generation: u32,
            session_id: u32,
            registered: bool,
            predecessor_session_id: u32,
            predecessor_generation: u32,
        }
        let alerts: Vec<NoStartAlert> = {
            let mut pending = self.lock_pending();
            let mut alerts = Vec::new();
            pending.retain_mut(|p| {
                if p.alerted {
                    let epic_gone = !sessions
                        .iter()
                        .any(|s| s.project == p.project && s.epic == p.epic);
                    if epic_gone {
                        log::info!(
                            "samurai replicator: pruning latched successor gen-{} for epic {} — no supervised session remains for the epic",
                            p.generation,
                            p.epic,
                        );
                    }
                    return !epic_gone;
                }
                if no_start_expired(p.queued_at, p.registered.map(|(_, t)| t), timeout) {
                    p.alerted = true;
                    alerts.push(NoStartAlert {
                        project: p.project.clone(),
                        epic: p.epic.clone(),
                        generation: p.generation,
                        // Finding F: an unregistered successor has no session
                        // id of its own — 0 is a sentinel that can never
                        // collide (ProcessManager ids start at 1: its counter
                        // is initialized to 1 and hands out the pre-increment
                        // value). The predecessor's identity stays in details.
                        session_id: p.registered.map(|(id, _)| id).unwrap_or(0),
                        registered: p.registered.is_some(),
                        predecessor_session_id: p.predecessor_session_id,
                        predecessor_generation: p.predecessor_generation,
                    });
                }
                true
            });
            alerts
        };
        for a in alerts {
            log::error!(
                "samurai replicator: successor gen-{} for epic {} never started (registered: {}) — ALERT (latched; a late registration still delivers)",
                a.generation,
                a.epic,
                a.registered,
            );
            self.audit.append(
                &a.project,
                AuditEvent::now(
                    a.epic,
                    AuditEventKind::Alert,
                    a.generation,
                    a.session_id,
                    json!({
                        "kind": "successor_no_start",
                        "registered": a.registered,
                        "predecessor_session_id": a.predecessor_session_id,
                        "predecessor_generation": a.predecessor_generation,
                    }),
                ),
            );
        }
    }

    /// Recover from a poisoned lock rather than panicking — event-path
    /// policy, same as the injector and context store.
    fn lock_pending(&self) -> std::sync::MutexGuard<'_, Vec<PendingRitual>> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Test-only view of one staged ritual by successor generation:
    /// (registered session id, instruction).
    #[cfg(test)]
    fn pending_view(&self, generation: u32) -> Option<(Option<u32>, String)> {
        self.lock_pending()
            .iter()
            .find(|p| p.generation == generation)
            .map(|p| (p.registered.map(|(id, _)| id), p.instruction.clone()))
    }

    /// Test-only: how many staged rituals exist for one successor
    /// generation (idempotency checks).
    #[cfg(test)]
    fn pending_count(&self, generation: u32) -> usize {
        self.lock_pending()
            .iter()
            .filter(|p| p.generation == generation)
            .count()
    }

    /// Test-only: age a staged ritual's clocks so timeout paths run without
    /// real waiting.
    #[cfg(test)]
    fn backdate(&self, generation: u32, by: Duration) {
        let mut pending = self.lock_pending();
        let p = pending
            .iter_mut()
            .find(|p| p.generation == generation)
            .expect("no staged ritual");
        p.queued_at = p.queued_at.checked_sub(by).expect("backdate underflow");
        if let Some((id, at)) = p.registered {
            p.registered = Some((id, at.checked_sub(by).expect("backdate underflow")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::process_manager::ProcessManager;
    use crate::core::samurai_config::SamuraiConfig;
    use crate::core::samurai_context::SamuraiContextStore;
    use crate::core::samurai_injector::SamuraiInjector;
    use std::collections::HashMap;
    use std::sync::RwLock;
    use tempfile::tempdir;

    const SHA_TIMEOUT: Duration = Duration::from_secs(180); // default ack_timeout_secs

    /// Recorded side effects + the replicator under test, wired to a real
    /// supervisor and audit log in a temp dir.
    struct Harness {
        replicator: Arc<SamuraiReplicator>,
        supervisor: Arc<Supervisor>,
        audit: AuditLog,
        dirs: Arc<Mutex<HashMap<u32, String>>>,
        transcripts: Arc<Mutex<HashMap<u32, PathBuf>>>,
        torn_down: Arc<Mutex<Vec<u32>>>,
        spawns: Arc<Mutex<Vec<SuccessorSpawn>>>,
        writes: Arc<Mutex<Vec<(u32, String)>>>,
        config: SharedSamuraiConfig,
    }

    fn harness(dir: &Path) -> Harness {
        let (audit, task) = AuditLog::new(dir.to_path_buf(), None);
        tokio::spawn(task);
        let supervisor = Arc::new(Supervisor::new(audit.clone(), None));
        let config: SharedSamuraiConfig = Arc::new(RwLock::new(SamuraiConfig::default()));
        let dirs: Arc<Mutex<HashMap<u32, String>>> = Arc::new(Mutex::new(HashMap::new()));
        let dirs_for_resolver = dirs.clone();
        let session_dirs: SessionDirResolver =
            Arc::new(move |id| dirs_for_resolver.lock().unwrap().get(&id).cloned());
        let transcripts: Arc<Mutex<HashMap<u32, PathBuf>>> = Arc::new(Mutex::new(HashMap::new()));
        let transcripts_for_resolver = transcripts.clone();
        let transcript_paths: TranscriptPathResolver =
            Arc::new(move |id| transcripts_for_resolver.lock().unwrap().get(&id).cloned());

        let torn_down: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
        let torn_down_rec = torn_down.clone();
        let teardown: SessionTeardown = Arc::new(move |id| {
            let rec = torn_down_rec.clone();
            Box::pin(async move {
                rec.lock().unwrap().push(id);
            })
        });

        let spawns: Arc<Mutex<Vec<SuccessorSpawn>>> = Arc::new(Mutex::new(Vec::new()));
        let spawns_rec = spawns.clone();
        let emit_spawn: SuccessorEmitter = Arc::new(move |s| {
            spawns_rec.lock().unwrap().push(s.clone());
        });

        let writes: Arc<Mutex<Vec<(u32, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let writes_rec = writes.clone();
        let write_stdin: StdinWriter = Arc::new(move |id, data| {
            writes_rec.lock().unwrap().push((id, data));
        });

        let replicator = Arc::new(SamuraiReplicator::new(
            supervisor.clone(),
            audit.clone(),
            config.clone(),
            session_dirs,
            transcript_paths,
            teardown,
            emit_spawn,
            write_stdin,
        ));
        Harness {
            replicator,
            supervisor,
            audit,
            dirs,
            transcripts,
            torn_down,
            spawns,
            writes,
            config,
        }
    }

    /// `git init` + one commit, returning nothing; identity is repo-local.
    fn init_repo(dir: &Path) {
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .hide_console_window()
                .output()
                .expect("git must be runnable in tests");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("tracked.txt"), "v1\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["commit", "-q", "-m", "init"]);
    }

    /// Writes a §6-shaped handoff for `epic`/`generation` whose Repo state
    /// records `sha`.
    fn write_handoff(dir: &Path, epic: &str, generation: u32, sha: &str) {
        let rel = samurai_prompts::handoff_file_relpath(epic, generation);
        let path = dir.join(&rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!(
                "# Handoff — epic {epic} — gen {generation}\n\
                 ## Goal\nship it\n\
                 ## Repo state\nbranch main, HEAD SHA: {sha}\n\
                 ## Verify\ncargo test\n\
                 ## Next steps\n1. next\n"
            ),
        )
        .unwrap();
    }

    /// Registers session 1 and walks it to HANDOFF_WRITTEN, returning that
    /// snapshot (the exact value the injector hands to the replicator).
    fn to_handoff_written(
        supervisor: &Supervisor,
        project: &str,
        epic: &str,
        generation: u32,
    ) -> SessionSnapshot {
        supervisor
            .register_session(1, project.into(), epic.into(), generation)
            .unwrap();
        supervisor
            .transition(1, SupervisorState::HandoffRequested)
            .unwrap();
        supervisor
            .transition(1, SupervisorState::HandoffWritten)
            .unwrap()
    }

    /// Polls until `cond` holds or ~2s pass (replicate runs on the tauri
    /// runtime, not this test's).
    async fn wait_until(mut cond: impl FnMut() -> bool) {
        for _ in 0..200 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not reached within 2s");
    }

    fn state_of(supervisor: &Supervisor, session_id: u32) -> Option<SupervisorState> {
        supervisor
            .list_sessions()
            .into_iter()
            .find(|s| s.session_id == session_id)
            .map(|s| s.state)
    }

    // --- pure decisions ---

    #[test]
    fn test_head_matches_table() {
        let a = "0123456789abcdef0123456789abcdef01234567";
        // (handoff, head, expected)
        let table = [
            (Some(a), Some(a), true),
            // Models re-type SHAs; case must not defeat the gate.
            (Some("ABCDEF0000000000000000000000000000000000"), Some("abcdef0000000000000000000000000000000000"), true),
            (Some(a), Some("f000000000000000000000000000000000000000"), false),
            (None, Some(a), false), // unparseable handoff → verify required
            (Some(a), None, false), // unreadable HEAD → verify required
            (None, None, false),
        ];
        for (handoff, head, expected) in table {
            assert_eq!(head_matches(handoff, head), expected, "{handoff:?} vs {head:?}");
        }
    }

    #[test]
    fn test_no_start_expiry_is_strict_and_prefers_registration_clock() {
        let timeout = Duration::from_secs(180);
        let now = Instant::now();
        let old = now.checked_sub(Duration::from_secs(181)).unwrap();
        // Unregistered: the queue clock decides.
        assert!(no_start_expired(old, None, timeout));
        assert!(!no_start_expired(now, None, timeout));
        // Registration resets the clock even when the queue clock expired.
        assert!(!no_start_expired(old, Some(now), timeout));
        assert!(no_start_expired(now, Some(old), timeout));
    }

    #[test]
    fn test_parse_owner_repo_https_and_ssh_forms() {
        // (url, expected) — tolerant of the common spellings, None otherwise.
        let table: [(&str, Option<&str>); 14] = [
            ("https://github.com/nachogl1/maestro.git", Some("nachogl1/maestro")),
            ("https://github.com/nachogl1/maestro", Some("nachogl1/maestro")),
            ("https://github.com/nachogl1/maestro/", Some("nachogl1/maestro")),
            ("http://github.com/o/r.git", Some("o/r")),
            ("https://user:token@github.com/o/r.git", Some("o/r")),
            ("git@github.com:o/r.git", Some("o/r")),
            ("git@github.com:o/r", Some("o/r")),
            ("ssh://git@github.com/o/r.git", Some("o/r")),
            ("  https://github.com/o/r.git \n", Some("o/r")),
            // Not owner/repo shapes: local paths, drives, deeper paths.
            (r"C:\git\maestro", None),
            ("/home/x/repo", None),
            ("https://gitlab.com/group/sub/repo.git", None),
            ("https://github.com/only-owner", None),
            ("", None),
        ];
        for (url, expected) in table {
            assert_eq!(
                parse_owner_repo(url).as_deref(),
                expected,
                "url {url:?}"
            );
        }
    }

    #[test]
    fn test_read_repo_head_matches_git() {
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let head = read_repo_head(repo.path()).unwrap();
        assert_eq!(head.len(), 40);
        assert!(head.bytes().all(|b| b.is_ascii_hexdigit()));
        // And a non-repo directory fails instead of inventing a SHA.
        let empty = tempdir().unwrap();
        assert!(read_repo_head(empty.path()).is_err());
    }

    // --- kill → stage chain ---

    #[tokio::test]
    async fn test_handoff_written_kills_and_stages_successor_with_head_match() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-match";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let head = read_repo_head(repo.path()).unwrap();
        write_handoff(repo.path(), "epic-9", 2, &head);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        let snapshot = to_handoff_written(&h.supervisor, project, "epic-9", 2);

        h.replicator.on_handoff_written(&snapshot);
        wait_until(|| state_of(&h.supervisor, 1) == Some(SupervisorState::Killed)).await;
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;

        // Full teardown ran, once, before the transition.
        assert_eq!(*h.torn_down.lock().unwrap(), vec![1]);

        // The audit trail carries the killed phase.
        let mut rows = Vec::new();
        for _ in 0..200 {
            rows = h.audit.read(project, None, None).await.unwrap().events;
            if rows
                .iter()
                .any(|r| r.event == AuditEventKind::Handoff && r.details["phase"] == "killed")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(rows
            .iter()
            .any(|r| r.event == AuditEventKind::Handoff && r.details["phase"] == "killed"));

        // The spawn event names the successor and its stable working dir.
        let spawns = h.spawns.lock().unwrap();
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0].project, project);
        assert_eq!(spawns[0].epic, "epic-9");
        assert_eq!(spawns[0].generation, 3);
        assert_eq!(spawns[0].session_name, "samurai gen-3 epic-9");
        assert_eq!(
            spawns[0].working_dir,
            strip_extended_prefix(&repo.path().to_string_lossy()).to_string()
        );

        // HEAD matched → the staged ritual skips verify.
        let (registered, instruction) = h.replicator.pending_view(3).unwrap();
        assert_eq!(registered, None);
        assert!(instruction.contains("SKIP"));
        assert!(instruction.contains("generation 3"));
        assert!(!instruction.contains('\n'));
    }

    #[tokio::test]
    async fn test_head_mismatch_stages_verify_required_ritual() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        // Handoff records a SHA that is NOT the repo's HEAD.
        write_handoff(repo.path(), "epic-9", 2, &"f".repeat(40));
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        let snapshot = to_handoff_written(&h.supervisor, "C:/git/proj-rep-mismatch", "epic-9", 2);

        h.replicator.on_handoff_written(&snapshot);
        wait_until(|| h.replicator.pending_view(3).is_some()).await;

        let (_, instruction) = h.replicator.pending_view(3).unwrap();
        assert!(instruction.contains("MUST run every command"));
        assert!(!instruction.contains("SKIP"));
    }

    #[tokio::test]
    async fn test_present_handoff_in_broken_repo_defaults_to_verify_required() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        // The handoff file is present but the working dir is not a git repo:
        // the HEAD gate cannot confirm anything → normal ritual, verify
        // required (NOT recovery — that is only for a missing handoff).
        let not_a_repo = tempdir().unwrap();
        write_handoff(not_a_repo.path(), "epic-9", 2, &"f".repeat(40));
        h.dirs
            .lock()
            .unwrap()
            .insert(1, not_a_repo.path().to_string_lossy().into_owned());
        let snapshot = to_handoff_written(&h.supervisor, "C:/git/proj-rep-broken", "epic-9", 2);

        h.replicator.on_handoff_written(&snapshot);
        wait_until(|| state_of(&h.supervisor, 1) == Some(SupervisorState::Killed)).await;
        wait_until(|| h.replicator.pending_view(3).is_some()).await;
        let (_, instruction) = h.replicator.pending_view(3).unwrap();
        assert!(instruction.contains("MUST run every command"));
        assert!(!instruction.contains("RECOVERY"));
    }

    #[tokio::test]
    async fn test_unknown_working_dir_alerts_and_does_not_kill() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-nodir";
        // No dir registered for session 1.
        let snapshot = to_handoff_written(&h.supervisor, project, "epic-9", 2);

        h.replicator.on_handoff_written(&snapshot);

        // Synchronous refusal: no teardown, no spawn, state untouched.
        assert!(h.torn_down.lock().unwrap().is_empty());
        assert!(h.spawns.lock().unwrap().is_empty());
        assert_eq!(state_of(&h.supervisor, 1), Some(SupervisorState::HandoffWritten));
        let mut alerts = 0;
        for _ in 0..200 {
            let rows = h.audit.read(project, None, None).await.unwrap().events;
            alerts = rows
                .iter()
                .filter(|r| r.details["kind"] == "successor_spawn_failed")
                .count();
            if alerts > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(alerts, 1);
    }

    // --- registration → SessionStarted → delivery ---

    /// Stages a gen-3 successor for epic-9 (HEAD mismatch variant — the
    /// gate does not matter for the delivery tests) and returns the project.
    async fn stage_successor(h: &Harness, project: &str) {
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        write_handoff(repo.path(), "epic-9", 2, &"f".repeat(40));
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        let snapshot = to_handoff_written(&h.supervisor, project, "epic-9", 2);
        h.replicator.on_handoff_written(&snapshot);
        wait_until(|| h.replicator.pending_view(3).is_some()).await;
    }

    fn session_started(session_id: u32) -> ClaudeEvent {
        ClaudeEvent::SessionStarted {
            session_id,
            claude_session_uuid: "u".into(),
            transcript_path: "p".into(),
            timestamp: "t".into(),
        }
    }

    #[tokio::test]
    async fn test_registration_arms_and_first_session_started_delivers() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-arm";
        stage_successor(&h, project).await;

        // The registration command's flow: linking details, register with
        // them, notify the replicator.
        let details = h.replicator.spawn_details(project, "epic-9", 3).unwrap();
        assert_eq!(details["predecessor_session_id"], 1);
        assert_eq!(details["predecessor_generation"], 2);
        let snapshot = h
            .supervisor
            .register_session_with_details(2, project.into(), "epic-9".into(), 3, details)
            .unwrap();
        h.replicator.on_registered(&snapshot);
        assert_eq!(h.replicator.pending_view(3).unwrap().0, Some(2));

        // The successor's SPAWN row links it to its predecessor.
        let mut spawn_rows = Vec::new();
        for _ in 0..200 {
            let rows = h.audit.read(project, None, None).await.unwrap().events;
            spawn_rows = rows
                .into_iter()
                .filter(|r| r.event == AuditEventKind::Spawn && r.session_id == 2)
                .collect();
            if !spawn_rows.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(spawn_rows.len(), 1);
        assert_eq!(spawn_rows[0].details["predecessor_session_id"], 1);
        assert_eq!(spawn_rows[0].details["predecessor_generation"], 2);
        assert_eq!(spawn_rows[0].details["state"], "WORKING");
        assert_eq!(spawn_rows[0].generation, 3);

        // A SessionStarted for an UNRELATED session delivers nothing.
        h.replicator.observe_hook(&session_started(99));
        assert!(h.writes.lock().unwrap().is_empty());

        // The armed session's first SessionStarted delivers ritual + \r.
        h.replicator.observe_hook(&session_started(2));
        let writes = h.writes.lock().unwrap().clone();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, 2);
        assert!(writes[0].1.ends_with('\r'));
        assert_eq!(writes[0].1.matches('\r').count(), 1, "exactly the final CR");
        assert!(!writes[0].1.contains('\n'));
        assert!(writes[0].1.contains("generation 3"));
        assert!(writes[0].1.contains(".maestro/handoffs/epic-9-gen2.md"));

        // Delivery completes the entry: a restart never re-injects.
        assert!(h.replicator.pending_view(3).is_none());
        h.replicator.observe_hook(&session_started(2));
        assert_eq!(h.writes.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_registration_for_other_epic_or_generation_does_not_arm() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-other";
        stage_successor(&h, project).await;

        // Wrong generation and wrong epic: no linking details, no arming.
        assert!(h.replicator.spawn_details(project, "epic-9", 4).is_none());
        assert!(h.replicator.spawn_details(project, "epic-x", 3).is_none());
        let snapshot = h
            .supervisor
            .register_session(7, project.into(), "epic-x".into(), 3)
            .unwrap();
        h.replicator.on_registered(&snapshot);
        assert_eq!(h.replicator.pending_view(3).unwrap().0, None);
    }

    #[tokio::test]
    async fn test_registered_successor_that_never_starts_alerts_once() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-nostart";
        stage_successor(&h, project).await;
        let details = h.replicator.spawn_details(project, "epic-9", 3).unwrap();
        let snapshot = h
            .supervisor
            .register_session_with_details(2, project.into(), "epic-9".into(), 3, details)
            .unwrap();
        h.replicator.on_registered(&snapshot);

        // Inside the window: kept.
        h.replicator.tick();
        assert!(h.replicator.pending_view(3).is_some());

        // Past ack_timeout_secs of registration: single ALERT — and the
        // entry stays, latched (finding G), because the successor might
        // still start late.
        h.replicator.backdate(3, SHA_TIMEOUT + Duration::from_secs(1));
        h.replicator.tick();
        assert!(
            h.replicator.pending_view(3).is_some(),
            "the latched entry survives its ALERT (finding G)"
        );
        let mut alerts = Vec::new();
        for _ in 0..200 {
            let rows = h.audit.read(project, None, None).await.unwrap().events;
            alerts = rows
                .into_iter()
                .filter(|r| r.details["kind"] == "successor_no_start")
                .collect();
            if !alerts.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].session_id, 2);
        assert_eq!(alerts[0].generation, 3);
        assert_eq!(alerts[0].details["registered"], true);
        assert_eq!(alerts[0].details["predecessor_session_id"], 1);

        // Further ticks stay quiet (never re-alerts) …
        h.replicator.tick();
        let rows = h.audit.read(project, None, None).await.unwrap().events;
        assert_eq!(
            rows.iter()
                .filter(|r| r.details["kind"] == "successor_no_start")
                .count(),
            1
        );
        // … and a LATE SessionStarted still delivers the ritual — the whole
        // point of latching (finding G) — completing the entry.
        h.replicator.observe_hook(&session_started(2));
        let writes = h.writes.lock().unwrap().clone();
        assert_eq!(writes.len(), 1, "late start still gets the ritual");
        assert_eq!(writes[0].0, 2);
        assert!(h.replicator.pending_view(3).is_none(), "claimed = pruned");
    }

    #[tokio::test]
    async fn test_never_registered_successor_alerts_from_staging_clock() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-noreg";
        stage_successor(&h, project).await;

        h.replicator.backdate(3, SHA_TIMEOUT + Duration::from_secs(1));
        h.replicator.tick();
        // Latched, not deleted (finding G).
        assert!(h.replicator.pending_view(3).is_some());
        let mut alerts = Vec::new();
        for _ in 0..200 {
            let rows = h.audit.read(project, None, None).await.unwrap().events;
            alerts = rows
                .into_iter()
                .filter(|r| r.details["kind"] == "successor_no_start")
                .collect();
            if !alerts.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].details["registered"], false);
        // Finding F: no successor session id exists — the row carries the
        // 0 sentinel (never a real id; ProcessManager ids start at 1), and
        // the predecessor identity rides in details, not the id column.
        assert_eq!(alerts[0].session_id, 0);
        assert_eq!(alerts[0].details["predecessor_session_id"], 1);
        assert_eq!(alerts[0].details["predecessor_generation"], 2);
    }

    #[tokio::test]
    async fn test_late_registration_after_alert_still_delivers_ritual() {
        // Finding G end-to-end: timeout → ALERT → late registration → the
        // ritual is still armed and delivered, with exactly one ALERT total.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-late";
        stage_successor(&h, project).await;

        h.replicator.backdate(3, SHA_TIMEOUT + Duration::from_secs(1));
        h.replicator.tick();
        assert!(h.replicator.pending_view(3).is_some(), "latched");

        // The frontend recovers from its stall and registers gen-3 late.
        let details = h
            .replicator
            .spawn_details(project, "epic-9", 3)
            .expect("a latched entry still links its registration");
        assert_eq!(details["predecessor_session_id"], 1);
        let snapshot = h
            .supervisor
            .register_session_with_details(2, project.into(), "epic-9".into(), 3, details)
            .unwrap();
        h.replicator.on_registered(&snapshot);
        assert_eq!(h.replicator.pending_view(3).unwrap().0, Some(2));

        // First SessionStarted delivers as if nothing had happened.
        h.replicator.observe_hook(&session_started(2));
        let writes = h.writes.lock().unwrap().clone();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, 2);
        assert!(writes[0].1.ends_with('\r'));
        assert!(h.replicator.pending_view(3).is_none());

        // Exactly one successor_no_start ALERT in the whole flow.
        let rows = h.audit.read(project, None, None).await.unwrap().events;
        assert_eq!(
            rows.iter()
                .filter(|r| r.details["kind"] == "successor_no_start")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn test_latched_entry_prunes_when_epic_sessions_are_gone() {
        // Finding G's GC: a latched entry is dropped once NO supervised
        // session remains for its (project, epic) — the user tore the epic
        // down (finding H's removal paths) — but never merely because the
        // predecessor is in a terminal state (that is the normal
        // between-generations window a late registration arrives in).
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-prune";
        stage_successor(&h, project).await;
        h.replicator.backdate(3, SHA_TIMEOUT + Duration::from_secs(1));
        h.replicator.tick();
        assert!(h.replicator.pending_view(3).is_some(), "latched");

        // The predecessor's KILLED entry still exists → kept.
        h.replicator.tick();
        assert!(h.replicator.pending_view(3).is_some());

        // The user closes the epic's tile: supervisor entry removed → the
        // next tick prunes the latched ritual.
        assert!(h.supervisor.remove_session(1));
        h.replicator.tick();
        assert!(h.replicator.pending_view(3).is_none());

        // Still exactly one ALERT.
        let rows = h.audit.read(project, None, None).await.unwrap().events;
        assert_eq!(
            rows.iter()
                .filter(|r| r.details["kind"] == "successor_no_start")
                .count(),
            1
        );
    }

    // --- full P2.3 → P2.4 chain through the injector's public surface ---

    #[tokio::test]
    async fn test_validated_handoff_chains_from_injector_to_kill_and_stage() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-chain";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let head = read_repo_head(repo.path()).unwrap();
        write_handoff(repo.path(), "epic-9", 2, &head);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());

        // A real injector wired to THIS replicator: the P2.3 validation's
        // success must hand over without any polling glue.
        let dirs_for_resolver = h.dirs.clone();
        let session_dirs: SessionDirResolver =
            Arc::new(move |id| dirs_for_resolver.lock().unwrap().get(&id).cloned());
        let context = Arc::new(SamuraiContextStore::new());
        let injector = SamuraiInjector::new(
            h.supervisor.clone(),
            context.clone(),
            h.config.clone(),
            ProcessManager::new(),
            h.audit.clone(),
            session_dirs,
            Some(h.replicator.clone()),
        );

        h.supervisor
            .register_session(1, project.into(), "epic-9".into(), 2)
            .unwrap();
        context.observe(&ClaudeEvent::ContextUsageUpdate {
            session_id: 1,
            model: "claude-opus-4".into(),
            context_tokens: 90_000,
            context_window: 200_000,
            percent: 50.0,
            timestamp: "t".into(),
        });
        // Trigger (already idle → immediate injection), then ACK + marker.
        injector.observe_hook(&ClaudeEvent::SessionEnded {
            session_id: 1,
            reason: "stop".into(),
            timestamp: "t".into(),
        });
        injector.tick();
        injector.observe(&ClaudeEvent::AssistantMessage {
            session_id: 1,
            uuid: "u1".into(),
            text: "<samurai-ack>handoff gen-2</samurai-ack>".into(),
            model: "m".into(),
            token_usage: None,
            timestamp: "t".into(),
        });
        injector.observe(&ClaudeEvent::AssistantMessage {
            session_id: 1,
            uuid: "u2".into(),
            text: "<samurai-handoff-written>gen-2</samurai-handoff-written>".into(),
            model: "m".into(),
            token_usage: None,
            timestamp: "t".into(),
        });

        // Validation → HANDOFF_WRITTEN → replicator → teardown → KILLED →
        // successor staged + spawn event emitted.
        wait_until(|| state_of(&h.supervisor, 1) == Some(SupervisorState::Killed)).await;
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;
        assert_eq!(*h.torn_down.lock().unwrap(), vec![1]);
        assert_eq!(h.spawns.lock().unwrap()[0].generation, 3);
        let (_, instruction) = h.replicator.pending_view(3).unwrap();
        assert!(instruction.contains("SKIP"), "HEAD matched → verify skipped");
    }

    // --- issue #56: recovery digest extraction ---

    /// A transcript user-message line with one text block.
    fn user_line(text: &str) -> String {
        format!(
            r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"text","text":{}}}]}},"uuid":"u","timestamp":"t"}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    /// A transcript assistant-message line with one text block.
    fn assistant_line(text: &str) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"model":"m","content":[{{"type":"text","text":{}}}]}},"uuid":"a","timestamp":"t"}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    /// A transcript line carrying a completed sub-agent's tool result.
    fn subagent_line() -> String {
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"done"}]},"toolUseResult":{"status":"completed","agentId":"agent-7","content":[{"type":"text","text":"review finished: all good"}]},"uuid":"u","timestamp":"t"}"#
            .to_string()
    }

    #[test]
    fn test_digest_missing_transcript_notes_and_header() {
        let content =
            recovery_digest_content("epic-9", 2, 1, "2026-08-06T12:00:00Z", None, None);
        assert!(content.contains("# Samurai recovery digest — epic epic-9 — for gen 3"));
        assert!(content.contains("generation 2, session 1"));
        assert!(content.contains("Ended at: 2026-08-06T12:00:00Z"));
        assert!(content.contains("Source transcript: none"));
        assert!(content.contains("No transcript available"));
    }

    #[test]
    fn test_digest_tail_is_bounded_and_keeps_the_most_recent_content() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        let mut file = String::new();
        // Early content that must fall outside the bounded tail …
        file.push_str(&user_line("EARLY MARKER that must never appear"));
        file.push('\n');
        // … under >256KB of padding …
        let padding = "pad ".repeat(150);
        for _ in 0..500 {
            file.push_str(&assistant_line(&padding));
            file.push('\n');
        }
        // … then the exchanges the digest is for.
        file.push_str(&user_line("last real user question"));
        file.push('\n');
        for i in 1..=12 {
            file.push_str(&assistant_line(&format!("assistant reply {i}")));
            file.push('\n');
        }
        file.push_str(&subagent_line());
        file.push('\n');
        std::fs::write(&path, &file).unwrap();
        assert!(
            file.len() as u64 > DIGEST_TAIL_BYTES,
            "fixture must exceed the tail window"
        );

        let tail = read_transcript_tail(&path).unwrap();
        assert!(tail.len() as u64 <= DIGEST_TAIL_BYTES);
        let content = recovery_digest_content("epic-9", 2, 1, "ts", Some(&path), Some(&tail));

        // The most recent exchanges are kept, the assistant window holds
        // only the last 10 (replies 1-2 and all padding fall out) …
        assert!(content.contains("last real user question"));
        assert!(content.contains("assistant reply 12"));
        assert!(content.contains("assistant reply 3"));
        assert!(!content.contains("assistant reply 2"));
        assert!(!content.contains("pad pad"));
        // … everything before the tail window is gone …
        assert!(!content.contains("EARLY MARKER"));
        // … and the sub-agent completion made it in.
        assert!(content.contains("- agent toolu_x (completed): review finished: all good"));
    }

    #[test]
    fn test_digest_truncates_snippets_and_strips_ansi() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let long = "x".repeat(600);
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                assistant_line(&format!("\u{1b}[31mred\u{1b}[0m alert {long}")),
                user_line("final \u{1b}[1mbold\u{1b}[0m question"),
            ),
        )
        .unwrap();
        let tail = read_transcript_tail(&path).unwrap();
        let content = recovery_digest_content("epic-9", 2, 1, "ts", Some(&path), Some(&tail));
        // Per-snippet cap with the truncation marker; ANSI stripped.
        assert!(content.contains("[... truncated ...]"));
        assert!(!content.contains(&long));
        assert!(content.contains("red alert"));
        assert!(content.contains("final bold question"));
        assert!(!content.contains('\u{1b}'));
    }

    #[test]
    fn test_digest_whole_file_is_hard_capped() {
        let mut file = String::new();
        for i in 0..10 {
            file.push_str(&assistant_line(&format!("{i} {}", "y".repeat(600))));
            file.push('\n');
        }
        let content = recovery_digest_content("epic-9", 2, 1, "ts", None, Some(&file));
        // 10 snippets × 500 chars would blow past the cap; the whole digest
        // is clamped (+ small allowance for the truncation marker itself).
        assert!(
            content.chars().count() <= DIGEST_MAX_CHARS + 20,
            "digest is {} chars",
            content.chars().count()
        );
    }

    // --- issue #56 trigger (b): handoff vanished at successor-prep time ---

    #[tokio::test]
    async fn test_vanished_handoff_stages_recovery_successor() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-vanish";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        // NO handoff file: it vanished between validation and prep.
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        // The predecessor's transcript is resolvable (pre-teardown).
        let transcript = repo.path().join("transcript.jsonl");
        std::fs::write(
            &transcript,
            format!("{}\n", assistant_line("the final words of gen-2")),
        )
        .unwrap();
        h.transcripts.lock().unwrap().insert(1, transcript.clone());
        let snapshot = to_handoff_written(&h.supervisor, project, "epic-9", 2);

        h.replicator.on_handoff_written(&snapshot);
        wait_until(|| state_of(&h.supervisor, 1) == Some(SupervisorState::Killed)).await;
        wait_until(|| h.replicator.pending_view(3).is_some()).await;

        // The kill still happened (this is the killed path, not DEAD) …
        assert_eq!(*h.torn_down.lock().unwrap(), vec![1]);
        // … but the staged instruction is the RECOVERY ritual.
        let (_, instruction) = h.replicator.pending_view(3).unwrap();
        assert!(instruction.contains("RECOVERY MODE"));
        assert!(instruction.contains(".maestro/handoffs/epic-9-gen3-recovery.md"));
        assert!(!instruction.contains("MUST run every command"));
        assert!(!instruction.contains('\n'));
        // The digest file was written before staging, from the transcript.
        let digest = std::fs::read_to_string(
            repo.path().join(".maestro/handoffs/epic-9-gen3-recovery.md"),
        )
        .unwrap();
        assert!(digest.contains("the final words of gen-2"));
        assert!(digest.contains("for gen 3"));
        // The SPAWN linkage marks recovery.
        let details = h.replicator.spawn_details(project, "epic-9", 3).unwrap();
        assert_eq!(details["recovery"], true);
        assert_eq!(details["predecessor_session_id"], 1);
        // The spawn event is the exact shape the frontend already handles.
        let spawns = h.spawns.lock().unwrap();
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0].generation, 3);
        assert_eq!(spawns[0].session_name, "samurai gen-3 epic-9");
    }

    // --- issue #56 trigger (a): DEAD → recovery spawn ---

    /// Registers session 1 and declares it DEAD, returning that snapshot
    /// (the exact value the supervisor's change callback hands to on_dead).
    fn to_dead(
        supervisor: &Supervisor,
        project: &str,
        epic: &str,
        generation: u32,
    ) -> SessionSnapshot {
        supervisor
            .register_session(1, project.into(), epic.into(), generation)
            .unwrap();
        supervisor.transition(1, SupervisorState::Dead).unwrap()
    }

    #[tokio::test]
    async fn test_dead_stages_exactly_one_recovery_successor() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-dead";
        let repo = tempdir().unwrap();
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        let snapshot = to_dead(&h.supervisor, project, "epic-9", 2);

        h.replicator.on_dead(&snapshot);

        // Staging is synchronous, and the dead session's terminal is NOT
        // torn down — the tile stays for the human to dismiss.
        assert_eq!(h.replicator.pending_count(3), 1);
        assert!(h.torn_down.lock().unwrap().is_empty());
        let (_, instruction) = h.replicator.pending_view(3).unwrap();
        assert!(instruction.contains("RECOVERY MODE"));

        // One spawn event, emitted after the digest file is written.
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;
        {
            let spawns = h.spawns.lock().unwrap();
            assert_eq!(spawns.len(), 1);
            assert_eq!(spawns[0].project, project);
            assert_eq!(spawns[0].epic, "epic-9");
            assert_eq!(spawns[0].generation, 3);
            assert_eq!(spawns[0].session_name, "samurai gen-3 epic-9");
        }
        // No transcript was resolvable → the digest still exists, noted.
        let digest = std::fs::read_to_string(
            repo.path().join(".maestro/handoffs/epic-9-gen3-recovery.md"),
        )
        .unwrap();
        assert!(digest.contains("No transcript available"));
        assert!(digest.contains("Source transcript: none"));

        // Idempotency: a repeated DEAD notification changes nothing.
        h.replicator.on_dead(&snapshot);
        assert_eq!(h.replicator.pending_count(3), 1);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(h.spawns.lock().unwrap().len(), 1);

        // Registration links + marks the SPAWN row; delivery is unchanged.
        let details = h.replicator.spawn_details(project, "epic-9", 3).unwrap();
        assert_eq!(details["recovery"], true);
        assert_eq!(details["predecessor_session_id"], 1);
        assert_eq!(details["predecessor_generation"], 2);
        let registered = h
            .supervisor
            .register_session_with_details(2, project.into(), "epic-9".into(), 3, details)
            .unwrap();
        h.replicator.on_registered(&registered);
        h.replicator.observe_hook(&session_started(2));
        let writes = h.writes.lock().unwrap().clone();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, 2);
        assert!(writes[0].1.contains("RECOVERY MODE"));
        assert!(writes[0].1.ends_with('\r'));
        assert_eq!(writes[0].1.matches('\r').count(), 1, "exactly the final CR");

        // The successor's SPAWN audit row carries the recovery mark.
        let mut spawn_rows = Vec::new();
        for _ in 0..200 {
            let rows = h.audit.read(project, None, None).await.unwrap().events;
            spawn_rows = rows
                .into_iter()
                .filter(|r| r.event == AuditEventKind::Spawn && r.session_id == 2)
                .collect();
            if !spawn_rows.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(spawn_rows.len(), 1);
        assert_eq!(spawn_rows[0].details["recovery"], true);
        assert_eq!(spawn_rows[0].details["predecessor_session_id"], 1);
        assert_eq!(spawn_rows[0].generation, 3);
    }

    #[tokio::test]
    async fn test_dead_recovery_digest_uses_predecessor_transcript() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let repo = tempdir().unwrap();
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        // The watchdog never stops the watcher, so the transcript resolves.
        let transcript = repo.path().join("dead.jsonl");
        std::fs::write(
            &transcript,
            format!(
                "{}\n{}\n",
                user_line("please finish issue 42"),
                assistant_line("starting on issue 42 now"),
            ),
        )
        .unwrap();
        h.transcripts.lock().unwrap().insert(1, transcript.clone());
        let snapshot = to_dead(&h.supervisor, "C:/git/proj-rep-dead-t", "epic-9", 2);

        h.replicator.on_dead(&snapshot);
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;

        let digest = std::fs::read_to_string(
            repo.path().join(".maestro/handoffs/epic-9-gen3-recovery.md"),
        )
        .unwrap();
        assert!(digest.contains("please finish issue 42"));
        assert!(digest.contains("starting on issue 42 now"));
        assert!(digest.contains(&transcript.display().to_string()));
        // The DEAD snapshot's timestamp is the recorded end.
        assert!(digest.contains(&format!("Ended at: {}", snapshot.ts)));
    }

    #[tokio::test]
    async fn test_dead_recovery_prompt_is_repo_pinned_when_origin_parses() {
        // Finding D: the recovery ritual must pin `gh --repo` (PRD §10).
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(repo.path())
                .hide_console_window()
                .output()
                .expect("git must be runnable in tests");
            assert!(out.status.success());
        };
        run(&["remote", "add", "origin", "https://github.com/nachogl1/maestro.git"]);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        let snapshot = to_dead(&h.supervisor, "C:/git/proj-rep-pin", "epic-9", 2);

        h.replicator.on_dead(&snapshot);
        // The pin swap happens in the async task strictly before the spawn
        // event, so once the spawn is out the instruction is final.
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;

        let (_, instruction) = h.replicator.pending_view(3).unwrap();
        assert!(instruction.contains("RECOVERY MODE"));
        assert_eq!(
            instruction.matches("--repo nachogl1/maestro").count(),
            2,
            "issue read AND takeover comment must be pinned: {instruction}"
        );
        assert!(!instruction.contains("CAUTION"));
        assert!(!instruction.contains('\n'), "still a single pasteable line");
    }

    #[tokio::test]
    async fn test_dead_recovery_prompt_without_origin_keeps_caution() {
        // Finding D fallback: unparseable/missing remote → unpinned wording
        // plus the explicit caution; recovery is never blocked.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let repo = tempdir().unwrap(); // not even a git repo
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        let snapshot = to_dead(&h.supervisor, "C:/git/proj-rep-nopin", "epic-9", 2);

        h.replicator.on_dead(&snapshot);
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;

        let (_, instruction) = h.replicator.pending_view(3).unwrap();
        assert!(instruction.contains("RECOVERY MODE"));
        // No pinned `gh` usage (the caution itself mentions the missing pin).
        assert!(!instruction.contains("passing `--repo"));
        assert!(instruction.contains("CAUTION"));
        assert!(!instruction.contains('\n'));
    }

    #[tokio::test]
    async fn test_dead_trigger_guards_state_and_unknown_dir() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-dead-guard";
        // A non-DEAD snapshot is a no-op (the lib.rs callback filters on
        // DEAD, but the API must be safe against misuse).
        let working = h
            .supervisor
            .register_session(1, project.into(), "epic-9".into(), 2)
            .unwrap();
        h.replicator.on_dead(&working);
        assert_eq!(h.replicator.pending_count(3), 0);

        // DEAD with no resolvable working dir: ALERT, nothing staged.
        let dead = h.supervisor.transition(1, SupervisorState::Dead).unwrap();
        h.replicator.on_dead(&dead);
        assert_eq!(h.replicator.pending_count(3), 0);
        assert!(h.spawns.lock().unwrap().is_empty());
        let mut alerts = 0;
        for _ in 0..200 {
            let rows = h.audit.read(project, None, None).await.unwrap().events;
            alerts = rows
                .iter()
                .filter(|r| r.details["kind"] == "successor_spawn_failed")
                .count();
            if alerts > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(alerts, 1);
    }

    // --- issue #60: parking-engaged handoff absorption ---

    #[tokio::test]
    async fn test_engaged_absorber_suppresses_successor_and_writes_park_row() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-absorb";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let head = read_repo_head(repo.path()).unwrap();
        write_handoff(repo.path(), "epic-9", 2, &head);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());

        // A hard park sweep is engaged: the absorber says so and records
        // what it was asked about.
        let asked: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let asked_rec = asked.clone();
        h.replicator.set_absorber(Arc::new(move |project, epic| {
            asked_rec
                .lock()
                .unwrap()
                .push((project.to_string(), epic.to_string()));
            true
        }));

        let snapshot = to_handoff_written(&h.supervisor, project, "epic-9", 2);
        h.replicator.on_handoff_written(&snapshot);

        // The kill still happens in full (teardown + Killed transition) …
        wait_until(|| state_of(&h.supervisor, 1) == Some(SupervisorState::Killed)).await;
        assert_eq!(*h.torn_down.lock().unwrap(), vec![1]);
        // … and the trail explains the missing successor with a PARK row.
        let mut absorbed = false;
        for _ in 0..200 {
            let rows = h.audit.read(project, None, None).await.unwrap().events;
            absorbed = rows.iter().any(|r| {
                r.event == AuditEventKind::Park && r.details["phase"] == "handoff_absorbed"
            });
            if absorbed {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(absorbed, "PARK handoff_absorbed row must land");

        // ONLY the staging + spawn emit were suppressed.
        assert!(h.spawns.lock().unwrap().is_empty(), "no spawn event");
        assert_eq!(h.replicator.pending_count(3), 0, "no staged ritual");
        assert_eq!(
            *asked.lock().unwrap(),
            vec![(project.to_string(), "epic-9".to_string())]
        );
    }

    #[tokio::test]
    async fn test_disengaged_absorber_spawns_normally() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-noabsorb";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let head = read_repo_head(repo.path()).unwrap();
        write_handoff(repo.path(), "epic-9", 2, &head);
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        h.replicator.set_absorber(Arc::new(|_, _| false));

        let snapshot = to_handoff_written(&h.supervisor, project, "epic-9", 2);
        h.replicator.on_handoff_written(&snapshot);
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;

        // Not engaged: the Phase-2 behavior is untouched.
        assert_eq!(h.replicator.pending_count(3), 1);
        let rows = h.audit.read(project, None, None).await.unwrap().events;
        assert!(!rows
            .iter()
            .any(|r| r.details["phase"] == "handoff_absorbed"));
    }
}
