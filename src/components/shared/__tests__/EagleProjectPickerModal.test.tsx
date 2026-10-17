import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EagleProjectPickerModal } from "../EagleProjectPickerModal";
import type { EagleProjectOption } from "../TopBar";

function buildProjects(): EagleProjectOption[] {
  return [
    { tabId: "a", name: "alpha", color: "#f00", atMax: false },
    { tabId: "b", name: "bravo", color: "#0f0", atMax: true },
    { tabId: "c", name: "charlie", color: "#00f", atMax: false },
  ];
}

// act() flushes the selection state update (and the effect re-registration
// that captures it) before the next key arrives — mirrors real typing cadence.
function dispatchKey(key: string): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(ev);
  });
  return ev;
}

describe("EagleProjectPickerModal", () => {
  it("Enter picks the first selectable project by default", () => {
    const onPick = vi.fn();
    render(
      <EagleProjectPickerModal projects={buildProjects()} onPick={onPick} onClose={vi.fn()} />,
    );

    dispatchKey("Enter");

    expect(onPick).toHaveBeenCalledWith("a");
  });

  it("ArrowDown skips projects at the session cap and stops at the last one", () => {
    const onPick = vi.fn();
    render(
      <EagleProjectPickerModal projects={buildProjects()} onPick={onPick} onClose={vi.fn()} />,
    );

    dispatchKey("ArrowDown"); // alpha → (skips bravo) → charlie
    dispatchKey("Enter");
    expect(onPick).toHaveBeenLastCalledWith("c");

    dispatchKey("ArrowDown"); // charlie is the last selectable — stays put
    dispatchKey("Enter");
    expect(onPick).toHaveBeenLastCalledWith("c");
  });

  it("ArrowUp stops at the first selectable project instead of wrapping", () => {
    const onPick = vi.fn();
    render(
      <EagleProjectPickerModal projects={buildProjects()} onPick={onPick} onClose={vi.fn()} />,
    );

    dispatchKey("ArrowUp"); // alpha is the first selectable — stays put
    dispatchKey("Enter");
    expect(onPick).toHaveBeenLastCalledWith("a");

    dispatchKey("ArrowDown"); // → charlie
    dispatchKey("ArrowUp"); // charlie → (skips bravo) → alpha
    dispatchKey("Enter");
    expect(onPick).toHaveBeenLastCalledWith("a");
  });

  it("hides the list scrollbar and gives the list a tall viewport", () => {
    render(
      <EagleProjectPickerModal projects={buildProjects()} onPick={vi.fn()} onClose={vi.fn()} />,
    );

    const list = screen.getByRole("list");
    expect(list.className).toContain("scrollbar-none");
    expect(list.className).toContain("max-h-[70vh]");
  });

  it("arrow keys scroll the selected row into the list's view", () => {
    const projects: EagleProjectOption[] = Array.from({ length: 10 }, (_, i) => ({
      tabId: `p${i}`,
      name: `project-${i}`,
      color: "#fff",
      atMax: false,
    }));
    render(<EagleProjectPickerModal projects={projects} onPick={vi.fn()} onClose={vi.fn()} />);

    const ROW_HEIGHT = 30;
    const list = screen.getByRole("list");
    Object.defineProperty(list, "clientHeight", { configurable: true, value: ROW_HEIGHT * 3 });
    Array.from(list.children).forEach((row, i) => {
      Object.defineProperty(row, "offsetTop", { configurable: true, value: i * ROW_HEIGHT });
      Object.defineProperty(row, "offsetHeight", { configurable: true, value: ROW_HEIGHT });
    });

    for (let i = 0; i < 5; i++) dispatchKey("ArrowDown"); // → row 5 (bottom at 180)
    expect(list.scrollTop).toBe(6 * ROW_HEIGHT - 3 * ROW_HEIGHT);

    for (let i = 0; i < 5; i++) dispatchKey("ArrowUp"); // → row 0
    expect(list.scrollTop).toBe(0);
  });

  it("Escape closes without picking", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <EagleProjectPickerModal projects={buildProjects()} onPick={onPick} onClose={onClose} />,
    );

    const ev = dispatchKey("Escape");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("Enter is a no-op when every project is at the cap", () => {
    const onPick = vi.fn();
    const projects = buildProjects().map((p) => ({ ...p, atMax: true }));
    render(<EagleProjectPickerModal projects={projects} onPick={onPick} onClose={vi.fn()} />);

    dispatchKey("ArrowDown");
    dispatchKey("Enter");

    expect(onPick).not.toHaveBeenCalled();
  });

  it("clicking a selectable row picks it; at-cap rows are disabled", () => {
    const onPick = vi.fn();
    render(
      <EagleProjectPickerModal projects={buildProjects()} onPick={onPick} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /charlie/ }));
    expect(onPick).toHaveBeenCalledWith("c");

    expect(screen.getByRole("button", { name: /bravo/ })).toBeDisabled();
  });
});
