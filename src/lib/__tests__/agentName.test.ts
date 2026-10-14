import { describe, expect, it } from "vitest";
import {
  agentTitleUpdates,
  defaultAgentName,
  isValidAgentName,
  sanitizeAgentName,
} from "@/lib/agentName";

describe("sanitizeAgentName", () => {
  it("turns free text into a terminal-safe agent name", () => {
    expect(sanitizeAgentName("  harvest triage ")).toBe("harvest-triage");
    expect(sanitizeAgentName("PR #42: review")).toBe("PR-42-review");
    expect(sanitizeAgentName("--x--")).toBe("x");
  });

  it("returns null when nothing usable is left", () => {
    expect(sanitizeAgentName("   ")).toBeNull();
    expect(sanitizeAgentName("#!?")).toBeNull();
  });

  it("caps the length", () => {
    const name = sanitizeAgentName("a".repeat(100));
    expect(name).toHaveLength(64);
    expect(isValidAgentName(name ?? "")).toBe(true);
  });
});

describe("defaultAgentName", () => {
  it("names the agent after the folder with a two-digit suffix", () => {
    expect(defaultAgentName("C:\\git\\maestro", new Set(), () => 0)).toBe("maestro-10");
    expect(defaultAgentName("/home/me/my app/", new Set(), () => 0.999)).toBe("my-app-99");
  });

  it("skips names a live agent already uses", () => {
    const rolls = [0, 0, 0.5];
    const next = () => rolls.shift() ?? 0.5;
    expect(defaultAgentName("/x/maestro", new Set(["maestro-10"]), next)).toBe("maestro-55");
  });

  it("falls back to 'agent' when the folder has no usable characters", () => {
    expect(defaultAgentName("/###", new Set(), () => 0)).toBe("agent-10");
  });
});

describe("agentTitleUpdates", () => {
  const live = [{ session_id: "conv-1", name: "maestro-42" }];

  it("renames a title that differs from the live agent name", () => {
    const lastSeen = new Map<number, string>();
    const updates = agentTitleUpdates(
      [{ sessionId: 1, title: "maestro-41", conversationId: "conv-1" }],
      live,
      lastSeen,
    );
    expect(updates).toEqual([{ sessionId: 1, name: "maestro-42" }]);
    expect(lastSeen.get(1)).toBe("maestro-42");
  });

  it("keeps a fresh user rename until the live name changes", () => {
    const lastSeen = new Map([[1, "maestro-42"]]);
    const pending = [{ sessionId: 1, title: "reviewer", conversationId: "conv-1" }];
    expect(agentTitleUpdates(pending, live, lastSeen)).toEqual([]);
    // Claude resolved a collision by picking another name: follow it.
    const applied = [{ session_id: "conv-1", name: "reviewer-2" }];
    expect(agentTitleUpdates(pending, applied, lastSeen)).toEqual([
      { sessionId: 1, name: "reviewer-2" },
    ]);
  });

  it("skips terminals with no conversation or no live entry", () => {
    const updates = agentTitleUpdates(
      [
        { sessionId: 1, title: null, conversationId: undefined },
        { sessionId: 2, title: null, conversationId: "conv-unknown" },
      ],
      live,
      new Map(),
    );
    expect(updates).toEqual([]);
  });
});
