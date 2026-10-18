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
  it("shows the mode tabs, sections and reset actions", () => {
    render(<CliSettingsPanel />);
    for (const mode of ["Claude", "Gemini", "Codex", "OpenCode"]) {
      expect(screen.getByRole("button", { name: mode })).toBeInTheDocument();
    }
    for (const section of ["Permissions", "Custom Flags", "Command Preview"]) {
      expect(screen.getByText(section)).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Reset All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset Claude" })).toBeInTheDocument();
  });

  it("switches the active mode and stores that mode's custom flags", () => {
    render(<CliSettingsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Gemini" }));
    expect(screen.getByRole("button", { name: "Reset Gemini" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("e.g., --verbose --model opus"), {
      target: { value: "--verbose" },
    });
    expect(useCliSettingsStore.getState().flags.Gemini.customFlags).toBe("--verbose");
  });
});
