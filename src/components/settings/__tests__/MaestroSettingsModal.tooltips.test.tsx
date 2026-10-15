import { invoke } from "@tauri-apps/api/core";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MaestroSettingsModal } from "../MaestroSettingsModal";

const invokeMock = vi.mocked(invoke);

const SAMURAI_CONFIG = {
  handoff_context_pct: 40,
  park_soft_5h_pct: 78,
  park_hard_5h_pct: 90,
  park_hard_7d_pct: 95,
  ack_timeout_secs: 180,
  max_turn_wait_secs: 1800,
  staleness_window_secs: 600,
  handoff_retention_days: 14,
  breaker_events: 20,
  size_warn_bytes: 1_000_000,
};

const SAMURAI_LABELS = [
  "Handoff trigger (context %)",
  "Park soft, 5h window (%)",
  "Park hard, 5h window (%)",
  "Park hard, 7d window (%)",
  "ACK timeout (seconds)",
  "Max turn wait (seconds)",
  "Staleness window (seconds)",
  "Handoff retention (days)",
  "Circuit breaker events (zero-progress trip)",
  "File size warning (bytes)",
];

/** The `title` hover text of `element` or its nearest ancestor that has one. */
function hoverText(element: HTMLElement): string | null {
  return element.closest("[title]")?.getAttribute("title") ?? null;
}

describe("MaestroSettingsModal tooltips", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "samurai_get_config") return SAMURAI_CONFIG;
      if (cmd === "is_cli_installed") return false;
      if (cmd === "get_app_version") return "0.3.9";
      // The embedded Work Journal section loads its own settings.
      if (cmd === "load_work_journal") {
        return { layout_version: 1, pages: {}, deleted_dates: [], settings: {} };
      }
      if (cmd === "work_journal_restore_state") return { canUndo: false };
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  it("explains every Samurai threshold in a hover tooltip", async () => {
    render(<MaestroSettingsModal onClose={() => {}} />);

    for (const label of SAMURAI_LABELS) {
      const row = await screen.findByText(label);
      const hint = hoverText(row);
      expect(hint, label).toBeTruthy();
      // Plain language, not just the label repeated.
      expect(hint, label).not.toBe(label);
      expect(hint?.length ?? 0, label).toBeGreaterThan(40);
    }
    expect(hoverText(screen.getByText("Samurai Thresholds"))).toMatch(/supervisor/);
  });

  it("explains the update, CLI and advanced settings in hover tooltips", async () => {
    render(<MaestroSettingsModal onClose={() => {}} />);

    expect(hoverText(screen.getByText("Auto-check"))).toMatch(/newer versions/);
    expect(hoverText(screen.getByText("Interval"))).toMatch(/How often/);
    expect(hoverText(screen.getByText("CLI Command"))).toMatch(/terminal window/);
    expect(
      hoverText(await screen.findByRole("button", { name: /Install 'maestro' command/ })),
    ).toMatch(/Adds the maestro command/);
    expect(hoverText(screen.getByRole("button", { name: /Advanced/ }))).toMatch(/most people/);
  });
});
