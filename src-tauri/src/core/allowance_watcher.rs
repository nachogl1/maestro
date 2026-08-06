//! Backend-side allowance threshold detection (issue #45; PRD §5.5).
//!
//! Polls the same usage source the frontend uses (`commands::usage`,
//! Anthropic's OAuth usage API) on its own ~60s timer — deliberately NOT
//! dependent on the frontend store being mounted — and compares the 5h/7d
//! window percentages against the configured soft/hard park thresholds.
//!
//! **Edge-triggered:** one event per crossing (rising edge), not one per
//! tick. A threshold re-arms when the value falls back below it, so the next
//! crossing fires again. Threshold changes take effect on the next tick
//! (lowering a threshold below current usage IS the live test — PRD
//! decision #7).
//!
//! **No governing window** (enterprise-style accounts return the 5h/7d
//! windows as null): a distinct event fires once — Phase 3's preflight will
//! block on it. Never silence.
//!
//! **Detection only.** This module appends ALERT audit rows, emits
//! `samurai-allowance-event`, and hands each event to the parker
//! (`samurai_parker`, issue #60) — the backend consumer that decides the
//! wind-down / sequential park. No decisions live here.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::samurai_audit::{AuditEvent, AuditEventKind, AuditLog};
use super::samurai_config::{SamuraiConfig, SharedSamuraiConfig};
use super::samurai_parker::SamuraiParker;
use super::supervisor::Supervisor;

/// Frontend channel for allowance events (same payload as the audit row's
/// `details`, plus it also arrives via `samurai-audit-event` when the row
/// lands). Issue #46 consumes this.
pub const ALLOWANCE_EVENT_CHANNEL: &str = "samurai-allowance-event";

/// Pseudo-project the account-wide ALERT rows fall back to when no session
/// is under supervision (allowance is account-wide; the audit log is
/// per-project). Readable via `samurai_audit_read` with this exact string.
pub const ACCOUNT_PROJECT: &str = "samurai-account";

/// Poll cadence — matches the frontend's 60s usage poll; the 30s response
/// cache in `commands::usage` dedupes the actual API calls between the two.
pub const POLL_INTERVAL_SECS: u64 = 60;

/// Which allowance window crossed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AllowanceWindow {
    #[serde(rename = "5h")]
    FiveHour,
    #[serde(rename = "7d")]
    SevenDay,
}

/// Soft = wind down (stop new subagents); hard = park (PRD §5.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThresholdKind {
    Soft,
    Hard,
}

/// One detected allowance condition. Serialized (tagged by `kind`, matching
/// the audit `details.kind` convention set by the supervisor's
/// `illegal_transition` rows) both into the ALERT row's `details` and as the
/// `samurai-allowance-event` payload.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum AllowanceEvent {
    /// A usage percentage rose to (or past) a configured threshold.
    #[serde(rename = "allowance_threshold")]
    ThresholdCrossed {
        window: AllowanceWindow,
        threshold_kind: ThresholdKind,
        /// The window's usage percentage at the tick that crossed.
        value: f64,
        /// The configured threshold it crossed.
        threshold: f64,
        /// When the window resets (ISO 8601), when the API reported it.
        resets_at: Option<String>,
    },
    /// Neither the 5h nor the 7d window is reported (enterprise-style
    /// account): there is no governing window to park on. Phase 3's
    /// preflight blocks on this.
    #[serde(rename = "no_governing_window")]
    NoGoverningWindow,
}

/// The slice of a usage poll this watcher evaluates. `None` means "window
/// not reported" — distinct from 0% (see `commands::usage::UsageData`).
#[derive(Debug, Clone, Default)]
pub struct AllowanceReading {
    pub session_percent: Option<f64>,
    pub session_resets_at: Option<String>,
    pub weekly_percent: Option<f64>,
    pub weekly_resets_at: Option<String>,
}

/// Edge-trigger state: one latch per threshold, plus one for the
/// no-governing-window condition. A latch set = "already fired, waiting to
/// fall back below before firing again".
#[derive(Debug, Default)]
pub struct AllowanceWatcher {
    above_soft_5h: bool,
    above_hard_5h: bool,
    above_hard_7d: bool,
    no_window_reported: bool,
}

impl AllowanceWatcher {
    /// Evaluates one reading against the current config, returning the
    /// events for exactly the edges crossed this tick (possibly several:
    /// a single jump from below-soft to above-hard fires both).
    ///
    /// Callers must NOT feed error/unknown polls (auth failure, API error)
    /// through here — skip the tick instead, so latches keep their state
    /// across data gaps.
    pub fn evaluate(
        &mut self,
        reading: &AllowanceReading,
        config: &SamuraiConfig,
    ) -> Vec<AllowanceEvent> {
        let mut events = Vec::new();

        // Neither governing window reported → the distinct event, once.
        // Threshold latches are left untouched: a null blip between two
        // above-threshold readings must not re-fire the threshold.
        if reading.session_percent.is_none() && reading.weekly_percent.is_none() {
            if !self.no_window_reported {
                self.no_window_reported = true;
                events.push(AllowanceEvent::NoGoverningWindow);
            }
            return events;
        }
        // A window came back → re-arm the no-window condition.
        self.no_window_reported = false;

        if let Some(pct) = reading.session_percent {
            edge(
                &mut self.above_soft_5h,
                pct,
                config.park_soft_5h_pct,
                AllowanceWindow::FiveHour,
                ThresholdKind::Soft,
                &reading.session_resets_at,
                &mut events,
            );
            edge(
                &mut self.above_hard_5h,
                pct,
                config.park_hard_5h_pct,
                AllowanceWindow::FiveHour,
                ThresholdKind::Hard,
                &reading.session_resets_at,
                &mut events,
            );
        }
        if let Some(pct) = reading.weekly_percent {
            edge(
                &mut self.above_hard_7d,
                pct,
                config.park_hard_7d_pct,
                AllowanceWindow::SevenDay,
                ThresholdKind::Hard,
                &reading.weekly_resets_at,
                &mut events,
            );
        }
        events
    }
}

/// One latch: fire on the rising edge (`value >= threshold`, PRD says
/// "5h ≥ 90%"), re-arm silently when the value falls back below.
fn edge(
    latch: &mut bool,
    value: f64,
    threshold: f64,
    window: AllowanceWindow,
    threshold_kind: ThresholdKind,
    resets_at: &Option<String>,
    out: &mut Vec<AllowanceEvent>,
) {
    if value >= threshold {
        if !*latch {
            *latch = true;
            out.push(AllowanceEvent::ThresholdCrossed {
                window,
                threshold_kind,
                value,
                threshold,
                resets_at: resets_at.clone(),
            });
        }
    } else {
        *latch = false;
    }
}

/// Spawns the evaluation loop (same shape as `github::watchdog`): every
/// ~60s fetch usage, evaluate, and on events append ALERT audit rows,
/// emit the frontend event, and hand the event to the parker (issue #60) —
/// backend-direct, never through a Tauri event listener.
///
/// ALERT rows land in the audit log of every project with a supervised
/// session (those are the runs a crossing is about); with none supervised
/// they land in the [`ACCOUNT_PROJECT`] pseudo-project instead — an
/// account-wide condition is never silent (issue #45 acceptance).
pub fn spawn_allowance_loop(
    app: AppHandle,
    config: SharedSamuraiConfig,
    supervisor: Arc<Supervisor>,
    audit: AuditLog,
    parker: Arc<SamuraiParker>,
) {
    tauri::async_runtime::spawn(async move {
        let mut watcher = AllowanceWatcher::default();
        let mut interval = tokio::time::interval(Duration::from_secs(POLL_INTERVAL_SECS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;

            // Same source as the frontend poll; the layering inversion
            // (core → commands) is accepted because the fetcher is a plain
            // stateless async fn and duplicating it would drift.
            let usage = match crate::commands::usage::get_claude_usage(None).await {
                Ok(u) => u,
                Err(e) => {
                    log::debug!("samurai allowance: usage fetch failed: {e}");
                    continue;
                }
            };
            // Unknown data (needs login, API error/rate limit) is a data
            // gap, not "no window": skip the tick, keep every latch.
            if usage.needs_auth || usage.error_message.is_some() {
                continue;
            }

            let reading = AllowanceReading {
                session_percent: usage.session_percent,
                session_resets_at: usage.session_resets_at,
                weekly_percent: usage.weekly_percent,
                weekly_resets_at: usage.weekly_resets_at,
            };
            let snapshot = {
                let cfg = config
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                cfg.clone()
            };
            let events = watcher.evaluate(&reading, &snapshot);
            if events.is_empty() {
                continue;
            }

            let mut projects: Vec<String> = supervisor
                .list_sessions()
                .into_iter()
                .map(|s| s.project)
                .collect();
            projects.sort();
            projects.dedup();
            if projects.is_empty() {
                projects.push(ACCOUNT_PROJECT.to_string());
            }

            for event in &events {
                let details = match serde_json::to_value(event) {
                    Ok(v) => v,
                    Err(e) => {
                        log::error!("samurai allowance: serialize failed: {e}");
                        json!({ "kind": "allowance_serialize_error" })
                    }
                };
                log::info!("samurai allowance event: {details}");
                for project in &projects {
                    // generation/session_id 0: account-wide, not tied to
                    // one orchestrator generation.
                    audit.append(
                        project,
                        AuditEvent::now("", AuditEventKind::Alert, 0, 0, details.clone()),
                    );
                }
                let _ = app.emit(ALLOWANCE_EVENT_CHANNEL, event);
                // Issue #60: the parker consumes the event after its ALERT
                // rows are durable, so the trail always shows the crossing
                // before the PARK rows it causes.
                parker.on_allowance_event(event);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> SamuraiConfig {
        SamuraiConfig::default() // soft 5h 78, hard 5h 90, hard 7d 95
    }

    fn reading(session: Option<f64>, weekly: Option<f64>) -> AllowanceReading {
        AllowanceReading {
            session_percent: session,
            session_resets_at: session.map(|_| "2026-08-06T20:00:00Z".to_string()),
            weekly_percent: weekly,
            weekly_resets_at: None,
        }
    }

    fn kinds(events: &[AllowanceEvent]) -> Vec<(AllowanceWindow, ThresholdKind)> {
        events
            .iter()
            .filter_map(|e| match e {
                AllowanceEvent::ThresholdCrossed {
                    window,
                    threshold_kind,
                    ..
                } => Some((*window, *threshold_kind)),
                AllowanceEvent::NoGoverningWindow => None,
            })
            .collect()
    }

    #[test]
    fn fires_once_on_rising_edge_then_stays_silent() {
        let mut w = AllowanceWatcher::default();
        // Below everything: nothing.
        assert!(w
            .evaluate(&reading(Some(50.0), Some(50.0)), &cfg())
            .is_empty());
        // Cross soft 5h: exactly one event, with the crossing's context.
        let events = w.evaluate(&reading(Some(80.0), Some(50.0)), &cfg());
        assert_eq!(
            kinds(&events),
            vec![(AllowanceWindow::FiveHour, ThresholdKind::Soft)]
        );
        match &events[0] {
            AllowanceEvent::ThresholdCrossed {
                value,
                threshold,
                resets_at,
                ..
            } => {
                assert_eq!(*value, 80.0);
                assert_eq!(*threshold, 78.0);
                assert_eq!(resets_at.as_deref(), Some("2026-08-06T20:00:00Z"));
            }
            other => panic!("unexpected event {other:?}"),
        }
        // Stays above on later ticks: no repeat — this is the whole point.
        assert!(w
            .evaluate(&reading(Some(81.0), Some(50.0)), &cfg())
            .is_empty());
        assert!(w
            .evaluate(&reading(Some(89.0), Some(50.0)), &cfg())
            .is_empty());
    }

    #[test]
    fn rearms_after_falling_below_and_fires_on_recross() {
        let mut w = AllowanceWatcher::default();
        assert_eq!(w.evaluate(&reading(Some(80.0), None), &cfg()).len(), 1);
        // Fall back below (5h window reset): silent re-arm.
        assert!(w.evaluate(&reading(Some(10.0), None), &cfg()).is_empty());
        // Re-cross: fires again.
        let events = w.evaluate(&reading(Some(79.0), None), &cfg());
        assert_eq!(
            kinds(&events),
            vec![(AllowanceWindow::FiveHour, ThresholdKind::Soft)]
        );
    }

    #[test]
    fn single_jump_past_soft_and_hard_fires_both_once() {
        let mut w = AllowanceWatcher::default();
        let events = w.evaluate(&reading(Some(92.0), Some(96.0)), &cfg());
        assert_eq!(
            kinds(&events),
            vec![
                (AllowanceWindow::FiveHour, ThresholdKind::Soft),
                (AllowanceWindow::FiveHour, ThresholdKind::Hard),
                (AllowanceWindow::SevenDay, ThresholdKind::Hard),
            ]
        );
        // And all three stay latched.
        assert!(w
            .evaluate(&reading(Some(93.0), Some(97.0)), &cfg())
            .is_empty());
    }

    #[test]
    fn crossing_fires_at_exactly_the_threshold() {
        // PRD phrases the rule as "5h ≥ 90%" — equality crosses.
        let mut w = AllowanceWatcher::default();
        let events = w.evaluate(&reading(Some(90.0), None), &cfg());
        assert_eq!(
            kinds(&events),
            vec![
                (AllowanceWindow::FiveHour, ThresholdKind::Soft),
                (AllowanceWindow::FiveHour, ThresholdKind::Hard),
            ]
        );
    }

    #[test]
    fn lowering_a_threshold_below_current_usage_fires_next_tick() {
        // PRD decision #7: this is the supported live-test path.
        let mut w = AllowanceWatcher::default();
        assert!(w.evaluate(&reading(Some(40.0), None), &cfg()).is_empty());
        let mut test_cfg = cfg();
        test_cfg.park_soft_5h_pct = 2.0;
        test_cfg.park_hard_5h_pct = 5.0;
        let events = w.evaluate(&reading(Some(40.0), None), &test_cfg);
        assert_eq!(
            kinds(&events),
            vec![
                (AllowanceWindow::FiveHour, ThresholdKind::Soft),
                (AllowanceWindow::FiveHour, ThresholdKind::Hard),
            ]
        );
        // Restoring the threshold re-arms (value now below it) …
        assert!(w.evaluate(&reading(Some(40.0), None), &cfg()).is_empty());
        // … so lowering it again fires again: repeatable live testing.
        let events = w.evaluate(&reading(Some(40.0), None), &test_cfg);
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn no_governing_window_fires_once_and_rearms_when_windows_return() {
        let mut w = AllowanceWatcher::default();
        let events = w.evaluate(&reading(None, None), &cfg());
        assert_eq!(events, vec![AllowanceEvent::NoGoverningWindow]);
        // Still null: silent (once per condition, not per tick).
        assert!(w.evaluate(&reading(None, None), &cfg()).is_empty());
        // Windows come back below thresholds: nothing, but re-armed …
        assert!(w
            .evaluate(&reading(Some(10.0), Some(10.0)), &cfg())
            .is_empty());
        // … so a later null period announces itself again.
        let events = w.evaluate(&reading(None, None), &cfg());
        assert_eq!(events, vec![AllowanceEvent::NoGoverningWindow]);
    }

    #[test]
    fn null_blip_does_not_refire_a_latched_threshold() {
        let mut w = AllowanceWatcher::default();
        assert_eq!(w.evaluate(&reading(Some(95.0), None), &cfg()).len(), 2);
        // Both windows drop out for a tick (API hiccup) → only the distinct
        // no-window event; the 5h latches must survive untouched.
        let events = w.evaluate(&reading(None, None), &cfg());
        assert_eq!(events, vec![AllowanceEvent::NoGoverningWindow]);
        // Value returns, still above: no duplicate threshold event.
        assert!(w.evaluate(&reading(Some(95.0), None), &cfg()).is_empty());
    }

    #[test]
    fn a_single_reported_window_is_evaluated_alone() {
        // Only the 7d window reported: 5h latches untouched, 7d evaluated,
        // and no "no governing window" (one window IS governing).
        let mut w = AllowanceWatcher::default();
        let events = w.evaluate(&reading(None, Some(96.0)), &cfg());
        assert_eq!(
            kinds(&events),
            vec![(AllowanceWindow::SevenDay, ThresholdKind::Hard)]
        );
        assert!(!events.contains(&AllowanceEvent::NoGoverningWindow));
    }

    #[test]
    fn event_serializes_to_the_agreed_audit_details_shape() {
        // Issue #46 consumes these exact keys from `details` and from the
        // `samurai-allowance-event` payload.
        let event = AllowanceEvent::ThresholdCrossed {
            window: AllowanceWindow::FiveHour,
            threshold_kind: ThresholdKind::Hard,
            value: 91.5,
            threshold: 90.0,
            resets_at: Some("2026-08-06T20:00:00Z".to_string()),
        };
        let v = serde_json::to_value(&event).unwrap();
        assert_eq!(v["kind"], "allowance_threshold");
        assert_eq!(v["window"], "5h");
        assert_eq!(v["threshold_kind"], "hard");
        assert_eq!(v["value"], 91.5);
        assert_eq!(v["threshold"], 90.0);
        assert_eq!(v["resets_at"], "2026-08-06T20:00:00Z");

        let v = serde_json::to_value(&AllowanceEvent::NoGoverningWindow).unwrap();
        assert_eq!(v["kind"], "no_governing_window");
    }
}
