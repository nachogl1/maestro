use crate::github::{
    AuthStatus, BranchPullRequest, CreatePullRequestOptions, DiscussionDetail, DiscussionInfo,
    GitHub, GitHubError, GitHubWatchdog, IssueDetail, IssueFilter, IssueInfo, IssueLinks,
    MergeMethod, PullRequestDetail, PullRequestFilter, PullRequestInfo, RepoAssignee,
    WatchedProject,
};

/// Checks if the user is authenticated with GitHub CLI.
#[tauri::command]
pub async fn github_auth_status(repo_path: String) -> Result<AuthStatus, GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.auth_status().await
}

/// Lists pull requests with optional filtering.
#[tauri::command]
pub async fn github_list_prs(
    repo_path: String,
    state: Option<String>,
    limit: Option<u32>,
    search: Option<String>,
) -> Result<Vec<PullRequestInfo>, GitHubError> {
    let gh = GitHub::new(&repo_path);
    let filter = PullRequestFilter {
        state,
        limit,
        search,
    };
    gh.list_pull_requests(filter).await
}

/// Gets detailed information about a specific pull request.
#[tauri::command]
pub async fn github_get_pr(
    repo_path: String,
    number: u64,
) -> Result<PullRequestDetail, GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.get_pull_request(number).await
}

/// Finds the pull request opened from `branch`, if there is one.
///
/// Returns `None` (not an error) when the branch has no PR — the common case
/// for the terminal headers that call this.
#[tauri::command]
pub async fn github_pr_for_branch(
    repo_path: String,
    branch: String,
) -> Result<Option<BranchPullRequest>, GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.pull_request_for_branch(&branch).await
}

/// Creates a new pull request.
#[tauri::command]
pub async fn github_create_pr(
    repo_path: String,
    title: String,
    body: String,
    base: String,
    head: String,
    draft: bool,
) -> Result<PullRequestInfo, GitHubError> {
    let gh = GitHub::new(&repo_path);
    let options = CreatePullRequestOptions {
        title,
        body,
        base,
        head,
        draft,
    };
    gh.create_pull_request(options).await
}

/// Merges a pull request.
#[tauri::command]
pub async fn github_merge_pr(
    repo_path: String,
    number: u64,
    method: MergeMethod,
    delete_branch: bool,
) -> Result<(), GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.merge_pull_request(number, method, delete_branch).await
}

/// Closes a pull request without merging.
#[tauri::command]
pub async fn github_close_pr(repo_path: String, number: u64) -> Result<(), GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.close_pull_request(number).await
}

/// Adds a comment to a pull request.
#[tauri::command]
pub async fn github_comment_pr(
    repo_path: String,
    number: u64,
    body: String,
) -> Result<(), GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.comment_pull_request(number, &body).await
}

/// Lists issues with optional filtering.
#[tauri::command]
pub async fn github_list_issues(
    repo_path: String,
    state: Option<String>,
    limit: Option<u32>,
    search: Option<String>,
) -> Result<Vec<IssueInfo>, GitHubError> {
    let gh = GitHub::new(&repo_path);
    let filter = IssueFilter {
        state,
        limit,
        search,
    };
    gh.list_issues(filter).await
}

/// Fetches parent/sub-issue/dependency links for the given issues.
#[tauri::command]
pub async fn github_issue_links(
    repo_path: String,
    numbers: Vec<u64>,
) -> Result<Vec<IssueLinks>, GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.list_issue_links(&numbers).await
}

/// Lists users assignable to issues in the repository.
#[tauri::command]
pub async fn github_list_assignees(repo_path: String) -> Result<Vec<RepoAssignee>, GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.list_assignees().await
}

/// Adds and/or removes assignees on an issue.
#[tauri::command]
pub async fn github_update_issue_assignees(
    repo_path: String,
    number: u64,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<(), GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.update_issue_assignees(number, &add, &remove).await
}

/// Lists discussions using the GraphQL API.
#[tauri::command]
pub async fn github_list_discussions(
    repo_path: String,
    limit: Option<u32>,
) -> Result<Vec<DiscussionInfo>, GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.list_discussions(limit.unwrap_or(25)).await
}

/// Gets detailed information about a specific issue.
#[tauri::command]
pub async fn github_get_issue(repo_path: String, number: u64) -> Result<IssueDetail, GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.get_issue(number).await
}

/// Adds a comment to an issue.
#[tauri::command]
pub async fn github_comment_issue(
    repo_path: String,
    number: u64,
    body: String,
) -> Result<(), GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.comment_issue(number, &body).await
}

/// Closes an issue.
#[tauri::command]
pub async fn github_close_issue(repo_path: String, number: u64) -> Result<(), GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.close_issue(number).await
}

/// Reopens a closed issue.
#[tauri::command]
pub async fn github_reopen_issue(repo_path: String, number: u64) -> Result<(), GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.reopen_issue(number).await
}

/// Gets detailed information about a specific discussion.
#[tauri::command]
pub async fn github_get_discussion(
    repo_path: String,
    number: u64,
) -> Result<DiscussionDetail, GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.get_discussion(number).await
}

/// Adds a comment to a discussion.
#[tauri::command]
pub async fn github_comment_discussion(
    repo_path: String,
    number: u64,
    body: String,
) -> Result<(), GitHubError> {
    let gh = GitHub::new(&repo_path);
    gh.comment_discussion(number, &body).await
}

/// Replaces the set of projects the background GitHub watchdog polls.
/// Called by the frontend whenever the open workspace tabs change; the
/// watchdog polls immediately when the set actually changed.
#[tauri::command]
pub fn github_watchdog_set_projects(
    state: tauri::State<'_, std::sync::Arc<GitHubWatchdog>>,
    projects: Vec<WatchedProject>,
) {
    state.set_projects(projects);
}

/// Write an exported issue map (a standalone HTML file) to `path`.
///
/// `path` comes from the OS save dialog the user just confirmed, so the
/// destination is their choice — but it must end in `.html` and its parent
/// directory must already exist, so a malformed path fails loudly instead of
/// scattering files. Writes atomically (temp file + rename).
#[tauri::command]
pub async fn export_issue_map(path: String, content: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);

    let extension = target
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("html") | Some("htm")) {
        return Err("Export must be a .html file".to_string());
    }

    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "Export path has no parent directory".to_string())?;
    if !parent.is_dir() {
        return Err(format!("Directory does not exist: {}", parent.display()));
    }

    crate::core::mcp_config_writer::atomic_write(target, &content).await
}

#[cfg(test)]
mod export_issue_map_tests {
    use super::export_issue_map;
    use tempfile::tempdir;

    #[tokio::test]
    async fn writes_the_html_to_the_chosen_path() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("issue-map.html");

        export_issue_map(
            path.to_string_lossy().into_owned(),
            "<!doctype html>".into(),
        )
        .await
        .expect("export should succeed");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "<!doctype html>");
    }

    #[tokio::test]
    async fn rejects_an_unexpected_extension() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("issue-map.exe");

        let err = export_issue_map(path.to_string_lossy().into_owned(), "x".into())
            .await
            .expect_err("an .exe export should be refused");

        assert!(err.contains(".html"), "unexpected error: {err}");
        assert!(!path.exists(), "nothing should be written");
    }

    #[tokio::test]
    async fn rejects_a_missing_directory() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nope").join("issue-map.html");

        let err = export_issue_map(path.to_string_lossy().into_owned(), "x".into())
            .await
            .expect_err("a missing directory should be refused");

        assert!(err.contains("does not exist"), "unexpected error: {err}");
    }
}
