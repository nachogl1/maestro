import { useEffect } from "react";
import { type AgentTerminal, agentTitleUpdates, listLiveAgentNames } from "@/lib/agentName";
import { useActivityStore } from "@/stores/useActivityStore";
import { useSessionStore } from "@/stores/useSessionStore";

/** How often Claude's session registry is re-read. A few tiny files. */
const AGENT_NAME_POLL_MS = 3000;

/** The Claude terminals open right now, each with its current conversation. */
function claudeTerminals(): AgentTerminal[] {
  const activity = useActivityStore.getState().sessions;
  return useSessionStore
    .getState()
    .sessions.filter((s) => s.mode === "Claude")
    .map((s) => {
      const conversations = activity[s.id]?.conversationUuids ?? [];
      return {
        sessionId: s.id,
        title: s.name,
        conversationId: conversations[conversations.length - 1],
      };
    });
}

/**
 * Keeps every Claude terminal's title equal to its live agent name — the
 * name other agents message it by — including names Claude chose itself and
 * `/rename`s typed straight into the terminal. Mounted once by
 * `useBackgroundPollers`.
 */
export function useAgentNameSync(): void {
  useEffect(() => {
    const lastSeen = new Map<number, string>();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const terminals = claudeTerminals();
      // Every Claude terminal is a candidate: the backend matches a live
      // claude to its terminal by process tree, so a conversation id (which
      // only the SessionStart hook reports) is not required.
      if (terminals.length > 0) {
        try {
          const live = await listLiveAgentNames();
          if (stopped) return;
          const renameSession = useSessionStore.getState().renameSession;
          for (const { sessionId, name } of agentTitleUpdates(terminals, live, lastSeen)) {
            await renameSession(sessionId, name);
          }
        } catch (err) {
          console.warn("[AgentName] Could not sync agent names:", err);
        }
      }
      if (!stopped) timer = setTimeout(tick, AGENT_NAME_POLL_MS);
    };

    timer = setTimeout(tick, AGENT_NAME_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
}
