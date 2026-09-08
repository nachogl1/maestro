//! Event-driven waits shared by the samurai integration test harnesses.
//!
//! Every one of those harnesses drives work that does **not** run on the
//! test's own runtime: park validation, brief staging and the replicator's
//! ritual decision go to `tauri::async_runtime` behind `spawn_blocking` and
//! real `git` subprocesses, on a runtime shared with the whole test binary.
//!
//! The waits used to be a fixed budget of 200 × 10 ms sleeps spent on the
//! test's own, otherwise idle, current-thread runtime (issues #197, #198).
//! That measured the wrong clock: under load the test's sleeps keep ticking
//! at ~10 ms while the global runtime and the process launches queued behind
//! it slow down several-fold, so the budget expires on a run that is merely
//! slow. (Its real wall budget on Windows was ~3.4 s, not the 2 s the panic
//! claimed — 200 nominal-10 ms sleeps land on the ~15.6 ms system timer.)
//!
//! Here the waits block on a [`HarnessTick`] instead, signalled by whatever
//! the harness can observe — the audit writer's `on_append` hook, a spawn
//! emitter, a delivery writer — so a healthy run returns the instant its
//! producer acts, however loaded the machine is. The wall-clock bound that
//! remains is a **hang detector, not a race budget**: it never participates
//! in a passing run.

use std::sync::Arc;
use std::time::Duration;

use crate::core::samurai_audit::{AppendCallback, AuditEvent, AuditLog};

/// Woken the moment a harness observes anything a test can wait on.
pub type HarnessTick = Arc<tokio::sync::Notify>;

/// A fresh tick for one harness.
pub fn new_tick() -> HarnessTick {
    Arc::new(tokio::sync::Notify::new())
}

/// The audit writer hook that ticks `tick` on every append. Pass the result
/// to [`AuditLog::new`] as its `on_append` callback.
pub fn tick_on_append(tick: &HarnessTick) -> AppendCallback {
    let tick = tick.clone();
    // `notify_one` (not `notify_waiters`) so an event that lands while nobody
    // is waiting still stores its permit — a waiter that arrives afterwards
    // re-checks immediately instead of sleeping through it.
    Arc::new(move |_: &str, _: &AuditEvent| tick.notify_one())
}

/// Longest a wait may sit with its condition still false before the test
/// calls it a hang. **Not a race budget** — see the module doc.
pub const HANG_BACKSTOP: Duration = Duration::from_secs(60);

/// Longest a waiter sleeps between re-checks when no tick arrives. Covers the
/// one edge an event cannot: a condition that flips without a further
/// harness event (the parker disengaging after its last row).
pub const SETTLE: Duration = Duration::from_millis(50);

/// Waits until `cond` holds, woken by the harness tick.
pub async fn wait_until(tick: &HarnessTick, mut cond: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + HANG_BACKSTOP;
    loop {
        if cond() {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "condition still false {HANG_BACKSTOP:?} after the last harness event",
        );
        let _ = tokio::time::timeout(SETTLE, tick.notified()).await;
    }
}

/// Awaits `fut` under the [`HANG_BACKSTOP`] hang detector, for the case where
/// the test can await the work directly rather than observe it through a
/// harness hook.
///
/// Awaiting a future *is* the maximally event-driven wait — the future's own
/// completion is the wake, so a healthy run returns the instant it resolves,
/// however loaded the machine is. The bound exists only because `cargo test`
/// has no per-test timeout: without it, a regression that awaits something
/// which never resolves would wedge the whole test binary instead of naming
/// itself. It is **not** a race budget and never participates in a passing
/// run — see the module doc. `what` names the awaited work in the panic.
pub async fn await_or_hang<T>(what: &str, fut: impl std::future::Future<Output = T>) -> T {
    match tokio::time::timeout(HANG_BACKSTOP, fut).await {
        Ok(value) => value,
        Err(_) => panic!("{what} never completed within {HANG_BACKSTOP:?} — it hung"),
    }
}

/// Reads the audit log until a row matches, returning all rows. Same contract
/// as [`wait_until`]: the audit writer's `on_append` hook ticks the harness,
/// so the re-read happens on the append, not on a timer.
pub async fn wait_for_row(
    tick: &HarnessTick,
    audit: &AuditLog,
    project: &str,
    mut pred: impl FnMut(&AuditEvent) -> bool,
) -> Vec<AuditEvent> {
    let deadline = std::time::Instant::now() + HANG_BACKSTOP;
    loop {
        let rows = audit.read(project, None, None).await.unwrap().events;
        if rows.iter().any(&mut pred) {
            return rows;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "expected audit row never landed; have: {rows:?}",
        );
        let _ = tokio::time::timeout(SETTLE, tick.notified()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The contract every caller depends on. The helper these replaced gave
    /// up after 200 × 10 ms sleeps, so a producer needing more wall time than
    /// that failed the test with nothing actually wrong — exactly what a
    /// cold, loaded box does to the `git` subprocesses this work runs. A
    /// producer that takes 4 s (past the old loop's real ~3.4 s Windows
    /// budget, and deliberately silent so the settle re-check is what
    /// notices) must now simply cost time.
    #[tokio::test]
    async fn test_wait_until_outlives_a_producer_slower_than_the_old_fixed_budget() {
        let tick = new_tick();
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let setter = done.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(4000));
            setter.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        wait_until(&tick, || done.load(std::sync::atomic::Ordering::SeqCst)).await;
    }

    /// `await_or_hang` hands back the future's value the moment it resolves —
    /// the backstop is a hang detector, so it must cost a passing run nothing.
    #[tokio::test]
    async fn test_await_or_hang_returns_the_moment_the_future_resolves() {
        let started = std::time::Instant::now();
        let value = await_or_hang("a future that resolves at once", async { 7 }).await;
        assert_eq!(value, 7);
        assert!(
            started.elapsed() < SETTLE,
            "a resolved future must not pay any of the backstop"
        );
    }

    /// A tick that lands before anyone waits is not lost: `notify_one` stores
    /// the permit, so the waiter re-checks immediately instead of paying the
    /// settle interval.
    #[tokio::test]
    async fn test_a_tick_that_lands_before_the_wait_is_not_lost() {
        let tick = new_tick();
        tick.notify_one();
        let started = std::time::Instant::now();
        wait_until(&tick, || true).await;
        assert!(started.elapsed() < SETTLE, "wait must not sleep at all");
    }
}
