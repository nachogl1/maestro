import { X } from "lucide-react";
import { useMemo } from "react";
import { deriveLiveActivity } from "@/lib/liveActivity";
import { useActivityStore } from "@/stores/useActivityStore";

/**
 * The live-activity popover behind a running session node's eye icon
 * (issue #94): the session's latest tool call and last assistant message
 * snippet, straight from the activity store the transcript watcher feeds.
 *
 * Self-subscribing, so it refreshes on every `claude-events` batch that
 * touches this session while it is open. The caller positions it — it is just
 * the card.
 */
export function LiveActivityPopover({
  sessionId,
  onClose,
  className,
}: {
  sessionId: number;
  onClose: () => void;
  className?: string;
}) {
  const events = useActivityStore((s) => s.sessions[sessionId]?.events);
  const activity = useMemo(() => deriveLiveActivity(events ?? []), [events]);

  const updatedAt = useMemo(() => {
    if (!activity) return null;
    const parsed = Date.parse(activity.updatedAt);
    return Number.isNaN(parsed) ? activity.updatedAt : new Date(parsed).toLocaleTimeString();
  }, [activity]);

  return (
    <div
      className={`rounded-lg border border-maestro-border bg-maestro-surface p-2.5 text-left shadow-lg ${
        className ?? ""
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-maestro-muted">
          Live activity
        </span>
        <div className="flex-1" />
        {updatedAt && (
          <span className="shrink-0 text-[10px] text-maestro-muted" title="Last transcript update">
            {updatedAt}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close live activity"
          title="Close"
          className="shrink-0 rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
        >
          <X size={11} />
        </button>
      </div>

      {activity ? (
        /* Scrolls instead of clipping (issue #127): three wrapped tool lines
           plus a snippet can outgrow the anchored card. */
        <div className="max-h-64 overflow-y-auto">
          {/* The latest tool calls, oldest first — the shape of the current
              turn, each line wrapped in full rather than truncated. */}
          {activity.recentTools.map((tool, index) => {
            const current = index === activity.recentTools.length - 1;
            return (
              <p
                key={`${tool.timestamp}-${tool.name}-${index}`}
                className={`mt-1.5 w-full break-words text-[11px] ${
                  current ? "text-maestro-text" : "text-maestro-muted opacity-80"
                }`}
              >
                <span className="font-semibold">{tool.name}</span>
                {tool.summary && <span className="text-maestro-muted"> — {tool.summary}</span>}
              </p>
            );
          })}
          {activity.lastMessage && (
            <p className="mt-1.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-maestro-muted">
              {activity.lastMessage.snippet}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] italic text-maestro-muted">
          Nothing captured yet — activity appears with the next tool call or message.
        </p>
      )}
    </div>
  );
}
