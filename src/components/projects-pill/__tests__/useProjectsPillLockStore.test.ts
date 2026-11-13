import { beforeEach, describe, expect, it, vi } from "vitest";

// One in-memory settings file that outlives a module reload, as the real
// store file outlives an app restart.
const disk = new Map<string, unknown>();
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn(async (key: string) => disk.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      disk.set(key, value);
    }),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(async (key: string) => {
      disk.delete(key);
    }),
  })),
}));

async function freshStore() {
  vi.resetModules();
  const { useProjectsPillLockStore } = await import("../useProjectsPillLockStore");
  await useProjectsPillLockStore.persist.rehydrate();
  return useProjectsPillLockStore;
}

describe("useProjectsPillLockStore", () => {
  beforeEach(() => disk.clear());

  it("counts blocked issues by default", async () => {
    const store = await freshStore();

    expect(store.getState().countBlocked).toBe(true);
  });

  it("remembers Ready only across a restart", async () => {
    const before = await freshStore();
    before.getState().setCountBlocked(false);
    await vi.waitFor(() => expect(disk.size).toBe(1));

    const after = await freshStore();

    expect(after.getState().countBlocked).toBe(false);
  });
});
