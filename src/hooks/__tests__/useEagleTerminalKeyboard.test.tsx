import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useEagleTerminalKeyboard } from "../useEagleTerminalKeyboard";

/** A pane host with a focusable input inside, like an eagle tile's xterm textarea. */
function mountPane(slotId: string): HTMLTextAreaElement {
  const host = document.createElement("div");
  host.dataset.slotId = slotId;
  const input = document.createElement("textarea");
  host.appendChild(input);
  document.body.appendChild(host);
  return input;
}

/** metaKey AND ctrlKey both set so the test passes whatever isMac() reports. */
function pressZoom(target: EventTarget): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    code: "Digit1",
    key: "1",
    ctrlKey: true,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev;
}

function pressPark(target: EventTarget): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    code: "KeyP",
    key: "p",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useEagleTerminalKeyboard", () => {
  it("zooms the pane the key was pressed in", () => {
    const onToggleZoom = vi.fn(() => true);
    renderHook(() => useEagleTerminalKeyboard({ enabled: true, onToggleZoom, onPark: vi.fn() }));
    const ev = pressZoom(mountPane("slot-a"));
    expect(onToggleZoom).toHaveBeenCalledWith("slot-a");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("parks the pane the key was pressed in and stops the key reaching the terminal", () => {
    const onPark = vi.fn(() => true);
    renderHook(() => useEagleTerminalKeyboard({ enabled: true, onToggleZoom: vi.fn(), onPark }));
    const input = mountPane("slot-b");
    const inner = vi.fn();
    input.addEventListener("keydown", inner);
    const ev = pressPark(input);
    expect(onPark).toHaveBeenCalledWith("slot-b");
    expect(ev.defaultPrevented).toBe(true);
    expect(inner).not.toHaveBeenCalled();
  });

  it("lets the key through when the pane belongs to another grid", () => {
    const onPark = vi.fn(() => false);
    renderHook(() => useEagleTerminalKeyboard({ enabled: true, onToggleZoom: vi.fn(), onPark }));
    const ev = pressPark(mountPane("slot-c"));
    expect(onPark).toHaveBeenCalledWith("slot-c");
    expect(ev.defaultPrevented).toBe(false);
  });

  it("ignores keys pressed outside any pane", () => {
    const onToggleZoom = vi.fn(() => true);
    renderHook(() => useEagleTerminalKeyboard({ enabled: true, onToggleZoom, onPark: vi.fn() }));
    pressZoom(document.body);
    expect(onToggleZoom).not.toHaveBeenCalled();
  });

  it("does nothing while disabled", () => {
    const onToggleZoom = vi.fn(() => true);
    const onPark = vi.fn(() => true);
    renderHook(() => useEagleTerminalKeyboard({ enabled: false, onToggleZoom, onPark }));
    const input = mountPane("slot-d");
    pressZoom(input);
    pressPark(input);
    expect(onToggleZoom).not.toHaveBeenCalled();
    expect(onPark).not.toHaveBeenCalled();
  });
});
