import { invoke } from "@tauri-apps/api/core";

/**
 * Claude agent names — the name other agents message a session by.
 *
 * A Claude terminal's title IS its agent name: Maestro launches `claude
 * --name <name>`, follows the live name Claude reports in its session
 * registry, and turns a title rename into `/rename <name>`. Names are
 * restricted to terminal-safe characters so they can sit unquoted on the
 * launch command line and be typed into the CLI; the backend applies the
 * same rule (`is_valid_agent_name` in `src-tauri/src/commands/agent_names.rs`).
 */

/** Longest agent name Maestro will set. */
export const MAX_AGENT_NAME_LENGTH = 64;

const VALID_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Whether `name` can be used as an agent name as-is. */
export function isValidAgentName(name: string): boolean {
  return name.length <= MAX_AGENT_NAME_LENGTH && VALID_AGENT_NAME.test(name);
}

/**
 * Turns free text into an agent name: whitespace runs become `-`, other
 * unsafe characters are dropped, and leading/trailing separators are
 * trimmed. Returns null when nothing usable is left.
 *
 * @example sanitizeAgentName("harvest triage") // "harvest-triage"
 */
export function sanitizeAgentName(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, MAX_AGENT_NAME_LENGTH)
    .replace(/[._-]+$/, "");
  return name && isValidAgentName(name) ? name : null;
}

/**
 * A fresh agent name in Claude's own style — `<folder>-<NN>` — that no live
 * agent is using. `taken` holds the live names; after 90 misses a third digit
 * keeps it unique.
 */
export function defaultAgentName(
  workingDirectory: string,
  taken: ReadonlySet<string>,
  random: () => number = Math.random,
): string {
  const folder = workingDirectory.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const base = (sanitizeAgentName(folder) ?? "agent").slice(0, MAX_AGENT_NAME_LENGTH - 4);
  for (let attempt = 0; attempt < 90; attempt++) {
    const candidate = `${base}-${10 + Math.floor(random() * 90)}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${100 + Math.floor(random() * 900)}`;
}

/** One live Claude agent: its conversation id and the name it answers to. */
export interface LiveAgentName {
  session_id: string;
  name: string;
  /**
   * The Maestro terminal this claude runs in, found by the backend from the
   * process tree (a shell Maestro spawned is among the claude process's
   * ancestors). Null for a claude started outside Maestro.
   */
  maestro_session: number | null;
}

/** Every live Claude agent's name, from Claude Code's session registry. */
export function listLiveAgentNames(): Promise<LiveAgentName[]> {
  return invoke<LiveAgentName[]>("list_live_agent_names");
}

/** Types `/rename <name>` into the Claude running in Maestro terminal `sessionId`. */
export function renameAgent(sessionId: number, name: string): Promise<void> {
  return invoke("rename_agent", { sessionId, name });
}

/** A Maestro terminal running Claude, with the conversation it is on now. */
export interface AgentTerminal {
  sessionId: number;
  /** The terminal's current title (Maestro session name). */
  title: string | null | undefined;
  /** Claude conversation id from the latest SessionStart hook, if any yet. */
  conversationId: string | undefined;
}

/**
 * Titles to change so each Claude terminal shows its live agent name.
 *
 * A terminal is matched to its live agent by the process tree first (the
 * backend says which terminal each claude runs in), so the title follows
 * the real name even when no SessionStart hook ever reported a conversation
 * id — a claude typed by hand, or a launch whose hooks config was not
 * written. The conversation id is the fallback.
 *
 * Only a CHANGE of the live name renames the title (`lastSeen` remembers the
 * last name seen per terminal and is updated in place). A title the user
 * just edited therefore survives while Claude has not applied the matching
 * `/rename` yet — a busy agent applies it after its current turn — and is
 * then confirmed (or corrected, if Claude picked another name) by the change.
 */
export function agentTitleUpdates(
  terminals: AgentTerminal[],
  live: LiveAgentName[],
  lastSeen: Map<number, string>,
): Array<{ sessionId: number; name: string }> {
  const nameByConversation = new Map(live.map((a) => [a.session_id, a.name]));
  const nameBySession = new Map<number, string>();
  for (const agent of live) {
    if (agent.maestro_session != null) nameBySession.set(agent.maestro_session, agent.name);
  }
  const updates: Array<{ sessionId: number; name: string }> = [];
  for (const terminal of terminals) {
    const name =
      nameBySession.get(terminal.sessionId) ??
      (terminal.conversationId ? nameByConversation.get(terminal.conversationId) : undefined);
    if (!name || lastSeen.get(terminal.sessionId) === name) continue;
    lastSeen.set(terminal.sessionId, name);
    if (terminal.title !== name) updates.push({ sessionId: terminal.sessionId, name });
  }
  return updates;
}
