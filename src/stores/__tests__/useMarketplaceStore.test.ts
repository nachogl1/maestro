import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  addMarketplaceSource: vi.fn(),
  getAvailablePlugins: vi.fn(),
  getInstalledPlugins: vi.fn(),
  getMarketplaceSources: vi.fn(),
  installMarketplacePlugin: vi.fn(),
  loadMarketplaceData: vi.fn(),
  refreshAllMarketplaces: vi.fn(),
  refreshMarketplace: vi.fn(),
  removeMarketplaceSource: vi.fn(),
  toggleMarketplaceSource: vi.fn(),
  uninstallPlugin: vi.fn(),
}));

// Tauri APIs must be mocked before importing the store module.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@/lib/marketplace", () => api);

import type { InstalledPlugin, MarketplacePlugin, MarketplaceSource } from "@/types/marketplace";
import { stopMarketplaceListeners, useMarketplaceStore } from "../useMarketplaceStore";

function source(id: string, over: Partial<MarketplaceSource> = {}): MarketplaceSource {
  return {
    id,
    name: id,
    repository_url: `https://github.com/x/${id}`,
    is_official: false,
    is_enabled: true,
    last_fetched: null,
    last_error: null,
    ...over,
  };
}

function plugin(id: string, over: Partial<MarketplacePlugin> = {}): MarketplacePlugin {
  return {
    id,
    name: id,
    description: "",
    version: "1.0.0",
    author: "anon",
    category: "other",
    types: [],
    tags: [],
    marketplace_id: "src",
    ...over,
  } as MarketplacePlugin;
}

function installed(id: string, pluginId: string, version = "1.0.0"): InstalledPlugin {
  return { id, plugin_id: pluginId, name: pluginId, version } as InstalledPlugin;
}

const INITIAL = useMarketplaceStore.getState();

describe("useMarketplaceStore", () => {
  beforeEach(() => {
    stopMarketplaceListeners();
    for (const fn of Object.values(api)) fn.mockReset();
    api.getMarketplaceSources.mockResolvedValue([]);
    api.getAvailablePlugins.mockResolvedValue([]);
    api.getInstalledPlugins.mockResolvedValue([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    useMarketplaceStore.setState(INITIAL, true);
  });

  it("fetchAll loads sources, available and installed plugins", async () => {
    api.getMarketplaceSources.mockResolvedValue([source("s1")]);
    api.getAvailablePlugins.mockResolvedValue([plugin("p1")]);
    api.getInstalledPlugins.mockResolvedValue([installed("i1", "p1")]);

    await useMarketplaceStore.getState().fetchAll();

    const s = useMarketplaceStore.getState();
    expect(s.sources.map((x) => x.id)).toEqual(["s1"]);
    expect(s.availablePlugins.map((x) => x.id)).toEqual(["p1"]);
    expect(s.installedPlugins.map((x) => x.id)).toEqual(["i1"]);
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("fetchAll records the error on failure", async () => {
    api.getAvailablePlugins.mockRejectedValue("network");

    await useMarketplaceStore.getState().fetchAll();

    expect(useMarketplaceStore.getState().error).toBe("network");
    expect(useMarketplaceStore.getState().isLoading).toBe(false);
  });

  it("initialize records the error when loading persisted data fails", async () => {
    api.loadMarketplaceData.mockRejectedValue("corrupt");

    await useMarketplaceStore.getState().initialize();

    expect(useMarketplaceStore.getState().error).toBe("corrupt");
    expect(api.getMarketplaceSources).not.toHaveBeenCalled();
  });

  it("open sets isOpen and fetches; close resets the browsing state", async () => {
    useMarketplaceStore.getState().open();
    expect(useMarketplaceStore.getState().isOpen).toBe(true);
    await vi.waitFor(() => expect(api.getMarketplaceSources).toHaveBeenCalled());

    useMarketplaceStore.setState({
      selectedPlugin: plugin("p"),
      searchText: "q",
      filters: { ...INITIAL.filters, category: "ai" },
    });
    useMarketplaceStore.getState().close();

    const s = useMarketplaceStore.getState();
    expect(s.isOpen).toBe(false);
    expect(s.selectedPlugin).toBeNull();
    expect(s.searchText).toBe("");
    expect(s.filters).toEqual(INITIAL.filters);
  });

  it("refreshMarketplaces refreshes then reloads data, clearing isRefreshing", async () => {
    api.refreshAllMarketplaces.mockResolvedValue(undefined);
    api.getAvailablePlugins.mockResolvedValue([plugin("fresh")]);

    await useMarketplaceStore.getState().refreshMarketplaces();

    expect(api.refreshAllMarketplaces).toHaveBeenCalled();
    expect(useMarketplaceStore.getState().availablePlugins.map((p) => p.id)).toEqual(["fresh"]);
    expect(useMarketplaceStore.getState().isRefreshing).toBe(false);
  });

  it("refreshSource records the error and clears isRefreshing on failure", async () => {
    api.refreshMarketplace.mockRejectedValue("404");

    await useMarketplaceStore.getState().refreshSource("s1");

    expect(api.refreshMarketplace).toHaveBeenCalledWith("s1");
    expect(useMarketplaceStore.getState().error).toBe("404");
    expect(useMarketplaceStore.getState().isRefreshing).toBe(false);
  });

  it("addSource appends the new source and refreshes it", async () => {
    api.addMarketplaceSource.mockResolvedValue(source("new"));
    api.refreshMarketplace.mockResolvedValue(undefined);
    api.getMarketplaceSources.mockResolvedValue([source("new")]);

    await useMarketplaceStore.getState().addSource("new", "https://github.com/x/new");

    expect(api.addMarketplaceSource).toHaveBeenCalledWith("new", "https://github.com/x/new", false);
    expect(api.refreshMarketplace).toHaveBeenCalledWith("new");
    expect(useMarketplaceStore.getState().sources.map((s) => s.id)).toEqual(["new"]);
  });

  it("removeSource drops the source and its plugins", async () => {
    api.removeMarketplaceSource.mockResolvedValue(undefined);
    useMarketplaceStore.setState({
      sources: [source("a"), source("b")],
      availablePlugins: [
        plugin("pa", { marketplace_id: "a" }),
        plugin("pb", { marketplace_id: "b" }),
      ],
    });

    await useMarketplaceStore.getState().removeSource("a");

    const s = useMarketplaceStore.getState();
    expect(s.sources.map((x) => x.id)).toEqual(["b"]);
    expect(s.availablePlugins.map((x) => x.id)).toEqual(["pb"]);
  });

  it("removeSource keeps state and records the error on failure", async () => {
    api.removeMarketplaceSource.mockRejectedValue("locked");
    useMarketplaceStore.setState({ sources: [source("a")] });

    await useMarketplaceStore.getState().removeSource("a");

    expect(useMarketplaceStore.getState().sources).toHaveLength(1);
    expect(useMarketplaceStore.getState().error).toBe("locked");
  });

  it("toggleSource applies the backend's enabled flag and reloads available plugins", async () => {
    api.toggleMarketplaceSource.mockResolvedValue(false);
    api.getAvailablePlugins.mockResolvedValue([plugin("left")]);
    useMarketplaceStore.setState({ sources: [source("a"), source("b")] });

    await useMarketplaceStore.getState().toggleSource("a");

    const s = useMarketplaceStore.getState();
    expect(s.sources.find((x) => x.id === "a")?.is_enabled).toBe(false);
    expect(s.sources.find((x) => x.id === "b")?.is_enabled).toBe(true);
    expect(s.availablePlugins.map((x) => x.id)).toEqual(["left"]);
  });

  it("installPlugin appends the installed plugin and clears installingPluginId", async () => {
    api.installMarketplacePlugin.mockResolvedValue(installed("i1", "p1"));

    const result = await useMarketplaceStore.getState().installPlugin("p1", "project", "/proj");

    expect(api.installMarketplacePlugin).toHaveBeenCalledWith("p1", "project", "/proj");
    expect(result?.id).toBe("i1");
    expect(useMarketplaceStore.getState().installedPlugins.map((p) => p.id)).toEqual(["i1"]);
    expect(useMarketplaceStore.getState().installingPluginId).toBeNull();
  });

  it("installPlugin returns null and records the error on failure", async () => {
    api.installMarketplacePlugin.mockRejectedValue("conflict");

    const result = await useMarketplaceStore.getState().installPlugin("p1", "user");

    expect(result).toBeNull();
    expect(useMarketplaceStore.getState().error).toBe("conflict");
    expect(useMarketplaceStore.getState().installingPluginId).toBeNull();
  });

  it("uninstallPluginById removes the plugin, or keeps it and records the error", async () => {
    useMarketplaceStore.setState({
      installedPlugins: [installed("i1", "p1"), installed("i2", "p2")],
    });
    api.uninstallPlugin.mockResolvedValueOnce(undefined).mockRejectedValueOnce("busy");

    await useMarketplaceStore.getState().uninstallPluginById("i1");
    expect(useMarketplaceStore.getState().installedPlugins.map((p) => p.id)).toEqual(["i2"]);

    await useMarketplaceStore.getState().uninstallPluginById("i2");
    expect(useMarketplaceStore.getState().installedPlugins.map((p) => p.id)).toEqual(["i2"]);
    expect(useMarketplaceStore.getState().error).toBe("busy");
    expect(useMarketplaceStore.getState().uninstallingPluginId).toBeNull();
  });

  it("isInstalled and getInstalledVersion look up by marketplace plugin id", () => {
    useMarketplaceStore.setState({ installedPlugins: [installed("i1", "p1", "2.3.0")] });
    const s = useMarketplaceStore.getState();

    expect(s.isInstalled("p1")).toBe(true);
    expect(s.isInstalled("p2")).toBe(false);
    expect(s.getInstalledVersion("p1")).toBe("2.3.0");
    expect(s.getInstalledVersion("p2")).toBeNull();
  });

  it("simple UI setters update their fields", () => {
    const s = useMarketplaceStore.getState();
    s.setSearchText("abc");
    s.setViewMode("list");
    s.toggleSourcesSidebar();
    s.selectPlugin(plugin("sel"));
    s.setFilter("tags", ["t"]);

    let next = useMarketplaceStore.getState();
    expect(next.searchText).toBe("abc");
    expect(next.viewMode).toBe("list");
    expect(next.showSourcesSidebar).toBe(true);
    expect(next.selectedPlugin?.id).toBe("sel");
    expect(next.filters.tags).toEqual(["t"]);

    next.clearFilters();
    next = useMarketplaceStore.getState();
    expect(next.filters).toEqual(INITIAL.filters);
    expect(next.searchText).toBe("");
  });

  describe("getFilteredPlugins", () => {
    beforeEach(() => {
      useMarketplaceStore.setState({
        availablePlugins: [
          plugin("alpha", {
            description: "Linter",
            category: "development",
            types: ["skill"],
            tags: ["lint", "js"],
          }),
          plugin("beta", { author: "Acme", category: "ai", types: ["mcp"], tags: ["js"] }),
          plugin("gamma", { category: "ai", types: ["skill", "hook"], tags: ["Python"] }),
        ],
        installedPlugins: [installed("i", "beta")],
      });
    });

    const ids = (): string[] =>
      useMarketplaceStore
        .getState()
        .getFilteredPlugins()
        .map((p) => p.id);

    it("searches name, description, author and tags case-insensitively", () => {
      useMarketplaceStore.setState({ searchText: "LINTER" });
      expect(ids()).toEqual(["alpha"]);
      useMarketplaceStore.setState({ searchText: "acme" });
      expect(ids()).toEqual(["beta"]);
      useMarketplaceStore.setState({ searchText: "python" });
      expect(ids()).toEqual(["gamma"]);
    });

    it("filters by category, type and all-of tags", () => {
      useMarketplaceStore.getState().setFilter("category", "ai");
      expect(ids()).toEqual(["beta", "gamma"]);
      useMarketplaceStore.getState().setFilter("type", "skill");
      expect(ids()).toEqual(["gamma"]);

      useMarketplaceStore.getState().clearFilters();
      useMarketplaceStore.getState().setFilter("tags", ["js", "lint"]);
      expect(ids()).toEqual(["alpha"]);
    });

    it("filters by installed / not installed", () => {
      useMarketplaceStore.getState().setFilter("showInstalled", true);
      expect(ids()).toEqual(["beta"]);

      useMarketplaceStore.getState().clearFilters();
      useMarketplaceStore.getState().setFilter("showNotInstalled", true);
      expect(ids()).toEqual(["alpha", "gamma"]);
    });
  });
});
