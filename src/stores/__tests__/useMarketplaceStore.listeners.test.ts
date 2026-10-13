import { beforeEach, describe, expect, it, vi } from "vitest";

const { listenMock, unlistenMocks } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  unlistenMocks: [] as ReturnType<typeof vi.fn>[],
}));

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));
vi.mock("@/lib/marketplace", () => ({
  addMarketplaceSource: vi.fn(),
  getAvailablePlugins: vi.fn().mockResolvedValue([]),
  getInstalledPlugins: vi.fn().mockResolvedValue([]),
  getMarketplaceSources: vi.fn().mockResolvedValue([]),
  installMarketplacePlugin: vi.fn(),
  loadMarketplaceData: vi.fn().mockResolvedValue(undefined),
  refreshAllMarketplaces: vi.fn(),
  refreshMarketplace: vi.fn(),
  removeMarketplaceSource: vi.fn(),
  toggleMarketplaceSource: vi.fn(),
  uninstallPlugin: vi.fn(),
}));

import { stopMarketplaceListeners, useMarketplaceStore } from "../useMarketplaceStore";

describe("useMarketplaceStore event listeners", () => {
  beforeEach(() => {
    stopMarketplaceListeners();
    listenMock.mockReset();
    unlistenMocks.length = 0;
    listenMock.mockImplementation(() => {
      const unlisten = vi.fn();
      unlistenMocks.push(unlisten);
      return Promise.resolve(unlisten);
    });
  });

  it("attaches the listeners only once when initialize runs twice", async () => {
    await useMarketplaceStore.getState().initialize();
    await useMarketplaceStore.getState().initialize();

    expect(listenMock).toHaveBeenCalledTimes(3);
  });

  it("unregisters every listener on stop", async () => {
    await useMarketplaceStore.getState().initialize();
    expect(unlistenMocks).toHaveLength(3);

    stopMarketplaceListeners();

    for (const unlisten of unlistenMocks) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("re-attaches after a stop", async () => {
    await useMarketplaceStore.getState().initialize();
    stopMarketplaceListeners();
    await useMarketplaceStore.getState().initialize();

    expect(listenMock).toHaveBeenCalledTimes(6);
  });

  it("unregisters listeners that resolve after stop was called", async () => {
    const pending = useMarketplaceStore.getState().initialize();
    // initialize awaits data loading before subscribing; wait until listen() fired.
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(3));
    stopMarketplaceListeners();
    await pending;

    for (const unlisten of unlistenMocks) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });
});
