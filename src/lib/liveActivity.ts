import type { ClaudeEvent } from "@/types/claude-events";

/**
 * The "what is this agent doing RIGHT NOW" summary for one top-level session
 * (issue #94), derived from the transcript events the watcher already puts on
 * the bus: the latest tool call (`ToolUseStarted`) and the latest non-empty
 * assistant message (`AssistantMessage`).
 *
 * Only top-level sessions have this — a subagent's internal activity never
 * reaches the bus (no sidechain entries in the transcripts), which is why the
 * eye/popover lives on session nodes and subagent nodes keep their
 * brief/report drawer.
 */

export interface LiveToolCall {
  name: string;
  /** The parser's bounded input summary (file path, command, pattern…). */
  summary: string;
  timestamp: string;
}

export interface LiveMessage {
  /** Bounded to {@link SNIPPET_MAX_CHARS} code points. */
  snippet: string;
  timestamp: string;
}

export interface LiveActivity {
  lastTool: LiveToolCall | null;
  /**
   * The latest tool calls, oldest first (the last entry IS `lastTool`), capped
   * at {@link RECENT_TOOLS_MAX}. Gives the popover the shape of the current
   * turn instead of a single truncated fragment (issue #127).
   */
  recentTools: LiveToolCall[];
  lastMessage: LiveMessage | null;
  /** The later of the two timestamps — when the summary last moved. */
  updatedAt: string;
}

/** Upper bound on the assistant-message snippet, in Unicode code points. */
export const SNIPPET_MAX_CHARS = 200;

/** How many of the latest tool calls the live summary keeps (issue #127). */
export const RECENT_TOOLS_MAX = 3;

/**
 * Trim and bound `text` to {@link SNIPPET_MAX_CHARS} code points, appending an
 * ellipsis when cut. Sliced via `Array.from` (code points, not UTF-16 units)
 * so a surrogate pair — an emoji, a CJK extension char — is never split.
 */
export function boundSnippet(text: string): string {
  const points = Array.from(text.trim());
  if (points.length <= SNIPPET_MAX_CHARS) return points.join("");
  return `${points.slice(0, SNIPPET_MAX_CHARS).join("")}…`;
}

/**
 * Walk a session's event feed backwards and pick out the latest tool call and
 * the latest assistant text. Returns null when the feed holds neither (fresh
 * session, or a feed of pure lifecycle events).
 *
 * Assistant messages whose text is empty (tool-use-only turns) are skipped —
 * they would blank the snippet on every tool call.
 */
export function deriveLiveActivity(events: readonly ClaudeEvent[]): LiveActivity | null {
  // Collected newest-first while walking backwards, reversed on return.
  const toolsNewestFirst: LiveToolCall[] = [];
  let lastMessage: LiveMessage | null = null;

  for (
    let i = events.length - 1;
    i >= 0 && (toolsNewestFirst.length < RECENT_TOOLS_MAX || !lastMessage);
    i--
  ) {
    const event = events[i];
    if (toolsNewestFirst.length < RECENT_TOOLS_MAX && event.event_type === "ToolUseStarted") {
      toolsNewestFirst.push({
        name: event.tool_name,
        summary: event.input_summary,
        timestamp: event.timestamp,
      });
    } else if (
      !lastMessage &&
      event.event_type === "AssistantMessage" &&
      event.text.trim() !== ""
    ) {
      lastMessage = { snippet: boundSnippet(event.text), timestamp: event.timestamp };
    }
  }

  const recentTools = toolsNewestFirst.reverse();
  const lastTool = recentTools[recentTools.length - 1] ?? null;
  if (!lastTool && !lastMessage) return null;
  // Transcript timestamps are ISO-8601 UTC, so lexicographic order is time order.
  const stamps = [lastTool?.timestamp, lastMessage?.timestamp].filter(
    (t): t is string => t !== undefined,
  );
  return { lastTool, recentTools, lastMessage, updatedAt: stamps.sort()[stamps.length - 1] };
}

/**
 * The model the session itself runs on (issue #126): the model named by the
 * latest assistant message. Entries with no model or the watcher's
 * "<synthetic>" placeholder (API-error entries) are skipped. Null until the
 * session has produced an assistant message.
 */
export function deriveSessionModel(events: readonly ClaudeEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (
      event.event_type === "AssistantMessage" &&
      event.model !== "" &&
      event.model !== "<synthetic>"
    ) {
      return event.model;
    }
  }
  return null;
}
