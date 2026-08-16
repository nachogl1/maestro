//! Pure parsing functions for Claude Code JSONL transcript lines.
//!
//! Each line in a transcript file (`~/.claude/projects/{project}/{sessionId}.jsonl`)
//! is a JSON object representing a user message, assistant message, or
//! file-history snapshot.  [`parse_transcript_line`] converts a single line
//! into zero or more [`ClaudeEvent`] variants without performing any file I/O.

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::Value;

use super::claude_event::{ClaudeEvent, SubagentToolStats, TokenUsage};

// ---------------------------------------------------------------------------
// Line shapes
// ---------------------------------------------------------------------------
//
// Transcript lines are big: on the transcripts on this machine, `toolUseResult`
// alone is ~48% of every byte written, and ~99% of that sits under keys nothing
// here reads (`file`, `stdout`, `structuredPatch`, …). Deserializing a line into
// a `Value` allocated that whole tree — on every appended line of every live
// session, and over the entire file again on resume.
//
// These narrow structs make serde walk past the unread keys without allocating
// them, and keep the fields that *can* be huge as unparsed spans (`RawValue`)
// so they cost something only on the branch that genuinely reads them.
//
// Every field is a span rather than a typed value on purpose: a struct of
// `RawValue`s cannot fail to deserialize from a JSON object, so an unexpected
// field type costs the entry one field (exactly like `Value::as_str` returning
// `None` did) instead of dropping the whole line.

/// The top-level fields a transcript entry is read for.
#[derive(Deserialize)]
struct Entry<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<&'a RawValue>,
    #[serde(borrow)]
    uuid: Option<&'a RawValue>,
    #[serde(borrow)]
    timestamp: Option<&'a RawValue>,
    #[serde(borrow)]
    message: Option<&'a RawValue>,
    #[serde(rename = "toolUseResult", borrow)]
    tool_use_result: Option<&'a RawValue>,
}

/// A message envelope; only its `content` is ever read.
#[derive(Deserialize)]
struct Message<'a> {
    #[serde(borrow)]
    content: Option<&'a RawValue>,
}

/// The fields of a user-message content block that are read. A `tool_result`
/// block's own `content` — the tool's entire output — is not one of them.
#[derive(Deserialize)]
struct ContentBlock<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<&'a RawValue>,
    #[serde(borrow)]
    text: Option<&'a RawValue>,
    #[serde(rename = "tool_use_id", borrow)]
    tool_use_id: Option<&'a RawValue>,
    #[serde(rename = "is_error", borrow)]
    is_error: Option<&'a RawValue>,
}

/// The `toolUseResult` fields that describe a sub-agent run.
#[derive(Deserialize)]
struct ResultDetail<'a> {
    #[serde(rename = "agentId", borrow)]
    agent_id: Option<&'a RawValue>,
    #[serde(borrow)]
    status: Option<&'a RawValue>,
    #[serde(rename = "agentType", borrow)]
    agent_type: Option<&'a RawValue>,
    #[serde(rename = "resolvedModel", borrow)]
    resolved_model: Option<&'a RawValue>,
    #[serde(borrow)]
    content: Option<&'a RawValue>,
    #[serde(rename = "totalDurationMs", borrow)]
    total_duration_ms: Option<&'a RawValue>,
    #[serde(rename = "totalTokens", borrow)]
    total_tokens: Option<&'a RawValue>,
    #[serde(rename = "totalToolUseCount", borrow)]
    total_tool_use_count: Option<&'a RawValue>,
    #[serde(rename = "toolStats", borrow)]
    tool_stats: Option<&'a RawValue>,
}

// ---------------------------------------------------------------------------
// Helpers: reading unparsed spans
// ---------------------------------------------------------------------------

/// Decode a span that should hold a JSON string, mirroring `Value::as_str`:
/// anything else yields `None` rather than an error.
fn raw_str(raw: Option<&RawValue>) -> Option<String> {
    serde_json::from_str::<String>(raw?.get()).ok()
}

/// As [`raw_str`], but dropping empty strings the way the old `str_field` did.
fn raw_str_non_empty(raw: Option<&RawValue>) -> Option<String> {
    raw_str(raw).filter(|s| !s.is_empty())
}

/// Decode a span that should hold a JSON integer, mirroring `Value::as_u64`.
fn raw_u64(raw: Option<&RawValue>) -> Option<u64> {
    serde_json::from_str::<u64>(raw?.get()).ok()
}

/// Decode a span that should hold a JSON bool, mirroring `Value::as_bool`.
fn raw_bool(raw: Option<&RawValue>) -> Option<bool> {
    serde_json::from_str::<bool>(raw?.get()).ok()
}

/// Materialize a span as a whole [`Value`] — only on branches that need the
/// entire subtree.
fn raw_value(raw: Option<&RawValue>) -> Option<Value> {
    serde_json::from_str(raw?.get()).ok()
}

/// Split a span holding an array of content blocks into the fields that are
/// read. Blocks that are not objects are dropped, as they were before: they
/// matched neither the `text` nor the `tool_result` branch.
fn content_blocks<'a>(content: Option<&'a RawValue>) -> Option<Vec<ContentBlock<'a>>> {
    let raws: Vec<&'a RawValue> = serde_json::from_str(content?.get()).ok()?;
    Some(
        raws.into_iter()
            .filter_map(|r| serde_json::from_str::<ContentBlock>(r.get()).ok())
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Parse a single JSONL line from a Claude Code transcript into events.
///
/// Returns an empty `Vec` for blank lines, invalid JSON, and
/// `"file-history-snapshot"` entries.
pub fn parse_transcript_line(session_id: u32, line: &str) -> Vec<ClaudeEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let entry: Entry = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    match raw_str(entry.kind).as_deref().unwrap_or("") {
        "user" => parse_user_message(session_id, &entry),
        "assistant" => parse_assistant_message(session_id, &entry),
        _ => Vec::new(), // skip file-history-snapshot, unknown types
    }
}

// ---------------------------------------------------------------------------
// Helpers: truncation
// ---------------------------------------------------------------------------

/// Truncate a string to `max` characters, appending "..." if truncated.
///
/// Truncation is by *character*, not byte: `&s[..max]` slices on a byte index
/// and panics if that index falls mid-codepoint. Because this runs on untrusted
/// transcript content inside a spawned reader task, a panic would silently kill
/// the session's live activity feed.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max).collect();
        format!("{truncated}...")
    }
}

// ---------------------------------------------------------------------------
// Helpers: context window
// ---------------------------------------------------------------------------

/// Default context window when the model string names no larger one.
const DEFAULT_CONTEXT_WINDOW: u64 = 200_000;

/// Resolve a model string to its context window in tokens.
///
/// Claude Code marks 1M-context variants with a literal `[1m]` suffix on the
/// model id (e.g. `claude-sonnet-4-6[1m]`), and several models run a 1M window
/// natively with no suffix. The list below mirrors the `context.native_1m`
/// flag in Claude Code's own model catalog (verified against the 2.1.232
/// bundle) — it must stay in sync, because a model missing from it is divided
/// by 200k and reports ~5x the real usage: bare `claude-sonnet-5` sessions on
/// this machine carry ~478k context tokens, which a flat 200k default turned
/// into "238.8%" and tripped the Samurai 45% handoff at ~9% real usage.
///
/// Unknown models fall back to 200k, which errs toward OVER-stating usage —
/// the safe direction for anything that acts on high context %.
fn context_window_for_model(model: &str) -> u64 {
    if model.contains("[1m]") {
        return 1_000_000;
    }
    // Models whose context window is 1M natively (no [1m] marker).
    const MILLION_TOKEN_MODELS: &[&str] = &[
        "claude-fable-5",
        "claude-mythos-5",
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-sonnet-5",
    ];
    if MILLION_TOKEN_MODELS.iter().any(|m| model.starts_with(m)) {
        return 1_000_000;
    }
    DEFAULT_CONTEXT_WINDOW
}

// ---------------------------------------------------------------------------
// Helpers: input summary
// ---------------------------------------------------------------------------

/// Produce a human-readable summary of a tool's input object.
fn summarize_tool_input(tool_name: &str, input: &Value) -> String {
    match tool_name {
        "Bash" => {
            let cmd = input
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            truncate(cmd, 120)
        }
        "Read" | "Edit" | "Write" => input
            .get("file_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "Grep" => {
            let pattern = input
                .get("pattern")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let path = input.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            format!("{pattern} in {path}")
        }
        "Glob" => input
            .get("pattern")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        // Subagent spawn — the tool was renamed "Task" -> "Agent" in newer
        // Claude Code versions; transcripts may contain either.
        "Task" | "Agent" => {
            let desc = input
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            truncate(desc, 80)
        }
        _ => {
            let s = serde_json::to_string(input).unwrap_or_default();
            truncate(&s, 100)
        }
    }
}

// ---------------------------------------------------------------------------
// Internal parsers
// ---------------------------------------------------------------------------

/// Join every `text` block of a message content array into one string.
fn join_text_blocks(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter_map(|b| {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                b.get("text").and_then(|t| t.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Pull the inner text of the first `<tag>…</tag>` pair out of `text`.
///
/// Task notifications are injected as a small XML-ish blob rather than JSON, so
/// this is deliberately a plain string scan — no XML parser, no dependency, and
/// a malformed blob simply yields `None`.
fn tag_value(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].trim().to_string())
}

/// Flatten a tool_result `content` value into plain text.
///
/// It is an array of content blocks in the transcripts we have seen, but a bare
/// string is legal too, and it is absent altogether on results that carry no
/// metadata.
fn extract_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => join_text_blocks(blocks),
        _ => String::new(),
    }
}

/// Whether an entry's `toolUseResult` is a sub-agent's, rather than some other
/// tool's. Both foreground (`completed`) and background (`async_launched`)
/// sub-agent results carry an `agentId` plus a `status`; ordinary tools carry
/// neither, and older sub-agent results carry no metadata at all — those fall
/// through to the watcher's bare completion synthesis.
fn is_subagent_result(detail: &ResultDetail) -> bool {
    detail.agent_id.is_some() && detail.status.is_some()
}

/// Build a rich [`ClaudeEvent::SubagentCompleted`] from an entry's
/// `toolUseResult` metadata.
fn subagent_completed(
    session_id: u32,
    agent_id: &str,
    is_error: bool,
    detail: &ResultDetail,
    timestamp: &str,
) -> ClaudeEvent {
    let status = raw_str_non_empty(detail.status);
    // Only an explicit failure word counts as failure; anything else is passed
    // through verbatim in `status` so an unrecognised one is displayed rather
    // than silently recoded as success or failure. "killed" is a failure: the
    // agent was stopped before finishing its work.
    let failed = matches!(status.as_deref(), Some("failed") | Some("error") | Some("killed"));
    let tool_stats = raw_value(detail.tool_stats).map(|s| {
        let count = |key: &str| s.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        SubagentToolStats {
            read_count: count("readCount"),
            search_count: count("searchCount"),
            bash_count: count("bashCount"),
            edit_file_count: count("editFileCount"),
            lines_added: count("linesAdded"),
            lines_removed: count("linesRemoved"),
            other_tool_count: count("otherToolCount"),
        }
    });

    ClaudeEvent::SubagentCompleted {
        session_id,
        agent_id: agent_id.to_string(),
        success: !is_error && !failed,
        report: extract_result_text(raw_value(detail.content).as_ref()),
        status,
        agent_type: raw_str_non_empty(detail.agent_type),
        model: raw_str_non_empty(detail.resolved_model),
        duration_ms: raw_u64(detail.total_duration_ms),
        total_tokens: raw_u64(detail.total_tokens),
        tool_use_count: raw_u64(detail.total_tool_use_count),
        tool_stats,
        agent_run_id: raw_str_non_empty(detail.agent_id),
        timestamp: timestamp.to_string(),
    }
}

fn parse_user_message(session_id: u32, entry: &Entry) -> Vec<ClaudeEvent> {
    let uuid = raw_str(entry.uuid).unwrap_or_default();
    let timestamp = raw_str(entry.timestamp).unwrap_or_default();

    let content = entry
        .message
        .and_then(|m| serde_json::from_str::<Message>(m.get()).ok())
        .and_then(|m| m.content);
    let content_blocks = content_blocks(content);

    // Content is an array of blocks for ordinary messages, but a bare string for
    // system-injected ones — task notifications among them — so read both shapes.
    let text = match &content_blocks {
        Some(blocks) => blocks
            .iter()
            .filter(|b| raw_str(b.kind).as_deref() == Some("text"))
            .filter_map(|b| raw_str(b.text))
            .collect::<Vec<_>>()
            .join("\n"),
        None => raw_str(content).unwrap_or_default(),
    };

    let mut events = vec![ClaudeEvent::UserMessage {
        session_id,
        uuid,
        text: text.clone(),
        timestamp: timestamp.clone(),
    }];

    // A background sub-agent's real completion arrives here, as a notification
    // injected into the parent conversation: the tool_result it got back at
    // launch time only said "started". The notification carries the agent's full
    // report but none of the counters a foreground result has.
    if text.contains("<task-notification>") {
        // Task notifications are not agent-only: background Bash commands,
        // workflows and monitors send the same blob (their summaries read
        // `Background command "…"` / `Dynamic workflow "…"` / `Monitor
        // event: …`). Only an agent's belongs on the agent graph — the
        // completions this parser emits can now reach the store without a
        // matching spawn, so this is the line that keeps a killed background
        // shell from showing up as a phantom agent. A notification with no
        // summary at all is the older, agent-only format and passes.
        let is_agent_notification = tag_value(&text, "summary")
            .is_none_or(|summary| summary.starts_with("Agent \""));
        if let Some(agent_id) = tag_value(&text, "tool-use-id").filter(|_| is_agent_notification) {
            let status = tag_value(&text, "status");
            let failed = matches!(status.as_deref(), Some("failed") | Some("error") | Some("killed"));
            events.push(ClaudeEvent::SubagentCompleted {
                session_id,
                agent_id,
                success: !failed,
                report: tag_value(&text, "result").unwrap_or_default(),
                status,
                agent_type: None,
                model: None,
                duration_ms: None,
                total_tokens: None,
                tool_use_count: None,
                tool_stats: None,
                agent_run_id: tag_value(&text, "task-id"),
                timestamp: timestamp.clone(),
            });
        }
    }

    // tool_result blocks close out an earlier tool_use with the same id.
    // The originating tool's name isn't present on the result block, so
    // tool_name is left empty; consumers match on tool_use_id.
    if let Some(blocks) = &content_blocks {
        // Sub-agent detail hangs off the entry, not the block. Claude Code
        // writes at most one tool_result per entry (0 of 4070 entries across
        // every transcript on this machine carried two), so it belongs to
        // whichever result block this entry has.
        //
        // Reading it through `ResultDetail` skips the tool's payload — the
        // `file` / `stdout` blob that is most of the line — without allocating
        // it. A `toolUseResult` that is not an object fails to decode and is
        // treated as absent, exactly as the old `is_object()` filter did.
        let detail = entry
            .tool_use_result
            .and_then(|r| serde_json::from_str::<ResultDetail>(r.get()).ok())
            .filter(is_subagent_result);
        let detail = detail.as_ref();
        for block in blocks {
            if raw_str(block.kind).as_deref() != Some("tool_result") {
                continue;
            }
            let tool_use_id = raw_str(block.tool_use_id).unwrap_or_default();
            if tool_use_id.is_empty() {
                continue;
            }
            let is_error = raw_bool(block.is_error).unwrap_or(false);

            // Pushed ahead of the ToolUseCompleted for the same id: the watcher
            // treats a sub-agent event as the authoritative outcome and drops
            // the generic completion that follows it.
            if let Some(detail) = detail {
                if raw_str(detail.status).as_deref() == Some("async_launched") {
                    events.push(ClaudeEvent::SubagentLaunched {
                        session_id,
                        agent_id: tool_use_id.clone(),
                        agent_run_id: raw_str(detail.agent_id).unwrap_or_default(),
                        model: raw_str(detail.resolved_model).unwrap_or_default(),
                        timestamp: timestamp.clone(),
                    });
                } else {
                    events.push(subagent_completed(
                        session_id,
                        &tool_use_id,
                        is_error,
                        detail,
                        &timestamp,
                    ));
                }
            }

            events.push(ClaudeEvent::ToolUseCompleted {
                session_id,
                tool_name: String::new(),
                tool_use_id,
                success: !is_error,
                timestamp: timestamp.clone(),
            });
        }
    }

    events
}

fn parse_assistant_message(session_id: u32, entry: &Entry) -> Vec<ClaudeEvent> {
    let uuid = raw_str(entry.uuid).unwrap_or_default();
    let timestamp = raw_str(entry.timestamp).unwrap_or_default();
    // Tool inputs are read whole (an unknown tool's summary is the serialized
    // input), so the message subtree is materialized. `toolUseResult` never is:
    // an assistant entry carries nothing there this parser reads.
    let message = raw_value(entry.message);
    let message = message.as_ref();

    let model = message
        .and_then(|m| m.get("model"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let content_blocks = message
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array());

    // Collect all text blocks into one string.
    let text = content_blocks
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        b.get("text").and_then(|t| t.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();

    // Parse usage.
    let usage_obj = message.and_then(|m| m.get("usage"));
    let token_usage = usage_obj.and_then(|u| {
        Some(TokenUsage {
            input_tokens: u.get("input_tokens")?.as_u64()?,
            output_tokens: u.get("output_tokens")?.as_u64()?,
            cache_read_input_tokens: u
                .get("cache_read_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            cache_creation_input_tokens: u
                .get("cache_creation_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
        })
    });

    let mut events: Vec<ClaudeEvent> = Vec::new();

    // Always emit an AssistantMessage.
    events.push(ClaudeEvent::AssistantMessage {
        session_id,
        uuid: uuid.clone(),
        text,
        model: model.clone(),
        token_usage: token_usage.clone(),
        timestamp: timestamp.clone(),
    });

    // Process tool_use blocks.
    if let Some(blocks) = content_blocks {
        for block in blocks {
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                continue;
            }

            let tool_name = block
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool_use_id = block
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            let input_summary = summarize_tool_input(&tool_name, &input);

            events.push(ClaudeEvent::ToolUseStarted {
                session_id,
                tool_name: tool_name.clone(),
                tool_use_id,
                input_summary,
                timestamp: timestamp.clone(),
            });

            // Emit higher-level events for specific tools.
            match tool_name.as_str() {
                "Edit" => {
                    let file_path = input
                        .get("file_path")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    events.push(ClaudeEvent::FileEdited {
                        session_id,
                        file_path,
                        tool: "Edit".to_string(),
                        timestamp: timestamp.clone(),
                    });
                }
                "Write" => {
                    let file_path = input
                        .get("file_path")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    events.push(ClaudeEvent::FileCreated {
                        session_id,
                        file_path,
                        timestamp: timestamp.clone(),
                    });
                }
                "Task" | "Agent" => {
                    let description = input
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let agent_type = input
                        .get("subagent_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let agent_id = block
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    // The brief, kept whole: it is the only record of what the
                    // orchestrator actually asked for, and it is available here
                    // at spawn time — long before any result comes back.
                    let prompt = input
                        .get("prompt")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let run_in_background = input
                        .get("run_in_background")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    // The model the orchestrator asked for, when the spawn
                    // names one (issue #126). The launch/completion later
                    // reports the model Claude actually resolved.
                    let model = input
                        .get("model")
                        .and_then(|v| v.as_str())
                        .filter(|m| !m.is_empty())
                        .map(|m| m.to_string());
                    events.push(ClaudeEvent::SubagentSpawned {
                        session_id,
                        agent_type,
                        agent_id,
                        description,
                        prompt,
                        run_in_background,
                        // The parser sees one line at a time and cannot know
                        // which file it came from; the watcher stamps the
                        // parent when the line belongs to a subagent's file.
                        parent_agent_id: None,
                        model,
                        timestamp: timestamp.clone(),
                    });
                }
                _ => {}
            }
        }
    }

    // Emit a TokenUsageUpdate when usage data is present.
    if let Some(tu) = &token_usage {
        events.push(ClaudeEvent::TokenUsageUpdate {
            session_id,
            input_tokens: tu.input_tokens,
            output_tokens: tu.output_tokens,
            cache_read_tokens: tu.cache_read_input_tokens,
            cache_creation_tokens: tu.cache_creation_input_tokens,
            timestamp: timestamp.clone(),
        });

        // Derived context-window usage: this API call's prompt size is the
        // session's current context, so each assistant message recomputes the
        // percentage and the latest one wins downstream (issue #41).
        //
        // This mirrors what Claude Code's own `/context` reports: the latest
        // assistant message's input + cache_read + cache_creation over the RAW
        // model window. `output_tokens` is deliberately excluded and no
        // auto-compact reserve is subtracted — both match `/context`. (Claude
        // Code's status-line "% until auto-compact" is a *different* figure:
        // it adds output_tokens and divides by window - max_output - 13k, so
        // it always reads higher. The badge and the 45% handoff track
        // `/context`, the number the user can actually see.)
        let context_tokens =
            tu.input_tokens + tu.cache_read_input_tokens + tu.cache_creation_input_tokens;
        // An API-error entry (model "<synthetic>", isApiErrorMessage — e.g. a
        // 429 or a spend limit) carries an all-zero usage block, while a real
        // assistant call always has a non-zero prompt. Emitting its 0% would
        // wipe the session's live reading in SamuraiContextStore and disarm
        // the 45% handoff trigger (PRD §5.4) and the highest-context-first
        // park order (§5.5).
        if context_tokens > 0 {
            let context_window = context_window_for_model(&model);
            let percent = (context_tokens as f64 / context_window as f64 * 1000.0).round() / 10.0;
            events.push(ClaudeEvent::ContextUsageUpdate {
                session_id,
                model,
                context_tokens,
                context_window,
                percent,
                timestamp: timestamp.clone(),
            });
        }
    }

    events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_does_not_panic_on_multibyte_boundary() {
        // A run of 4-byte emoji straddling the byte cutoff used to panic on the
        // byte-index slice; truncation must now be char-based.
        let s = "🚀".repeat(50); // 200 bytes, 50 chars
        for max in [1, 79, 80, 100, 120] {
            let out = truncate(&s, max);
            // Must not panic, and must respect the char budget.
            assert!(out.chars().count() <= max + 3); // +3 for the "..."
        }
    }

    #[test]
    fn truncate_appends_ellipsis_only_when_cut() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("abcdef", 3), "abc...");
    }

    const USER_MSG: &str = r#"{"parentUuid":"parent-1","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the login bug"}]},"uuid":"uuid-user-1","timestamp":"2026-02-24T10:00:00.000Z"}"#;

    const ASSISTANT_MSG_WITH_TOOL: &str = r#"{"parentUuid":"uuid-user-1","isSidechain":false,"type":"assistant","message":{"model":"claude-opus-4-6","id":"msg_001","type":"message","role":"assistant","content":[{"type":"text","text":"Let me read the file."},{"type":"tool_use","id":"toolu_abc","name":"Read","input":{"file_path":"/src/login.rs"}}],"usage":{"input_tokens":500,"output_tokens":100,"cache_read_input_tokens":50,"cache_creation_input_tokens":10}},"uuid":"uuid-asst-1","timestamp":"2026-02-24T10:00:05.000Z"}"#;

    const ASSISTANT_MSG_EDIT: &str = r#"{"parentUuid":"uuid-asst-1","isSidechain":false,"type":"assistant","message":{"model":"claude-opus-4-6","id":"msg_002","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_def","name":"Edit","input":{"file_path":"/src/login.rs","old_string":"bug","new_string":"fix"}}],"usage":{"input_tokens":600,"output_tokens":50}},"uuid":"uuid-asst-2","timestamp":"2026-02-24T10:00:10.000Z"}"#;

    const ASSISTANT_MSG_TASK: &str = r#"{"parentUuid":"uuid-user-1","isSidechain":false,"type":"assistant","message":{"model":"claude-opus-4-6","id":"msg_003","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_task1","name":"Task","input":{"description":"Search for auth code","prompt":"Find authentication","subagent_type":"Explore"}}],"usage":{"input_tokens":200,"output_tokens":30}},"uuid":"uuid-asst-3","timestamp":"2026-02-24T10:00:15.000Z"}"#;

    const FILE_HISTORY: &str = r#"{"type":"file-history-snapshot","messageId":"e2c301be","snapshot":{}}"#;

    const USER_MSG_TOOL_RESULT: &str = r#"{"parentUuid":"uuid-asst-3","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_task1","content":[{"type":"text","text":"Task finished"}]}]},"uuid":"uuid-user-2","timestamp":"2026-02-24T10:05:00.000Z"}"#;

    const USER_MSG_TOOL_RESULT_ERROR: &str = r#"{"parentUuid":"uuid-asst-1","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_abc","is_error":true,"content":"boom"}]},"uuid":"uuid-user-3","timestamp":"2026-02-24T10:06:00.000Z"}"#;

    #[test]
    fn test_parse_user_message() {
        let events = parse_transcript_line(1, USER_MSG);
        assert_eq!(events.len(), 1);
        match &events[0] {
            ClaudeEvent::UserMessage {
                session_id,
                uuid,
                text,
                timestamp,
            } => {
                assert_eq!(*session_id, 1);
                assert_eq!(uuid, "uuid-user-1");
                assert_eq!(text, "Fix the login bug");
                assert_eq!(timestamp, "2026-02-24T10:00:00.000Z");
            }
            other => panic!("Expected UserMessage, got {other:?}"),
        }
    }

    #[test]
    fn test_parse_assistant_with_tool() {
        let events = parse_transcript_line(2, ASSISTANT_MSG_WITH_TOOL);
        // Should produce: AssistantMessage + ToolUseStarted(Read) + TokenUsageUpdate
        assert!(
            events.len() >= 3,
            "Expected at least 3 events, got {}",
            events.len()
        );

        // First event is always the AssistantMessage.
        assert!(
            matches!(&events[0], ClaudeEvent::AssistantMessage { text, model, .. }
                if text == "Let me read the file." && model == "claude-opus-4-6"),
            "First event should be AssistantMessage, got {:?}",
            events[0]
        );

        // Find ToolUseStarted for Read.
        let tool_event = events.iter().find(|e| {
            matches!(e, ClaudeEvent::ToolUseStarted { tool_name, .. } if tool_name == "Read")
        });
        assert!(tool_event.is_some(), "Should have a ToolUseStarted(Read)");
        if let Some(ClaudeEvent::ToolUseStarted {
            tool_use_id,
            input_summary,
            ..
        }) = tool_event
        {
            assert_eq!(tool_use_id, "toolu_abc");
            assert_eq!(input_summary, "/src/login.rs");
        }

        // Find TokenUsageUpdate.
        let token_event = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::TokenUsageUpdate { .. }));
        assert!(token_event.is_some(), "Should have a TokenUsageUpdate");
        if let Some(ClaudeEvent::TokenUsageUpdate {
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            ..
        }) = token_event
        {
            assert_eq!(*input_tokens, 500);
            assert_eq!(*output_tokens, 100);
            assert_eq!(*cache_read_tokens, 50);
            assert_eq!(*cache_creation_tokens, 10);
        }
    }

    #[test]
    fn test_parse_file_edit() {
        let events = parse_transcript_line(3, ASSISTANT_MSG_EDIT);

        let edit_event = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::FileEdited { .. }));
        assert!(edit_event.is_some(), "Should have a FileEdited event");
        if let Some(ClaudeEvent::FileEdited {
            file_path, tool, ..
        }) = edit_event
        {
            assert_eq!(file_path, "/src/login.rs");
            assert_eq!(tool, "Edit");
        }
    }

    #[test]
    fn test_parse_subagent_spawn() {
        let events = parse_transcript_line(4, ASSISTANT_MSG_TASK);

        let spawn_event = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::SubagentSpawned { .. }));
        assert!(spawn_event.is_some(), "Should have a SubagentSpawned event");
        if let Some(ClaudeEvent::SubagentSpawned {
            agent_type,
            agent_id,
            description,
            ..
        }) = spawn_event
        {
            assert_eq!(agent_type, "Explore");
            assert_eq!(agent_id, "toolu_task1");
            assert_eq!(description, "Search for auth code");
        }
    }

    /// Issue #126: the Task input can name the model the orchestrator asked
    /// for; the spawn event carries it so the graph shows it from the start.
    #[test]
    fn test_parse_subagent_spawn_carries_requested_model() {
        let line = r#"{"parentUuid":"uuid-user-1","isSidechain":false,"type":"assistant","message":{"model":"claude-fable-5","id":"msg_005","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_task_m","name":"Task","input":{"description":"Review tests","prompt":"Review the suite","subagent_type":"Explore","model":"sonnet"}}],"usage":{"input_tokens":10,"output_tokens":5}},"uuid":"uuid-asst-5","timestamp":"2026-07-31T10:00:20.000Z"}"#;
        let events = parse_transcript_line(8, line);

        let spawn_event = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::SubagentSpawned { .. }));
        assert!(spawn_event.is_some(), "Should have a SubagentSpawned event");
        if let Some(ClaudeEvent::SubagentSpawned { model, .. }) = spawn_event {
            assert_eq!(model.as_deref(), Some("sonnet"));
        }
    }

    /// A spawn whose input names no model stays None — unknown, not "".
    #[test]
    fn test_parse_subagent_spawn_without_model_is_none() {
        let events = parse_transcript_line(4, ASSISTANT_MSG_TASK);
        let spawn_event = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::SubagentSpawned { .. }));
        assert!(spawn_event.is_some(), "Should have a SubagentSpawned event");
        if let Some(ClaudeEvent::SubagentSpawned { model, .. }) = spawn_event {
            assert!(model.is_none());
        }
    }

    /// Newer Claude Code versions renamed the subagent tool "Task" -> "Agent";
    /// both spellings must produce a SubagentSpawned event.
    #[test]
    fn test_parse_agent_tool_spawns_subagent() {
        let line = r#"{"parentUuid":"uuid-user-1","isSidechain":false,"type":"assistant","message":{"model":"claude-fable-5","id":"msg_004","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_agent1","name":"Agent","input":{"description":"Map feedback code","prompt":"Explore the repo","subagent_type":"general-purpose","run_in_background":true}}],"usage":{"input_tokens":200,"output_tokens":30}},"uuid":"uuid-asst-4","timestamp":"2026-07-31T10:00:15.000Z"}"#;
        let events = parse_transcript_line(7, line);

        let spawn_event = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::SubagentSpawned { .. }));
        assert!(spawn_event.is_some(), "Should have a SubagentSpawned event");
        if let Some(ClaudeEvent::SubagentSpawned {
            agent_type,
            agent_id,
            description,
            ..
        }) = spawn_event
        {
            assert_eq!(agent_type, "general-purpose");
            assert_eq!(agent_id, "toolu_agent1");
            assert_eq!(description, "Map feedback code");
        }
    }

    #[test]
    fn test_parse_tool_result_emits_completed() {
        let events = parse_transcript_line(4, USER_MSG_TOOL_RESULT);

        let completed = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::ToolUseCompleted { .. }));
        assert!(completed.is_some(), "Should have a ToolUseCompleted event");
        if let Some(ClaudeEvent::ToolUseCompleted {
            session_id,
            tool_use_id,
            success,
            ..
        }) = completed
        {
            assert_eq!(*session_id, 4);
            assert_eq!(tool_use_id, "toolu_task1");
            assert!(*success);
        }
    }

    #[test]
    fn test_parse_tool_result_error_marks_failure() {
        let events = parse_transcript_line(4, USER_MSG_TOOL_RESULT_ERROR);

        let completed = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::ToolUseCompleted { .. }));
        assert!(completed.is_some(), "Should have a ToolUseCompleted event");
        if let Some(ClaudeEvent::ToolUseCompleted { success, .. }) = completed {
            assert!(!*success, "is_error:true should map to success:false");
        }
    }

    #[test]
    fn test_plain_user_message_has_no_completed_event() {
        let events = parse_transcript_line(1, USER_MSG);
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, ClaudeEvent::ToolUseCompleted { .. })),
            "text-only user message must not emit ToolUseCompleted"
        );
    }

    #[test]
    fn test_skip_file_history_snapshot() {
        let events = parse_transcript_line(5, FILE_HISTORY);
        assert!(
            events.is_empty(),
            "file-history-snapshot should produce no events"
        );
    }

    #[test]
    fn test_skip_empty_line() {
        assert!(parse_transcript_line(6, "").is_empty());
        assert!(parse_transcript_line(6, "   ").is_empty());
    }

    #[test]
    fn test_skip_invalid_json() {
        assert!(parse_transcript_line(7, "not json at all!!!").is_empty());
        assert!(parse_transcript_line(7, "{bad json").is_empty());
    }

    #[test]
    fn test_truncate_long_input() {
        // Verify truncation adds "..." and respects max length.
        let short = "hello";
        assert_eq!(truncate(short, 10), "hello");

        let long = "a".repeat(200);
        let result = truncate(&long, 50);
        assert!(result.ends_with("..."));
        // The base portion is 50 chars, plus "..." = 53.
        assert_eq!(result.len(), 53);
        assert_eq!(&result[..50], &long[..50]);

        // Verify summarize_tool_input uses truncation for Bash commands.
        let long_cmd = "x".repeat(200);
        let input = serde_json::json!({ "command": long_cmd });
        let summary = summarize_tool_input("Bash", &input);
        assert!(summary.ends_with("..."));
        assert_eq!(summary.len(), 123); // 120 + "..."
    }

    // -----------------------------------------------------------------------
    // Sub-agent detail: the brief down, the report back, and the counters
    // -----------------------------------------------------------------------

    /// The brief is the whole point of the spawn event: keep it verbatim, and
    /// note whether this agent runs in the background (its result comes back
    /// immediately and means nothing about completion).
    #[test]
    fn test_spawn_carries_prompt_and_background_flag() {
        let line = r#"{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"tool_use","id":"toolu_a","name":"Agent","input":{"description":"Plan #64","prompt":"You are the PLAN agent.\nDo not write code.","subagent_type":"general-purpose","run_in_background":true}}]},"uuid":"a1","timestamp":"2026-08-03T10:00:00Z"}"#;
        let events = parse_transcript_line(1, line);

        let spawn = events
            .iter()
            .find_map(|e| match e {
                ClaudeEvent::SubagentSpawned {
                    prompt,
                    run_in_background,
                    ..
                } => Some((prompt, run_in_background)),
                _ => None,
            })
            .expect("SubagentSpawned");
        assert_eq!(spawn.0, "You are the PLAN agent.\nDo not write code.");
        assert!(*spawn.1, "run_in_background should be carried through");
    }

    /// A foreground agent's tool_result carries everything: the report it sent
    /// back plus the model, duration, tokens and per-tool counters.
    #[test]
    fn test_foreground_result_carries_report_and_counters() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_a","content":[{"type":"text","text":"agent-status: done"}]}]},"toolUseResult":{"status":"completed","agentId":"a4967701","agentType":"general-purpose","resolvedModel":"claude-fable-5","content":[{"type":"text","text":"agent-status: done"}],"totalDurationMs":1659000,"totalTokens":231047,"totalToolUseCount":57,"toolStats":{"readCount":10,"searchCount":3,"bashCount":0,"editFileCount":1,"linesAdded":137,"linesRemoved":0,"otherToolCount":4}},"uuid":"u1","timestamp":"2026-08-03T10:30:00Z"}"#;
        let events = parse_transcript_line(1, line);

        let done = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::SubagentCompleted { .. }))
            .expect("SubagentCompleted");
        if let ClaudeEvent::SubagentCompleted {
            agent_id,
            success,
            report,
            status,
            agent_type,
            model,
            duration_ms,
            total_tokens,
            tool_use_count,
            tool_stats,
            agent_run_id,
            ..
        } = done
        {
            assert_eq!(agent_id, "toolu_a");
            assert!(*success);
            assert_eq!(report, "agent-status: done");
            assert_eq!(status.as_deref(), Some("completed"));
            assert_eq!(agent_type.as_deref(), Some("general-purpose"));
            assert_eq!(model.as_deref(), Some("claude-fable-5"));
            assert_eq!(*duration_ms, Some(1_659_000));
            assert_eq!(*total_tokens, Some(231_047));
            assert_eq!(*tool_use_count, Some(57));
            assert_eq!(agent_run_id.as_deref(), Some("a4967701"));
            let stats = tool_stats.as_ref().expect("toolStats");
            assert_eq!(stats.read_count, 10);
            assert_eq!(stats.edit_file_count, 1);
            assert_eq!(stats.lines_added, 137);
            assert_eq!(stats.other_tool_count, 4);
        }
    }

    /// A background agent's result arrives at once with `async_launched`. It is
    /// a launch acknowledgement, not a completion — reporting it as DONE would
    /// mark every background agent finished the moment it started.
    #[test]
    fn test_async_launched_is_not_a_completion() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_b","content":"launched"}]},"toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"a11070c","description":"Summarize docs","resolvedModel":"claude-opus-4-8[1m]","prompt":"Read the docs"},"uuid":"u2","timestamp":"2026-08-03T10:00:05Z"}"#;
        let events = parse_transcript_line(1, line);

        assert!(
            !events
                .iter()
                .any(|e| matches!(e, ClaudeEvent::SubagentCompleted { .. })),
            "async_launched must not complete the agent: {events:?}"
        );
        let launched = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::SubagentLaunched { .. }))
            .expect("SubagentLaunched");
        if let ClaudeEvent::SubagentLaunched {
            agent_id,
            agent_run_id,
            model,
            ..
        } = launched
        {
            assert_eq!(agent_id, "toolu_b");
            assert_eq!(agent_run_id, "a11070c");
            assert_eq!(model, "claude-opus-4-8[1m]");
        }
    }

    /// The background agent's real outcome comes back later as a notification
    /// injected into the parent conversation, whose `<result>` is the report.
    #[test]
    fn test_task_notification_completes_a_background_agent() {
        let line = r#"{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>a11070c</task-id>\n<tool-use-id>toolu_b</tool-use-id>\n<status>completed</status>\n<summary>Agent \"Summarize docs\" finished</summary>\n<result>Here is the context you asked for.\nSecond line.</result>\n</task-notification>"},"uuid":"u3","timestamp":"2026-08-03T10:09:18Z"}"#;
        let events = parse_transcript_line(1, line);

        let done = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::SubagentCompleted { .. }))
            .expect("SubagentCompleted from the notification");
        if let ClaudeEvent::SubagentCompleted {
            agent_id,
            success,
            report,
            status,
            agent_run_id,
            ..
        } = done
        {
            assert_eq!(agent_id, "toolu_b", "keyed on the tool-use-id, not task-id");
            assert!(*success);
            assert_eq!(report, "Here is the context you asked for.\nSecond line.");
            assert_eq!(status.as_deref(), Some("completed"));
            assert_eq!(agent_run_id.as_deref(), Some("a11070c"));
        }

        // The notification body is also the user message text, so string-shaped
        // content must not be dropped on the floor.
        assert!(events.iter().any(|e| matches!(
            e,
            ClaudeEvent::UserMessage { text, .. } if text.contains("<task-notification>")
        )));
    }

    /// Background Bash commands, workflows and monitors send task
    /// notifications too, in the same blob format. Completions now reach the
    /// store without a matching spawn, so a non-agent notification must not
    /// become a phantom agent on the graph.
    #[test]
    fn test_non_agent_task_notification_is_not_a_subagent_completion() {
        let bash = r#"{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>b9wqvjtm1</task-id>\n<tool-use-id>toolu_bash1</tool-use-id>\n<status>killed</status>\n<summary>Background command \"heartbeat watch\" was stopped</summary>\n</task-notification>"},"uuid":"u1","timestamp":"2026-08-07T10:00:00Z"}"#;
        let workflow = r#"{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>wbjmf2mzu</task-id>\n<tool-use-id>toolu_wf1</tool-use-id>\n<status>completed</status>\n<summary>Dynamic workflow \"perf audit\" completed</summary>\n<result>{}</result>\n</task-notification>"},"uuid":"u2","timestamp":"2026-08-07T10:01:00Z"}"#;
        for line in [bash, workflow] {
            let events = parse_transcript_line(1, line);
            assert!(
                !events
                    .iter()
                    .any(|e| matches!(e, ClaudeEvent::SubagentCompleted { .. })),
                "only an agent's notification may complete an agent: {events:?}"
            );
            // The notification text itself still surfaces as the user message.
            assert!(events
                .iter()
                .any(|e| matches!(e, ClaudeEvent::UserMessage { .. })));
        }
    }

    /// An agent's notification carries a summary starting `Agent "…"` — it
    /// must keep completing the agent now that non-agent summaries are
    /// filtered out.
    #[test]
    fn test_agent_task_notification_with_summary_still_completes() {
        let line = r#"{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>a6cd66348</task-id>\n<tool-use-id>toolu_agent1</tool-use-id>\n<status>failed</status>\n<summary>Agent \"fix-review-findings\" failed: API error</summary>\n</task-notification>"},"uuid":"u1","timestamp":"2026-08-07T10:00:00Z"}"#;
        let events = parse_transcript_line(1, line);
        let done = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::SubagentCompleted { .. }))
            .expect("SubagentCompleted from the agent notification");
        if let ClaudeEvent::SubagentCompleted {
            agent_id, success, ..
        } = done
        {
            assert_eq!(agent_id, "toolu_agent1");
            assert!(!*success, "status 'failed' must not read as success");
        }
    }

    /// Ordinary tools also write a `toolUseResult`; none of them is a sub-agent.
    #[test]
    fn test_ordinary_tool_result_emits_no_subagent_event() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_read","content":"file body"}]},"toolUseResult":{"type":"text","file":{"filePath":"/src/a.rs","numLines":10}},"uuid":"u4","timestamp":"2026-08-03T10:00:00Z"}"#;
        let events = parse_transcript_line(1, line);

        assert!(
            !events.iter().any(|e| matches!(
                e,
                ClaudeEvent::SubagentCompleted { .. } | ClaudeEvent::SubagentLaunched { .. }
            )),
            "a Read result must not look like a sub-agent: {events:?}"
        );
        assert!(events
            .iter()
            .any(|e| matches!(e, ClaudeEvent::ToolUseCompleted { .. })));
    }

    // -----------------------------------------------------------------------
    // Context-window usage derivation (issue #41)
    // -----------------------------------------------------------------------

    /// Fixture modeled on a real assistant entry from a transcript on this
    /// machine (`~/.claude/projects/.../*.jsonl`, content redacted): same field
    /// set, same usage shape. Context = 2 + 613 + 100016 = 100631 tokens.
    const REAL_ASSISTANT_USAGE: &str = r#"{"parentUuid":"6d6b29ba-8a39-4082-b9a3-fc6422106b44","isSidechain":false,"message":{"model":"claude-fable-5","id":"msg_011CdkdFLsWwr9VRntznX2TJ","type":"message","role":"assistant","content":[{"type":"text","text":"Working on it."}],"stop_reason":"tool_use","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":613,"cache_read_input_tokens":100016,"output_tokens":2528,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":613,"ephemeral_5m_input_tokens":0},"speed":"standard"}},"requestId":"req_011CdkdFCCsNAMS84bPS37ff","type":"assistant","uuid":"565c9e58-3d2e-41fa-980f-709cb4687e13","timestamp":"2026-08-06T01:27:52.399Z","effort":"xhigh","userType":"external","entrypoint":"cli","cwd":"C:\\git\\maestro","sessionId":"01665762-7015-403c-826d-4dbfefa02070","version":"2.1.222","gitBranch":"main"}"#;

    /// The headline derivation: latest assistant message's input + cache_read
    /// + cache_creation over the model's window, as a percentage.
    #[test]
    fn test_context_usage_derived_from_real_transcript_shape() {
        let events = parse_transcript_line(9, REAL_ASSISTANT_USAGE);

        let ctx = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::ContextUsageUpdate { .. }))
            .expect("ContextUsageUpdate");
        if let ClaudeEvent::ContextUsageUpdate {
            session_id,
            model,
            context_tokens,
            context_window,
            percent,
            timestamp,
        } = ctx
        {
            assert_eq!(*session_id, 9);
            assert_eq!(model, "claude-fable-5");
            assert_eq!(*context_tokens, 100_631, "input + cache_read + cache_creation");
            assert_eq!(*context_window, 1_000_000, "fable-5 runs a 1M window");
            assert_eq!(*percent, 10.1, "100631 / 1M, rounded to one decimal");
            assert_eq!(timestamp, "2026-08-06T01:27:52.399Z");
        }
    }

    /// An API-error entry (`"<synthetic>"` + an all-zero usage block, the shape
    /// Claude Code writes on a 429 / spend limit) must NOT emit a 0% context
    /// reading — that would wipe the session's real percentage downstream and
    /// disarm the handoff trigger. Its token counters still flow.
    #[test]
    fn test_synthetic_api_error_usage_emits_no_context_update() {
        let line = r#"{"type":"assistant","isApiErrorMessage":true,"message":{"model":"<synthetic>","content":[{"type":"text","text":"API Error: 429"}],"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}},"uuid":"a-synthetic","timestamp":"2026-08-07T10:00:00Z"}"#;
        let events = parse_transcript_line(3, line);

        assert!(
            !events
                .iter()
                .any(|e| matches!(e, ClaudeEvent::ContextUsageUpdate { .. })),
            "an all-zero usage block must not reset the session's context: {events:?}"
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, ClaudeEvent::TokenUsageUpdate { .. })),
            "token counters still flow: {events:?}"
        );
    }

    /// Window resolution: the `[1m]` marker and every natively-1M model map to
    /// 1M; everything else (including unknown models) defaults to 200k. The 1M
    /// set mirrors `context.native_1m` in Claude Code's model catalog.
    #[test]
    fn test_context_window_resolution() {
        assert_eq!(context_window_for_model("claude-sonnet-4-6[1m]"), 1_000_000);
        assert_eq!(context_window_for_model("claude-sonnet-4-5[1m]"), 1_000_000);
        assert_eq!(context_window_for_model("claude-fable-5"), 1_000_000);
        assert_eq!(context_window_for_model("claude-mythos-5"), 1_000_000);
        assert_eq!(context_window_for_model("claude-opus-5"), 1_000_000);
        // Natively 1M without a [1m] marker — dividing these by 200k reported
        // >100% on real sessions (bare claude-sonnet-5 read 238.8%).
        assert_eq!(context_window_for_model("claude-sonnet-5"), 1_000_000);
        assert_eq!(context_window_for_model("claude-opus-4-8"), 1_000_000);
        assert_eq!(context_window_for_model("claude-opus-4-7"), 1_000_000);
        // Still 200k: opus 4.6 and older, every Sonnet before 5, every Haiku.
        assert_eq!(context_window_for_model("claude-opus-4-6"), 200_000);
        assert_eq!(context_window_for_model("claude-opus-4-5"), 200_000);
        assert_eq!(context_window_for_model("claude-sonnet-4-6"), 200_000);
        assert_eq!(context_window_for_model("claude-haiku-4-5"), 200_000);
        assert_eq!(context_window_for_model("claude-haiku-4-5-20251001"), 200_000);
        assert_eq!(context_window_for_model("claude-sonnet-4-5"), 200_000);
        assert_eq!(context_window_for_model(""), 200_000);
        assert_eq!(context_window_for_model("<synthetic>"), 200_000);
    }

    /// Regression for the badge/handoff mismatch: a real `claude-sonnet-5`
    /// line whose prompt exceeds 200k must report ~48%, not an impossible
    /// 238.8%. Token counts are the ones observed in a live transcript on this
    /// machine; Claude Code's `/context` shows 48% for the same message.
    #[test]
    fn test_context_usage_native_1m_sonnet_5() {
        let line = r#"{"type":"assistant","message":{"model":"claude-sonnet-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":4,"cache_creation_input_tokens":1658,"cache_read_input_tokens":476000,"output_tokens":1452}},"uuid":"a-s5","timestamp":"2026-08-14T10:00:00Z"}"#;
        let events = parse_transcript_line(7, line);

        let ctx = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::ContextUsageUpdate { .. }))
            .expect("ContextUsageUpdate");
        if let ClaudeEvent::ContextUsageUpdate {
            context_tokens,
            context_window,
            percent,
            ..
        } = ctx
        {
            assert_eq!(*context_tokens, 477_662, "output_tokens stays excluded");
            assert_eq!(*context_window, 1_000_000, "sonnet-5 runs a 1M window");
            assert_eq!(*percent, 47.8, "477662 / 1M; the old table said 238.8");
        }
    }

    /// A 200k-window model uses the default divisor.
    #[test]
    fn test_context_usage_default_window() {
        // ASSISTANT_MSG_WITH_TOOL: claude-opus-4-6, usage 500 + 50 + 10 = 560.
        let events = parse_transcript_line(2, ASSISTANT_MSG_WITH_TOOL);

        let ctx = events
            .iter()
            .find(|e| matches!(e, ClaudeEvent::ContextUsageUpdate { .. }))
            .expect("ContextUsageUpdate");
        if let ClaudeEvent::ContextUsageUpdate {
            context_tokens,
            context_window,
            percent,
            ..
        } = ctx
        {
            assert_eq!(*context_tokens, 560);
            assert_eq!(*context_window, 200_000);
            assert_eq!(*percent, 0.3, "560 / 200k = 0.28%, rounded to 0.3");
        }
    }

    /// No usage data means no context event — nothing to derive from.
    #[test]
    fn test_no_context_usage_without_usage_data() {
        let line = r#"{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"text","text":"hi"}]},"uuid":"a-nousage","timestamp":"2026-08-06T10:00:00Z"}"#;
        let events = parse_transcript_line(1, line);
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, ClaudeEvent::ContextUsageUpdate { .. })),
            "no usage means no ContextUsageUpdate: {events:?}"
        );
    }

    /// A result with no metadata at all keeps working the old way: the watcher
    /// still turns it into a bare completion via the pending-id fallback.
    #[test]
    fn test_result_without_metadata_leaves_completion_to_the_watcher() {
        let events = parse_transcript_line(1, USER_MSG_TOOL_RESULT);
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, ClaudeEvent::SubagentCompleted { .. })),
            "no metadata means the parser cannot know it was an agent"
        );
        assert!(events.iter().any(|e| matches!(
            e,
            ClaudeEvent::ToolUseCompleted { tool_use_id, .. } if tool_use_id == "toolu_task1"
        )));
    }
}
