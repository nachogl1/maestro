import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import type { ClaudeEvent } from "@/types/claude-events";
import { useAgentStore } from "../useAgentStore";

function spawned(
  sessionId: number,
  agentId: string,
  overrides?: Partial<Extract<ClaudeEvent, { event_type: "SubagentSpawned" }>>,
): ClaudeEvent {
  return {
    event_type: "SubagentSpawned",
    session_id: sessionId,
    agent_type: "Explore",
    agent_id: agentId,
    description: "search for auth code",
    prompt: "Find every call site of authenticate()",
    run_in_background: false,
    parent_agent_id: null,
    timestamp: "2026-07-13T10:00:00.000Z",
    ...overrides,
  };
}

function completed(
  sessionId: number,
  agentId: string,
  success = true,
  overrides?: Partial<Extract<ClaudeEvent, { event_type: "SubagentCompleted" }>>,
): ClaudeEvent {
  return {
    event_type: "SubagentCompleted",
    session_id: sessionId,
    agent_id: agentId,
    success,
    report: "",
    status: null,
    agent_type: null,
    model: null,
    duration_ms: null,
    total_tokens: null,
    tool_use_count: null,
    tool_stats: null,
    agent_run_id: null,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("useAgentStore", () => {
  beforeEach(() => {
    useAgentStore.setState({ agents: [] });
  });

  it("SubagentSpawned adds a running agent carrying its brief", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    const agents = useAgentStore.getState().agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      agentId: "toolu_a",
      sessionId: 1,
      agentType: "Explore",
      prompt: "Find every call site of authenticate()",
      runInBackground: false,
      completedAt: null,
      success: null,
      report: "",
    });
  });

  // Issue #126: the spawn input can name the model the orchestrator asked for
  // (e.g. "sonnet"); it must show on the node from the moment it appears, and
  // the launch acknowledgement's RESOLVED model must replace it.
  it("SubagentSpawned carries the requested model; SubagentLaunched resolves it", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_m", { model: "sonnet" }));
    expect(useAgentStore.getState().agents[0].model).toBe("sonnet");

    useAgentStore.getState().handleEvent({
      event_type: "SubagentLaunched",
      session_id: 1,
      agent_id: "toolu_m",
      agent_run_id: "a1",
      model: "claude-sonnet-5",
      timestamp: "2026-07-13T10:00:05.000Z",
    });
    expect(useAgentStore.getState().agents[0].model).toBe("claude-sonnet-5");
  });

  it("a spawn without a model leaves it null (unknown, not empty string)", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_n"));
    expect(useAgentStore.getState().agents[0].model).toBeNull();
  });

  // A nested agent's spawn (read from the subagents folder) names the agent
  // that spawned it, which is what the graphs hang the tree on.
  it("SubagentSpawned keeps the parent agent id", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_parent"));
    useAgentStore
      .getState()
      .handleEvent(spawned(1, "toolu_child", { parent_agent_id: "toolu_parent" }));
    const agents = useAgentStore.getState().agents;
    expect(agents.find((a) => a.agentId === "toolu_parent")?.parentAgentId).toBeNull();
    expect(agents.find((a) => a.agentId === "toolu_child")?.parentAgentId).toBe("toolu_parent");
  });

  it("duplicate SubagentSpawned is ignored", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    expect(useAgentStore.getState().agents).toHaveLength(1);
  });

  it("SubagentCompleted marks the agent done with the event's success flag", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    useAgentStore.getState().handleEvent(completed(1, "toolu_a", false));
    const agent = useAgentStore.getState().agents[0];
    expect(agent.completedAt).not.toBeNull();
    expect(agent.success).toBe(false);
  });

  it("SubagentCompleted stores the report and every counter it carries", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a", { agent_type: "unknown" }));
    useAgentStore.getState().handleEvent(
      completed(1, "toolu_a", true, {
        report: "agent-status: done",
        status: "completed",
        agent_type: "general-purpose",
        model: "claude-fable-5",
        duration_ms: 1_659_000,
        total_tokens: 231_047,
        tool_use_count: 57,
        tool_stats: {
          read_count: 10,
          search_count: 3,
          bash_count: 0,
          edit_file_count: 1,
          lines_added: 137,
          lines_removed: 0,
          other_tool_count: 4,
        },
        agent_run_id: "a4967701",
      }),
    );
    expect(useAgentStore.getState().agents[0]).toMatchObject({
      report: "agent-status: done",
      status: "completed",
      // The spawn named no real type; the result resolves it.
      agentType: "general-purpose",
      model: "claude-fable-5",
      durationMs: 1_659_000,
      totalTokens: 231_047,
      toolUseCount: 57,
      agentRunId: "a4967701",
    });
    expect(useAgentStore.getState().agents[0].toolStats?.lines_added).toBe(137);
  });

  // Real transcripts often launch an agent asynchronously without the spawn
  // saying run_in_background, so the launch ack is what identifies it.
  it("SubagentLaunched enriches a still-running agent and marks it background", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_bg", { run_in_background: false }));
    useAgentStore.getState().handleEvent({
      event_type: "SubagentLaunched",
      session_id: 1,
      agent_id: "toolu_bg",
      agent_run_id: "a11070c",
      model: "claude-opus-4-8[1m]",
      timestamp: "2026-07-13T10:00:05.000Z",
    });
    const agent = useAgentStore.getState().agents[0];
    expect(agent.completedAt).toBeNull();
    expect(agent.runInBackground).toBe(true);
    expect(agent.model).toBe("claude-opus-4-8[1m]");
    expect(agent.agentRunId).toBe("a11070c");
  });

  it("completedAt comes from the event timestamp, not the wall clock", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    const oldTs = "2026-07-01T00:00:00.000Z";
    useAgentStore.getState().handleEvent(completed(1, "toolu_a", true, { timestamp: oldTs }));
    expect(useAgentStore.getState().agents[0].completedAt).toBe(Date.parse(oldTs));
  });

  // The watcher can attach after a spawn scrolled by (the spawn lives in a
  // transcript file it never read); the completion alone must still show the
  // agent instead of losing the run forever.
  it("an orphan SubagentCompleted synthesizes a minimal finished agent", () => {
    useAgentStore.getState().handleEvent(
      completed(3, "toolu_orphan", true, {
        report: "late report",
        status: "completed",
        agent_type: "general-purpose",
        model: "claude-fable-5",
        timestamp: "2026-08-07T10:00:00.000Z",
      }),
    );
    const agents = useAgentStore.getState().agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      agentId: "toolu_orphan",
      sessionId: 3,
      agentType: "general-purpose",
      prompt: "",
      description: "",
      report: "late report",
      success: true,
      model: "claude-fable-5",
      completedAt: Date.parse("2026-08-07T10:00:00.000Z"),
    });
  });

  it("a repeat completion updates a synthesized orphan in place", () => {
    useAgentStore.getState().handleEvent(completed(3, "toolu_orphan", true, { report: "first" }));
    useAgentStore.getState().handleEvent(completed(3, "toolu_orphan", true, { report: "second" }));
    const agents = useAgentStore.getState().agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].report).toBe("second");
  });

  it("a bare re-completion does not clobber a completed agent", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    useAgentStore
      .getState()
      .handleEvent(completed(1, "toolu_a", false, { report: "failed early" }));
    const completedAt = useAgentStore.getState().agents[0].completedAt;
    useAgentStore.getState().handleEvent(completed(1, "toolu_a", true));
    expect(useAgentStore.getState().agents[0].success).toBe(false);
    expect(useAgentStore.getState().agents[0].report).toBe("failed early");
    expect(useAgentStore.getState().agents[0].completedAt).toBe(completedAt);
  });

  // A background agent can be resumed and notify again under the same id, and
  // the newest notification is the one worth reading.
  it("a later completion carrying a report does update a finished agent", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_bg", { run_in_background: true }));
    useAgentStore.getState().handleEvent(completed(1, "toolu_bg", true, { report: "first pass" }));
    useAgentStore.getState().handleEvent(completed(1, "toolu_bg", true, { report: "second pass" }));
    expect(useAgentStore.getState().agents[0].report).toBe("second pass");
  });

  it("finished agents are kept indefinitely — nothing expires them", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    useAgentStore.getState().handleEvent(
      // A completion from months ago, as a resumed session replays.
      completed(1, "toolu_a", true, { timestamp: "2026-01-01T00:00:00.000Z" }),
    );
    expect(useAgentStore.getState().agents).toHaveLength(1);
    expect(useAgentStore.getState().agents[0].completedAt).not.toBeNull();
  });

  it("agents of a dead session are kept, so a killed run can still be read", () => {
    useAgentStore.getState().handleEvent(spawned(99, "toolu_orphan"));
    useAgentStore.getState().handleEvent(completed(99, "toolu_orphan", true));
    expect(useAgentStore.getState().agents.map((a) => a.agentId)).toEqual(["toolu_orphan"]);
  });

  it("dismiss removes exactly one agent", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    useAgentStore.getState().handleEvent(spawned(1, "toolu_b"));
    useAgentStore.getState().dismiss(1, "toolu_a");
    expect(useAgentStore.getState().agents.map((a) => a.agentId)).toEqual(["toolu_b"]);
  });

  it("dismiss keeps the same tool_use id belonging to another session", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    useAgentStore.getState().handleEvent(spawned(2, "toolu_a"));
    useAgentStore.getState().dismiss(1, "toolu_a");
    expect(useAgentStore.getState().agents.map((a) => a.sessionId)).toEqual([2]);
  });

  it("dismiss of an unknown id leaves the state untouched", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_a"));
    const before = useAgentStore.getState().agents;
    useAgentStore.getState().dismiss(1, "nope");
    expect(useAgentStore.getState().agents).toBe(before);
  });

  it("clearFinished drops the finished agents of one session only", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_done"));
    useAgentStore.getState().handleEvent(spawned(1, "toolu_running"));
    useAgentStore.getState().handleEvent(spawned(2, "toolu_other_done"));
    useAgentStore.getState().handleEvent(completed(1, "toolu_done", true));
    useAgentStore.getState().handleEvent(completed(2, "toolu_other_done", true));

    useAgentStore.getState().clearFinished(1);

    expect(useAgentStore.getState().agents.map((a) => a.agentId)).toEqual([
      "toolu_running",
      "toolu_other_done",
    ]);
  });

  it("clearFinishedAndDead drops finished agents everywhere plus dead ones", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_running"));
    useAgentStore.getState().handleEvent(spawned(1, "toolu_done"));
    // Session 2 is not live — its still-"running" agent is dead.
    useAgentStore.getState().handleEvent(spawned(2, "toolu_dead"));
    useAgentStore.getState().handleEvent(completed(1, "toolu_done", true));

    useAgentStore.getState().clearFinishedAndDead(new Set([1]));

    expect(useAgentStore.getState().agents.map((a) => a.agentId)).toEqual(["toolu_running"]);
  });

  it("clearFinishedAndDead with nothing to clear leaves the state untouched", () => {
    useAgentStore.getState().handleEvent(spawned(1, "toolu_running"));
    const before = useAgentStore.getState().agents;
    useAgentStore.getState().clearFinishedAndDead(new Set([1]));
    expect(useAgentStore.getState().agents).toBe(before);
  });
});
