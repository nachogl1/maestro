import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Eye, Network, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  AgentExchangeDrawer,
  agentBadge,
  badgeBaseClass,
  buildExportMarkdown,
  edgeStroke,
  SESSION_STATUS_BADGES,
  shortModel,
  statsLine,
  ToolStatsRow,
} from "@/components/session/agentPresentation";
import { LiveActivityPopover } from "@/components/session/LiveActivityPopover";
import { SamuraiBadge } from "@/components/terminal/SamuraiBadge";
import { ThinkingIndicator } from "@/components/terminal/ThinkingIndicator";
import { type AgentTreeNode, buildAgentTree } from "@/lib/agentTree";
import { deriveSessionModel } from "@/lib/liveActivity";
import { useActivityStore } from "@/stores/useActivityStore";
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
 * Structure mirrors what the transcripts record: a single root node (the main
 * session, from useSessionStore) and the spawn tree of its agents
 * (useAgentStore). Agents spawned BY an agent are read from the
 * conversation's subagents folder and carry `parentAgentId`, so the graph
 * nests to any depth — one column per depth, each parent centered beside the
 * block of agents it spawned.
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
  const [liveOpen, setLiveOpen] = useState(false);

  // Sort by spawn timestamp (ISO strings sort lexicographically) so node
  // positions stay stable as new agents append.
  const sessionAgents = useMemo(
    () =>
      agents
        .filter((a) => a.sessionId === sessionId)
        .sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt)),
    [agents, sessionId],
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
    }),
  );

  // The model the session itself runs on (issue #126), read from the latest
  // assistant message the transcript watcher has forwarded.
  const activityEvents = useActivityStore((s) => s.sessions[sessionId]?.events);
  const sessionModel = useMemo(() => deriveSessionModel(activityEvents ?? []), [activityEvents]);

  // Leaving Working closes the popover FOR REAL (`showLivePopover` below only
  // hides it) — otherwise Working→NeedsInput→Working would reopen it
  // uninvited with the stale `liveOpen` still true.
  const working = session?.status === "Working";
  useEffect(() => {
    if (!working) setLiveOpen(false);
  }, [working]);

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
        {sessionModel && (
          <span
            className={`${badgeBaseClass} bg-maestro-muted/15 text-maestro-muted`}
            title={`Model: ${sessionModel}`}
          >
            {shortModel(sessionModel)}
          </span>
        )}
        <span className={`${badgeBaseClass} ${rootBadge.cls}`}>{rootBadge.label}</span>
        {/* Samurai supervision (issue #46) — nothing for non-supervised sessions. */}
        <SamuraiBadge sessionId={sessionId} />
        {/* Live activity (issue #94): top-level sessions only — a subagent's
            internals never reach the bus, so its node keeps the brief/report
            drawer instead. */}
        {session.status === "Working" && (
          <button
            type="button"
            onClick={() => setLiveOpen((v) => !v)}
            aria-label="Show live activity"
            title="What is this agent doing right now?"
            className="shrink-0 rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
          >
            <Eye size={11} />
          </button>
        )}
      </div>
      <p className="mt-1 truncate text-[11px] text-maestro-muted">{rootDescription}</p>
    </div>
  );

  // Hidden (not just closed) the moment the session stops working, so a stale
  // "live" summary never outlives the eye that opened it.
  const showLivePopover = liveOpen && session.status === "Working";

  if (sessionAgents.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-auto bg-maestro-bg p-6">
        {rootNode}
        {showLivePopover && (
          <LiveActivityPopover
            sessionId={sessionId}
            onClose={() => setLiveOpen(false)}
            className="w-[320px]"
          />
        )}
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

  /* ── Layout: session root at left, then one agent column per depth ── */
  const subtreeH = (node: AgentTreeNode): number => {
    if (node.children.length === 0) return NODE_H;
    const children =
      node.children.reduce((sum, child) => sum + subtreeH(child), 0) +
      (node.children.length - 1) * V_GAP;
    return Math.max(NODE_H, children);
  };

  const childX = PAD + ROOT_W + COL_GAP;
  const placed: { node: AgentTreeNode; x: number; y: number; parentId: string | null }[] = [];
  // Each node is centered against its own subtree, so a parent sits midway
  // beside the block of agents it spawned — the same centering the root gets.
  const place = (node: AgentTreeNode, top: number, parentId: string | null) => {
    const height = subtreeH(node);
    placed.push({
      node,
      x: childX + (node.depth - 1) * (NODE_W + COL_GAP),
      y: top + (height - NODE_H) / 2,
      parentId,
    });
    let cursor = top;
    for (const child of node.children) {
      place(child, cursor, node.agent.agentId);
      cursor += subtreeH(child) + V_GAP;
    }
  };
  let stackCursor = PAD;
  for (const root of buildAgentTree(sessionAgents)) {
    place(root, stackCursor, null);
    stackCursor += subtreeH(root) + V_GAP;
  }

  const stackH = Math.max(0, stackCursor - V_GAP - PAD);
  const maxDepth = placed.reduce((deepest, p) => Math.max(deepest, p.node.depth), 1);
  const contentW = PAD * 2 + ROOT_W + COL_GAP + maxDepth * NODE_W + (maxDepth - 1) * COL_GAP;
  const contentH = PAD * 2 + Math.max(ROOT_H, stackH);
  const rootX = PAD;
  const rootY = PAD + Math.max(0, (stackH - ROOT_H) / 2);
  const rootRight = rootX + ROOT_W;
  const rootMidY = rootY + ROOT_H / 2;
  const positionOf = new Map(placed.map((p) => [p.node.agent.agentId, p]));

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
          {placed.map(({ node, x, y, parentId }) => {
            const agent = node.agent;
            // Edges leave the session root, or the parent agent's right edge.
            const parent = parentId ? positionOf.get(parentId) : undefined;
            const startX = parent ? parent.x + NODE_W : rootRight;
            const startY = parent ? parent.y + NODE_H / 2 : rootMidY;
            const endY = y + NODE_H / 2;
            const midX = startX + COL_GAP / 2;
            const running = agent.completedAt === null;
            return (
              <path
                key={agent.agentId}
                d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${x} ${endY}`}
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

        {/* Live-activity popover, anchored under the root node. Outside the
            card because the card clips its overflow. */}
        {showLivePopover && (
          <div
            className="absolute z-20"
            style={{ left: rootX, top: rootY + ROOT_H + 6, width: 320 }}
          >
            <LiveActivityPopover sessionId={sessionId} onClose={() => setLiveOpen(false)} />
          </div>
        )}

        {/* Subagent nodes, one column per nesting depth */}
        {placed.map(({ node, x, y }) => {
          const agent = node.agent;
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
                left: x,
                top: y,
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
                {/* biome-ignore lint/a11y/useSemanticElements: can't be a real <button> — this whole card is already a <button>, and nested buttons are invalid HTML that breaks click handling. */}
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Dismiss ${agent.agentType}`}
                  title="Remove from the graph"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (openAgentId === agent.agentId) setOpenAgentId(null);
                    dismiss(agent.sessionId, agent.agentId);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.stopPropagation();
                    e.preventDefault();
                    dismiss(agent.sessionId, agent.agentId);
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
      {openAgent && <AgentExchangeDrawer agent={openAgent} onClose={() => setOpenAgentId(null)} />}
    </div>
  );
}
