use crate::github::{
    AuthStatus, BranchPullRequest, CreatePullRequestOptions, DiscussionDetail, DiscussionInfo,
    GitHub, GitHubError, GitHubWatchdog, IssueDetail, IssueFilter, IssueInfo, MergeMethod,
    PullRequestDetail, PullRequestFilter, PullRequestInfo, WatchedProject,
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
