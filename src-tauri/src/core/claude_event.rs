//! Unified event types for the Claude Event Bus.
//!
//! Every event flowing through the system is represented as a [`ClaudeEvent`]
//! variant. The enum is serde-tagged so that JSON payloads carry an explicit
//! `"event_type"` discriminator, making frontend consumption straightforward.

use serde::{Deserialize, Serialize};

/// Token usage statistics reported by the Claude API.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
}

/// Per-tool-family call counts a subagent reports when it finishes.
///
/// Mirrors the `toolStats` object inside a subagent tool_result's
/// `toolUseResult`. Absent on older transcripts and on background agents,
/// whose completion arrives as a task-notification carrying no counters.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SubagentToolStats {
    pub read_count: u64,
    pub search_count: u64,
    pub bash_count: u64,
    pub edit_file_count: u64,
    pub lines_added: u64,
    pub lines_removed: u64,
    pub other_tool_count: u64,
}

/// A single event emitted by, or on behalf of, a Claude Code session.
///
/// Variants are internally tagged via `event_type` so the serialized JSON
/// always contains `{ "event_type": "VariantName", ... }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event_type")]
pub enum ClaudeEvent {
    // === Lifecycle (Hook-sourced) ===
    /// A new Claude Code session has started (from SessionStart hook).
    SessionStarted {
        session_id: u32,
        claude_session_uuid: String,
        transcript_path: String,
        timestamp: String,
    },

    /// A Claude Code session has ended.
    SessionEnded {
        session_id: u32,
        reason: String,
        timestamp: String,
    },

    // === Messages (Transcript-sourced) ===
    /// The user sent a message to the assistant.
    UserMessage {
        session_id: u32,
        uuid: String,
        text: String,
        timestamp: String,
    },

    /// The assistant produced a response.
    AssistantMessage {
        session_id: u32,
        uuid: String,
        text: String,
        model: String,
        token_usage: Option<TokenUsage>,
        timestamp: String,
    },

    // === Tool Activity (Transcript + Hook-sourced) ===
    /// A tool invocation has started.
    ToolUseStarted {
        session_id: u32,
        tool_name: String,
        tool_use_id: String,
        input_summary: String,
        timestamp: String,
    },

    /// A tool invocation has completed.
    ToolUseCompleted {
        session_id: u32,
        tool_name: String,
        tool_use_id: String,
        success: bool,
        timestamp: String,
    },

    // === File Changes (Transcript-sourced) ===
    /// A file was edited by the assistant.
    FileEdited {
        session_id: u32,
        file_path: String,
        tool: String,
        timestamp: String,
    },

    /// A new file was created by the assistant.
    FileCreated {
        session_id: u32,
        file_path: String,
        timestamp: String,
    },

    // === Subagents (Transcript-sourced) ===
    /// A sub-agent was spawned.
    SubagentSpawned {
        session_id: u32,
        agent_type: String,
        agent_id: String,
        description: String,
        /// The full brief the orchestrator sent down (the tool's `prompt`).
        prompt: String,
        /// The spawn asked for a background agent, so its tool_result returns
        /// immediately and real completion arrives later as a notification.
        run_in_background: bool,
        /// Tool_use id of the agent that spawned this one — set when the spawn
        /// was parsed out of a subagent's own transcript (a nested agent).
        /// `None` when the session itself spawned it. `default` so events
        /// serialized before this field existed still deserialize.
        #[serde(default)]
        parent_agent_id: Option<String>,
        /// Model the orchestrator asked for in the spawn input (e.g. "sonnet").
        /// `None` when the input names none; the launch/completion may later
        /// resolve the actual model. `default` so older serialized events
        /// still deserialize.
        #[serde(default)]
        model: Option<String>,
        timestamp: String,
    },

    /// A background sub-agent was accepted and is now running.
    ///
    /// Its tool_result comes back at once with `status: "async_launched"`, so it
    /// is emphatically *not* a completion — it only tells us the run id and the
    /// model Claude resolved for the agent.
    SubagentLaunched {
        session_id: u32,
        agent_id: String,
        agent_run_id: String,
        model: String,
        timestamp: String,
    },

    /// A sub-agent finished its work.
    ///
    /// Everything past `success` comes from the transcript's `toolUseResult`
    /// (foreground agents) or the `<task-notification>` message (background
    /// agents), neither of which is guaranteed to be present — hence the
    /// `Option`s and the empty-string fallback for `report`.
    SubagentCompleted {
        session_id: u32,
        agent_id: String,
        /// Whether the Task tool_result reported success (`is_error` absent/false).
        success: bool,
        /// The sub-agent's final report back to the orchestrator.
        report: String,
        /// Raw status verbatim ("completed", …) when the transcript states one.
        status: Option<String>,
        /// Resolved agent type, which corrects a spawn that named none.
        agent_type: Option<String>,
        /// Model Claude actually ran the sub-agent on.
        model: Option<String>,
        duration_ms: Option<u64>,
        total_tokens: Option<u64>,
        tool_use_count: Option<u64>,
        tool_stats: Option<SubagentToolStats>,
        /// Claude's own id for the agent run — not the same as the tool_use id.
        agent_run_id: Option<String>,
        timestamp: String,
    },

    // === Status (MCP-sourced) ===
    /// A status/state change reported by the session.
    StatusUpdate {
        session_id: u32,
        state: String,
        message: String,
        needs_input_prompt: Option<String>,
        timestamp: String,
    },

    // === Token Usage (Transcript-sourced) ===
    /// Token usage for a single API call.
    TokenUsageUpdate {
        session_id: u32,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_creation_tokens: u64,
        timestamp: String,
    },

    /// Derived context-window usage for a session (Transcript-sourced).
    ///
    /// Recomputed from every assistant message that carries usage data: the
    /// current context size is that message's `input_tokens +
    /// cache_read_input_tokens + cache_creation_input_tokens`, and the window
    /// is resolved from the message's model string. The latest event for a
    /// session is authoritative; idle sessions simply keep their last value.
    ContextUsageUpdate {
        session_id: u32,
        /// Model string of the assistant message the usage came from.
        model: String,
        /// input + cache_read + cache_creation tokens of the latest call.
        context_tokens: u64,
        /// The model's context window in tokens.
        context_window: u64,
        /// `context_tokens / context_window * 100`, rounded to one decimal.
        percent: f64,
        timestamp: String,
    },
}

impl ClaudeEvent {
    /// Returns the `session_id` carried by every event variant.
    // Every consumer so far destructures the variant it cares about and reads
    // the field directly; kept because the invariant it encodes (every variant
    // has one) is worth stating in code.
    #[allow(dead_code)]
    pub fn session_id(&self) -> u32 {
        match self {
            ClaudeEvent::SessionStarted { session_id, .. }
            | ClaudeEvent::SessionEnded { session_id, .. }
            | ClaudeEvent::UserMessage { session_id, .. }
            | ClaudeEvent::AssistantMessage { session_id, .. }
            | ClaudeEvent::ToolUseStarted { session_id, .. }
            | ClaudeEvent::ToolUseCompleted { session_id, .. }
            | ClaudeEvent::FileEdited { session_id, .. }
            | ClaudeEvent::FileCreated { session_id, .. }
            | ClaudeEvent::SubagentSpawned { session_id, .. }
            | ClaudeEvent::SubagentLaunched { session_id, .. }
            | ClaudeEvent::SubagentCompleted { session_id, .. }
            | ClaudeEvent::StatusUpdate { session_id, .. }
            | ClaudeEvent::TokenUsageUpdate { session_id, .. }
            | ClaudeEvent::ContextUsageUpdate { session_id, .. } => *session_id,
        }
    }

    /// Returns a deduplication key unique to this event's identity.
    ///
    /// Two events with the same dedup key represent the same logical
    /// occurrence and one may safely be dropped.
    pub fn dedup_key(&self) -> String {
        match self {
            ClaudeEvent::SessionStarted { session_id, claude_session_uuid, .. } => {
                format!("SessionStarted:{session_id}:{claude_session_uuid}")
            }
            // The reason is part of the identity: the Stop hook reports every
            // agent turn end as `reason = "stop"`, so keying on the session id
            // alone let a genuine session end (`/clear`, `/exit`) landing
            // inside the bus's 5s window share the key with the turn end that
            // preceded it — and be dropped (issue #76).
            ClaudeEvent::SessionEnded {
                session_id, reason, ..
            } => {
                format!("SessionEnded:{session_id}:{reason}")
            }
            ClaudeEvent::UserMessage { uuid, .. } => {
                format!("UserMessage:{uuid}")
            }
            ClaudeEvent::AssistantMessage { uuid, .. } => {
                format!("AssistantMessage:{uuid}")
            }
            ClaudeEvent::ToolUseStarted { tool_use_id, .. } => {
                format!("ToolUseStarted:{tool_use_id}")
            }
            ClaudeEvent::ToolUseCompleted { tool_use_id, .. } => {
                format!("ToolUseCompleted:{tool_use_id}")
            }
            ClaudeEvent::FileEdited { session_id, file_path, timestamp, .. } => {
                format!("FileEdited:{session_id}:{file_path}:{timestamp}")
            }
            ClaudeEvent::FileCreated { session_id, file_path, timestamp } => {
                format!("FileCreated:{session_id}:{file_path}:{timestamp}")
            }
            // Session-scoped: the frontend keys agents by (session, agent),
            // because resuming the same conversation in a second terminal
            // replays identical tool_use ids under a new session id. Keying on
            // the agent id alone let the first terminal's replay swallow the
            // second's inside the dedup window, so its agents never appeared.
            ClaudeEvent::SubagentSpawned { session_id, agent_id, .. } => {
                format!("SubagentSpawned:{session_id}:{agent_id}")
            }
            ClaudeEvent::SubagentLaunched { session_id, agent_id, .. } => {
                format!("SubagentLaunched:{session_id}:{agent_id}")
            }
            // Timestamped: a background agent can be resumed and notify again
            // under the same id, and each notification carries a fresh report.
            // Keying on the id alone would drop every completion after the first.
            ClaudeEvent::SubagentCompleted {
                session_id,
                agent_id,
                timestamp,
                ..
            } => {
                format!("SubagentCompleted:{session_id}:{agent_id}:{timestamp}")
            }
            ClaudeEvent::StatusUpdate { session_id, state, message, .. } => {
                format!("StatusUpdate:{session_id}:{state}:{message}")
            }
            ClaudeEvent::TokenUsageUpdate { session_id, input_tokens, output_tokens, .. } => {
                format!("TokenUsageUpdate:{session_id}:{input_tokens}:{output_tokens}")
            }
            // Timestamped so that identical context sizes from distinct
            // assistant messages (same-size context, different call) are not
            // conflated; a re-read of the same line still dedups.
            ClaudeEvent::ContextUsageUpdate { session_id, context_tokens, timestamp, .. } => {
                format!("ContextUsageUpdate:{session_id}:{context_tokens}:{timestamp}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dedup_key_uniqueness() {
        let a = ClaudeEvent::ToolUseStarted {
            session_id: 1,
            tool_name: "Read".into(),
            tool_use_id: "toolu_aaa".into(),
            input_summary: "file.rs".into(),
            timestamp: "2026-02-24T00:00:00Z".into(),
        };
        let b = ClaudeEvent::ToolUseStarted {
            session_id: 1,
            tool_name: "Read".into(),
            tool_use_id: "toolu_bbb".into(),
            input_summary: "file.rs".into(),
            timestamp: "2026-02-24T00:00:00Z".into(),
        };
        assert_ne!(a.dedup_key(), b.dedup_key());
    }

    #[test]
    fn test_dedup_key_same_event() {
        let a = ClaudeEvent::UserMessage {
            session_id: 1,
            uuid: "uuid-123".into(),
            text: "hello".into(),
            timestamp: "2026-02-24T00:00:00Z".into(),
        };
        let b = ClaudeEvent::UserMessage {
            session_id: 1,
            uuid: "uuid-123".into(),
            text: "hello".into(),
            timestamp: "2026-02-24T00:00:00Z".into(),
        };
        assert_eq!(a.dedup_key(), b.dedup_key());
    }

    /// Resuming a conversation in a second terminal replays the same tool_use
    /// ids under a new session id. The store keys agents by (session, agent),
    /// so the dedup keys must too — otherwise the second terminal's replayed
    /// spawns land inside the first's 5s window and are silently swallowed.
    #[test]
    fn test_subagent_dedup_keys_are_scoped_by_session() {
        let spawned = |session_id| ClaudeEvent::SubagentSpawned {
            session_id,
            agent_type: "Explore".into(),
            agent_id: "toolu_x".into(),
            description: "d".into(),
            prompt: "p".into(),
            run_in_background: false,
            parent_agent_id: None,
            model: None,
            timestamp: "t".into(),
        };
        assert_ne!(spawned(1).dedup_key(), spawned(2).dedup_key());

        let launched = |session_id| ClaudeEvent::SubagentLaunched {
            session_id,
            agent_id: "toolu_x".into(),
            agent_run_id: "run".into(),
            model: "claude-fable-5".into(),
            timestamp: "t".into(),
        };
        assert_ne!(launched(1).dedup_key(), launched(2).dedup_key());

        let completed = |session_id| ClaudeEvent::SubagentCompleted {
            session_id,
            agent_id: "toolu_x".into(),
            success: true,
            report: "r".into(),
            status: None,
            agent_type: None,
            model: None,
            duration_ms: None,
            total_tokens: None,
            tool_use_count: None,
            tool_stats: None,
            agent_run_id: None,
            timestamp: "t".into(),
        };
        assert_ne!(completed(1).dedup_key(), completed(2).dedup_key());
        // Same session, same timestamp: still one logical occurrence.
        assert_eq!(completed(1).dedup_key(), completed(1).dedup_key());
    }

    #[test]
    fn test_session_id_extraction() {
        let events: Vec<ClaudeEvent> = vec![
            ClaudeEvent::SessionStarted { session_id: 1, claude_session_uuid: "u".into(), transcript_path: "p".into(), timestamp: "t".into() },
            ClaudeEvent::SessionEnded { session_id: 2, reason: "done".into(), timestamp: "t".into() },
            ClaudeEvent::UserMessage { session_id: 3, uuid: "u".into(), text: "hi".into(), timestamp: "t".into() },
            ClaudeEvent::AssistantMessage { session_id: 4, uuid: "u".into(), text: "hello".into(), model: "opus".into(), token_usage: None, timestamp: "t".into() },
            ClaudeEvent::ToolUseStarted { session_id: 5, tool_name: "Read".into(), tool_use_id: "x".into(), input_summary: "s".into(), timestamp: "t".into() },
            ClaudeEvent::ToolUseCompleted { session_id: 6, tool_name: "Read".into(), tool_use_id: "x".into(), success: true, timestamp: "t".into() },
            ClaudeEvent::FileEdited { session_id: 7, file_path: "/a".into(), tool: "Edit".into(), timestamp: "t".into() },
            ClaudeEvent::FileCreated { session_id: 8, file_path: "/b".into(), timestamp: "t".into() },
            ClaudeEvent::SubagentSpawned { session_id: 9, agent_type: "Explore".into(), agent_id: "s".into(), description: "d".into(), prompt: "p".into(), run_in_background: false, parent_agent_id: None, model: None, timestamp: "t".into() },
            ClaudeEvent::SubagentCompleted { session_id: 10, agent_id: "s".into(), success: true, report: "r".into(), status: None, agent_type: None, model: None, duration_ms: None, total_tokens: None, tool_use_count: None, tool_stats: None, agent_run_id: None, timestamp: "t".into() },
            ClaudeEvent::StatusUpdate { session_id: 11, state: "working".into(), message: "m".into(), needs_input_prompt: None, timestamp: "t".into() },
            ClaudeEvent::TokenUsageUpdate { session_id: 12, input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_creation_tokens: 5, timestamp: "t".into() },
            ClaudeEvent::SubagentLaunched { session_id: 13, agent_id: "s".into(), agent_run_id: "run".into(), model: "claude-fable-5".into(), timestamp: "t".into() },
            ClaudeEvent::ContextUsageUpdate { session_id: 14, model: "claude-fable-5".into(), context_tokens: 400_000, context_window: 1_000_000, percent: 40.0, timestamp: "t".into() },
        ];
        for (i, event) in events.iter().enumerate() {
            assert_eq!(event.session_id(), (i as u32) + 1);
        }
    }

    #[test]
    fn test_serialize_deserialize_roundtrip() {
        let original = ClaudeEvent::AssistantMessage {
            session_id: 42,
            uuid: "msg-001".into(),
            text: "Hello, world!".into(),
            model: "claude-opus-4-6".into(),
            token_usage: Some(TokenUsage {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_input_tokens: 10,
                cache_creation_input_tokens: 5,
            }),
            timestamp: "2026-02-24T12:00:00Z".into(),
        };
        let json = serde_json::to_string(&original).expect("serialize");
        let recovered: ClaudeEvent = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(recovered.session_id(), 42);
        if let ClaudeEvent::AssistantMessage { text, model, token_usage, .. } = &recovered {
            assert_eq!(text, "Hello, world!");
            assert_eq!(model, "claude-opus-4-6");
            assert!(token_usage.is_some());
            assert_eq!(token_usage.as_ref().unwrap().input_tokens, 100);
        } else {
            panic!("wrong variant after roundtrip");
        }
    }

    #[test]
    fn test_tagged_serialization() {
        let event = ClaudeEvent::ToolUseStarted {
            session_id: 1,
            tool_name: "Read".into(),
            tool_use_id: "abc".into(),
            input_summary: "file.rs".into(),
            timestamp: "2026-02-24T00:00:00Z".into(),
        };
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(
            json.contains(r#""event_type":"ToolUseStarted""#),
            "JSON should contain tagged event_type field, got: {json}"
        );
    }
}
