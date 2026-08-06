import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { samePath } from "@/lib/path";
import { useSessionStore, type SamuraiSupervisorState } from "@/stores/useSessionStore";

/**
 * Human badge text + tint per supervisor state (issue #46 / PRD §9: the user
 * sees states, never the machinery — so "handing off", not the state-machine
 * names). Colors follow the sidebar's badge palette.
 */
const STATE_PRESENTATION: Record<SamuraiSupervisorState, { label: string; cls: string }> = {
  WORKING: { label: "working", cls: "bg-maestro-blue/15 text-maestro-blue" },
  HANDOFF_REQUESTED: { label: "handing off", cls: "bg-maestro-orange/20 text-maestro-orange" },
  HANDOFF_WRITTEN: { label: "handing off", cls: "bg-maestro-orange/20 text-maestro-orange" },
  KILLED: { label: "killed", cls: "bg-maestro-muted/15 text-maestro-muted" },
  PARK_REQUESTED: { label: "parking", cls: "bg-maestro-purple/20 text-maestro-purple" },
  PARKED: { label: "parked", cls: "bg-maestro-purple/20 text-maestro-purple" },
  DEAD: { label: "dead", cls: "bg-red-500/15 text-red-400" },
};

/** A state the backend knows but this build doesn't: show it, don't hide it. */
function presentation(state: SamuraiSupervisorState): { label: string; cls: string } {
  return (
    STATE_PRESENTATION[state] ?? {
      label: String(state).replace(/_/g, " ").toLowerCase(),
      cls: "bg-maestro-muted/15 text-maestro-muted",
    }
  );
}

/**
 * `gen-2 · working · 43%` pill for a Samurai-supervised session (issue #46):
 * generation, supervisor state, and context-window usage. Renders nothing for
 * non-supervised sessions, so every existing view stays visually unchanged.
 * Reads the store directly by session id (same pattern as ThinkingIndicator)
 * so call sites need no extra props or selectors.
 */
export const SamuraiBadge = memo(function SamuraiBadge({
  sessionId,
  className = "",
}: {
  sessionId: number;
  className?: string;
}) {
  const info = useSessionStore(
    useShallow((s) => {
      const entry = s.samuraiBySessionId[sessionId];
      if (!entry) return null;
      const session = s.sessions.find((x) => x.id === sessionId);
      // Same id+project defence as the DEAD handler: session ids alone are
      // not trusted to be unique across projects.
      if (!session || !samePath(session.project_path, entry.project)) return null;
      return {
        generation: entry.generation,
        state: entry.state,
        contextPercent: session.contextPercent,
      };
    })
  );
  if (!info) return null;

  const { label, cls } = presentation(info.state);
  const pct = info.contextPercent !== undefined ? `${Math.round(info.contextPercent)}%` : null;
  return (
    <span
      title={`Samurai-supervised: generation ${info.generation}, ${label}${
        pct ? `, ${pct} context used` : ""
      }`}
      className={`shrink-0 whitespace-nowrap rounded px-1 py-px text-[9px] font-bold tracking-wide ${cls} ${className}`}
    >
      {`gen-${info.generation} · ${label}${pct ? ` · ${pct}` : ""}`}
    </span>
  );
});
