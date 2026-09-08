import { ask } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Cloud,
  FolderGit2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type BranchPr,
  fetchBranchPrAudit,
  findPrForBranch,
  formatRelativeTime,
  type PrBadgeTone,
  prBadge,
} from "../../../lib/branchPrAudit";
import type { BranchInfo } from "../../../lib/git";
import { getWorktreesStatus, isWorktreeAtRisk, type WorktreeStatus } from "../../../lib/git";
import { removeSessionWorktree } from "../../../lib/worktreeManager";
import { useGitHubStore } from "../../../stores/useGitHubStore";
import { useGitStore } from "../../../stores/useGitStore";

/**
 * Branches tab: the "clean resources" view for a repo. Shows local branches,
 * remote branches, and worktrees together, each with what's needed to decide
 * whether it's safe to delete — last commit author/date, and (when `gh` is
 * authenticated) whether its PR was merged, by whom, and when. Deletion for
 * all three resource kinds happens right here.
 *
 * Branch actions: checkout, create, rename, delete local (with force
 * fallback for unmerged branches), and delete on the remote. Remote refs
 * refresh via `git fetch --all --prune`. Worktree deletion goes through
 * `git worktree remove`, with the same "not clean — force?" fallback.
 */
type SectionKey = "local" | "remote" | "worktrees";

const SECTION_CHIPS: Array<{ key: SectionKey; label: string }> = [
  { key: "local", label: "Local" },
  { key: "remote", label: "Remote" },
  { key: "worktrees", label: "Worktrees" },
];

const DEFAULT_VISIBLE_SECTIONS: Record<SectionKey, boolean> = {
  local: true,
  remote: true,
  worktrees: true,
};

/** "4 of 31" once a filter narrows a section, otherwise just "31". */
function sectionCountLabel(filtered: number, total: number): string {
  return filtered === total ? `${total}` : `${filtered} of ${total}`;
}

export function BranchesPanel({ repoPath }: { repoPath: string }) {
  const {
    branches,
    currentBranch,
    error,
    fetchBranches,
    fetchCurrentBranch,
    fetchAllRemoteRefs,
    checkoutBranch,
    createBranch,
    deleteBranch,
    renameBranch,
    deleteRemoteBranch,
  } = useGitStore();
  // The store's own BranchInfo type predates the backend's additive
  // lastCommitDate/lastCommitAuthor fields; the runtime payload already
  // carries them (same `git_branches` call), so widen the view here rather
  // than touch the shared store's type.
  const typedBranches: BranchInfo[] = branches;

  // gh PR audit is best-effort and entirely optional: this tab isn't
  // gh-gated, so a missing/unauthenticated `gh` must never block anything
  // here — just skip the badges.
  const { authStatus, checkAuth } = useGitHubStore();
  const [prs, setPrs] = useState<BranchPr[]>([]);

  const [newBranchName, setNewBranchName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  /** Branch name currently being renamed, plus the draft value. */
  const [renaming, setRenaming] = useState<{ name: string; draft: string } | null>(null);
  /** Branch name with an action (checkout/delete/rename) in flight. */
  const [busyBranch, setBusyBranch] = useState<string | null>(null);

  const [worktrees, setWorktrees] = useState<WorktreeStatus[]>([]);
  const [worktreesLoading, setWorktreesLoading] = useState(true);
  /** Worktree path with a delete in flight. */
  const [busyWorktree, setBusyWorktree] = useState<string | null>(null);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);

  // Search + filters — component-local only, nothing persisted.
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleSections, setVisibleSections] =
    useState<Record<SectionKey, boolean>>(DEFAULT_VISIBLE_SECTIONS);
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(false);

  const refresh = useCallback(() => {
    fetchBranches(repoPath);
    fetchCurrentBranch(repoPath);
  }, [repoPath, fetchBranches, fetchCurrentBranch]);

  const refreshWorktrees = useCallback(async () => {
    try {
      const data = await getWorktreesStatus(repoPath);
      setWorktrees(data);
    } catch {
      setWorktrees([]);
    } finally {
      setWorktreesLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    refresh();
    void refreshWorktrees();
  }, [refresh, refreshWorktrees]);

  // Check gh auth once per repo. Branches isn't a gh-gated tab, so nothing
  // else triggers this — but the PR badges need to know whether it's worth
  // asking at all.
  useEffect(() => {
    if (!repoPath) return;
    checkAuth(repoPath);
  }, [repoPath, checkAuth]);

  // Fetch the PR audit once gh is confirmed authenticated (and again if the
  // repo changes while already authenticated). Silently empties out if auth
  // is lost or absent — badges just disappear, nothing surfaces as an error.
  useEffect(() => {
    if (!repoPath || !authStatus?.logged_in) {
      setPrs([]);
      return;
    }
    let cancelled = false;
    fetchBranchPrAudit(repoPath).then((result) => {
      if (!cancelled) setPrs(result);
    });
    return () => {
      cancelled = true;
    };
  }, [repoPath, authStatus]);

  const localBranches = typedBranches.filter((b) => !b.is_remote);
  const remoteBranches = typedBranches.filter((b) => b.is_remote);

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredLocalBranches = normalizedQuery
    ? localBranches.filter((b) => b.name.toLowerCase().includes(normalizedQuery))
    : localBranches;
  const filteredRemoteBranches = normalizedQuery
    ? remoteBranches.filter((b) => b.name.toLowerCase().includes(normalizedQuery))
    : remoteBranches;

  const attentionFilteredWorktrees = needsAttentionOnly
    ? worktrees.filter((wt) => isWorktreeAtRisk(wt))
    : worktrees;
  const filteredWorktrees = normalizedQuery
    ? attentionFilteredWorktrees.filter(
        (wt) =>
          (wt.branch ?? "").toLowerCase().includes(normalizedQuery) ||
          wt.path.toLowerCase().includes(normalizedQuery),
      )
    : attentionFilteredWorktrees;

  const hasActiveFilters =
    normalizedQuery.length > 0 ||
    needsAttentionOnly ||
    !visibleSections.local ||
    !visibleSections.remote ||
    !visibleSections.worktrees;

  const toggleSection = (key: SectionKey) => {
    setVisibleSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const clearFilters = () => {
    setSearchQuery("");
    setVisibleSections(DEFAULT_VISIBLE_SECTIONS);
    setNeedsAttentionOnly(false);
  };

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await fetchAllRemoteRefs(repoPath);
      refresh();
      void refreshWorktrees();
      if (authStatus?.logged_in) {
        fetchBranchPrAudit(repoPath).then(setPrs);
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const handleCreate = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    setIsCreating(true);
    try {
      await createBranch(repoPath, name);
      setNewBranchName("");
    } catch {
      // Error is surfaced via the store's error state.
    } finally {
      setIsCreating(false);
    }
  };

  const handleCheckout = async (name: string) => {
    setBusyBranch(name);
    try {
      await checkoutBranch(repoPath, name);
      refresh();
    } catch {
      // Store error state shows the failure.
    } finally {
      setBusyBranch(null);
    }
  };

  const handleDeleteLocal = async (name: string) => {
    const confirmed = await ask(`Delete local branch "${name}"?`, {
      title: "Delete Branch",
      kind: "warning",
    }).catch(() => false);
    if (!confirmed) return;
    setBusyBranch(name);
    try {
      await deleteBranch(repoPath, name);
    } catch (err) {
      // `git branch -d` refuses unmerged branches; offer the -D fallback.
      if (String(err).includes("not fully merged")) {
        const force = await ask(
          `"${name}" has commits that are not merged anywhere else. Delete it anyway and lose them?`,
          { title: "Branch Not Merged", kind: "warning" },
        ).catch(() => false);
        if (force) {
          await deleteBranch(repoPath, name, true).catch(() => {});
        }
      }
    } finally {
      setBusyBranch(null);
    }
  };

  const handleDeleteRemote = async (name: string) => {
    // Remote branch names look like "origin/feature-x".
    const slash = name.indexOf("/");
    if (slash <= 0) return;
    const remoteName = name.slice(0, slash);
    const branchName = name.slice(slash + 1);
    const confirmed = await ask(
      `Delete branch "${branchName}" on remote "${remoteName}"? This affects everyone using that remote.`,
      { title: "Delete Remote Branch", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    setBusyBranch(name);
    try {
      await deleteRemoteBranch(repoPath, remoteName, branchName);
    } catch {
      // Store error state shows the failure.
    } finally {
      setBusyBranch(null);
    }
  };

  const handleRenameSubmit = async () => {
    if (!renaming) return;
    const newName = renaming.draft.trim();
    if (!newName || newName === renaming.name) {
      setRenaming(null);
      return;
    }
    setBusyBranch(renaming.name);
    try {
      await renameBranch(repoPath, renaming.name, newName);
      setRenaming(null);
    } catch {
      // Keep the input open so the user can adjust the name.
    } finally {
      setBusyBranch(null);
    }
  };

  const handleDeleteWorktree = async (wt: WorktreeStatus) => {
    const branchLabel = wt.branch ?? "(detached)";
    const atRisk = isWorktreeAtRisk(wt);
    const confirmed = await ask(
      atRisk
        ? `Delete worktree "${branchLabel}" at ${wt.path}? It has uncommitted or unpushed work that will be lost.`
        : `Delete worktree "${branchLabel}" at ${wt.path}?`,
      { title: "Delete Worktree", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return;

    setWorktreeError(null);
    setBusyWorktree(wt.path);
    try {
      await removeSessionWorktree(repoPath, wt.path, false);
      await refreshWorktrees();
    } catch (err) {
      // `git worktree remove` refuses a dirty/not-fully-pushed worktree;
      // offer the --force fallback, mirroring the branch delete pattern.
      const force = await ask(
        `"${branchLabel}" could not be removed cleanly — it likely has uncommitted or unpushed work. Force delete and lose it?`,
        { title: "Worktree Not Clean", kind: "warning" },
      ).catch(() => false);
      if (force) {
        try {
          await removeSessionWorktree(repoPath, wt.path, true);
          await refreshWorktrees();
        } catch (forceErr) {
          setWorktreeError(String(forceErr));
        }
      } else {
        setWorktreeError(String(err));
      }
    } finally {
      setBusyWorktree(null);
    }
  };

  const rowButtonClass =
    "shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-maestro-border/60";

  const renderBranchRow = (branch: BranchInfo, isRemote: boolean, isCurrent: boolean) => {
    const name = branch.name;
    const busy = busyBranch === name;
    const matchedPr = findPrForBranch(prs, name, isRemote);

    if (!isRemote && renaming?.name === name) {
      return (
        <div key={name} className="flex items-center gap-1.5 rounded-md px-2 py-1">
          <GitBranch size={12} className="shrink-0 text-maestro-muted" />
          <input
            value={renaming.draft}
            onChange={(e) => setRenaming({ name, draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRenameSubmit();
              if (e.key === "Escape") setRenaming(null);
            }}
            // biome-ignore lint/a11y/noAutofocus: Focus moves to the field the user just opened for renaming.
            autoFocus
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-maestro-accent bg-maestro-surface px-1.5 py-0.5 text-xs text-maestro-text focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void handleRenameSubmit()}
            className="shrink-0 rounded p-0.5 hover:bg-maestro-border/60"
            title="Rename"
          >
            <Check size={12} className="text-maestro-green" />
          </button>
          <button
            type="button"
            onClick={() => setRenaming(null)}
            className="shrink-0 rounded p-0.5 hover:bg-maestro-border/60"
            title="Cancel"
          >
            <X size={12} className="text-maestro-muted" />
          </button>
        </div>
      );
    }

    const metaLabel = [
      branch.lastCommitAuthor,
      branch.lastCommitDate && formatRelativeTime(branch.lastCommitDate),
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <div key={name} className="group rounded-md px-2 py-1 hover:bg-maestro-border/40">
        <div className="flex items-center gap-1.5">
          {isRemote ? (
            <Cloud size={12} className="shrink-0 text-maestro-muted" />
          ) : (
            <GitBranch
              size={12}
              className={`shrink-0 ${isCurrent ? "text-maestro-accent" : "text-maestro-muted"}`}
            />
          )}
          <span
            className={`min-w-0 flex-1 truncate text-xs ${
              isCurrent ? "font-semibold text-maestro-accent" : "text-maestro-text"
            }`}
            title={name}
          >
            {name}
          </span>
          {isCurrent && (
            <span className="shrink-0 rounded bg-maestro-accent/20 px-1 text-[9px] font-bold text-maestro-accent">
              CURRENT
            </span>
          )}
          {busy ? (
            <Loader2 size={12} className="shrink-0 animate-spin text-maestro-muted" />
          ) : (
            <>
              {!isCurrent && (
                <button
                  type="button"
                  onClick={() => void handleCheckout(name)}
                  className={rowButtonClass}
                  title={isRemote ? "Checkout (creates a local tracking branch)" : "Checkout"}
                >
                  <Check size={12} className="text-maestro-green" />
                </button>
              )}
              {!isRemote && (
                <button
                  type="button"
                  onClick={() => setRenaming({ name, draft: name })}
                  className={rowButtonClass}
                  title="Rename branch"
                >
                  <Pencil size={12} className="text-maestro-muted" />
                </button>
              )}
              {!isCurrent && (
                <button
                  type="button"
                  onClick={() =>
                    void (isRemote ? handleDeleteRemote(name) : handleDeleteLocal(name))
                  }
                  className={`${rowButtonClass} hover:bg-maestro-red/10`}
                  title={isRemote ? "Delete branch on the remote" : "Delete local branch"}
                >
                  <Trash2 size={12} className="text-maestro-red" />
                </button>
              )}
            </>
          )}
        </div>
        {(metaLabel || matchedPr) && (
          <div className="flex items-center gap-1.5 pl-[18px]">
            {metaLabel && (
              <span className="min-w-0 truncate text-[10px] text-maestro-muted">{metaLabel}</span>
            )}
            {matchedPr && <PrBadgeChip pr={matchedPr} />}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Search + filters */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-maestro-border/60 px-2 py-2">
        <div className="relative">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-maestro-muted"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search branches and worktrees..."
            spellCheck={false}
            className="w-full rounded border border-maestro-border bg-maestro-surface py-1.5 pl-7 pr-7 text-xs text-maestro-text placeholder:text-maestro-muted focus:border-maestro-accent focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-maestro-muted hover:bg-maestro-border/60 hover:text-maestro-text"
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {SECTION_CHIPS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => toggleSection(chip.key)}
              className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                visibleSections[chip.key]
                  ? "bg-maestro-accent/20 text-maestro-accent"
                  : "bg-maestro-card/60 text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
              }`}
            >
              {chip.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setNeedsAttentionOnly((prev) => !prev)}
            className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
              needsAttentionOnly
                ? "bg-maestro-red/15 text-maestro-red"
                : "bg-maestro-card/60 text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
            }`}
          >
            Needs attention
          </button>
          <button
            type="button"
            onClick={clearFilters}
            disabled={!hasActiveFilters}
            className={`ml-auto rounded-full px-2 py-0.5 text-[10px] transition-colors ${
              hasActiveFilters
                ? "text-maestro-muted hover:text-maestro-text hover:underline"
                : "cursor-not-allowed text-maestro-muted/40"
            }`}
          >
            Clear filters
          </button>
        </div>
      </div>

      {/* Create + sync toolbar */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-maestro-border/60 px-2 py-2">
        <input
          value={newBranchName}
          onChange={(e) => setNewBranchName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
          placeholder="New branch from HEAD..."
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-maestro-border bg-maestro-surface px-2 py-1 text-xs text-maestro-text placeholder:text-maestro-muted focus:border-maestro-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={isCreating || !newBranchName.trim()}
          className="flex shrink-0 items-center gap-1 rounded bg-maestro-accent px-2 py-1 text-xs text-white hover:bg-maestro-accent/80 disabled:opacity-50"
          title="Create branch from HEAD"
        >
          {isCreating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          Create
        </button>
        <button
          type="button"
          onClick={() => void handleSync()}
          disabled={isSyncing}
          className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text disabled:opacity-50"
          title="Fetch all remotes (with prune)"
        >
          <RefreshCw size={13} className={isSyncing ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <p className="shrink-0 break-words border-b border-maestro-border/60 px-2 py-1 text-[10px] text-maestro-red">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
        {/* Local branches */}
        {visibleSections.local && (
          <>
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-maestro-muted">
              Local ({sectionCountLabel(filteredLocalBranches.length, localBranches.length)})
            </p>
            {localBranches.length === 0 ? (
              <p className="px-2 pb-2 text-[11px] italic text-maestro-muted">No local branches</p>
            ) : filteredLocalBranches.length === 0 ? (
              <p className="px-2 pb-2 text-[11px] italic text-maestro-muted">
                No local branches match
              </p>
            ) : (
              filteredLocalBranches.map((b) =>
                renderBranchRow(b, false, b.is_current || b.name === currentBranch),
              )
            )}
          </>
        )}

        {/* Remote branches */}
        {visibleSections.remote && (
          <>
            <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-maestro-muted">
              Remote ({sectionCountLabel(filteredRemoteBranches.length, remoteBranches.length)})
            </p>
            {remoteBranches.length === 0 ? (
              <p className="px-2 text-[11px] italic text-maestro-muted">
                No remote branches — try fetching
              </p>
            ) : filteredRemoteBranches.length === 0 ? (
              <p className="px-2 text-[11px] italic text-maestro-muted">No remote branches match</p>
            ) : (
              filteredRemoteBranches.map((b) => renderBranchRow(b, true, false))
            )}
          </>
        )}

        {/* Worktrees */}
        {visibleSections.worktrees && (
          <>
            <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-maestro-muted">
              Worktrees ({sectionCountLabel(filteredWorktrees.length, worktrees.length)})
            </p>
            {worktreeError && (
              <p className="px-2 pb-1 text-[10px] text-maestro-red">{worktreeError}</p>
            )}
            {worktreesLoading && worktrees.length === 0 ? (
              <p className="px-2 pb-2 text-[11px] italic text-maestro-muted">Loading worktrees…</p>
            ) : worktrees.length === 0 ? (
              <p className="px-2 pb-2 text-[11px] italic text-maestro-muted">No worktrees</p>
            ) : filteredWorktrees.length === 0 ? (
              <p className="px-2 pb-2 text-[11px] italic text-maestro-muted">No worktrees match</p>
            ) : (
              filteredWorktrees.map((wt) => (
                <WorktreeRow
                  key={wt.path}
                  status={wt}
                  busy={busyWorktree === wt.path}
                  onDelete={() => void handleDeleteWorktree(wt)}
                />
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Compact PR badge chip rendered under a branch row when a matching PR exists. */
function PrBadgeChip({ pr }: { pr: BranchPr }) {
  const { label, tone } = prBadge(pr, formatRelativeTime);
  const toneClass: Record<PrBadgeTone, string> = {
    merged: "bg-maestro-green/15 text-maestro-green",
    open: "bg-maestro-accent/15 text-maestro-accent",
    closed: "bg-maestro-muted/15 text-maestro-muted",
  };
  const Icon = tone === "merged" ? GitMerge : tone === "closed" ? XCircle : GitPullRequest;
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      className={`inline-flex min-w-0 shrink-0 items-center gap-1 truncate rounded px-1 py-0.5 text-[9px] font-medium ${toneClass[tone]} hover:opacity-80`}
    >
      <Icon size={9} className="shrink-0" />
      <span className="truncate">{label}</span>
    </a>
  );
}

/** One row in the Worktrees section: branch, short path, risk indicator, delete. */
function WorktreeRow({
  status,
  busy,
  onDelete,
}: {
  status: WorktreeStatus;
  busy: boolean;
  onDelete: () => void;
}) {
  const branchLabel = status.branch ?? "(detached)";
  const atRisk = isWorktreeAtRisk(status);

  return (
    <div className="group flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-maestro-border/40">
      <FolderGit2
        size={12}
        className={`shrink-0 ${status.is_main_worktree ? "text-maestro-accent" : "text-maestro-muted"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs text-maestro-text" title={branchLabel}>
            {branchLabel}
          </span>
          {status.is_main_worktree && (
            <span className="shrink-0 rounded bg-maestro-accent/20 px-1 text-[9px] font-bold text-maestro-accent">
              MAIN
            </span>
          )}
          {status.ahead > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-maestro-orange">
              <ArrowUp size={9} />
              {status.ahead}
            </span>
          )}
          {status.behind > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-maestro-accent">
              <ArrowDown size={9} />
              {status.behind}
            </span>
          )}
          {atRisk && (
            <span
              title="Uncommitted, unpushed, or stashed work would be lost"
              className="flex shrink-0 items-center gap-0.5 rounded bg-maestro-red/15 px-1 text-[9px] font-medium uppercase tracking-wide text-maestro-red"
            >
              <AlertTriangle size={9} />
              at risk
            </span>
          )}
        </div>
        <p className="truncate text-[10px] text-maestro-muted" title={status.path}>
          {status.path}
        </p>
      </div>
      {busy ? (
        <Loader2 size={12} className="shrink-0 animate-spin text-maestro-muted" />
      ) : (
        !status.is_main_worktree && (
          <button
            type="button"
            onClick={onDelete}
            className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-maestro-red/10 group-hover:opacity-100"
            title="Delete worktree"
          >
            <Trash2 size={12} className="text-maestro-red" />
          </button>
        )
      )}
    </div>
  );
}
