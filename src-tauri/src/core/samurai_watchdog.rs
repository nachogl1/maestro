//! Samurai silent-death watchdog (Phase 1, `docs/samurai/prd.md` §5.7).
//!
//! A crashed `claude.exe` fires no hook and its terminal stays open at a
//! shell prompt — without this watchdog the session would look "working"
//! forever. One periodic tick combines two signals per supervised session:
//!
//! 1. **Transcript staleness** — the transcript file's mtime is older than
//!    [`TRANSCRIPT_STALE_AFTER`] (the watcher already knows each session's
//!    transcript path).
//! 2. **Process liveness** — is any `claude` process still alive under the
//!    session's shell?
//!
//! Decision table (see [`decide`]): a session the supervisor considers live
//! is declared DEAD only when the transcript is stale **and** no claude
//! process survives. Process alive + stale transcript = idle → do nothing,
//! however long the idle lasts — false positives are worse than misses.
//!
//! The DEAD transition itself produces the ALERT audit row
//! (`details.kind = "dead"`) and the `samurai-supervisor-event` the frontend
//! turns into an attention flag. Since Phase 2 (issue #56) it also triggers
//! recovery: the supervisor's change callback (lib.rs) chains every DEAD
//! snapshot into `SamuraiReplicator::on_dead`, which stages a gen-N+1
//! RECOVERY successor — this module stays detection-only on purpose.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use super::process_manager::ProcessManager;
use super::supervisor::{Supervisor, SupervisorState};
use super::transcript_watcher::TranscriptWatcher;

// TODO(#45): both windows below move into the Samurai run config once the
// config module lands (issue #45, built in parallel — not on this branch).

/// How often the watchdog looks at supervised sessions. With no live
/// supervised session a tick returns immediately without scanning processes.
pub const TICK_INTERVAL: Duration = Duration::from_secs(30);

/// A transcript untouched for this long counts as stale. Staleness alone
/// never kills anything — it only arms the process-liveness check — so this
/// can stay well under "multi-minute idle" territory without false positives.
pub const TRANSCRIPT_STALE_AFTER: Duration = Duration::from_secs(120);

/// Upper bound when walking parent chains; also breaks PID-reuse cycles.
/// Same bound as `commands/processes.rs`.
const MAX_ANCESTRY_HOPS: usize = 64;

/// What one tick concluded about one session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Transcript stale + no live claude: declare the session DEAD.
    Dead,
    /// Not enough evidence of death — do nothing this tick.
    Leave,
}

/// Pure decision for one session. Inputs are pre-gathered facts so the logic
/// is unit-testable without processes or files:
///
/// - a terminal-state session is already gone → [`Verdict::Leave`];
/// - a live claude process means the session is at worst idle → `Leave`,
///   regardless of how stale the transcript is (no false positives on
///   multi-minute idles);
/// - no transcript age (no transcript known, unreadable, or mtime in the
///   future) is missing evidence, not evidence of death → `Leave`;
/// - only stale transcript **and** no live claude → [`Verdict::Dead`].
pub fn decide(
    state: SupervisorState,
    transcript_age: Option<Duration>,
    claude_alive: bool,
    stale_after: Duration,
) -> Verdict {
    if state.is_terminal() {
        return Verdict::Leave;
    }
    if claude_alive {
        return Verdict::Leave;
    }
    match transcript_age {
        Some(age) if age >= stale_after => Verdict::Dead,
        _ => Verdict::Leave,
    }
}

/// Every pid that has one of `pids` in its descendant tree — i.e. the pids
/// themselves plus all their ancestors, walking `parent_of` with a hop cap.
/// A session's shell has a live claude descendant iff its pid is in this set.
fn ancestors_of(pids: &[u32], parent_of: &HashMap<u32, u32>) -> HashSet<u32> {
    let mut out = HashSet::new();
    for &pid in pids {
        if !out.insert(pid) {
            continue; // chain above was already walked
        }
        let mut cur = pid;
        let mut hops = 0;
        while let Some(&pp) = parent_of.get(&cur) {
            // Stop on self-parent, an already-walked ancestor, or the hop cap
            // (which also breaks PID-reuse cycles).
            if pp == cur || hops >= MAX_ANCESTRY_HOPS || !out.insert(pp) {
                break;
            }
            cur = pp;
            hops += 1;
        }
    }
    out
}

/// One process scan: every pid that has a live claude process among its
/// descendants. Matching follows the Processes watchlist rules — exact
/// executable stem (`claude` / `claude.exe`) or `claude` anywhere in the
/// command line, which also catches the `node … claude/cli.js` shim. Matching
/// broadly is the safe direction: over-matching can only delay a DEAD verdict,
/// never fabricate one.
fn scan_claude_ancestor_pids() -> HashSet<u32> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_cmd(UpdateKind::OnlyIfNotSet),
    );

    let parent_of: HashMap<u32, u32> = sys
        .processes()
        .iter()
        .filter_map(|(pid, p)| p.parent().map(|pp| (pid.as_u32(), pp.as_u32())))
        .collect();

    let claude_pids: Vec<u32> = sys
        .processes()
        .iter()
        .filter(|(_, p)| {
            let name = p.name().to_string_lossy().to_lowercase();
            let stem = name.strip_suffix(".exe").unwrap_or(&name);
            if stem == "claude" {
                return true;
            }
            p.cmd()
                .iter()
                .any(|c| c.to_string_lossy().to_lowercase().contains("claude"))
        })
        .map(|(pid, _)| pid.as_u32())
        .collect();

    ancestors_of(&claude_pids, &parent_of)
}

/// Age of the transcript file's last write. `None` when the file is missing,
/// unreadable, or its mtime is in the future — all "missing evidence" for
/// [`decide`].
fn transcript_age(path: &Path) -> Option<Duration> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .elapsed()
        .ok()
}

/// One watchdog pass over every supervised session.
async fn run_tick(
    supervisor: &Supervisor,
    transcripts: &TranscriptWatcher,
    processes: &ProcessManager,
) {
    let live: Vec<_> = supervisor
        .list_sessions()
        .into_iter()
        .filter(|s| !s.state.is_terminal())
        .collect();
    if live.is_empty() {
        return; // nothing supervised: skip the process scan entirely
    }

    // The full-process-table scan is synchronous OS work; keep it off the
    // async runtime (same reasoning as the transcript watcher's read pass).
    let claude_ancestors = tokio::task::spawn_blocking(scan_claude_ancestor_pids)
        .await
        .unwrap_or_default();

    for session in live {
        let claude_alive = processes
            .session_pid(session.session_id)
            .map(|pid| pid > 0 && claude_ancestors.contains(&(pid as u32)))
            .unwrap_or(false);
        let age = transcripts
            .transcript_path(session.session_id)
            .and_then(|p| transcript_age(&p));

        if decide(session.state, age, claude_alive, TRANSCRIPT_STALE_AFTER) == Verdict::Dead {
            log::warn!(
                "samurai watchdog: session {} ({}) has a stale transcript ({:?} old) and no live claude process — declaring DEAD",
                session.session_id,
                session.project,
                age,
            );
            // The transition writes the ALERT audit row (kind "dead") and
            // notifies the frontend. It can legally fail if the session
            // reached a terminal state between the snapshot and now; that
            // race lands on the audit log as an illegal_transition ALERT.
            if let Err(e) = supervisor.transition(session.session_id, SupervisorState::Dead) {
                log::warn!(
                    "samurai watchdog: DEAD transition for session {} rejected: {e}",
                    session.session_id
                );
            }
        }
    }
}

/// Spawns the watchdog loop. Called once from app setup; runs for the app's
/// lifetime (same lifecycle as `github::watchdog::spawn_watchdog`).
pub fn spawn_watchdog(
    supervisor: Arc<Supervisor>,
    transcripts: Arc<TranscriptWatcher>,
    processes: ProcessManager,
) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(TICK_INTERVAL);
        // After a laptop sleep, run one catch-up tick, not a burst.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first `tick()` completes immediately; with nothing supervised
        // at startup run_tick returns without scanning.
        loop {
            interval.tick().await;
            run_tick(&supervisor, &transcripts, &processes).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::samurai_audit::{AuditEventKind, AuditLog};
    use tempfile::tempdir;

    const STALE: Duration = Duration::from_secs(120);
    /// Comfortably past the window.
    const OLD: Option<Duration> = Some(Duration::from_secs(600));
    /// A recent write, well inside the window.
    const FRESH: Option<Duration> = Some(Duration::from_secs(5));

    #[test]
    fn test_dead_only_when_stale_and_no_claude() {
        use SupervisorState::Working;
        // The full 2x2 of the issue's decision table, WORKING session:
        assert_eq!(decide(Working, OLD, false, STALE), Verdict::Dead);
        assert_eq!(decide(Working, OLD, true, STALE), Verdict::Leave); // idle
        assert_eq!(decide(Working, FRESH, false, STALE), Verdict::Leave);
        assert_eq!(decide(Working, FRESH, true, STALE), Verdict::Leave);
    }

    #[test]
    fn test_idle_but_alive_never_flagged_however_stale() {
        // Multi-minute (here: multi-hour) idle with a live claude: never DEAD.
        let very_stale = Some(Duration::from_secs(8 * 60 * 60));
        assert_eq!(
            decide(SupervisorState::Working, very_stale, true, STALE),
            Verdict::Leave
        );
    }

    #[test]
    fn test_missing_transcript_evidence_is_not_death() {
        // No transcript known (session registered but claude never launched,
        // file unreadable, mtime in the future): never a DEAD verdict.
        assert_eq!(
            decide(SupervisorState::Working, None, false, STALE),
            Verdict::Leave
        );
    }

    #[test]
    fn test_staleness_boundary() {
        let at = Some(STALE);
        let just_under = Some(STALE - Duration::from_secs(1));
        assert_eq!(
            decide(SupervisorState::Working, at, false, STALE),
            Verdict::Dead
        );
        assert_eq!(
            decide(SupervisorState::Working, just_under, false, STALE),
            Verdict::Leave
        );
    }

    #[test]
    fn test_every_live_state_can_be_declared_dead() {
        // §5.2: any live state → DEAD. A claude that crashes mid-handoff or
        // mid-park is exactly the silent death this watchdog exists for.
        for state in [
            SupervisorState::Working,
            SupervisorState::HandoffRequested,
            SupervisorState::HandoffWritten,
            SupervisorState::ParkRequested,
        ] {
            assert_eq!(decide(state, OLD, false, STALE), Verdict::Dead, "{state:?}");
        }
    }

    #[test]
    fn test_terminal_states_are_left_alone() {
        for state in [
            SupervisorState::Killed,
            SupervisorState::Parked,
            SupervisorState::Dead,
        ] {
            assert_eq!(
                decide(state, OLD, false, STALE),
                Verdict::Leave,
                "{state:?}"
            );
        }
    }

    #[test]
    fn test_ancestors_of_walks_the_chain() {
        // shell(10) -> pwsh(20) -> node(30) -> claude(40)
        let parent_of = HashMap::from([(40, 30), (30, 20), (20, 10)]);
        let set = ancestors_of(&[40], &parent_of);
        assert!(set.contains(&10), "the shell is an ancestor of claude");
        assert!(set.contains(&40));
        assert!(!set.contains(&99), "unrelated pids stay out");
    }

    #[test]
    fn test_ancestors_of_unrelated_shell_not_included() {
        // claude(40) under shell 10; shell 50 has no claude descendant.
        let parent_of = HashMap::from([(40, 10), (60, 50)]);
        let set = ancestors_of(&[40], &parent_of);
        assert!(set.contains(&10));
        assert!(!set.contains(&50));
    }

    #[test]
    fn test_ancestors_of_survives_cycles_and_self_parent() {
        // PID-reuse cycle a->b->a and a self-parented root must both terminate.
        let cycle = HashMap::from([(1, 2), (2, 1)]);
        let set = ancestors_of(&[1], &cycle);
        assert!(set.contains(&1) && set.contains(&2));

        let self_parent = HashMap::from([(7, 7)]);
        assert_eq!(ancestors_of(&[7], &self_parent), HashSet::from([7]));
    }

    #[test]
    fn test_ancestors_of_multiple_claudes_shared_ancestor() {
        // Two claude processes under one shell(1): both chains land on it.
        let parent_of = HashMap::from([(10, 1), (20, 1)]);
        let set = ancestors_of(&[10, 20], &parent_of);
        assert_eq!(set, HashSet::from([1, 10, 20]));
    }

    #[test]
    fn test_transcript_age_missing_file_is_none() {
        assert_eq!(
            transcript_age(Path::new("Z:/definitely/not/a/transcript.jsonl")),
            None
        );
    }

    #[test]
    fn test_transcript_age_of_fresh_file_is_small() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, "{}\n").unwrap();
        let age = transcript_age(&path).expect("fresh file must have an age");
        assert!(age < Duration::from_secs(60), "unexpected age {age:?}");
    }

    /// The watchdog's DEAD path end-to-end against a real supervisor: the
    /// verdict-driven transition must land the session in DEAD and put the
    /// `kind: "dead"` ALERT on the audit trail.
    #[tokio::test]
    async fn test_dead_verdict_drives_supervisor_to_dead_with_alert() {
        let dir = tempdir().unwrap();
        let (audit, task) = AuditLog::new(dir.path().to_path_buf(), None);
        tokio::spawn(task);
        let supervisor = Supervisor::new(audit.clone(), None);
        let project = "C:/git/proj-watchdog";
        supervisor
            .register_session(1, project.into(), "epic-w".into(), 2)
            .unwrap();

        let session = &supervisor.list_sessions()[0];
        assert_eq!(decide(session.state, OLD, false, STALE), Verdict::Dead);

        let snapshot = supervisor
            .transition(session.session_id, SupervisorState::Dead)
            .unwrap();
        assert_eq!(snapshot.state, SupervisorState::Dead);

        let rows = audit.read(project, None, None).await.unwrap().events;
        let alert = rows.last().unwrap();
        assert_eq!(alert.event, AuditEventKind::Alert);
        assert_eq!(alert.details["kind"], "dead");
        assert_eq!(alert.session_id, 1);
        assert_eq!(alert.generation, 2);
    }
}
