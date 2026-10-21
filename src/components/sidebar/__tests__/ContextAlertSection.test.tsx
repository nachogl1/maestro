import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The persisted store hydrates through the Tauri store plugin at import time;
// happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

import { useContextAlertStore } from "@/stores/useContextAlertStore";
import { CONTEXT_ALERT_APPLY_DELAY_MS, ContextAlertSection } from "../ContextAlertSection";

function input(): HTMLInputElement {
  return screen.getByLabelText("Context alert threshold") as HTMLInputElement;
}

describe("ContextAlertSection", () => {
  beforeEach(() => {
    useContextAlertStore.setState({ threshold: 80 });
  });

  it("shows the current threshold in a numeric input", () => {
    render(<ContextAlertSection />);
    expect(input().type).toBe("number");
    expect(input().value).toBe("80");
    expect(screen.getByLabelText("Toggle context alert")).toHaveAttribute("aria-checked", "true");
  });

  it("explains the threshold in the input's hover text instead of a paragraph", () => {
    render(<ContextAlertSection />);
    expect(input().title).toMatch(/blinks red/);
    expect(screen.queryByText(/the switch turns the alert off/)).toBeNull();
  });

  it("typing a percentage stores it on blur, not per keystroke", () => {
    render(<ContextAlertSection />);
    fireEvent.change(input(), { target: { value: "6" } });
    fireEvent.change(input(), { target: { value: "65" } });
    expect(useContextAlertStore.getState().threshold).toBe(80);
    fireEvent.blur(input());
    expect(useContextAlertStore.getState().threshold).toBe(65);
  });

  it("Enter applies the typed percentage", () => {
    render(<ContextAlertSection />);
    fireEvent.change(input(), { target: { value: "42" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(useContextAlertStore.getState().threshold).toBe(42);
  });

  it("clamps values outside 1-100 and rounds decimals", () => {
    render(<ContextAlertSection />);
    fireEvent.change(input(), { target: { value: "150" } });
    fireEvent.blur(input());
    expect(useContextAlertStore.getState().threshold).toBe(100);
    expect(input().value).toBe("100");

    fireEvent.change(input(), { target: { value: "0" } });
    fireEvent.blur(input());
    expect(useContextAlertStore.getState().threshold).toBe(1);

    fireEvent.change(input(), { target: { value: "72.6" } });
    fireEvent.blur(input());
    expect(useContextAlertStore.getState().threshold).toBe(73);
  });

  it("reverts text that is not a number and keeps the stored threshold", () => {
    render(<ContextAlertSection />);
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.blur(input());
    expect(useContextAlertStore.getState().threshold).toBe(80);
    expect(input().value).toBe("80");
  });

  describe("applies a changed number once the user stops typing", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("stores the typed percentage after the typing pause, without blur or Enter", () => {
      render(<ContextAlertSection />);
      fireEvent.change(input(), { target: { value: "9" } });
      fireEvent.change(input(), { target: { value: "95" } });
      // Mid-typing ("9" on the way to "95") nothing is applied yet.
      act(() => {
        vi.advanceTimersByTime(CONTEXT_ALERT_APPLY_DELAY_MS - 1);
      });
      expect(useContextAlertStore.getState().threshold).toBe(80);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(useContextAlertStore.getState().threshold).toBe(95);
    });

    it("restarts the pause on every keystroke so a partial number never fires", () => {
      render(<ContextAlertSection />);
      fireEvent.change(input(), { target: { value: "9" } });
      act(() => {
        vi.advanceTimersByTime(CONTEXT_ALERT_APPLY_DELAY_MS - 50);
      });
      fireEvent.change(input(), { target: { value: "95" } });
      act(() => {
        vi.advanceTimersByTime(CONTEXT_ALERT_APPLY_DELAY_MS - 50);
      });
      expect(useContextAlertStore.getState().threshold).toBe(80);
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(useContextAlertStore.getState().threshold).toBe(95);
    });

    it("Enter applies at once and cancels the pending pause", () => {
      render(<ContextAlertSection />);
      fireEvent.change(input(), { target: { value: "60" } });
      fireEvent.keyDown(input(), { key: "Enter" });
      expect(useContextAlertStore.getState().threshold).toBe(60);
      // A later edit followed by the pause still applies normally.
      fireEvent.change(input(), { target: { value: "70" } });
      act(() => {
        vi.advanceTimersByTime(CONTEXT_ALERT_APPLY_DELAY_MS);
      });
      expect(useContextAlertStore.getState().threshold).toBe(70);
    });

    it("blur applies at once and the pause does not re-apply afterwards", () => {
      const setThreshold = vi.spyOn(useContextAlertStore.getState(), "setThreshold");
      render(<ContextAlertSection />);
      fireEvent.change(input(), { target: { value: "55" } });
      fireEvent.blur(input());
      expect(useContextAlertStore.getState().threshold).toBe(55);
      const callsAfterBlur = setThreshold.mock.calls.length;
      act(() => {
        vi.advanceTimersByTime(CONTEXT_ALERT_APPLY_DELAY_MS * 2);
      });
      expect(setThreshold.mock.calls.length).toBe(callsAfterBlur);
      setThreshold.mockRestore();
    });

    it("leaves text that is not a number alone until blur, keeping the stored threshold", () => {
      render(<ContextAlertSection />);
      fireEvent.change(input(), { target: { value: "" } });
      act(() => {
        vi.advanceTimersByTime(CONTEXT_ALERT_APPLY_DELAY_MS);
      });
      expect(useContextAlertStore.getState().threshold).toBe(80);
      // The field keeps what the user typed so they can finish the number.
      expect(input().value).toBe("");
    });

    it("switching the alert off cancels a number still waiting to apply", () => {
      render(<ContextAlertSection />);
      fireEvent.change(input(), { target: { value: "95" } });
      fireEvent.click(screen.getByLabelText("Toggle context alert"));
      expect(useContextAlertStore.getState().threshold).toBeNull();
      act(() => {
        vi.advanceTimersByTime(CONTEXT_ALERT_APPLY_DELAY_MS);
      });
      expect(useContextAlertStore.getState().threshold).toBeNull();
    });

    it("a pause-apply leaves the text under the cursor alone until blur", () => {
      render(<ContextAlertSection />);
      input().focus();
      fireEvent.change(input(), { target: { value: "150" } });
      act(() => {
        vi.advanceTimersByTime(CONTEXT_ALERT_APPLY_DELAY_MS);
      });
      expect(useContextAlertStore.getState().threshold).toBe(100);
      expect(input().value).toBe("150");
      fireEvent.blur(input());
      expect(input().value).toBe("100");
    });

    it("unmounting with a pending edit does not apply it later", () => {
      const { unmount } = render(<ContextAlertSection />);
      fireEvent.change(input(), { target: { value: "33" } });
      unmount();
      act(() => {
        vi.advanceTimersByTime(CONTEXT_ALERT_APPLY_DELAY_MS);
      });
      expect(useContextAlertStore.getState().threshold).toBe(80);
    });
  });

  it("the switch turns the alert off and back on at the previous percentage", () => {
    render(<ContextAlertSection />);
    const toggle = screen.getByLabelText("Toggle context alert");
    fireEvent.click(toggle);
    expect(useContextAlertStore.getState().threshold).toBeNull();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(input().disabled).toBe(true);
    expect(input().value).toBe("80");

    fireEvent.click(toggle);
    expect(useContextAlertStore.getState().threshold).toBe(80);
    expect(input().disabled).toBe(false);
  });

  it("starts off with the default percentage ready when the alert is off", () => {
    useContextAlertStore.setState({ threshold: null });
    render(<ContextAlertSection />);
    expect(input().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Toggle context alert"));
    expect(useContextAlertStore.getState().threshold).toBe(35);
  });
});
