use std::path::PathBuf;

use crate::git::{
    BranchInfo, CommitInfo, FileChange, FileDiff, FileDiffMode, Git, GitError, GitUserConfig,
    RemoteInfo, WorktreeInfo, WorktreeStatus,
};

/// Information about a detected repository or directory within a workspace.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RepositoryInfo {
    /// Absolute path to the repository root.
    pub path: String,
    /// Display name (folder name).
    pub name: String,
    /// Whether this directory is a git repository.
    #[serde(rename = "isGitRepo")]
    pub is_git_repo: bool,
    /// Current branch name (if available).
    #[serde(rename = "currentBranch")]
    pub current_branch: Option<String>,
    /// Primary remote URL (origin, or first remote if no origin).
    #[serde(rename = "remoteUrl")]
    pub remote_url: Option<String>,
}

/// Returns `Err(GitError::NotARepo)` if the given path string is empty.
fn validate_repo_path(repo_path: &str) -> Result<(), GitError> {
    if repo_path.is_empty() {
        return Err(GitError::NotARepo {
            path: PathBuf::from(""),
        });
    }
    Ok(())
}

/// Exposes `Git::list_branches` to the frontend.
/// Returns all local and remote branches (excluding HEAD pointer entries).
#[tauri::command]
pub async fn git_branches(repo_path: String) -> Result<Vec<BranchInfo>, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.list_branches().await
}

/// Exposes `Git::current_branch` to the frontend.
/// Returns the branch name, or a short commit hash if HEAD is detached.
#[tauri::command]
pub async fn git_current_branch(repo_path: String) -> Result<String, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.current_branch().await
}

/// Exposes `Git::uncommitted_count` to the frontend.
/// Returns the number of dirty files (staged + unstaged + untracked).
#[tauri::command]
pub async fn git_uncommitted_count(repo_path: String) -> Result<usize, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.uncommitted_count().await
}

/// Exposes `Git::worktree_list` to the frontend.
/// Returns all worktrees (including the main one) with path, HEAD, and branch info.
#[tauri::command]
pub async fn git_worktree_list(repo_path: String) -> Result<Vec<WorktreeInfo>, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.worktree_list().await
}

/// Exposes `Git::worktree_add` to the frontend.
/// Creates a new worktree at `path`, optionally on a new branch from `checkout_ref`.
#[tauri::command]
pub async fn git_worktree_add(
    repo_path: String,
    path: String,
    new_branch: Option<String>,
    checkout_ref: Option<String>,
) -> Result<WorktreeInfo, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    let wt_path = PathBuf::from(&path);
    git.worktree_add(&wt_path, new_branch.as_deref(), checkout_ref.as_deref())
        .await
}

/// Exposes `Git::worktree_remove` to the frontend.
/// Removes a worktree directory; `force` bypasses uncommitted-changes checks.
#[tauri::command]
pub async fn git_worktree_remove(
    repo_path: String,
    path: String,
    force: bool,
) -> Result<(), GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    let wt_path = PathBuf::from(&path);
    git.worktree_remove(&wt_path, force).await
}

/// Exposes `Git::worktree_status` to the frontend.
///
/// `worktree_path` should be the absolute path to the worktree (or main repo)
/// to inspect; `is_main_worktree` indicates whether it's the primary working
/// tree. Returns a snapshot of every change that would be lost if the
/// worktree or branch were deleted: staged/unstaged/untracked files,
/// unpushed commits, and stashes that originated on the branch.
#[tauri::command]
pub async fn git_worktree_status(
    worktree_path: String,
    is_main_worktree: bool,
) -> Result<WorktreeStatus, GitError> {
    validate_repo_path(&worktree_path)?;
    let git = Git::new(&worktree_path);
    git.worktree_status(worktree_path.clone(), is_main_worktree)
        .await
}

/// Exposes `Git::all_worktrees_status` to the frontend.
///
/// Returns the [`WorktreeStatus`] for every worktree of `repo_path`. Bad
/// worktrees are skipped server-side rather than failing the whole call.
#[tauri::command]
pub async fn git_worktrees_status(repo_path: String) -> Result<Vec<WorktreeStatus>, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.all_worktrees_status().await
}

/// Exposes `Git::discard_file` to the frontend.
///
/// Discards a single tracked file's uncommitted changes, returning it to its
/// HEAD state. `worktree_path` is the worktree the file lives in. Irreversible.
#[tauri::command]
pub async fn git_discard_file(
    worktree_path: String,
    path: String,
    old_path: Option<String>,
) -> Result<(), GitError> {
    validate_repo_path(&worktree_path)?;
    let git = Git::new(&worktree_path);
    git.discard_file(&path, old_path.as_deref()).await
}

/// Exposes `Git::remove_file` to the frontend.
///
/// Deletes an untracked file or directory from `worktree_path`. Irreversible.
#[tauri::command]
pub async fn git_remove_file(worktree_path: String, path: String) -> Result<(), GitError> {
    validate_repo_path(&worktree_path)?;
    let git = Git::new(&worktree_path);
    git.remove_file(&path).await
}

/// Exposes `Git::file_diff` to the frontend.
///
/// Returns the unified diff (or full content for untracked files) of a single
/// file in `worktree_path`. `mode` is "staged", "unstaged", or "untracked".
#[tauri::command]
pub async fn git_file_diff(
    worktree_path: String,
    path: String,
    old_path: Option<String>,
    mode: String,
) -> Result<FileDiff, GitError> {
    validate_repo_path(&worktree_path)?;
    let mode = match mode.as_str() {
        "staged" => FileDiffMode::Staged,
        "unstaged" => FileDiffMode::Unstaged,
        "untracked" => FileDiffMode::Untracked,
        other => {
            return Err(GitError::ParseError {
                message: format!("unknown diff mode: {other}"),
            })
        }
    };
    let git = Git::new(&worktree_path);
    git.file_diff(&path, old_path.as_deref(), mode).await
}

/// Exposes `Git::commit_log` to the frontend.
/// Returns up to `max_count` commits in topological order across all or current branch.
#[tauri::command]
pub async fn git_commit_log(
    repo_path: String,
    max_count: usize,
    all_branches: bool,
) -> Result<Vec<CommitInfo>, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.commit_log(max_count, all_branches).await
}

/// Checks out a branch by name.
/// Handles both local and remote branches.
#[tauri::command]
pub async fn git_checkout_branch(repo_path: String, branch_name: String) -> Result<(), GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.checkout_branch(&branch_name).await
}

/// Creates a new branch, optionally from a specific starting point.
#[tauri::command]
pub async fn git_create_branch(
    repo_path: String,
    branch_name: String,
    start_point: Option<String>,
) -> Result<(), GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.create_branch(&branch_name, start_point.as_deref())
        .await
}

/// Deletes a local branch. `force` uses `-D` (delete even if unmerged).
#[tauri::command]
pub async fn git_delete_branch(
    repo_path: String,
    branch_name: String,
    force: bool,
) -> Result<(), GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.delete_branch(&branch_name, force).await
}

/// Renames a local branch.
#[tauri::command]
pub async fn git_rename_branch(
    repo_path: String,
    old_name: String,
    new_name: String,
) -> Result<(), GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.rename_branch(&old_name, &new_name).await
}

/// Deletes a branch on a remote (`git push <remote> --delete <branch>`).
#[tauri::command]
pub async fn git_delete_remote_branch(
    repo_path: String,
    remote_name: String,
    branch_name: String,
) -> Result<(), GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.delete_remote_branch(&remote_name, &branch_name).await
}

/// Returns the list of files changed in a specific commit.
#[tauri::command]
pub async fn git_commit_files(
    repo_path: String,
    commit_hash: String,
) -> Result<Vec<FileChange>, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.commit_files(&commit_hash).await
}

/// Gets the git user config (name and email) for this repository.
#[tauri::command]
pub async fn git_user_config(repo_path: String) -> Result<GitUserConfig, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.get_user_config().await
}

/// Sets the git user config (name and/or email).
#[tauri::command]
pub async fn git_set_user_config(
    repo_path: String,
    name: Option<String>,
    email: Option<String>,
    global: bool,
) -> Result<(), GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.set_user_config(name.as_deref(), email.as_deref(), global)
        .await
}

/// Lists all configured remotes with their URLs.
#[tauri::command]
pub async fn git_list_remotes(repo_path: String) -> Result<Vec<RemoteInfo>, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.list_remotes().await
}

/// Adds a new remote with the given name and URL.
#[tauri::command]
pub async fn git_add_remote(repo_path: String, name: String, url: String) -> Result<(), GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.add_remote(&name, &url).await
}

/// Removes a remote by name.
#[tauri::command]
pub async fn git_remove_remote(repo_path: String, name: String) -> Result<(), GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.remove_remote(&name).await
}

/// Gets refs (branches and tags) pointing to a specific commit.
#[tauri::command]
pub async fn git_refs_for_commit(
    repo_path: String,
    commit_hash: String,
) -> Result<Vec<String>, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.refs_for_commit(&commit_hash).await
}

/// Fetches refs and objects from a specific remote.
/// Uses --prune to clean up stale remote-tracking branches.
#[tauri::command]
pub async fn git_fetch(repo_path: String, remote_name: String) -> Result<(), GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.fetch(&remote_name).await
}

/// Fetches refs and objects from all configured remotes.
#[tauri::command]
pub async fn git_fetch_all(repo_path: String) -> Result<(), GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.fetch_all().await
}

/// Tests connectivity to a remote.
/// Returns true if reachable, false otherwise.
#[tauri::command]
pub async fn git_test_remote(repo_path: String, remote_name: String) -> Result<bool, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.test_remote(&remote_name).await
}

/// Updates the URL of an existing remote.
#[tauri::command]
pub async fn git_set_remote_url(
    repo_path: String,
    name: String,
    url: String,
) -> Result<(), GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.set_remote_url(&name, &url).await
}

/// Gets the default branch name from git config.
#[tauri::command]
pub async fn git_get_default_branch(repo_path: String) -> Result<Option<String>, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.get_default_branch().await
}

/// Sets the default branch name in git config.
#[tauri::command]
pub async fn git_set_default_branch(
    repo_path: String,
    branch: String,
    global: bool,
) -> Result<(), GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.set_default_branch(&branch, global).await
}

/// Checks if a path is a git repository root.
/// Returns true if the path contains a .git directory or file (could be a worktree).
#[tauri::command]
pub async fn is_git_repository(path: String) -> Result<bool, GitError> {
    let git_path = std::path::Path::new(&path).join(".git");
    Ok(git_path.exists())
}

/// Checks if a path is a git worktree (not the main working tree).
/// Returns true if the path is a linked worktree created by `git worktree add`.
#[tauri::command]
pub async fn is_git_worktree(repo_path: String) -> Result<bool, GitError> {
    validate_repo_path(&repo_path)?;
    let git = Git::new(&repo_path);
    git.is_worktree().await
}

/// Directories to skip during the recursive workspace scan.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "build",
    "dist",
    ".next",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".cargo",
];

/// Ceiling on the real work one workspace scan does at once: the per-repo
/// `git` probes and the directory reads each take a permit. A wide tree can
/// therefore never fork hundreds of git processes or saturate the blocking
/// pool, however many directories the fan-out visits.
const MAX_CONCURRENT_SCANS: usize = 8;

/// Recursively scans a directory for nested git repositories.
/// Skips common non-project directories (node_modules, .git, etc.) and
/// limits depth to avoid performance issues.
#[tauri::command]
pub async fn detect_repositories(path: String) -> Result<Vec<RepositoryInfo>, GitError> {
    let root = PathBuf::from(&path);
    let scan_limit = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_SCANS));

    // Walk directory recursively (max depth 5 to avoid performance issues)
    Ok(detect_repos_recursive(root, SKIP_DIRS, 0, 5, scan_limit).await)
}

/// Internal recursive helper for detect_repositories.
///
/// Returns this subtree's repositories in depth-first pre-order — the directory
/// itself (when it qualifies) followed by each child's results in `read_dir`
/// order — which is the order the serial version produced. Subdirectories are
/// walked concurrently on a `JoinSet` and re-sorted by their child index, so
/// the fan-out is invisible to callers. Uses `Box::pin` for async recursion;
/// the arguments are owned/`'static` because `JoinSet` tasks must be.
fn detect_repos_recursive(
    dir: PathBuf,
    skip_dirs: &'static [&'static str],
    depth: usize,
    max_depth: usize,
    scan_limit: std::sync::Arc<tokio::sync::Semaphore>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<RepositoryInfo>> + Send>> {
    Box::pin(async move {
        let mut repos: Vec<RepositoryInfo> = Vec::new();

        if depth > max_depth {
            return repos;
        }

        // Check if this directory is a git repo
        let git_path = dir.join(".git");
        let is_git_repo = git_path.exists();

        if is_git_repo {
            // Get current branch and remotes (best effort). The two probes are
            // independent git processes, so they run together rather than
            // back-to-back; the permit caps how many repos probe at once.
            let git = Git::new(dir.to_str().unwrap_or_default());
            let (current_branch, remotes) = {
                let _permit = scan_limit.acquire().await;
                tokio::join!(git.current_branch(), git.list_remotes())
            };
            let current_branch = current_branch.ok();

            // Get primary remote URL (prefer "origin", fall back to first remote)
            let remote_url = match remotes {
                Ok(remotes) => remotes
                    .iter()
                    .find(|r| r.name == "origin")
                    .or_else(|| remotes.first())
                    .map(|r| r.url.clone()),
                Err(_) => None,
            };

            repos.push(RepositoryInfo {
                path: dir.to_string_lossy().to_string(),
                name: dir
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| dir.to_string_lossy().to_string()),
                is_git_repo: true,
                current_branch,
                remote_url,
            });
            // Continue scanning - there may be nested repos (submodules, monorepo packages, etc.)
        } else if depth == 1 {
            // Include immediate non-git directories so they appear in the workspace selector
            repos.push(RepositoryInfo {
                path: dir.to_string_lossy().to_string(),
                name: dir
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| dir.to_string_lossy().to_string()),
                is_git_repo: false,
                current_branch: None,
                remote_url: None,
            });
        }

        // Read directory entries. Async (so the walk never blocks a runtime
        // thread) and under a permit, which is released before recursing —
        // holding one across the child awaits would deadlock the pool.
        let children = {
            let _permit = scan_limit.acquire().await;
            let mut entries = match tokio::fs::read_dir(&dir).await {
                Ok(e) => e,
                Err(_) => return repos,
            };

            let mut children: Vec<PathBuf> = Vec::new();
            // Skip unreadable entries rather than ending the walk on the first
            // one, matching the `flatten()` behaviour this replaced. A single
            // sharing violation or unreadable junction must not silently drop
            // every sibling after it — and with it every repo underneath.
            // The consecutive-error cap stops a permanently-failing handle from
            // spinning forever, which plain `continue` would allow.
            let mut consecutive_errors = 0u32;
            loop {
                let entry = match entries.next_entry().await {
                    Ok(Some(entry)) => {
                        consecutive_errors = 0;
                        entry
                    }
                    Ok(None) => break,
                    Err(e) => {
                        consecutive_errors += 1;
                        if consecutive_errors >= 16 {
                            log::warn!(
                                "detect_repositories: giving up on {} after repeated read errors: {e}",
                                dir.display()
                            );
                            break;
                        }
                        continue;
                    }
                };

                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }

                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                // Skip hidden and excluded directories
                if name.starts_with('.') || skip_dirs.contains(&name.as_str()) {
                    continue;
                }

                children.push(path);
            }
            children
        };

        // Recurse into children concurrently instead of one directory at a
        // time, but keep at most MAX_CONCURRENT_SCANS of them in flight per
        // directory. Spawning every child at every level would hold one live
        // task per directory in the whole subtree; topping the pool up caps
        // each directory's own fan-out instead. Note this bounds task objects,
        // not work — the semaphore is what limits how much runs at once.
        let mut results: Vec<(usize, Vec<RepositoryInfo>)> = Vec::new();
        let mut tasks: tokio::task::JoinSet<(usize, Vec<RepositoryInfo>)> =
            tokio::task::JoinSet::new();
        let mut pending = children.into_iter().enumerate();

        loop {
            while tasks.len() < MAX_CONCURRENT_SCANS {
                let Some((index, child)) = pending.next() else {
                    break;
                };
                let limit = std::sync::Arc::clone(&scan_limit);
                tasks.spawn(async move {
                    (
                        index,
                        detect_repos_recursive(child, skip_dirs, depth + 1, max_depth, limit).await,
                    )
                });
            }

            match tasks.join_next().await {
                Some(Ok(result)) => results.push(result),
                // A panicking child must not take the whole scan down.
                Some(Err(e)) => log::warn!("detect_repositories: scan task failed: {e}"),
                None => break,
            }
        }
        // Restore `read_dir` order — the serial walk's ordering contract.
        results.sort_by_key(|(index, _)| *index);
        for (_, child_repos) in results {
            repos.extend(child_repos);
        }

        repos
    })
}
