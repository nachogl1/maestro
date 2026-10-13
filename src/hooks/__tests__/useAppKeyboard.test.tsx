import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAppKeyboard } from "../useAppKeyboard";

function dispatch(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(ev);
  return ev;
}

function renderAppKeyboard(overrides: Partial<Parameters<typeof useAppKeyboard>[0]> = {}) {
  const handlers = {
    onAddSession: vi.fn(),
    onSidebarTab: vi.fn(),
    onToggleGitPanel: vi.fn(),
    onToggleUtilityPanel: vi.fn(),
    onToggleEagleView: vi.fn(),
    onNextProject: vi.fn(),
    onPrevProject: vi.fn(),
  };
  renderHook(() =>
    useAppKeyboard({
      canAddSession: true,
      ...handlers,
      ...overrides,
    }),
  );
  return handlers;
}

// ctrlKey AND metaKey both set on mod-based shortcuts so tests pass
// regardless of what isMac() reports for the test environment.
const MOD = { ctrlKey: true, metaKey: true };

describe("useAppKeyboard sidebar tabs (Alt+1-3)", () => {
  it("fires onSidebarTab with the pressed tab index", () => {
    const { onSidebarTab } = renderAppKeyboard();

    for (const digit of [1, 2, 3]) {
      const ev = dispatch({ key: String(digit), code: `Digit${digit}`, altKey: true });
      expect(ev.defaultPrevented).toBe(true);
    }

    expect(onSidebarTab.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it("ignores numpad digits so Windows Alt-code entry keeps working", () => {
    const { onSidebarTab } = renderAppKeyboard();
    dispatch({ key: "2", code: "Numpad2", altKey: true });
    expect(onSidebarTab).not.toHaveBeenCalled();
  });

  it("ignores Alt+4 and Alt+digit with extra modifiers", () => {
    const { onSidebarTab } = renderAppKeyboard();

    dispatch({ key: "4", code: "Digit4", altKey: true });
    dispatch({ key: "1", code: "Digit1", altKey: true, ctrlKey: true });
    dispatch({ key: "1", code: "Digit1", altKey: true, shiftKey: true });

    expect(onSidebarTab).not.toHaveBeenCalled();
  });
});

describe("useAppKeyboard right panels (Cmd/Ctrl+2 and +5)", () => {
  it("fires onToggleGitPanel on Cmd/Ctrl+2", () => {
    const { onToggleGitPanel, onToggleUtilityPanel } = renderAppKeyboard();

    dispatch({ key: "2", code: "Digit2", ...MOD });

    expect(onToggleGitPanel).toHaveBeenCalledTimes(1);
    expect(onToggleUtilityPanel).not.toHaveBeenCalled();
  });

  it("maps Cmd/Ctrl+5 to the Notes panel and nothing to the removed digits", () => {
    const { onToggleUtilityPanel } = renderAppKeyboard();

    for (const digit of [3, 4, 5, 6]) {
      dispatch({ key: String(digit), code: `Digit${digit}`, ...MOD });
    }

    expect(onToggleUtilityPanel.mock.calls.map((c) => c[0])).toEqual(["notes"]);
  });

  it("ignores digits with Alt or Shift held", () => {
    const { onToggleUtilityPanel } = renderAppKeyboard();

    dispatch({ key: "5", code: "Digit5", ...MOD, altKey: true });
    dispatch({ key: "5", code: "Digit5", ...MOD, shiftKey: true });

    expect(onToggleUtilityPanel).not.toHaveBeenCalled();
  });
});

describe("useAppKeyboard new terminal (Cmd/Ctrl+T)", () => {
  it("fires onAddSession when allowed", () => {
    const { onAddSession } = renderAppKeyboard();
    dispatch({ key: "t", code: "KeyT", ...MOD });
    expect(onAddSession).toHaveBeenCalledTimes(1);
  });

  it("still prevents the WebView default when not allowed", () => {
    const { onAddSession } = renderAppKeyboard({ canAddSession: false });
    const ev = dispatch({ key: "t", code: "KeyT", ...MOD });
    expect(onAddSession).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe("useAppKeyboard eagle view (Cmd/Ctrl+G)", () => {
  it("fires onToggleEagleView", () => {
    const { onToggleEagleView } = renderAppKeyboard();
    dispatch({ key: "g", code: "KeyG", ...MOD });
    expect(onToggleEagleView).toHaveBeenCalledTimes(1);
  });
});

describe("useAppKeyboard project cycling (Ctrl+Tab on all platforms)", () => {
  it("fires onNextProject on Ctrl+Tab", () => {
    const { onNextProject, onPrevProject } = renderAppKeyboard();

    const ev = dispatch({ key: "Tab", code: "Tab", ctrlKey: true });

    expect(onNextProject).toHaveBeenCalledTimes(1);
    expect(onPrevProject).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("fires onPrevProject on Ctrl+Shift+Tab", () => {
    const { onNextProject, onPrevProject } = renderAppKeyboard();

    dispatch({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true });

    expect(onPrevProject).toHaveBeenCalledTimes(1);
    expect(onNextProject).not.toHaveBeenCalled();
  });

  it("ignores Tab without Ctrl and Cmd+Tab (macOS app switcher owns it)", () => {
    const { onNextProject } = renderAppKeyboard();
    dispatch({ key: "Tab", code: "Tab" });
    dispatch({ key: "Tab", code: "Tab", metaKey: true });
    expect(onNextProject).not.toHaveBeenCalled();
  });
});
