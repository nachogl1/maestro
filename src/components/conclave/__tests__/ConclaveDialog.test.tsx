import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
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

import { useCliSettingsStore } from "@/stores/useCliSettingsStore";
import { useInjectedMessageStore } from "@/stores/useInjectedMessageStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { ConclaveDialog } from "../ConclaveDialog";
import { CONCLAVE_DEFAULT_MESSAGE } from "../conclave";

const invokeMock = vi.mocked(invoke);

const WARNING =
  "These agents will ask you to approve each message. Set crossSessionInbound to accept in " +
  "Claude Code settings to stop that.";

function buildTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "alpha-app",
    projectPath: "C:\\work\\alpha-app",
    active: true,
    sessionIds: [],
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
    project_path: "C:\\work\\alpha-app",
    status: "Idle",
    ...overrides,
  };
}

/**
 * Two projects: alpha-app runs #1 (named, Claude), #2 (plain shell) and #4
 * (unnamed Claude, parked); beta-app runs #3 (named, Claude).
 */
function seedTwoProjects(): void {
  useWorkspaceStore.setState({
    tabs: [
      buildTab({ id: "tab-1", name: "alpha-app", sessionIds: [1, 2, 4] }),
      buildTab({
        id: "tab-2",
        name: "beta-app",
        projectPath: "C:\\work\\beta-app",
        active: false,
        sessionIds: [3],
      }),
    ],
  });
  useSessionStore.setState({
    sessions: [
      buildSession({ id: 1, name: "fox" }),
      buildSession({ id: 2, name: "sh", mode: "Plain" }),
      buildSession({ id: 3, name: "owl", project_path: "C:\\work\\beta-app" }),
      buildSession({ id: 4 }),
    ],
    parkedSessionIds: [4],
  });
}

function injectCalls(): { sessionId: number; text: string }[] {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "inject_message")
    .map(([, args]) => args as { sessionId: number; text: string });
}

const invokeButton = () => screen.getByRole("button", { name: "Invoke Conclave" });
const messageBox = () => screen.getByRole("textbox", { name: "Conclave message" });

function setSkipPermissions(value: boolean): void {
  const { flags } = useCliSettingsStore.getState();
  useCliSettingsStore.setState({
    flags: { ...flags, Claude: { ...flags.Claude, skipPermissions: value } },
  });
}

describe("ConclaveDialog", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    useInjectedMessageStore.setState({ bySession: {} });
    useSessionStore.setState({ sessions: [], parkedSessionIds: [] });
    useWorkspaceStore.setState({ tabs: [] });
    setSkipPermissions(false);
  });

  it("asks the question with its (i) explanation on hover and keyboard focus", () => {
    seedTwoProjects();
    render(<ConclaveDialog onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Do you want to invoke Conclave?" })).toBeVisible();

    const info = screen.getByRole("button", { name: "About Conclave" });
    fireEvent.mouseEnter(info);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      /each one messages the others, says what it is working on, offers help where it can/,
    );
    fireEvent.mouseLeave(info);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.focus(info);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("lists every running Claude Code terminal by project, parked ones tagged, none ticked", () => {
    seedTwoProjects();
    render(<ConclaveDialog onClose={vi.fn()} />);

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual(["fox", "Terminal 4", "owl"]);
    for (const box of boxes) expect(box).not.toBeChecked();
    // The plain shell has no ListAgents / SendMessage, so it is never offered.
    expect(screen.queryByRole("checkbox", { name: "sh" })).not.toBeInTheDocument();
    expect(screen.getByText("alpha-app")).toBeInTheDocument();
    expect(screen.getByText("beta-app")).toBeInTheDocument();
    expect(screen.getAllByText("parked")).toHaveLength(1);
    expect(screen.getByText("parked").closest("label")).toHaveTextContent("Terminal 4");
  });

  it("keeps Invoke off below two ticked terminals or with an empty message; All ticks every one", () => {
    seedTwoProjects();
    render(<ConclaveDialog onClose={vi.fn()} />);
    expect(invokeButton()).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "fox" }));
    expect(invokeButton()).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeChecked();
    expect(invokeButton()).toBeEnabled();

    fireEvent.change(messageBox(), { target: { value: "  \n " } });
    expect(invokeButton()).toBeDisabled();
  });

  it("opens with the default message every time, even after an earlier edit", () => {
    seedTwoProjects();
    const first = render(<ConclaveDialog onClose={vi.fn()} />);
    expect(messageBox()).toHaveValue(CONCLAVE_DEFAULT_MESSAGE);
    fireEvent.change(messageBox(), { target: { value: "something else" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "fox" }));
    first.unmount();

    render(<ConclaveDialog onClose={vi.fn()} />);
    expect(messageBox()).toHaveValue(CONCLAVE_DEFAULT_MESSAGE);
    expect(screen.getByRole("checkbox", { name: "fox" })).not.toBeChecked();
  });

  it("sends the edited text plus the member line to exactly the ticked terminals, then closes", async () => {
    seedTwoProjects();
    const onClose = vi.fn();
    render(<ConclaveDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "fox" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "owl" }));
    fireEvent.change(messageBox(), { target: { value: "Share the dev port, please.\n" } });
    fireEvent.click(invokeButton());

    const sent =
      "Share the dev port, please.\n\nAgents in this Conclave: fox (alpha-app), owl (beta-app)";
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(injectCalls()).toEqual([
      { sessionId: 1, text: sent },
      { sessionId: 3, text: sent },
    ]);
    const { bySession } = useInjectedMessageStore.getState();
    expect(bySession[1]).toEqual([expect.objectContaining({ sender: "Conclave", text: sent })]);
    expect(bySession[3]).toEqual([expect.objectContaining({ sender: "Conclave", text: sent })]);
    expect(bySession[4]).toBeUndefined();
  });

  it("shows a failed terminal inline, stays open and records nothing for it", async () => {
    seedTwoProjects();
    invokeMock.mockImplementation(async (cmd, args) => {
      const a = args as { sessionId?: number } | undefined;
      if (cmd === "inject_message" && a?.sessionId === 3) throw new Error("Session 3 not found");
      return undefined;
    });
    const onClose = vi.fn();
    render(<ConclaveDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "fox" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "owl" }));
    fireEvent.click(invokeButton());

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 sent, 1 failed:"));
    expect(screen.getByRole("status")).toHaveTextContent("owl — Session 3 not found");
    expect(onClose).not.toHaveBeenCalled();
    const { bySession } = useInjectedMessageStore.getState();
    expect(bySession[1]).toEqual([expect.objectContaining({ sender: "Conclave" })]);
    expect(bySession[3]).toBeUndefined();
  });

  it("warns about message approvals only when Claude skips permissions and a terminal is ticked", () => {
    seedTwoProjects();
    const { unmount } = render(<ConclaveDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "fox" }));
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    unmount();

    setSkipPermissions(true);
    render(<ConclaveDialog onClose={vi.fn()} />);
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "fox" }));
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it("Cancel and Esc close it without sending anything", () => {
    seedTwoProjects();
    const onClose = vi.fn();
    render(<ConclaveDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(injectCalls()).toHaveLength(0);
  });

  it("takes keyboard focus from the terminal it was opened over, so Esc closes it there", () => {
    seedTwoProjects();
    // Alt+C is usually pressed inside a terminal: xterm handles Escape itself
    // (sends it to the agent and stops the event), so focus must leave it.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal();
    term.open(host);
    const typed: string[] = [];
    term.onData((data) => typed.push(data));
    term.focus();
    expect(host.contains(document.activeElement)).toBe(true);

    const onClose = vi.fn();
    render(<ConclaveDialog onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(typed).toEqual([]);

    term.dispose();
    host.remove();
  });
});
