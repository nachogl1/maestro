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
import { CliSettingsModal } from "../CliSettingsModal";

describe("CliSettingsModal", () => {
  it("opens as a shared settings dialog with the mode tabs, sections and reset actions", () => {
    render(<CliSettingsModal onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "CLI Settings" })).toBeInTheDocument();
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
    render(<CliSettingsModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Gemini" }));
    expect(screen.getByRole("button", { name: "Reset Gemini" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("e.g., --verbose --model opus"), {
      target: { value: "--verbose" },
    });
    expect(useCliSettingsStore.getState().flags.Gemini.customFlags).toBe("--verbose");
  });

  it("closes from the shared close button", () => {
    const onClose = vi.fn();
    render(<CliSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
