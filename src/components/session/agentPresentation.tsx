import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  BookOpen,
  Check,
  Copy,
  PencilLine,
  Search,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { useState } from "react";
import type { SubagentInfo } from "@/stores/useAgentStore";
import type { BackendSessionStatus } from "@/stores/useSessionStore";

/**
 * Shared presentation of a subagent: badges, counters, the brief/report drawer
 * and the markdown export.
 *
 * Extracted from the per-terminal [`AgentGraph`] so every surface renders
 * the exact same agent card and drawer — one place decides what a RUNNING badge
 * looks like or how a token count is abbreviated.
 */

/** Word badge per session status (mirrors the sidebar's badges). */
export const SESSION_STATUS_BADGES: Record<BackendSessionStatus, { label: string; cls: string }> = {
  Starting: { label: "STARTING", cls: "bg-orange-500/15 text-orange-400" },
  Idle: { label: "IDLE", cls: "bg-maestro-muted/15 text-maestro-muted" },
  Working: { label: "WORKING", cls: "bg-maestro-blue/15 text-maestro-blue" },
  NeedsInput: { label: "NEEDS INPUT", cls: "bg-maestro-accent/15 text-maestro-accent" },
  Done: { label: "DONE", cls: "bg-maestro-green/15 text-maestro-green" },
  Error: { label: "ERROR", cls: "bg-red-500/15 text-red-400" },
  Timeout: { label: "TIMEOUT", cls: "bg-red-500/15 text-red-400" },
};

export const badgeBaseClass =
  "shrink-0 whitespace-nowrap rounded px-1 py-px text-[9px] font-bold tracking-wide";

/**
 * Badge for a subagent node.
 *
 * A status the transcript reports but we don't recognise is shown verbatim
 * rather than folded into DONE — better an unfamiliar word than a wrong one.
 */
export function agentBadge(agent: SubagentInfo): { label: string; cls: string } {
  if (agent.completedAt === null) {
    return { label: "RUNNING", cls: "bg-maestro-blue/15 text-maestro-blue animate-pulse" };
  }
  if (agent.success === false) {
    return { label: "FAILED", cls: "bg-red-500/15 text-red-400" };
  }
  if (agent.status && agent.status !== "completed") {
    return {
      label: agent.status.replace(/_/g, " ").toUpperCase(),
      cls: "bg-maestro-muted/15 text-maestro-muted",
    };
  }
  return { label: "DONE", cls: "bg-maestro-green/15 text-maestro-green" };
}

/** Edge color via CSS vars so the light theme (swapped vars) keeps working. */
export function edgeStroke(agent: SubagentInfo): string {
  if (agent.completedAt === null) return "rgb(var(--maestro-blue))";
  if (agent.success === false) return "rgb(var(--maestro-red))";
  return "rgb(var(--maestro-border))";
}

/* ── Formatting ── */

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Model id shortened for a 250px node: "claude-fable-5" -> "fable-5". */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "");
}

/** The one-line summary under a node's description: model, cost, effort. */
export function statsLine(agent: SubagentInfo): string {
  const parts: string[] = [];
  if (agent.model) parts.push(shortModel(agent.model));
  if (agent.durationMs !== null) parts.push(formatDuration(agent.durationMs));
  if (agent.totalTokens !== null) parts.push(`${formatTokens(agent.totalTokens)} tok`);
  if (agent.toolUseCount !== null) parts.push(`${agent.toolUseCount} tools`);
  return parts.join(" · ");
}

/**
 * One agent as markdown: the caller's heading line, then the counters, the
 * whole brief and the whole report.
 *
 * Kept whole: an export exists to be read outside Maestro, so truncating it
 * would defeat the point. The heading is passed in because the per-terminal
 * export can nest agents under a project or terminal heading.
 */
function agentMarkdownLines(agent: SubagentInfo, heading: string): string[] {
  const badge = agentBadge(agent);
  const lines: string[] = [
    heading,
    "",
    `- Status: ${badge.label}`,
    `- Tool use id: ${agent.agentId}`,
  ];
  if (agent.agentRunId) lines.push(`- Agent run id: ${agent.agentRunId}`);
  if (agent.model) lines.push(`- Model: ${agent.model}`);
  lines.push(`- Spawned: ${agent.spawnedAt}`);
  if (agent.completedAt !== null) {
    lines.push(`- Completed: ${new Date(agent.completedAt).toISOString()}`);
  }
  if (agent.runInBackground) lines.push("- Ran in the background");
  if (agent.durationMs !== null) lines.push(`- Duration: ${formatDuration(agent.durationMs)}`);
  if (agent.totalTokens !== null) lines.push(`- Tokens: ${agent.totalTokens}`);
  if (agent.toolUseCount !== null) lines.push(`- Tool calls: ${agent.toolUseCount}`);
  const s = agent.toolStats;
  if (s) {
    lines.push(
      `- Tool breakdown: ${s.read_count} read, ${s.search_count} search, ` +
        `${s.bash_count} bash, ${s.edit_file_count} edit ` +
        `(+${s.lines_added}/-${s.lines_removed} lines), ${s.other_tool_count} other`,
    );
  }
  lines.push(
    "",
    "### Brief sent",
    "",
    agent.prompt || "_(none recorded)_",
    "",
    "### Report back",
    "",
  );
  lines.push(agent.report || "_(none recorded)_", "");
  return lines;
}

/**
 * Markdown of every agent in one terminal's run.
 *
 * `heading` names the run — the terminal it belongs to.
 */
export function buildExportMarkdown(agents: SubagentInfo[], heading: string): string {
  const lines: string[] = [`# Agent run — ${heading}`, "", `${agents.length} subagent(s).`, ""];
  for (const [index, agent] of agents.entries()) {
    lines.push(
      ...agentMarkdownLines(
        agent,
        `## ${index + 1}. ${agent.agentType} — ${agent.description || "(no description)"}`,
      ),
    );
  }
  return lines.join("\n");
}

/** A copy-to-clipboard button that confirms itself for a moment. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (err) {
          console.error("Failed to copy to clipboard:", err);
        }
      }}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** The tool-call breakdown, rendered as icon + count pairs. */
export function ToolStatsRow({ agent }: { agent: SubagentInfo }) {
  const s = agent.toolStats;
  if (!s) return null;
  const items: { icon: typeof BookOpen; count: number; label: string }[] = [
    { icon: BookOpen, count: s.read_count, label: "files read" },
    { icon: Search, count: s.search_count, label: "searches" },
    { icon: TerminalIcon, count: s.bash_count, label: "shell commands" },
    { icon: PencilLine, count: s.edit_file_count, label: "file edits" },
  ];
  return (
    <div className="mt-1 flex items-center gap-2 text-[10px] text-maestro-muted">
      {items.map(({ icon: Icon, count, label }) => (
        <span key={label} className="flex items-center gap-0.5" title={`${count} ${label}`}>
          <Icon size={9} className="shrink-0" />
          {count}
        </span>
      ))}
      {(s.lines_added > 0 || s.lines_removed > 0) && (
        <span title={`${s.lines_added} lines added, ${s.lines_removed} removed`}>
          <span className="text-maestro-green">+{s.lines_added}</span>
          <span className="text-red-400">/-{s.lines_removed}</span>
        </span>
      )}
    </div>
  );
}

/** One labelled block of the drawer: a heading, a char count, copy, the text. */
function ExchangeBlock({ title, text, empty }: { title: string; text: string; empty: string }) {
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 border-b border-maestro-border pb-1">
        <span className="text-[10px] font-bold uppercase tracking-wider text-maestro-muted">
          {title}
        </span>
        <div className="flex-1" />
        {text && (
          <span className="shrink-0 text-[10px] text-maestro-muted">
            {text.length.toLocaleString()} chars
          </span>
        )}
        <CopyButton text={text} label={title.toLowerCase()} />
      </div>
      {text ? (
        <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-maestro-text">
          {text}
        </pre>
      ) : (
        <p className="mt-1.5 text-[11px] italic text-maestro-muted">{empty}</p>
      )}
    </div>
  );
}

/**
 * The full exchange for one agent: the brief the orchestrator sent down and the
 * report the agent sent back, over the graph it was opened from.
 *
 * `subtitle` lets the caller prepend context the graph itself doesn't show —
 * a caller can name the project and terminal the agent belongs to.
 */
export function AgentExchangeDrawer({
  agent,
  subtitle,
  onClose,
}: {
  agent: SubagentInfo;
  subtitle?: string;
  onClose: () => void;
}) {
  const meta = [
    agentBadge(agent).label,
    subtitle,
    agent.agentRunId,
    agent.model,
    agent.durationMs !== null ? formatDuration(agent.durationMs) : null,
    agent.totalTokens !== null ? `${agent.totalTokens.toLocaleString()} tok` : null,
    agent.toolUseCount !== null ? `${agent.toolUseCount} tool calls` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-maestro-bg/98 backdrop-blur-sm">
      <div className="flex items-start gap-2 border-b border-maestro-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-maestro-text">
            {agent.agentType}
            {agent.description ? ` — ${agent.description}` : ""}
          </p>
          <p className="mt-0.5 truncate text-[10px] text-maestro-muted">{meta}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close agent detail"
          title="Close"
          className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <ExchangeBlock
          title="Brief sent ↓"
          text={agent.prompt}
          empty="This spawn recorded no prompt."
        />
        <ExchangeBlock
          title="Report back ↑"
          text={agent.report}
          empty={
            agent.completedAt === null
              ? "Still running — the report arrives when it finishes."
              : "No report was recorded for this agent."
          }
        />
      </div>
    </div>
  );
}
