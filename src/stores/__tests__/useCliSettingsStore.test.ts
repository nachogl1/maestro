import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri plugin-store must be mocked before importing the store module.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { useCliSettingsStore } from "../useCliSettingsStore";

const DEFAULT = { skipPermissions: false, customFlags: "" };

describe("useCliSettingsStore", () => {
  beforeEach(() => {
    useCliSettingsStore.getState().resetAllToDefaults();
  });

  it("starts with default flags for every AI mode", () => {
    const { flags } = useCliSettingsStore.getState();
    expect(flags).toEqual({ Claude: DEFAULT, Gemini: DEFAULT, Codex: DEFAULT, OpenCode: DEFAULT });
  });

  it("setSkipPermissions changes only the given mode", () => {
    useCliSettingsStore.getState().setSkipPermissions("Claude", true);
    const { flags } = useCliSettingsStore.getState();
    expect(flags.Claude).toEqual({ skipPermissions: true, customFlags: "" });
    expect(flags.Gemini).toEqual(DEFAULT);
  });

  it("setCustomFlags keeps the mode's other settings", () => {
    useCliSettingsStore.getState().setSkipPermissions("Codex", true);
    useCliSettingsStore.getState().setCustomFlags("Codex", "--verbose");
    expect(useCliSettingsStore.getState().getFlags("Codex")).toEqual({
      skipPermissions: true,
      customFlags: "--verbose",
    });
  });

  it("resetModeToDefaults resets one mode and leaves the others", () => {
    useCliSettingsStore.getState().setCustomFlags("Claude", "--a");
    useCliSettingsStore.getState().setCustomFlags("Gemini", "--b");
    useCliSettingsStore.getState().resetModeToDefaults("Claude");
    const { flags } = useCliSettingsStore.getState();
    expect(flags.Claude).toEqual(DEFAULT);
    expect(flags.Gemini.customFlags).toBe("--b");
  });

  it("resetAllToDefaults resets every mode", () => {
    useCliSettingsStore.getState().setSkipPermissions("OpenCode", true);
    useCliSettingsStore.getState().setCustomFlags("Gemini", "--x");
    useCliSettingsStore.getState().resetAllToDefaults();
    const { flags } = useCliSettingsStore.getState();
    expect(flags.OpenCode).toEqual(DEFAULT);
    expect(flags.Gemini).toEqual(DEFAULT);
  });

  it("getFlags falls back to defaults for a mode missing from persisted state", () => {
    useCliSettingsStore.setState({
      flags: { Claude: { skipPermissions: true, customFlags: "" } } as never,
    });
    expect(useCliSettingsStore.getState().getFlags("Gemini")).toEqual(DEFAULT);
  });
});
