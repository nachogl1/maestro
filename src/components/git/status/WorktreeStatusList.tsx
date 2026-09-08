import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
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
  Search,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  discardFile,
  type FileDiffMode,
  type FileStatusEntry,
  type FileStatusKind,
  getWorktreesStatus,
  isWorktreeAtRisk,
  removeFile,
  type WorktreeStatus,
} from "../../../lib/git";
import { FileDiffModal } from "./FileDiffModal";

interface WorktreeStatusListProps {
  repoPath: string;
  /** Poll only while the git panel is actually open — a full status sweep
   *  spawns ~7 git subprocesses per worktree and used to run forever behind
   *  the permanently-mounted (width-0) panel. Mirrors the `enabled` gate in
   *  `useDevProcesses`. */
  active?: boolean;
}

/** File selected in the list, shown in the side-by-side diff modal. */
interface SelectedFile {
  worktreePath: string;
  path: string;
  oldPath: string | null;
  mode: FileDiffMode;
}

const POLL_INTERVAL_MS = 15_000;

/** Case-insensitive substring match, used for both the worktree-level and
 *  file-level search. */
function textMatches(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query);
}

/** `true` when the search query matches the worktree's own branch or path,
 *  i.e. independently of any of its files. */
function worktreeSelfMatches(status: WorktreeStatus, query: string): boolean {
  const branch = status.branch ?? "(detached)";
  return textMatches(branch, query) || textMatches(status.path, query);
}

function fileEntryMatches(entry: FileStatusEntry, query: string): boolean {
  return (
    textMatches(entry.path, query) ||
    (entry.old_path !== null && textMatches(entry.old_path, query))
  );
}

/** `true` when any of the worktree's staged/unstaged/untracked file paths
 *  match the search query. */
function worktreeHasMatchingFile(status: WorktreeStatus, query: string): boolean {
  return (
    status.staged.some((f) => fileEntryMatches(f, query)) ||
    status.unstaged.some((f) => fileEntryMatches(f, query)) ||
    status.untracked.some((p) => textMatches(p, query))
  );
}

function hasChangedFiles(status: WorktreeStatus): boolean {
  return status.staged.length + status.unstaged.length + status.untracked.length > 0;
}

export function WorktreeStatusList({ repoPath, active = true }: WorktreeStatusListProps) {
  const [worktrees, setWorktrees] = useState<WorktreeStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(false);
  // Guards the interval only. Manual refreshes and post-file-action refreshes
  // must never be swallowed, so this is deliberately not inside `refresh`.
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    inFlight.current = true;
    try {
      setError(null);
      const data = await getWorktreesStatus(repoPath);
      setWorktrees(data);
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error).message);
    } finally {
      inFlight.current = false;
      setIsLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    if (!active) return;

    setIsLoading(true);
    void refresh();

    const tick = () => {
      // A sweep can outlast the interval on repos with many worktrees — skip
      // rather than stack. Also skip when nobody is looking at the window.
      if (inFlight.current || !document.hasFocus()) return;
      void refresh();
    };

    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, refresh]);

  const query = searchQuery.trim().toLowerCase();
  const filtersActive = query.length > 0 || onlyChanged || needsAttentionOnly;

  // Presentational only — `worktrees` (the polled state) is never touched
  // here, so a poll landing mid-filter never loses data.
  const filteredWorktrees = useMemo(() => {
    return worktrees.filter((wt) => {
      if (onlyChanged && !hasChangedFiles(wt)) return false;
      if (needsAttentionOnly && !isWorktreeAtRisk(wt)) return false;
      if (!query) return true;
      return worktreeSelfMatches(wt, query) || worktreeHasMatchingFile(wt, query);
    });
  }, [worktrees, query, onlyChanged, needsAttentionOnly]);

  const clearFilters = () => {
    setSearchQuery("");
    setOnlyChanged(false);
    setNeedsAttentionOnly(false);
  };

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
      <div className="flex flex-col gap-1.5 border-b border-maestro-border/60 px-3 py-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-maestro-muted">
            {filtersActive
              ? `${filteredWorktrees.length} of ${worktrees.length} worktree${
                  worktrees.length === 1 ? "" : "s"
                }`
              : `${worktrees.length} worktree${worktrees.length === 1 ? "" : "s"}`}
          </span>
          <button
            type="button"
            onClick={refresh}
            className="rounded p-1 text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
            title="Refresh"
          >
            <RefreshCw size={12} className={isLoading ? "animate-spin" : undefined} />
          </button>
        </div>

        <div className="relative">
          <Search
            size={11}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-maestro-muted/60"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search worktrees or files..."
            className="w-full rounded-md border border-maestro-border bg-maestro-card py-1 pl-6 pr-6 text-[11px] text-maestro-text placeholder:text-maestro-muted/50 focus:border-maestro-accent focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-maestro-muted hover:bg-maestro-border/40 hover:text-maestro-text"
              aria-label="Clear search"
            >
              <X size={11} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setOnlyChanged((v) => !v)}
            className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
              onlyChanged
                ? "bg-maestro-accent/20 text-maestro-accent"
                : "bg-maestro-card/60 text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
            }`}
          >
            Only with changes
          </button>
          <button
            type="button"
            onClick={() => setNeedsAttentionOnly((v) => !v)}
            className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
              needsAttentionOnly
                ? "bg-maestro-red/20 text-maestro-red"
                : "bg-maestro-card/60 text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
            }`}
          >
            Needs attention
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {filteredWorktrees.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center">
            <p className="text-xs text-maestro-muted">
              {worktrees.length === 0 ? "No worktrees found." : "No worktrees match your filters."}
            </p>
            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="rounded bg-maestro-card px-3 py-1 text-xs hover:bg-maestro-border"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          filteredWorktrees.map((wt) => {
            const selfMatch = !query || worktreeSelfMatches(wt, query);
            return (
              <WorktreeCard
                key={wt.path}
                status={wt}
                fileQuery={selfMatch ? null : query}
                onChanged={refresh}
                onSelectFile={setSelectedFile}
              />
            );
          })
        )}
      </div>
      {selectedFile && (
        <FileDiffModal
          worktreePath={selectedFile.worktreePath}
          path={selectedFile.path}
          oldPath={selectedFile.oldPath}
          mode={selectedFile.mode}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </div>
  );
}

function WorktreeCard({
  status,
  fileQuery,
  onChanged,
  onSelectFile,
}: {
  status: WorktreeStatus;
  /** When set, only staged/unstaged/untracked entries matching this
   *  (already-lowercased) query are shown — used when the worktree itself
   *  didn't match the search but one of its files did. `null` shows all
   *  files, unfiltered. */
  fileQuery: string | null;
  onChanged: () => void;
  onSelectFile: (file: SelectedFile) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const atRisk = isWorktreeAtRisk(status);
  const branchLabel = status.branch ?? "(detached)";
  const visibleStaged = fileQuery
    ? status.staged.filter((f) => fileEntryMatches(f, fileQuery))
    : status.staged;
  const visibleUnstaged = fileQuery
    ? status.unstaged.filter((f) => fileEntryMatches(f, fileQuery))
    : status.unstaged;
  const visibleUntracked = fileQuery
    ? status.untracked.filter((p) => textMatches(p, fileQuery))
    : status.untracked;

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
            status.is_main_worktree ? "text-maestro-accent" : "text-maestro-muted"
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="truncate font-medium text-maestro-text">{branchLabel}</span>
            {status.is_main_worktree && (
              <span className="rounded bg-maestro-accent/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-maestro-accent">
                main
              </span>
            )}
          </div>
          <div className="truncate text-[10px] text-maestro-muted">{status.path}</div>
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
              <li key={c.hash} className="flex items-center gap-2 px-1 py-0.5 text-[11px]">
                <span className="font-mono text-maestro-muted">{c.short_hash}</span>
                <span className="truncate text-maestro-text">{c.summary}</span>
              </li>
            ))}
          </Section>

          <Section
            label="Staged"
            count={visibleStaged.length}
            icon={<FilePlus size={11} />}
            color="text-maestro-green"
          >
            {visibleStaged.map((f) => (
              <FileRow
                key={`s-${f.path}`}
                entry={f}
                worktreePath={status.path}
                onChanged={onChanged}
                onOpenDiff={() =>
                  onSelectFile({
                    worktreePath: status.path,
                    path: f.path,
                    oldPath: f.old_path,
                    mode: "staged",
                  })
                }
              />
            ))}
          </Section>

          <Section
            label="Unstaged"
            count={visibleUnstaged.length}
            icon={<FileCode size={11} />}
            color="text-maestro-yellow"
          >
            {visibleUnstaged.map((f) => (
              <FileRow
                key={`u-${f.path}`}
                entry={f}
                worktreePath={status.path}
                onChanged={onChanged}
                onOpenDiff={() =>
                  onSelectFile({
                    worktreePath: status.path,
                    path: f.path,
                    oldPath: f.old_path,
                    mode: "unstaged",
                  })
                }
              />
            ))}
          </Section>

          <Section
            label="Untracked"
            count={visibleUntracked.length}
            icon={<FileX size={11} />}
            color="text-maestro-muted"
          >
            {visibleUntracked.map((path) => (
              <UntrackedRow
                key={`n-${path}`}
                path={path}
                worktreePath={status.path}
                onChanged={onChanged}
                onOpenDiff={() =>
                  onSelectFile({
                    worktreePath: status.path,
                    path,
                    oldPath: null,
                    mode: "untracked",
                  })
                }
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
              <li key={s.ref_name} className="flex items-center gap-2 px-1 py-0.5 text-[11px]">
                <span className="font-mono text-maestro-muted">{s.ref_name}</span>
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
  onOpenDiff,
}: {
  entry: FileStatusEntry;
  worktreePath: string;
  onChanged: () => void;
  onOpenDiff: () => void;
}) {
  return (
    <li className="group flex items-center gap-2 px-1 py-0.5 text-[11px]">
      <span
        title={entry.status}
        className={`w-3 shrink-0 text-center font-mono text-[10px] ${statusColor(entry.status)}`}
      >
        {statusLetter(entry.status)}
      </span>
      <button
        type="button"
        onClick={onOpenDiff}
        title="View changes side by side"
        className="min-w-0 flex-1 truncate text-left text-maestro-text hover:text-maestro-accent hover:underline"
      >
        {entry.old_path ? `${entry.old_path} → ${entry.path}` : entry.path}
      </button>
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
  onOpenDiff,
}: {
  path: string;
  worktreePath: string;
  onChanged: () => void;
  onOpenDiff: () => void;
}) {
  return (
    <li className="group flex items-center gap-2 px-1 py-0.5 text-[11px]">
      <button
        type="button"
        onClick={onOpenDiff}
        title="View file contents"
        className="min-w-0 flex-1 truncate text-left text-maestro-text hover:text-maestro-accent hover:underline"
      >
        {path}
      </button>
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
