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
    onTogglePanel: vi.fn(),
    onToggleEagleView: vi.fn(),
    onNextProject: vi.fn(),
    onPrevProject: vi.fn(),
    onOpenIssueMap: vi.fn(),
    onOpenConclave: vi.fn(),
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

describe("useAppKeyboard panel shortcuts (Alt+1-4) open the same panels as before the icon strip", () => {
  it("maps Alt+1 to History, Alt+2 to Infra, Alt+3 to Settings and Alt+4 to the Injector", () => {
    const { onTogglePanel } = renderAppKeyboard();

    for (const digit of [1, 2, 3, 4]) {
      const ev = dispatch({ key: String(digit), code: `Digit${digit}`, altKey: true });
      expect(ev.defaultPrevented).toBe(true);
    }

    expect(onTogglePanel.mock.calls.map((c) => c[0])).toEqual([
      "history",
      "infra",
      "settings",
      "inject",
    ]);
  });

  it("ignores numpad digits so Windows Alt-code entry keeps working", () => {
    const { onTogglePanel } = renderAppKeyboard();
    const ev = dispatch({ key: "2", code: "Numpad2", altKey: true });
    expect(onTogglePanel).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("ignores Alt+5 and Alt+digit with extra modifiers", () => {
    const { onTogglePanel } = renderAppKeyboard();

    dispatch({ key: "5", code: "Digit5", altKey: true });
    dispatch({ key: "1", code: "Digit1", altKey: true, ctrlKey: true });
    dispatch({ key: "1", code: "Digit1", altKey: true, shiftKey: true });

    expect(onTogglePanel).not.toHaveBeenCalled();
  });
});

describe("useAppKeyboard panel shortcuts (Cmd/Ctrl+2 and +5)", () => {
  it("maps Cmd/Ctrl+2 to the Git panel, top row or numpad", () => {
    const { onTogglePanel } = renderAppKeyboard();

    dispatch({ key: "2", code: "Digit2", ...MOD });
    dispatch({ key: "2", code: "Numpad2", ...MOD });

    expect(onTogglePanel.mock.calls.map((c) => c[0])).toEqual(["git", "git"]);
  });

  it("maps Cmd/Ctrl+5 to the Notes panel and nothing to the other digits", () => {
    const { onTogglePanel } = renderAppKeyboard();

    for (const digit of [3, 4, 5, 6]) {
      dispatch({ key: String(digit), code: `Digit${digit}`, ...MOD });
    }

    expect(onTogglePanel.mock.calls.map((c) => c[0])).toEqual(["notes"]);
  });

  it("ignores digits with Alt or Shift held", () => {
    const { onTogglePanel } = renderAppKeyboard();

    dispatch({ key: "5", code: "Digit5", ...MOD, altKey: true });
    dispatch({ key: "5", code: "Digit5", ...MOD, shiftKey: true });

    expect(onTogglePanel).not.toHaveBeenCalled();
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

describe("useAppKeyboard issue map (Alt+M)", () => {
  it("opens the issue map and keeps the key from reaching the terminal", () => {
    const { onOpenIssueMap } = renderAppKeyboard();
    const ev = dispatch({ key: "m", code: "KeyM", altKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(onOpenIssueMap).toHaveBeenCalledTimes(1);
  });

  it("leaves Alt+Shift+M and Ctrl+Alt+M alone", () => {
    const { onOpenIssueMap } = renderAppKeyboard();
    dispatch({ key: "M", code: "KeyM", altKey: true, shiftKey: true });
    dispatch({ key: "m", code: "KeyM", altKey: true, ctrlKey: true });
    expect(onOpenIssueMap).not.toHaveBeenCalled();
  });
});

describe("useAppKeyboard Conclave (Alt+C)", () => {
  it("opens the Conclave dialog and keeps the key from reaching the terminal", () => {
    const { onOpenConclave } = renderAppKeyboard();
    const ev = dispatch({ key: "c", code: "KeyC", altKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(onOpenConclave).toHaveBeenCalledTimes(1);
  });

  it("leaves Alt+Shift+C and Ctrl+Alt+C alone", () => {
    const { onOpenConclave } = renderAppKeyboard();
    dispatch({ key: "C", code: "KeyC", altKey: true, shiftKey: true });
    dispatch({ key: "c", code: "KeyC", altKey: true, ctrlKey: true });
    expect(onOpenConclave).not.toHaveBeenCalled();
  });
});
