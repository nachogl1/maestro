import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted zustand stores hydrate through the Tauri store plugin at
// import time; happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

import { useInjectorTriggers } from "@/hooks/useInjectorTriggers";
import { useInjectorStore } from "@/stores/useInjectorStore";
import { useInjectorTriggerStore } from "@/stores/useInjectorTriggerStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { InjectorTriggersSection } from "../InjectorTriggersSection";

const invokeMock = vi.mocked(invoke);

function buildTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "maestro",
    projectPath: "C:\\git\\maestro",
    active: true,
    sessionIds: [1, 2, 3],
    sessionsLaunched: true,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
    ...overrides,
  };
}

function buildSession(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: 1,
    mode: "Claude",
    name: null,
    branch: null,
    worktree_path: null,
    project_path: "C:\\git\\maestro",
    status: "Idle",
    ...overrides,
  };
}

function seedSessions() {
  useWorkspaceStore.setState({ tabs: [buildTab()] });
  useSessionStore.setState({
    sessions: [
      buildSession({ id: 1, name: "alpha" }),
      buildSession({ id: 2, name: "beta" }),
      buildSession({ id: 3, name: "gamma" }),
    ],
  });
}

function setContext(id: number, contextPercent: number | undefined) {
  act(() => {
    useSessionStore.setState((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, contextPercent } : x)),
    }));
  });
}

function injectCalls(): { sessionId: number; text: string }[] {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "inject_message")
    .map(([, args]) => args as { sessionId: number; text: string });
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  useInjectorStore.setState({ message: "", selectedIds: [], lastRun: null, injecting: false });
  useInjectorTriggerStore.setState({ triggers: [] });
  seedSessions();
});

describe("InjectorTriggersSection", () => {
  it("needs ticked terminals and a message before a trigger can be added", () => {
    render(<InjectorTriggersSection />);
    const add = () => screen.getByRole("button", { name: /Add trigger/ });
    expect(screen.getByText("Tick terminals in the Injector above to watch them.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Trigger message" }), {
      target: { value: "hand off" },
    });
    expect(add()).toBeDisabled();

    act(() => useInjectorStore.setState({ selectedIds: [1, 3] }));
    expect(screen.getByText("Watch the 2 terminals ticked above.")).toBeTruthy();
    expect(add()).toBeEnabled();
  });

  it("adds a trigger for the ticked terminals and lists it, then deletes it", () => {
    useInjectorStore.setState({ selectedIds: [1, 3] });
    render(<InjectorTriggersSection />);
    fireEvent.change(screen.getByLabelText("At context"), { target: { value: "70" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Send the message to" }), {
      target: { value: "reached" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Trigger message" }), {
      target: { value: "write a handoff" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add trigger/ }));

    const [trigger] = useInjectorTriggerStore.getState().triggers;
    expect(trigger).toMatchObject({
      watchIds: [1, 3],
      threshold: 70,
      target: "reached",
      message: "write a handoff",
    });
    expect(screen.getByText("Watches alpha, gamma")).toBeTruthy();
    expect(screen.getByText("At 70% → the one that reached it")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete trigger" }));
    expect(useInjectorTriggerStore.getState().triggers).toEqual([]);
  });
});

describe("useInjectorTriggers", () => {
  it("broadcasts to every watched terminal once when one reaches the threshold", async () => {
    useInjectorTriggerStore
      .getState()
      .addTrigger({ watchIds: [1, 2], threshold: 50, message: "compact now", target: "all" });
    renderHook(() => useInjectorTriggers());

    setContext(1, 30);
    expect(injectCalls()).toEqual([]);

    setContext(1, 50);
    await waitFor(() =>
      expect(injectCalls()).toEqual([
        { sessionId: 1, text: "compact now" },
        { sessionId: 2, text: "compact now" },
      ]),
    );
    await waitFor(() =>
      expect(useInjectorTriggerStore.getState().triggers[0].lastFire).toMatchObject({
        reachedNames: ["alpha"],
        result: { sent: 2, failures: [] },
      }),
    );

    // Climbing further does not fire again.
    setContext(1, 70);
    expect(injectCalls()).toHaveLength(2);
  });

  it("sends only to the terminal that reached it and re-arms after /clear", async () => {
    useInjectorTriggerStore
      .getState()
      .addTrigger({ watchIds: [1, 2], threshold: 50, message: "hand off", target: "reached" });
    renderHook(() => useInjectorTriggers());

    setContext(2, 55);
    await waitFor(() => expect(injectCalls()).toEqual([{ sessionId: 2, text: "hand off" }]));

    setContext(2, undefined);
    setContext(2, 52);
    await waitFor(() => expect(injectCalls()).toHaveLength(2));
    expect(injectCalls()[1]).toEqual({ sessionId: 2, text: "hand off" });
  });

  it("fires right away for a watched terminal already over the threshold", async () => {
    setContext(3, 90);
    renderHook(() => useInjectorTriggers());
    act(() =>
      useInjectorTriggerStore
        .getState()
        .addTrigger({ watchIds: [3], threshold: 80, message: "stop", target: "all" }),
    );
    await waitFor(() => expect(injectCalls()).toEqual([{ sessionId: 3, text: "stop" }]));
  });
});
