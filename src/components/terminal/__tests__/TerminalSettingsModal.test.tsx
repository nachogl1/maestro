import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The store persists through the Tauri store plugin and listens for zoom
// events; happy-dom has no Tauri backend, so stub both out.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));

import { useTerminalSettingsStore } from "@/stores/useTerminalSettingsStore";
import { TerminalSettingsModal } from "../TerminalSettingsModal";

describe("TerminalSettingsModal", () => {
  beforeEach(() => {
    // Skip the font scan: happy-dom has no Tauri backend.
    useTerminalSettingsStore.setState({
      isInitialized: true,
      isLoading: false,
      availableFonts: [],
    });
  });

  it("opens as a shared settings dialog with its sections and the reset action", () => {
    render(<TerminalSettingsModal onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Terminal Settings" })).toBeInTheDocument();
    for (const section of ["Font Family", "Font Size", "Zoom Level", "Line Height"]) {
      expect(screen.getByText(section)).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Reset to Defaults" })).toBeInTheDocument();
  });

  it("closes from the shared close button", () => {
    const onClose = vi.fn();
    render(<TerminalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("applies a zoom preset", () => {
    render(<TerminalSettingsModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "150%" }));
    expect(useTerminalSettingsStore.getState().settings.zoomLevel).toBe(150);
  });
});
