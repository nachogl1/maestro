import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { ContextAlertSection } from "../ContextAlertSection";

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
    expect(useContextAlertStore.getState().threshold).toBe(80);
  });
});
