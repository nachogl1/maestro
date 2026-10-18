import { invoke } from "@tauri-apps/api/core";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatesSettingsPanel } from "../UpdatesSettingsPanel";

const platform = vi.hoisted(() => ({ windows: true }));
vi.mock("@/lib/platform", () => ({
  isMac: () => false,
  isWindows: () => platform.windows,
}));

const invokeMock = vi.mocked(invoke);

describe("UpdatesSettingsPanel CLI section by platform", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "is_cli_installed") return false;
      if (cmd === "get_app_version") return "0.3.9";
      return null;
    });
  });

  it("offers no install button on Windows, where the backend refuses", async () => {
    platform.windows = true;
    render(<UpdatesSettingsPanel />);

    expect(await screen.findByText("Not available on Windows.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Install 'maestro' command/ })).toBeNull();
  });

  it("offers the install button on macOS and Linux", async () => {
    platform.windows = false;
    render(<UpdatesSettingsPanel />);

    const button = await screen.findByRole("button", { name: /Install 'maestro' command/ });
    expect(button.getAttribute("title")).not.toMatch(/Windows/);
    expect(screen.queryByText("Not available on Windows.")).toBeNull();
  });
});
