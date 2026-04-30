use serde::Serialize;
use std::path::Path;

use super::error::GitError;
use super::runner::Git;

/// A local or remote branch returned by `list_branches`.
///
/// Remote branches have `is_remote = true` and names like `origin/main`.
/// Synthetic `HEAD` pointer entries (e.g. `origin/HEAD`) are filtered out
/// during parsing and will never appear in results.
#[derive(Debug, Clone, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_remote: bool,
    pub is_current: bool,
}

/// Metadata for a single git worktree, parsed from `git worktree list --porcelain`.
///
/// `branch` is `None` for detached HEAD states or bare repositories.
/// `head` contains the full commit SHA the worktree currently points to.
#[derive(Debug, Clone, Serialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub is_bare: bool,
    /// `true` for the first entry returned by `git worktree list`, which is
    /// always the main working tree (the original clone directory).
    pub is_main_worktree: bool,
}

/// A single commit entry parsed from `git log` output.
///
/// `parent_hashes` is empty for root commits and contains multiple entries
/// for merge commits. `timestamp` is a Unix epoch value from `%at`.
/// `summary` is the first line of the commit message (`%s`).
#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub parent_hashes: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub summary: String,
}

/// Represents a file changed in a commit.
#[derive(Debug, Clone, Serialize)]
pub struct FileChange {
    pub path: String,
    pub status: FileChangeStatus,
    /// Original path for renamed files
    pub old_path: Option<String>,
}

/// The type of change made to a file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Unknown,
}

/// Git user configuration (name and email).
#[derive(Debug, Clone, Serialize)]
pub struct GitUserConfig {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// Information about a git remote.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

/// Per-worktree snapshot of "what is at risk of being lost" if the worktree
/// or its branch is deleted. Aggregates working-tree status, unpushed
/// commits, and stashes that originated on this branch.
#[derive(Debug, Clone, Serialize)]
pub struct WorktreeStatus {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub is_main_worktree: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub staged: Vec<FileStatusEntry>,
    pub unstaged: Vec<FileStatusEntry>,
    pub untracked: Vec<String>,
    pub unpushed_commits: Vec<UnpushedCommit>,
    pub stashes: Vec<StashEntry>,
}

/// A single file changed in the working tree (either staged or unstaged).
#[derive(Debug, Clone, Serialize)]
pub struct FileStatusEntry {
    pub path: String,
    pub status: FileStatusKind,
    /// Source path for renames and copies; `None` otherwise.
    pub old_path: Option<String>,
}

/// Kind of working-tree change for a single file.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileStatusKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    Unknown,
}

/// A commit that is reachable from HEAD but not from the upstream branch.
#[derive(Debug, Clone, Serialize)]
pub struct UnpushedCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub timestamp: i64,
    pub summary: String,
}

/// A single entry from `git stash list`. `branch` is parsed from the stash
/// message ("WIP on <branch>" / "On <branch>") and used by the UI to
/// associate the stash with the worktree where it was created.
#[derive(Debug, Clone, Serialize)]
pub struct StashEntry {
    pub ref_name: String,
    pub message: String,
    pub branch: Option<String>,
}

impl Git {
    /// Lists all local and remote branches, excluding `HEAD` pointer entries.
    ///
    /// Parses `git branch -a` with a custom format using `|` delimiters.
    /// Any branch name containing "HEAD" (e.g. `origin/HEAD`) is skipped to
    /// avoid exposing symbolic refs that confuse branch selectors in the UI.
    pub async fn list_branches(&self) -> Result<Vec<BranchInfo>, GitError> {
        let output = self
            .run(&[
                "branch",
                "-a",
                "--no-color",
                "--format=%(HEAD)|%(refname:short)|%(refname:rstrip=-2)",
            ])
            .await?;

        let mut branches = Vec::new();
        for line in output.lines() {
            let parts: Vec<&str> = line.splitn(3, '|').collect();
            if parts.len() < 2 {
                continue;
            }
            let is_current = parts[0].trim() == "*";
            let name = parts[1].trim().to_string();

            // Skip HEAD pointer entries like "origin/HEAD"
            if name == "HEAD" || name.ends_with("/HEAD") {
                continue;
            }

            let is_remote = parts
                .get(2)
                .map(|r| r.trim() == "remotes")
                .unwrap_or(false);

            branches.push(BranchInfo {
                name,
                is_remote,
                is_current,
            });
        }
        Ok(branches)
    }

    /// Returns the name of the currently checked-out branch.
    ///
    /// Uses `symbolic-ref` first; if that fails (detached HEAD), falls back to
    /// `rev-parse --short HEAD` so the caller always gets a usable label.
    pub async fn current_branch(&self) -> Result<String, GitError> {
        match self.run(&["symbolic-ref", "--short", "HEAD"]).await {
            Ok(output) => Ok(output.trimmed().to_string()),
            Err(GitError::CommandFailed { code, stderr, .. }) => {
                // Git returns: "fatal: ref HEAD is not a symbolic ref"
                if stderr.contains("not a symbolic ref") {
                    // Detached HEAD — fall back to short hash
                    let output = self.run(&["rev-parse", "--short", "HEAD"]).await?;
                    Ok(output.trimmed().to_string())
                } else {
                    // Real error — propagate
                    Err(GitError::CommandFailed {
                        code,
                        stderr,
                        command: "git symbolic-ref --short HEAD".to_string(),
                    })
                }
            }
            Err(e) => Err(e), // Other errors (GitNotFound, SpawnError, etc.)
        }
    }

    /// Returns the number of uncommitted changes (staged + unstaged + untracked).
    ///
    /// Counts non-empty lines from `git status --porcelain`. Each line represents
    /// one changed file, so the count reflects individual file changes.
    pub async fn uncommitted_count(&self) -> Result<usize, GitError> {
        let output = self.run(&["status", "--porcelain"]).await?;
        Ok(output.lines().len())
    }

    /// Lists all worktrees by parsing `git worktree list --porcelain`.
    ///
    /// Porcelain format uses blank-line-separated stanzas with `worktree`, `HEAD`,
    /// `branch`, and `bare` fields. Detached worktrees will have `branch: None`.
    pub async fn worktree_list(&self) -> Result<Vec<WorktreeInfo>, GitError> {
        let output = self.run(&["worktree", "list", "--porcelain"]).await?;

        let mut worktrees = Vec::new();
        let mut current_path = String::new();
        let mut current_head = String::new();
        let mut current_branch: Option<String> = None;
        let mut current_bare = false;

        for line in output.lines() {
            if let Some(path) = line.strip_prefix("worktree ") {
                // Save previous entry if we have one
                if !current_path.is_empty() {
                    let is_main = worktrees.is_empty();
                    worktrees.push(WorktreeInfo {
                        path: current_path,
                        head: current_head,
                        branch: current_branch,
                        is_bare: current_bare,
                        is_main_worktree: is_main,
                    });
                }
                current_path = path.to_string();
                current_head = String::new();
                current_branch = None;
                current_bare = false;
            } else if let Some(head) = line.strip_prefix("HEAD ") {
                current_head = head.to_string();
            } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
                current_branch = Some(branch.to_string());
            } else if line == "bare" {
                current_bare = true;
            }
        }

        // Push last entry
        if !current_path.is_empty() {
            let is_main = worktrees.is_empty();
            worktrees.push(WorktreeInfo {
                path: current_path,
                head: current_head,
                branch: current_branch,
                is_bare: current_bare,
                is_main_worktree: is_main,
            });
        }

        Ok(worktrees)
    }

    /// Creates a new worktree at the given path, optionally on a new branch.
    ///
    /// If `new_branch` is provided, passes `-b <branch>` to create it.
    /// If `checkout_ref` is provided, the new worktree checks out that ref.
    /// After creation, reads back the HEAD and branch from the new worktree
    /// directory to return accurate metadata.
    pub async fn worktree_add(
        &self,
        path: &Path,
        new_branch: Option<&str>,
        checkout_ref: Option<&str>,
    ) -> Result<WorktreeInfo, GitError> {
        self.worktree_add_inner(path, new_branch, checkout_ref, false).await
    }

    pub async fn worktree_add_force(
        &self,
        path: &Path,
        checkout_ref: Option<&str>,
    ) -> Result<WorktreeInfo, GitError> {
        self.worktree_add_inner(path, None, checkout_ref, true).await
    }

    async fn worktree_add_inner(
        &self,
        path: &Path,
        new_branch: Option<&str>,
        checkout_ref: Option<&str>,
        force: bool,
    ) -> Result<WorktreeInfo, GitError> {
        let path_str = path.to_string_lossy();
        let mut args = vec!["worktree", "add"];

        if force {
            args.push("--force");
        }

        // Collect owned strings to extend their lifetime
        let branch_flag;
        if let Some(branch) = new_branch {
            branch_flag = branch.to_string();
            args.push("-b");
            args.push(&branch_flag);
        }

        args.push(&path_str);

        let checkout_ref_owned;
        if let Some(cr) = checkout_ref {
            checkout_ref_owned = cr.to_string();
            args.push(&checkout_ref_owned);
        }

        self.run(&args).await?;

        // Read back the created worktree info
        let head_output = self.run_in(path, &["rev-parse", "HEAD"]).await?;
        let branch_output = self.run_in(path, &["symbolic-ref", "--short", "HEAD"]).await;

        let branch = match branch_output {
            Ok(o) => Some(o.trimmed().to_string()),
            Err(GitError::CommandFailed { ref stderr, .. })
                if stderr.contains("not a symbolic reference") =>
            {
                None // Detached HEAD
            }
            Err(e) => {
                log::warn!("symbolic-ref in worktree {:?} failed unexpectedly: {e}", path);
                None
            }
        };

        Ok(WorktreeInfo {
            path: path.to_string_lossy().to_string(),
            head: head_output.trimmed().to_string(),
            branch,
            is_bare: false,
            is_main_worktree: false,
        })
    }

    /// Removes a worktree at the given path. Pass `force: true` to remove
    /// even if the worktree has uncommitted changes.
    pub async fn worktree_remove(&self, path: &Path, force: bool) -> Result<(), GitError> {
        let path_str = path.to_string_lossy().to_string();
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&path_str);
        self.run(&args).await?;
        Ok(())
    }

    /// Prunes stale worktree references whose directories no longer exist on disk.
    pub async fn worktree_prune(&self) -> Result<(), GitError> {
        self.run(&["worktree", "prune"]).await?;
        Ok(())
    }

    /// Returns up to `max_count` commits in topological order.
    ///
    /// Parses a pipe-delimited `git log` format with 7 fields. Lines with fewer
    /// than 7 fields are silently skipped (e.g., malformed or empty repos).
    /// When `all_branches` is true, includes commits from all refs (`--all`).
    pub async fn commit_log(
        &self,
        max_count: usize,
        all_branches: bool,
    ) -> Result<Vec<CommitInfo>, GitError> {
        let count_str = format!("-{}", max_count);
        let mut args = vec![
            "log",
            "--format=%H|%h|%P|%an|%ae|%at|%s",
            &count_str,
            "--topo-order",
        ];
        if all_branches {
            args.push("--all");
        }

        let output = self.run(&args).await?;

        let mut commits = Vec::new();
        for line in output.lines() {
            let parts: Vec<&str> = line.splitn(7, '|').collect();
            if parts.len() < 7 {
                continue;
            }

            let timestamp = parts[5].parse::<i64>().unwrap_or(0);
            let parent_hashes: Vec<String> = if parts[2].is_empty() {
                Vec::new()
            } else {
                parts[2].split(' ').map(|s| s.to_string()).collect()
            };

            commits.push(CommitInfo {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                parent_hashes,
                author_name: parts[3].to_string(),
                author_email: parts[4].to_string(),
                timestamp,
                summary: parts[6].to_string(),
            });
        }

        Ok(commits)
    }

    /// Checks out a branch by name.
    ///
    /// For local branches, uses `git checkout <name>`.
    /// For remote branches like `origin/feature`, creates a local tracking branch.
    pub async fn checkout_branch(&self, name: &str) -> Result<(), GitError> {
        // Check if this is a remote branch reference
        if name.contains('/') {
            // Try to extract the local branch name from remote ref (e.g., "origin/main" -> "main")
            if let Some(local_name) = name.split('/').last() {
                // First try checking out the local branch if it exists
                match self.run(&["checkout", local_name]).await {
                    Ok(_) => return Ok(()),
                    Err(GitError::CommandFailed { .. }) => {
                        // Local branch doesn't exist, create tracking branch
                        self.run(&["checkout", "-b", local_name, "--track", name])
                            .await?;
                        return Ok(());
                    }
                    Err(e) => return Err(e),
                }
            }
        }

        // Normal local branch checkout
        self.run(&["checkout", name]).await?;
        Ok(())
    }

    /// Creates a new branch, optionally from a specific starting point.
    ///
    /// If `start_point` is None, creates from HEAD.
    pub async fn create_branch(
        &self,
        name: &str,
        start_point: Option<&str>,
    ) -> Result<(), GitError> {
        let mut args = vec!["branch", name];
        if let Some(point) = start_point {
            args.push(point);
        }
        self.run(&args).await?;
        Ok(())
    }

    /// Returns the list of files changed in a specific commit.
    ///
    /// Parses `git show --name-status --format=` output.
    pub async fn commit_files(&self, hash: &str) -> Result<Vec<FileChange>, GitError> {
        let output = self
            .run(&["show", "--name-status", "--format=", hash])
            .await?;

        let mut files = Vec::new();
        for line in output.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.is_empty() {
                continue;
            }

            let status_char = parts[0].chars().next().unwrap_or('?');
            let (status, path, old_path) = match status_char {
                'A' => (FileChangeStatus::Added, parts.get(1).unwrap_or(&"").to_string(), None),
                'M' => (FileChangeStatus::Modified, parts.get(1).unwrap_or(&"").to_string(), None),
                'D' => (FileChangeStatus::Deleted, parts.get(1).unwrap_or(&"").to_string(), None),
                'R' => {
                    // Renamed: R100\told_path\tnew_path
                    let old = parts.get(1).map(|s| s.to_string());
                    let new = parts.get(2).unwrap_or(&"").to_string();
                    (FileChangeStatus::Renamed, new, old)
                }
                'C' => {
                    // Copied: C100\told_path\tnew_path
                    let old = parts.get(1).map(|s| s.to_string());
                    let new = parts.get(2).unwrap_or(&"").to_string();
                    (FileChangeStatus::Copied, new, old)
                }
                _ => (FileChangeStatus::Unknown, parts.get(1).unwrap_or(&"").to_string(), None),
            };

            if !path.is_empty() {
                files.push(FileChange {
                    path,
                    status,
                    old_path,
                });
            }
        }

        Ok(files)
    }

    /// Gets the git user config (name and email) for this repository.
    ///
    /// First checks local config, falls back to global if not set.
    pub async fn get_user_config(&self) -> Result<GitUserConfig, GitError> {
        let name = match self.run(&["config", "user.name"]).await {
            Ok(output) => Some(output.trimmed().to_string()),
            Err(GitError::CommandFailed { code: 1, .. }) => None, // Not set
            Err(e) => return Err(e),
        };

        let email = match self.run(&["config", "user.email"]).await {
            Ok(output) => Some(output.trimmed().to_string()),
            Err(GitError::CommandFailed { code: 1, .. }) => None, // Not set
            Err(e) => return Err(e),
        };

        Ok(GitUserConfig { name, email })
    }

    /// Sets the git user config (name and/or email).
    ///
    /// If `global` is true, sets the global config; otherwise, sets repository-local config.
    pub async fn set_user_config(
        &self,
        name: Option<&str>,
        email: Option<&str>,
        global: bool,
    ) -> Result<(), GitError> {
        let scope = if global { "--global" } else { "--local" };

        if let Some(n) = name {
            self.run(&["config", scope, "user.name", n]).await?;
        }

        if let Some(e) = email {
            self.run(&["config", scope, "user.email", e]).await?;
        }

        Ok(())
    }

    /// Lists all configured remotes with their URLs.
    pub async fn list_remotes(&self) -> Result<Vec<RemoteInfo>, GitError> {
        let output = self.run(&["remote", "-v"]).await?;

        let mut remotes: Vec<RemoteInfo> = Vec::new();
        let mut seen_names = std::collections::HashSet::new();

        for line in output.lines() {
            // Format: "origin\thttps://github.com/user/repo.git (fetch)"
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 2 {
                continue;
            }

            let name = parts[0].to_string();
            if seen_names.contains(&name) {
                continue; // Skip duplicate entries (fetch/push)
            }

            // Extract URL (remove the (fetch) or (push) suffix)
            let url_part = parts[1];
            let url = url_part
                .split_whitespace()
                .next()
                .unwrap_or(url_part)
                .to_string();

            seen_names.insert(name.clone());
            remotes.push(RemoteInfo { name, url });
        }

        Ok(remotes)
    }

    /// Adds a new remote with the given name and URL.
    pub async fn add_remote(&self, name: &str, url: &str) -> Result<(), GitError> {
        self.run(&["remote", "add", name, url]).await?;
        Ok(())
    }

    /// Removes a remote by name.
    pub async fn remove_remote(&self, name: &str) -> Result<(), GitError> {
        self.run(&["remote", "remove", name]).await?;
        Ok(())
    }

    /// Gets refs (branches and tags) pointing to a specific commit.
    ///
    /// Returns refs formatted as "refname" entries.
    pub async fn refs_for_commit(&self, hash: &str) -> Result<Vec<String>, GitError> {
        // Get branches pointing to this commit
        let output = self
            .run(&[
                "branch",
                "-a",
                "--points-at",
                hash,
                "--format=%(refname:short)",
            ])
            .await?;

        let mut refs: Vec<String> = output
            .lines()
            .iter()
            .filter(|l| !l.is_empty() && !l.contains("HEAD"))
            .map(|l| l.to_string())
            .collect();

        // Get tags pointing to this commit
        if let Ok(tag_output) = self
            .run(&["tag", "--points-at", hash])
            .await
        {
            for tag in tag_output.lines() {
                if !tag.is_empty() {
                    refs.push(format!("tag:{}", tag));
                }
            }
        }

        Ok(refs)
    }

    /// Tests connectivity to a remote by running `git ls-remote --heads`.
    ///
    /// Returns `true` if the remote is reachable, `false` otherwise.
    /// Uses a 15-second timeout (longer than SSH's own ConnectTimeout=5) so
    /// that SSH fails with a meaningful error before we kill the process.
    pub async fn test_remote(&self, remote_name: &str) -> Result<bool, GitError> {
        match tokio::time::timeout(
            std::time::Duration::from_secs(15),
            self.run(&["ls-remote", "--heads", remote_name]),
        )
        .await
        {
            Ok(Ok(_)) => Ok(true),
            Ok(Err(GitError::CommandFailed { ref stderr, .. })) => {
                log::warn!("test_remote('{remote_name}'): {stderr}");
                Ok(false)
            }
            Ok(Err(e)) => Err(e),
            Err(_) => {
                log::warn!("test_remote('{remote_name}'): timed out after 15s");
                Ok(false)
            }
        }
    }

    /// Fetches refs and objects from a specific remote.
    ///
    /// Uses `--prune` to remove stale remote-tracking branches that no longer
    /// exist on the remote. Allows up to 120 seconds for large repositories.
    pub async fn fetch(&self, remote_name: &str) -> Result<(), GitError> {
        self.run_with_timeout(
            &["fetch", "--prune", remote_name],
            std::time::Duration::from_secs(120),
        )
        .await?;
        Ok(())
    }

    /// Fetches refs and objects from all configured remotes.
    ///
    /// Uses `--all --prune` to update every remote and clean up stale
    /// remote-tracking branches. Allows up to 120 seconds.
    pub async fn fetch_all(&self) -> Result<(), GitError> {
        self.run_with_timeout(
            &["fetch", "--all", "--prune"],
            std::time::Duration::from_secs(120),
        )
        .await?;
        Ok(())
    }

    /// Updates the URL of an existing remote.
    pub async fn set_remote_url(&self, name: &str, url: &str) -> Result<(), GitError> {
        self.run(&["remote", "set-url", name, url]).await?;
        Ok(())
    }

    /// Gets the default branch name from git config (init.defaultBranch).
    ///
    /// First checks local config, then global. Returns None if not set.
    pub async fn get_default_branch(&self) -> Result<Option<String>, GitError> {
        // Try local first
        match self.run(&["config", "--local", "init.defaultBranch"]).await {
            Ok(output) => return Ok(Some(output.trimmed().to_string())),
            Err(GitError::CommandFailed { code: 1, .. }) => {} // Not set locally
            Err(e) => return Err(e),
        }

        // Fall back to global
        match self.run(&["config", "--global", "init.defaultBranch"]).await {
            Ok(output) => Ok(Some(output.trimmed().to_string())),
            Err(GitError::CommandFailed { code: 1, .. }) => Ok(None), // Not set
            Err(e) => Err(e),
        }
    }

    /// Sets the default branch name in git config (init.defaultBranch).
    ///
    /// If `global` is true, sets the global config; otherwise, sets repository-local config.
    pub async fn set_default_branch(&self, branch: &str, global: bool) -> Result<(), GitError> {
        let scope = if global { "--global" } else { "--local" };
        self.run(&["config", scope, "init.defaultBranch", branch]).await?;
        Ok(())
    }

    /// Detaches HEAD at the current commit.
    ///
    /// Used when we need to free up a branch for worktree creation
    /// but have no other branch to switch to.
    pub async fn detach_head(&self) -> Result<(), GitError> {
        self.run(&["checkout", "--detach"]).await?;
        Ok(())
    }

    /// Checks whether the repository path is a git worktree (not the main working tree).
    ///
    /// Compares `git rev-parse --git-dir` with `git rev-parse --git-common-dir`.
    /// In the main working tree these are equal (both `.git`); in a linked worktree
    /// `--git-dir` points to `.git/worktrees/<name>` while `--git-common-dir` points
    /// to the shared `.git` directory.
    pub async fn is_worktree(&self) -> Result<bool, GitError> {
        let git_dir = self.run(&["rev-parse", "--git-dir"]).await?;
        let common_dir = self.run(&["rev-parse", "--git-common-dir"]).await?;

        let git_dir = std::path::Path::new(git_dir.trimmed());
        let common_dir = std::path::Path::new(common_dir.trimmed());

        // Canonicalize both for reliable comparison (handles relative paths)
        let git_dir_canon = std::fs::canonicalize(git_dir).unwrap_or_else(|_| git_dir.to_path_buf());
        let common_dir_canon = std::fs::canonicalize(common_dir).unwrap_or_else(|_| common_dir.to_path_buf());

        Ok(git_dir_canon != common_dir_canon)
    }

    /// Returns `(ahead, behind)` for HEAD vs its configured upstream.
    ///
    /// `ahead` is commits on HEAD not on upstream; `behind` is the inverse.
    /// Returns `None` if the current branch has no configured upstream
    /// (detached HEAD, brand-new branch, etc.).
    pub async fn upstream_ahead_behind(&self) -> Result<Option<(usize, usize)>, GitError> {
        let result = self
            .run(&["rev-list", "--count", "--left-right", "HEAD...@{u}"])
            .await;
        match result {
            Ok(out) => {
                // Output format: "<ahead>\t<behind>"
                let trimmed = out.trimmed();
                let mut parts = trimmed.split_whitespace();
                let ahead: usize = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                let behind: usize = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                Ok(Some((ahead, behind)))
            }
            Err(GitError::CommandFailed { stderr, .. })
                if stderr.contains("no upstream")
                    || stderr.contains("does not have an upstream")
                    || stderr.contains("unknown revision")
                    || stderr.contains("ambiguous argument") =>
            {
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }

    /// Returns the upstream tracking branch name (e.g. `origin/main`), or
    /// `None` when the branch has no upstream configured.
    pub async fn upstream_name(&self) -> Result<Option<String>, GitError> {
        let result = self
            .run(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
            .await;
        match result {
            Ok(out) => {
                let name = out.trimmed().to_string();
                if name.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(name))
                }
            }
            Err(GitError::CommandFailed { stderr, .. })
                if stderr.contains("no upstream")
                    || stderr.contains("does not have an upstream")
                    || stderr.contains("unknown revision")
                    || stderr.contains("ambiguous argument") =>
            {
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }

    /// Lists commits reachable from HEAD but not from upstream. Empty when
    /// there is no upstream or the branch is fully pushed.
    pub async fn unpushed_commits(&self) -> Result<Vec<UnpushedCommit>, GitError> {
        // Bail early if no upstream so we don't degenerate into "all commits".
        if self.upstream_name().await?.is_none() {
            return Ok(Vec::new());
        }

        // Custom format: hash|short|timestamp|author|summary
        let out = self
            .run(&[
                "log",
                "@{u}..HEAD",
                "--pretty=format:%H|%h|%at|%an|%s",
            ])
            .await?;

        let mut commits = Vec::new();
        for line in out.stdout.lines() {
            if line.is_empty() {
                continue;
            }
            let mut parts = line.splitn(5, '|');
            let hash = parts.next().unwrap_or("").to_string();
            let short = parts.next().unwrap_or("").to_string();
            let ts = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let author = parts.next().unwrap_or("").to_string();
            let summary = parts.next().unwrap_or("").to_string();
            if hash.is_empty() {
                continue;
            }
            commits.push(UnpushedCommit {
                hash,
                short_hash: short,
                timestamp: ts,
                author,
                summary,
            });
        }
        Ok(commits)
    }

    /// Lists all stashes in the repo. Stashes are repository-global rather
    /// than worktree-scoped; the `branch` field is parsed from the stash
    /// message so callers can group them by the branch they were created on.
    pub async fn stash_list(&self) -> Result<Vec<StashEntry>, GitError> {
        // `git stash list` is silent (exit 0, empty stdout) when no stashes exist.
        let out = self
            .run(&["stash", "list", "--pretty=format:%gd|%s"])
            .await?;

        let mut entries = Vec::new();
        for line in out.stdout.lines() {
            if line.is_empty() {
                continue;
            }
            let mut parts = line.splitn(2, '|');
            let ref_name = parts.next().unwrap_or("").to_string();
            let message = parts.next().unwrap_or("").to_string();
            if ref_name.is_empty() {
                continue;
            }
            let branch = parse_stash_branch(&message);
            entries.push(StashEntry {
                ref_name,
                message,
                branch,
            });
        }
        Ok(entries)
    }

    /// Parses `git status --porcelain=v1 --untracked-files=all` into
    /// (staged, unstaged, untracked) lists.
    ///
    /// Each non-untracked line is `XY <path>` or `XY <orig> -> <new>`.
    /// `X` is the index status (staged), `Y` is the worktree status (unstaged).
    /// Untracked lines start with `??`.
    pub async fn working_tree_changes(
        &self,
    ) -> Result<(Vec<FileStatusEntry>, Vec<FileStatusEntry>, Vec<String>), GitError> {
        let out = self
            .run(&["status", "--porcelain=v1", "--untracked-files=all"])
            .await?;

        let mut staged = Vec::new();
        let mut unstaged = Vec::new();
        let mut untracked = Vec::new();

        for line in out.stdout.lines() {
            if line.len() < 3 {
                continue;
            }
            let bytes = line.as_bytes();
            let x = bytes[0] as char;
            let y = bytes[1] as char;
            let rest = &line[3..];

            if x == '?' && y == '?' {
                untracked.push(rest.to_string());
                continue;
            }

            // Split on " -> " for rename/copy entries.
            let (path, old_path) = if let Some(idx) = rest.find(" -> ") {
                let old = rest[..idx].to_string();
                let new = rest[idx + 4..].to_string();
                (new, Some(old))
            } else {
                (rest.to_string(), None)
            };

            if x != ' ' && x != '?' {
                staged.push(FileStatusEntry {
                    path: path.clone(),
                    status: classify_status(x),
                    old_path: old_path.clone(),
                });
            }
            if y != ' ' && y != '?' {
                unstaged.push(FileStatusEntry {
                    path,
                    status: classify_status(y),
                    old_path,
                });
            }
        }

        Ok((staged, unstaged, untracked))
    }

    /// Builds a [`WorktreeStatus`] for this repo path. Aggregates branch,
    /// upstream tracking, working-tree changes, unpushed commits, and stashes.
    pub async fn worktree_status(
        &self,
        path: String,
        is_main_worktree: bool,
    ) -> Result<WorktreeStatus, GitError> {
        let head = self
            .run(&["rev-parse", "HEAD"])
            .await
            .map(|o| o.trimmed().to_string())
            .unwrap_or_default();
        let branch = self.current_branch().await.ok();
        let upstream = self.upstream_name().await?;
        let (ahead, behind) = self.upstream_ahead_behind().await?.unwrap_or((0, 0));
        let (staged, unstaged, untracked) = self.working_tree_changes().await?;
        let unpushed_commits = self.unpushed_commits().await?;
        let all_stashes = self.stash_list().await?;
        let stashes = match &branch {
            Some(b) => all_stashes
                .into_iter()
                .filter(|s| s.branch.as_deref() == Some(b.as_str()))
                .collect(),
            None => Vec::new(),
        };

        Ok(WorktreeStatus {
            path,
            branch,
            head,
            is_main_worktree,
            upstream,
            ahead,
            behind,
            staged,
            unstaged,
            untracked,
            unpushed_commits,
            stashes,
        })
    }

    /// Aggregates [`worktree_status`] across every worktree returned by
    /// `git worktree list`. Worktrees that fail to inspect are skipped with a
    /// log warning so a single bad worktree does not poison the response.
    pub async fn all_worktrees_status(&self) -> Result<Vec<WorktreeStatus>, GitError> {
        let worktrees = self.worktree_list().await?;
        let mut result = Vec::with_capacity(worktrees.len());
        for wt in worktrees {
            let git = Git::new(&wt.path);
            match git
                .worktree_status(wt.path.clone(), wt.is_main_worktree)
                .await
            {
                Ok(status) => result.push(status),
                Err(e) => {
                    log::warn!("worktree_status failed for {}: {:?}", wt.path, e);
                }
            }
        }
        Ok(result)
    }
}

/// Maps a single porcelain v1 status character to a [`FileStatusKind`].
fn classify_status(ch: char) -> FileStatusKind {
    match ch {
        'A' => FileStatusKind::Added,
        'M' => FileStatusKind::Modified,
        'D' => FileStatusKind::Deleted,
        'R' => FileStatusKind::Renamed,
        'C' => FileStatusKind::Copied,
        'T' => FileStatusKind::TypeChanged,
        'U' => FileStatusKind::Unmerged,
        _ => FileStatusKind::Unknown,
    }
}

/// Extracts the source branch from a stash message of the form
/// `WIP on <branch>: ...` or `On <branch>: ...`. Returns `None` for any
/// other shape (custom messages, detached-HEAD stashes).
fn parse_stash_branch(message: &str) -> Option<String> {
    let rest = message
        .strip_prefix("WIP on ")
        .or_else(|| message.strip_prefix("On "))?;
    let end = rest.find(':')?;
    let branch = rest[..end].trim();
    if branch.is_empty() {
        None
    } else {
        Some(branch.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::runner::Git;
    use tempfile::tempdir;

    /// Helper: creates a temp git repo with an initial commit.
    async fn create_test_repo() -> (tempfile::TempDir, Git) {
        let dir = tempdir().unwrap();
        let path = dir.path().to_path_buf();
        let git = Git::new(&path);

        git.run(&["init"]).await.unwrap();
        git.run(&["config", "user.email", "test@test.com"])
            .await
            .unwrap();
        git.run(&["config", "user.name", "Test"]).await.unwrap();

        let file_path = path.join("README.md");
        tokio::fs::write(&file_path, "# Test").await.unwrap();
        git.run(&["add", "."]).await.unwrap();
        git.run(&["commit", "-m", "initial"]).await.unwrap();

        (dir, git)
    }

    #[tokio::test]
    async fn test_worktree_list_main_repo_only() {
        let (_dir, git) = create_test_repo().await;
        let worktrees = git.worktree_list().await.unwrap();

        assert_eq!(worktrees.len(), 1);
        assert!(worktrees[0].is_main_worktree);
    }

    #[tokio::test]
    async fn test_worktree_list_with_added_worktree() {
        let (dir, git) = create_test_repo().await;
        git.run(&["branch", "test-branch"]).await.unwrap();

        let wt_path = dir.path().join("wt-test");
        git.worktree_add(&wt_path, None, Some("test-branch"))
            .await
            .unwrap();

        let worktrees = git.worktree_list().await.unwrap();
        assert_eq!(worktrees.len(), 2);
        assert!(worktrees[0].is_main_worktree);
        assert!(!worktrees[1].is_main_worktree);

        // Cleanup
        git.worktree_remove(&wt_path, true).await.unwrap();
    }

    #[tokio::test]
    async fn test_worktree_list_main_has_correct_branch() {
        let (_dir, git) = create_test_repo().await;
        let current = git.current_branch().await.unwrap();
        let worktrees = git.worktree_list().await.unwrap();

        assert_eq!(worktrees[0].branch.as_deref(), Some(current.as_str()));
    }

    #[tokio::test]
    async fn test_worktree_list_detached_head() {
        let (_dir, git) = create_test_repo().await;
        git.detach_head().await.unwrap();

        let worktrees = git.worktree_list().await.unwrap();
        assert!(
            worktrees[0].branch.is_none(),
            "Detached HEAD should have no branch"
        );
        assert!(worktrees[0].is_main_worktree);
    }

    #[tokio::test]
    async fn test_worktree_list_multiple_worktrees() {
        let (dir, git) = create_test_repo().await;
        git.run(&["branch", "branch-a"]).await.unwrap();
        git.run(&["branch", "branch-b"]).await.unwrap();

        let wt_a = dir.path().join("wt-a");
        let wt_b = dir.path().join("wt-b");
        git.worktree_add(&wt_a, None, Some("branch-a"))
            .await
            .unwrap();
        git.worktree_add(&wt_b, None, Some("branch-b"))
            .await
            .unwrap();

        let worktrees = git.worktree_list().await.unwrap();
        assert_eq!(worktrees.len(), 3);

        // Only the first should be main
        let main_count = worktrees.iter().filter(|wt| wt.is_main_worktree).count();
        assert_eq!(main_count, 1);
        assert!(worktrees[0].is_main_worktree);

        // Cleanup
        git.worktree_remove(&wt_a, true).await.unwrap();
        git.worktree_remove(&wt_b, true).await.unwrap();
    }

    #[tokio::test]
    async fn test_worktree_add_existing_branch() {
        let (dir, git) = create_test_repo().await;
        git.run(&["branch", "wt-existing"]).await.unwrap();

        let wt_path = dir.path().join("wt-existing");
        let info = git
            .worktree_add(&wt_path, None, Some("wt-existing"))
            .await
            .unwrap();

        assert_eq!(info.branch.as_deref(), Some("wt-existing"));
        assert!(!info.is_main_worktree);
        assert!(!info.head.is_empty());

        // Cleanup
        git.worktree_remove(&wt_path, true).await.unwrap();
    }

    #[tokio::test]
    async fn test_worktree_add_new_branch() {
        let (dir, git) = create_test_repo().await;

        let wt_path = dir.path().join("wt-new");
        let info = git
            .worktree_add(&wt_path, Some("new-wt-branch"), None)
            .await
            .unwrap();

        assert_eq!(info.branch.as_deref(), Some("new-wt-branch"));
        assert!(!info.is_main_worktree);

        // Cleanup
        git.worktree_remove(&wt_path, true).await.unwrap();
    }

    #[tokio::test]
    async fn test_list_branches_local() {
        let (_dir, git) = create_test_repo().await;
        git.run(&["branch", "local-test"]).await.unwrap();

        let branches = git.list_branches().await.unwrap();
        let local_names: Vec<&str> = branches
            .iter()
            .filter(|b| !b.is_remote)
            .map(|b| b.name.as_str())
            .collect();

        assert!(local_names.contains(&"local-test"));
    }

    #[tokio::test]
    async fn test_create_branch_from_head() {
        let (_dir, git) = create_test_repo().await;
        git.create_branch("from-head", None).await.unwrap();

        let branches = git.list_branches().await.unwrap();
        assert!(branches.iter().any(|b| b.name == "from-head" && !b.is_remote));
    }

    #[tokio::test]
    async fn test_checkout_branch() {
        let (_dir, git) = create_test_repo().await;
        git.run(&["branch", "checkout-test"]).await.unwrap();

        git.checkout_branch("checkout-test").await.unwrap();
        let current = git.current_branch().await.unwrap();
        assert_eq!(current, "checkout-test");
    }

    #[tokio::test]
    async fn test_detach_head() {
        let (_dir, git) = create_test_repo().await;
        git.detach_head().await.unwrap();

        // After detach, symbolic-ref should fail; current_branch falls back to short hash
        let current = git.current_branch().await.unwrap();
        // The result should be a short hash (hex characters), not a branch name
        assert!(
            current.chars().all(|c| c.is_ascii_hexdigit()),
            "Detached HEAD should return a commit hash, got: {}",
            current
        );
    }

    // ── parse_stash_branch ───────────────────────────────────────────

    #[test]
    fn test_parse_stash_branch_wip_form() {
        assert_eq!(
            parse_stash_branch("WIP on main: 1c93923 some commit"),
            Some("main".to_string())
        );
    }

    #[test]
    fn test_parse_stash_branch_on_form() {
        // `git stash push -m "msg"` produces "On <branch>: msg"
        assert_eq!(
            parse_stash_branch("On feature/x: my custom message"),
            Some("feature/x".to_string())
        );
    }

    #[test]
    fn test_parse_stash_branch_unknown_shape() {
        assert_eq!(parse_stash_branch("just some message"), None);
        assert_eq!(parse_stash_branch(""), None);
    }

    // ── classify_status ──────────────────────────────────────────────

    #[test]
    fn test_classify_status_known_codes() {
        assert_eq!(classify_status('A'), FileStatusKind::Added);
        assert_eq!(classify_status('M'), FileStatusKind::Modified);
        assert_eq!(classify_status('D'), FileStatusKind::Deleted);
        assert_eq!(classify_status('R'), FileStatusKind::Renamed);
        assert_eq!(classify_status('C'), FileStatusKind::Copied);
        assert_eq!(classify_status('T'), FileStatusKind::TypeChanged);
        assert_eq!(classify_status('U'), FileStatusKind::Unmerged);
        assert_eq!(classify_status('?'), FileStatusKind::Unknown);
    }

    // ── working_tree_changes ─────────────────────────────────────────

    #[tokio::test]
    async fn test_working_tree_changes_clean_repo() {
        let (_dir, git) = create_test_repo().await;
        let (staged, unstaged, untracked) = git.working_tree_changes().await.unwrap();
        assert!(staged.is_empty());
        assert!(unstaged.is_empty());
        assert!(untracked.is_empty());
    }

    #[tokio::test]
    async fn test_working_tree_changes_mixed() {
        let (dir, git) = create_test_repo().await;
        let path = dir.path();

        // Staged new file
        tokio::fs::write(path.join("staged-new.txt"), "new")
            .await
            .unwrap();
        git.run(&["add", "staged-new.txt"]).await.unwrap();

        // Modified-and-staged then modified-again file
        tokio::fs::write(path.join("README.md"), "# Test 2")
            .await
            .unwrap();
        git.run(&["add", "README.md"]).await.unwrap();
        tokio::fs::write(path.join("README.md"), "# Test 3")
            .await
            .unwrap();

        // Untracked file
        tokio::fs::write(path.join("untracked.txt"), "junk")
            .await
            .unwrap();

        let (staged, unstaged, untracked) = git.working_tree_changes().await.unwrap();

        assert!(staged.iter().any(|f| f.path == "staged-new.txt"
            && f.status == FileStatusKind::Added));
        assert!(staged.iter().any(|f| f.path == "README.md"
            && f.status == FileStatusKind::Modified));
        assert!(unstaged.iter().any(|f| f.path == "README.md"
            && f.status == FileStatusKind::Modified));
        assert_eq!(untracked, vec!["untracked.txt".to_string()]);
    }

    // ── stash_list ───────────────────────────────────────────────────

    #[tokio::test]
    async fn test_stash_list_empty_when_no_stashes() {
        let (_dir, git) = create_test_repo().await;
        let stashes = git.stash_list().await.unwrap();
        assert!(stashes.is_empty());
    }

    #[tokio::test]
    async fn test_stash_list_records_branch() {
        let (dir, git) = create_test_repo().await;

        tokio::fs::write(dir.path().join("README.md"), "# changed")
            .await
            .unwrap();
        git.run(&["stash", "push", "-m", "saving"]).await.unwrap();

        let stashes = git.stash_list().await.unwrap();
        assert_eq!(stashes.len(), 1);
        assert!(stashes[0].ref_name.starts_with("stash@{"));
        assert!(stashes[0].branch.is_some());
    }

    // ── upstream + ahead/behind ──────────────────────────────────────

    #[tokio::test]
    async fn test_upstream_none_when_no_remote() {
        let (_dir, git) = create_test_repo().await;
        let upstream = git.upstream_name().await.unwrap();
        assert!(upstream.is_none());
        let ab = git.upstream_ahead_behind().await.unwrap();
        assert!(ab.is_none());
    }

    // ── unpushed_commits ─────────────────────────────────────────────

    #[tokio::test]
    async fn test_unpushed_commits_empty_without_upstream() {
        let (_dir, git) = create_test_repo().await;
        let commits = git.unpushed_commits().await.unwrap();
        assert!(commits.is_empty());
    }

    // ── worktree_status ──────────────────────────────────────────────

    #[tokio::test]
    async fn test_worktree_status_clean_main() {
        let (dir, git) = create_test_repo().await;
        let path = dir.path().to_string_lossy().to_string();
        let status = git.worktree_status(path.clone(), true).await.unwrap();

        assert!(status.is_main_worktree);
        assert!(status.staged.is_empty());
        assert!(status.unstaged.is_empty());
        assert!(status.untracked.is_empty());
        assert!(status.upstream.is_none());
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);
        assert!(status.unpushed_commits.is_empty());
        assert!(status.stashes.is_empty());
        assert_eq!(status.path, path);
    }

    #[tokio::test]
    async fn test_worktree_status_with_changes() {
        let (dir, git) = create_test_repo().await;
        tokio::fs::write(dir.path().join("new.txt"), "hi")
            .await
            .unwrap();

        let status = git
            .worktree_status(dir.path().to_string_lossy().to_string(), true)
            .await
            .unwrap();
        assert_eq!(status.untracked, vec!["new.txt".to_string()]);
    }

    #[tokio::test]
    async fn test_all_worktrees_status_covers_every_worktree() {
        let (dir, git) = create_test_repo().await;
        git.run(&["branch", "feature"]).await.unwrap();
        let wt = dir.path().join("wt-feature");
        git.worktree_add(&wt, None, Some("feature")).await.unwrap();

        let statuses = git.all_worktrees_status().await.unwrap();
        assert_eq!(statuses.len(), 2);
        assert!(statuses.iter().any(|s| s.is_main_worktree));
        assert!(statuses.iter().any(|s| !s.is_main_worktree));

        // Cleanup
        git.worktree_remove(&wt, true).await.unwrap();
    }
}
