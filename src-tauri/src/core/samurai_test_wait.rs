//! The audit-log waits of the samurai integration test harnesses. The
//! generic tick-and-wait helpers they build on live in
//! [`crate::core::test_wait`], which explains the whole class.

use std::sync::Arc;

use crate::core::samurai_audit::{AppendCallback, AuditEvent, AuditLog};
use crate::core::test_wait::{HarnessTick, HANG_BACKSTOP, SETTLE};

/// The audit writer hook that ticks `tick` on every append. Pass the result
/// to [`AuditLog::new`] as its `on_append` callback.
pub fn tick_on_append(tick: &HarnessTick) -> AppendCallback {
    let tick = tick.clone();
    // `notify_one` (not `notify_waiters`) so an event that lands while nobody
    // is waiting still stores its permit — a waiter that arrives afterwards
    // re-checks immediately instead of sleeping through it.
    Arc::new(move |_: &str, _: &AuditEvent| tick.notify_one())
}

/// Reads the audit log until `cond` holds over the rows read, returning them.
/// Same contract as [`wait_until`](crate::core::test_wait::wait_until): the audit writer's `on_append` hook ticks
/// the harness, so the re-read happens on the append, not on a timer.
///
/// Use this when the wait is about a *set* of rows ("four retries and one
/// give-up"); [`wait_for_row`] is the single-row shorthand.
pub async fn wait_for_rows(
    tick: &HarnessTick,
    audit: &AuditLog,
    project: &str,
    mut cond: impl FnMut(&[AuditEvent]) -> bool,
) -> Vec<AuditEvent> {
    let deadline = std::time::Instant::now() + HANG_BACKSTOP;
    loop {
        let rows = audit.read(project, None, None).await.unwrap().events;
        if cond(&rows) {
            return rows;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "expected audit rows never landed; have: {rows:?}",
        );
        let _ = tokio::time::timeout(SETTLE, tick.notified()).await;
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
    wait_for_rows(tick, audit, project, |rows| rows.iter().any(&mut pred)).await
}
