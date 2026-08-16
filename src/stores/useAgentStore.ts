import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { ClaudeEvent, SubagentToolStats } from "@/types/claude-events";

/**
 * A subagent spawned by a Claude Code session (an `Agent`/`Task` tool
 * invocation detected in the session's transcript), plus everything the
 * transcript says about what it was asked to do and what it sent back.
 *
 * Fields up to `success` are always known. The rest is detail Claude Code
 * records on completion: a foreground agent reports all of it, a background one
 * reports only its status and report (its notification carries no counters), and
 * an older transcript may report none of it — hence the nulls.
 */
export interface SubagentInfo {
  /** The Agent/Task tool_use id — unique per spawn. */
  agentId: string;
  /** Maestro session (terminal) the agent runs inside. */
  sessionId: number;
  agentType: string;
  description: string;
  /** The full brief the orchestrator sent down. Known from the spawn. */
  prompt: string;
  /** Launched in the background, so it keeps running past its tool_result. */
  runInBackground: boolean;
  /**
   * Tool_use id of the agent that spawned this one — a nested agent, read
   * from the parent's own transcript in the subagents folder. Null for agents
   * the session itself spawned (and for synthesized orphans).
   */
  parentAgentId: string | null;
  /** Transcript timestamp of the spawn. */
  spawnedAt: string;
  /** Epoch ms of completion; null while running. From the transcript timestamp. */
  completedAt: number | null;
  /** Whether the agent reported success; null while running. */
  success: boolean | null;
  /** The agent's full report back to the orchestrator; empty until it finishes. */
  report: string;
  /** Raw status verbatim ("completed", …) when the transcript states one. */
  status: string | null;
  /** Model Claude resolved for this agent. */
  model: string | null;
  durationMs: number | null;
  totalTokens: number | null;
  toolUseCount: number | null;
  toolStats: SubagentToolStats | null;
  /** Claude's own id for the run — not the same as the tool_use id. */
  agentRunId: string | null;
}

interface AgentState {
  agents: SubagentInfo[];
  handleEvent: (event: ClaudeEvent) => void;
  /**
   * Fold a whole batch of events in ONE set() call. The backend coalesces
   * events on a 16ms timer, so a transcript replay arrives as a few
   * hundred-event batches instead of hundreds of individual messages.
   */
  handleEvents: (events: ClaudeEvent[]) => void;
  /**
   * Remove one agent from the graph. Nothing else ever removes them.
   * Keyed on (session, agent) like every event handler: a resumed
   * conversation replays the same tool_use ids, so the id alone would also
   * take the other session's node.
   */
  dismiss: (sessionId: number, agentId: string) => void;
  /** Remove every finished agent of one session, leaving the running ones. */
  clearFinished: (sessionId: number) => void;
  /**
   * Remove every finished agent everywhere, plus the dead ones: agents still
   * marked running whose session is not in `liveSessionIds` — its terminal
   * ended or is gone, so the agent can never complete and would otherwise
   * show as "running" forever.
   */
  clearFinishedAndDead: (liveSessionIds: ReadonlySet<number>) => void;
}

/**
 * Store of the subagents seen in each session's transcript.
 *
 * Agents are kept until the user dismisses them: a finished agent stays on the
 * graph with its final status, its brief and its report, so a whole
 * orchestration run can be read back after every agent has stopped. Nothing
 * expires them on a timer and a dead session does not drop them — the only
 * removals are [`dismiss`], [`clearFinished`] and [`clearFinishedAndDead`],
 * plus quitting the app, since this store is in memory only.
 */
/**
 * Apply one event to the agent list, returning the SAME array reference when
 * nothing changed (which lets `set` skip the subscriber notification, exactly
 * as the old per-event `return state` did). Pure, so a whole batch can be
 * folded through it inside a single `set` call.
 */
function applyEvent(agents: SubagentInfo[], event: ClaudeEvent): SubagentInfo[] {
  switch (event.event_type) {
    case "SubagentSpawned": {
      // Identity is (session, agent): resuming a conversation in a new
      // terminal replays the same Task tool_use ids, and the new session
      // must get its own nodes rather than be hidden by the dead one's.
      if (agents.some((a) => a.agentId === event.agent_id && a.sessionId === event.session_id))
        return agents;
      return [
        ...agents,
        {
          agentId: event.agent_id,
          sessionId: event.session_id,
          agentType: event.agent_type,
          description: event.description,
          prompt: event.prompt,
          runInBackground: event.run_in_background,
          parentAgentId: event.parent_agent_id ?? null,
          spawnedAt: event.timestamp,
          completedAt: null,
          success: null,
          report: "",
          status: null,
          // The requested model from the spawn input, when named (issue
          // #126); the launch/completion later resolves the actual one.
          model: event.model ?? null,
          durationMs: null,
          totalTokens: null,
          toolUseCount: null,
          toolStats: null,
          agentRunId: null,
        },
      ];
    }
    // A background agent's launch acknowledgement: still running, but now we
    // know the run id and which model it got. Only an async agent is ever
    // acknowledged this way, so this — not the spawn's `run_in_background`,
    // which real transcripts often omit — is what marks it as one.
    case "SubagentLaunched": {
      if (!agents.some((a) => a.agentId === event.agent_id && a.sessionId === event.session_id))
        return agents;
      return agents.map((a) =>
        a.agentId === event.agent_id && a.sessionId === event.session_id
          ? {
              ...a,
              runInBackground: true,
              agentRunId: event.agent_run_id || a.agentRunId,
              model: event.model || a.model,
            }
          : a,
      );
    }
    case "SubagentCompleted": {
      // Use the transcript timestamp: catch-up reads replay old history, and
      // a wall-clock stamp would date every agent to the moment the session
      // was resumed.
      const parsed = Date.parse(event.timestamp);
      const completedAt = Number.isNaN(parsed) ? Date.now() : parsed;
      const target = agents.find(
        (a) => a.agentId === event.agent_id && a.sessionId === event.session_id,
      );
      if (!target) {
        // An orphan completion: the watcher never saw this agent's spawn
        // (it lives in a transcript file the watcher never read). Synthesize
        // the agent from what the completion carries — losing the prompt is
        // better than losing the whole run.
        return [
          ...agents,
          {
            agentId: event.agent_id,
            sessionId: event.session_id,
            agentType: event.agent_type || "unknown",
            description: "",
            prompt: "",
            runInBackground: false,
            parentAgentId: null,
            spawnedAt: event.timestamp,
            completedAt,
            success: event.success,
            report: event.report,
            status: event.status,
            model: event.model,
            durationMs: event.duration_ms,
            totalTokens: event.total_tokens,
            toolUseCount: event.tool_use_count,
            toolStats: event.tool_stats,
            agentRunId: event.agent_run_id,
          },
        ];
      }
      // A detailed completion must not be clobbered by a bare one replayed
      // on catch-up. A later notification carrying a fresh report does
      // update it, because a background agent can be resumed and report
      // again under the same id.
      if (target.completedAt !== null && !event.report) return agents;
      return agents.map((a) =>
        a.agentId === event.agent_id && a.sessionId === event.session_id
          ? {
              ...a,
              completedAt,
              success: event.success,
              report: event.report || a.report,
              status: event.status ?? a.status,
              // The spawn names no subagent_type for Claude's default
              // agent; the result resolves it.
              agentType: event.agent_type || a.agentType,
              model: event.model ?? a.model,
              durationMs: event.duration_ms ?? a.durationMs,
              totalTokens: event.total_tokens ?? a.totalTokens,
              toolUseCount: event.tool_use_count ?? a.toolUseCount,
              toolStats: event.tool_stats ?? a.toolStats,
              agentRunId: event.agent_run_id ?? a.agentRunId,
            }
          : a,
      );
    }
    default:
      return agents;
  }
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],

  handleEvent: (event: ClaudeEvent) => {
    set((state) => {
      const agents = applyEvent(state.agents, event);
      return agents === state.agents ? state : { agents };
    });
  },

  handleEvents: (events: ClaudeEvent[]) => {
    if (events.length === 0) return;
    set((state) => {
      let agents = state.agents;
      for (const event of events) {
        agents = applyEvent(agents, event);
      }
      return agents === state.agents ? state : { agents };
    });
  },

  dismiss: (sessionId: number, agentId: string) =>
    set((state) => {
      const kept = state.agents.filter((a) => a.agentId !== agentId || a.sessionId !== sessionId);
      return kept.length === state.agents.length ? state : { agents: kept };
    }),

  clearFinished: (sessionId: number) =>
    set((state) => {
      const kept = state.agents.filter((a) => a.sessionId !== sessionId || a.completedAt === null);
      return kept.length === state.agents.length ? state : { agents: kept };
    }),

  clearFinishedAndDead: (liveSessionIds: ReadonlySet<number>) =>
    set((state) => {
      const kept = state.agents.filter(
        (a) => a.completedAt === null && liveSessionIds.has(a.sessionId),
      );
      return kept.length === state.agents.length ? state : { agents: kept };
    }),
}));

// Global event listener. `active` tracks the *desired* state so an init/stop
// pair that races the pending listen() promise (React StrictMode's dev
// double-mount) can't leak a second listener.
let unlisten: UnlistenFn | null = null;
let starting: Promise<void> | null = null;
let active = false;

export async function initAgentListener(): Promise<void> {
  active = true;
  if (unlisten || starting) return;
  starting = listen<ClaudeEvent[]>("claude-events", (event) => {
    useAgentStore.getState().handleEvents(event.payload);
  })
    .then((fn) => {
      if (!active) {
        fn();
        return;
      }
      unlisten = fn;
    })
    .finally(() => {
      starting = null;
    });
  await starting;
}

export function stopAgentListener(): void {
  active = false;
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}
