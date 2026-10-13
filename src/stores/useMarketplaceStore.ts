import { listen, type UnlistenFn } from "@tauri-apps/api/event";
/**
 * Zustand store for marketplace plugin browsing and installation.
 *
 * Manages marketplace sources, available plugins, installed plugins,
 * and UI state for the marketplace browser.
 */

import { create } from "zustand";

import {
  addMarketplaceSource,
  getAvailablePlugins,
  getInstalledPlugins,
  getMarketplaceSources,
  installMarketplacePlugin,
  loadMarketplaceData,
  refreshAllMarketplaces,
  refreshMarketplace,
  removeMarketplaceSource,
  toggleMarketplaceSource,
  uninstallPlugin,
} from "@/lib/marketplace";
import type {
  InstalledPlugin,
  InstallScope,
  MarketplaceFilters,
  MarketplacePlugin,
  MarketplaceSource,
  ViewMode,
} from "@/types/marketplace";

interface MarketplaceState {
  /** All marketplace sources. */
  sources: MarketplaceSource[];

  /** All available plugins from enabled marketplaces. */
  availablePlugins: MarketplacePlugin[];

  /** All installed plugins. */
  installedPlugins: InstalledPlugin[];

  /** Currently selected plugin for details view. */
  selectedPlugin: MarketplacePlugin | null;

  /** Search text for filtering plugins. */
  searchText: string;

  /** Active filters. */
  filters: MarketplaceFilters;

  /** View mode (grid or list). */
  viewMode: ViewMode;

  /** Whether the sources sidebar is visible. */
  showSourcesSidebar: boolean;

  /** Whether the marketplace browser modal is open. */
  isOpen: boolean;

  /** Whether data is loading. */
  isLoading: boolean;

  /** Whether plugins are being refreshed. */
  isRefreshing: boolean;

  /** Error message (if any). */
  error: string | null;

  /** Plugin currently being installed (ID). */
  installingPluginId: string | null;

  /** Plugin currently being uninstalled (ID). */
  uninstallingPluginId: string | null;

  // ========== Actions ==========

  /** Opens the marketplace browser modal. */
  open: () => void;

  /** Closes the marketplace browser modal. */
  close: () => void;

  /** Initializes the store by loading persisted data. */
  initialize: () => Promise<void>;

  /** Fetches all data (sources, available plugins, installed plugins). */
  fetchAll: () => Promise<void>;

  /** Refreshes all enabled marketplaces. */
  refreshMarketplaces: () => Promise<void>;

  /** Refreshes a single marketplace source. */
  refreshSource: (sourceId: string) => Promise<void>;

  /** Adds a new marketplace source. */
  addSource: (name: string, repositoryUrl: string, isOfficial?: boolean) => Promise<void>;

  /** Removes a marketplace source. */
  removeSource: (sourceId: string) => Promise<void>;

  /** Toggles a marketplace source's enabled state. */
  toggleSource: (sourceId: string) => Promise<void>;

  /** Selects a plugin for details view. */
  selectPlugin: (plugin: MarketplacePlugin | null) => void;

  /** Sets the search text. */
  setSearchText: (text: string) => void;

  /** Sets a filter value. */
  setFilter: <K extends keyof MarketplaceFilters>(key: K, value: MarketplaceFilters[K]) => void;

  /** Clears all filters. */
  clearFilters: () => void;

  /** Sets the view mode. */
  setViewMode: (mode: ViewMode) => void;

  /** Toggles the sources sidebar. */
  toggleSourcesSidebar: () => void;

  /** Installs a plugin from a marketplace. */
  installPlugin: (
    pluginId: string,
    scope: InstallScope,
    projectPath?: string,
  ) => Promise<InstalledPlugin | null>;

  /** Uninstalls a plugin. */
  uninstallPluginById: (installedPluginId: string) => Promise<void>;

  /** Checks if a marketplace plugin is installed. */
  isInstalled: (marketplacePluginId: string) => boolean;

  /** Gets the installed version of a marketplace plugin. */
  getInstalledVersion: (marketplacePluginId: string) => string | null;

  /** Gets filtered and searched plugins. */
  getFilteredPlugins: () => MarketplacePlugin[];
}

const defaultFilters: MarketplaceFilters = {
  category: null,
  type: null,
  tags: [],
  showInstalled: false,
  showNotInstalled: false,
};

/**
 * Backend channels announcing that the plugin inventory changed
 * (`src-tauri/src/commands/marketplace.rs`).
 */
const MARKETPLACE_EVENTS = [
  "marketplace:refresh-complete",
  "marketplace:plugin-installed",
  "marketplace:plugin-uninstalled",
] as const;

// Global event listeners. `active` tracks the *desired* state so a
// subscribe/stop pair that races the pending listen() promises can't leak
// listeners (same pattern as `initAgentListener` in useAgentStore).
let unlisteners: UnlistenFn[] = [];
let starting: Promise<void> | null = null;
let active = false;

async function subscribeToMarketplaceEvents(onChange: () => void): Promise<void> {
  active = true;
  // `initialize` may run more than once: never attach a second set.
  if (unlisteners.length > 0 || starting) return;
  starting = Promise.all(MARKETPLACE_EVENTS.map((name) => listen(name, onChange)))
    .then((fns) => {
      if (!active) {
        for (const fn of fns) fn();
        return;
      }
      unlisteners = fns;
    })
    .catch((err) => {
      // Event system unavailable (tests): the store still works on reads.
      console.error("Failed to subscribe to marketplace events:", err);
    })
    .finally(() => {
      starting = null;
    });
  await starting;
}

/** Detaches the marketplace event listeners attached by `initialize`. */
export function stopMarketplaceListeners(): void {
  active = false;
  for (const fn of unlisteners) fn();
  unlisteners = [];
}

export const useMarketplaceStore = create<MarketplaceState>()((set, get) => ({
  sources: [],
  availablePlugins: [],
  installedPlugins: [],
  selectedPlugin: null,
  searchText: "",
  filters: defaultFilters,
  viewMode: "grid",
  showSourcesSidebar: false,
  isOpen: false,
  isLoading: false,
  isRefreshing: false,
  error: null,
  installingPluginId: null,
  uninstallingPluginId: null,

  open: () => {
    set({ isOpen: true });
    // Fetch data when opening
    get().fetchAll();
  },

  close: () => {
    set({
      isOpen: false,
      selectedPlugin: null,
      searchText: "",
      filters: defaultFilters,
    });
  },

  initialize: async () => {
    try {
      await loadMarketplaceData();
      await get().fetchAll();
      // The backend emits on every refresh/install/uninstall, and nothing
      // listened: a change made through one code path left every other view
      // rendering stale plugin state until a manual refresh.
      await subscribeToMarketplaceEvents(() => {
        void get().fetchAll();
      });
    } catch (err) {
      console.error("Failed to initialize marketplace:", err);
      set({ error: String(err) });
    }
  },

  fetchAll: async () => {
    set({ isLoading: true, error: null });

    try {
      const [sources, availablePlugins, installedPlugins] = await Promise.all([
        getMarketplaceSources(),
        getAvailablePlugins(),
        getInstalledPlugins(),
      ]);

      set({
        sources,
        availablePlugins,
        installedPlugins,
        isLoading: false,
      });
    } catch (err) {
      console.error("Failed to fetch marketplace data:", err);
      set({
        isLoading: false,
        error: String(err),
      });
    }
  },

  refreshMarketplaces: async () => {
    set({ isRefreshing: true, error: null });

    try {
      await refreshAllMarketplaces();
      // Fetch updated data
      const [sources, availablePlugins, installedPlugins] = await Promise.all([
        getMarketplaceSources(),
        getAvailablePlugins(),
        getInstalledPlugins(),
      ]);

      set({
        sources,
        availablePlugins,
        installedPlugins,
        isRefreshing: false,
      });
    } catch (err) {
      console.error("Failed to refresh marketplaces:", err);
      set({
        isRefreshing: false,
        error: String(err),
      });
    }
  },

  refreshSource: async (sourceId: string) => {
    set({ isRefreshing: true, error: null });

    try {
      await refreshMarketplace(sourceId);
      // Fetch updated data
      const [sources, availablePlugins, installedPlugins] = await Promise.all([
        getMarketplaceSources(),
        getAvailablePlugins(),
        getInstalledPlugins(),
      ]);

      set({
        sources,
        availablePlugins,
        installedPlugins,
        isRefreshing: false,
      });
    } catch (err) {
      console.error(`Failed to refresh marketplace ${sourceId}:`, err);
      set({
        isRefreshing: false,
        error: String(err),
      });
    }
  },

  addSource: async (name: string, repositoryUrl: string, isOfficial = false) => {
    try {
      const source = await addMarketplaceSource(name, repositoryUrl, isOfficial);
      set((state) => ({
        sources: [...state.sources, source],
      }));

      // Optionally refresh the new source
      await get().refreshSource(source.id);
    } catch (err) {
      console.error("Failed to add marketplace source:", err);
      set({ error: String(err) });
    }
  },

  removeSource: async (sourceId: string) => {
    try {
      await removeMarketplaceSource(sourceId);
      set((state) => ({
        sources: state.sources.filter((s) => s.id !== sourceId),
        // Also remove plugins from this source
        availablePlugins: state.availablePlugins.filter((p) => p.marketplace_id !== sourceId),
      }));
    } catch (err) {
      console.error("Failed to remove marketplace source:", err);
      set({ error: String(err) });
    }
  },

  toggleSource: async (sourceId: string) => {
    try {
      const newState = await toggleMarketplaceSource(sourceId);
      set((state) => ({
        sources: state.sources.map((s) => (s.id === sourceId ? { ...s, is_enabled: newState } : s)),
      }));

      // Refresh available plugins
      const availablePlugins = await getAvailablePlugins();
      set({ availablePlugins });
    } catch (err) {
      console.error("Failed to toggle marketplace source:", err);
      set({ error: String(err) });
    }
  },

  selectPlugin: (plugin: MarketplacePlugin | null) => {
    set({ selectedPlugin: plugin });
  },

  setSearchText: (text: string) => {
    set({ searchText: text });
  },

  setFilter: <K extends keyof MarketplaceFilters>(key: K, value: MarketplaceFilters[K]) => {
    set((state) => ({
      filters: { ...state.filters, [key]: value },
    }));
  },

  clearFilters: () => {
    set({ filters: defaultFilters, searchText: "" });
  },

  setViewMode: (mode: ViewMode) => {
    set({ viewMode: mode });
  },

  toggleSourcesSidebar: () => {
    set((state) => ({ showSourcesSidebar: !state.showSourcesSidebar }));
  },

  installPlugin: async (
    pluginId: string,
    scope: InstallScope,
    projectPath?: string,
  ): Promise<InstalledPlugin | null> => {
    set({ installingPluginId: pluginId, error: null });

    try {
      const installed = await installMarketplacePlugin(pluginId, scope, projectPath);
      set((state) => ({
        installedPlugins: [...state.installedPlugins, installed],
        installingPluginId: null,
      }));
      return installed;
    } catch (err) {
      console.error(`Failed to install plugin ${pluginId}:`, err);
      set({
        installingPluginId: null,
        error: String(err),
      });
      return null;
    }
  },

  uninstallPluginById: async (installedPluginId: string) => {
    set({ uninstallingPluginId: installedPluginId, error: null });

    try {
      await uninstallPlugin(installedPluginId);
      set((state) => ({
        installedPlugins: state.installedPlugins.filter((p) => p.id !== installedPluginId),
        uninstallingPluginId: null,
      }));
    } catch (err) {
      console.error(`Failed to uninstall plugin ${installedPluginId}:`, err);
      set({
        uninstallingPluginId: null,
        error: String(err),
      });
    }
  },

  isInstalled: (marketplacePluginId: string): boolean => {
    return get().installedPlugins.some((p) => p.plugin_id === marketplacePluginId);
  },

  getInstalledVersion: (marketplacePluginId: string): string | null => {
    const installed = get().installedPlugins.find((p) => p.plugin_id === marketplacePluginId);
    return installed?.version ?? null;
  },

  getFilteredPlugins: (): MarketplacePlugin[] => {
    const { availablePlugins, installedPlugins, searchText, filters } = get();

    return availablePlugins.filter((plugin) => {
      // Search filter
      if (searchText) {
        const search = searchText.toLowerCase();
        const matchesSearch =
          plugin.name.toLowerCase().includes(search) ||
          plugin.description.toLowerCase().includes(search) ||
          plugin.author.toLowerCase().includes(search) ||
          plugin.tags.some((t) => t.toLowerCase().includes(search));

        if (!matchesSearch) return false;
      }

      // Category filter
      if (filters.category && plugin.category !== filters.category) {
        return false;
      }

      // Type filter
      if (filters.type && !plugin.types.includes(filters.type)) {
        return false;
      }

      // Tags filter
      if (filters.tags.length > 0) {
        const hasAllTags = filters.tags.every((tag) => plugin.tags.includes(tag));
        if (!hasAllTags) return false;
      }

      // Installed filter
      const isInstalled = installedPlugins.some((p) => p.plugin_id === plugin.id);

      if (filters.showInstalled && !isInstalled) {
        return false;
      }

      if (filters.showNotInstalled && isInstalled) {
        return false;
      }

      return true;
    });
  },
}));
