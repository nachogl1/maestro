import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The store persists through the Tauri store plugin; happy-dom has no Tauri
// backend, so stub it out.
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

import { useCliSettingsStore } from "@/stores/useCliSettingsStore";
import { CliSettingsPanel } from "../CliSettingsPanel";

describe("CliSettingsPanel", () => {
  it("shows the Claude tab as the only mode, its sections and reset actions", () => {
    render(<CliSettingsPanel />);
    const modeTabs = screen
      .getAllByRole("button")
      .filter((button) => !button.textContent?.includes("Reset"));
    expect(modeTabs.map((tab) => tab.textContent)).toEqual(["Claude"]);
    for (const section of ["Permissions", "Custom Flags", "Command Preview"]) {
      expect(screen.getByText(section)).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Reset All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset Claude" })).toBeInTheDocument();
  });

  it("stores the custom flags typed for Claude and shows them in the preview", () => {
    render(<CliSettingsPanel />);
    fireEvent.change(screen.getByPlaceholderText("e.g., --verbose --model opus"), {
      target: { value: "--verbose" },
    });
    expect(useCliSettingsStore.getState().flags.Claude.customFlags).toBe("--verbose");
    expect(screen.getByText("claude --verbose")).toBeInTheDocument();
  });
});
