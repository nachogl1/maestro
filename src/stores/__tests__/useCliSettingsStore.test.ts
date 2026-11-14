import { beforeEach, describe, expect, it, vi } from "vitest";

// What the mocked Tauri store holds on disk, keyed by the persist name.
const savedFile = vi.hoisted(() => new Map<string, string>());

// Tauri plugin-store must be mocked before importing the store module.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn(async (name: string) => savedFile.get(name) ?? null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { buildCliCommand } from "@/lib/terminal";
import { useCliSettingsStore } from "../useCliSettingsStore";
import savedWithRemovedKinds from "./fixtures/cli-settings-removed-kinds.json";

const DEFAULT = { skipPermissions: false, customFlags: "" };

describe("useCliSettingsStore", () => {
  beforeEach(() => {
    savedFile.clear();
    useCliSettingsStore.getState().resetAllToDefaults();
  });

  it("starts with default flags for Claude, the only mode with flags", () => {
    const { flags } = useCliSettingsStore.getState();
    expect(flags).toEqual({ Claude: DEFAULT });
  });

  it("setSkipPermissions changes only the skip flag", () => {
    useCliSettingsStore.getState().setCustomFlags("Claude", "--verbose");
    useCliSettingsStore.getState().setSkipPermissions("Claude", true);
    const { flags } = useCliSettingsStore.getState();
    expect(flags.Claude).toEqual({ skipPermissions: true, customFlags: "--verbose" });
  });

  it("setCustomFlags keeps the mode's other settings", () => {
    useCliSettingsStore.getState().setSkipPermissions("Claude", true);
    useCliSettingsStore.getState().setCustomFlags("Claude", "--verbose");
    expect(useCliSettingsStore.getState().getFlags("Claude")).toEqual({
      skipPermissions: true,
      customFlags: "--verbose",
    });
  });

  it("resetModeToDefaults resets the mode", () => {
    useCliSettingsStore.getState().setSkipPermissions("Claude", true);
    useCliSettingsStore.getState().setCustomFlags("Claude", "--a");
    useCliSettingsStore.getState().resetModeToDefaults("Claude");
    expect(useCliSettingsStore.getState().flags.Claude).toEqual(DEFAULT);
  });

  it("resetAllToDefaults resets every mode", () => {
    useCliSettingsStore.getState().setSkipPermissions("Claude", true);
    useCliSettingsStore.getState().setCustomFlags("Claude", "--x");
    useCliSettingsStore.getState().resetAllToDefaults();
    expect(useCliSettingsStore.getState().flags).toEqual({ Claude: DEFAULT });
  });

  it("getFlags falls back to defaults for a mode missing from persisted state", () => {
    useCliSettingsStore.setState({ flags: {} as never });
    expect(useCliSettingsStore.getState().getFlags("Claude")).toEqual(DEFAULT);
  });

  // Issue #606: earlier versions offered three more terminal kinds and saved
  // flags for each. Such a file stays on users' machines, untouched; loading
  // it must not fail, and its extra entries must change nothing.
  it("loads a saved file that still holds flags for removed terminal kinds", async () => {
    savedFile.set("maestro-cli-settings", JSON.stringify(savedWithRemovedKinds));

    await useCliSettingsStore.persist.rehydrate();

    const claudeFlags = useCliSettingsStore.getState().getFlags("Claude");
    expect(claudeFlags).toEqual({ skipPermissions: true, customFlags: "--model opus" });
    expect(buildCliCommand("Claude", claudeFlags)).toBe(
      "claude --dangerously-skip-permissions --model opus",
    );
  });
});
