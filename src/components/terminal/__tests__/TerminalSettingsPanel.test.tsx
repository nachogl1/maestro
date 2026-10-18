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
import { TerminalSettingsPanel } from "../TerminalSettingsPanel";

describe("TerminalSettingsPanel", () => {
  beforeEach(() => {
    // Skip the font scan: happy-dom has no Tauri backend.
    useTerminalSettingsStore.setState({
      isInitialized: true,
      isLoading: false,
      availableFonts: [],
    });
  });

  it("shows its sections and the reset action", () => {
    render(<TerminalSettingsPanel />);
    for (const section of ["Font Family", "Font Size", "Zoom Level", "Line Height"]) {
      expect(screen.getByText(section)).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Reset to Defaults" })).toBeInTheDocument();
  });

  it("hides the reset action until the saved settings have loaded", () => {
    useTerminalSettingsStore.setState({ isInitialized: false, isLoading: true });
    render(<TerminalSettingsPanel />);
    expect(screen.queryByRole("button", { name: "Reset to Defaults" })).not.toBeInTheDocument();
  });

  it("applies a zoom preset", () => {
    render(<TerminalSettingsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "150%" }));
    expect(useTerminalSettingsStore.getState().settings.zoomLevel).toBe(150);
  });
});
