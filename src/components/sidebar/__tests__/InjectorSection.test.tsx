import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { useInjectorStore } from "@/stores/useInjectorStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { InjectorSection } from "../InjectorSection";

const invokeMock = vi.mocked(invoke);

function buildTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "maestro",
    projectPath: "C:\\git\\maestro",
    active: true,
    sessionIds: [],
    sessionsLaunched: false,
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

/** Two projects, three terminals: maestro has #1 (named) and #2, other has #3. */
function seedTwoProjects() {
  useWorkspaceStore.setState({
    tabs: [
      buildTab({ id: "tab-1", name: "maestro", sessionIds: [1, 2] }),
      buildTab({
        id: "tab-2",
        name: "other",
        projectPath: "C:\\git\\other",
        active: false,
        sessionIds: [3],
      }),
    ],
  });
  useSessionStore.setState({
    sessions: [
      buildSession({ id: 1, name: "maestro-alpha", status: "Working" }),
      buildSession({ id: 2, status: "NeedsInput" }),
      buildSession({ id: 3, project_path: "C:\\git\\other", mode: "Plain" }),
    ],
  });
}

function injectCalls(): { sessionId: number; text: string }[] {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "inject_message")
    .map(([, args]) => args as { sessionId: number; text: string });
}

describe("InjectorSection", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    useInjectorStore.setState({ message: "", selectedIds: [], lastRun: null, injecting: false });
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    useSessionStore.setState({ sessions: [] });
  });

  it("shows an empty state when nothing is running", () => {
    render(<InjectorSection />);
    expect(screen.getByText("No running terminals")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inject into 0 terminals/ })).toBeDisabled();
  });

  it("lists every running terminal of every project with its name and status", () => {
    seedTwoProjects();
    render(<InjectorSection />);
    expect(screen.getByRole("checkbox", { name: "maestro-alpha" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Terminal 2" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Terminal 3" })).toBeInTheDocument();
    expect(screen.getByText("WORKING")).toBeInTheDocument();
    expect(screen.getByText("NEEDS INPUT")).toBeInTheDocument();
  });

  it("stays disabled until at least one terminal is ticked and a message is typed", () => {
    seedTwoProjects();
    render(<InjectorSection />);
    const button = () => screen.getByRole("button", { name: /Inject into/ });
    expect(button()).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "maestro-alpha" }));
    expect(button()).toHaveTextContent("Inject into 1 terminal");
    expect(button()).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Message to inject" }), {
      target: { value: "   " },
    });
    expect(button()).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Message to inject" }), {
      target: { value: "commit your work" },
    });
    expect(button()).toBeEnabled();
  });

  it("sends the message to every ticked terminal and clears the box on success", async () => {
    seedTwoProjects();
    render(<InjectorSection />);
    fireEvent.click(screen.getByRole("checkbox", { name: "maestro-alpha" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Terminal 3" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message to inject" }), {
      target: { value: "please commit" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Inject into 2 terminals/ }));

    await waitFor(() => expect(injectCalls()).toHaveLength(2));
    expect(injectCalls()).toEqual([
      { sessionId: 1, text: "please commit" },
      { sessionId: 3, text: "please commit" },
    ]);
    // Terminal 2 was never ticked.
    expect(injectCalls().some((c) => c.sessionId === 2)).toBe(false);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Sent to 2 terminals."),
    );
    expect(screen.getByRole("textbox", { name: "Message to inject" })).toHaveValue("");
  });

  it("the project checkbox ticks and unticks all of that project's terminals", () => {
    seedTwoProjects();
    render(<InjectorSection />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all terminals in maestro" }));
    expect(screen.getByRole("checkbox", { name: "maestro-alpha" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Terminal 2" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Terminal 3" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all terminals in maestro" }));
    expect(screen.getByRole("checkbox", { name: "maestro-alpha" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Terminal 2" })).not.toBeChecked();
  });

  it("All and None tick every terminal across projects, then none", () => {
    seedTwoProjects();
    render(<InjectorSection />);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByRole("button", { name: /Inject into 3 terminals/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(screen.getByRole("button", { name: /Inject into 0 terminals/ })).toBeInTheDocument();
  });

  it("Ctrl+Enter in the box sends, plain Enter does not", async () => {
    seedTwoProjects();
    render(<InjectorSection />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Terminal 2" }));
    const box = screen.getByRole("textbox", { name: "Message to inject" });
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(injectCalls()).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(injectCalls()).toEqual([{ sessionId: 2, text: "hello" }]));
  });

  it("reports failed terminals by name and keeps the message for a retry", async () => {
    seedTwoProjects();
    invokeMock.mockImplementation(async (cmd, args) => {
      const a = args as { sessionId?: number } | undefined;
      if (cmd === "inject_message" && a?.sessionId === 3) {
        throw new Error("Session 3 not found");
      }
      return undefined;
    });
    render(<InjectorSection />);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message to inject" }), {
      target: { value: "status?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Inject into 3 terminals/ }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 sent, 1 failed"));
    expect(screen.getByRole("status")).toHaveTextContent("Terminal 3 — Session 3 not found");
    expect(screen.getByRole("textbox", { name: "Message to inject" })).toHaveValue("status?");
  });

  it("ignores ticks for terminals that have since closed", () => {
    seedTwoProjects();
    useInjectorStore.setState({ selectedIds: [1, 99], message: "hi" });
    render(<InjectorSection />);
    expect(screen.getByRole("button", { name: /Inject into 1 terminal$/ })).toBeEnabled();
  });
});
