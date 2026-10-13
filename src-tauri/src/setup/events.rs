//! Event pipeline: the batched `claude-events` EventBus and the Samurai
//! event tees that observe every deduped event before it is batched.

use std::sync::{Arc, Mutex, OnceLock};

use tauri::Emitter;

use crate::commands;
use crate::core;
use crate::core::samurai_context::SamuraiContextStore;
use crate::core::samurai_injector::SamuraiInjector;
use crate::core::{ClaudeEvent, EventBus};

/// Samurai consumers fed by the event tees. The context store is live from
/// the start; the other three are late-bound slots filled once their
/// controllers are constructed in [`super::samurai`].
pub(super) struct SamuraiTees {
    pub samurai_context: Arc<SamuraiContextStore>,
    pub samurai_injector: Arc<OnceLock<Arc<SamuraiInjector>>>,
    pub samurai_completion: Arc<OnceLock<Arc<core::samurai_completion::SamuraiCompletionWatcher>>>,
    pub harvest_triage_slot: Arc<OnceLock<Arc<commands::harvest::HarvestTriage>>>,
}

/// Builds the EventBus (and spawns its flush task) plus the Samurai tees.
pub(super) fn build_event_bus(app: &tauri::App) -> (Arc<EventBus>, SamuraiTees) {
    // Create EventBus - emits events to frontend via Tauri.
    //
    // Events are batched rather than emitted one IPC message at a time:
    // a SessionStart hook (launch, /clear, `claude --resume`) replays the
    // whole transcript from byte 0, which pushes ~2000 events through here
    // back-to-back. Time-based coalescing mirrors the PTY output path
    // (see core::process_manager, FLUSH_INTERVAL) — accumulate into a
    // shared buffer and flush every 16ms (60fps) or once the buffer fills,
    // whichever comes first. Order is preserved: the buffer is a Vec
    // drained from the front.
    const MAX_BATCH_EVENTS: usize = 256;
    let app_handle_for_bus = app.handle().clone();
    let pending_events: Arc<Mutex<Vec<ClaudeEvent>>> = Arc::new(Mutex::new(Vec::new()));
    // `data_ready` wakes the idle drain task; `flush_now` cuts the
    // coalescing window short when the buffer is already large, so a
    // full-transcript replay ships as several medium messages instead of
    // one huge one.
    let data_ready = Arc::new(tokio::sync::Notify::new());
    let flush_now = Arc::new(tokio::sync::Notify::new());

    // Samurai (issue #52): backend tee. The context store observes
    // every deduped event before it enters the frontend batch buffer,
    // retaining the latest context % per session for Phase 2's
    // handoff trigger and ACK scanner. Observation only — the
    // batching path below is unchanged.
    let samurai_context = Arc::new(SamuraiContextStore::new());

    // Samurai (issue #53): the injection controller is constructed
    // further down (it needs the supervisor/config/audit created
    // there), but both event tees are built here — a late-bound slot
    // bridges the gap. Events arriving before it is filled concern no
    // supervised session and are safely ignored.
    let samurai_injector: Arc<std::sync::OnceLock<Arc<SamuraiInjector>>> =
        Arc::new(std::sync::OnceLock::new());
    // Samurai (issue #96): the run-completion scanner rides the same
    // tee; same late-bound slot (it needs the run-config store
    // constructed further down).
    let samurai_completion: Arc<
        std::sync::OnceLock<Arc<core::samurai_completion::SamuraiCompletionWatcher>>,
    > = Arc::new(std::sync::OnceLock::new());
    // Interactive harvest triage (issue #98): armed sessions get the
    // journal prompt injected on their first SessionStarted hook
    // signal. Same late-bound slot pattern (it needs the journal
    // store constructed further down).
    let harvest_triage_slot: Arc<
        std::sync::OnceLock<Arc<commands::harvest::HarvestTriage>>,
    > = Arc::new(std::sync::OnceLock::new());

    let pending_for_emit = pending_events.clone();
    let data_ready_for_emit = data_ready.clone();
    let flush_now_for_emit = flush_now.clone();
    let samurai_context_for_emit = samurai_context.clone();
    let samurai_injector_for_emit = samurai_injector.clone();
    let samurai_completion_for_emit = samurai_completion.clone();
    let emit_fn: Arc<dyn Fn(ClaudeEvent) + Send + Sync> = Arc::new(move |event: ClaudeEvent| {
        samurai_context_for_emit.observe(&event);
        // Samurai (issue #53): ACK scanning over AssistantMessage.
        if let Some(injector) = samurai_injector_for_emit.get() {
            injector.observe(&event);
        }
        // Samurai (issue #96): completion-declaration scanning.
        if let Some(completion) = samurai_completion_for_emit.get() {
            completion.observe(&event);
        }
        // Recover from a poisoned lock rather than dropping the event —
        // losing one silently would corrupt the frontend's activity feed.
        let len = {
            let mut buf = pending_for_emit
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            buf.push(event);
            buf.len()
        };
        data_ready_for_emit.notify_one();
        if len >= MAX_BATCH_EVENTS {
            flush_now_for_emit.notify_one();
        }
    });

    tauri::async_runtime::spawn(async move {
        const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(16);
        loop {
            // Idle: park until a producer signals there is something to
            // send. `notify_one` stores a permit when nobody is waiting,
            // so an event pushed mid-flush cannot be stranded.
            data_ready.notified().await;

            tokio::select! {
                _ = tokio::time::sleep(FLUSH_INTERVAL) => {}
                _ = flush_now.notified() => {}
            }

            // Emit in bounded chunks: a 2000-event replay becomes a
            // handful of medium messages rather than one huge one.
            loop {
                let batch: Vec<ClaudeEvent> = {
                    let mut buf = pending_events
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if buf.is_empty() {
                        break;
                    }
                    let take = buf.len().min(MAX_BATCH_EVENTS);
                    buf.drain(..take).collect()
                };
                let _ = app_handle_for_bus.emit("claude-events", &batch);
            }
        }
    });

    let event_bus = Arc::new(EventBus::new(emit_fn));

    (
        event_bus,
        SamuraiTees {
            samurai_context,
            samurai_injector,
            samurai_completion,
            harvest_triage_slot,
        },
    )
}
