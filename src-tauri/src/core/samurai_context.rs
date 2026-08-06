//! Samurai per-session context store (Phase 2, issue #52; PRD §5.4/§5.3).
//!
//! The 45% handoff trigger and the ACK scanner must read a session's live
//! context percentage **in the backend**. The transcript parser already
//! derives it ([`ClaudeEvent::ContextUsageUpdate`], recomputed on every
//! assistant message with usage data), but until now the event flowed
//! straight to the frontend batcher and nothing on the Rust side retained
//! it. This store closes that gap: `lib.rs` tees every event through
//! [`observe`](SamuraiContextStore::observe) before batching, and later
//! phases read [`percent`](SamuraiContextStore::percent) from their watcher
//! loops via `app.state::<Arc<SamuraiContextStore>>()`.
//!
//! Entries are removed at the same session-teardown sites that already call
//! `TranscriptWatcher::stop_watching` (`commands/session.rs`,
//! `commands/terminal.rs`) — a stale percentage for a dead session must
//! never arm a handoff.

use std::collections::HashMap;
use std::sync::Mutex;

use super::claude_event::ClaudeEvent;

/// Latest context-window usage snapshot for one session. Field semantics
/// mirror [`ClaudeEvent::ContextUsageUpdate`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContextUsage {
    /// input + cache_read + cache_creation tokens of the latest call.
    pub context_tokens: u64,
    /// The model's context window in tokens.
    pub context_window: u64,
    /// `context_tokens / context_window * 100`, rounded to one decimal.
    pub percent: f64,
}

/// Retains the latest [`ClaudeEvent::ContextUsageUpdate`] per Maestro
/// session id (u32).
///
/// Thread-safe: written from the event-bus tee, read from watcher loops.
/// The single `Mutex` is uncontended in practice — writes arrive at
/// assistant-message cadence and reads at watcher-tick cadence.
#[derive(Default)]
pub struct SamuraiContextStore {
    by_session: Mutex<HashMap<u32, ContextUsage>>,
}

impl SamuraiContextStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one event through the store. Only `ContextUsageUpdate` mutates
    /// state (latest event wins); every other variant is ignored, so the tee
    /// can pass the whole stream without filtering.
    pub fn observe(&self, event: &ClaudeEvent) {
        if let ClaudeEvent::ContextUsageUpdate {
            session_id,
            context_tokens,
            context_window,
            percent,
            ..
        } = event
        {
            self.lock().insert(
                *session_id,
                ContextUsage {
                    context_tokens: *context_tokens,
                    context_window: *context_window,
                    percent: *percent,
                },
            );
        }
    }

    /// Latest context percentage for a session, `None` if never seen.
    #[allow(dead_code)] // read API for the handoff trigger / ACK scanner (later P2 issues)
    pub fn percent(&self, session_id: u32) -> Option<f64> {
        self.usage(session_id).map(|u| u.percent)
    }

    /// Latest full snapshot (tokens + window + percent) for a session.
    #[allow(dead_code)] // read API for the handoff trigger / ACK scanner (later P2 issues)
    pub fn usage(&self, session_id: u32) -> Option<ContextUsage> {
        self.lock().get(&session_id).copied()
    }

    /// Drop one session's entry. Called from session teardown.
    pub fn remove(&self, session_id: u32) {
        self.lock().remove(&session_id);
    }

    /// Drop every entry. Called from the kill-all-sessions teardown, which
    /// may hold entries for sessions whose watcher already stopped.
    pub fn clear(&self) {
        self.lock().clear();
    }

    /// Recover from a poisoned lock rather than panicking — this runs on the
    /// event path, and a panicked writer elsewhere must not take it down
    /// (same policy as the emit closure in `lib.rs`).
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, ContextUsage>> {
        self.by_session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: a `ContextUsageUpdate` for `session_id` at `percent`.
    fn context_event(session_id: u32, percent: f64) -> ClaudeEvent {
        ClaudeEvent::ContextUsageUpdate {
            session_id,
            model: "claude-opus-4".to_string(),
            context_tokens: 90_000,
            context_window: 200_000,
            percent,
            timestamp: "2026-08-06T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn test_observe_retains_latest_usage() {
        let store = SamuraiContextStore::new();
        store.observe(&context_event(1, 45.0));

        assert_eq!(store.percent(1), Some(45.0));
        let usage = store.usage(1).expect("usage must be retained");
        assert_eq!(usage.context_tokens, 90_000);
        assert_eq!(usage.context_window, 200_000);
    }

    #[test]
    fn test_latest_event_wins() {
        let store = SamuraiContextStore::new();
        store.observe(&context_event(1, 10.0));
        store.observe(&context_event(1, 55.5));
        assert_eq!(store.percent(1), Some(55.5));
    }

    #[test]
    fn test_unknown_session_is_none() {
        let store = SamuraiContextStore::new();
        store.observe(&context_event(1, 45.0));
        assert_eq!(store.percent(99), None);
        assert!(store.usage(99).is_none());
    }

    #[test]
    fn test_non_context_events_are_ignored() {
        let store = SamuraiContextStore::new();
        store.observe(&ClaudeEvent::UserMessage {
            session_id: 1,
            uuid: "uuid-1".to_string(),
            text: "hello".to_string(),
            timestamp: "t".to_string(),
        });
        assert_eq!(store.percent(1), None);
    }

    #[test]
    fn test_remove_cleans_up_only_that_session() {
        let store = SamuraiContextStore::new();
        store.observe(&context_event(1, 45.0));
        store.observe(&context_event(2, 20.0));

        store.remove(1);
        assert_eq!(store.percent(1), None);
        assert_eq!(store.percent(2), Some(20.0));
    }

    #[test]
    fn test_clear_removes_everything() {
        let store = SamuraiContextStore::new();
        store.observe(&context_event(1, 45.0));
        store.observe(&context_event(2, 20.0));

        store.clear();
        assert_eq!(store.percent(1), None);
        assert_eq!(store.percent(2), None);
    }
}
