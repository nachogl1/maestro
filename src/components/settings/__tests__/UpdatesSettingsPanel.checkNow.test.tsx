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
import { UpdatesSettingsPanel } from "../UpdatesSettingsPanel";

const invokeMock = vi.mocked(invoke);

const UPDATE = {
  available: true,
  current_version: "0.3.9",
  latest_version: "0.3.10",
  release_notes: null,
  date: null,
};

describe("UpdatesSettingsPanel check now", () => {
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
      if (cmd === "is_cli_installed") return false;
      if (cmd === "get_app_version") return "0.3.9";
      if (cmd === "check_for_updates") return UPDATE;
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  it("re-shows an update the user dismissed earlier", async () => {
    render(<UpdatesSettingsPanel />);
    fireEvent.click(screen.getByTitle("Look for a newer version of Maestro right now."));
    await waitFor(() => expect(useUpdateStore.getState().status).toBe("available"));
    expect(invokeMock).toHaveBeenCalledWith("check_for_updates", { customEndpoint: null });
    expect(useUpdateStore.getState().dismissedVersion).toBeNull();
  });

  it("the Install on launch toggle saves the auto-install choice", () => {
    useUpdateStore.setState({ autoInstallOnLaunch: null });
    render(<UpdatesSettingsPanel />);
    const toggle = screen.getByRole("switch", { name: "Toggle install on launch" });
    fireEvent.click(toggle);
    expect(useUpdateStore.getState().autoInstallOnLaunch).toBe(true);
    fireEvent.click(toggle);
    expect(useUpdateStore.getState().autoInstallOnLaunch).toBe(false);
  });
});
