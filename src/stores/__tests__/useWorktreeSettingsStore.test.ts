import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the mock factory and the assertions share one LazyStore stub.
const lazy = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => lazy),
}));

import { useWorktreeSettingsStore } from "../useWorktreeSettingsStore";

describe("useWorktreeSettingsStore", () => {
  beforeEach(() => {
    lazy.get.mockReset().mockResolvedValue(null);
    lazy.set.mockReset().mockResolvedValue(undefined);
    lazy.save.mockReset().mockResolvedValue(undefined);
    lazy.delete.mockReset().mockResolvedValue(undefined);
    useWorktreeSettingsStore.setState({ worktreeCloseAction: "keep" });
  });

  it("defaults to keep", () => {
    expect(useWorktreeSettingsStore.getInitialState().worktreeCloseAction).toBe("keep");
  });

  it("setWorktreeCloseAction updates the action", () => {
    useWorktreeSettingsStore.getState().setWorktreeCloseAction("delete");
    expect(useWorktreeSettingsStore.getState().worktreeCloseAction).toBe("delete");
    useWorktreeSettingsStore.getState().setWorktreeCloseAction("ask");
    expect(useWorktreeSettingsStore.getState().worktreeCloseAction).toBe("ask");
  });

  it("persists the action to the Tauri store", async () => {
    useWorktreeSettingsStore.getState().setWorktreeCloseAction("ask");
    await vi.waitFor(() => expect(lazy.save).toHaveBeenCalled());
    const [name, value] = lazy.set.mock.calls.at(-1) as [string, string];
    expect(name).toBe("maestro-worktree-settings");
    expect(JSON.parse(value).state).toEqual({ worktreeCloseAction: "ask" });
  });

  it("rehydrates a saved action", async () => {
    lazy.get.mockResolvedValue(
      JSON.stringify({ state: { worktreeCloseAction: "delete" }, version: 0 }),
    );
    await useWorktreeSettingsStore.persist.rehydrate();
    expect(useWorktreeSettingsStore.getState().worktreeCloseAction).toBe("delete");
  });

  it("keeps the current value when the stored read throws", async () => {
    lazy.get.mockRejectedValue(new Error("disk gone"));
    await useWorktreeSettingsStore.persist.rehydrate();
    expect(useWorktreeSettingsStore.getState().worktreeCloseAction).toBe("keep");
  });
});
