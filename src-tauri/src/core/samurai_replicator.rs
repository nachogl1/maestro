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
//! Same shape as the watchdog/injector: decisions as pure functions, I/O at
//! the edges, one periodic timeout pass (driven by the injector's tick).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;

use super::claude_event::ClaudeEvent;
use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_config::SharedSamuraiConfig;
use super::samurai_injector::{strip_extended_prefix, SessionDirResolver};
use super::samurai_prompts;
use super::supervisor::{SessionSnapshot, Supervisor, SupervisorState};
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
    queued_at: Instant,
    /// Set when the frontend registered the successor: (session id, when).
    /// The no-start clock runs from here; before registration it runs from
    /// `queued_at` so a spawn flow that never happens still ALERTs.
    registered: Option<(u32, Instant)>,
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
/// Blocking: only ever called inside `spawn_blocking`.
fn read_repo_head(dir: &Path) -> Result<String, String> {
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
    teardown: SessionTeardown,
    emit_spawn: SuccessorEmitter,
    write_stdin: StdinWriter,
    pending: Mutex<Vec<PendingRitual>>,
}

impl SamuraiReplicator {
    pub fn new(
        supervisor: Arc<Supervisor>,
        audit: AuditLog,
        config: SharedSamuraiConfig,
        session_dirs: SessionDirResolver,
        teardown: SessionTeardown,
        emit_spawn: SuccessorEmitter,
        write_stdin: StdinWriter,
    ) -> Self {
        Self {
            supervisor,
            audit,
            config,
            session_dirs,
            teardown,
            emit_spawn,
            write_stdin,
            pending: Mutex::new(Vec::new()),
        }
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
            log::error!(
                "samurai replicator: session {} has no recorded working directory — not killing, ALERT",
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
                        "failure": "the session's working directory is unknown",
                    }),
                ),
            );
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
        // have no bounded completion time → blocking pool.
        let relpath =
            samurai_prompts::handoff_file_relpath(&snapshot.epic, snapshot.generation);
        let gate_dir = PathBuf::from(working_dir.clone());
        let head_matched = tokio::task::spawn_blocking(move || {
            let handoff = std::fs::read_to_string(gate_dir.join(&relpath))
                .map_err(|e| {
                    log::warn!("samurai replicator: could not re-read handoff {relpath}: {e}");
                })
                .ok();
            let handoff_sha = handoff
                .as_deref()
                .and_then(samurai_prompts::handoff_head_sha);
            let head = read_repo_head(&gate_dir)
                .map_err(|e| log::warn!("samurai replicator: {e}"))
                .ok();
            head_matches(handoff_sha.as_deref(), head.as_deref())
        })
        .await
        .unwrap_or(false);

        // Full teardown, mirroring the manual kill command path, BEFORE the
        // Killed transition so the audit row records an accomplished fact.
        (self.teardown)(snapshot.session_id).await;

        // HANDOFF_WRITTEN → KILLED: writes the `HANDOFF phase=killed` audit
        // row and emits the supervisor event the frontend clears the dead
        // tile on. A rejection (e.g. the watchdog declared the session DEAD
        // mid-teardown) aborts the successor — DEAD has its own recovery
        // path and must not race a second spawn.
        if let Err(e) = self
            .supervisor
            .transition(snapshot.session_id, SupervisorState::Killed)
        {
            log::warn!(
                "samurai replicator: Killed transition for session {} rejected ({e}) — successor not staged",
                snapshot.session_id
            );
            return;
        }

        let generation = snapshot.generation + 1;
        let instruction = samurai_prompts::successor_ritual_instruction(
            &snapshot.epic,
            snapshot.generation,
            head_matched,
        );
        let spawn = SuccessorSpawn {
            project: snapshot.project.clone(),
            epic: snapshot.epic.clone(),
            generation,
            working_dir,
            session_name: samurai_prompts::successor_session_name(&snapshot.epic, generation),
        };
        log::info!(
            "samurai replicator: session {} (gen-{}) killed for epic {} — staging gen-{generation} (HEAD gate: {})",
            snapshot.session_id,
            snapshot.generation,
            snapshot.epic,
            if head_matched { "match, verify skipped" } else { "mismatch, verify required" },
        );
        self.lock_pending().push(PendingRitual {
            project: snapshot.project.clone(),
            epic: snapshot.epic.clone(),
            generation,
            instruction,
            predecessor_session_id: snapshot.session_id,
            predecessor_generation: snapshot.generation,
            queued_at: Instant::now(),
            registered: None,
        });
        (self.emit_spawn)(&spawn);
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
                json!({
                    "predecessor_session_id": p.predecessor_session_id,
                    "predecessor_generation": p.predecessor_generation,
                })
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
    /// one at all) raises a single `successor_no_start` ALERT and stops
    /// being tracked.
    pub fn tick(&self) {
        let timeout = Duration::from_secs(
            self.config
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .ack_timeout_secs,
        );
        let expired: Vec<PendingRitual> = {
            let mut pending = self.lock_pending();
            let mut expired = Vec::new();
            let mut i = 0;
            while i < pending.len() {
                let p = &pending[i];
                if no_start_expired(p.queued_at, p.registered.map(|(_, t)| t), timeout) {
                    expired.push(pending.remove(i));
                } else {
                    i += 1;
                }
            }
            expired
        };
        for p in expired {
            let session_id = p
                .registered
                .map(|(id, _)| id)
                .unwrap_or(p.predecessor_session_id);
            log::error!(
                "samurai replicator: successor gen-{} for epic {} never started (registered: {}) — ALERT",
                p.generation,
                p.epic,
                p.registered.is_some(),
            );
            self.audit.append(
                &p.project,
                AuditEvent::now(
                    p.epic.clone(),
                    AuditEventKind::Alert,
                    p.generation,
                    session_id,
                    json!({
                        "kind": "successor_no_start",
                        "registered": p.registered.is_some(),
                        "predecessor_session_id": p.predecessor_session_id,
                        "predecessor_generation": p.predecessor_generation,
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
            teardown,
            emit_spawn,
            write_stdin,
        ));
        Harness {
            replicator,
            supervisor,
            audit,
            dirs,
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
    async fn test_missing_handoff_or_broken_repo_defaults_to_verify_required() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        // Working dir exists but holds neither a handoff file nor a repo.
        let not_a_repo = tempdir().unwrap();
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

        // Past ack_timeout_secs of registration: single ALERT, untracked.
        h.replicator.backdate(3, SHA_TIMEOUT + Duration::from_secs(1));
        h.replicator.tick();
        assert!(h.replicator.pending_view(3).is_none());
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

        // Further ticks stay quiet, and a late SessionStarted writes nothing.
        h.replicator.tick();
        h.replicator.observe_hook(&session_started(2));
        assert!(h.writes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_never_registered_successor_alerts_from_staging_clock() {
        let dir = tempdir().unwrap();
        let h = harness(dir.path());
        let project = "C:/git/proj-rep-noreg";
        stage_successor(&h, project).await;

        h.replicator.backdate(3, SHA_TIMEOUT + Duration::from_secs(1));
        h.replicator.tick();
        assert!(h.replicator.pending_view(3).is_none());
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
        // No successor id exists — the row points at the predecessor.
        assert_eq!(alerts[0].session_id, 1);
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
}
