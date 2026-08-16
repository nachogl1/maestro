import { describe, expect, it } from "vitest";
import {
  boundSnippet,
  deriveLiveActivity,
  RECENT_TOOLS_MAX,
  SNIPPET_MAX_CHARS,
} from "@/lib/liveActivity";
import type { ClaudeEvent } from "@/types/claude-events";

function toolUse(id: string, name: string, summary: string, timestamp: string): ClaudeEvent {
  return {
    event_type: "ToolUseStarted",
    session_id: 1,
    tool_name: name,
    tool_use_id: id,
    input_summary: summary,
    timestamp,
  };
}

function assistant(uuid: string, text: string, timestamp: string): ClaudeEvent {
  return {
    event_type: "AssistantMessage",
    session_id: 1,
    uuid,
    text,
    model: "claude-fable-5",
    token_usage: null,
    timestamp,
  };
}

describe("deriveLiveActivity", () => {
  it("returns null when the feed holds no tool call and no assistant text", () => {
    expect(deriveLiveActivity([])).toBeNull();
    expect(
      deriveLiveActivity([
        {
          event_type: "UserMessage",
          session_id: 1,
          uuid: "u1",
          text: "hi",
          timestamp: "2026-08-13T10:00:00Z",
        },
      ]),
    ).toBeNull();
  });

  it("picks the LATEST tool call and the LATEST non-empty assistant text", () => {
    const activity = deriveLiveActivity([
      assistant("a1", "Reading the config first.", "2026-08-13T10:00:00Z"),
      toolUse("t1", "Read", "/src/config.rs", "2026-08-13T10:00:01Z"),
      assistant("a2", "Now running the tests.", "2026-08-13T10:00:02Z"),
      toolUse("t2", "Bash", "cargo test --workspace", "2026-08-13T10:00:03Z"),
    ]);
    expect(activity).not.toBeNull();
    expect(activity?.lastTool).toEqual({
      name: "Bash",
      summary: "cargo test --workspace",
      timestamp: "2026-08-13T10:00:03Z",
    });
    expect(activity?.lastMessage?.snippet).toBe("Now running the tests.");
    expect(activity?.updatedAt).toBe("2026-08-13T10:00:03Z");
  });

  it("skips empty assistant texts (tool-use-only turns) instead of blanking the snippet", () => {
    const activity = deriveLiveActivity([
      assistant("a1", "Let me check the file.", "2026-08-13T10:00:00Z"),
      assistant("a2", "", "2026-08-13T10:00:01Z"),
      assistant("a3", "   \n ", "2026-08-13T10:00:02Z"),
    ]);
    expect(activity?.lastMessage?.snippet).toBe("Let me check the file.");
  });

  it("works with only one of the two halves present", () => {
    const toolOnly = deriveLiveActivity([toolUse("t1", "Grep", "TODO", "2026-08-13T10:00:00Z")]);
    expect(toolOnly?.lastTool?.name).toBe("Grep");
    expect(toolOnly?.lastMessage).toBeNull();
    expect(toolOnly?.updatedAt).toBe("2026-08-13T10:00:00Z");

    const messageOnly = deriveLiveActivity([assistant("a1", "Thinking…", "2026-08-13T10:00:05Z")]);
    expect(messageOnly?.lastTool).toBeNull();
    expect(messageOnly?.updatedAt).toBe("2026-08-13T10:00:05Z");
  });

  it("updatedAt is the later of the two timestamps when the message follows the tool", () => {
    const activity = deriveLiveActivity([
      toolUse("t1", "Read", "/a.rs", "2026-08-13T10:00:00Z"),
      assistant("a1", "Done reading.", "2026-08-13T10:00:09Z"),
    ]);
    expect(activity?.updatedAt).toBe("2026-08-13T10:00:09Z");
  });
});

describe("recentTools (issue #127: activity detail too shallow)", () => {
  it("collects the latest tool calls oldest-first so the popover can show the whole turn", () => {
    const activity = deriveLiveActivity([
      toolUse("t1", "Read", "/src/config.rs", "2026-08-13T10:00:01Z"),
      toolUse("t2", "Grep", "TODO in src", "2026-08-13T10:00:02Z"),
      toolUse("t3", "Bash", "cargo test --workspace", "2026-08-13T10:00:03Z"),
    ]);
    expect(activity?.recentTools.map((t) => t.name)).toEqual(["Read", "Grep", "Bash"]);
    // The newest of them is still the headline tool.
    expect(activity?.lastTool?.name).toBe("Bash");
  });

  it(`caps the list at ${RECENT_TOOLS_MAX} keeping the newest calls`, () => {
    const events = Array.from({ length: RECENT_TOOLS_MAX + 2 }, (_, i) =>
      toolUse(`t${i}`, `Tool${i}`, `target ${i}`, `2026-08-13T10:00:0${i}Z`),
    );
    const activity = deriveLiveActivity(events);
    expect(activity?.recentTools).toHaveLength(RECENT_TOOLS_MAX);
    expect(activity?.recentTools.at(-1)?.name).toBe(`Tool${RECENT_TOOLS_MAX + 1}`);
    expect(activity?.recentTools[0]?.name).toBe("Tool2");
  });

  it("is empty when the feed holds assistant text only", () => {
    const activity = deriveLiveActivity([assistant("a1", "Thinking…", "2026-08-13T10:00:00Z")]);
    expect(activity?.recentTools).toEqual([]);
  });
});

describe("boundSnippet", () => {
  it("returns short text trimmed but uncut, without an ellipsis", () => {
    expect(boundSnippet("  hello world \n")).toBe("hello world");
  });

  it("bounds long text to the cap in code points and appends an ellipsis", () => {
    const long = "x".repeat(SNIPPET_MAX_CHARS + 50);
    const out = boundSnippet(long);
    expect(Array.from(out)).toHaveLength(SNIPPET_MAX_CHARS + 1); // +1 for "…"
    expect(out.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair (multibyte safety)", () => {
    // Each emoji is one code point but two UTF-16 units; a .slice() by UTF-16
    // index would cut one in half.
    const long = "😀".repeat(SNIPPET_MAX_CHARS + 50);
    const out = boundSnippet(long);
    const points = Array.from(out);
    expect(points).toHaveLength(SNIPPET_MAX_CHARS + 1);
    expect(points.slice(0, -1).every((p) => p === "😀")).toBe(true);
    expect(points.at(-1)).toBe("…");
  });
});
