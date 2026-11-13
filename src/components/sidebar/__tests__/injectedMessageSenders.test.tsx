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
import { useInjectedMessageStore } from "@/stores/useInjectedMessageStore";
import { useInjectorStore } from "@/stores/useInjectorStore";
import { useInjectorTriggerStore } from "@/stores/useInjectorTriggerStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { InjectorSection } from "../InjectorSection";

const invokeMock = vi.mocked(invoke);
/** Terminal 2 is the one whose delivery fails in every case below. */
const FAILING_SESSION = 2;

function buildTab(): WorkspaceTab {
  return {
    id: "tab-1",
    name: "demo",
    projectPath: "C:\\git\\demo",
    active: true,
    sessionIds: [1, 2],
    sessionsLaunched: true,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
  };
}

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

/** Sends "commit your work" to terminals 1 and 2 through one of the two senders. */
const senders: { name: string; sender: string; send: () => void }[] = [
  {
    name: "the Injector panel",
    sender: "Injector",
    send: () => {
      render(<InjectorSection />);
      fireEvent.click(screen.getByRole("button", { name: "All" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Message to inject" }), {
        target: { value: "commit your work" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Inject into 2 terminals/ }));
    },
  },
  {
    name: "a trigger",
    sender: "Trigger at 50%",
    send: () => {
      useInjectorTriggerStore.getState().addTrigger({
        watchIds: [1, 2],
        threshold: 50,
        message: "commit your work",
        target: "all",
      });
      renderHook(() => useInjectorTriggers());
      act(() => {
        useSessionStore.setState((s) => ({
          sessions: s.sessions.map((x) => (x.id === 1 ? { ...x, contextPercent: 60 } : x)),
        }));
      });
    },
  },
];

describe("injected-message notices from the two senders", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd, args) => {
      const a = args as { sessionId?: number } | undefined;
      if (cmd === "inject_message" && a?.sessionId === FAILING_SESSION) {
        throw new Error("Session 2 not found");
      }
      return undefined;
    });
    useInjectorStore.setState({ message: "", selectedIds: [], lastRun: null, injecting: false });
    useInjectorTriggerStore.setState({ triggers: [] });
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    useSessionStore.setState({ sessions: [buildSession(1), buildSession(2)] });
    useInjectedMessageStore.setState({ bySession: {} });
  });

  it.each(
    senders,
  )("$name records one notice per terminal it reached, none for a failed one", async ({
    sender,
    send,
  }) => {
    send();

    await waitFor(() => expect(useInjectedMessageStore.getState().bySession[1]).toHaveLength(1));
    expect(useInjectedMessageStore.getState().bySession[1][0]).toMatchObject({
      sender,
      text: "commit your work",
    });
    // The failing terminal was really sent to, so the failure case ran.
    expect(invokeMock).toHaveBeenCalledWith(
      "inject_message",
      expect.objectContaining({ sessionId: FAILING_SESSION }),
    );
    expect(useInjectedMessageStore.getState().bySession[FAILING_SESSION]).toBeUndefined();
  });
});
