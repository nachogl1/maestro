import { invoke } from "@tauri-apps/api/core";
import { listWorktrees } from "./worktreeManager";

/** Branch info from the backend. */
export interface BranchInfo {
  name: string;
  is_remote: boolean;
  is_current: boolean;
  /** ISO-8601 commit date of the branch tip. Absent for a rare empty ref. */
  lastCommitDate?: string;
  /** Author name of the branch tip's commit. Absent for a rare empty ref. */
  lastCommitAuthor?: string;
}

/** Extended branch info with worktree status for UI display. */
export interface BranchWithWorktreeStatus {
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  hasWorktree: boolean;
}

/**
 * Shared cache for in-flight branch fetches to avoid redundant IPC calls
 * when multiple components in the same project poll or fetch simultaneously.
 */
const activeFetches = new Map<string, Promise<string>>();

/**
 * Last successfully resolved branch per repo. In-flight sharing alone only
 * collapses calls that overlap, and the per-terminal 15 s polls start at
 * different moments so they never do — N terminals in one repo meant N
 * identical `git symbolic-ref` spawns per window. Successful results are
 * therefore held for {@link BRANCH_CACHE_TTL_MS}. Failures are never cached.
 */
const branchCache = new Map<string, { value: string; at: number }>();

/** How long a resolved branch name is reused before re-spawning git. */
const BRANCH_CACHE_TTL_MS = 10_000;

/**
 * Fetches all branches for a repository.
 * @param repoPath - Path to the git repository
 * @returns List of branch info from the backend
 */
async function getBranches(repoPath: string): Promise<BranchInfo[]> {
  return invoke<BranchInfo[]>("git_branches", { repoPath });
}

/**
 * Fetches branches with worktree status indicators.
 * Combines branch list with worktree info to show which branches already have worktrees.
 *
 * @param repoPath - Path to the git repository
 * @returns List of branches with worktree status
 */
export async function getBranchesWithWorktreeStatus(
  repoPath: string,
): Promise<BranchWithWorktreeStatus[]> {
  const [branches, worktrees] = await Promise.all([
    getBranches(repoPath),
    listWorktrees(repoPath).catch(() => []), // Gracefully handle non-git repos
  ]);

  const worktreeBranches = new Set(
    worktrees.map((wt) => wt.branch).filter((b): b is string => b !== null),
  );

  return branches.map((branch) => ({
    name: branch.name,
    isRemote: branch.is_remote,
    isCurrent: branch.is_current,
    hasWorktree: worktreeBranches.has(branch.name),
  }));
}

/**
 * Gets the current branch name for a repository.
 * @param repoPath - Path to the git repository
 * @returns Current branch name or short commit hash if detached
 */
async function getCurrentBranch(repoPath: string): Promise<string> {
  return invoke<string>("git_current_branch", { repoPath });
}

/**
 * Checks if a path is a git worktree (not the main working tree).
 * @param repoPath - Path to check
 * @returns true if the path is a linked worktree
 */
export async function isGitWorktree(repoPath: string): Promise<boolean> {
  return invoke<boolean>("is_git_worktree", { repoPath });
}

/**
 * Gets the current branch name, deduplicating requests for the same path:
 * simultaneous callers share the one in-flight fetch, and callers arriving
 * within {@link BRANCH_CACHE_TTL_MS} of the last success reuse that result.
 *
 * The TTL bounds staleness at 10 s. Anything that changes the branch itself
 * should call {@link invalidateCurrentBranchCache} so the next read is exact.
 *
 * @param repoPath - Path to the git repository
 * @returns Current branch name
 */
export async function getDeduplicatedCurrentBranch(repoPath: string): Promise<string> {
  const cached = branchCache.get(repoPath);
  if (cached && Date.now() - cached.at < BRANCH_CACHE_TTL_MS) return cached.value;

  const existing = activeFetches.get(repoPath);
  if (existing) return existing;

  const promise = getCurrentBranch(repoPath)
    .then((name) => {
      branchCache.set(repoPath, { value: name, at: Date.now() });
      return name;
    })
    .finally(() => {
      activeFetches.delete(repoPath);
    });
  activeFetches.set(repoPath, promise);
  return promise;
}

/**
 * Drops the cached branch name so the next {@link getDeduplicatedCurrentBranch}
 * re-reads git. Call after a checkout (or any other branch change) to keep the
 * headers exact instead of waiting out the TTL.
 *
 * @param repoPath - Repo to invalidate; omit to clear every entry
 */
export function invalidateCurrentBranchCache(repoPath?: string): void {
  if (repoPath === undefined) {
    branchCache.clear();
  } else {
    branchCache.delete(repoPath);
  }
}

// ── Worktree status (per-worktree "what's at risk if I delete this") ──

export type FileStatusKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechanged"
  | "unmerged"
  | "unknown";

export interface FileStatusEntry {
  path: string;
  status: FileStatusKind;
  old_path: string | null;
}

export interface UnpushedCommit {
  hash: string;
  short_hash: string;
  author: string;
  timestamp: number;
  summary: string;
}

export interface StashEntry {
  ref_name: string;
  message: string;
  branch: string | null;
}

export interface WorktreeStatus {
  path: string;
  branch: string | null;
  head: string;
  is_main_worktree: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: FileStatusEntry[];
  unstaged: FileStatusEntry[];
  untracked: string[];
  unpushed_commits: UnpushedCommit[];
  stashes: StashEntry[];
}

/**
 * Returns the WorktreeStatus for every worktree of `repoPath`. Aggregates
 * staged/unstaged/untracked files, unpushed commits, and stashes — i.e.
 * everything that would be lost if the worktree or its branch were deleted.
 */
export async function getWorktreesStatus(repoPath: string): Promise<WorktreeStatus[]> {
  return invoke<WorktreeStatus[]>("git_worktrees_status", { repoPath });
}

/**
 * Discards a single tracked file's uncommitted changes, restoring it to its
 * committed (HEAD) state. For a newly added file with no committed version,
 * the file is removed instead. This is irreversible.
 *
 * @param worktreePath - Absolute path to the worktree the file lives in
 * @param path - Repo-relative path of the file to discard
 * @param oldPath - Original path for a renamed file, so the rename is undone
 */
export async function discardFile(
  worktreePath: string,
  path: string,
  oldPath?: string | null,
): Promise<void> {
  return invoke<void>("git_discard_file", {
    worktreePath,
    path,
    oldPath: oldPath ?? null,
  });
}

/**
 * Deletes an untracked file or directory from the worktree. Irreversible.
 *
 * @param worktreePath - Absolute path to the worktree the file lives in
 * @param path - Repo-relative path of the untracked file to delete
 */
export async function removeFile(worktreePath: string, path: string): Promise<void> {
  return invoke<void>("git_remove_file", { worktreePath, path });
}

/** Which two versions of a file a diff compares. */
export type FileDiffMode = "staged" | "unstaged" | "untracked";

/**
 * Diff of a single working-tree file, as returned by the backend.
 * For tracked files `diff` holds raw unified diff text (empty when binary).
 * For untracked files `content` holds the full file text instead.
 */
export interface FileDiff {
  path: string;
  old_path: string | null;
  is_binary: boolean;
  is_untracked: boolean;
  diff: string;
  content: string | null;
}

/**
 * Fetches the diff of a single file for the side-by-side diff viewer.
 *
 * @param worktreePath - Absolute path to the worktree the file lives in
 * @param path - Repo-relative path of the file
 * @param mode - "staged" (HEAD → index), "unstaged" (index → worktree), or
 *               "untracked" (full content, no old version)
 * @param oldPath - Original path for a renamed file
 */
export async function getFileDiff(
  worktreePath: string,
  path: string,
  mode: FileDiffMode,
  oldPath?: string | null,
): Promise<FileDiff> {
  return invoke<FileDiff>("git_file_diff", {
    worktreePath,
    path,
    mode,
    oldPath: oldPath ?? null,
  });
}

/**
 * `true` when the worktree has anything that would be lost on delete:
 * unpushed commits, working-tree changes, or stashes.
 */
export function isWorktreeAtRisk(status: WorktreeStatus): boolean {
  return (
    status.ahead > 0 ||
    status.staged.length > 0 ||
    status.unstaged.length > 0 ||
    status.untracked.length > 0 ||
    status.unpushed_commits.length > 0 ||
    status.stashes.length > 0
  );
}
