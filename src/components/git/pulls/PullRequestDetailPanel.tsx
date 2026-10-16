import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  FileEdit,
  GitMerge,
  GitPullRequest,
  HelpCircle,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { useGitHubStore } from "../../../stores/useGitHubStore";
import { CommentList } from "../shared/CommentList";
import { DetailLoadError } from "../shared/DetailLoadError";
import { MarkdownBody } from "../shared/MarkdownBody";
import { type NormalizedCheck, normalizeCheck } from "./prChecks";

/** Icon + tint for one check's normalized state. */
function CheckStateIcon({ state }: { state: NormalizedCheck["state"] }) {
  switch (state) {
    case "success":
      return <CheckCircle2 size={10} className="shrink-0 text-green-400" />;
    case "failure":
      return <XCircle size={10} className="shrink-0 text-red-400" />;
    case "pending":
      return <Clock size={10} className="shrink-0 text-yellow-400" />;
    default:
      return <HelpCircle size={10} className="shrink-0 text-maestro-muted" />;
  }
}

/** Tint classes for the checks summary header, keyed by `ChecksSummary.verdict`. */
function verdictClass(verdict: string): string {
  switch (verdict) {
    case "success":
      return "text-green-400";
    case "failure":
      return "text-red-400";
    case "pending":
      return "text-yellow-400";
    default:
      return "text-maestro-muted";
  }
}

/** e.g. "3 passed, 1 failed, 2 pending" from the non-zero buckets only. */
function checksSummaryLabel(summary: {
  success: number;
  failure: number;
  pending: number;
}): string {
  const parts: string[] = [];
  if (summary.success > 0) parts.push(`${summary.success} passed`);
  if (summary.failure > 0) parts.push(`${summary.failure} failed`);
  if (summary.pending > 0) parts.push(`${summary.pending} pending`);
  return parts.length > 0 ? parts.join(", ") : "No checks";
}

const CHECKS_COLLAPSE_THRESHOLD = 6;

interface PullRequestDetailPanelProps {
  onClose: () => void;
}

export function PullRequestDetailPanel({ onClose }: PullRequestDetailPanelProps) {
  const { selectedPR, isLoadingPRDetail, prDetailError } = useGitHubStore();

  const [showAllChecks, setShowAllChecks] = useState(false);

  if (isLoadingPRDetail) {
    return (
      <div className="flex h-full items-center justify-center bg-maestro-card">
        <Loader2 size={24} className="animate-spin text-maestro-muted" />
      </div>
    );
  }

  if (!selectedPR) {
    return <DetailLoadError itemLabel="pull request" error={prDetailError} onClose={onClose} />;
  }

  const isMerged = selectedPR.state.toUpperCase() === "MERGED";
  const isClosed = selectedPR.state.toUpperCase() === "CLOSED";

  const normalizedChecks = (selectedPR.statusCheckRollup ?? []).map(normalizeCheck);
  const canCollapseChecks = normalizedChecks.length > CHECKS_COLLAPSE_THRESHOLD;
  const visibleChecks =
    canCollapseChecks && !showAllChecks
      ? normalizedChecks.filter((check) => check.state !== "success")
      : normalizedChecks;

  const handleOpenCheckUrl = (url: string) => {
    openUrl(url).catch((err) => console.error("Failed to open check URL:", err));
  };

  return (
    <div className="flex h-full flex-col bg-maestro-card">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-maestro-border p-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
            title="Back to list"
          >
            <X size={16} />
          </button>
          {isMerged ? (
            <GitMerge size={16} className="text-purple-400" />
          ) : isClosed ? (
            <XCircle size={16} className="text-red-400" />
          ) : (
            <GitPullRequest
              size={16}
              className={selectedPR.isDraft ? "text-maestro-muted" : "text-green-400"}
            />
          )}
          <span className="text-sm font-medium text-maestro-text">#{selectedPR.number}</span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-3" style={{ scrollbarWidth: "thin" }}>
        {/* Title */}
        <h3 className="mb-2 text-sm font-medium text-maestro-text">{selectedPR.title}</h3>

        {/* Branch info */}
        <div className="mb-3 text-[10px] text-maestro-muted">
          <span className="font-mono rounded bg-maestro-surface px-1 py-0.5">
            {selectedPR.headRefName}
          </span>
          <span className="mx-1">→</span>
          <span className="font-mono rounded bg-maestro-surface px-1 py-0.5">
            {selectedPR.baseRefName}
          </span>
        </div>

        {/* Author and date */}
        <div className="mb-3 text-[10px] text-maestro-muted">
          {/* A deleted GitHub account comes back with an empty login. */}
          {selectedPR.author.login ? `by ${selectedPR.author.login} on` : "Opened on"}{" "}
          {new Date(selectedPR.createdAt).toLocaleDateString()}
        </div>

        {/* Stats */}
        <div className="mb-3 flex items-center gap-3 text-[10px]">
          <div className="flex items-center gap-1">
            <FileEdit size={10} className="text-maestro-muted" />
            <span className="text-green-400">+{selectedPR.additions}</span>
            <span className="text-red-400">-{selectedPR.deletions}</span>
          </div>
          <span className="text-maestro-muted">{selectedPR.changedFiles} files</span>
        </div>

        {/* Status badges */}
        <div className="mb-3 flex flex-wrap items-center gap-1">
          {selectedPR.isDraft && (
            <span className="rounded bg-maestro-muted/20 px-1.5 py-0.5 text-[10px] font-medium text-maestro-muted">
              Draft
            </span>
          )}
          {selectedPR.mergeable && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                selectedPR.mergeable === "MERGEABLE"
                  ? "bg-green-500/20 text-green-400"
                  : selectedPR.mergeable === "CONFLICTING"
                    ? "bg-red-500/20 text-red-400"
                    : "bg-maestro-muted/20 text-maestro-muted"
              }`}
            >
              {selectedPR.mergeable === "MERGEABLE"
                ? "Mergeable"
                : selectedPR.mergeable === "CONFLICTING"
                  ? "Conflicts"
                  : selectedPR.mergeable}
            </span>
          )}
          {selectedPR.reviewDecision && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                selectedPR.reviewDecision === "APPROVED"
                  ? "bg-green-500/20 text-green-400"
                  : selectedPR.reviewDecision === "CHANGES_REQUESTED"
                    ? "bg-orange-500/20 text-orange-400"
                    : "bg-maestro-muted/20 text-maestro-muted"
              }`}
            >
              {selectedPR.reviewDecision === "APPROVED"
                ? "Approved"
                : selectedPR.reviewDecision === "CHANGES_REQUESTED"
                  ? "Changes requested"
                  : selectedPR.reviewDecision}
            </span>
          )}
        </div>

        {/* Checks */}
        {selectedPR.checksSummary && selectedPR.checksSummary.total > 0 && (
          <div className="mb-3">
            <div
              className={`mb-1 flex items-center gap-1 text-[10px] font-medium ${verdictClass(selectedPR.checksSummary.verdict)}`}
            >
              {selectedPR.checksSummary.verdict === "success" ? (
                <CheckCircle2 size={12} />
              ) : selectedPR.checksSummary.verdict === "failure" ? (
                <XCircle size={12} />
              ) : (
                <Clock size={12} />
              )}
              <span>{checksSummaryLabel(selectedPR.checksSummary)}</span>
            </div>
            <div className="space-y-0.5 rounded bg-maestro-surface p-1.5">
              {visibleChecks.map((check, idx) => (
                <div key={`${check.name}-${idx}`} className="flex items-center gap-1.5 text-[10px]">
                  <CheckStateIcon state={check.state} />
                  <span className="flex-1 truncate text-maestro-text" title={check.name}>
                    {check.name}
                  </span>
                  {check.url && (
                    <button
                      type="button"
                      onClick={() => handleOpenCheckUrl(check.url as string)}
                      className="shrink-0 text-maestro-muted hover:text-maestro-accent"
                      title="Open check details"
                      aria-label={`Open ${check.name} details on GitHub`}
                    >
                      <ExternalLink size={10} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {canCollapseChecks && (
              <button
                type="button"
                onClick={() => setShowAllChecks((prev) => !prev)}
                className="mt-1 text-[10px] text-maestro-accent hover:underline"
              >
                {showAllChecks
                  ? "Show only failing/pending"
                  : `Show all ${normalizedChecks.length}`}
              </button>
            )}
          </div>
        )}

        {/* Labels */}
        {selectedPR.labels.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1">
            {selectedPR.labels.map((label) => (
              <span
                key={label.name}
                className="rounded px-1.5 py-0.5 text-[10px]"
                style={{
                  backgroundColor: `#${label.color}20`,
                  color: `#${label.color}`,
                }}
              >
                {label.name}
              </span>
            ))}
          </div>
        )}

        {/* Open on GitHub */}
        <a
          href={selectedPR.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-3 flex items-center gap-1 text-xs text-maestro-accent hover:underline"
        >
          <ExternalLink size={12} />
          View on GitHub
        </a>

        {/* Body */}
        <div className="mb-3 rounded bg-maestro-surface p-2">
          <MarkdownBody content={selectedPR.body} />
        </div>

        {/* Comments */}
        {selectedPR.comments.length > 0 && (
          <div className="mb-3">
            <CommentList comments={selectedPR.comments} />
          </div>
        )}
      </div>
    </div>
  );
}
