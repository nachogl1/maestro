import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { TerminalHeader } from "../TerminalHeader";

/** The header inside a terminal cell, next to xterm's input textarea. */
function renderInCell(onRename = vi.fn()) {
  render(
    <div className="terminal-cell">
      <TerminalHeader sessionId={4} onKill={vi.fn()} onRename={onRename} />
      <textarea className="xterm-helper-textarea" aria-label="Terminal input" />
    </div>,
  );
  return onRename;
}

async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });
}

describe("TerminalHeader rename from the keyboard", () => {
  it("Enter saves the name once and puts the cursor back in the terminal", async () => {
    const onRename = renderInCell();
    fireEvent.click(screen.getByRole("button", { name: "Terminal 4" }));
    const input = screen.getByDisplayValue("Terminal 4");
    fireEvent.change(input, { target: { value: "api work" } });

    fireEvent.keyDown(input, { key: "Enter" });
    await flushFrame();

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith(4, "api work");
    expect(document.activeElement).toBe(screen.getByLabelText("Terminal input"));
  });

  it("Escape keeps the old name and puts the cursor back in the terminal", async () => {
    const onRename = renderInCell();
    fireEvent.click(screen.getByRole("button", { name: "Terminal 4" }));
    const input = screen.getByDisplayValue("Terminal 4");
    fireEvent.change(input, { target: { value: "never saved" } });

    fireEvent.keyDown(input, { key: "Escape" });
    await flushFrame();

    expect(onRename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText("Terminal input"));
  });
});
