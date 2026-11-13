import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useInjectedMessageStore } from "@/stores/useInjectedMessageStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { TerminalHeader } from "../TerminalHeader";

const SESSION_ID = 3;
const NOTICE_NAME = /^Injected messages/;
const at = (hour: number, minute: number) => new Date(2026, 10, 13, hour, minute).getTime();

function renderHeader(props: Partial<React.ComponentProps<typeof TerminalHeader>> = {}) {
  return render(<TerminalHeader sessionId={SESSION_ID} onKill={() => {}} {...props} />);
}

function record(sender: string, text: string, time: number) {
  act(() => useInjectedMessageStore.getState().record([SESSION_ID], sender, text, time));
}

const notice = () => screen.getByRole("button", { name: NOTICE_NAME });

describe("TerminalHeader injected-message notice", () => {
  beforeEach(() => {
    const session: SessionConfig = {
      id: SESSION_ID,
      mode: "Claude",
      name: null,
      branch: null,
      worktree_path: null,
      project_path: "C:\\git\\demo",
      status: "Idle",
    };
    useSessionStore.setState({ sessions: [session] });
    useInjectedMessageStore.setState({ bySession: {} });
  });

  it("shows an amber icon after the name only while the terminal has notices", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: NOTICE_NAME })).toBeNull();

    record("Injector", "please commit", at(14, 20));
    expect(screen.getByText("Terminal 3").nextElementSibling).toBe(notice());
    expect(notice().className).toContain("text-amber-500");
    // One notice: just the icon, no count.
    expect(notice().textContent).toBe("");
  });

  it("sits after the red context icon when that shows", () => {
    record("Injector", "please commit", at(14, 20));
    renderHeader({ contextAlert: true });
    expect(screen.getByRole("status").nextElementSibling).toBe(notice());
  });

  it("carries a count from two notices on", () => {
    renderHeader();
    record("Injector", "one", at(14, 20));
    record("Injector", "two", at(14, 21));
    expect(notice().textContent).toBe("2");
    record("Injector", "three", at(14, 22));
    expect(notice().textContent).toBe("3");
  });

  it("lists every notice newest first on hover, ending with how to dismiss", () => {
    record("Injector", "please commit\nand push", at(14, 20));
    record("Trigger at 50%", "compact now", at(9, 5));
    renderHeader();
    expect(notice().getAttribute("title")).toBe(
      [
        "Trigger at 50% · 09:05 · compact now",
        "Injector · 14:20 · please commit",
        "Click to dismiss",
      ].join("\n"),
    );
  });

  it("clears every notice on click; clicking the header or typing does not", () => {
    const onToggleFlag = vi.fn();
    record("Injector", "one", at(14, 20));
    record("Injector", "two", at(14, 21));
    renderHeader({ onToggleFlag });

    fireEvent.click(screen.getByText("Terminal 3").parentElement as HTMLElement);
    fireEvent.keyDown(document.body, { key: "a" });
    expect(notice()).toBeInTheDocument();

    fireEvent.click(notice());
    expect(screen.queryByRole("button", { name: NOTICE_NAME })).toBeNull();
    expect(useInjectedMessageStore.getState().bySession[SESSION_ID]).toBeUndefined();
    // The dismiss click is the icon's own, never a flag toggle.
    expect(onToggleFlag).toHaveBeenCalledTimes(1);
  });
});
