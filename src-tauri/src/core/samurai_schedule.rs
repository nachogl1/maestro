//! Persisted Samurai resume timers — `schedule.json` (issue #59; PRD §5.5,
//! §7, §8 row 3).
//!
//! When an epic parks against the allowance window, the caller (P3.2)
//! computes `fire_at = resets_at + 5 min + per-epic jitter` (PRD §7 — the
//! jitter helper lives here, see [`jitter_secs`]) and [`arm`]s an entry.
//! This module only stores and fires timers; what a firing *means* (a fresh
//! spawn from the handoff file) is the callback's business — a logging stub
//! until P3.3 (issue #61) wires the real resume.
//!
//! **Location:** one `schedule.json` for the whole app. The store is rooted
//! at a caller-supplied base dir — the app passes
//! `commands::ai_runner::artifact_base_dir("samurai")`, so the file lives at
//! `<app data>/samurai/schedule.json`; tests pass a tempdir. On-disk shape:
//! a plain JSON array of [`ScheduleEntry`].
//!
//! **Restart survival (PRD §5.5):** the constructor reads `schedule.json`
//! and the loop's first tick — `tokio::time::interval`'s initial immediate
//! tick — fires every entry whose `fire_at` already passed during downtime.
//! A corrupt `schedule.json` loads as empty (warned, never a panic); the
//! lost timers are backstopped by cold-start reconciliation (PRD §5.6),
//! which respawns any live epic without an orchestrator regardless.
//!
//! **Self-clean (PRD §8 row 3):** an entry is removed from `schedule.json`
//! AFTER its callback returns — so a crash mid-callback re-fires the entry
//! on next launch. That is the safe direction: resume spawning is
//! idempotent (one worktree per epic; a successor spawn for an epic that
//! already has a living orchestrator is refused by reconciliation), whereas
//! removing first would silently lose the resume on a crash. When the last
//! entry is removed the file itself is deleted.
//!
//! **Fire granularity:** a 30s interval tick (same shape as
//! `samurai_watchdog::spawn_watchdog` / `allowance_watcher`), not exact
//! sleeps — timers are minute-granular by design (resets + 5 min).

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::samurai_prompts::epic_slug;

/// How often the loop checks for due entries. Coarse on purpose (module doc).
const TICK_INTERVAL: Duration = Duration::from_secs(30);

/// Upper bound of the per-epic jitter, inclusive (PRD §7: anti-thundering-
/// herd spread over 0..=5 minutes).
pub const MAX_JITTER_SECS: u64 = 300;

/// Fired for each due entry. A stub (log-only) until P3.3 wires the real
/// resume spawn — see the construction site in `lib.rs`.
pub type FireCallback = Arc<dyn Fn(ScheduleEntry) + Send + Sync>;

/// One persisted timer. Kept lean (PRD §8): identity + when + why — the run
/// config (`samurai_run_config`) holds everything a resume spawn needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduleEntry {
    /// Canonical project path, `\\?\`-stripped (fork convention); re-
    /// normalized on `arm` so lookups by either spelling match.
    pub project_path: String,
    /// Epic reference — with `project_path`, the timer's identity: one
    /// pending timer per (project, epic).
    pub epic: String,
    /// RFC 3339 UTC fire time, computed by the caller
    /// (`resets_at + 5 min +` [`jitter_secs`]).
    pub fire_at: String,
    /// Why the timer exists (e.g. `"park"`) — for the audit trail and the
    /// Second Brain Files panel ("resumes at 14:32").
    pub reason: String,
}

/// The persisted timer store + in-memory mirror. Constructed once at app
/// setup; the returned future is the fire loop, spawned by the caller
/// (`tauri::async_runtime::spawn` in the app, `tokio::spawn` in tests —
/// same split as `samurai_audit::AuditLog::new`).
pub struct SamuraiSchedule {
    path: PathBuf,
    /// The lock covers memory + file together: every mutation persists
    /// before releasing, so the file never lags a reader's view.
    entries: Mutex<Vec<ScheduleEntry>>,
    on_fire: FireCallback,
}

impl SamuraiSchedule {
    /// Loads `<base_dir>/schedule.json` (missing file = empty; corrupt =
    /// warn + empty, see module doc) and returns the handle plus the fire-
    /// loop future. The loop's first tick completes immediately, which is
    /// what makes past-due entries fire right on launch.
    pub fn new(
        base_dir: PathBuf,
        on_fire: FireCallback,
    ) -> (Arc<Self>, impl std::future::Future<Output = ()> + Send) {
        let path = base_dir.join("schedule.json");
        let entries = load_entries(&path);
        let schedule = Arc::new(Self {
            path,
            entries: Mutex::new(entries),
            on_fire,
        });
        let loop_schedule = schedule.clone();
        let task = async move {
            let mut interval = tokio::time::interval(TICK_INTERVAL);
            // After a laptop sleep, one catch-up tick, not a burst.
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                loop_schedule.fire_due();
            }
        };
        (schedule, task)
    }

    /// Persists `entry` and arms it in memory, replacing any existing timer
    /// for the same (project, epic) — re-arming is how a park updates an
    /// earlier estimate.
    pub fn arm(&self, entry: ScheduleEntry) -> Result<(), String> {
        let mut entry = entry;
        entry.project_path = normalize_project(&entry.project_path);
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        entries.retain(|e| !(e.project_path == entry.project_path && e.epic == entry.epic));
        entries.push(entry);
        persist(&self.path, &entries)
    }

    /// Cancels the (project, epic) timer if one is pending. `Ok(false)` when
    /// nothing was armed — cancelling twice is not an error.
    pub fn cancel(&self, project: &str, epic: &str) -> Result<bool, String> {
        let project = normalize_project(project);
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let before = entries.len();
        entries.retain(|e| !(e.project_path == project && e.epic == epic));
        if entries.len() == before {
            return Ok(false);
        }
        persist(&self.path, &entries)?;
        Ok(true)
    }

    /// Snapshot of every pending timer (for a future Tauri command / the
    /// Second Brain Files panel).
    pub fn list(&self) -> Vec<ScheduleEntry> {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// One tick's work: fire every due entry, then self-clean it. Callback
    /// runs OUTSIDE the lock (it may call back into `arm`/`cancel`); removal
    /// matches on `fire_at` too, so a re-arm issued during the callback
    /// survives the cleanup.
    fn fire_due(&self) {
        let now = Utc::now();
        let due: Vec<ScheduleEntry> = {
            let entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
            entries.iter().filter(|e| is_due(e, now)).cloned().collect()
        };
        for entry in due {
            log::info!(
                "samurai schedule: firing timer for epic {} in {} (reason: {}, fire_at: {})",
                entry.epic,
                entry.project_path,
                entry.reason,
                entry.fire_at,
            );
            (self.on_fire)(entry.clone());
            // Remove AFTER the callback returned (module doc: a crash
            // mid-callback re-fires on next launch — the safe direction).
            let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
            entries.retain(|e| {
                !(e.project_path == entry.project_path
                    && e.epic == entry.epic
                    && e.fire_at == entry.fire_at)
            });
            if let Err(e) = persist(&self.path, &entries) {
                log::error!("samurai schedule: failed to persist after fire: {e}");
            }
        }
    }
}

/// Deterministic per-epic jitter in `0..=`[`MAX_JITTER_SECS`] seconds
/// (PRD §7: resume at `resets_at + 5 min + jitter` so concurrent epics never
/// resume as a thundering herd). FNV-1a over [`epic_slug`] — the slug, not
/// the raw ref, so `#37` and `37` (which already share handoff files and a
/// worktree) also share their jitter. Exported for P3.2, which computes
/// `fire_at`; this module only stores and fires it.
pub fn jitter_secs(epic: &str) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET;
    for byte in epic_slug(epic).as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash % (MAX_JITTER_SECS + 1)
}

/// A timer is due once `fire_at <= now`. An unparseable `fire_at` counts as
/// due — firing a resume early is recoverable (spawning is idempotent),
/// silently never firing it would strand the epic.
fn is_due(entry: &ScheduleEntry, now: DateTime<Utc>) -> bool {
    match DateTime::parse_from_rfc3339(&entry.fire_at) {
        Ok(fire_at) => fire_at <= now,
        Err(e) => {
            log::warn!(
                "samurai schedule: unparseable fire_at {:?} for epic {} ({e}) — treating as due",
                entry.fire_at,
                entry.epic,
            );
            true
        }
    }
}

fn load_entries(path: &PathBuf) -> Vec<ScheduleEntry> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            log::warn!("samurai schedule: cannot read {path:?}: {e} — starting empty");
            return Vec::new();
        }
    };
    match serde_json::from_str(&content) {
        Ok(entries) => entries,
        Err(e) => {
            log::warn!(
                "samurai schedule: corrupt {path:?}: {e} — starting empty \
                 (cold-start reconciliation backstops any lost timer)"
            );
            Vec::new()
        }
    }
}

/// Atomic write (temp + rename, same rationale as
/// `samurai_run_config::atomic_write_json`); an empty list deletes the file
/// instead — `schedule.json` self-cleans away entirely (PRD §8 row 3).
fn persist(path: &PathBuf, entries: &[ScheduleEntry]) -> Result<(), String> {
    if entries.is_empty() {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("failed to remove empty {path:?}: {e}")),
        };
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create schedule dir {parent:?}: {e}"))?;
    }
    let json = serde_json::to_string_pretty(entries)
        .map_err(|e| format!("failed to serialize schedule: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("failed to write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("failed to move {tmp:?} into place at {path:?}: {e}"))
}

/// Strips the Windows `\\?\` extended-length prefix, per fork convention
/// (see `samurai_audit::normalize_project`).
fn normalize_project(project: &str) -> String {
    project.strip_prefix(r"\\?\").unwrap_or(project).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Collects fired entries synchronously — `fire_due` invokes the
    /// callback inline, so assertions after the call are deterministic.
    fn collector() -> (FireCallback, Arc<Mutex<Vec<ScheduleEntry>>>) {
        let fired: Arc<Mutex<Vec<ScheduleEntry>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = fired.clone();
        let callback: FireCallback = Arc::new(move |entry| {
            sink.lock().unwrap().push(entry);
        });
        (callback, fired)
    }

    fn entry(project: &str, epic: &str, fire_at: &str) -> ScheduleEntry {
        ScheduleEntry {
            project_path: project.to_string(),
            epic: epic.to_string(),
            fire_at: fire_at.to_string(),
            reason: "park".to_string(),
        }
    }

    fn in_one_hour() -> String {
        (Utc::now() + chrono::Duration::hours(1)).to_rfc3339()
    }

    #[test]
    fn test_arm_persists_and_survives_reload() {
        let dir = tempdir().unwrap();
        let (cb, _) = collector();
        {
            let (schedule, _task) = SamuraiSchedule::new(dir.path().to_path_buf(), cb.clone());
            schedule
                .arm(entry("C:/git/alpha", "#37", &in_one_hour()))
                .unwrap();
            schedule
                .arm(entry("C:/git/beta", "#9", &in_one_hour()))
                .unwrap();
        }
        // A fresh instance (an app restart) must see both timers.
        let (schedule, _task) = SamuraiSchedule::new(dir.path().to_path_buf(), cb);
        let mut epics: Vec<String> = schedule.list().into_iter().map(|e| e.epic).collect();
        epics.sort();
        assert_eq!(epics, vec!["#37".to_string(), "#9".to_string()]);
    }

    #[test]
    fn test_arm_replaces_existing_timer_for_same_epic() {
        let dir = tempdir().unwrap();
        let (cb, _) = collector();
        let (schedule, _task) = SamuraiSchedule::new(dir.path().to_path_buf(), cb);
        schedule
            .arm(entry("C:/git/alpha", "#37", "2027-01-01T00:00:00+00:00"))
            .unwrap();
        schedule
            .arm(entry("C:/git/alpha", "#37", "2027-06-01T00:00:00+00:00"))
            .unwrap();
        let entries = schedule.list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].fire_at, "2027-06-01T00:00:00+00:00");
    }

    #[test]
    fn test_cancel_removes_and_persists() {
        let dir = tempdir().unwrap();
        let (cb, _) = collector();
        let (schedule, _task) = SamuraiSchedule::new(dir.path().to_path_buf(), cb.clone());
        schedule
            .arm(entry("C:/git/alpha", "#37", &in_one_hour()))
            .unwrap();
        schedule
            .arm(entry("C:/git/alpha", "#38", &in_one_hour()))
            .unwrap();

        assert!(schedule.cancel("C:/git/alpha", "#37").unwrap());
        assert!(!schedule.cancel("C:/git/alpha", "#37").unwrap());
        assert_eq!(schedule.list().len(), 1);

        // The cancel reached the file, not just memory.
        let (reloaded, _task) = SamuraiSchedule::new(dir.path().to_path_buf(), cb);
        assert_eq!(reloaded.list().len(), 1);
        assert_eq!(reloaded.list()[0].epic, "#38");
    }

    #[test]
    fn test_verbatim_prefix_matches_plain_spelling() {
        let dir = tempdir().unwrap();
        let (cb, _) = collector();
        let (schedule, _task) = SamuraiSchedule::new(dir.path().to_path_buf(), cb);
        schedule
            .arm(entry(r"\\?\C:\git\maestro", "#37", &in_one_hour()))
            .unwrap();
        assert!(schedule.cancel(r"C:\git\maestro", "#37").unwrap());
    }

    #[test]
    fn test_fire_due_fires_past_entries_and_self_cleans() {
        let dir = tempdir().unwrap();
        let (cb, fired) = collector();
        let (schedule, _task) = SamuraiSchedule::new(dir.path().to_path_buf(), cb);
        schedule
            .arm(entry("C:/git/alpha", "#37", "2020-01-01T00:00:00+00:00"))
            .unwrap();
        schedule
            .arm(entry("C:/git/alpha", "#38", &in_one_hour()))
            .unwrap();

        schedule.fire_due();

        let fired = fired.lock().unwrap();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].epic, "#37");
        // The fired entry self-cleaned; the future one stayed armed —
        // in memory and on disk.
        assert_eq!(schedule.list().len(), 1);
        assert_eq!(schedule.list()[0].epic, "#38");
        let on_disk = load_entries(&dir.path().join("schedule.json"));
        assert_eq!(on_disk.len(), 1);
        assert_eq!(on_disk[0].epic, "#38");
    }

    #[test]
    fn test_file_deleted_when_last_timer_fires() {
        let dir = tempdir().unwrap();
        let (cb, fired) = collector();
        let (schedule, _task) = SamuraiSchedule::new(dir.path().to_path_buf(), cb);
        schedule
            .arm(entry("C:/git/alpha", "#37", "2020-01-01T00:00:00+00:00"))
            .unwrap();

        schedule.fire_due();

        assert_eq!(fired.lock().unwrap().len(), 1);
        assert!(schedule.list().is_empty());
        // PRD §8 row 3: schedule.json self-cleans away entirely.
        assert!(!dir.path().join("schedule.json").exists());
    }

    #[tokio::test]
    async fn test_past_due_entry_fires_immediately_on_load() {
        // The restart scenario: a timer expired while the app was down. The
        // spawned loop's first (immediate) tick must fire it — no 30s wait.
        let dir = tempdir().unwrap();
        let (cb, _) = collector();
        {
            let (schedule, _task) = SamuraiSchedule::new(dir.path().to_path_buf(), cb);
            schedule
                .arm(entry("C:/git/alpha", "#37", "2020-01-01T00:00:00+00:00"))
                .unwrap();
        }

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let notify: FireCallback = Arc::new(move |entry| {
            let _ = tx.send(entry);
        });
        let (_schedule, task) = SamuraiSchedule::new(dir.path().to_path_buf(), notify);
        tokio::spawn(task);

        let fired = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("past-due timer must fire on the first tick")
            .expect("channel closed without a fire");
        assert_eq!(fired.epic, "#37");
        assert_eq!(fired.reason, "park");
    }

    #[test]
    fn test_unparseable_fire_at_fires_rather_than_strands() {
        let dir = tempdir().unwrap();
        let (cb, fired) = collector();
        let (schedule, _task) = SamuraiSchedule::new(dir.path().to_path_buf(), cb);
        schedule
            .arm(entry("C:/git/alpha", "#37", "not-a-timestamp"))
            .unwrap();

        schedule.fire_due();

        assert_eq!(fired.lock().unwrap().len(), 1);
        assert!(schedule.list().is_empty());
    }

    #[test]
    fn test_corrupt_schedule_file_loads_empty_and_recovers() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("schedule.json");
        std::fs::write(&path, "{ definitely not a schedule").unwrap();

        let (cb, _) = collector();
        let (schedule, _task) = SamuraiSchedule::new(dir.path().to_path_buf(), cb);
        assert!(schedule.list().is_empty());

        // The store must still be usable — the next arm overwrites the
        // corrupt file with a valid one.
        schedule
            .arm(entry("C:/git/alpha", "#37", &in_one_hour()))
            .unwrap();
        assert_eq!(load_entries(&path).len(), 1);
    }

    #[test]
    fn test_jitter_deterministic_and_in_range() {
        // Deterministic: same epic, same jitter — every time.
        assert_eq!(jitter_secs("#37"), jitter_secs("#37"));
        // Slug-based: refs that slug identically (and thus share a worktree
        // and handoff files) share their jitter too.
        assert_eq!(jitter_secs("#37"), jitter_secs("37"));
        // In range for a spread of shapes, including the empty-ref fallback.
        for epic in [
            "#1",
            "#37",
            "#38",
            "https://github.com/nachogl1/maestro/issues/59",
            "epic/some-long-name",
            "",
        ] {
            assert!(
                jitter_secs(epic) <= MAX_JITTER_SECS,
                "jitter for {epic:?} out of range"
            );
        }
        // Anti-thundering-herd: neighboring epics land on different offsets.
        assert_ne!(jitter_secs("#37"), jitter_secs("#38"));
    }
}
