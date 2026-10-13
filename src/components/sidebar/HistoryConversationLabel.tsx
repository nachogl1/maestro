import { useEffect } from "react";
import type { ClaudeSessionInfo } from "@/lib/terminal";
import { useSessionSummaryStore } from "@/stores/useSessionSummaryStore";

interface HistoryConversationLabelProps {
  conv: ClaudeSessionInfo;
  /** Name only, on one line — for the "Running now" list. */
  compact?: boolean;
}

/**
 * A History row's identity: the session's name and a two-sentence AI summary
 * of what it did. The name is the transcript's own title (the user's
 * `/rename`, else Claude Code's AI title) and falls back to the AI-written
 * name. Mounting asks for the summary, so only rows on screen cost a model
 * call. When the summary cannot be made, the first prompt stands in for the
 * name so the row stays recognisable, and the reason sits in the hover.
 */
export function HistoryConversationLabel({ conv, compact = false }: HistoryConversationLabelProps) {
  const entry = useSessionSummaryStore((s) => s.entries[conv.session_id]);
  const request = useSessionSummaryStore((s) => s.request);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-ask only when the transcript changed, not on every new listing object
  useEffect(() => {
    request(conv);
  }, [conv.session_id, conv.last_active, conv.message_count, request]);

  const failed = entry?.status === "error";
  const name =
    conv.title?.trim() ||
    entry?.name?.trim() ||
    (failed ? conv.first_prompt?.trim() : null) ||
    (entry?.status === "loading" ? "Naming session…" : "Untitled session");

  if (compact) {
    return <span className="truncate text-[10px] text-maestro-text">{name}</span>;
  }

  return (
    <>
      <span className="line-clamp-1 block text-[11px] font-semibold leading-snug text-maestro-text">
        {name}
      </span>
      {entry?.status === "ready" ? (
        <span className="line-clamp-3 block text-[10px] leading-snug text-maestro-muted">
          {entry.summary}
        </span>
      ) : failed ? (
        <span
          className="block text-[10px] italic leading-snug text-maestro-muted/70"
          title={`${entry.error ?? "Unknown error"} — reopen the project to retry`}
        >
          Summary unavailable
        </span>
      ) : (
        <span className="block text-[10px] italic leading-snug text-maestro-muted/70">
          Summarising…
        </span>
      )}
    </>
  );
}
