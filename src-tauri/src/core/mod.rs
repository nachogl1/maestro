pub mod allowance_watcher;
pub mod claude_event;
pub mod cli_path;
pub mod config_recovery;
pub mod error;
pub mod event_bus;
pub mod font_detector;
pub mod hook_config_writer;
pub mod marketplace_error;
pub mod marketplace_manager;
pub mod marketplace_models;
pub mod mcp_config_writer;
pub mod mcp_manager;
pub mod mcp_settings;
pub mod plugin_config_writer;
pub mod plugin_manager;
pub mod process_manager;
pub mod samurai_audit;
pub mod samurai_auth_watch;
pub mod samurai_brief;
pub mod samurai_completion;
pub mod samurai_config;
pub mod samurai_context;
pub mod samurai_files;
pub mod samurai_injector;
pub mod samurai_journal;
pub mod samurai_latches;
pub mod samurai_parker;
pub mod samurai_pr_runs;
pub mod samurai_progress;
pub mod samurai_prompts;
pub mod samurai_pty;
pub mod samurai_reconciler;
pub mod samurai_replicator;
pub mod samurai_resumer;
pub mod samurai_run_config;
pub mod samurai_schedule;
pub mod samurai_test_gate;
pub mod samurai_watchdog;
pub mod samurai_workflow;
pub mod session_manager;
pub mod status_server;
pub mod supervisor;
pub mod terminal_backend;
pub mod transcript_parser;
pub mod transcript_watcher;
pub mod windows_process;
pub mod worktree_manager;
pub mod xterm_backend;

#[cfg(feature = "vte-backend")]
pub mod vte_backend;

pub use claude_event::ClaudeEvent;
pub use error::PtyError;
pub use event_bus::EventBus;
pub use font_detector::{detect_available_fonts, is_font_available, AvailableFont};
pub use process_manager::ProcessManager;
pub use status_server::StatusServer;
// Only the two types `commands::terminal` reads are re-exported here. Every
// other consumer imports through the defining module (`core::foo::Bar`), so
// a façade entry for them would be a second name for the same thing that
// nothing calls.
pub use terminal_backend::{BackendCapabilities, BackendType};
pub use transcript_watcher::TranscriptWatcher;

#[cfg(feature = "vte-backend")]
pub use vte_backend::VteBackend;
