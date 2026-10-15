import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useTerminalKeyboard } from "../useTerminalKeyboard";

/**
 * Dispatch a keydown synthesizing what xterm does when it consumes a key:
 * sets `stopImmediatePropagation` to short-circuit bubble-phase listeners.
 * Our capture-phase handlers must intercept BEFORE xterm sees the event, so
 * any listener attached to a deeper element should never run.
 */
function dispatchAltArrow(key: "ArrowLeft" | "ArrowRight"): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key,
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(ev);
  return ev;
}

/**
 * Cmd/Ctrl+Alt+Arrow. metaKey AND ctrlKey both set so the test passes
 * regardless of what isMac() reports for the test environment.
 */
function dispatchModAltArrow(key: "ArrowLeft" | "ArrowRight"): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key,
    altKey: true,
    ctrlKey: true,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(ev);
  return ev;
}

function renderKeyboardHook(overrides: Partial<Parameters<typeof useTerminalKeyboard>[0]> = {}) {
  const handlers = {
    onCycleNext: vi.fn(),
    onCyclePrevious: vi.fn(),
    onZoomedNext: vi.fn(),
    onZoomedPrev: vi.fn(),
    onParkFocused: vi.fn(),
  };
  renderHook(() =>
    useTerminalKeyboard({
      terminalCount: 3,
      ...handlers,
      ...overrides,
    }),
  );
  return handlers;
}

describe("useTerminalKeyboard Alt+Arrow tab navigation", () => {
  it("does not fire onZoomedNext/Prev when isZoomed is false", () => {
    const { onZoomedNext, onZoomedPrev } = renderKeyboardHook({ isZoomed: false });

    dispatchAltArrow("ArrowRight");
    dispatchAltArrow("ArrowLeft");

    expect(onZoomedNext).not.toHaveBeenCalled();
    expect(onZoomedPrev).not.toHaveBeenCalled();
  });

  it("fires onZoomedNext on Alt+Right when isZoomed is true and prevents default", () => {
    const { onZoomedNext, onZoomedPrev } = renderKeyboardHook({ isZoomed: true });

    const ev = dispatchAltArrow("ArrowRight");

    expect(onZoomedNext).toHaveBeenCalledTimes(1);
    expect(onZoomedPrev).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("fires onZoomedPrev on Alt+Left when isZoomed is true and prevents default", () => {
    const { onZoomedNext, onZoomedPrev } = renderKeyboardHook({ isZoomed: true });

    const ev = dispatchAltArrow("ArrowLeft");

    expect(onZoomedPrev).toHaveBeenCalledTimes(1);
    expect(onZoomedNext).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("is registered in capture phase so xterm-style stopPropagation cannot block it", () => {
    const { onZoomedNext } = renderKeyboardHook({ isZoomed: true });

    // A bubble-phase listener on document that calls stopImmediatePropagation
    // simulates xterm's textarea/keydown handler.
    const sink = vi.fn((e: Event) => e.stopImmediatePropagation());
    document.addEventListener("keydown", sink);

    dispatchAltArrow("ArrowRight");

    expect(onZoomedNext).toHaveBeenCalledTimes(1);

    document.removeEventListener("keydown", sink);
  });

  it("does not register the capture listener when enabled=false", () => {
    const { onZoomedNext } = renderKeyboardHook({ isZoomed: true, enabled: false });
    dispatchAltArrow("ArrowRight");
    expect(onZoomedNext).not.toHaveBeenCalled();
  });
});

describe("useTerminalKeyboard Cmd/Ctrl+Alt+Arrow focus cycling", () => {
  it("fires onCycleNext on Cmd/Ctrl+Alt+Right and prevents default", () => {
    const { onCycleNext, onCyclePrevious } = renderKeyboardHook();

    const ev = dispatchModAltArrow("ArrowRight");

    expect(onCycleNext).toHaveBeenCalledTimes(1);
    expect(onCyclePrevious).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("fires onCyclePrevious on Cmd/Ctrl+Alt+Left", () => {
    const { onCycleNext, onCyclePrevious } = renderKeyboardHook();

    dispatchModAltArrow("ArrowLeft");

    expect(onCyclePrevious).toHaveBeenCalledTimes(1);
    expect(onCycleNext).not.toHaveBeenCalled();
  });

  it("does not cycle when no terminals are launched", () => {
    const { onCycleNext } = renderKeyboardHook({ terminalCount: 0 });
    dispatchModAltArrow("ArrowRight");
    expect(onCycleNext).not.toHaveBeenCalled();
  });

  it("does not treat Cmd/Ctrl+Alt+Arrow as zoomed tab navigation", () => {
    const { onCycleNext, onZoomedNext } = renderKeyboardHook({ isZoomed: true });
    dispatchModAltArrow("ArrowRight");
    expect(onCycleNext).toHaveBeenCalledTimes(1);
    expect(onZoomedNext).not.toHaveBeenCalled();
  });
});

describe("useTerminalKeyboard Cmd/Ctrl+1 zoom toggle", () => {
  function dispatchMod1(extra: KeyboardEventInit = {}): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", {
      key: "1",
      code: "Digit1",
      ctrlKey: true,
      metaKey: true,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    window.dispatchEvent(ev);
    return ev;
  }

  it("fires onToggleZoomFocused on Cmd/Ctrl+1 and prevents default", () => {
    const onToggleZoomFocused = vi.fn();
    renderKeyboardHook({ onToggleZoomFocused });

    const ev = dispatchMod1();

    expect(onToggleZoomFocused).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("ignores Cmd/Ctrl+1 with Alt or Shift held", () => {
    const onToggleZoomFocused = vi.fn();
    renderKeyboardHook({ onToggleZoomFocused });

    dispatchMod1({ altKey: true });
    dispatchMod1({ shiftKey: true });

    expect(onToggleZoomFocused).not.toHaveBeenCalled();
  });
});

describe("useTerminalKeyboard Alt+P park", () => {
  function dispatchAltP(extra: KeyboardEventInit = {}): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", {
      key: "p",
      code: "KeyP",
      altKey: true,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    window.dispatchEvent(ev);
    return ev;
  }

  it("fires onParkFocused on Alt+P and prevents default", () => {
    const { onParkFocused } = renderKeyboardHook();

    const ev = dispatchAltP();

    expect(onParkFocused).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("ignores Alt+P when Ctrl or Shift is also pressed", () => {
    const { onParkFocused } = renderKeyboardHook();

    dispatchAltP({ ctrlKey: true });
    dispatchAltP({ shiftKey: true });

    expect(onParkFocused).not.toHaveBeenCalled();
  });

  it("does not fire when enabled=false", () => {
    const { onParkFocused } = renderKeyboardHook({ enabled: false });
    dispatchAltP();
    expect(onParkFocused).not.toHaveBeenCalled();
  });
});

describe("useTerminalKeyboard Alt+Shift+Arrow pane moves", () => {
  function dispatchAltShiftArrow(key: string): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", {
      key,
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    return ev;
  }

  it("moves the focused pane in the arrow's direction and prevents default", () => {
    const onMoveFocused = vi.fn();
    renderKeyboardHook({ onMoveFocused });

    const ev = dispatchAltShiftArrow("ArrowDown");

    expect(onMoveFocused).toHaveBeenCalledWith("down");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does not treat Alt+Shift+Arrow as a zoom-tab or focus cycle", () => {
    const onMoveFocused = vi.fn();
    const { onZoomedNext, onCycleNext } = renderKeyboardHook({ onMoveFocused, isZoomed: true });

    dispatchAltShiftArrow("ArrowRight");

    expect(onMoveFocused).toHaveBeenCalledWith("right");
    expect(onZoomedNext).not.toHaveBeenCalled();
    expect(onCycleNext).not.toHaveBeenCalled();
  });

  it("leaves Alt+Shift+Arrow alone when no move handler is given", () => {
    renderKeyboardHook({ onMoveFocused: undefined });

    const ev = dispatchAltShiftArrow("ArrowLeft");

    expect(ev.defaultPrevented).toBe(false);
  });
});
