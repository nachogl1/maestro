import type { McpServerConfig } from "@/lib/mcp";
import type { PluginConfig, SkillConfig } from "@/lib/plugins";
import type { SessionSlot } from "./PreLaunchCard";

/**
 * The folder whose session config (MCP, plugins, hooks) a closing terminal
 * must clean: the one launch wrote into, else its worktree, else the project.
 */
export function sessionConfigDir(
  slot: Pick<SessionSlot, "configDir" | "worktreePath"> | undefined,
  projectPath: string | undefined,
): string | undefined {
  return slot?.configDir || slot?.worktreePath || projectPath;
}

/** Generates a unique ID for a new session slot. */
export function generateSlotId(): string {
  return `slot-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Creates a new empty session slot with default configuration. */
export function createEmptySlot(
  mcpServers: McpServerConfig[] = [],
  skills: SkillConfig[] = [],
  plugins: PluginConfig[] = [],
): SessionSlot {
  return {
    id: generateSlotId(),
    mode: "Claude",
    branch: null,
    customName: "",
    worktreeMode: "project",
    sessionId: null,
    worktreePath: null,
    worktreeWarning: null,
    enabledMcpServers: mcpServers.map((s) => s.name), // All enabled by default
    enabledSkills: skills.map((s) => s.id), // All enabled by default
    enabledPlugins: plugins.filter((p) => p.enabled_by_default).map((p) => p.id),
    mcpDefaultsApplied: mcpServers.length > 0,
    skillsDefaultsApplied: skills.length > 0,
    pluginsDefaultsApplied: plugins.length > 0,
  };
}
