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

describe("ContextAlertSection", () => {
  beforeEach(() => {
    useContextAlertStore.setState({ threshold: 80 });
  });

  it("shows the current threshold", () => {
    render(<ContextAlertSection />);
    const select = screen.getByLabelText("Context alert threshold") as HTMLSelectElement;
    expect(select.value).toBe("80");
  });

  it("picking another percentage stores it", () => {
    render(<ContextAlertSection />);
    fireEvent.change(screen.getByLabelText("Context alert threshold"), {
      target: { value: "90" },
    });
    expect(useContextAlertStore.getState().threshold).toBe(90);
  });

  it("picking Off disables the alert and shows Off", () => {
    render(<ContextAlertSection />);
    const select = screen.getByLabelText("Context alert threshold") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "off" } });
    expect(useContextAlertStore.getState().threshold).toBeNull();
    expect(select.value).toBe("off");
  });
});
