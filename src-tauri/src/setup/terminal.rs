//! Terminal session wiring: the generic initial-prompt injector, the hook
//! callback that starts transcript watching, and the HTTP status server.

use std::sync::Arc;

use tauri::Manager;

use super::events::SamuraiTees;
use crate::commands;
use crate::core;
use crate::core::status_server::StatusServer;
use crate::core::ProcessManager;
use crate::core::{ClaudeEvent, EventBus, TranscriptWatcher};

/// Wires the hook path and starts the status server, then manages the
/// EventBus and TranscriptWatcher. Fails when the status server cannot start.
pub(super) fn setup_terminal(
    app: &tauri::App,
    instance_id: String,
    event_bus: Arc<EventBus>,
    tees: &SamuraiTees,
) -> Result<(), Box<dyn std::error::Error>> {
    let samurai_injector = &tees.samurai_injector;
    let harvest_triage_slot = &tees.harvest_triage_slot;

    // Create TranscriptWatcher
    let transcript_watcher = Arc::new(TranscriptWatcher::new(event_bus.clone()));

    // Generic initial prompt: a launch that carries prompt text arms
    // the session via `terminal_arm_initial_prompt` right before the
    // CLI command is typed, and the session's first SessionStarted
    // hook signal types the prompt in. Same delivery as the harvest
    // triage below — the confirmed body write, then the scaled gap
    // and the lone Enter (issue #103). No late-bound slot: this
    // depends only on the ProcessManager, already managed.
    let initial_prompt_pm = app.state::<ProcessManager>().inner().clone();
    let initial_prompt_deliver: commands::harvest::DeliverFn =
        Arc::new(move |session_id, prompt| {
            core::samurai_pty::submit_instruction_confirmed(
                initial_prompt_pm.clone(),
                session_id,
                prompt,
                "initial-prompt",
            )
        });
    let initial_prompt = Arc::new(commands::initial_prompt::InitialPromptInjector::new(
        initial_prompt_deliver,
    ));
    app.manage(initial_prompt.clone());

    // Create hook emit callback
    // When SessionStarted events arrive via hooks, start watching the transcript
    let event_bus_for_hooks = event_bus.clone();
    let initial_prompt_for_hooks = initial_prompt.clone();
    let transcript_watcher_for_hooks = transcript_watcher.clone();
    let samurai_injector_for_hooks = samurai_injector.clone();
    let harvest_triage_for_hooks = harvest_triage_slot.clone();
    let hook_emit_fn: Arc<dyn Fn(ClaudeEvent) + Send + Sync> = Arc::new(move |event: ClaudeEvent| {
        if let ClaudeEvent::SessionStarted { session_id, ref transcript_path, .. } = event {
            transcript_watcher_for_hooks.start_watching(
                session_id,
                std::path::PathBuf::from(transcript_path),
            );
            // Interactive harvest triage (issue #98): an armed
            // session's first SessionStarted is the injection gate —
            // the same signal the replicator uses for successor
            // briefs. The injection reads and commits the journal
            // (file IO, Windows rename retries), so it leaves the
            // hook chain via the blocking pool.
            if let Some(triage) = harvest_triage_for_hooks.get() {
                let triage = triage.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    triage.on_session_started(session_id);
                });
            }
            // Generic initial prompt: same gate, same policy — the
            // PTY write is fully blocking, so it leaves the hook
            // chain via the blocking pool. A session nobody armed is
            // a no-op inside the injector.
            let initial_prompt_injector = initial_prompt_for_hooks.clone();
            tauri::async_runtime::spawn_blocking(move || {
                initial_prompt_injector.on_session_started(session_id);
            });
        }
        // Samurai (issue #53): idle-gate signal (Stop hook →
        // SessionEnded reason "stop"). Tapped here, pre-dedup: the
        // EventBus dedups SessionEnded per session and reason, so a
        // Stop landing within the 5s window of another Stop would
        // never reach a bus-side tee.
        if let Some(injector) = samurai_injector_for_hooks.get() {
            injector.observe_hook(&event);
        }
        event_bus_for_hooks.emit(event);
    });

    // Start the HTTP status server for MCP status reporting
    // IMPORTANT: This must be done synchronously so the server is ready
    // before any commands try to use it
    let app_handle = app.handle().clone();
    let server = tauri::async_runtime::block_on(async {
        StatusServer::start(app_handle, instance_id, Some(hook_emit_fn)).await
    });

    match server {
        Some(server) => {
            log::info!(
                "Status server started on port {}, URL: {}",
                server.port(),
                server.status_url()
            );
            app.manage(Arc::new(server));
        }
        None => {
            log::error!("Failed to start status server - MCP status reporting will not work");
            // Return error to prevent app from starting without status server
            return Err("Failed to start status server".into());
        }
    }

    app.manage(event_bus);
    app.manage(transcript_watcher);

    Ok(())
}
