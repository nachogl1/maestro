import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Network, Trash2, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { SamuraiBadge } from "@/components/terminal/SamuraiBadge";
import { ThinkingIndicator } from "@/components/terminal/ThinkingIndicator";
import {
  AgentExchangeDrawer,
  agentBadge,
  badgeBaseClass,
  buildExportMarkdown,
  edgeStroke,
  SESSION_STATUS_BADGES,
  statsLine,
  ToolStatsRow,
} from "@/components/session/agentPresentation";
import { useAgentStore } from "@/stores/useAgentStore";
import { useSessionStore } from "@/stores/useSessionStore";

// Re-exported so the markdown export stays importable from the graph that owns
// the "Export run" button.
export { buildExportMarkdown };

interface AgentGraphProps {
  sessionId: number;
}

/* ── Layout constants (px) ── */
const PAD = 24;
const ROOT_W = 220;
const ROOT_H = 64;
const NODE_W = 250;
const NODE_H = 96;
const V_GAP = 14;
const COL_GAP = 80;

/**
 * Live node graph of the agents running inside one terminal session.
 *
 * Structure is the honest one the app actually tracks: a single root node
 * (the main session, from useSessionStore) fanned out to the subagents the
 * transcript watcher reported for that session (useAgentStore — Agent/Task tool
 * spawns and completions). No parent->child nesting exists in the transcript —
 * a subagent's own tool calls are never written to the parent's file — so the
 * graph is always 1 root -> N children.
 *
 * Nodes persist with their final status until dismissed, so a finished run can
 * be read back; clicking one opens the exchange drawer with the full brief the
 * orchestrator sent and the full report the agent returned.
 *
 * Self-subscribing (no props beyond sessionId) so mounting one per terminal
 * doesn't re-render every terminal on each agent event. Updates are live via
 * the zustand subscriptions — claude-events -> useAgentStore -> re-render.
 */
export function AgentGraph({ sessionId }: AgentGraphProps) {
  const agents = useAgentStore((s) => s.agents);
  const dismiss = useAgentStore((s) => s.dismiss);
  const clearFinished = useAgentStore((s) => s.clearFinished);
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Sort by spawn timestamp (ISO strings sort lexicographically) so node
  // positions stay stable as new agents append.
  const sessionAgents = useMemo(
    () =>
      agents
        .filter((a) => a.sessionId === sessionId)
        .sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt)),
    [agents, sessionId]
  );

  const session = useSessionStore(
    useShallow((s) => {
      const sess = s.sessions.find((x) => x.id === sessionId);
      if (!sess) return null;
      return {
        name: sess.name,
        mode: sess.mode,
        status: sess.status,
        statusMessage: sess.statusMessage,
        needsInputPrompt: sess.needsInputPrompt,
      };
    })
  );

  if (!session) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-maestro-bg">
        <div className="flex flex-col items-center gap-2 text-maestro-muted">
          <Network size={24} className="opacity-60" />
          <p className="text-xs">No active agent session</p>
        </div>
      </div>
    );
  }

  const rootBadge = SESSION_STATUS_BADGES[session.status] ?? SESSION_STATUS_BADGES.Idle;
  const rootTitle = session.name?.trim() || session.mode;
  const rootDescription =
    (session.status === "NeedsInput" && session.needsInputPrompt) ||
    session.statusMessage ||
    (session.status === "Working" ? "Working…" : "Idle");

  const rootNode = (
    <div
      className="flex flex-col justify-center overflow-hidden rounded-lg border border-maestro-border bg-maestro-card px-3 py-2 text-maestro-text"
      style={{ width: ROOT_W, height: ROOT_H }}
      title={rootDescription}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{rootTitle}</span>
        <ThinkingIndicator sessionId={sessionId} />
        <span className={`${badgeBaseClass} ${rootBadge.cls}`}>{rootBadge.label}</span>
        {/* Samurai supervision (issue #46) — nothing for non-supervised sessions. */}
        <SamuraiBadge sessionId={sessionId} />
      </div>
      <p className="mt-1 truncate text-[11px] text-maestro-muted">{rootDescription}</p>
    </div>
  );

  if (sessionAgents.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-auto bg-maestro-bg p-6">
        {rootNode}
        <p className="max-w-[280px] text-center text-[11px] italic text-maestro-muted">
          No subagents running — agents spawned via the Task tool will appear here.
        </p>
      </div>
    );
  }

  const finishedCount = sessionAgents.filter((a) => a.completedAt !== null).length;
  const openAgent = sessionAgents.find((a) => a.agentId === openAgentId) ?? null;

  const handleExport = async () => {
    setExportError(null);
    try {
      const path = await save({
        defaultPath: `agent-run-session-${sessionId}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      await invoke("export_agent_run", {
        path,
        content: buildExportMarkdown(sessionAgents, rootTitle),
      });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  };

  /* ── Layout: root at left, children stacked in a right column ── */
  const n = sessionAgents.length;
  const stackH = n * NODE_H + (n - 1) * V_GAP;
  const contentW = PAD * 2 + ROOT_W + COL_GAP + NODE_W;
  const contentH = PAD * 2 + Math.max(ROOT_H, stackH);
  const rootX = PAD;
  const rootY = PAD + Math.max(0, (stackH - ROOT_H) / 2);
  const childX = PAD + ROOT_W + COL_GAP;
  const rootRight = rootX + ROOT_W;
  const rootMidY = rootY + ROOT_H / 2;
  const midX = rootRight + COL_GAP / 2;

  return (
    <div className="relative h-full w-full overflow-auto bg-maestro-bg">
      {/* Toolbar: floats over the scrolling canvas, top-right. */}
      <div className="sticky top-0 z-10 flex items-center justify-end gap-1 px-2 py-1.5">
        {exportError && (
          <span className="mr-auto truncate text-[10px] text-red-400" title={exportError}>
            Export failed: {exportError}
          </span>
        )}
        <button
          type="button"
          onClick={handleExport}
          title="Export this run (briefs, reports and counters) to a markdown file"
          className="flex items-center gap-1 rounded border border-maestro-border bg-maestro-card px-1.5 py-0.5 text-[10px] text-maestro-muted transition-colors hover:text-maestro-text"
        >
          <Download size={10} />
          Export run
        </button>
        <button
          type="button"
          onClick={() => {
            clearFinished(sessionId);
            setOpenAgentId(null);
          }}
          disabled={finishedCount === 0}
          title="Remove every finished agent from this graph"
          className="flex items-center gap-1 rounded border border-maestro-border bg-maestro-card px-1.5 py-0.5 text-[10px] text-maestro-muted transition-colors hover:text-maestro-text disabled:opacity-40"
        >
          <Trash2 size={10} />
          Clear finished{finishedCount > 0 ? ` (${finishedCount})` : ""}
        </button>
      </div>

      <div className="relative" style={{ width: contentW, height: contentH }}>
        {/* Edge overlay */}
        <svg
          className="pointer-events-none absolute inset-0"
          width={contentW}
          height={contentH}
          aria-hidden="true"
        >
          {sessionAgents.map((agent, i) => {
            const childMidY = PAD + i * (NODE_H + V_GAP) + NODE_H / 2;
            const running = agent.completedAt === null;
            return (
              <path
                key={agent.agentId}
                d={`M ${rootRight} ${rootMidY} C ${midX} ${rootMidY}, ${midX} ${childMidY}, ${childX} ${childMidY}`}
                fill="none"
                stroke={edgeStroke(agent)}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeDasharray={running ? "6 6" : undefined}
                className={running ? "animate-edge-dash" : undefined}
              />
            );
          })}
        </svg>

        {/* Root node (main session) */}
        <div className="absolute" style={{ left: rootX, top: rootY }}>
          {rootNode}
        </div>

        {/* Subagent nodes */}
        {sessionAgents.map((agent, i) => {
          const badge = agentBadge(agent);
          const running = agent.completedAt === null;
          const stats = statsLine(agent);
          return (
            <button
              type="button"
              key={agent.agentId}
              onClick={() => setOpenAgentId(agent.agentId)}
              title="Show the brief sent and the report returned"
              className={`absolute flex flex-col overflow-hidden rounded-lg border bg-maestro-card px-3 py-2 text-left text-maestro-text transition-colors hover:border-maestro-accent ${
                running ? "border-maestro-accent/60" : "border-maestro-border"
              }`}
              style={{
                left: childX,
                top: PAD + i * (NODE_H + V_GAP),
                width: NODE_W,
                height: NODE_H,
              }}
            >
              <div className="flex w-full items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">
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
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Dismiss ${agent.agentType}`}
                  title="Remove from the graph"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (openAgentId === agent.agentId) setOpenAgentId(null);
                    dismiss(agent.agentId);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.stopPropagation();
                    e.preventDefault();
                    dismiss(agent.agentId);
                  }}
                  className="shrink-0 rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
                >
                  <X size={11} />
                </span>
              </div>
              <p className="mt-1 w-full truncate text-[11px] text-maestro-muted">
                {agent.description || "—"}
              </p>
              {stats && (
                <p className="mt-1 w-full truncate text-[10px] text-maestro-muted">{stats}</p>
              )}
              <ToolStatsRow agent={agent} />
            </button>
          );
        })}
      </div>

      {/* Exchange drawer: the full brief and report for one agent. */}
      {openAgent && (
        <AgentExchangeDrawer agent={openAgent} onClose={() => setOpenAgentId(null)} />
      )}
    </div>
  );
}
