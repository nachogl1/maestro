import type { McpServerConfig } from "@/lib/mcp";
import type { PluginConfig, SkillConfig } from "@/lib/plugins";
import { SAMURAI_TERMINAL_STATES, useSessionStore } from "@/stores/useSessionStore";
import type { SessionSlot } from "./PreLaunchCard";

/**
 * How many of these slots count against `MAX_SESSIONS`.
 *
 * Parked samurai terminal-state tiles (issue #122) are dead weight: the PTY
 * is gone and only the transcript remains. A long autonomous run leaves one
 * per generation, so counting them would first drop a successor's launch
 * AFTER `consume` claimed it (silently stalling the run) and then make the
 * "+" button a silent no-op for the whole project. Both call sites — the
 * pending-launch claim and `addSession` — go through here so the exemption
 * cannot drift apart again (PR #131 review M4/F4).
 */
export function occupiedSlotCount(slots: SessionSlot[]): number {
  const { samuraiBySessionId, parkedSessionIds } = useSessionStore.getState();
  return slots.filter((slot) => {
    if (slot.sessionId === null) return true;
    const info = samuraiBySessionId[slot.sessionId];
    return !(
      info !== undefined &&
      SAMURAI_TERMINAL_STATES.has(info.state) &&
      parkedSessionIds.includes(slot.sessionId)
    );
  }).length;
}

/** Generates a unique ID for a new session slot. */
function generateSlotId(): string {
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
