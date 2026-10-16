import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The update store persists through the Tauri store plugin; happy-dom has no
// Tauri backend, so stub it out.
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

import { useUpdateStore } from "@/stores/useUpdateStore";
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

const UPDATE = {
  available: true,
  current_version: "0.3.9",
  latest_version: "0.3.10",
  release_notes: null,
  date: null,
};

describe("MaestroSettingsModal check now", () => {
  beforeEach(() => {
    useUpdateStore.setState({
      status: "idle",
      updateInfo: null,
      error: null,
      lastCheckedAt: null,
      dismissedVersion: "0.3.10",
      customEndpoint: null,
    });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "samurai_get_config") return SAMURAI_CONFIG;
      if (cmd === "is_cli_installed") return false;
      if (cmd === "get_app_version") return "0.3.9";
      if (cmd === "check_for_updates") return UPDATE;
      if (cmd === "load_work_journal") {
        return { layout_version: 1, pages: {}, deleted_dates: [], settings: {} };
      }
      if (cmd === "work_journal_restore_state") return { canUndo: false };
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  it("renders at the top level of the document, above the terminal area", () => {
    const { container } = render(
      <div data-testid="host">
        <MaestroSettingsModal onClose={() => {}} />
      </div>,
    );
    const heading = screen.getByText("Maestro Settings");
    // A portal: the dialog is not inside the component that opened it...
    expect(container.querySelector('[data-testid="host"]')?.contains(heading)).toBe(false);
    // ...and its backdrop outranks the z-50 tab bar and zoomed panes.
    const backdrop = heading.closest(".fixed");
    expect(backdrop?.parentElement).toBe(document.body);
    expect(backdrop?.className).toContain("z-[100]");
  });

  it("re-shows an update the user dismissed earlier", async () => {
    render(<MaestroSettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByTitle("Look for a newer version of Maestro right now."));
    await waitFor(() => expect(useUpdateStore.getState().status).toBe("available"));
    expect(invokeMock).toHaveBeenCalledWith("check_for_updates", { customEndpoint: null });
    expect(useUpdateStore.getState().dismissedVersion).toBeNull();
  });
});
