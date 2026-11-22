import { CheckCircle2, GitMerge, GitPullRequest, Loader2, XCircle } from "lucide-react";
import { useMemo } from "react";
import type { ChecksSummary, PullRequestInfo } from "../../../stores/useGitHubStore";

interface PullRequestRowProps {
  pr: PullRequestInfo;
  isSelected: boolean;
  onClick: () => void;
}

/** How a `reviewDecision` value is shown. Anything else renders no badge. */
const REVIEW_BADGES: Record<string, { label: string; title: string; className: string }> = {
  APPROVED: {
    label: "Approved",
    title: "Review approved",
    className: "bg-maestro-green/15 text-maestro-green",
  },
  CHANGES_REQUESTED: {
    label: "Changes",
    title: "Changes requested",
    className: "bg-maestro-red/15 text-maestro-red",
  },
  REVIEW_REQUIRED: {
    label: "Review",
    title: "Review required",
    className: "bg-maestro-muted/15 text-maestro-muted",
  },
};

/**
 * The CI verdict as one icon. Nothing renders when the PR has no checks
 * ("none"), so a repo without CI does not grow an empty column.
 */
function ChecksBadge({ checks }: { checks?: ChecksSummary }) {
  if (!checks) return null;
  const tip = `Checks: ${checks.success} passed, ${checks.failure} failed, ${checks.pending} pending (${checks.total} total)`;
  switch (checks.verdict) {
    case "success":
      return (
        <span role="img" title={tip} aria-label={tip}>
          <CheckCircle2 size={11} className="text-maestro-green" />
        </span>
      );
    case "failure":
      return (
        <span role="img" title={tip} aria-label={tip}>
          <XCircle size={11} className="text-maestro-red" />
        </span>
      );
    case "pending":
      return (
        <span role="img" title={tip} aria-label={tip}>
          <Loader2 size={11} className="animate-spin text-maestro-orange" />
        </span>
      );
    default:
      return null;
  }
}

export function PullRequestRow({ pr, isSelected, onClick }: PullRequestRowProps) {
  // Format relative time
  const relativeTime = useMemo(() => {
    const now = Date.now();
    const prTime = new Date(pr.createdAt).getTime();
    const diff = now - prTime;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    if (years > 0) return `${years}y`;
    if (months > 0) return `${months}mo`;
    if (weeks > 0) return `${weeks}w`;
    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return "now";
  }, [pr.createdAt]);

  // Get state icon and color
  const stateInfo = useMemo(() => {
    const state = pr.state.toUpperCase();
    if (state === "MERGED") {
      return {
        icon: GitMerge,
        color: "text-purple-400",
        bgColor: "bg-purple-500/20",
      };
    }
    if (state === "CLOSED") {
      return {
        icon: XCircle,
        color: "text-red-400",
        bgColor: "bg-red-500/20",
      };
    }
    // OPEN
    return {
      icon: GitPullRequest,
      color: pr.isDraft ? "text-maestro-muted" : "text-green-400",
      bgColor: pr.isDraft ? "bg-maestro-muted/20" : "bg-green-500/20",
    };
  }, [pr.state, pr.isDraft]);

  const StateIcon = stateInfo.icon;
  const review = REVIEW_BADGES[(pr.reviewDecision ?? "").toUpperCase()];

  return (
    <div
      className={`flex w-full items-center border-b border-maestro-border/30 transition-colors ${
        isSelected ? "bg-maestro-accent/20 hover:bg-maestro-accent/25" : "hover:bg-maestro-card/50"
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-3 pr-3 text-left"
      >
        {/* State icon */}
        <div className={`shrink-0 rounded p-1 ${stateInfo.bgColor}`}>
          <StateIcon size={14} className={stateInfo.color} />
        </div>

        {/* Title, author and branch info */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            {pr.isDraft && (
              <span className="shrink-0 rounded bg-maestro-muted/20 px-1 py-0.5 text-[10px] font-medium text-maestro-muted">
                Draft
              </span>
            )}
            <span className="truncate text-xs text-maestro-text">{pr.title}</span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-maestro-muted">
            <span className="shrink-0 font-mono">#{pr.number}</span>
            {/* A deleted GitHub account comes back without an author. */}
            {pr.author?.login && <span className="shrink-0 truncate">by {pr.author.login}</span>}
            <span className="truncate">
              {pr.headRefName} → {pr.baseRefName}
            </span>
          </div>
        </div>

        {/* Status column: CI verdict + review decision, then size and age */}
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <div className="flex items-center gap-1">
            <ChecksBadge checks={pr.checksSummary} />
            {review && (
              <span
                title={review.title}
                className={`rounded px-1 py-0.5 text-[10px] font-medium ${review.className}`}
              >
                {review.label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 text-[10px]">
            <span className="text-green-400">+{pr.additions}</span>
            <span className="text-red-400">-{pr.deletions}</span>
            <span className="text-maestro-muted/60">{relativeTime}</span>
          </div>
        </div>
      </button>
    </div>
  );
}
