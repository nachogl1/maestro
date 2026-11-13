import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInjectedMessageStore } from "@/stores/useInjectedMessageStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";

function buildSession(id: number): SessionConfig {
  return {
    id,
    mode: "Claude",
    name: null,
    branch: null,
    worktree_path: null,
    project_path: "C:\\git\\demo",
    status: "Idle",
  };
}

const AT_14_20 = new Date(2026, 10, 13, 14, 20).getTime();
const AT_14_25 = new Date(2026, 10, 13, 14, 25).getTime();

describe("useInjectedMessageStore", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useSessionStore.setState({ sessions: [buildSession(1), buildSession(2)] });
    useInjectedMessageStore.setState({ bySession: {} });
  });

  it("keeps each terminal's messages newest first, and clearing one leaves the others", () => {
    const { record } = useInjectedMessageStore.getState();
    record([1, 2], "Injector", "please commit", AT_14_20);
    record([1], "Trigger at 50%", "compact now", AT_14_25);

    expect(useInjectedMessageStore.getState().bySession[1]).toEqual([
      { sender: "Trigger at 50%", at: AT_14_25, text: "compact now" },
      { sender: "Injector", at: AT_14_20, text: "please commit" },
    ]);

    useInjectedMessageStore.getState().clear(1);
    expect(useInjectedMessageStore.getState().bySession[1]).toBeUndefined();
    expect(useInjectedMessageStore.getState().bySession[2]).toHaveLength(1);
  });

  it("drops a closed terminal's messages and writes nothing to disk", () => {
    useInjectedMessageStore.getState().record([1, 2], "Injector", "hello", AT_14_20);

    useSessionStore.setState({ sessions: [buildSession(2)] });

    expect(useInjectedMessageStore.getState().bySession[1]).toBeUndefined();
    expect(useInjectedMessageStore.getState().bySession[2]).toHaveLength(1);
    // In memory only: no persist middleware, no backend call.
    expect("persist" in useInjectedMessageStore).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
