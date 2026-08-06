//! Periodic `gh auth status` re-check during Samurai runs (issue #63; PRD
//! §5.8: "corporate SSO tokens expire — on failure: park + ALERT, not a
//! crash loop").
//!
//! A small dedicated loop (the `github::watchdog` 5-minute cadence, the
//! `allowance_watcher` spawn shape) rather than a bolt-on to an existing
//! samurai loop: the existing loops are keyed on supervised sessions or
//! usage polls, while this one is keyed on ACTIVE run configs — a parked
//! epic has no session yet must still surface an auth loss before its
//! resume timer burns a spawn on a dead `gh`.
//!
//! Per tick:
//!
//! - **No active run config** → skip entirely (no `gh` subprocess). The
//!   latch is left as-is; a stale latch is harmless — the next launch runs
//!   preflight, and a lost→good→lost cycle passes through a `logged_in ==
//!   true` tick that clears it.
//! - **Probe errored** (gh missing, timeout, spawn failure) → logged and
//!   skipped, NOT treated as auth loss (the PRD's "not a crash loop"; the
//!   same data-gap policy as the allowance loop's failed usage polls).
//! - **`logged_in == false`, not latched** → latch, then
//!   [`SamuraiParker::engage_external_park`]`("gh_auth_lost")` ONCE — the
//!   parker emits the ALERT and sweeps every supervised session without
//!   arming resume timers (auth has no reset time; the human fixes it and
//!   resumes manually).
//! - **`logged_in == true`** → clear the latch, so a future loss alerts
//!   again.
//!
//! Shape: the tick decision is a pure function ([`tick_action`], table-
//! tested); the loop is a thin IO shell with the probe injected (the
//! reconciler's closure pattern), so the module never touches `gh` in tests.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use super::samurai_parker::SamuraiParker;
use super::samurai_run_config::RunConfigStore;

/// Re-check cadence — the `github::watchdog::POLL_INTERVAL` precedent.
pub const POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// The audit `details.kind` (and park reason) for a detected auth loss.
pub const GH_AUTH_LOST: &str = "gh_auth_lost";

/// Probes `gh auth status` in some active run's directory:
/// `Ok(logged_in)`, or `Err` for a transient runner failure (gh missing,
/// timeout, spawn error). Injected so tests drive the loop's decision table
/// without a `gh` binary; lib.rs wires `github::GitHub::auth_status`.
pub type AuthProbe =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<bool, String>> + Send>> + Send + Sync>;

/// What one probe outcome means for the latch and the parker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TickAction {
    /// `logged_in == false` on the lost EDGE: latch and engage the park.
    EngagePark,
    /// `logged_in == true`: auth observed good — clear the latch.
    ClearLatch,
    /// Latched loss (already parked) or a transient probe error: nothing.
    Noop,
}

/// The decision table (module doc). Pure so the latch behavior is testable
/// without a loop: exactly one engage per lost edge, re-armed only by an
/// observed-good tick, never poked by transient errors.
pub(crate) fn tick_action(probe: Result<bool, &str>, latched: bool) -> TickAction {
    match probe {
        Ok(true) => TickAction::ClearLatch,
        Ok(false) if !latched => TickAction::EngagePark,
        Ok(false) => TickAction::Noop,
        Err(_) => TickAction::Noop,
    }
}

/// Spawns the re-check loop. Called once from app setup; runs for the app's
/// lifetime (idle ticks with no active runs cost one store scan, no
/// subprocess).
pub fn spawn_auth_watch(
    run_configs: Arc<RunConfigStore>,
    parker: Arc<SamuraiParker>,
    probe: AuthProbe,
) {
    tauri::async_runtime::spawn(async move {
        let mut latched = false;
        let mut interval = tokio::time::interval(POLL_INTERVAL);
        // After a laptop sleep, one catch-up tick, not a burst (the
        // samurai_schedule discipline).
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            // Keyed on ACTIVE run configs: no run, no `gh` subprocess.
            let Some(config) = run_configs.load_active().into_iter().next() else {
                continue;
            };
            let result = probe(config.project_path.clone()).await;
            match tick_action(result.as_ref().map(|&b| b).map_err(String::as_str), latched) {
                TickAction::EngagePark => {
                    log::error!(
                        "samurai auth watch: gh is no longer authenticated — engaging external park ({GH_AUTH_LOST})"
                    );
                    latched = true;
                    parker.engage_external_park(GH_AUTH_LOST);
                }
                TickAction::ClearLatch => {
                    if latched {
                        log::info!(
                            "samurai auth watch: gh auth observed good again — loss latch cleared"
                        );
                    }
                    latched = false;
                }
                TickAction::Noop => {
                    if let Err(e) = &result {
                        log::warn!(
                            "samurai auth watch: auth probe failed transiently ({e}) — skipped, not treated as auth loss"
                        );
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tick_action_table() {
        use TickAction::*;
        // (probe, latched, expected)
        let table: [(Result<bool, &str>, bool, TickAction); 6] = [
            // Auth good: clears the latch either way (idempotent).
            (Ok(true), false, ClearLatch),
            (Ok(true), true, ClearLatch),
            // Lost edge: engage exactly once…
            (Ok(false), false, EngagePark),
            // …then latched silence until auth is observed good again.
            (Ok(false), true, Noop),
            // Transient probe errors never engage AND never clear: a
            // timeout between two lost ticks must not re-arm the latch.
            (Err("timeout"), false, Noop),
            (Err("timeout"), true, Noop),
        ];
        for (probe, latched, expected) in table {
            assert_eq!(
                tick_action(probe, latched),
                expected,
                "probe={probe:?} latched={latched}"
            );
        }
    }

    #[test]
    fn test_latch_lifecycle_engages_once_per_loss_episode() {
        // Drives the latch exactly as the loop does: lost, lost, error,
        // good, lost — two loss EPISODES, two engages.
        let mut latched = false;
        let mut engages = 0;
        for probe in [Ok(false), Ok(false), Err("timeout"), Ok(true), Ok(false)] {
            match tick_action(probe, latched) {
                TickAction::EngagePark => {
                    latched = true;
                    engages += 1;
                }
                TickAction::ClearLatch => latched = false,
                TickAction::Noop => {}
            }
        }
        assert_eq!(engages, 2, "one engage per loss episode, no park-spam");
        assert!(latched, "still latched after the second loss");
    }
}
