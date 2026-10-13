import { create } from "zustand";
import { type ClaudeSessionInfo, summarizeClaudeSession } from "@/lib/terminal";

/** One conversation's AI label, as far as it has got. */
export interface SessionSummaryEntry {
  status: "loading" | "ready" | "error";
  /** The transcript state it was requested for — a changed key re-requests. */
  key: string;
  name: string | null;
  summary: string | null;
  error: string | null;
}

interface SessionSummaryState {
  /** Keyed by Claude session id. */
  entries: Record<string, SessionSummaryEntry>;
  /**
   * Asks the backend for a conversation's label unless one is already loaded
   * or in flight for the same transcript state. A failed entry is retried on
   * the next request (e.g. when the row mounts again), never in a loop.
   */
  request: (conv: ClaudeSessionInfo) => void;
}

type SummaryTarget = Pick<ClaudeSessionInfo, "session_id" | "last_active" | "message_count">;

function summaryKey(conv: SummaryTarget): string {
  return `${conv.last_active}|${conv.message_count}`;
}

/**
 * AI-written names and summaries for History rows. Shared across remounts so
 * switching sidebar tabs does not re-ask; the backend's disk cache covers
 * app restarts.
 */
export const useSessionSummaryStore = create<SessionSummaryState>((set, get) => ({
  entries: {},
  request: (conv) => {
    const key = summaryKey(conv);
    const existing = get().entries[conv.session_id];
    if (existing && existing.key === key && existing.status !== "error") return;

    const id = conv.session_id;
    const settle = (entry: SessionSummaryEntry) =>
      set((s) => {
        // A newer request for this session superseded this one — drop it.
        if (s.entries[id]?.key !== key) return s;
        return { entries: { ...s.entries, [id]: entry } };
      });

    set((s) => ({
      entries: {
        ...s.entries,
        [id]: { status: "loading", key, name: null, summary: null, error: null },
      },
    }));
    summarizeClaudeSession(conv)
      .then((result) => {
        if (!result?.summary) throw new Error("the backend returned no summary");
        settle({
          status: "ready",
          key,
          name: result.name || null,
          summary: result.summary,
          error: null,
        });
      })
      .catch((error) => {
        console.error("Failed to summarise conversation:", error);
        settle({
          status: "error",
          key,
          name: null,
          summary: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  },
}));
