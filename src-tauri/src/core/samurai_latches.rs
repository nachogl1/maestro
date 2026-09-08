//! Restart-durable latch state for the account-wide samurai watchers
//! (`allowance_watcher`, `samurai_auth_watch`).
//!
//! Both of those loops are **edge-triggered**: they fire once when a
//! condition starts (usage crossed a park threshold, `gh auth status` went
//! from good to lost) and stay silent while it holds. The latch that makes
//! them edge-triggered used to live in a local variable inside the spawned
//! task, so it was reset to "nothing has fired" on every app start — and an
//! app restart while the condition was STILL true replayed the whole edge:
//! a duplicate ALERT row per supervised run, and, for the allowance loop, a
//! fresh `ThresholdCrossed{Hard}` handed to `SamuraiParker::engage_hard` —
//! a real park sweep over every supervised session, once per launch. The
//! 2026-08-19 audit log shows exactly that: soft+hard `allowance_threshold`
//! pairs re-emitted 2 minutes apart, including a `soft` row carrying
//! `value:90.0 threshold:78.0`, which only a cold latch can produce.
//!
//! This module is that latch state, written to
//! `<app data>/samurai/latches.json` — the same backend-owned state
//! directory as `schedule.json` (`samurai_schedule`), and the same atomic
//! temp+rename write.
//!
//! **Never fatal.** A missing file is "nothing latched" (the pre-existing
//! behaviour); a corrupt or unreadable one is warned and treated the same
//! way — the worst case is the one duplicate alert this module exists to
//! remove, never a panic and never a lost watcher.
//!
//! **One file, two writers.** The allowance loop owns the four allowance
//! latches and the auth loop owns `gh_auth_lost`; the store keeps the whole
//! record in memory behind a mutex and rewrites it as a unit, so neither
//! loop can clobber the other's field. Writes only happen when something
//! actually changed, so a steady state costs no IO.

use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};

/// Every persisted latch. `#[serde(default)]` per container so a file
/// written by an older build (or a hand-edit that drops a key) loads with
/// the un-latched default for whatever is missing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LatchState {
    /// `allowance_watcher`: 5h usage is above the soft (wind-down) line.
    pub above_soft_5h: bool,
    /// `allowance_watcher`: 5h usage is above the hard (park) line.
    pub above_hard_5h: bool,
    /// `allowance_watcher`: 7d usage is above the hard (park) line.
    pub above_hard_7d: bool,
    /// `allowance_watcher`: the "no governing window" condition has fired.
    pub no_window_reported: bool,
    /// `samurai_auth_watch`: a `gh` auth loss has already been parked+alerted.
    pub gh_auth_lost: bool,
}

/// The persisted latch record plus its in-memory mirror.
#[derive(Debug)]
pub struct LatchStore {
    path: PathBuf,
    /// Covers memory + file together: a mutation persists before releasing,
    /// so the file never lags a reader's view (the `SamuraiSchedule` rule).
    state: Mutex<LatchState>,
}

impl LatchStore {
    /// Loads `<base_dir>/latches.json`; missing, unreadable or corrupt all
    /// load as "nothing latched" (module doc).
    pub fn new(base_dir: PathBuf) -> Self {
        let path = base_dir.join("latches.json");
        let state = load(&path);
        Self {
            path,
            state: Mutex::new(state),
        }
    }

    /// The latch state the watchers seed themselves from at loop start.
    pub fn snapshot(&self) -> LatchState {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Replaces the four allowance latches, leaving `gh_auth_lost` alone.
    pub fn set_allowance(&self, allowance: LatchState) {
        self.update(|state| {
            state.above_soft_5h = allowance.above_soft_5h;
            state.above_hard_5h = allowance.above_hard_5h;
            state.above_hard_7d = allowance.above_hard_7d;
            state.no_window_reported = allowance.no_window_reported;
        });
    }

    /// Replaces the auth-loss latch, leaving the allowance latches alone.
    pub fn set_gh_auth_lost(&self, lost: bool) {
        self.update(|state| state.gh_auth_lost = lost);
    }

    /// Applies `mutate` and persists — but only when the record actually
    /// changed, so a steady state costs no IO on either loop's tick.
    fn update(&self, mutate: impl FnOnce(&mut LatchState)) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let before = *state;
        mutate(&mut state);
        if *state == before {
            return;
        }
        if let Err(e) = persist(&self.path, &state) {
            // Losing the write costs the duplicate alert this module
            // removes; it must never take a watcher loop down with it.
            log::warn!("samurai latches: {e}");
        }
    }
}

/// Reads the record, downgrading every failure to "nothing latched".
fn load(path: &PathBuf) -> LatchState {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return LatchState::default(),
        Err(e) => {
            log::warn!("samurai latches: cannot read {path:?}: {e} — starting un-latched");
            return LatchState::default();
        }
    };
    match serde_json::from_str::<LatchState>(&content) {
        Ok(state) => state,
        Err(e) => {
            log::warn!("samurai latches: unreadable {path:?}: {e} — starting un-latched");
            LatchState::default()
        }
    }
}

/// Atomic write (temp + rename, the `samurai_schedule::persist` rationale).
/// Unlike the schedule this file is NOT self-cleaning: an all-false record
/// is the meaningful "everything re-armed" state and must be readable as
/// itself, not as a missing file — the two happen to mean the same thing,
/// but leaving the file in place keeps the last write inspectable.
fn persist(path: &PathBuf, state: &LatchState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create latch dir {parent:?}: {e}"))?;
    }
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("failed to serialize latches: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("failed to write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("failed to move {tmp:?} into place at {path:?}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_latches_round_trip_across_a_restart() {
        let dir = tempdir().unwrap();
        let store = LatchStore::new(dir.path().to_path_buf());
        assert_eq!(store.snapshot(), LatchState::default(), "nothing latched");

        store.set_allowance(LatchState {
            above_soft_5h: true,
            above_hard_5h: true,
            ..LatchState::default()
        });
        store.set_gh_auth_lost(true);

        // "Restart": a fresh store over the same directory.
        let reopened = LatchStore::new(dir.path().to_path_buf());
        assert_eq!(
            reopened.snapshot(),
            LatchState {
                above_soft_5h: true,
                above_hard_5h: true,
                above_hard_7d: false,
                no_window_reported: false,
                gh_auth_lost: true,
            }
        );
    }

    #[test]
    fn test_the_two_writers_do_not_clobber_each_other() {
        // The allowance loop and the auth loop write the same file on their
        // own cadences; each must only ever touch its own fields.
        let dir = tempdir().unwrap();
        let store = LatchStore::new(dir.path().to_path_buf());
        store.set_gh_auth_lost(true);
        store.set_allowance(LatchState {
            above_hard_7d: true,
            ..LatchState::default()
        });
        assert!(store.snapshot().gh_auth_lost, "auth latch survived");

        store.set_gh_auth_lost(false);
        assert!(
            store.snapshot().above_hard_7d,
            "allowance latch survived the auth write"
        );
        assert_eq!(
            LatchStore::new(dir.path().to_path_buf()).snapshot(),
            LatchState {
                above_hard_7d: true,
                ..LatchState::default()
            }
        );
    }

    #[test]
    fn test_a_missing_or_corrupt_file_loads_un_latched() {
        let dir = tempdir().unwrap();
        // Missing.
        assert_eq!(
            LatchStore::new(dir.path().to_path_buf()).snapshot(),
            LatchState::default()
        );
        // Corrupt (truncated mid-write, or hand-edited into nonsense).
        std::fs::write(dir.path().join("latches.json"), "{ not json at all").unwrap();
        let store = LatchStore::new(dir.path().to_path_buf());
        assert_eq!(store.snapshot(), LatchState::default());
        // And it recovers: the next write replaces the garbage.
        store.set_gh_auth_lost(true);
        assert!(
            LatchStore::new(dir.path().to_path_buf())
                .snapshot()
                .gh_auth_lost
        );
    }

    #[test]
    fn test_a_partial_record_defaults_the_missing_latches() {
        // A file written by an older build has fewer keys; the missing ones
        // must read as un-latched instead of failing the whole load.
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("latches.json"),
            r#"{"above_hard_5h": true}"#,
        )
        .unwrap();
        assert_eq!(
            LatchStore::new(dir.path().to_path_buf()).snapshot(),
            LatchState {
                above_hard_5h: true,
                ..LatchState::default()
            }
        );
    }

    #[test]
    fn test_an_unwritable_path_never_panics() {
        // A directory where the file should be: every write fails, and the
        // in-memory latch still tracks so the running process stays correct.
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("latches.json")).unwrap();
        let store = LatchStore::new(dir.path().to_path_buf());
        store.set_gh_auth_lost(true);
        assert!(store.snapshot().gh_auth_lost, "memory still tracks");
    }
}
