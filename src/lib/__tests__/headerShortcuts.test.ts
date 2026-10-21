import { afterEach, describe, expect, it, vi } from "vitest";

import { clickHeaderAction, headerActionForKey } from "../headerShortcuts";

function key(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { code, altKey: true, ...init });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("headerActionForKey", () => {
  it("maps the four header shortcuts", () => {
    expect(headerActionForKey(key("KeyR"))).toBe("rename");
    expect(headerActionForKey(key("KeyW"))).toBe("close");
    expect(headerActionForKey(key("KeyP", { shiftKey: true }))).toBe("pin");
    expect(headerActionForKey(key("KeyF", { shiftKey: true }))).toBe("flag");
  });

  it("leaves other keys alone, including Alt+P (park) and plain letters", () => {
    expect(headerActionForKey(key("KeyP"))).toBeNull();
    expect(headerActionForKey(key("KeyR", { shiftKey: true }))).toBeNull();
    expect(headerActionForKey(key("KeyR", { ctrlKey: true }))).toBeNull();
    expect(headerActionForKey(new KeyboardEvent("keydown", { code: "KeyR" }))).toBeNull();
  });
});

describe("clickHeaderAction", () => {
  function mountPane(slotId: string, actions: string[]): Record<string, () => void> {
    const pane = document.createElement("div");
    pane.dataset.slotId = slotId;
    const clicks: Record<string, () => void> = {};
    for (const action of actions) {
      const button = document.createElement("button");
      button.dataset.headerAction = action;
      clicks[action] = vi.fn();
      button.addEventListener("click", clicks[action]);
      pane.appendChild(button);
    }
    document.body.appendChild(pane);
    return clicks;
  }

  it("clicks the matching control inside the given pane only", () => {
    const a = mountPane("slot-a", ["close"]);
    const b = mountPane("slot-b", ["close"]);

    expect(clickHeaderAction("slot-b", "close")).toBe(true);

    expect(b.close).toHaveBeenCalledTimes(1);
    expect(a.close).not.toHaveBeenCalled();
  });

  it("returns false when the pane has no such control", () => {
    mountPane("slot-a", ["close"]);
    expect(clickHeaderAction("slot-a", "pin")).toBe(false);
    expect(clickHeaderAction("slot-missing", "close")).toBe(false);
  });
});
