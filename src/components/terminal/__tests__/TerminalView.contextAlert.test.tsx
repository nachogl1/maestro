import { act, render } from "@testing-library/react";
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

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(async () => false),
}));

// xterm.js cannot mount in happy-dom; the frame under test is the wrapper div.
vi.mock("@/hooks/useXtermSession", () => ({
  useXtermSession: () => {},
}));
vi.mock("@/hooks/useSessionBranch", () => ({
  useSessionBranch: () => null,
}));
vi.mock("@/lib/git", () => ({
  isGitWorktree: vi.fn(async () => false),
}));
vi.mock("@/components/session/ActivityFeed", () => ({ ActivityFeed: () => null }));
vi.mock("@/components/session/AgentGraph", () => ({ AgentGraph: () => null }));
vi.mock("@/components/quickactions/QuickActionsManager", () => ({
  QuickActionsManager: () => null,
}));

import { useContextAlertStore } from "@/stores/useContextAlertStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { TerminalView } from "../TerminalView";

const SESSION_ID = 7;

function seedSession(contextPercent: number | undefined) {
  const session = {
    id: SESSION_ID,
    mode: "Claude",
    status: "Working",
    branch: null,
    worktree_path: null,
    project_path: "C:/proj",
    name: "agent",
    contextPercent,
  } as unknown as SessionConfig;
  useSessionStore.setState({ sessions: [session] });
}

function frame(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".terminal-cell");
  if (!(el instanceof HTMLElement)) throw new Error("terminal frame not rendered");
  return el;
}

describe("TerminalView context alert frame", () => {
  beforeEach(() => {
    useContextAlertStore.setState({ threshold: 80 });
  });

  it("keeps the project-colour border below the threshold", () => {
    seedSession(42);
    const { container } = render(
      <TerminalView sessionId={SESSION_ID} onKill={() => {}} projectColor="#123456" />,
    );
    const cell = frame(container);
    expect(cell.classList.contains("terminal-cell-context-alert")).toBe(false);
    expect(cell.style.borderColor).not.toBe("");
  });

  it("switches to the blinking red frame once usage reaches the threshold", () => {
    seedSession(85);
    const { container } = render(
      <TerminalView sessionId={SESSION_ID} onKill={() => {}} projectColor="#123456" />,
    );
    const cell = frame(container);
    expect(cell.classList.contains("terminal-cell-context-alert")).toBe(true);
    // The inline project colour must step aside or it would beat the red class.
    expect(cell.style.borderColor).toBe("");
    expect(cell.dataset.contextAlert).toBe("true");
  });

  it("stops alerting when the setting is turned off", () => {
    seedSession(85);
    const { container } = render(<TerminalView sessionId={SESSION_ID} onKill={() => {}} />);
    expect(frame(container).classList.contains("terminal-cell-context-alert")).toBe(true);
    act(() => {
      useContextAlertStore.getState().setThreshold(null);
    });
    expect(frame(container).classList.contains("terminal-cell-context-alert")).toBe(false);
  });

  it("shows the header banner with percent and threshold only while alerting", () => {
    seedSession(87.3);
    const { container, queryByRole } = render(
      <TerminalView sessionId={SESSION_ID} onKill={() => {}} />,
    );
    const pill = queryByRole("status");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain("Context threshold reached");
    expect(pill?.getAttribute("title")).toBe("Context 87% ≥ 80% alert");
    act(() => {
      useContextAlertStore.getState().setThreshold(90);
    });
    expect(frame(container).classList.contains("terminal-cell-context-alert")).toBe(false);
    expect(queryByRole("status")).toBeNull();
  });

  it("alerts when the reading rounds up to the threshold, like the badges show it", () => {
    seedSession(79.6);
    const { container } = render(<TerminalView sessionId={SESSION_ID} onKill={() => {}} />);
    expect(frame(container).classList.contains("terminal-cell-context-alert")).toBe(true);
  });

  it("does not alert before the first usage reading", () => {
    seedSession(undefined);
    const { container } = render(<TerminalView sessionId={SESSION_ID} onKill={() => {}} />);
    expect(frame(container).classList.contains("terminal-cell-context-alert")).toBe(false);
  });
});
