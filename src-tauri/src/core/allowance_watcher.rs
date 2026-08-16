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
//! decision #7). The one exception the LOOP adds on top: while a hard
//! threshold stays latched and the sweep it caused already completed, a
//! crossing REBUILT FROM THE CURRENT READING
//! ([`AllowanceWatcher::latched_hard_event`]) is re-handed to the parker as
//! soon as a session is working again — sessions that register after the
//! crossing (cold-start reconciliation, resumes) must not run unparked for
//! the rest of an exhausted window. Rebuilt, not remembered: the parker arms
//! resume timers from `resets_at`, and the original event's copy goes stale
//! as soon as its window resets while another latch holds the sweep open.
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
use super::supervisor::{Supervisor, SupervisorState};

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
    /// The 5h usage fell back below the SOFT threshold (issue #120): the
    /// wind-down episode is over. A governing-window reset also surfaces as
    /// this falling edge (the next poll reads the reset window's low usage),
    /// so "window reset OR usage recovered, whichever first" is this ONE
    /// edge. The parker answers with the wind-down all-clear.
    #[serde(rename = "allowance_recovered")]
    SoftRecovered {
        window: AllowanceWindow,
        /// The window's usage percentage at the tick that fell below.
        value: f64,
        /// The configured soft threshold it fell below.
        threshold: f64,
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

        // The park thresholds below are read from the GLOBAL config only —
        // deliberately: allowance windows are account-wide, so a per-run
        // `thresholds` override (run config, review F4) never applies here.
        // Only the handoff trigger consults per-run overrides
        // (`samurai_injector::handoff_threshold_for`).
        if let Some(pct) = reading.session_percent {
            let was_above_soft = self.above_soft_5h;
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
            // Issue #120: the soft latch's FALLING edge is the recovery —
            // the same re-arm that always existed, now announced so the
            // parker can all-clear wound-down sessions.
            if was_above_soft && !self.above_soft_5h {
                events.push(AllowanceEvent::SoftRecovered {
                    window: AllowanceWindow::FiveHour,
                    value: pct,
                    threshold: config.park_soft_5h_pct,
                });
            }
        } else if self.above_soft_5h {
            // Fix T4 (issue #131 review 2): the decided policy is "all-clear
            // on whichever comes first: window RESET or usage below soft",
            // but the falling edge above only ever fired on a decay — a
            // reset that makes the API stop reporting the 5h window left
            // `above_soft_5h` latched forever, so every wound-down session
            // stayed wound down with no edge left to lift it (the same
            // shape as bug #120). A window that stopped being reported while
            // another governing window still is IS the reset: re-arm the
            // soft latch and announce the recovery, reporting 0% because
            // there is no usage left in the window to report.
            //
            // Only the SOFT latch — a hard latch keeps the parking guard
            // engaged, and re-arming it here would let a hard crossing
            // re-fire a park sweep on a data gap.
            log::info!(
                "samurai allowance: the 5h window stopped being reported while above soft — treating it as the window reset and all-clearing"
            );
            self.above_soft_5h = false;
            events.push(AllowanceEvent::SoftRecovered {
                window: AllowanceWindow::FiveHour,
                value: 0.0,
                threshold: config.park_soft_5h_pct,
            });
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

    /// Whether a hard threshold is STILL above its line — the latched state
    /// behind the edge, which no event reports after the crossing tick.
    #[cfg(test)]
    fn hard_latched(&self) -> bool {
        self.above_hard_5h || self.above_hard_7d
    }

    /// The hard crossing still in force, rebuilt from THIS tick's reading.
    ///
    /// Deliberately not a remembered snapshot of the original crossing event:
    /// the parker arms resume timers from the event's `resets_at`, and a
    /// remembered 5h `resets_at` goes stale the moment that window resets
    /// while the 7d latch keeps the sweep engaged — re-handing it then arms a
    /// timer in the PAST, which fires immediately and thrashes the epic
    /// between park and resume for the rest of the weekly window.
    ///
    /// When both hard windows are latched the LATER reset wins, matching what
    /// the parker does when both cross in one sweep. A latched window with no
    /// percent this tick is skipped: no current data, so nothing to re-hand.
    pub fn latched_hard_event(
        &self,
        reading: &AllowanceReading,
        config: &SamuraiConfig,
    ) -> Option<AllowanceEvent> {
        let mut candidates: Vec<AllowanceEvent> = Vec::new();
        if self.above_hard_5h {
            if let Some(value) = reading.session_percent {
                candidates.push(AllowanceEvent::ThresholdCrossed {
                    window: AllowanceWindow::FiveHour,
                    threshold_kind: ThresholdKind::Hard,
                    value,
                    threshold: config.park_hard_5h_pct,
                    resets_at: reading.session_resets_at.clone(),
                });
            }
        }
        if self.above_hard_7d {
            if let Some(value) = reading.weekly_percent {
                candidates.push(AllowanceEvent::ThresholdCrossed {
                    window: AllowanceWindow::SevenDay,
                    threshold_kind: ThresholdKind::Hard,
                    value,
                    threshold: config.park_hard_7d_pct,
                    resets_at: reading.weekly_resets_at.clone(),
                });
            }
        }
        // Later known reset wins; a known reset beats an unknown one.
        candidates.into_iter().max_by_key(|e| match e {
            AllowanceEvent::ThresholdCrossed { resets_at, .. } => resets_at
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&chrono::Utc)),
            AllowanceEvent::SoftRecovered { .. } | AllowanceEvent::NoGoverningWindow => None,
        })
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
                if !parker.parking_engaged() {
                    // Still above a hard line with the sweep already
                    // finished: anything WORKING now registered AFTER the
                    // crossing and would otherwise never be parked. Re-hand a
                    // crossing rebuilt from THIS tick's reading — never the
                    // original event, whose `resets_at` may belong to a window
                    // that has since reset (that arms a resume timer in the
                    // past). `engage_hard` is idempotent, the crossing was
                    // already audited (no new ALERT rows), and the completed
                    // sweep took its `parked_epics` with it, so no timer can
                    // be armed twice.
                    if let Some(event) = watcher.latched_hard_event(&reading, &snapshot) {
                        if supervisor
                            .list_sessions()
                            .iter()
                            .any(|s| s.state == SupervisorState::Working)
                        {
                            log::info!(
                                "samurai allowance: still above the hard threshold and a session is working — re-engaging the park sweep"
                            );
                            parker.on_allowance_event(&event);
                        }
                    }
                }
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
                AllowanceEvent::SoftRecovered { .. } | AllowanceEvent::NoGoverningWindow => None,
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
        // Fall back below (5h window reset): the threshold re-arms and the
        // recovery event fires (#120) — no new ThresholdCrossed.
        let events = w.evaluate(&reading(Some(10.0), None), &cfg());
        assert!(kinds(&events).is_empty());
        assert_eq!(events.len(), 1, "the falling edge is the recovery event");
        // Re-cross: fires again.
        let events = w.evaluate(&reading(Some(79.0), None), &cfg());
        assert_eq!(
            kinds(&events),
            vec![(AllowanceWindow::FiveHour, ThresholdKind::Soft)]
        );
    }

    #[test]
    fn soft_recovery_fires_once_per_winddown_episode() {
        // Issue #120: one falling edge per episode — a governing-window
        // reset and a usage decay below the soft threshold both surface as
        // the same falling reading, so "whichever first" is this one edge.
        let mut w = AllowanceWatcher::default();
        // Below from the start: falling readings never fire a recovery.
        assert!(w.evaluate(&reading(Some(50.0), None), &cfg()).is_empty());
        assert!(w.evaluate(&reading(Some(10.0), None), &cfg()).is_empty());
        // Episode 1: cross soft, then recover.
        assert_eq!(w.evaluate(&reading(Some(80.0), None), &cfg()).len(), 1);
        let events = w.evaluate(&reading(Some(10.0), None), &cfg());
        assert_eq!(
            events,
            vec![AllowanceEvent::SoftRecovered {
                window: AllowanceWindow::FiveHour,
                value: 10.0,
                threshold: 78.0,
            }]
        );
        // Staying below: no repeat — edge, not level.
        assert!(w.evaluate(&reading(Some(9.0), None), &cfg()).is_empty());
        // Episode 2: both edges fire afresh.
        assert_eq!(w.evaluate(&reading(Some(80.0), None), &cfg()).len(), 1);
        assert_eq!(w.evaluate(&reading(Some(5.0), None), &cfg()).len(), 1);
    }

    /// Fix T4 (issue #131 review 2): policy (a) is "all-clear on whichever
    /// comes FIRST — the window reset or usage below soft". Only the decay
    /// half was exercised: a reset that makes the API stop reporting the 5h
    /// window used to leave `above_soft_5h` latched, so wound-down sessions
    /// were never all-cleared and no further edge could lift them.
    #[test]
    fn soft_recovery_fires_when_the_5h_window_stops_being_reported() {
        let mut w = AllowanceWatcher::default();
        assert_eq!(w.evaluate(&reading(Some(80.0), Some(50.0)), &cfg()).len(), 1);

        // The 5h window resets and the API stops reporting it; the weekly
        // window is still there, so this is NOT the no-governing-window case.
        let events = w.evaluate(&reading(None, Some(50.0)), &cfg());
        assert_eq!(
            events,
            vec![AllowanceEvent::SoftRecovered {
                window: AllowanceWindow::FiveHour,
                value: 0.0,
                threshold: 78.0,
            }]
        );
        // Edge, not level: staying unreported says nothing more.
        assert!(w.evaluate(&reading(None, Some(50.0)), &cfg()).is_empty());
        // And the latch really re-armed — the next crossing fires afresh.
        assert_eq!(
            kinds(&w.evaluate(&reading(Some(80.0), Some(50.0)), &cfg())),
            vec![(AllowanceWindow::FiveHour, ThresholdKind::Soft)]
        );
    }

    #[test]
    fn an_unreported_5h_window_below_soft_stays_silent() {
        // No wind-down episode is open, so a disappearing window announces
        // nothing — the all-clear is an edge off a real crossing.
        let mut w = AllowanceWatcher::default();
        assert!(w.evaluate(&reading(Some(50.0), Some(50.0)), &cfg()).is_empty());
        assert!(w.evaluate(&reading(None, Some(50.0)), &cfg()).is_empty());
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
        // Restoring the threshold re-arms (value now below it) — announced
        // as the #120 recovery event, never a crossing …
        let events = w.evaluate(&reading(Some(40.0), None), &cfg());
        assert!(kinds(&events).is_empty());
        assert_eq!(events.len(), 1, "the soft re-arm is the recovery event");
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
    fn hard_latched_reports_the_state_the_edge_hides() {
        // The loop re-hands a rebuilt hard crossing while this is true (a
        // session registering after the crossing would never be parked
        // otherwise) and stops once the window resets.
        let mut w = AllowanceWatcher::default();
        assert!(!w.hard_latched(), "nothing crossed yet");
        // Soft alone never counts as "hard still above the line".
        assert_eq!(w.evaluate(&reading(Some(80.0), None), &cfg()).len(), 1);
        assert!(!w.hard_latched());
        // 5h hard crosses → latched, and it STAYS latched on silent ticks.
        assert_eq!(w.evaluate(&reading(Some(91.0), None), &cfg()).len(), 1);
        assert!(w.hard_latched());
        assert!(w.evaluate(&reading(Some(92.0), None), &cfg()).is_empty());
        assert!(w.hard_latched());
        // 5h window resets below every threshold → re-armed, not latched
        // (the falling soft edge is the #120 recovery event, no crossings).
        let events = w.evaluate(&reading(Some(3.0), None), &cfg());
        assert!(kinds(&events).is_empty());
        assert!(!w.hard_latched());
        // The 7d window latches it just as well.
        assert_eq!(w.evaluate(&reading(Some(3.0), Some(96.0)), &cfg()).len(), 1);
        assert!(w.hard_latched());
    }

    #[test]
    fn latched_hard_event_is_rebuilt_from_the_current_reading() {
        // The re-hand must never carry a `resets_at` from a window that has
        // since reset: the parker arms resume timers from it, and a spent 5h
        // reset time is in the PAST — the timer fires instantly and the epic
        // thrashes between park and resume for the rest of the weekly window.
        let mut w = AllowanceWatcher::default();
        let with_resets = |session: Option<f64>, weekly: Option<f64>| AllowanceReading {
            session_percent: session,
            session_resets_at: Some("2026-08-06T20:00:00Z".to_string()),
            weekly_percent: weekly,
            weekly_resets_at: Some("2026-08-10T09:00:00Z".to_string()),
        };

        // Nothing crossed: nothing to re-hand.
        assert_eq!(w.latched_hard_event(&with_resets(Some(10.0), None), &cfg()), None);

        // Both hard windows cross (5h also passes its soft line on the way).
        // The LATER reset (7d) wins — resuming at the 5h reset would land
        // straight back in an exhausted weekly.
        assert_eq!(w.evaluate(&with_resets(Some(91.0), Some(96.0)), &cfg()).len(), 3);
        let event = w
            .latched_hard_event(&with_resets(Some(91.0), Some(96.0)), &cfg())
            .expect("both latched");
        assert!(matches!(
            &event,
            AllowanceEvent::ThresholdCrossed { window: AllowanceWindow::SevenDay, resets_at, .. }
                if resets_at.as_deref() == Some("2026-08-10T09:00:00Z")
        ));

        // The 5h window resets while the 7d latch still holds the sweep open.
        // The re-hand must now be the 7d event with the WEEKLY reset time —
        // the bug was re-handing the remembered 5h event, whose `resets_at`
        // is now in the past. (The falling soft edge announces the #120
        // recovery; no new crossing.)
        assert!(kinds(&w.evaluate(&with_resets(Some(2.0), Some(96.0)), &cfg())).is_empty());
        let event = w
            .latched_hard_event(&with_resets(Some(2.0), Some(96.0)), &cfg())
            .expect("7d still latched");
        assert!(matches!(
            &event,
            AllowanceEvent::ThresholdCrossed { window: AllowanceWindow::SevenDay, resets_at, .. }
                if resets_at.as_deref() == Some("2026-08-10T09:00:00Z")
        ));

        // A latched window with no percent this tick is skipped — no current
        // data, so nothing is re-handed until the next reading.
        assert_eq!(
            w.latched_hard_event(
                &AllowanceReading {
                    session_percent: None,
                    session_resets_at: None,
                    weekly_percent: None,
                    weekly_resets_at: None,
                },
                &cfg()
            ),
            None
        );

        // Weekly resets too: nothing latched, nothing to re-hand.
        assert!(w.evaluate(&with_resets(Some(2.0), Some(4.0)), &cfg()).is_empty());
        assert_eq!(w.latched_hard_event(&with_resets(Some(2.0), Some(4.0)), &cfg()), None);
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
