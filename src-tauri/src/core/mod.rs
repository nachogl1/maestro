pub mod atomic_write;
pub mod brief_files;
pub mod claude_event;
pub mod cli_path;
pub mod config_recovery;
pub mod error;
pub mod event_bus;
pub mod extended_paths;
pub mod font_detector;
pub mod hook_config_writer;
pub mod marketplace_error;
pub mod marketplace_manager;
pub mod marketplace_models;
pub mod mcp_config_writer;
pub mod mcp_error;
pub mod mcp_manager;
pub mod mcp_settings;
pub mod open_terminals;
pub mod plugin_config_writer;
pub mod plugin_error;
pub mod plugin_manager;
pub mod pr_runs;
pub mod process_manager;
pub mod pty_submit;
pub mod redirection_guard;
pub mod session_manager;
pub mod status_server;
pub mod terminal_backend;
/// Event-driven waits shared by the integration test harnesses.
#[cfg(test)]
pub mod test_wait;
pub mod transcript_parser;
pub mod transcript_watcher;
pub mod windows_process;
pub mod work_journal;
pub mod work_journal_activity;
pub mod work_journal_collect;
pub mod work_journal_markdown;
pub mod work_journal_quit;
pub mod work_journal_report;
pub mod work_journal_run;
pub mod work_journal_spelling;
pub mod workshop;
pub mod worktree_manager;

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
