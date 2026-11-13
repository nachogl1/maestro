import { invoke } from "@tauri-apps/api/core";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { useInjectedMessageStore } from "@/stores/useInjectedMessageStore";
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
  useInjectedMessageStore.setState({ bySession: {} });
  seedSessions();
});

/** The add form at the bottom of the panel (every row's editor is another form). */
function addForm(): HTMLElement {
  return screen.getByRole("button", { name: /Add trigger/ }).parentElement as HTMLElement;
}

function addTicked(name: string, watchIds: number[], message = "run /compact") {
  act(() =>
    useInjectorTriggerStore.getState().addTrigger({
      name,
      watch: "ticked",
      watchIds,
      threshold: 80,
      message,
      target: "reached",
    }),
  );
}

describe("InjectorTriggersSection", () => {
  it("needs ticked terminals for a ticked trigger, but none for an all-terminals one", () => {
    render(<InjectorTriggersSection />);
    const add = () => screen.getByRole("button", { name: /Add trigger/ });
    expect(screen.getByText("Tick terminals in the Injector above to watch them.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hand off" } });
    expect(add()).toBeDisabled();

    act(() => useInjectorStore.setState({ selectedIds: [1, 3] }));
    expect(screen.getByRole("radio", { name: "Only the ones ticked above (2)" })).toBeChecked();
    expect(add()).toBeEnabled();

    act(() => useInjectorStore.setState({ selectedIds: [] }));
    fireEvent.click(screen.getByRole("radio", { name: "All terminals, also new ones" }));
    expect(add()).toBeEnabled();
  });

  it("adds a named trigger for the ticked terminals and lists it, then deletes it", () => {
    useInjectorStore.setState({ selectedIds: [1, 3] });
    render(<InjectorTriggersSection />);
    const sendTo = screen.getByRole("combobox", { name: "send the message to" });
    expect(sendTo).toHaveValue("reached");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Handoff" } });
    fireEvent.change(screen.getByLabelText("When a terminal reaches"), {
      target: { value: "70" },
    });
    fireEvent.change(sendTo, { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "write a handoff" } });
    fireEvent.click(screen.getByRole("button", { name: /Add trigger/ }));

    const [trigger] = useInjectorTriggerStore.getState().triggers;
    expect(trigger).toMatchObject({
      name: "Handoff",
      watch: "ticked",
      watchIds: [1, 3],
      threshold: 70,
      target: "all",
      message: "write a handoff",
    });
    const row = screen.getByRole("listitem", { name: "Handoff" });
    expect(within(row).getByText("At 70% → every terminal it watches")).toBeTruthy();
    expect(within(row).getByText("Not fired yet")).toBeTruthy();
    expect(within(addForm()).getByLabelText("Name")).toHaveValue("");

    fireEvent.click(within(row).getByRole("button", { name: "Delete trigger" }));
    expect(useInjectorTriggerStore.getState().triggers).toEqual([]);
  });

  it("names an unnamed trigger by the first words of its message", () => {
    render(<InjectorTriggersSection />);
    fireEvent.click(screen.getByRole("radio", { name: "All terminals, also new ones" }));
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Stop and write a handoff note now" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add trigger/ }));

    const row = screen.getByRole("listitem", { name: "Stop and write a…" });
    expect(within(row).getByText("At 80% → only that terminal")).toBeTruthy();
  });

  it("lists the watched terminals from the pill: the ticked ones, or every open one", () => {
    addTicked("Ticked", [1, 3]);
    act(() =>
      useInjectorTriggerStore.getState().addTrigger({
        name: "Everyone",
        watch: "all",
        watchIds: [],
        threshold: 80,
        message: "b",
        target: "reached",
      }),
    );
    render(<InjectorTriggersSection />);

    const ticked = screen.getByRole("listitem", { name: "Ticked" });
    fireEvent.click(within(ticked).getByRole("button", { name: "2 terminals" }));
    const tickedList = within(ticked).getByRole("list", { name: "Watched terminals" });
    expect(
      within(tickedList)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["alpha · maestro", "gamma · maestro"]);

    const everyone = screen.getByRole("listitem", { name: "Everyone" });
    fireEvent.click(within(everyone).getByRole("button", { name: "all terminals" }));
    expect(within(everyone).getByText("All terminals open now:")).toBeTruthy();
    const allList = within(everyone).getByRole("list", { name: "Watched terminals" });
    expect(within(allList).getAllByRole("listitem")).toHaveLength(3);
  });

  it("edits a trigger in its row: Cancel keeps it, Save changes it", () => {
    useInjectorStore.setState({ selectedIds: [2] });
    addTicked("Compact", [1]);
    render(<InjectorTriggersSection />);
    const openEditor = () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit trigger" }));
      return screen.getByRole("listitem", { name: "Edit Compact" });
    };

    let editor = openEditor();
    expect(within(editor).getByLabelText("Name")).toHaveValue("Compact");
    expect(within(editor).getByLabelText("When a terminal reaches")).toHaveValue(80);
    expect(within(editor).getByLabelText("Message")).toHaveValue("run /compact");
    fireEvent.change(within(editor).getByLabelText("Name"), { target: { value: "Ignored" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("listitem", { name: "Compact" })).toBeTruthy();
    expect(useInjectorTriggerStore.getState().triggers[0].name).toBe("Compact");

    editor = openEditor();
    fireEvent.change(within(editor).getByLabelText("When a terminal reaches"), {
      target: { value: "65" },
    });
    fireEvent.change(within(editor).getByLabelText("Message"), {
      target: { value: "run /compact now" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));

    expect(useInjectorTriggerStore.getState().triggers).toEqual([
      expect.objectContaining({ threshold: 65, message: "run /compact now", watchIds: [2] }),
    ]);
    const row = screen.getByRole("listitem", { name: "Compact" });
    expect(within(row).getByText("At 65% → only that terminal")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "1 terminal" })).toBeTruthy();
  });

  it("marks a ticked trigger with no open terminal as watching nothing", () => {
    addTicked("After restart", []);
    render(<InjectorTriggersSection />);

    const row = screen.getByRole("listitem", { name: "After restart" });
    expect(within(row).getByText("watches nothing, edit to pick terminals")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /terminal/ })).toBeNull();
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

  it("watches a terminal opened after an all-terminals trigger was made", async () => {
    useInjectorTriggerStore.getState().addTrigger({
      watch: "all",
      watchIds: [],
      threshold: 50,
      message: "compact now",
      target: "reached",
    });
    renderHook(() => useInjectorTriggers());

    act(() => {
      useSessionStore.setState((s) => ({
        sessions: [...s.sessions, buildSession({ id: 4, name: "delta" })],
      }));
    });
    setContext(4, 60);

    await waitFor(() => expect(injectCalls()).toEqual([{ sessionId: 4, text: "compact now" }]));
    // The terminal header's message icon is recorded for the new terminal too.
    await waitFor(() =>
      expect(useInjectedMessageStore.getState().bySession[4]).toEqual([
        expect.objectContaining({ text: "compact now" }),
      ]),
    );
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
