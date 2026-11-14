import { sessionsForTab } from "@/hooks/useProjectStatus";
import type { SessionConfig } from "@/stores/useSessionStore";
import type { WorkspaceTab } from "@/stores/useWorkspaceStore";

/**
 * Conclave (issue #598): one message, sent to the Claude Code terminals the
 * person ticks, that asks those agents to find each other through Claude
 * Code's cross-session messaging and agree how to share resources.
 */

/** The text the message box opens with, every time the dialog opens. */
export const CONCLAVE_DEFAULT_MESSAGE =
  "Conclave: you and these agents are asked to coordinate. Use ListAgents to find them and " +
  "SendMessage to write to each by name. Tell them what you are working on and which files, " +
  "folders, worktrees, ports and long-running commands you use or are about to use; ask the " +
  "same of them. Offer help where you can. Agree who uses which shared resource and when, so " +
  "nobody blocks or competes with anybody. Then carry on with your task and tell the others " +
  "when that changes.";

/** A Conclave needs someone to talk to: at least two agents. */
export const MIN_CONCLAVE_MEMBERS = 2;

/** One ticked terminal as the roster line names it. */
export interface ConclaveMember {
  /** The name Claude knows the agent by (its `--name`). */
  name: string;
  /** The project tab the terminal belongs to. */
  project: string;
}

/** One project and the Claude Code terminals it is running. */
export interface ConclaveProject {
  tab: WorkspaceTab;
  sessions: SessionConfig[];
}

/**
 * Every project's running Claude Code terminals, in tab order; projects with
 * none are left out. Other CLIs are never listed: the message relies on
 * Claude Code's ListAgents and SendMessage, which they do not have.
 */
export function conclaveProjects(
  tabs: WorkspaceTab[],
  sessions: SessionConfig[],
): ConclaveProject[] {
  return tabs
    .map((tab) => ({
      tab,
      sessions: sessionsForTab(tab, sessions).filter((s) => s.mode === "Claude"),
    }))
    .filter((p) => p.sessions.length > 0);
}

/**
 * The text every ticked terminal receives: the person's message, then one
 * line they never edit naming every member and its project.
 */
export function buildConclaveText(message: string, members: ConclaveMember[]): string {
  const roster = members.map((m) => `${m.name} (${m.project})`).join(", ");
  return `${message.trim()}\n\nAgents in this Conclave: ${roster}`;
}
