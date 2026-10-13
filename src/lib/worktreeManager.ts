import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";

/** Worktree info from the backend. */
export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  is_bare: boolean;
  /** True for the main working tree (the original clone directory). */
  is_main_worktree: boolean;
}

/** Result of preparing a worktree for a session. */
export interface WorktreePreparationResult {
  /** The directory where the session should run (worktree or project path). */
  working_directory: string;
  /** The worktree path if one was created or reused. */
  worktree_path: string | null;
  /** The resolved branch name (auto-detected or explicitly specified). */
  branch: string | null;
  /** Whether a new worktree was created (vs. reused or skipped). */
  created: boolean;
  /** Warning message if something unexpected happened but we recovered. */
  warning: string | null;
}

/**
 * Generates a hash from a string for creating unique worktree paths.
 */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

/**
 * Sanitizes a branch name for use in filesystem paths.
 */
function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * Gets the base directory for worktrees.
 * Uses ~/.claude-maestro/worktrees/
 */
async function getWorktreeBaseDir(): Promise<string> {
  const home = await homeDir();
  return `${home}.claude-maestro/worktrees`;
}

/**
 * Calculates the worktree path for a given repo and branch.
 *
 * Path format: ~/.claude-maestro/worktrees/{repoHash}/{sanitizedBranch}/
 *
 * @param repoPath - The path to the main repository
 * @param branch - The branch name
 * @returns The worktree path
 */
async function getWorktreePath(repoPath: string, branch: string): Promise<string> {
  const baseDir = await getWorktreeBaseDir();
  const repoHash = hashString(repoPath);
  const sanitizedBranch = sanitizeBranch(branch);
  return `${baseDir}/${repoHash}/${sanitizedBranch}`;
}

/**
 * Removes a worktree associated with a session.
 *
 * @param repoPath - The path to the main repository
 * @param worktreePath - The worktree path to remove
 * @param force - Whether to force removal even with uncommitted changes
 */
export async function removeSessionWorktree(
  repoPath: string,
  worktreePath: string,
  force = false,
): Promise<void> {
  try {
    await invoke("git_worktree_remove", {
      repoPath,
      path: worktreePath,
      force,
    });
    console.log(`Removed worktree at ${worktreePath}`);
  } catch (err) {
    console.error(`Failed to remove worktree at ${worktreePath}:`, err);
    throw err;
  }
}

/**
 * Lists all worktrees for a repository.
 *
 * @param repoPath - The path to the main repository
 * @returns List of worktree info
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  return invoke<WorktreeInfo[]>("git_worktree_list", { repoPath });
}

/**
 * Prepares a worktree for a session, handling all edge cases gracefully.
 *
 * This function orchestrates worktree creation for a session launch:
 * - If no branch is specified, returns the project path as-is.
 * - If a worktree already exists for this branch, reuses it.
 * - If the branch is checked out in the main repo, switches main to default branch first.
 * - If the branch doesn't exist locally, creates it from HEAD.
 * - Creates the worktree via the backend WorktreeManager.
 *
 * On any failure, falls back to the project path so sessions always launch.
 *
 * @param projectPath - The path to the main repository
 * @param branch - The branch to checkout in the worktree (null to skip worktree)
 * @returns The preparation result with the working directory to use
 */
export async function prepareSessionWorktree(
  projectPath: string,
  branch: string | null,
  worktreeBasePath?: string | null,
  forceNew?: boolean,
): Promise<WorktreePreparationResult> {
  try {
    const result = await invoke<WorktreePreparationResult>("prepare_session_worktree", {
      projectPath,
      branch,
      worktreeBasePath: worktreeBasePath ?? null,
      forceNew: forceNew ?? false,
    });

    if (result.warning) {
      console.warn(`Worktree warning: ${result.warning}`);
    }

    if (result.created) {
      console.log(`Created worktree at ${result.worktree_path}`);
    } else if (result.worktree_path) {
      console.log(`Reusing worktree at ${result.worktree_path}`);
    } else {
      console.log(`Using project path (no worktree)`);
    }

    return result;
  } catch (err) {
    console.error(`Failed to prepare worktree:`, err);
    // Fall back to project path on error
    return {
      working_directory: projectPath,
      worktree_path: null,
      branch: null,
      created: false,
      warning: `Failed to prepare worktree: ${err}`,
    };
  }
}

/**
 * Cleans up a worktree when a session ends.
 *
 * Removes the worktree from the filesystem and prunes git refs.
 * Failures are logged but don't prevent session cleanup.
 *
 * @param projectPath - The path to the main repository
 * @param worktreePath - The worktree path to clean up
 * @param worktreeBasePath - The project's custom worktree base dir (null = default);
 *   the backend refuses to delete worktrees outside this managed base
 * @returns True if a worktree was cleaned up, false otherwise
 */
export async function cleanupSessionWorktree(
  projectPath: string,
  worktreePath: string | null,
  worktreeBasePath?: string | null,
): Promise<boolean> {
  if (!worktreePath) {
    return false;
  }

  try {
    const cleaned = await invoke<boolean>("cleanup_session_worktree", {
      projectPath,
      worktreePath,
      worktreeBasePath: worktreeBasePath ?? null,
    });

    if (cleaned) {
      console.log(`Cleaned up worktree at ${worktreePath}`);
    }

    return cleaned;
  } catch (err) {
    console.error(`Failed to cleanup worktree at ${worktreePath}:`, err);
    return false;
  }
}
