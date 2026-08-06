import { createContext, useContext } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ArrowUpRight, Folder, TerminalSquare, X } from "lucide-react";
import { SamuraiBadge } from "@/components/terminal/SamuraiBadge";
import { ThinkingIndicator } from "@/components/terminal/ThinkingIndicator";
import {
  agentBadge,
  badgeBaseClass,
  SESSION_STATUS_BADGES,
  statsLine,
  ToolStatsRow,
} from "@/components/session/agentPresentation";
import type { SubagentInfo } from "@/stores/useAgentStore";
import type { BackendSessionStatus } from "@/stores/useSessionStore";
import { AGENT_H, AGENT_W, PROJECT_H, PROJECT_W, TERMINAL_H, TERMINAL_W } from "./layout";

/**
 * The three node kinds of the landscape graph.
 *
 * Data is plain values only — the callbacks live in {@link LandscapeActions}
 * context instead, so a node's data can be rebuilt on every store change
 * without new function identities churning React Flow's internals.
 */

export type ProjectNodeData = {
  kind: "project";
  tabId: string;
  name: string;
  path: string;
  color: string;
  /** Worst status among the project's terminals — what needs your attention. */
  status: BackendSessionStatus;
  terminalCount: number;
  runningAgentCount: number;
  /** Filtered out: shown faded rather than hidden, so the map keeps its shape. */
  dimmed: boolean;
};

export type TerminalNodeData = {
  kind: "terminal";
  tabId: string;
  sessionId: number;
  title: string;
  description: string;
  status: BackendSessionStatus;
  color: string;
  agentCount: number;
  dimmed: boolean;
};

export type AgentNodeData = {
  kind: "agent";
  agent: SubagentInfo;
  dimmed: boolean;
};

export type LandscapeNodeData = ProjectNodeData | TerminalNodeData | AgentNodeData;

/** What a node can ask the view to do. */
export interface LandscapeActions {
  /** Open the agent's brief/report drawer. */
  openAgent: (agent: SubagentInfo) => void;
  /** Remove one finished/running agent from the graph (same as the old graph's ×). */
  dismissAgent: (agentId: string) => void;
  /** Leave the landscape and focus that terminal. */
  openTerminal: (tabId: string, sessionId: number) => void;
  /** Leave the landscape and activate that project tab. */
  openProject: (tabId: string) => void;
}

const noop = () => {};

const LandscapeActionsContext = createContext<LandscapeActions>({
  openAgent: noop,
  dismissAgent: noop,
  openTerminal: noop,
  openProject: noop,
});

export const LandscapeActionsProvider = LandscapeActionsContext.Provider;

/** Invisible connection points — edges attach here; users never draw edges. */
function EdgeHandles({ source, target }: { source?: boolean; target?: boolean }) {
  return (
    <>
      {target && (
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={false}
          className="!h-1 !w-1 !border-0 !bg-transparent"
        />
      )}
      {source && (
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={false}
          className="!h-1 !w-1 !border-0 !bg-transparent"
        />
      )}
    </>
  );
}

/** Border treatment shared by project and terminal nodes. */
function statusBorderClass(status: BackendSessionStatus): string {
  if (status === "NeedsInput") return "border-maestro-accent";
  if (status === "Working") return "border-maestro-blue/70";
  if (status === "Error" || status === "Timeout") return "border-maestro-red/70";
  return "border-maestro-border";
}

const dimClass = (dimmed: boolean) => (dimmed ? "opacity-25" : "opacity-100");

/**
 * A project: the root of one cluster. Shows the rollup of everything inside it
 * so a collapsed/zoomed-out view still tells you where the action is.
 */
export function ProjectNode({ data, selected }: NodeProps) {
  const d = data as ProjectNodeData;
  const { openProject } = useContext(LandscapeActionsContext);
  const badge = SESSION_STATUS_BADGES[d.status] ?? SESSION_STATUS_BADGES.Idle;
  return (
    <div
      style={{ width: PROJECT_W, height: PROJECT_H, borderLeftColor: d.color }}
      title={d.path}
      className={`flex flex-col justify-center rounded-lg border border-l-4 bg-maestro-surface px-3 py-2 transition-opacity ${statusBorderClass(
        d.status,
      )} ${dimClass(d.dimmed)} ${selected ? "ring-1 ring-maestro-accent" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        <Folder size={13} className="shrink-0" style={{ color: d.color }} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-maestro-text">
          {d.name}
        </span>
        <span className={`${badgeBaseClass} ${badge.cls}`}>{badge.label}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openProject(d.tabId);
          }}
          title={`Open ${d.name}`}
          aria-label={`Open project ${d.name}`}
          className="nodrag shrink-0 rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
        >
          <ArrowUpRight size={13} />
        </button>
      </div>
      <p className="mt-1 truncate text-[11px] text-maestro-muted">
        {d.terminalCount} terminal{d.terminalCount === 1 ? "" : "s"}
        {d.runningAgentCount > 0 ? ` · ${d.runningAgentCount} agent${
          d.runningAgentCount === 1 ? "" : "s"
        } running` : ""}
      </p>
      <p className="truncate text-[10px] text-maestro-muted/70">{d.path}</p>
      <EdgeHandles source />
    </div>
  );
}

/** A terminal (Maestro session) — the same card the per-terminal graph roots on. */
export function TerminalNode({ data, selected }: NodeProps) {
  const d = data as TerminalNodeData;
  const { openTerminal } = useContext(LandscapeActionsContext);
  const badge = SESSION_STATUS_BADGES[d.status] ?? SESSION_STATUS_BADGES.Idle;
  return (
    <div
      style={{ width: TERMINAL_W, height: TERMINAL_H }}
      title={d.description}
      className={`flex flex-col justify-center rounded-lg border bg-maestro-card px-3 py-2 transition-opacity ${statusBorderClass(
        d.status,
      )} ${dimClass(d.dimmed)} ${selected ? "ring-1 ring-maestro-accent" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        <TerminalSquare size={12} className="shrink-0 text-maestro-muted" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-maestro-text">
          {d.title}
        </span>
        <ThinkingIndicator sessionId={d.sessionId} />
        <span className={`${badgeBaseClass} ${badge.cls}`}>{badge.label}</span>
        {/* Samurai supervision (issue #46) — nothing for non-supervised sessions. */}
        <SamuraiBadge sessionId={d.sessionId} />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openTerminal(d.tabId, d.sessionId);
          }}
          title="Go to this terminal"
          aria-label={`Go to terminal ${d.title}`}
          className="nodrag shrink-0 rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
        >
          <ArrowUpRight size={12} />
        </button>
      </div>
      <p className="mt-1 truncate text-[11px] text-maestro-muted">{d.description}</p>
      <p className="truncate text-[10px] text-maestro-muted/70">
        {d.agentCount === 0
          ? "no subagents"
          : `${d.agentCount} subagent${d.agentCount === 1 ? "" : "s"}`}
      </p>
      <EdgeHandles target source />
    </div>
  );
}

/** A subagent — identical content to the per-terminal graph's agent card. */
export function AgentNode({ data, selected }: NodeProps) {
  const d = data as AgentNodeData;
  const { openAgent, dismissAgent } = useContext(LandscapeActionsContext);
  const agent = d.agent;
  const badge = agentBadge(agent);
  const running = agent.completedAt === null;
  const stats = statsLine(agent);
  return (
    <div
      style={{ width: AGENT_W, height: AGENT_H }}
      title="Click to read the brief sent and the report returned"
      onClick={() => openAgent(agent)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        openAgent(agent);
      }}
      role="button"
      tabIndex={0}
      className={`flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-maestro-card px-3 py-2 text-left transition-opacity hover:border-maestro-accent ${
        running ? "border-maestro-accent/60" : "border-maestro-border"
      } ${dimClass(d.dimmed)} ${selected ? "ring-1 ring-maestro-accent" : ""}`}
    >
      <div className="flex w-full items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-maestro-text">
          {agent.agentType}
        </span>
        {agent.runInBackground && (
          <span
            className={`${badgeBaseClass} bg-maestro-muted/15 text-maestro-muted`}
            title="Launched in the background"
          >
            BG
          </span>
        )}
        <span className={`${badgeBaseClass} ${badge.cls}`}>{badge.label}</span>
        <button
          type="button"
          aria-label={`Dismiss ${agent.agentType}`}
          title="Remove from the graph"
          onClick={(e) => {
            e.stopPropagation();
            dismissAgent(agent.agentId);
          }}
          className="nodrag shrink-0 rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
        >
          <X size={11} />
        </button>
      </div>
      <p className="mt-1 w-full truncate text-[11px] text-maestro-muted">
        {agent.description || "—"}
      </p>
      {stats && <p className="mt-1 w-full truncate text-[10px] text-maestro-muted">{stats}</p>}
      <ToolStatsRow agent={agent} />
      <EdgeHandles target />
    </div>
  );
}

/** Node type registry handed to React Flow. */
export const landscapeNodeTypes = {
  project: ProjectNode,
  terminal: TerminalNode,
  agent: AgentNode,
};
