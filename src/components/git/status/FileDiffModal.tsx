import { AlertTriangle, FileCode, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useDismissable } from "@/hooks/useDismissable";
import {
  type CellKind,
  type DiffCell,
  type DiffRow,
  parseUnifiedDiff,
  rowsForUntracked,
} from "../../../lib/diffParser";
import { type FileDiff, type FileDiffMode, getFileDiff } from "../../../lib/git";

/** Diffs above this size are not rendered to keep the UI responsive. */
const MAX_RENDER_BYTES = 1024 * 1024;

interface FileDiffModalProps {
  /** Absolute path to the worktree the file lives in. */
  worktreePath: string;
  /** Repo-relative path of the file. */
  path: string;
  /** Original path for a renamed file. */
  oldPath: string | null;
  /** Which comparison to show: staged, unstaged, or untracked. */
  mode: FileDiffMode;
  onClose: () => void;
}

/**
 * Full-screen overlay showing a side-by-side diff of a single working-tree
 * file: old version on the left, current version on the right. Added lines
 * are green, deleted lines red, and modified lines yellow.
 */
export function FileDiffModal({ worktreePath, path, oldPath, mode, onClose }: FileDiffModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    getFileDiff(worktreePath, path, mode, oldPath)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e) => {
        if (!cancelled) setError(typeof e === "string" ? e : (e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [worktreePath, path, mode, oldPath]);

  // Close on outside click or Escape
  useDismissable(onClose, { ref: modalRef });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={modalRef}
        className="flex h-[85vh] w-[90vw] flex-col overflow-hidden rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-maestro-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileCode size={14} className="shrink-0 text-maestro-muted" />
            <span className="truncate text-sm font-medium text-maestro-text">
              {oldPath ? `${oldPath} → ${path}` : path}
            </span>
            <span className="shrink-0 rounded bg-maestro-card px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-maestro-muted">
              {mode}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close diff"
            className="shrink-0 rounded p-1 text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
          >
            <X size={16} />
          </button>
        </div>

        {/* Column titles */}
        <div className="flex border-b border-maestro-border/60 text-[10px] font-medium uppercase tracking-wide text-maestro-muted">
          <div className="w-1/2 border-r border-maestro-border/60 px-3 py-1.5">Old version</div>
          <div className="w-1/2 px-3 py-1.5">Current version</div>
        </div>

        {/* Body */}
        <DiffBody diff={diff} isLoading={isLoading} error={error} />
      </div>
    </div>
  );
}

function DiffBody({
  diff,
  isLoading,
  error,
}: {
  diff: FileDiff | null;
  isLoading: boolean;
  error: string | null;
}) {
  if (isLoading) {
    return (
      <Centered>
        <Loader2 size={20} className="animate-spin text-maestro-muted" />
      </Centered>
    );
  }

  if (error) {
    return (
      <Centered>
        <AlertTriangle size={24} className="text-maestro-red/60" />
        <p className="max-w-md text-xs text-maestro-muted">{error}</p>
      </Centered>
    );
  }

  if (!diff) return null;

  if (diff.is_binary) {
    return (
      <Centered>
        <p className="text-xs text-maestro-muted">Binary file — no text diff</p>
      </Centered>
    );
  }

  if (diff.diff.length > MAX_RENDER_BYTES) {
    return (
      <Centered>
        <p className="text-xs text-maestro-muted">Diff too large to display</p>
      </Centered>
    );
  }

  const rows = diff.is_untracked
    ? rowsForUntracked(diff.content ?? "")
    : parseUnifiedDiff(diff.diff);

  if (rows.length === 0) {
    return (
      <Centered>
        <p className="text-xs text-maestro-muted">No changes to show</p>
      </Centered>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex min-h-full font-mono text-[11px]">
        <DiffColumn
          rows={rows}
          side="left"
          emptyLabel={diff.is_untracked ? "No previous version" : null}
        />
        <DiffColumn rows={rows} side="right" emptyLabel={null} />
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
      {children}
    </div>
  );
}

/**
 * One side of the diff. Both columns render the same row list (the parser
 * always emits aligned rows with fixed height), so vertical scrolling in the
 * shared parent keeps the two sides in sync.
 */
function DiffColumn({
  rows,
  side,
  emptyLabel,
}: {
  rows: DiffRow[];
  side: "left" | "right";
  emptyLabel: string | null;
}) {
  const isLeft = side === "left";

  // Untracked files have an entirely empty left column — show a hint instead
  // of a wall of blank filler cells.
  if (emptyLabel && rows.every((r) => r.left.kind === "empty")) {
    return (
      <div className="flex w-1/2 items-start justify-center border-r border-maestro-border/60 pt-8">
        <span className="text-[11px] text-maestro-muted/60">{emptyLabel}</span>
      </div>
    );
  }

  return (
    <div className={`w-1/2 overflow-x-auto ${isLeft ? "border-r border-maestro-border/60" : ""}`}>
      <div className="w-max min-w-full">
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are a fixed, immutable parse of the diff text (re-parsed wholesale, never reordered/spliced in place); lineNo can't be used as it's null for empty/hunk cells and can repeat across the two sides.
          <DiffLine key={i} cell={isLeft ? row.left : row.right} side={side} />
        ))}
      </div>
    </div>
  );
}

function DiffLine({ cell, side }: { cell: DiffCell; side: "left" | "right" }) {
  if (cell.kind === "hunk") {
    return (
      <div className="flex h-5 items-center bg-maestro-card/60 px-2 leading-5 text-maestro-muted/70">
        {side === "left" ? cell.text : "⋯"}
      </div>
    );
  }

  return (
    <div className={`flex h-5 leading-5 ${cellClasses(cell.kind)}`}>
      <span className="w-10 shrink-0 select-none pr-2 text-right text-maestro-muted/60">
        {cell.lineNo ?? ""}
      </span>
      <span className="whitespace-pre pr-3">{cell.text}</span>
    </div>
  );
}

/** Background/tint for a cell by change kind. */
function cellClasses(kind: CellKind): string {
  switch (kind) {
    case "added":
      return "bg-maestro-green/15";
    case "removed":
      return "bg-maestro-red/15";
    case "modified":
      return "bg-maestro-yellow/15";
    case "empty":
      return "bg-maestro-card/30";
    default:
      return "";
  }
}
