/**
 * Zustand store for plugin/skill discovery.
 *
 * Tracks discovered plugins and skills per project.
 */

import { create } from "zustand";

import {
  deletePlugin as deletePluginApi,
  deleteSkill as deleteSkillApi,
  getProjectPlugins,
  type PluginConfig,
  refreshProjectPlugins,
  type SkillConfig,
} from "@/lib/plugins";

interface PluginState {
  /** Skills discovered per project path. */
  projectSkills: Record<string, SkillConfig[]>;

  /** Plugins discovered per project path. */
  projectPlugins: Record<string, PluginConfig[]>;

  /** Loading state per project. */
  isLoading: Record<string, boolean>;

  /** Error state per project. */
  errors: Record<string, string | null>;

  /** ID of skill currently being deleted. */
  deletingSkillId: string | null;

  /** ID of plugin currently being deleted. */
  deletingPluginId: string | null;

  /**
   * Fetches plugins/skills for a project (uses cache on backend).
   * Updates the store with discovered items.
   */
  fetchProjectPlugins: (projectPath: string) => Promise<void>;

  /**
   * Refreshes plugins/skills for a project (re-parses .plugins.json).
   */
  refreshProjectPlugins: (projectPath: string) => Promise<void>;

  /**
   * Deletes a standalone skill (project or personal).
   * Refreshes the plugin list after deletion.
   */
  deleteSkill: (skillId: string, skillPath: string, projectPath: string) => Promise<void>;

  /**
   * Deletes a manually installed plugin (from ~/.claude/plugins/ or .claude/plugins/).
   * Refreshes the plugin list after deletion.
   */
  deletePlugin: (pluginId: string, pluginPath: string, projectPath: string) => Promise<void>;
}

export const usePluginStore = create<PluginState>()((set, get) => ({
  projectSkills: {},
  projectPlugins: {},
  isLoading: {},
  errors: {},
  deletingSkillId: null,
  deletingPluginId: null,

  fetchProjectPlugins: async (projectPath: string) => {
    set((state) => ({
      isLoading: { ...state.isLoading, [projectPath]: true },
      errors: { ...state.errors, [projectPath]: null },
    }));

    try {
      const result = await getProjectPlugins(projectPath);

      set((state) => ({
        projectSkills: { ...state.projectSkills, [projectPath]: result.skills },
        projectPlugins: { ...state.projectPlugins, [projectPath]: result.plugins },
        isLoading: { ...state.isLoading, [projectPath]: false },
      }));
    } catch (err) {
      const errorMsg = String(err);
      console.error("Failed to fetch plugins:", err);
      set((state) => ({
        isLoading: { ...state.isLoading, [projectPath]: false },
        errors: { ...state.errors, [projectPath]: errorMsg },
      }));
    }
  },

  refreshProjectPlugins: async (projectPath: string) => {
    set((state) => ({
      isLoading: { ...state.isLoading, [projectPath]: true },
      errors: { ...state.errors, [projectPath]: null },
    }));

    try {
      const result = await refreshProjectPlugins(projectPath);
      set((state) => ({
        projectSkills: { ...state.projectSkills, [projectPath]: result.skills },
        projectPlugins: { ...state.projectPlugins, [projectPath]: result.plugins },
        isLoading: { ...state.isLoading, [projectPath]: false },
      }));
    } catch (err) {
      const errorMsg = String(err);
      console.error("Failed to refresh plugins:", err);
      set((state) => ({
        isLoading: { ...state.isLoading, [projectPath]: false },
        errors: { ...state.errors, [projectPath]: errorMsg },
      }));
    }
  },

  deleteSkill: async (skillId: string, skillPath: string, projectPath: string) => {
    set({ deletingSkillId: skillId });

    try {
      await deleteSkillApi(skillPath);
      // Refresh the plugin list to reflect the deletion
      await get().refreshProjectPlugins(projectPath);
    } catch (err) {
      console.error(`Failed to delete skill ${skillId}:`, err);
      set((state) => ({
        errors: { ...state.errors, [projectPath]: String(err) },
      }));
    } finally {
      set({ deletingSkillId: null });
    }
  },

  deletePlugin: async (pluginId: string, pluginPath: string, projectPath: string) => {
    set({ deletingPluginId: pluginId });

    try {
      await deletePluginApi(pluginPath);
      // Refresh the plugin list to reflect the deletion
      await get().refreshProjectPlugins(projectPath);
    } catch (err) {
      console.error(`Failed to delete plugin ${pluginId}:`, err);
      set((state) => ({
        errors: { ...state.errors, [projectPath]: String(err) },
      }));
    } finally {
      set({ deletingPluginId: null });
    }
  },
}));
