//! Event pipeline: the batched `claude-events` EventBus.

use std::sync::{Arc, Mutex};

use tauri::Emitter;

use crate::core::{ClaudeEvent, EventBus};

/// Builds the EventBus and spawns its flush task.
pub(super) fn build_event_bus(app: &tauri::App) -> Arc<EventBus> {
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

    let pending_for_emit = pending_events.clone();
    let data_ready_for_emit = data_ready.clone();
    let flush_now_for_emit = flush_now.clone();
    let emit_fn: Arc<dyn Fn(ClaudeEvent) + Send + Sync> = Arc::new(move |event: ClaudeEvent| {
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

    Arc::new(EventBus::new(emit_fn))
}
