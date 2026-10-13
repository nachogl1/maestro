/**
 * Zustand store for MCP server discovery and management.
 *
 * Tracks discovered MCP servers per project.
 */

import { create } from "zustand";

import {
  deleteCustomMcpServer as deleteCustomMcpServerApi,
  getCustomMcpServers,
  getMcpStatus,
  getProjectMcpServers,
  type McpCustomServer,
  type McpManagedScope,
  type McpServerConfig,
  type McpStatusView,
  refreshProjectMcpServers,
  removeMcpServer,
  saveCustomMcpServer,
  setMcpServerEnabled,
  upsertMcpServer,
} from "@/lib/mcp";

interface McpState {
  /** MCP servers discovered per project path. */
  projectServers: Record<string, McpServerConfig[]>;

  /** Custom MCP servers configured by the user (global, user-level). */
  customServers: McpCustomServer[];

  /** Whether custom servers have been loaded. */
  customServersLoaded: boolean;

  /** Loading state per project. */
  isLoading: Record<string, boolean>;

  /** Error state per project. */
  errors: Record<string, string | null>;

  /**
   * Fetches MCP servers for a project (uses cache on backend).
   * Updates the store with discovered servers.
   */
  fetchProjectServers: (projectPath: string) => Promise<McpServerConfig[]>;

  /**
   * Refreshes MCP servers for a project (re-parses .mcp.json).
   */
  refreshProjectServers: (projectPath: string) => Promise<McpServerConfig[]>;

  /**
   * Fetches custom MCP servers from the backend.
   */
  fetchCustomServers: () => Promise<McpCustomServer[]>;

  /**
   * Adds or updates a custom MCP server.
   */
  addCustomServer: (server: McpCustomServer) => Promise<void>;

  /**
   * Updates an existing custom MCP server.
   */
  updateCustomServer: (server: McpCustomServer) => Promise<void>;

  /**
   * Deletes a custom MCP server by ID.
   */
  deleteCustomServer: (serverId: string) => Promise<void>;

  /**
   * Gets all servers (discovered + custom) for a project.
   */
  getAllServers: (projectPath: string) => McpServerConfig[];

  /** Management view (real config files + connectors) per project path. */
  mcpStatus: Record<string, McpStatusView>;

  /** Fetches the management view for a project, fresh from disk. */
  fetchMcpStatus: (projectPath: string) => Promise<McpStatusView | null>;

  /**
   * Adds or replaces a server in the real config file for a scope, then
   * refreshes the management view. (Launch-time discovery picks the change
   * up via its mtime-based cache invalidation — no explicit refresh needed.)
   */
  upsertManagedServer: (
    projectPath: string,
    scope: McpManagedScope,
    name: string,
    config: Record<string, unknown>,
    overwrite: boolean,
  ) => Promise<void>;

  /** Removes a server from the real config file for a scope. */
  removeManagedServer: (projectPath: string, scope: McpManagedScope, name: string) => Promise<void>;

  /** Enables/disables a server or connector for this project. */
  setManagedServerEnabled: (
    projectPath: string,
    scope: McpManagedScope,
    name: string,
    enabled: boolean,
  ) => Promise<void>;
}

export const useMcpStore = create<McpState>()((set, get) => ({
  projectServers: {},
  customServers: [],
  customServersLoaded: false,
  isLoading: {},
  errors: {},

  fetchProjectServers: async (projectPath: string) => {
    set((state) => ({
      isLoading: { ...state.isLoading, [projectPath]: true },
      errors: { ...state.errors, [projectPath]: null },
    }));

    try {
      const servers = await getProjectMcpServers(projectPath);

      set((state) => ({
        projectServers: { ...state.projectServers, [projectPath]: servers },
        isLoading: { ...state.isLoading, [projectPath]: false },
      }));
      return servers;
    } catch (err) {
      const errorMsg = String(err);
      console.error("Failed to fetch MCP servers:", err);
      set((state) => ({
        isLoading: { ...state.isLoading, [projectPath]: false },
        errors: { ...state.errors, [projectPath]: errorMsg },
      }));
      return [];
    }
  },

  refreshProjectServers: async (projectPath: string) => {
    set((state) => ({
      isLoading: { ...state.isLoading, [projectPath]: true },
      errors: { ...state.errors, [projectPath]: null },
    }));

    try {
      const servers = await refreshProjectMcpServers(projectPath);
      set((state) => ({
        projectServers: { ...state.projectServers, [projectPath]: servers },
        isLoading: { ...state.isLoading, [projectPath]: false },
      }));
      return servers;
    } catch (err) {
      const errorMsg = String(err);
      console.error("Failed to refresh MCP servers:", err);
      set((state) => ({
        isLoading: { ...state.isLoading, [projectPath]: false },
        errors: { ...state.errors, [projectPath]: errorMsg },
      }));
      return [];
    }
  },

  fetchCustomServers: async () => {
    try {
      const servers = await getCustomMcpServers();
      set({ customServers: servers, customServersLoaded: true });
      return servers;
    } catch (err) {
      console.error("Failed to fetch custom MCP servers:", err);
      return [];
    }
  },

  addCustomServer: async (server: McpCustomServer) => {
    // Optimistically update local state
    set((state) => ({
      customServers: [...state.customServers, server],
    }));

    try {
      await saveCustomMcpServer(server);
    } catch (err) {
      console.error("Failed to save custom MCP server:", err);
      // Revert on error
      set((state) => ({
        customServers: state.customServers.filter((s) => s.id !== server.id),
      }));
      throw err;
    }
  },

  updateCustomServer: async (server: McpCustomServer) => {
    const state = get();
    const previousServers = state.customServers;

    // Optimistically update local state
    set((state) => ({
      customServers: state.customServers.map((s) => (s.id === server.id ? server : s)),
    }));

    try {
      await saveCustomMcpServer(server);
    } catch (err) {
      console.error("Failed to update custom MCP server:", err);
      // Revert on error
      set({ customServers: previousServers });
      throw err;
    }
  },

  deleteCustomServer: async (serverId: string) => {
    const state = get();
    const previousServers = state.customServers;

    // Optimistically update local state
    set((state) => ({
      customServers: state.customServers.filter((s) => s.id !== serverId),
    }));

    try {
      await deleteCustomMcpServerApi(serverId);
    } catch (err) {
      console.error("Failed to delete custom MCP server:", err);
      // Revert on error
      set({ customServers: previousServers });
      throw err;
    }
  },

  mcpStatus: {},

  fetchMcpStatus: async (projectPath: string) => {
    try {
      const status = await getMcpStatus(projectPath);
      set((state) => ({
        mcpStatus: { ...state.mcpStatus, [projectPath]: status },
      }));
      return status;
    } catch (err) {
      console.error("Failed to fetch MCP status:", err);
      set((state) => ({
        errors: { ...state.errors, [projectPath]: String(err) },
      }));
      return null;
    }
  },

  upsertManagedServer: async (projectPath, scope, name, config, overwrite) => {
    try {
      await upsertMcpServer(projectPath, scope, name, config, overwrite);
      set((state) => ({ errors: { ...state.errors, [projectPath]: null } }));
    } catch (err) {
      set((state) => ({ errors: { ...state.errors, [projectPath]: String(err) } }));
      throw err;
    } finally {
      // Re-read the files so the UI reflects exactly what was written.
      await get().fetchMcpStatus(projectPath);
    }
  },

  removeManagedServer: async (projectPath, scope, name) => {
    try {
      await removeMcpServer(projectPath, scope, name);
      set((state) => ({ errors: { ...state.errors, [projectPath]: null } }));
    } catch (err) {
      set((state) => ({ errors: { ...state.errors, [projectPath]: String(err) } }));
      throw err;
    } finally {
      await get().fetchMcpStatus(projectPath);
    }
  },

  setManagedServerEnabled: async (projectPath, scope, name, enabled) => {
    // Optimistic flip so the toggle feels instant; the refetch corrects it.
    set((state) => {
      const status = state.mcpStatus[projectPath];
      if (!status) return {};
      return {
        mcpStatus: {
          ...state.mcpStatus,
          [projectPath]: {
            servers: status.servers.map((s) =>
              s.name === name && s.scope === scope ? { ...s, enabled, pending: false } : s,
            ),
            connectors: status.connectors.map((c) =>
              scope === "connector" && c.name === name ? { ...c, enabled } : c,
            ),
          },
        },
      };
    });

    try {
      await setMcpServerEnabled(projectPath, scope, name, enabled);
      set((state) => ({ errors: { ...state.errors, [projectPath]: null } }));
    } catch (err) {
      // Surface the failure — the refetch below also snaps the optimistic
      // toggle back, so without this the write would fail invisibly.
      set((state) => ({ errors: { ...state.errors, [projectPath]: String(err) } }));
    } finally {
      await get().fetchMcpStatus(projectPath);
    }
  },

  getAllServers: (projectPath: string) => {
    const state = get();
    const discoveredServers = state.projectServers[projectPath] ?? [];
    const enabledCustomServers = state.customServers.filter((s) => s.isEnabled);

    // Convert custom servers to McpServerConfig format
    const customServerConfigs: McpServerConfig[] = enabledCustomServers.map((custom) => ({
      name: custom.name,
      type: "stdio" as const,
      command: custom.command,
      args: custom.args,
      env: custom.env,
    }));

    return [...discoveredServers, ...customServerConfigs];
  },
}));
