import { invoke } from "@tauri-apps/api/core";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";
import { UpdatesSettingsPanel } from "../UpdatesSettingsPanel";
import { WorkJournalSettingsSection } from "../WorkJournalSettingsSection";

const invokeMock = vi.mocked(invoke);

// The Work Journal switch persists through the Tauri store plugin; happy-dom
// has no Tauri backend, so stub it out.
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

/** The `title` hover text of `element` or its nearest ancestor that has one. */
function hoverText(element: HTMLElement): string | null {
  return element.closest("[title]")?.getAttribute("title") ?? null;
}

describe("settings panel tooltips", () => {
  beforeEach(() => {
    // The full Work Journal section shows only once the user turned the journal on.
    useWorkJournalSettingsStore.setState({ enabled: true });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "is_cli_installed") return false;
      if (cmd === "get_app_version") return "0.3.9";
      if (cmd === "load_work_journal") {
        return { layout_version: 1, pages: {}, deleted_dates: [], settings: {} };
      }
      if (cmd === "work_journal_restore_state") return { canUndo: false };
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  it("explains the update, CLI and advanced settings in hover tooltips", async () => {
    render(<UpdatesSettingsPanel />);

    expect(hoverText(screen.getByText("Auto-check"))).toMatch(/newer versions/);
    expect(hoverText(screen.getByText("Interval"))).toMatch(/How often/);
    expect(hoverText(screen.getByText("CLI Command"))).toMatch(/terminal window/);
    expect(
      hoverText(await screen.findByRole("button", { name: /Install 'maestro' command/ })),
    ).toMatch(/Adds the maestro command/);
    expect(hoverText(screen.getByRole("button", { name: /Advanced/ }))).toMatch(/most people/);
  });

  it("explains the Work Journal settings in hover tooltips", async () => {
    render(<WorkJournalSettingsSection />);

    expect(hoverText(await screen.findByText("Run every"))).toMatch(/How often/);
    expect(hoverText(screen.getByText("Model"))).toMatch(/suggestions and the supervisor report/);
    expect(hoverText(screen.getByText("Granola meeting notes"))).toMatch(/meetings/);
    expect(hoverText(screen.getByText("Backup folder"))).toMatch(/safety net/);
    expect(hoverText(screen.getByText("Report folder"))).toBeTruthy();
  });
});
