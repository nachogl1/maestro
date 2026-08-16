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
//! Issue #61 adds [`SamuraiReplicator::spawn_generation`] — the fresh-spawn
//! entry point for generations with NO live predecessor session (timer
//! resumes and P3.4 cold-start reconciliation): the ritual is chosen by
//! whether the prior generation's handoff file exists on disk, and the spawn
//! event is re-emitted once per timeout window while no registration arrives
//! (the frontend drops the event when no project tab is open), bounded by
//! [`MAX_SPAWN_EMITS`] and closed out with a `spawn_dropped` ALERT.
//!
//! Issue #63 adds [`SamuraiReplicator::spawn_first_generation`] — the gen-1
//! seam for the P3.5 launcher: a brand-new epic has no handoff and no
//! predecessor, so the caller supplies the opening brief
//! (`samurai_prompts::launch_instruction`) directly and the entry rides the
//! exact same staging / spawn-retry / delivery machinery as every other
//! fresh spawn.
//!
//! Same shape as the watchdog/injector: decisions as pure functions, I/O at
//! the edges, one periodic timeout pass (driven by the injector's tick).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;

use crate::commands::ai_runner::{strip_ansi, truncate_chars};

use super::claude_event::ClaudeEvent;
use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_config::SharedSamuraiConfig;
use super::samurai_injector::{strip_extended_prefix, AgeableInstant, SessionDirResolver};
use super::samurai_journal::default_journal_file;
use super::samurai_prompts;
use super::samurai_workflow;
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

/// Delivers one instruction into a session's PTY (the ritual delivery).
///
/// The writer OWNS submission: it receives the instruction text alone and is
/// responsible for sending the Enter itself. The production closure routes
/// through `samurai_pty::submit_instruction`, which writes the text and then
/// a lone `\r` a moment later — a single text-plus-CR write is read by the
/// CLI as a paste and leaves the instruction sitting in the input box,
/// unsubmitted.
///
/// Issue #109: the third argument is the writer's verdict channel — invoked
/// with `Ok` once the instruction BODY actually reached the PTY, `Err` when
/// the write failed. The `delivered` audit row and the Enter-resend watch
/// hang off that verdict, so neither can ever describe a write that did not
/// happen. The injector's deliveries share this exact contract.
pub type StdinWriter = Arc<dyn Fn(u32, String, super::samurai_pty::DeliveryOutcome) + Send + Sync>;

/// Issue #103: re-sends ONLY the lone Enter into a session's PTY. Used by
/// the post-delivery watch when a typed-in instruction shows no evidence of
/// a started turn — the Enter of a very long paste (the gen-1 launch brief
/// above all) can be consumed as part of the paste burst, leaving the brief
/// fully typed but never submitted. The body is NEVER re-sent: it already
/// sits in the input box, and a re-paste would duplicate the prompt. The
/// production closure wraps `samurai_pty::resend_submit`.
pub type EnterResender = Arc<dyn Fn(u32) + Send + Sync>;

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
    /// Model preference from the epic's run config (review F4) — the
    /// frontend appends `--model <value>` to the successor's CLI launch.
    /// `None` = the spawn flow's default model. Resolved at emit time via
    /// [`SamuraiReplicator::set_run_configs`].
    pub model: Option<String>,
}

/// How many times a fresh-spawn ([`Self::spawn_generation`] /
/// [`Self::spawn_first_generation`]) event is emitted in total before the
/// entry gives up with a `spawn_dropped` ALERT (issue #61; renamed from
/// `resume_spawn_dropped` in #63 — gen-1 launches ride it too). The frontend
/// listener drops the event when no tab for the project is open
/// (`spawnSession.ts` returns false), so a resume that fires while the user
/// has the project closed needs re-emits — one per `ack_timeout_secs`
/// window. Five windows (~15 min at the default 180s) is long enough to
/// survive a slow frontend start and short enough that a genuinely closed
/// project alerts the same day it parked.
const MAX_SPAWN_EMITS: u32 = 5;

/// Retry state for a fresh-spawn entry (issue #61): the payload to re-emit
/// and how many emits happened so far.
struct RespawnState {
    spawn: SuccessorSpawn,
    attempts: u32,
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
    /// True for a gen-1 LAUNCH entry (issue #63,
    /// [`SamuraiReplicator::spawn_first_generation`]): there is no
    /// predecessor at all, so the SPAWN audit details carry
    /// `trigger: "launch"` instead of predecessor linkage.
    launch: bool,
    /// What started this generation (issue #101): `"handoff"` (validated
    /// handoff chain), `"watchdog"` (DEAD recovery), `"resume_timer"` (a
    /// park timer armed this session) or `"launch"`. Rides into the SPAWN
    /// audit row's details so the trail explains why gen-N+1 exists. App
    /// startup produces none of them: cold-start reconciliation alerts
    /// instead of spawning (`samurai_reconciler`).
    trigger: &'static str,
    queued_at: AgeableInstant,
    /// Set when the frontend registered the successor: (session id, when).
    /// The no-start clock runs from here; before registration it runs from
    /// `queued_at` so a spawn flow that never happens still ALERTs.
    registered: Option<(u32, AgeableInstant)>,
    /// The no-start timeout fired for this entry (fresh-eyes finding G).
    /// Latched instead of deleted: a successor registered LATE (frontend
    /// stall past the timeout) must still get its ritual armed and
    /// delivered. Never re-alerts; pruned when the ritual is claimed or when
    /// no supervised session remains for the (project, epic).
    alerted: bool,
    /// `Some` for entries staged by [`SamuraiReplicator::spawn_generation`]
    /// (issue #61 — timer resumes; P3.4 cold-start reconciliation and the
    /// P3.5 gen-1 launcher reuse it): while unregistered, the tick re-emits
    /// the spawn event per timeout window up to [`MAX_SPAWN_EMITS`], then
    /// latches with a `spawn_dropped` ALERT (which REPLACES the generic
    /// `successor_no_start` for this path — one clear ALERT, not two vague
    /// ones). These entries also skip the epic-gone prune: a resumed epic
    /// has NO supervised session until its successor registers, so the
    /// heuristic would delete them instantly; they are pruned on delivery
    /// instead (bounded: one per (project, epic, generation)).
    respawn: Option<RespawnState>,
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
    queued_at: AgeableInstant,
    registered_at: Option<AgeableInstant>,
    timeout: Duration,
) -> bool {
    registered_at.unwrap_or(queued_at).elapsed() > timeout
}

// ---------------------------------------------------------------------------
// Issue #103: post-delivery watch — did the typed-in instruction ever submit?
// ---------------------------------------------------------------------------

/// How long a delivered instruction may sit with NO turn-start evidence
/// before the lone Enter is re-sent. Evidence for a landed submit arrives
/// within seconds (the CLI appends the `UserMessage` transcript entry at
/// submission; the PreToolUse hook pushes on the first tool call), so 45s is
/// an order-of-magnitude margin against false resends — and with the 30s
/// tick driving this check, a swallowed Enter is recovered 45–75s after
/// delivery instead of stranding the run until a human presses Enter
/// (observed live 2026-08-12). Constant, not config: like `SUBMIT_DELAY`
/// it is a property of the delivery mechanics, not a user preference.
const ENTER_RESEND_WINDOW: Duration = Duration::from_secs(45);

/// Bounded resends: one covers the observed failure (a single swallowed
/// Enter), the second covers the resend itself being swallowed. Beyond that
/// more Enters cannot be the fix, so the watch gives up with an ALERT.
const MAX_ENTER_RESENDS: u32 = 2;

/// One instruction typed into a successor's PTY, watched until something
/// proves the submit landed (or the watch gives up). Armed at delivery
/// time in [`SamuraiReplicator::observe_hook`]; released by
/// [`turn_activity_session`] evidence; driven by the tick.
struct DeliveredWatch {
    project: String,
    epic: String,
    generation: u32,
    session_id: u32,
    /// Gen-1 LAUNCH flag, carried into the audit rows: the launch brief is
    /// the longest paste and the reason this watch exists (issue #103).
    launch: bool,
    /// Who delivered the watched instruction (issue #109): `"replicator"`
    /// for staged rituals/briefs, `"injector"` for handoff/park/wind-down
    /// instructions. Rides the `submit_retry`/`submit_unconfirmed` audit
    /// rows so the two delivery paths stay distinguishable in the trail.
    source: &'static str,
    /// Delivery time, re-stamped on each resend so every attempt gets a
    /// full window.
    delivered_at: AgeableInstant,
    resends: u32,
}

/// What the tick concluded about one delivered-but-unconfirmed instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnterResendVerdict {
    /// Still inside the window — keep waiting.
    Keep,
    /// The window expired with resends left: re-send the lone Enter.
    Resend,
    /// The window expired and the resend budget is spent: ALERT and stop.
    GiveUp,
}

/// Pure resend decision. Strict boundary (`>`), same discipline as every
/// other timeout in the supervision chain.
fn enter_resend_verdict(elapsed: Duration, resends: u32) -> EnterResendVerdict {
    if elapsed <= ENTER_RESEND_WINDOW {
        EnterResendVerdict::Keep
    } else if resends < MAX_ENTER_RESENDS {
        EnterResendVerdict::Resend
    } else {
        EnterResendVerdict::GiveUp
    }
}

/// The events that release a delivery watch, keyed by session:
///
/// - `UserMessage` — the CLI writes the user entry to the transcript at
///   prompt submission: the DIRECT proof the Enter landed. This is the same
///   signal the injector's `idle_effect` already treats as "a genuine turn
///   restart".
/// - `ToolUseStarted` — the PreToolUse hook, an independent (non-transcript)
///   channel: even if the transcript watcher never attached, the first tool
///   call proves a turn is running.
/// - `AssistantMessage` — covers a watcher that attached mid-turn and missed
///   the user entry.
/// - `SessionEnded` — any reason: `"stop"` is a turn boundary (a turn that
///   ended must have started), anything else means the session is gone and
///   there is nothing left to resend into.
///
/// `SessionStarted` is deliberately NOT evidence: it is the very signal the
/// delivery rides on.
fn turn_activity_session(event: &ClaudeEvent) -> Option<u32> {
    match event {
        ClaudeEvent::UserMessage { session_id, .. }
        | ClaudeEvent::ToolUseStarted { session_id, .. }
        | ClaudeEvent::AssistantMessage { session_id, .. }
        | ClaudeEvent::SessionEnded { session_id, .. } => Some(*session_id),
        _ => None,
    }
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
    if [owner, repo].iter().any(|s| {
        !s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    }) {
        // GitHub owner/repo names are [A-Za-z0-9._-]. Anything else — shell
        // metacharacters above all — must never reach the `--repo` pin the
        // prompts embed, because the orchestrator that runs those `gh`
        // commands runs with `--dangerously-skip-permissions` (PRD §10).
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

/// The `--repo owner/repo` pin for recovery prompts (fresh-eyes finding D;
/// PRD §10: successors run with `--dangerously-skip-permissions`, so every
/// orchestrator prompt pins `--repo`). `None` (logged) when the remote is
/// missing or unparseable — recovery is never blocked on it; the prompt then
/// carries an explicit caution instead. `pub(crate)`: the P3.5 launcher
/// (issue #63, `commands::samurai`) derives the run config's `repo_pin` from
/// the freshly created epic worktree with this same helper.
pub(crate) fn derive_repo_pin(dir: &Path) -> Option<String> {
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
    /// Issue #103: the Enter-only resend for the post-delivery watch.
    resend_enter: EnterResender,
    pending: Mutex<Vec<PendingRitual>>,
    /// Issue #103: instructions typed in but not yet proven submitted.
    /// `Arc` so the delivery-outcome callback (issue #109) can arm a watch
    /// after the call that spawned the write returned.
    delivered: Arc<Mutex<Vec<DeliveredWatch>>>,
    /// Issue #60: the parking-engaged check (see [`HandoffAbsorber`]).
    /// Unset (tests without a parker, or before setup finishes) = never
    /// absorb — successors spawn as in Phase 2.
    absorber: std::sync::OnceLock<HandoffAbsorber>,
    /// Review F4: the run-config store, consulted at spawn-emit time for the
    /// epic's per-run `model` preference. Late-bound like the absorber
    /// (constructed after this controller in lib.rs); unset (tests, early
    /// setup) = no model preference on any spawn.
    run_configs: std::sync::OnceLock<Arc<super::samurai_run_config::RunConfigStore>>,
}

impl SamuraiReplicator {
    // Nine distinct collaborators, each injected once at startup. A params
    // struct would only move the same list one level out.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        supervisor: Arc<Supervisor>,
        audit: AuditLog,
        config: SharedSamuraiConfig,
        session_dirs: SessionDirResolver,
        transcript_paths: TranscriptPathResolver,
        teardown: SessionTeardown,
        emit_spawn: SuccessorEmitter,
        write_stdin: StdinWriter,
        resend_enter: EnterResender,
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
            resend_enter,
            pending: Mutex::new(Vec::new()),
            delivered: Arc::new(Mutex::new(Vec::new())),
            absorber: std::sync::OnceLock::new(),
            run_configs: std::sync::OnceLock::new(),
        }
    }

    /// Issue #60: late-binds the parking-engaged check (the parker is
    /// constructed after this controller). Second calls are ignored, like
    /// every OnceLock slot in setup.
    pub fn set_absorber(&self, absorber: HandoffAbsorber) {
        let _ = self.absorber.set(absorber);
    }

    /// Review F4: late-binds the run-config store (constructed after this
    /// controller in lib.rs), the `set_absorber` pattern. Second calls are
    /// ignored.
    pub fn set_run_configs(&self, store: Arc<super::samurai_run_config::RunConfigStore>) {
        let _ = self.run_configs.set(store);
    }

    /// The epic's per-run model preference, when a run config carries one
    /// (review F4). Resolved at emit time — a relaunch with a different
    /// model applies to the next spawn without a restart. One small JSON
    /// read; `None` on every miss (no store bound, no config, no model).
    fn model_for(&self, project: &str, epic: &str) -> Option<String> {
        self.run_configs.get()?.get(project, epic)?.model
    }

    /// The epic's compiled workflow section (issue #91): the graph its run
    /// config snapshotted at launch, or the default template when the
    /// config predates workflows — or no store/config exists at all.
    /// Resolved at brief-build time like [`Self::model_for`], so successor
    /// and recovery briefs always recompile the SAME workflow the run
    /// launched with.
    fn workflow_for(&self, project: &str, epic: &str) -> String {
        let stored = self
            .run_configs
            .get()
            .and_then(|s| s.get(project, epic))
            .and_then(|c| c.workflow);
        samurai_workflow::compiled_for_run(stored.as_ref())
    }

    /// Whether the epic's run config carries any GitHub ref (issue #128 fix
    /// L2): `false` only for a pure-prose run — launched via free text with
    /// no `#N` refs — whose successor/recovery briefs must not send the
    /// agent hunting for a GitHub issue that does not exist. Resolved at
    /// brief-build time like [`Self::workflow_for`]; defaults to `true`
    /// (today's ref-framed wording) when no store or config is bound, so a
    /// missing config never silently strips the GitHub steps from a real
    /// ref-based run.
    fn has_refs_for(&self, project: &str, epic: &str) -> bool {
        self.run_configs
            .get()
            .and_then(|s| s.get(project, epic))
            .map(|c| !c.epics.is_empty() || !c.issues.is_empty())
            .unwrap_or(true)
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
        let relpath = samurai_prompts::handoff_file_relpath(&snapshot.epic, snapshot.generation);
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

        // Issue #60: while a hard park sweep is engaged, a completed handoff
        // is ABSORBED instead of replicated — the handoff file already IS the
        // park state (PRD §5.2) and a successor would burn the exhausted
        // allowance. Evaluated BEFORE the Killed transition (review F3b):
        // Killed is terminal and stops blocking the sweep
        // (`blocks_completion`), so consulting the absorber after it opened
        // a window where a concurrent complete_sweep disengaged between the
        // two — the successor then spawned into an exhausted allowance, or
        // the epic was swallowed into a disengaged sweep with no resume
        // timer. `absorb_handoff` records the epic while HANDOFF_WRITTEN
        // still holds the sweep open, so the stored verdict stays valid
        // after the transition.
        let absorbed = self
            .absorber
            .get()
            .is_some_and(|absorber| absorber(&snapshot.project, &snapshot.epic));

        // HANDOFF_WRITTEN → KILLED: writes the `HANDOFF phase=killed` audit
        // row and emits the supervisor event the frontend clears the dead
        // tile on. A rejection (e.g. the watchdog declared the session DEAD
        // mid-teardown) aborts the successor — DEAD has its own recovery
        // path and must not race a second spawn. (An absorbed epic stays
        // recorded with the parker then — correct either way: the handoff
        // on disk is the park state a resume timer restarts from.)
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

        if absorbed {
            // ONLY the successor staging + spawn emit are suppressed — the
            // teardown and Killed transition above happened in full. The
            // PARK row explains why no successor appears; the parker arms
            // the epic's resume timer when the sweep completes.
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

        let generation = snapshot.generation + 1;
        // Issue #91: the run's workflow, recompiled from the graph its
        // config snapshotted at launch — rides both ritual variants.
        let workflow = self.workflow_for(&snapshot.project, &snapshot.epic);
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
                    // Issue #72: the journaling rider rides every successor
                    // brief so agents record their own friction (PRD §5.12).
                    format!(
                        "{} {}",
                        samurai_prompts::successor_ritual_instruction(
                            &snapshot.epic,
                            snapshot.generation,
                            head_matched,
                            &workflow,
                            self.has_refs_for(&snapshot.project, &snapshot.epic),
                        ),
                        samurai_prompts::journal_instruction(&default_journal_file()),
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
                self.write_recovery_digest(
                    &snapshot.epic,
                    snapshot.generation,
                    snapshot.session_id,
                    &working_dir,
                    &killed.ts,
                    transcript,
                )
                .await;
                // Finding D: pin `--repo` in the recovery prompt (PRD §10).
                // Blocking git → blocking pool; failure never blocks recovery.
                let pin_dir = PathBuf::from(working_dir.clone());
                let repo_pin = tokio::task::spawn_blocking(move || derive_repo_pin(&pin_dir))
                    .await
                    .unwrap_or(None);
                (
                    // Issue #72 / fix M4: the journaling rider rides recovery
                    // briefs too — recovered generations hit the most
                    // friction and must record it.
                    format!(
                        "{} {}",
                        samurai_prompts::recovery_ritual_instruction(
                            &snapshot.epic,
                            snapshot.generation,
                            repo_pin.as_deref(),
                            &workflow,
                            self.has_refs_for(&snapshot.project, &snapshot.epic),
                        ),
                        samurai_prompts::journal_instruction(&default_journal_file()),
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
            model: self.model_for(&snapshot.project, &snapshot.epic),
        };
        self.lock_pending().push(PendingRitual {
            project: snapshot.project.clone(),
            epic: snapshot.epic.clone(),
            generation,
            instruction,
            predecessor_session_id: snapshot.session_id,
            predecessor_generation: snapshot.generation,
            recovery,
            launch: false,
            trigger: "handoff",
            queued_at: AgeableInstant::now(),
            registered: None,
            alerted: false,
            respawn: None,
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
        // Review F7: while a hard park sweep is engaged, a DEAD session's
        // epic is ABSORBED like a completed handoff (`replicate` above) —
        // the parker records it for a resume timer and NO recovery successor
        // is staged: spawning one would burn the exhausted allowance the
        // sweep exists to protect. The PARK row explains the missing
        // successor (`dead_absorbed` — the handoff-less sibling of
        // `handoff_absorbed`); the resume path respawns the generation from
        // disk once the window resets. No lock is held here, so the
        // parker→injector→supervisor ordering is untouched.
        if self
            .absorber
            .get()
            .is_some_and(|absorber| absorber(&snapshot.project, &snapshot.epic))
        {
            log::info!(
                "samurai replicator: parking engaged — DEAD gen-{} for epic {} absorbed, no recovery successor staged",
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
                    json!({ "phase": "dead_absorbed" }),
                ),
            );
            return;
        }
        let Some(dir) = (self.session_dirs)(snapshot.session_id) else {
            self.alert_spawn_failed(snapshot, "the session's working directory is unknown");
            return;
        };
        let working_dir = strip_extended_prefix(&dir).to_string();
        let generation = snapshot.generation + 1;
        // Issue #91: resolved before the lock (one small JSON read, same
        // budget as model_for below) — never file I/O under the mutex.
        let workflow = self.workflow_for(&snapshot.project, &snapshot.epic);
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
                // Issue #72 / fix M4: the journaling rider rides both
                // versions of the brief.
                instruction: format!(
                    "{} {}",
                    samurai_prompts::recovery_ritual_instruction(
                        &snapshot.epic,
                        snapshot.generation,
                        None,
                        &workflow,
                        self.has_refs_for(&snapshot.project, &snapshot.epic),
                    ),
                    samurai_prompts::journal_instruction(&default_journal_file()),
                ),
                predecessor_session_id: snapshot.session_id,
                predecessor_generation: snapshot.generation,
                recovery: true,
                launch: false,
                trigger: "watchdog",
                queued_at: AgeableInstant::now(),
                registered: None,
                alerted: false,
                respawn: None,
            });
        }
        let spawn = SuccessorSpawn {
            project: snapshot.project.clone(),
            epic: snapshot.epic.clone(),
            generation,
            working_dir: working_dir.clone(),
            session_name: samurai_prompts::successor_session_name(&snapshot.epic, generation),
            model: self.model_for(&snapshot.project, &snapshot.epic),
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
                // Issue #91: resolved before the lock, like the staging path.
                let workflow = this.workflow_for(&snapshot.project, &snapshot.epic);
                let mut pending = this.lock_pending();
                if let Some(p) = pending.iter_mut().find(|p| {
                    p.generation == generation
                        && p.epic == snapshot.epic
                        && p.project == snapshot.project
                }) {
                    // Issue #72 / fix M4: the pin swap must not drop the
                    // journaling rider the staged brief already carried.
                    p.instruction = format!(
                        "{} {}",
                        samurai_prompts::recovery_ritual_instruction(
                            &snapshot.epic,
                            snapshot.generation,
                            Some(&pin),
                            &workflow,
                            this.has_refs_for(&snapshot.project, &snapshot.epic),
                        ),
                        samurai_prompts::journal_instruction(&default_journal_file()),
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
            this.write_recovery_digest(
                &snapshot.epic,
                snapshot.generation,
                snapshot.session_id,
                &working_dir,
                &snapshot.ts,
                transcript,
            )
            .await;
            (this.emit_spawn)(&spawn);
        });
    }

    /// Issue #61: the reusable FRESH-SPAWN entry point — a generation spawned
    /// with no live predecessor session (PRD §5.5: every wake-up is a fresh
    /// spawn from the handoff file). The resume path calls it when a park
    /// timer fires; P3.4's cold-start reconciliation and P3.5's gen-1 launch
    /// call this same method.
    ///
    /// `prior_generation = Some(n)`: the ritual is chosen by whether gen-n's
    /// handoff file exists in `working_dir` — present → the normal successor
    /// ritual, HEAD-gated exactly like [`Self::replicate`]; missing (e.g. the
    /// registry knew a later generation than the last handoff on disk) →
    /// the recovery ritual with a `--repo` pin and a no-transcript digest
    /// file (there is no predecessor transcript to digest on this path).
    ///
    /// `prior_generation = None` still refuses loudly: a brand-new epic has
    /// no handoff AND no predecessor transcript, so neither ritual applies —
    /// gen-1 launches go through [`Self::spawn_first_generation`] (issue
    /// #63), which carries its opening brief explicitly.
    ///
    /// Callers pass `generation = prior + 1` (the resumer derives `prior` as
    /// the highest generation across the supervisor registry and the handoff
    /// files, so the ritual's self-description matches the badge); a caller
    /// that breaks that invariant gets a logged warning, not a panic.
    ///
    /// Staging is synchronous and idempotent — a second call for the same
    /// (project, epic, generation) is a no-op, which is what makes the
    /// schedule's crash-mid-callback re-fire safe. The spawn event is emitted
    /// from a spawned task (the ritual decision reads files + git); if the
    /// frontend drops it (no open project tab), [`Self::tick`] re-emits — see
    /// [`MAX_SPAWN_EMITS`].
    pub fn spawn_generation(
        self: &Arc<Self>,
        project: &str,
        epic: &str,
        working_dir: &str,
        generation: u32,
        prior_generation: Option<u32>,
        trigger: &'static str,
    ) {
        let Some(prior) = prior_generation else {
            log::error!(
                "samurai replicator: spawn_generation for epic {epic} without a prior generation has no ritual — gen-1 launches must go through spawn_first_generation (issue #63); nothing staged"
            );
            return;
        };
        if generation != prior + 1 {
            log::warn!(
                "samurai replicator: spawn_generation gen-{generation} for epic {epic} does not follow prior gen-{prior} — the ritual text will name gen-{}",
                prior + 1,
            );
        }
        let working_dir = strip_extended_prefix(working_dir).to_string();
        // Issue #91: the run's workflow, recompiled from the launch
        // snapshot — resolved once here (same JSON read budget as
        // model_for), used by the placeholder and the real ritual alike.
        let workflow = self.workflow_for(project, epic);
        let spawn = SuccessorSpawn {
            project: project.to_string(),
            epic: epic.to_string(),
            generation,
            working_dir: working_dir.clone(),
            session_name: samurai_prompts::successor_session_name(epic, generation),
            model: self.model_for(project, epic),
        };
        // Stage synchronously, under the one lock, so a repeated fire (the
        // schedule re-fires after a crash mid-callback) can never
        // double-stage — same discipline as on_dead.
        {
            let mut pending = self.lock_pending();
            if let Some(i) = pending
                .iter()
                .position(|p| p.generation == generation && p.epic == epic && p.project == project)
            {
                // An entry that already GAVE UP (spawn_dropped ALERT, still
                // unregistered) is kept only for a late registration — it
                // must not block a later attempt at the same generation, or
                // the epic can never be resumed short of an app restart.
                if pending[i].alerted && pending[i].registered.is_none() {
                    log::warn!(
                        "samurai replicator: replacing the dropped gen-{generation} entry for epic {epic} — re-staging"
                    );
                    pending.remove(i);
                } else {
                    log::warn!(
                        "samurai replicator: gen-{generation} for epic {epic} is already staged — ignoring repeated spawn_generation"
                    );
                    return;
                }
            }
            // Backstop against a second orchestrator in one worktree: the
            // guard above is keyed on the GENERATION, so two callers that
            // disagree about the prior generation (the reconciler's retry
            // pass reading back its own RESUME row, or a resumer/reconciler
            // race) would each stage their own entry and BOTH spawn. An epic
            // that already has a live, not-yet-given-up entry is not
            // respawnable at any other generation either. `alerted` entries
            // are exempt for the same reason as above — an epic must never
            // become permanently unresumable.
            if let Some(other) = pending.iter().find(|p| {
                p.epic == epic && p.project == project && p.registered.is_none() && !p.alerted
            }) {
                log::warn!(
                    "samurai replicator: epic {epic} already has an unregistered gen-{} staged — refusing to also stage gen-{generation}",
                    other.generation
                );
                return;
            }
            log::info!(
                "samurai replicator: staging fresh gen-{generation} for epic {epic} in {working_dir} (prior gen-{prior})"
            );
            pending.push(PendingRitual {
                project: project.to_string(),
                epic: epic.to_string(),
                generation,
                // Staged provisionally as UNPINNED recovery (this synchronous
                // path must not touch files or git); the async task below
                // swaps in the real ritual before the spawn event fires —
                // and delivery only happens on the successor's
                // SessionStarted, which cannot precede that event. Issue #72
                // / fix M4: the journaling rider rides every version.
                instruction: format!(
                    "{} {}",
                    samurai_prompts::recovery_ritual_instruction(
                        epic,
                        prior,
                        None,
                        &workflow,
                        self.has_refs_for(project, epic),
                    ),
                    samurai_prompts::journal_instruction(&default_journal_file()),
                ),
                predecessor_session_id: 0,
                predecessor_generation: prior,
                recovery: true,
                launch: false,
                trigger,
                queued_at: AgeableInstant::now(),
                registered: None,
                alerted: false,
                respawn: Some(RespawnState {
                    spawn: spawn.clone(),
                    attempts: 1,
                }),
            });
        }
        let this = self.clone();
        let project = project.to_string();
        let epic = epic.to_string();
        tauri::async_runtime::spawn(async move {
            // Ritual decision on the blocking pool: read gen-`prior`'s
            // handoff and, when present, HEAD-gate it (same gate as
            // replicate); a missing/unreadable file selects recovery.
            let gate_dir = PathBuf::from(working_dir.clone());
            let gate_epic = epic.clone();
            let head_gate: Option<bool> = tokio::task::spawn_blocking(move || {
                let relpath = samurai_prompts::handoff_file_relpath(&gate_epic, prior);
                let handoff = std::fs::read_to_string(gate_dir.join(&relpath))
                    .map_err(|e| {
                        log::info!(
                            "samurai replicator: no gen-{prior} handoff at {relpath} ({e}) — fresh spawn uses recovery mode"
                        );
                    })
                    .ok()?;
                let handoff_sha = samurai_prompts::handoff_head_sha(&handoff);
                let head = read_repo_head(&gate_dir)
                    .map_err(|e| log::warn!("samurai replicator: {e}"))
                    .ok();
                Some(head_matches(handoff_sha.as_deref(), head.as_deref()))
            })
            .await
            // A join failure is not evidence the handoff is missing; verify-
            // required is the safe default (same policy as replicate).
            .unwrap_or(Some(false));

            let (instruction, recovery) = match head_gate {
                Some(head_matched) => {
                    log::info!(
                        "samurai replicator: fresh gen-{generation} for epic {epic} reads the gen-{prior} handoff (HEAD gate: {})",
                        if head_matched { "match, verify skipped" } else { "mismatch, verify required" },
                    );
                    (
                        // Issue #72: journaling rider, same as replicate.
                        format!(
                            "{} {}",
                            samurai_prompts::successor_ritual_instruction(
                                &epic,
                                prior,
                                head_matched,
                                &workflow,
                                this.has_refs_for(&project, &epic),
                            ),
                            samurai_prompts::journal_instruction(&default_journal_file()),
                        ),
                        false,
                    )
                }
                None => {
                    // Finding D: pin `--repo`; failure never blocks the spawn.
                    let pin_dir = PathBuf::from(working_dir.clone());
                    let repo_pin = tokio::task::spawn_blocking(move || derive_repo_pin(&pin_dir))
                        .await
                        .unwrap_or(None);
                    // No predecessor transcript exists on this path — the
                    // digest file still gets written, carrying its
                    // no-transcript note (git + GitHub are the sources).
                    this.write_recovery_digest(
                        &epic,
                        prior,
                        0,
                        &working_dir,
                        &chrono::Utc::now().to_rfc3339(),
                        None,
                    )
                    .await;
                    (
                        // Issue #72 / fix M4: journaling rider, same as the
                        // successor arm above.
                        format!(
                            "{} {}",
                            samurai_prompts::recovery_ritual_instruction(
                                &epic,
                                prior,
                                repo_pin.as_deref(),
                                &workflow,
                                this.has_refs_for(&project, &epic),
                            ),
                            samurai_prompts::journal_instruction(&default_journal_file()),
                        ),
                        true,
                    )
                }
            };
            {
                let mut pending = this.lock_pending();
                if let Some(p) = pending
                    .iter_mut()
                    .find(|p| p.generation == generation && p.epic == epic && p.project == project)
                {
                    p.instruction = instruction;
                    p.recovery = recovery;
                }
            }
            (this.emit_spawn)(&spawn);
        });
    }

    /// Issue #63: the gen-1 LAUNCH entry point — the P3.5 launcher's seam.
    /// A brand-new epic has no handoff and no predecessor, so no ritual can
    /// be derived; the caller passes the opening brief
    /// (`samurai_prompts::launch_instruction`, `--repo`-pinned, plus the
    /// issue-#72 journaling rider) directly.
    /// Everything downstream is the shared fresh-spawn machinery: staged
    /// under the (project, epic, generation 1) idempotence guard, the spawn
    /// event re-emitted per timeout window while unregistered (bounded by
    /// [`MAX_SPAWN_EMITS`], closed out with a `spawn_dropped` ALERT), and
    /// the brief typed in on the session's first `SessionStarted`. Fully
    /// synchronous — there is no file or git I/O to defer, the instruction
    /// is already complete.
    pub fn spawn_first_generation(
        self: &Arc<Self>,
        project: &str,
        epic: &str,
        working_dir: &str,
        instruction: String,
    ) {
        let generation = 1;
        let working_dir = strip_extended_prefix(working_dir).to_string();
        let spawn = SuccessorSpawn {
            project: project.to_string(),
            epic: epic.to_string(),
            generation,
            working_dir,
            session_name: samurai_prompts::successor_session_name(epic, generation),
            model: self.model_for(project, epic),
        };
        {
            let mut pending = self.lock_pending();
            if let Some(i) = pending
                .iter()
                .position(|p| p.generation == generation && p.epic == epic && p.project == project)
            {
                // Same rule as spawn_generation: a dropped, never-registered
                // entry is latched for a late registration only, and a fresh
                // staging supersedes it — otherwise a launch whose spawn
                // event nobody consumed (no project tab open) would silently
                // no-op for the rest of the app's lifetime.
                if pending[i].alerted && pending[i].registered.is_none() {
                    log::warn!(
                        "samurai replicator: replacing the dropped gen-1 entry for epic {epic} — re-staging"
                    );
                    pending.remove(i);
                } else {
                    log::warn!(
                        "samurai replicator: gen-1 for epic {epic} is already staged — ignoring repeated spawn_first_generation"
                    );
                    return;
                }
            }
            log::info!(
                "samurai replicator: staging gen-1 LAUNCH for epic {epic} in {}",
                spawn.working_dir
            );
            pending.push(PendingRitual {
                project: project.to_string(),
                epic: epic.to_string(),
                generation,
                instruction,
                // 0 sentinels: gen-1 has no predecessor (finding F's "can
                // never collide" rationale — ProcessManager ids start at 1).
                predecessor_session_id: 0,
                predecessor_generation: 0,
                recovery: false,
                launch: true,
                trigger: "launch",
                queued_at: AgeableInstant::now(),
                registered: None,
                alerted: false,
                respawn: Some(RespawnState {
                    spawn: spawn.clone(),
                    attempts: 1,
                }),
            });
        }
        (self.emit_spawn)(&spawn);
    }

    /// Builds and writes the recovery digest file for the gen-
    /// `predecessor_generation + 1` successor
    /// (`<working_dir>/.maestro/handoffs/<slug>-gen<N+1>-recovery.md`). Best
    /// effort: failures are logged, never propagated — git + GitHub are the
    /// primary reconstruction sources, the digest is only hints. Field-wise
    /// (not a snapshot) because the resume path (issue #61) has no live
    /// predecessor session — it passes the 0 sentinel id and no transcript.
    async fn write_recovery_digest(
        &self,
        epic: &str,
        predecessor_generation: u32,
        predecessor_session_id: u32,
        working_dir: &str,
        ended_at: &str,
        transcript: Option<PathBuf>,
    ) {
        let epic = epic.to_string();
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
                // Issue #63: a gen-1 LAUNCH has no predecessor — its SPAWN
                // row names the trigger instead of a fabricated linkage.
                if p.launch {
                    return json!({ "trigger": "launch" });
                }
                let mut details = json!({
                    "predecessor_session_id": p.predecessor_session_id,
                    "predecessor_generation": p.predecessor_generation,
                    // Issue #101: WHY this generation exists — handoff,
                    // watchdog recovery or resume timer.
                    "trigger": p.trigger,
                });
                // Issue #56: mark RECOVERY successors on their SPAWN row;
                // normal successors keep the exact P2.4 shape.
                if p.recovery {
                    details["recovery"] = json!(true);
                }
                details
            })
    }

    /// Drops every staged-but-unregistered entry for an epic. Returns whether
    /// anything was removed.
    ///
    /// Called by the epic cleanup: the cleanup's own guard only sees
    /// SUPERVISED sessions, and a launch that the frontend has not registered
    /// yet is invisible to the supervisor while its spawn event is still
    /// being re-emitted (up to five windows, ~15 min). Left staged, that spawn
    /// fires into a directory cleanup has just deleted, and it blocks a
    /// relaunch of the same epic until it gives up.
    ///
    /// Matched by SLUG, not exact string: staging keys on the exact epic
    /// spelling while cleanup, run configs and worktrees all unify by slug —
    /// a cleanup typed as "38" must still cancel a spawn staged under "#38".
    /// Registered entries are left alone; cleanup refuses on those already.
    pub fn cancel_pending_for_epic(&self, project: &str, epic: &str) -> bool {
        let slug = samurai_prompts::epic_slug(epic);
        let mut pending = self.lock_pending();
        let before = pending.len();
        pending.retain(|p| {
            let cancel = p.project == project
                && samurai_prompts::epic_slug(&p.epic) == slug
                && p.registered.is_none();
            if cancel {
                log::info!(
                    "samurai replicator: cancelling staged gen-{} for epic {} in {project} — the epic is being cleaned up",
                    p.generation,
                    p.epic,
                );
            }
            !cancel
        });
        pending.len() != before
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
            p.registered = Some((snapshot.session_id, AgeableInstant::now()));
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
    ///
    /// Issue #103: delivery also arms a [`DeliveredWatch`] — the writer's
    /// Enter can be swallowed when the CLI is still consuming the paste
    /// burst, and no ACK ladder covers these instructions. Hook-side
    /// activity (PreToolUse above all) releases the watch here too.
    pub fn observe_hook(&self, event: &ClaudeEvent) {
        self.note_turn_activity(event);
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
            let session_id = *session_id;
            let instruction_kind = if p.launch {
                "launch_brief"
            } else if p.recovery {
                "recovery_ritual"
            } else {
                "successor_ritual"
            };
            let PendingRitual {
                project,
                epic,
                generation,
                instruction,
                launch,
                ..
            } = p;
            // Issue #109: the `delivered` audit row and the Enter-resend
            // watch (issue #103) both hang off the writer's verdict — the
            // row used to be written before the async PTY write completed,
            // so a failed write left a false 'delivered' trail. The
            // callback only queue-pushes (audit is a channel send, the
            // watch a mutex push), the DeliveryOutcome contract.
            let audit = self.audit.clone();
            let delivered = self.delivered.clone();
            let (excerpt, total_chars) = super::samurai_audit::instruction_excerpt(&instruction);
            let outcome: super::samurai_pty::DeliveryOutcome = Box::new(move |result| {
                match result {
                    Ok(()) => {
                        // Issue #101: the brief Maestro typed into the fresh
                        // terminal is an injection like any other — record
                        // what was said (bounded excerpt) and what let it
                        // through (the first SessionStarted). No ACK ladder
                        // exists here; submission is watched and failures
                        // land as submit_retry / submit_unconfirmed ALERTs.
                        audit.append(
                            &project,
                            AuditEvent::now(
                                epic.clone(),
                                AuditEventKind::Inject,
                                generation,
                                session_id,
                                json!({
                                    "phase": "delivered",
                                    "instruction": instruction_kind,
                                    "gate": "session_started",
                                    "excerpt": excerpt,
                                    "total_chars": total_chars,
                                }),
                            ),
                        );
                        delivered
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .push(DeliveredWatch {
                                project,
                                epic,
                                generation,
                                session_id,
                                launch,
                                source: "replicator",
                                delivered_at: AgeableInstant::now(),
                                resends: 0,
                            });
                    }
                    Err(error) => {
                        // The body never reached the PTY: a distinct ALERT
                        // instead of a false 'delivered' row, and no watch —
                        // there is nothing in the input box to re-submit.
                        log::error!(
                            "samurai replicator: {instruction_kind} for session {session_id} never reached the PTY ({error}) — ALERT"
                        );
                        audit.append(
                            &project,
                            AuditEvent::now(
                                epic,
                                AuditEventKind::Alert,
                                generation,
                                session_id,
                                json!({
                                    "kind": "delivery_failed",
                                    "instruction": instruction_kind,
                                    "source": "replicator",
                                    "error": error,
                                }),
                            ),
                        );
                    }
                }
            });
            // Text only — the writer submits it (see [`StdinWriter`]).
            (self.write_stdin)(session_id, instruction, outcome);
        }
    }

    /// Arms the issue-#103 Enter-resend watch for an instruction the
    /// INJECTOR just delivered (issue #109: handoff/park/wind-down used to
    /// have no watch at all, so a swallowed Enter degraded to an ack_timeout
    /// instead of auto-recovery). Called from the injector's delivery-outcome
    /// callback, i.e. only after the instruction body actually reached the
    /// PTY. Same release evidence, resend budget and tick as every other
    /// watch; the audit rows carry `source: "injector"`.
    pub fn watch_delivery(&self, project: &str, epic: &str, generation: u32, session_id: u32) {
        self.lock_delivered().push(DeliveredWatch {
            project: project.to_string(),
            epic: epic.to_string(),
            generation,
            session_id,
            launch: false,
            source: "injector",
            delivered_at: AgeableInstant::now(),
            resends: 0,
        });
    }

    /// EventBus tap (forwarded by the injector's `observe`, the same tee the
    /// ACK scanner reads): transcript-side activity — the `UserMessage` the
    /// CLI writes at prompt submission above all — releases the delivery
    /// watch (issue #103). Every other variant is ignored, so the tee can
    /// pass the whole stream without filtering.
    pub fn observe(&self, event: &ClaudeEvent) {
        self.note_turn_activity(event);
    }

    /// Releases the delivery watch for a session that shows turn activity
    /// (or is gone) — see [`turn_activity_session`] for the evidence table.
    fn note_turn_activity(&self, event: &ClaudeEvent) {
        let Some(session_id) = turn_activity_session(event) else {
            return;
        };
        let mut delivered = self.lock_delivered();
        let before = delivered.len();
        delivered.retain(|d| d.session_id != session_id);
        if delivered.len() != before {
            log::info!(
                "samurai replicator: session {session_id} shows turn activity — delivered instruction confirmed submitted"
            );
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
        struct DroppedSpawn {
            project: String,
            epic: String,
            generation: u32,
        }
        let mut re_emits: Vec<SuccessorSpawn> = Vec::new();
        let mut dropped: Vec<DroppedSpawn> = Vec::new();
        let alerts: Vec<NoStartAlert> = {
            let mut pending = self.lock_pending();
            let mut alerts = Vec::new();
            pending.retain_mut(|p| {
                // Issue #61: an UNREGISTERED fresh-spawn entry owns its
                // whole timeout story here — re-emit per window, then a
                // single spawn_dropped ALERT — and never reaches the
                // generic branches below (their successor_no_start would be
                // a second, vaguer alert; and their epic-gone prune would
                // delete a resume entry instantly, because a resumed epic
                // has no supervised session until its successor registers).
                // A registration hands the entry to the generic machinery.
                if let Some(respawn) = &mut p.respawn {
                    if p.registered.is_none() {
                        if p.alerted {
                            return true; // latched; pruned on delivery only
                        }
                        if no_start_expired(p.queued_at, None, timeout) {
                            if respawn.attempts >= MAX_SPAWN_EMITS {
                                p.alerted = true;
                                dropped.push(DroppedSpawn {
                                    project: p.project.clone(),
                                    epic: p.epic.clone(),
                                    generation: p.generation,
                                });
                            } else {
                                respawn.attempts += 1;
                                // Restart the window so each emit gets a
                                // full ack_timeout to land.
                                p.queued_at = AgeableInstant::now();
                                re_emits.push(respawn.spawn.clone());
                            }
                        }
                        return true;
                    }
                }
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
        // Issue #61 re-emits: outside the lock, same policy as every other
        // emit. The frontend consumes duplicates idempotently — an already-
        // consumed launch was claimed by the grid, and a re-emit for it can
        // only happen while nothing registered, i.e. nothing was consumed.
        for spawn in re_emits {
            log::warn!(
                "samurai replicator: spawn event for gen-{} of epic {} got no registration within the window — re-emitting (no project tab open?)",
                spawn.generation,
                spawn.epic,
            );
            (self.emit_spawn)(&spawn);
        }
        for d in dropped {
            log::error!(
                "samurai replicator: spawn event for gen-{} of epic {} was dropped {MAX_SPAWN_EMITS} times — giving up with an ALERT (a late registration still delivers the ritual)",
                d.generation,
                d.epic,
            );
            self.audit.append(
                &d.project,
                AuditEvent::now(
                    d.epic.clone(),
                    AuditEventKind::Alert,
                    d.generation,
                    // 0 sentinel: no successor session exists (finding F).
                    0,
                    json!({
                        // Issue #63 renamed resume_spawn_dropped: launches
                        // ride this path too, the kind is caller-neutral.
                        "kind": "spawn_dropped",
                        "epic": d.epic,
                        "generation": d.generation,
                    }),
                ),
            );
        }
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

        // Issue #103: the post-delivery watch. A delivered instruction whose
        // session shows no turn activity within the window gets the lone
        // Enter re-sent (NEVER the body — it already sits in the input box),
        // bounded by MAX_ENTER_RESENDS, then a final ALERT.
        let mut rows: Vec<(String, AuditEvent)> = Vec::new();
        {
            let mut delivered = self.lock_delivered();
            delivered.retain_mut(|d| {
                if !sessions.iter().any(|s| s.session_id == d.session_id) {
                    // Torn down / unregistered outside the samurai pipeline:
                    // never write into a session that is no longer ours.
                    return false;
                }
                match enter_resend_verdict(d.delivered_at.elapsed(), d.resends) {
                    EnterResendVerdict::Keep => true,
                    EnterResendVerdict::Resend => {
                        d.resends += 1;
                        // Re-stamp so each resend gets a full window.
                        d.delivered_at = AgeableInstant::now();
                        log::warn!(
                            "samurai replicator: no turn activity from session {} since its instruction was typed in — re-sending the lone Enter (swallowed-submit recovery, issue #103)",
                            d.session_id
                        );
                        // Issue #106 review F4: fire WHILE HOLDING the
                        // delivered lock. Deciding under the lock but firing
                        // after release left a gap where turn evidence could
                        // release the watch (`note_turn_activity` takes this
                        // same lock) and the queued `\r` still fired into the
                        // already-started turn. Verdict and fire are atomic
                        // now: a released watch can never resend. Safe to
                        // hold: the resender is fire-and-forget (production
                        // spawns an async task; tests push to a Vec) and
                        // never re-enters the replicator.
                        (self.resend_enter)(d.session_id);
                        rows.push((
                            d.project.clone(),
                            AuditEvent::now(
                                d.epic.clone(),
                                AuditEventKind::Alert,
                                d.generation,
                                d.session_id,
                                json!({
                                    "kind": "submit_retry",
                                    "attempt": d.resends,
                                    "launch": d.launch,
                                    "source": d.source,
                                }),
                            ),
                        ));
                        true
                    }
                    EnterResendVerdict::GiveUp => {
                        rows.push((
                            d.project.clone(),
                            AuditEvent::now(
                                d.epic.clone(),
                                AuditEventKind::Alert,
                                d.generation,
                                d.session_id,
                                json!({
                                    "kind": "submit_unconfirmed",
                                    "resends": d.resends,
                                    "launch": d.launch,
                                    "source": d.source,
                                }),
                            ),
                        ));
                        false
                    }
                }
            });
        }
        // Audit I/O outside the lock, like every other tick pass.
        for (project, row) in rows {
            self.audit.append(&project, row);
        }
    }

    /// Recover from a poisoned lock rather than panicking — event-path
    /// policy, same as the injector and context store.
    fn lock_pending(&self) -> std::sync::MutexGuard<'_, Vec<PendingRitual>> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Same poisoned-lock policy for the delivery watches (issue #103).
    fn lock_delivered(&self) -> std::sync::MutexGuard<'_, Vec<DeliveredWatch>> {
        self.delivered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Test-only: how many delivery watches are armed (issue #103).
    #[cfg(test)]
    fn delivered_count(&self) -> usize {
        self.lock_delivered().len()
    }

    /// Test-only: age one session's delivery watch so the resend path runs
    /// without real waiting (same `AgeableInstant` discipline as
    /// [`Self::backdate`]).
    #[cfg(test)]
    fn backdate_delivered(&self, session_id: u32, by: Duration) {
        let mut delivered = self.lock_delivered();
        let d = delivered
            .iter_mut()
            .find(|d| d.session_id == session_id)
            .expect("no delivery watch for the session");
        d.delivered_at.backdate(by);
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
    ///
    /// Ages by advancing the clocks' *reading* side (`AgeableInstant`'s
    /// extra elapsed time) rather than rewinding the stored `Instant` —
    /// `Instant::now().checked_sub(by)` underflows whenever machine uptime
    /// is shorter than `by` (issue #90), which made this flaky right after
    /// a reboot.
    #[cfg(test)]
    fn backdate(&self, generation: u32, by: Duration) {
        let mut pending = self.lock_pending();
        let p = pending
            .iter_mut()
            .find(|p| p.generation == generation)
            .expect("no staged ritual");
        p.queued_at.backdate(by);
        if let Some((_, at)) = &mut p.registered {
            at.backdate(by);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        /// Issue #103: session ids the Enter-only resend fired for.
        resends: Arc<Mutex<Vec<u32>>>,
        config: SharedSamuraiConfig,
    }

    fn harness(dir: &Path) -> Harness {
        harness_with_writer(dir, None)
    }

    /// `writer`: `None` = the default recorder that confirms every body
    /// write; `Some` = a failure-path writer (issue #109 tests).
    fn harness_with_writer(dir: &Path, writer: Option<StdinWriter>) -> Harness {
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
        // Default: confirms every body write synchronously (issue #109) —
        // the delivered row and the armed watch then behave exactly as
        // production's post-write verdict. Failure-path tests inject their
        // own writer.
        let write_stdin: StdinWriter = writer.unwrap_or_else(|| {
            Arc::new(move |id, data, outcome| {
                writes_rec.lock().unwrap().push((id, data));
                outcome(Ok(()));
            })
        });

        let resends: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
        let resends_rec = resends.clone();
        let resend_enter: EnterResender = Arc::new(move |id| {
            resends_rec.lock().unwrap().push(id);
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
            resend_enter,
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
            resends,
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
            (
                Some("ABCDEF0000000000000000000000000000000000"),
                Some("abcdef0000000000000000000000000000000000"),
                true,
            ),
            (
                Some(a),
                Some("f000000000000000000000000000000000000000"),
                false,
            ),
            (None, Some(a), false), // unparseable handoff → verify required
            (Some(a), None, false), // unreadable HEAD → verify required
            (None, None, false),
        ];
        for (handoff, head, expected) in table {
            assert_eq!(
                head_matches(handoff, head),
                expected,
                "{handoff:?} vs {head:?}"
            );
        }
    }

    #[test]
    fn test_no_start_expiry_is_strict_and_prefers_registration_clock() {
        let timeout = Duration::from_secs(180);
        let now = AgeableInstant::now();
        // Backdating (not `Instant::checked_sub`) so this can't underflow on
        // a freshly booted machine — see issue #90.
        let mut old = AgeableInstant::now();
        old.backdate(Duration::from_secs(181));
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
        let table: [(&str, Option<&str>); 18] = [
            (
                "https://github.com/nachogl1/maestro.git",
                Some("nachogl1/maestro"),
            ),
            (
                "https://github.com/nachogl1/maestro",
                Some("nachogl1/maestro"),
            ),
            (
                "https://github.com/nachogl1/maestro/",
                Some("nachogl1/maestro"),
            ),
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
            // Shell metacharacters in a pathological remote must never reach
            // the `--repo` pin an autonomous orchestrator runs `gh` with.
            ("https://github.com/o/r;$(id)", None),
            ("https://github.com/o/r`id`", None),
            ("git@github.com:o/r|sh", None),
            ("https://github.com/o$(id)/r", None),
        ];
        for (url, expected) in table {
            assert_eq!(parse_owner_repo(url).as_deref(), expected, "url {url:?}");
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

        // The agent death is on the audit trail as a KILL row.
        let mut rows = Vec::new();
        for _ in 0..200 {
            rows = h.audit.read(project, None, None).await.unwrap().events;
            if rows
                .iter()
                .any(|r| r.event == AuditEventKind::Kill && r.details["phase"] == "killed")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(rows.iter().any(|r| r.event == AuditEventKind::Kill
            && r.details["phase"] == "killed"
            && r.details["cause"] == crate::core::supervisor::KILL_CAUSE_HANDOFF));

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
        // Issue #72: the journaling rider rides the composed brief.
        assert!(instruction.contains("journal.jsonl"));
        assert!(instruction.contains("\"BOTTLENECK\""));
        assert!(instruction.contains("NEVER rewrite or delete existing lines"));
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
        assert_eq!(
            state_of(&h.supervisor, 1),
            Some(SupervisorState::HandoffWritten)
        );
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
        // Issue #101: the SPAWN details name why gen-3 exists.
        assert_eq!(details["trigger"], "handoff");
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
        assert_eq!(spawn_rows[0].details["trigger"], "handoff");
        assert_eq!(spawn_rows[0].details["state"], "WORKING");
        assert_eq!(spawn_rows[0].generation, 3);

        // A SessionStarted for an UNRELATED session delivers nothing.
        h.replicator.observe_hook(&session_started(99));
        assert!(h.writes.lock().unwrap().is_empty());

        // The armed session's first SessionStarted delivers the ritual. The
        // payload carries NO submit key — the writer sends Enter separately
        // (samurai_pty), because text+CR in one write is read as a paste.
        h.replicator.observe_hook(&session_started(2));
        let writes = h.writes.lock().unwrap().clone();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, 2);
        assert!(!writes[0].1.contains('\r'), "no submit key in the payload");
        assert!(!writes[0].1.contains('\n'));
        assert!(writes[0].1.contains("generation 3"));
        assert!(writes[0].1.contains(".maestro/handoffs/epic-9-gen2.md"));

        // Issue #101: the delivered ritual lands an INJECT audit row with a
        // bounded excerpt of the exact text typed in.
        let mut inject_rows = Vec::new();
        for _ in 0..200 {
            let rows = h.audit.read(project, None, None).await.unwrap().events;
            inject_rows = rows
                .into_iter()
                .filter(|r| r.event == AuditEventKind::Inject)
                .collect();
            if !inject_rows.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(inject_rows.len(), 1);
        let inject = &inject_rows[0];
        assert_eq!(inject.session_id, 2);
        assert_eq!(inject.generation, 3);
        assert_eq!(inject.epic, "epic-9");
        assert_eq!(inject.details["phase"], "delivered");
        assert_eq!(inject.details["instruction"], "successor_ritual");
        assert_eq!(inject.details["gate"], "session_started");
        let excerpt = inject.details["excerpt"].as_str().unwrap();
        assert!(writes[0].1.starts_with(excerpt), "excerpt is a prefix");
        assert!(excerpt.chars().count() <= crate::core::samurai_audit::EXCERPT_MAX_CHARS);
        assert_eq!(
            inject.details["total_chars"].as_u64().unwrap() as usize,
            writes[0].1.chars().count()
        );

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
        h.replicator
            .backdate(3, SHA_TIMEOUT + Duration::from_secs(1));
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

        h.replicator
            .backdate(3, SHA_TIMEOUT + Duration::from_secs(1));
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

        h.replicator
            .backdate(3, SHA_TIMEOUT + Duration::from_secs(1));
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
        assert!(!writes[0].1.contains('\r'), "no submit key in the payload");
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
        h.replicator
            .backdate(3, SHA_TIMEOUT + Duration::from_secs(1));
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
            Arc::new(|_, _, outcome: crate::core::samurai_pty::DeliveryOutcome| outcome(Ok(()))),
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
        assert!(
            instruction.contains("SKIP"),
            "HEAD matched → verify skipped"
        );
    }

    /// The whole feature, from the context reading that arrives in a
    /// transcript to the successor staged for spawn — the cycle a live run
    /// performs, with only the PTY and the frontend's spawn call stubbed.
    ///
    /// Every step is the production one: a real file append parsed by the
    /// real watcher, the real context store, the real trigger, the real
    /// instruction text, the real git validation against a real repo whose
    /// WIP is really committed. The agent is the only actor simulated — it
    /// replies with the markers and does the work the instruction demands.
    #[tokio::test]
    async fn test_context_crossing_drives_the_whole_handoff_cycle() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-handoff-cycle";
        let epic = "epic #113";
        let session = 7u32;

        // The session's working directory is a real repository.
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        h.dirs
            .lock()
            .unwrap()
            .insert(session, repo.path().to_string_lossy().into_owned());

        // The real watcher feeding the real context store, wired exactly as
        // `lib.rs` wires its event tee.
        let context = Arc::new(SamuraiContextStore::new());
        let context_for_bus = context.clone();
        let bus = Arc::new(crate::core::event_bus::EventBus::new(Arc::new(
            move |event: ClaudeEvent| context_for_bus.observe(&event),
        )));
        let watcher = crate::core::transcript_watcher::TranscriptWatcher::new(bus);
        let transcript = dir.path().join("cycle.jsonl");
        std::fs::write(&transcript, "").unwrap();
        let transcript = transcript.canonicalize().unwrap();
        watcher.start_watching(session, transcript.clone());

        // The injector, chained into this replicator like production's.
        let typed: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let typed_rec = typed.clone();
        let dirs_for_resolver = h.dirs.clone();
        let session_dirs: SessionDirResolver =
            Arc::new(move |id| dirs_for_resolver.lock().unwrap().get(&id).cloned());
        let injector = SamuraiInjector::new(
            h.supervisor.clone(),
            context.clone(),
            h.config.clone(),
            Arc::new(
                move |_, data: String, outcome: crate::core::samurai_pty::DeliveryOutcome| {
                    typed_rec.lock().unwrap().push(data);
                    outcome(Ok(()));
                },
            ),
            h.audit.clone(),
            session_dirs,
            Some(h.replicator.clone()),
        );

        h.supervisor
            .register_session(session, project.into(), epic.into(), 1)
            .unwrap();
        // The agent finished a turn, so an instruction can be typed at once.
        injector.observe_hook(&ClaudeEvent::SessionEnded {
            session_id: session,
            reason: "stop".into(),
            timestamp: "t".into(),
        });

        // Below the threshold: the tick must leave the session alone.
        append_assistant_usage(&transcript, 300_000);
        wait_until(|| context.percent(session) == Some(30.0)).await;
        injector.tick();
        assert_eq!(
            state_of(&h.supervisor, session),
            Some(SupervisorState::Working),
            "30% is under the 40% default"
        );
        assert!(typed.lock().unwrap().is_empty(), "nothing typed under it");

        // Crossing it: 441,033 tokens of a 1M window = 44.1%.
        append_assistant_usage(&transcript, 441_033);
        wait_until(|| context.percent(session) == Some(44.1)).await;
        injector.tick();
        assert_eq!(
            state_of(&h.supervisor, session),
            Some(SupervisorState::HandoffRequested)
        );

        // The instruction really was typed, and it is the handoff one.
        use crate::core::samurai_injector::{ACK_TAG, WRITTEN_TAG};
        let instruction = typed.lock().unwrap().join("");
        assert!(
            instruction.contains(ACK_TAG) && instruction.contains("Handoff requested"),
            "the injected text must be the handoff instruction: {instruction}"
        );
        let relpath = samurai_prompts::handoff_file_relpath(epic, 1);
        assert!(
            instruction.contains(&relpath),
            "it must name the gen-1 handoff file: {instruction}"
        );

        // The agent acknowledges, then does what it was told: commits WIP and
        // writes the §6 file recording the post-commit HEAD.
        injector.observe(&ClaudeEvent::AssistantMessage {
            session_id: session,
            uuid: "ack".into(),
            text: format!(
                "<{ACK_TAG}>{}</{ACK_TAG}>",
                samurai_prompts::handoff_ack_value(1)
            ),
            model: "claude-opus-5".into(),
            token_usage: None,
            timestamp: "t".into(),
        });
        commit_wip(repo.path());
        let head = read_repo_head(repo.path()).unwrap();
        write_handoff(repo.path(), epic, 1, &head);
        injector.observe(&ClaudeEvent::AssistantMessage {
            session_id: session,
            uuid: "written".into(),
            text: format!(
                "<{WRITTEN_TAG}>{}</{WRITTEN_TAG}>",
                samurai_prompts::handoff_written_value(1)
            ),
            model: "claude-opus-5".into(),
            token_usage: None,
            timestamp: "t".into(),
        });

        // Validation → HANDOFF_WRITTEN → teardown → KILLED → successor staged.
        wait_until(|| state_of(&h.supervisor, session) == Some(SupervisorState::Killed)).await;
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;
        assert_eq!(
            *h.torn_down.lock().unwrap(),
            vec![session],
            "gen-1 is torn down"
        );
        let spawn = h.spawns.lock().unwrap()[0].clone();
        assert_eq!(spawn.generation, 2, "the successor is generation 2");
        let (_, ritual) = h.replicator.pending_view(2).unwrap();
        assert!(
            ritual.contains("SKIP"),
            "HEAD matches the handoff, so the successor skips verify: {ritual}"
        );

        // The audit tells the whole story, in order.
        let kinds: Vec<AuditEventKind> = h
            .audit
            .read(project, None, None)
            .await
            .unwrap()
            .events
            .into_iter()
            .map(|r| r.event)
            .filter(|k| *k != AuditEventKind::Inject)
            .collect();
        assert_eq!(
            kinds,
            vec![
                AuditEventKind::Spawn,
                AuditEventKind::Handoff, // requested
                AuditEventKind::Handoff, // written
                AuditEventKind::Kill,    // gen-1 killed for the handoff
            ],
            "audit trail of a clean handoff"
        );
    }

    /// Appends one assistant line whose usage sums to `context_tokens`, the
    /// shape `claude-opus-5` writes: input + cache creation + cache read.
    fn append_assistant_usage(transcript: &Path, context_tokens: u64) {
        use std::io::Write;
        let line = format!(
            r#"{{"parentUuid":"u","isSidechain":false,"type":"assistant","message":{{"model":"claude-opus-5","id":"m","type":"message","role":"assistant","content":[{{"type":"text","text":"working"}}],"usage":{{"input_tokens":4,"output_tokens":120,"cache_creation_input_tokens":1029,"cache_read_input_tokens":{}}}}},"uuid":"a","timestamp":"2026-08-14T13:58:09.201Z"}}"#,
            context_tokens - 1033
        );
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(transcript)
            .unwrap();
        writeln!(f, "{line}").unwrap();
    }

    /// The WIP commit the handoff instruction demands, staging one named path.
    fn commit_wip(dir: &Path) {
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
        std::fs::write(dir.join("tracked.txt"), "v2\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["commit", "-q", "-m", "feat(scratch): wip before handoff"]);
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
        let content = recovery_digest_content("epic-9", 2, 1, "2026-08-06T12:00:00Z", None, None);
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
        // Fix M4: the journaling rider rides recovery briefs too — and the
        // composed brief stays one paste-able line.
        assert!(instruction.contains("journal.jsonl"));
        assert!(instruction.contains("\"BOTTLENECK\""));
        assert!(!instruction.contains('\n'));
        // The digest file was written before staging, from the transcript.
        let digest = std::fs::read_to_string(
            repo.path()
                .join(".maestro/handoffs/epic-9-gen3-recovery.md"),
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
        // Fix M4: the journaling rider rides the DEAD-recovery brief.
        assert!(instruction.contains("journal.jsonl"));
        assert!(instruction.contains("\"BOTTLENECK\""));
        assert!(!instruction.contains('\n'));

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
            repo.path()
                .join(".maestro/handoffs/epic-9-gen3-recovery.md"),
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
        // Issue #101: the watchdog's DEAD verdict is what spawned gen-3.
        assert_eq!(details["trigger"], "watchdog");
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
        assert!(!writes[0].1.contains('\r'), "no submit key in the payload");

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
            repo.path()
                .join(".maestro/handoffs/epic-9-gen3-recovery.md"),
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
        run(&[
            "remote",
            "add",
            "origin",
            "https://github.com/nachogl1/maestro.git",
        ]);
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
        // Fix M4: the pin swap must keep the journaling rider aboard.
        assert!(instruction.contains("journal.jsonl"));
        assert!(instruction.contains("\"BOTTLENECK\""));
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
        // Fix M4: the unpinned staged brief carries the rider too.
        assert!(instruction.contains("journal.jsonl"));
        assert!(instruction.contains("\"BOTTLENECK\""));
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
        // what it was asked about — and the session state AT consult time
        // (review F3b: the absorber must be evaluated BEFORE the Killed
        // transition, while HANDOFF_WRITTEN still holds the sweep open).
        // (project, epic, session state at consult time)
        type AbsorbCall = (String, String, Option<SupervisorState>);
        let asked: Arc<Mutex<Vec<AbsorbCall>>> = Arc::new(Mutex::new(Vec::new()));
        let asked_rec = asked.clone();
        let supervisor_for_absorb = h.supervisor.clone();
        h.replicator.set_absorber(Arc::new(move |project, epic| {
            asked_rec.lock().unwrap().push((
                project.to_string(),
                epic.to_string(),
                state_of(&supervisor_for_absorb, 1),
            ));
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
            vec![(
                project.to_string(),
                "epic-9".to_string(),
                // Review F3b: consulted BEFORE the Killed transition, while
                // the state still blocks a concurrent sweep completion.
                Some(SupervisorState::HandoffWritten),
            )]
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

    #[tokio::test]
    async fn test_dead_session_is_absorbed_while_sweep_engaged() {
        // Review F7: a DEAD session during an engaged sweep must not stage a
        // recovery successor into the exhausted allowance — the epic is
        // absorbed (resume timer) and the trail carries a PARK row.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-dead-absorb";
        let repo = tempdir().unwrap();
        h.dirs
            .lock()
            .unwrap()
            .insert(1, repo.path().to_string_lossy().into_owned());
        let asked: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let asked_rec = asked.clone();
        h.replicator.set_absorber(Arc::new(move |project, epic| {
            asked_rec
                .lock()
                .unwrap()
                .push((project.to_string(), epic.to_string()));
            true
        }));
        let snapshot = to_dead(&h.supervisor, project, "epic-9", 2);

        h.replicator.on_dead(&snapshot);

        // Absorbed: nothing staged, nothing emitted, epic recorded.
        assert_eq!(h.replicator.pending_count(3), 0, "no recovery staged");
        assert_eq!(
            *asked.lock().unwrap(),
            vec![(project.to_string(), "epic-9".to_string())]
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(h.spawns.lock().unwrap().is_empty(), "no spawn event");
        // The PARK dead_absorbed row explains the missing successor.
        let mut absorbed = false;
        for _ in 0..200 {
            let rows = h.audit.read(project, None, None).await.unwrap().events;
            absorbed = rows.iter().any(|r| {
                r.event == AuditEventKind::Park
                    && r.details["phase"] == "dead_absorbed"
                    && r.generation == 2
                    && r.session_id == 1
            });
            if absorbed {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(absorbed, "PARK dead_absorbed row must land");
    }

    #[tokio::test]
    async fn test_spawn_events_carry_the_run_config_model() {
        // Review F4: the stored `model` preference must reach the spawn
        // event — resolved at emit time from the bound run-config store.
        use crate::core::samurai_run_config::{RunConfigStore, SamuraiRunConfig};

        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-model";
        let store = Arc::new(RunConfigStore::new(dir.path().join("runs")));
        let repo = tempdir().unwrap();
        let working_dir = repo.path().to_string_lossy().into_owned();
        let mut config = SamuraiRunConfig::new(project, "epic-9", working_dir.clone());
        config.model = Some("opus".to_string());
        store.save(&config).unwrap();
        h.replicator.set_run_configs(store);

        // A fresh spawn (resume/reconcile path) carries the config's model …
        h.replicator
            .spawn_generation(project, "epic-9", &working_dir, 4, Some(3), "resume_timer");
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;
        assert_eq!(
            h.spawns.lock().unwrap()[0].model.as_deref(),
            Some("opus"),
            "spawn_generation must emit the run config's model"
        );

        // … and an epic WITHOUT a config (or model) emits None.
        h.replicator.spawn_first_generation(
            project,
            "epic-77",
            &working_dir,
            "opening brief".to_string(),
        );
        wait_until(|| h.spawns.lock().unwrap().len() >= 2).await;
        assert_eq!(h.spawns.lock().unwrap()[1].model, None);
    }

    #[tokio::test]
    async fn test_staged_briefs_recompile_the_stored_workflow_graph() {
        // Issue #91: the run config snapshots the workflow graph at launch;
        // every successor brief must recompile THAT graph — never the
        // default — and a config without a graph falls back to the default
        // template (backward compat).
        use crate::core::samurai_run_config::{RunConfigStore, SamuraiRunConfig};
        use crate::core::samurai_workflow::{WorkflowEdge, WorkflowGraph, WorkflowNode};

        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-workflow";
        let store = Arc::new(RunConfigStore::new(dir.path().join("runs")));
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let head = read_repo_head(repo.path()).unwrap();
        write_handoff(repo.path(), "epic-9", 3, &head);
        let working_dir = repo.path().to_string_lossy().into_owned();

        let mut config = SamuraiRunConfig::new(project, "epic-9", working_dir.clone());
        config.workflow = Some(WorkflowGraph {
            nodes: vec![
                WorkflowNode {
                    id: "a".to_string(),
                    text: "custom implement ritual".to_string(),
                },
                WorkflowNode {
                    id: "b".to_string(),
                    text: "custom ship ritual".to_string(),
                },
            ],
            edges: vec![WorkflowEdge {
                from: "a".to_string(),
                to: "b".to_string(),
            }],
            start: "a".to_string(),
        });
        store.save(&config).unwrap();
        // A second run whose config predates workflows (no graph stored).
        store
            .save(&SamuraiRunConfig::new(
                project,
                "epic-88",
                working_dir.clone(),
            ))
            .unwrap();
        h.replicator.set_run_configs(store);

        // The successor ritual (handoff present) carries the STORED graph.
        h.replicator
            .spawn_generation(project, "epic-9", &working_dir, 4, Some(3), "resume_timer");
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;
        let (_, instruction) = h.replicator.pending_view(4).unwrap();
        assert!(
            instruction.contains("Step 1: custom implement ritual"),
            "{instruction}"
        );
        assert!(
            instruction.contains("Step 2: custom ship ritual"),
            "{instruction}"
        );
        assert!(
            !instruction.contains("fresh-eyes review"),
            "the stored graph replaces the default: {instruction}"
        );

        // The graph-less config compiles the DEFAULT template (its spawn
        // takes the recovery ritual — no epic-88 handoff exists — which
        // must carry the workflow too).
        h.replicator
            .spawn_generation(project, "epic-88", &working_dir, 6, Some(5), "resume_timer");
        wait_until(|| h.spawns.lock().unwrap().len() >= 2).await;
        let (_, instruction) = h.replicator.pending_view(6).unwrap();
        assert!(instruction.contains("RECOVERY MODE"), "{instruction}");
        assert!(
            instruction.contains("Step 2: Run a fresh-eyes review"),
            "no stored graph → the default workflow: {instruction}"
        );
        assert!(instruction.contains("END OF WORKFLOW"), "{instruction}");
    }

    // --- issue #61: spawn_generation (fresh spawns) + spawn retry ---

    #[tokio::test]
    async fn test_spawn_generation_with_handoff_stages_head_gated_successor_ritual() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let head = read_repo_head(repo.path()).unwrap();
        write_handoff(repo.path(), "epic-9", 3, &head);
        let working_dir = repo.path().to_string_lossy().into_owned();

        h.replicator
            .spawn_generation("C:/git/proj-sg-match", "epic-9", &working_dir, 4, Some(3), "resume_timer");
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;

        // The spawn event names the fresh generation and its working dir.
        let spawns = h.spawns.lock().unwrap().clone();
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0].generation, 4);
        assert_eq!(spawns[0].session_name, "samurai gen-4 epic-9");
        assert_eq!(spawns[0].working_dir, working_dir);

        // Handoff present + HEAD match → the normal ritual, verify skipped.
        let (registered, instruction) = h.replicator.pending_view(4).unwrap();
        assert_eq!(registered, None);
        assert!(instruction.contains("SKIP"));
        assert!(instruction.contains("generation 4"));
        assert!(instruction.contains(".maestro/handoffs/epic-9-gen3.md"));
        assert!(!instruction.contains("RECOVERY"));
        // Issue #72: the journaling rider rides the composed brief — and
        // the whole thing stays one paste-able line.
        assert!(instruction.contains("journal.jsonl"));
        assert!(instruction.contains("\"BOTTLENECK\""));
        assert!(!instruction.contains('\n'));

        // Issue #101: a fresh spawn's SPAWN linkage names its trigger (the
        // resumer passes "resume_timer" — the only caller left, now that
        // cold-start reconciliation alerts instead of spawning).
        let details = h
            .replicator
            .spawn_details("C:/git/proj-sg-match", "epic-9", 4)
            .unwrap();
        assert_eq!(details["trigger"], "resume_timer");
        assert_eq!(details["predecessor_generation"], 3);
    }

    #[tokio::test]
    async fn test_spawn_generation_without_handoff_stages_recovery_and_digest() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let repo = tempdir().unwrap();
        init_repo(repo.path()); // a repo, but NO handoff file for gen 3
        let working_dir = repo.path().to_string_lossy().into_owned();

        h.replicator
            .spawn_generation("C:/git/proj-sg-rec", "epic-9", &working_dir, 4, Some(3), "resume_timer");
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;

        let (_, instruction) = h.replicator.pending_view(4).unwrap();
        assert!(instruction.contains("RECOVERY"));
        assert!(instruction.contains("generation 4"));
        // Fix M4: the fresh-spawn recovery brief carries the journaling
        // rider, and stays one paste-able line.
        assert!(instruction.contains("journal.jsonl"));
        assert!(instruction.contains("\"BOTTLENECK\""));
        assert!(!instruction.contains('\n'));
        // The digest file exists before the spawn event fired, carrying the
        // no-transcript note (there is no predecessor transcript to digest).
        let digest_path = repo
            .path()
            .join(samurai_prompts::recovery_digest_relpath("epic-9", 4));
        let digest = std::fs::read_to_string(&digest_path).expect("digest file must exist");
        assert!(digest.contains("No transcript available"));
        assert!(digest.contains("epic epic-9"));
    }

    #[tokio::test]
    async fn test_spawn_generation_is_idempotent_per_generation() {
        // The schedule re-fires an entry after a crash mid-callback; a
        // second spawn_generation for the same triple must be a no-op.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let working_dir = repo.path().to_string_lossy().into_owned();

        h.replicator
            .spawn_generation("C:/git/proj-sg-idem", "epic-9", &working_dir, 4, Some(3), "resume_timer");
        h.replicator
            .spawn_generation("C:/git/proj-sg-idem", "epic-9", &working_dir, 4, Some(3), "resume_timer");
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;
        // Give the (single) async prep task time to finish emitting.
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert_eq!(h.replicator.pending_count(4), 1, "staged exactly once");
        assert_eq!(h.spawns.lock().unwrap().len(), 1, "emitted exactly once");
    }

    #[tokio::test]
    async fn test_spawn_generation_without_prior_still_refuses() {
        // No prior generation → no ritual can be derived; gen-1 goes through
        // spawn_first_generation (issue #63), never this arm.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        h.replicator
            .spawn_generation("C:/git/proj-sg-gen1", "epic-9", "C:/tmp/wt", 1, None, "resume_timer");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(h.replicator.pending_count(1), 0);
        assert!(h.spawns.lock().unwrap().is_empty());
    }

    // --- issue #63: spawn_first_generation (gen-1 launch seam) ---

    #[tokio::test]
    async fn test_spawn_first_generation_stages_and_delivers_the_launch_brief() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-launch";
        let brief = samurai_prompts::launch_instruction(
            &samurai_prompts::RunRefs::epics_only("#38"),
            Some("nachogl1/maestro"),
            &samurai_workflow::compiled_for_run(None),
        );

        h.replicator
            .spawn_first_generation(project, "#38", "C:/tmp/wt-38", brief.clone());

        // Synchronous: the spawn event is out before the call returns.
        let spawns = h.spawns.lock().unwrap().clone();
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0].generation, 1);
        assert_eq!(spawns[0].session_name, "samurai gen-1 38");
        assert_eq!(spawns[0].working_dir, "C:/tmp/wt-38");
        // The staged instruction is EXACTLY the caller's brief.
        let (registered, instruction) = h.replicator.pending_view(1).unwrap();
        assert_eq!(registered, None);
        assert_eq!(instruction, brief);

        // SPAWN details name the trigger, not a fabricated predecessor.
        let details = h.replicator.spawn_details(project, "#38", 1).unwrap();
        assert_eq!(details, json!({ "trigger": "launch" }));

        // Registration + first SessionStarted deliver the brief verbatim.
        let snapshot = h
            .supervisor
            .register_session_with_details(5, project.into(), "#38".into(), 1, details)
            .unwrap();
        h.replicator.on_registered(&snapshot);
        h.replicator.observe_hook(&session_started(5));
        let writes = h.writes.lock().unwrap().clone();
        assert_eq!(writes.len(), 1);
        // Verbatim, and WITHOUT a submit key — samurai_pty sends the Enter
        // as its own write so the CLI does not read the pair as a paste.
        assert_eq!(writes[0], (5, brief.clone()));
        assert!(h.replicator.pending_view(1).is_none(), "claimed = pruned");
    }

    #[tokio::test]
    async fn test_spawn_first_generation_is_idempotent_and_retries_like_a_resume() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-launch-retry";
        let brief = samurai_prompts::launch_instruction(
            &samurai_prompts::RunRefs::epics_only("#38"),
            None,
            &samurai_workflow::compiled_for_run(None),
        );

        h.replicator
            .spawn_first_generation(project, "#38", "C:/tmp/wt", brief.clone());
        h.replicator
            .spawn_first_generation(project, "#38", "C:/tmp/wt", brief);
        assert_eq!(h.replicator.pending_count(1), 1, "staged exactly once");
        assert_eq!(h.spawns.lock().unwrap().len(), 1, "emitted exactly once");

        // Unregistered launches ride the same re-emit machinery as resumes
        // (issue #61): one re-emit per expired window.
        h.replicator
            .backdate(1, SHA_TIMEOUT + Duration::from_secs(1));
        h.replicator.tick();
        assert_eq!(h.spawns.lock().unwrap().len(), 2, "dropped launch re-emits");
    }

    // --- issue #103: post-delivery watch (swallowed-Enter recovery) ---

    #[test]
    fn test_enter_resend_verdict_table() {
        let inside = ENTER_RESEND_WINDOW - Duration::from_secs(1);
        let expired = ENTER_RESEND_WINDOW + Duration::from_secs(1);
        // (elapsed, resends so far, expected)
        let table = [
            (inside, 0, EnterResendVerdict::Keep),
            // Strict boundary, like every other timeout in the chain.
            (ENTER_RESEND_WINDOW, 0, EnterResendVerdict::Keep),
            (expired, 0, EnterResendVerdict::Resend),
            (expired, MAX_ENTER_RESENDS - 1, EnterResendVerdict::Resend),
            (expired, MAX_ENTER_RESENDS, EnterResendVerdict::GiveUp),
            // A fresh window keeps waiting even with the budget spent —
            // GiveUp only ever fires on an EXPIRED window.
            (inside, MAX_ENTER_RESENDS, EnterResendVerdict::Keep),
        ];
        for (elapsed, resends, expected) in table {
            assert_eq!(
                enter_resend_verdict(elapsed, resends),
                expected,
                "elapsed {elapsed:?}, resends {resends}"
            );
        }
    }

    fn user_message(session_id: u32) -> ClaudeEvent {
        ClaudeEvent::UserMessage {
            session_id,
            uuid: "u".into(),
            text: "[Maestro Samurai] …".into(),
            timestamp: "t".into(),
        }
    }

    fn tool_use_started(session_id: u32) -> ClaudeEvent {
        ClaudeEvent::ToolUseStarted {
            session_id,
            tool_name: "Bash".into(),
            tool_use_id: "tu".into(),
            input_summary: String::new(),
            timestamp: "t".into(),
        }
    }

    #[test]
    fn test_turn_activity_classification() {
        // Releases: the prompt-submission transcript entry, the first tool
        // call (PreToolUse hook), an assistant reply, the session going away.
        assert_eq!(turn_activity_session(&user_message(5)), Some(5));
        assert_eq!(turn_activity_session(&tool_use_started(5)), Some(5));
        assert_eq!(
            turn_activity_session(&ClaudeEvent::AssistantMessage {
                session_id: 5,
                uuid: "a".into(),
                text: "hi".into(),
                model: "m".into(),
                token_usage: None,
                timestamp: "t".into(),
            }),
            Some(5)
        );
        assert_eq!(
            turn_activity_session(&ClaudeEvent::SessionEnded {
                session_id: 5,
                reason: "stop".into(),
                timestamp: "t".into(),
            }),
            Some(5)
        );
        // NOT evidence: SessionStarted is the very signal delivery rides on.
        assert_eq!(turn_activity_session(&session_started(5)), None);
    }

    /// Stages a gen-1 launch, registers session 5 and delivers the brief on
    /// its first SessionStarted — the armed-watch state every delivery-watch
    /// test starts from.
    fn deliver_launch_brief(h: &Harness, project: &str) {
        let brief = samurai_prompts::launch_instruction(
            &samurai_prompts::RunRefs::epics_only("#38"),
            Some("nachogl1/maestro"),
            &samurai_workflow::compiled_for_run(None),
        );
        h.replicator
            .spawn_first_generation(project, "#38", "C:/tmp/wt-103", brief);
        let details = h.replicator.spawn_details(project, "#38", 1).unwrap();
        let snapshot = h
            .supervisor
            .register_session_with_details(5, project.into(), "#38".into(), 1, details)
            .unwrap();
        h.replicator.on_registered(&snapshot);
        h.replicator.observe_hook(&session_started(5));
        assert_eq!(h.writes.lock().unwrap().len(), 1, "brief delivered once");
        assert_eq!(h.replicator.delivered_count(), 1, "delivery arms the watch");
    }

    #[tokio::test]
    async fn test_swallowed_enter_resends_only_the_submit_key_and_is_bounded() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-103-resend";
        deliver_launch_brief(&h, project);

        // Inside the window: quiet.
        h.replicator.tick();
        assert!(h.resends.lock().unwrap().is_empty());

        // First expiry: the lone Enter is re-sent — and ONLY the Enter, the
        // brief body is never re-pasted (it already sits in the input box).
        h.replicator
            .backdate_delivered(5, ENTER_RESEND_WINDOW + Duration::from_secs(1));
        h.replicator.tick();
        assert_eq!(h.resends.lock().unwrap().clone(), vec![5]);
        assert_eq!(h.writes.lock().unwrap().len(), 1, "body never re-sent");

        // Second expiry: the bounded second resend.
        h.replicator
            .backdate_delivered(5, ENTER_RESEND_WINDOW + Duration::from_secs(1));
        h.replicator.tick();
        assert_eq!(h.resends.lock().unwrap().clone(), vec![5, 5]);

        // Third expiry: budget spent — final ALERT and the watch is gone;
        // further ticks stay quiet.
        h.replicator
            .backdate_delivered(5, ENTER_RESEND_WINDOW + Duration::from_secs(1));
        h.replicator.tick();
        assert_eq!(h.replicator.delivered_count(), 0);
        h.replicator.tick();
        assert_eq!(
            h.resends.lock().unwrap().len(),
            2,
            "no resend after give-up"
        );

        // Audit trail: one submit_retry per resend, one final
        // submit_unconfirmed, all naming the launch.
        let mut retries = Vec::new();
        let mut unconfirmed = Vec::new();
        for _ in 0..200 {
            let rows = h.audit.read(project, None, None).await.unwrap().events;
            retries = rows
                .iter()
                .filter(|r| r.details["kind"] == "submit_retry")
                .cloned()
                .collect();
            unconfirmed = rows
                .into_iter()
                .filter(|r| r.details["kind"] == "submit_unconfirmed")
                .collect();
            if retries.len() == 2 && unconfirmed.len() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(retries.len(), 2);
        assert_eq!(retries[0].session_id, 5);
        assert_eq!(retries[0].generation, 1);
        assert_eq!(retries[0].details["attempt"], 1);
        assert_eq!(retries[0].details["launch"], true);
        assert_eq!(retries[1].details["attempt"], 2);
        assert_eq!(unconfirmed.len(), 1);
        assert_eq!(unconfirmed[0].session_id, 5);
        assert_eq!(unconfirmed[0].details["resends"], 2);
        assert_eq!(unconfirmed[0].details["launch"], true);
    }

    #[tokio::test]
    async fn test_evidence_on_an_expired_watch_wins_over_the_due_resend() {
        // Issue #106 review F4: the watch has already EXPIRED — the resend
        // is due on the very next tick — when turn evidence arrives. The
        // release must win: the Enter never fires (it would land in an
        // already-started turn), no retry bookkeeping is written, and the
        // body is (as always) never re-sent. With the resend now fired
        // under the delivered lock, the release and the verdict+fire are
        // atomic — this pins the observable contract.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-106-f4-gap";
        deliver_launch_brief(&h, project);

        h.replicator
            .backdate_delivered(5, ENTER_RESEND_WINDOW + Duration::from_secs(1));
        // Evidence lands between the expiry and the tick.
        h.replicator.observe(&user_message(5));
        assert_eq!(h.replicator.delivered_count(), 0, "watch released");

        h.replicator.tick();
        assert!(
            h.resends.lock().unwrap().is_empty(),
            "a released watch never resends"
        );
        assert_eq!(h.writes.lock().unwrap().len(), 1, "body never re-sent");
        let rows = h.audit.read(project, None, None).await.unwrap().events;
        assert!(
            !rows.iter().any(|r| r.details["kind"] == "submit_retry"
                || r.details["kind"] == "submit_unconfirmed"),
            "no retry bookkeeping for a confirmed submit"
        );
    }

    #[tokio::test]
    async fn test_turn_activity_releases_the_watch_and_stops_all_retries() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-103-release";
        deliver_launch_brief(&h, project);

        // Activity from an UNRELATED session must not release the watch.
        h.replicator.observe(&user_message(99));
        assert_eq!(h.replicator.delivered_count(), 1);

        // The transcript-side UserMessage — the CLI writes the prompt entry
        // at submission — proves the Enter landed (EventBus tee → observe).
        h.replicator.observe(&user_message(5));
        assert_eq!(h.replicator.delivered_count(), 0);

        // Released: ticks never resend and never write audit rows.
        h.replicator.tick();
        assert!(h.resends.lock().unwrap().is_empty());
        let rows = h.audit.read(project, None, None).await.unwrap().events;
        assert!(
            !rows.iter().any(|r| r.details["kind"] == "submit_retry"
                || r.details["kind"] == "submit_unconfirmed"),
            "no retry bookkeeping once the submit is confirmed"
        );
    }

    #[tokio::test]
    async fn test_hook_side_tool_use_releases_the_watch_too() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        deliver_launch_brief(&h, "C:/git/proj-103-hook");

        // PreToolUse arrives on the hook chain (observe_hook), an
        // independent channel from the transcript watcher.
        h.replicator.observe_hook(&tool_use_started(5));
        assert_eq!(h.replicator.delivered_count(), 0);
        h.replicator.tick();
        assert!(h.resends.lock().unwrap().is_empty());
    }

    // --- issue #109: delivered rows reflect write reality; injector
    //     deliveries get the same Enter-resend watch ---

    #[tokio::test]
    async fn test_failed_body_write_alerts_instead_of_false_delivered() {
        // Issue #109 (I2): the writer reports the body write FAILED — no
        // 'delivered' row may exist, no watch may arm (there is nothing in
        // the input box to re-submit), and a distinct ALERT names the error.
        let dir = tempdir().unwrap();
        let attempts: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
        let attempts_rec = attempts.clone();
        let failing: StdinWriter = Arc::new(move |id, _data, outcome| {
            attempts_rec.lock().unwrap().push(id);
            outcome(Err("pty gone".to_string()));
        });
        let h = harness_with_writer(dir.path(), Some(failing));
        let project = "C:/git/proj-109-failed-write";
        stage_successor(&h, project).await;
        let details = h.replicator.spawn_details(project, "epic-9", 3).unwrap();
        let snapshot = h
            .supervisor
            .register_session_with_details(2, project.into(), "epic-9".into(), 3, details)
            .unwrap();
        h.replicator.on_registered(&snapshot);

        h.replicator.observe_hook(&session_started(2));

        // The write was attempted, but nothing downstream may claim success.
        assert_eq!(*attempts.lock().unwrap(), vec![2]);
        assert_eq!(h.replicator.delivered_count(), 0, "no watch on a failed write");
        let mut rows = Vec::new();
        for _ in 0..200 {
            rows = h.audit.read(project, None, None).await.unwrap().events;
            if rows.iter().any(|r| r.details["kind"] == "delivery_failed") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let alert = rows
            .iter()
            .find(|r| r.details["kind"] == "delivery_failed")
            .expect("delivery_failed ALERT");
        assert_eq!(alert.event, AuditEventKind::Alert);
        assert_eq!(alert.session_id, 2);
        assert_eq!(alert.details["instruction"], "successor_ritual");
        assert_eq!(alert.details["source"], "replicator");
        assert_eq!(alert.details["error"], "pty gone");
        assert!(
            !rows
                .iter()
                .any(|r| r.event == AuditEventKind::Inject && r.details["phase"] == "delivered"),
            "a failed write must never leave a 'delivered' row"
        );
    }

    /// Wires a real injector to the harness replicator and walks session 1
    /// (gen-2, epic-9) through the idle-gated handoff injection — the state
    /// every injector-delivery watch test starts from. Returns the injector
    /// and the writes its own writer recorded.
    fn inject_handoff_via_injector(
        h: &Harness,
        project: &str,
        writer: Option<StdinWriter>,
    ) -> (SamuraiInjector, Arc<Mutex<Vec<(u32, String)>>>) {
        let dirs_for_resolver = h.dirs.clone();
        let session_dirs: SessionDirResolver =
            Arc::new(move |id| dirs_for_resolver.lock().unwrap().get(&id).cloned());
        let context = Arc::new(SamuraiContextStore::new());
        let writes: Arc<Mutex<Vec<(u32, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let writes_rec = writes.clone();
        let deliver: StdinWriter = writer.unwrap_or_else(|| {
            Arc::new(move |id, data, outcome| {
                writes_rec.lock().unwrap().push((id, data));
                outcome(Ok(()));
            })
        });
        let injector = SamuraiInjector::new(
            h.supervisor.clone(),
            context.clone(),
            h.config.clone(),
            deliver,
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
        // Idle first (Stop hook), then the trigger tick: the armed handoff
        // injects immediately through the already-idle path.
        injector.observe_hook(&ClaudeEvent::SessionEnded {
            session_id: 1,
            reason: "stop".into(),
            timestamp: "t".into(),
        });
        injector.tick();
        (injector, writes)
    }

    #[tokio::test]
    async fn test_injector_delivery_arms_the_watch_and_resends_like_a_ritual() {
        // Issue #109 (I1): an injector-delivered instruction (here: the
        // handoff request) gets the SAME issue-#103 Enter-resend watch as
        // replicator-staged rituals — mirrored on
        // test_swallowed_enter_resends_only_the_submit_key_and_is_bounded,
        // with the audit rows carrying source: "injector".
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-109-inj-resend";
        let (_injector, writes) = inject_handoff_via_injector(&h, project, None);

        // Delivered once (no submit key in the body) and the watch is armed.
        assert_eq!(writes.lock().unwrap().len(), 1);
        assert!(!writes.lock().unwrap()[0].1.contains('\r'));
        assert_eq!(h.replicator.delivered_count(), 1, "delivery arms the watch");

        // Inside the window: quiet.
        h.replicator.tick();
        assert!(h.resends.lock().unwrap().is_empty());

        // First and second expiry: the lone Enter — never the body.
        h.replicator
            .backdate_delivered(1, ENTER_RESEND_WINDOW + Duration::from_secs(1));
        h.replicator.tick();
        assert_eq!(h.resends.lock().unwrap().clone(), vec![1]);
        assert_eq!(writes.lock().unwrap().len(), 1, "body never re-sent");
        h.replicator
            .backdate_delivered(1, ENTER_RESEND_WINDOW + Duration::from_secs(1));
        h.replicator.tick();
        assert_eq!(h.resends.lock().unwrap().clone(), vec![1, 1]);

        // Third expiry: budget spent — final ALERT, watch gone.
        h.replicator
            .backdate_delivered(1, ENTER_RESEND_WINDOW + Duration::from_secs(1));
        h.replicator.tick();
        assert_eq!(h.replicator.delivered_count(), 0);

        // Audit trail: delivered row first, then injector-tagged retries.
        let mut rows = Vec::new();
        for _ in 0..200 {
            rows = h.audit.read(project, None, None).await.unwrap().events;
            if rows.iter().any(|r| r.details["kind"] == "submit_unconfirmed") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let delivered: Vec<_> = rows
            .iter()
            .filter(|r| r.event == AuditEventKind::Inject && r.details["phase"] == "delivered")
            .collect();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].details["instruction"], "handoff");
        let retries: Vec<_> = rows
            .iter()
            .filter(|r| r.details["kind"] == "submit_retry")
            .collect();
        assert_eq!(retries.len(), 2);
        assert_eq!(retries[0].session_id, 1);
        assert_eq!(retries[0].generation, 2);
        assert_eq!(retries[0].details["attempt"], 1);
        assert_eq!(retries[0].details["launch"], false);
        assert_eq!(retries[0].details["source"], "injector");
        let unconfirmed: Vec<_> = rows
            .iter()
            .filter(|r| r.details["kind"] == "submit_unconfirmed")
            .collect();
        assert_eq!(unconfirmed.len(), 1);
        assert_eq!(unconfirmed[0].details["resends"], 2);
        assert_eq!(unconfirmed[0].details["source"], "injector");
    }

    #[tokio::test]
    async fn test_turn_evidence_releases_an_injector_armed_watch() {
        // The UserMessage the CLI writes at prompt submission releases an
        // injector-armed watch exactly like a ritual's (issue #109).
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-109-inj-release";
        inject_handoff_via_injector(&h, project, None);
        assert_eq!(h.replicator.delivered_count(), 1);

        h.replicator.observe(&user_message(1));
        assert_eq!(h.replicator.delivered_count(), 0);
        h.replicator.tick();
        assert!(h.resends.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_injector_failed_write_alerts_and_never_arms_the_watch() {
        // Issue #109 (I2, injector side): a failed body write records the
        // distinct ALERT — no false 'delivered' row, no watch.
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-109-inj-failed";
        let failing: StdinWriter =
            Arc::new(move |_id, _data, outcome| outcome(Err("pty gone".to_string())));
        inject_handoff_via_injector(&h, project, Some(failing));

        assert_eq!(h.replicator.delivered_count(), 0, "no watch on a failed write");
        let mut rows = Vec::new();
        for _ in 0..200 {
            rows = h.audit.read(project, None, None).await.unwrap().events;
            if rows.iter().any(|r| r.details["kind"] == "delivery_failed") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let alert = rows
            .iter()
            .find(|r| r.details["kind"] == "delivery_failed")
            .expect("delivery_failed ALERT");
        assert_eq!(alert.session_id, 1);
        assert_eq!(alert.details["instruction"], "handoff");
        assert_eq!(alert.details["source"], "injector");
        assert_eq!(alert.details["error"], "pty gone");
        assert!(
            !rows
                .iter()
                .any(|r| r.event == AuditEventKind::Inject && r.details["phase"] == "delivered"),
            "a failed write must never leave a 'delivered' row"
        );
    }

    #[tokio::test]
    async fn test_dropped_spawn_entry_does_not_block_a_later_relaunch() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-launch-dropped";
        let brief = samurai_prompts::launch_instruction(
            &samurai_prompts::RunRefs::epics_only("#38"),
            None,
            &samurai_workflow::compiled_for_run(None),
        );

        h.replicator
            .spawn_first_generation(project, "#38", "C:/tmp/wt", brief.clone());
        assert_eq!(h.spawns.lock().unwrap().len(), 1);

        // Nobody consumes the spawn event (no project tab open): one re-emit
        // per expired window, then the entry gives up (spawn_dropped) and
        // latches for a late registration that will never come.
        for _ in 0..MAX_SPAWN_EMITS {
            h.replicator
                .backdate(1, SHA_TIMEOUT + Duration::from_secs(1));
            h.replicator.tick();
        }
        assert_eq!(h.spawns.lock().unwrap().len(), MAX_SPAWN_EMITS as usize);
        assert!(
            h.replicator.pending_view(1).is_some(),
            "latched, not pruned"
        );

        // The user re-opens the tab and launches again. The dropped entry is
        // replaced instead of blocking the staging guard, so the spawn event
        // fires — it used to no-op for the rest of the app's lifetime while
        // the UI still reported a successful launch.
        h.replicator
            .spawn_first_generation(project, "#38", "C:/tmp/wt", brief);
        assert_eq!(
            h.spawns.lock().unwrap().len(),
            MAX_SPAWN_EMITS as usize + 1,
            "the relaunch emits a spawn event"
        );
        assert_eq!(h.replicator.pending_count(1), 1, "replaced, not duplicated");
    }

    #[tokio::test]
    async fn test_spawn_retry_reemits_then_alerts_and_still_delivers_late() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-sg-retry";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let head = read_repo_head(repo.path()).unwrap();
        write_handoff(repo.path(), "epic-9", 3, &head);
        let working_dir = repo.path().to_string_lossy().into_owned();

        h.replicator
            .spawn_generation(project, "epic-9", &working_dir, 4, Some(3), "resume_timer");
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;
        assert_eq!(h.spawns.lock().unwrap().len(), 1);

        // Inside the window: no re-emit.
        h.replicator.tick();
        assert_eq!(h.spawns.lock().unwrap().len(), 1);

        // Each expired window re-emits once, up to MAX_SPAWN_EMITS total.
        for expected in 2..=MAX_SPAWN_EMITS as usize {
            h.replicator
                .backdate(4, SHA_TIMEOUT + Duration::from_secs(1));
            h.replicator.tick();
            assert_eq!(h.spawns.lock().unwrap().len(), expected);
        }

        // The next expiry gives up: ONE spawn_dropped ALERT, no further
        // emits — and NO generic successor_no_start for this path.
        h.replicator
            .backdate(4, SHA_TIMEOUT + Duration::from_secs(1));
        h.replicator.tick();
        assert_eq!(h.spawns.lock().unwrap().len(), MAX_SPAWN_EMITS as usize);
        let mut alerts = Vec::new();
        for _ in 0..200 {
            let rows = h.audit.read(project, None, None).await.unwrap().events;
            alerts = rows
                .into_iter()
                .filter(|r| r.details["kind"] == "spawn_dropped")
                .collect();
            if !alerts.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].generation, 4);
        assert_eq!(alerts[0].session_id, 0, "0 sentinel — no session exists");
        assert_eq!(alerts[0].details["epic"], "epic-9");

        // Latched, never re-alerts, and NOT pruned — even though the epic
        // has no supervised session at all (the resume situation).
        h.replicator.tick();
        h.replicator.tick();
        assert!(
            h.replicator.pending_view(4).is_some(),
            "kept for a late registration"
        );
        let rows = h.audit.read(project, None, None).await.unwrap().events;
        assert_eq!(
            rows.iter()
                .filter(|r| r.details["kind"] == "spawn_dropped")
                .count(),
            1
        );
        assert!(
            !rows
                .iter()
                .any(|r| r.details["kind"] == "successor_no_start"),
            "the retry path suppresses the generic no-start ALERT"
        );

        // A late registration + SessionStarted still delivers the ritual.
        let details = h.replicator.spawn_details(project, "epic-9", 4).unwrap();
        assert_eq!(details["predecessor_session_id"], 0);
        assert_eq!(details["predecessor_generation"], 3);
        let snapshot = h
            .supervisor
            .register_session_with_details(9, project.into(), "epic-9".into(), 4, details)
            .unwrap();
        h.replicator.on_registered(&snapshot);
        h.replicator.observe_hook(&session_started(9));
        let writes = h.writes.lock().unwrap().clone();
        assert_eq!(writes.len(), 1, "late registration still gets the ritual");
        assert_eq!(writes[0].0, 9);
        assert!(h.replicator.pending_view(4).is_none(), "claimed = pruned");
    }

    #[tokio::test]
    async fn test_spawn_retry_stops_once_registered() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-sg-reg";
        let repo = tempdir().unwrap();
        init_repo(repo.path());
        let head = read_repo_head(repo.path()).unwrap();
        write_handoff(repo.path(), "epic-9", 3, &head);
        let working_dir = repo.path().to_string_lossy().into_owned();

        h.replicator
            .spawn_generation(project, "epic-9", &working_dir, 4, Some(3), "resume_timer");
        wait_until(|| !h.spawns.lock().unwrap().is_empty()).await;

        let details = h.replicator.spawn_details(project, "epic-9", 4).unwrap();
        let snapshot = h
            .supervisor
            .register_session_with_details(9, project.into(), "epic-9".into(), 4, details)
            .unwrap();
        h.replicator.on_registered(&snapshot);

        // Registered: an expired window re-emits nothing; the generic
        // no-start machinery owns the entry from here (it has a session id).
        h.replicator
            .backdate(4, SHA_TIMEOUT + Duration::from_secs(1));
        h.replicator.tick();
        assert_eq!(
            h.spawns.lock().unwrap().len(),
            1,
            "no re-emit after registration"
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
        assert_eq!(alerts[0].session_id, 9);
    }
}
