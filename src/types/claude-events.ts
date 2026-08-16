export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Per-tool-family call counts a subagent reports when it finishes. */
export interface SubagentToolStats {
  read_count: number;
  search_count: number;
  bash_count: number;
  edit_file_count: number;
  lines_added: number;
  lines_removed: number;
  other_tool_count: number;
}

export type ClaudeEvent =
  | {
      event_type: "SessionStarted";
      session_id: number;
      claude_session_uuid: string;
      transcript_path: string;
      timestamp: string;
    }
  | { event_type: "SessionEnded"; session_id: number; reason: string; timestamp: string }
  | { event_type: "UserMessage"; session_id: number; uuid: string; text: string; timestamp: string }
  | {
      event_type: "AssistantMessage";
      session_id: number;
      uuid: string;
      text: string;
      model: string;
      token_usage: TokenUsage | null;
      timestamp: string;
    }
  | {
      event_type: "ToolUseStarted";
      session_id: number;
      tool_name: string;
      tool_use_id: string;
      input_summary: string;
      timestamp: string;
    }
  | {
      event_type: "ToolUseCompleted";
      session_id: number;
      tool_name: string;
      tool_use_id: string;
      success: boolean;
      timestamp: string;
    }
  | {
      event_type: "FileEdited";
      session_id: number;
      file_path: string;
      tool: string;
      timestamp: string;
    }
  | { event_type: "FileCreated"; session_id: number; file_path: string; timestamp: string }
  | {
      event_type: "SubagentSpawned";
      session_id: number;
      agent_type: string;
      agent_id: string;
      description: string;
      prompt: string;
      run_in_background: boolean;
      parent_agent_id: string | null;
      /** Model the orchestrator asked for in the spawn input (e.g. "sonnet"). */
      model?: string | null;
      timestamp: string;
    }
  | {
      event_type: "SubagentLaunched";
      session_id: number;
      agent_id: string;
      agent_run_id: string;
      model: string;
      timestamp: string;
    }
  | {
      event_type: "SubagentCompleted";
      session_id: number;
      agent_id: string;
      success: boolean;
      report: string;
      status: string | null;
      agent_type: string | null;
      model: string | null;
      duration_ms: number | null;
      total_tokens: number | null;
      tool_use_count: number | null;
      tool_stats: SubagentToolStats | null;
      agent_run_id: string | null;
      timestamp: string;
    }
  | {
      event_type: "StatusUpdate";
      session_id: number;
      state: string;
      message: string;
      needs_input_prompt: string | null;
      timestamp: string;
    }
  | {
      event_type: "TokenUsageUpdate";
      session_id: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      timestamp: string;
    }
  | {
      event_type: "ContextUsageUpdate";
      session_id: number;
      model: string;
      context_tokens: number;
      context_window: number;
      percent: number;
      timestamp: string;
    };
