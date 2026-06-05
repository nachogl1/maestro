import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  ChevronRight,
  FileCode,
  FilePlus,
  FileX,
  FolderGit2,
  GitCommit,
  Loader2,
  Package,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  discardFile,
  getWorktreesStatus,
  isWorktreeAtRisk,
  removeFile,
  type FileStatusEntry,
  type FileStatusKind,
  type WorktreeStatus,
} from "../../../lib/git";

interface WorktreeStatusListProps {
  repoPath: string;
}

const POLL_INTERVAL_MS = 15_000;

export function WorktreeStatusList({ repoPath }: WorktreeStatusListProps) {
  const [worktrees, setWorktrees] = useState<WorktreeStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await getWorktreesStatus(repoPath);
      setWorktrees(data);
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    setIsLoading(true);
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  if (isLoading && worktrees.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 size={20} className="animate-spin text-maestro-muted" />
      </div>
    );
  }

  if (error && worktrees.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <AlertTriangle size={24} className="text-maestro-red/60" />
        <p className="text-xs text-maestro-muted">{error}</p>
        <button
          type="button"
          onClick={refresh}
          className="mt-1 rounded bg-maestro-card px-3 py-1 text-xs hover:bg-maestro-border"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-maestro-border/60 px-3 py-1.5">
        <span className="text-[11px] font-medium text-maestro-muted">
          {worktrees.length} worktree{worktrees.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={refresh}
          className="rounded p-1 text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
          title="Refresh"
        >
          <RefreshCw
            size={12}
            className={isLoading ? "animate-spin" : undefined}
          />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {worktrees.map((wt) => (
          <WorktreeCard key={wt.path} status={wt} onChanged={refresh} />
        ))}
      </div>
    </div>
  );
}

function WorktreeCard({
  status,
  onChanged,
}: {
  status: WorktreeStatus;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const atRisk = isWorktreeAtRisk(status);
  const branchLabel = status.branch ?? "(detached)";

  return (
    <div className="border-b border-maestro-border/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-maestro-card/50"
      >
        {expanded ? (
          <ChevronDown size={14} className="shrink-0 text-maestro-muted" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-maestro-muted" />
        )}
        <FolderGit2
          size={14}
          className={`shrink-0 ${
            status.is_main_worktree
              ? "text-maestro-accent"
              : "text-maestro-muted"
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="truncate font-medium text-maestro-text">
              {branchLabel}
            </span>
            {status.is_main_worktree && (
              <span className="rounded bg-maestro-accent/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-maestro-accent">
                main
              </span>
            )}
          </div>
          <div className="truncate text-[10px] text-maestro-muted">
            {status.path}
          </div>
        </div>
        <UpstreamBadge status={status} />
        {atRisk && (
          <span
            title="Worktree has unsaved/unpushed work"
            className="ml-1 flex shrink-0 items-center gap-1 rounded bg-maestro-red/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-maestro-red"
          >
            <AlertTriangle size={10} />
            unsafe
          </span>
        )}
      </button>

      {expanded && (
        <div className="space-y-1 px-3 pb-3 pt-1">
          {!atRisk && (
            <div className="rounded bg-maestro-card/40 px-2 py-1.5 text-[11px] text-maestro-muted">
              Working tree clean. Branch is fully pushed.
            </div>
          )}

          <Section
            label="Unpushed commits"
            count={status.unpushed_commits.length}
            icon={<GitCommit size={11} />}
            color="text-maestro-orange"
          >
            {status.unpushed_commits.map((c) => (
              <li
                key={c.hash}
                className="flex items-center gap-2 px-1 py-0.5 text-[11px]"
              >
                <span className="font-mono text-maestro-muted">
                  {c.short_hash}
                </span>
                <span className="truncate text-maestro-text">{c.summary}</span>
              </li>
            ))}
          </Section>

          <Section
            label="Staged"
            count={status.staged.length}
            icon={<FilePlus size={11} />}
            color="text-maestro-green"
          >
            {status.staged.map((f) => (
              <FileRow
                key={`s-${f.path}`}
                entry={f}
                worktreePath={status.path}
                onChanged={onChanged}
              />
            ))}
          </Section>

          <Section
            label="Unstaged"
            count={status.unstaged.length}
            icon={<FileCode size={11} />}
            color="text-maestro-yellow"
          >
            {status.unstaged.map((f) => (
              <FileRow
                key={`u-${f.path}`}
                entry={f}
                worktreePath={status.path}
                onChanged={onChanged}
              />
            ))}
          </Section>

          <Section
            label="Untracked"
            count={status.untracked.length}
            icon={<FileX size={11} />}
            color="text-maestro-muted"
          >
            {status.untracked.map((path) => (
              <UntrackedRow
                key={`n-${path}`}
                path={path}
                worktreePath={status.path}
                onChanged={onChanged}
              />
            ))}
          </Section>

          <Section
            label="Stashes"
            count={status.stashes.length}
            icon={<Package size={11} />}
            color="text-maestro-purple"
          >
            {status.stashes.map((s) => (
              <li
                key={s.ref_name}
                className="flex items-center gap-2 px-1 py-0.5 text-[11px]"
              >
                <span className="font-mono text-maestro-muted">
                  {s.ref_name}
                </span>
                <span className="truncate text-maestro-text">{s.message}</span>
              </li>
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}

function UpstreamBadge({ status }: { status: WorktreeStatus }) {
  if (!status.upstream) {
    return (
      <span
        title="Branch has no upstream — pushed state cannot be determined"
        className="shrink-0 rounded bg-maestro-card px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-maestro-muted"
      >
        no upstream
      </span>
    );
  }
  if (status.ahead === 0 && status.behind === 0) {
    return (
      <span
        title={`In sync with ${status.upstream}`}
        className="shrink-0 rounded bg-maestro-green/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-maestro-green"
      >
        synced
      </span>
    );
  }
  return (
    <span
      title={`vs ${status.upstream}`}
      className="flex shrink-0 items-center gap-1 rounded bg-maestro-card px-1.5 py-0.5 text-[10px] text-maestro-muted"
    >
      {status.ahead > 0 && (
        <span className="flex items-center gap-0.5 text-maestro-orange">
          <ArrowUp size={9} />
          {status.ahead}
        </span>
      )}
      {status.behind > 0 && (
        <span className="flex items-center gap-0.5 text-maestro-accent">
          <ArrowDown size={9} />
          {status.behind}
        </span>
      )}
    </span>
  );
}

function Section({
  label,
  count,
  icon,
  color,
  children,
}: {
  label: string;
  count: number;
  icon: React.ReactNode;
  color: string;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div>
      <div
        className={`flex items-center gap-1.5 px-1 pt-1 text-[10px] font-medium uppercase tracking-wide ${color}`}
      >
        {icon}
        <span>
          {label} ({count})
        </span>
      </div>
      <ul className="border-l border-maestro-border/60 pl-2">{children}</ul>
    </div>
  );
}

function FileRow({
  entry,
  worktreePath,
  onChanged,
}: {
  entry: FileStatusEntry;
  worktreePath: string;
  onChanged: () => void;
}) {
  return (
    <li className="group flex items-center gap-2 px-1 py-0.5 text-[11px]">
      <span
        title={entry.status}
        className={`w-3 shrink-0 text-center font-mono text-[10px] ${statusColor(entry.status)}`}
      >
        {statusLetter(entry.status)}
      </span>
      <span className="min-w-0 flex-1 truncate text-maestro-text">
        {entry.old_path ? `${entry.old_path} → ${entry.path}` : entry.path}
      </span>
      <RowAction
        label="Restore"
        title="Discard changes — restore this file to its last commit"
        icon={<Undo2 size={11} />}
        run={() => discardFile(worktreePath, entry.path, entry.old_path)}
        onDone={onChanged}
      />
    </li>
  );
}

function UntrackedRow({
  path,
  worktreePath,
  onChanged,
}: {
  path: string;
  worktreePath: string;
  onChanged: () => void;
}) {
  return (
    <li className="group flex items-center gap-2 px-1 py-0.5 text-[11px]">
      <span className="min-w-0 flex-1 truncate text-maestro-text">{path}</span>
      <RowAction
        label="Remove"
        title="Delete this untracked file from disk"
        icon={<Trash2 size={11} />}
        danger
        run={() => removeFile(worktreePath, path)}
        onDone={onChanged}
      />
    </li>
  );
}

/**
 * Hover-revealed action button for a file row. Clicking expands an inline
 * confirm (Confirm / Cancel) since the underlying git operation is
 * irreversible. Shows a spinner while running and surfaces any error.
 */
function RowAction({
  label,
  title,
  icon,
  run,
  onDone,
  danger = false,
}: {
  label: string;
  title: string;
  icon: React.ReactNode;
  run: () => Promise<void>;
  onDone: () => void;
  danger?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = async () => {
    setBusy(true);
    setError(null);
    try {
      await run();
      setConfirming(false);
      onDone();
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (confirming) {
    return (
      <span className="flex shrink-0 items-center gap-1">
        {error && (
          <span title={error} className="flex items-center text-maestro-red">
            <AlertTriangle size={11} />
          </span>
        )}
        <button
          type="button"
          onClick={execute}
          disabled={busy}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium disabled:opacity-50 ${
            danger
              ? "bg-maestro-red/20 text-maestro-red hover:bg-maestro-red/30"
              : "bg-maestro-accent/20 text-maestro-accent hover:bg-maestro-accent/30"
          }`}
          title={`${label} — this cannot be undone`}
        >
          {busy ? <Loader2 size={10} className="animate-spin" /> : "Confirm"}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          disabled={busy}
          className="rounded px-1.5 py-0.5 text-[10px] text-maestro-muted hover:bg-maestro-card disabled:opacity-50"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      title={title}
      aria-label={label}
      className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-maestro-muted transition-colors hover:bg-maestro-card ${
        danger ? "hover:text-maestro-red" : "hover:text-maestro-text"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function statusLetter(kind: FileStatusKind): string {
  switch (kind) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "typechanged":
      return "T";
    case "unmerged":
      return "U";
    default:
      return "?";
  }
}

function statusColor(kind: FileStatusKind): string {
  switch (kind) {
    case "added":
      return "text-maestro-green";
    case "modified":
      return "text-maestro-yellow";
    case "deleted":
      return "text-maestro-red";
    case "renamed":
    case "copied":
      return "text-maestro-accent";
    case "unmerged":
      return "text-maestro-red";
    default:
      return "text-maestro-muted";
  }
}
