use serde::{Deserialize, Serialize};

use super::error::GitHubError;
use super::runner::GitHub;

/// Authentication status from `gh auth status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub username: Option<String>,
    pub scopes: Vec<String>,
}

/// Pull request information returned from `gh pr list`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestInfo {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: PrAuthor,
    pub created_at: String,
    pub updated_at: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub is_draft: bool,
    pub additions: u64,
    pub deletions: u64,
    pub url: String,
    #[serde(default)]
    pub labels: Vec<PrLabel>,
    #[serde(default)]
    pub merged_at: Option<String>,
    #[serde(default)]
    pub closed_at: Option<String>,
    #[serde(default)]
    pub review_decision: Option<String>,
    #[serde(default)]
    pub checks_summary: ChecksSummary,
}

/// Pull request author.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrAuthor {
    pub login: String,
}

/// Pull request label.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrLabel {
    pub name: String,
    pub color: String,
}

/// Compact summary of a PR's CI check runs, computed in Rust from
/// `statusCheckRollup` so the list payload doesn't have to carry every
/// individual check (that array can be large; the raw array is kept only on
/// [`PullRequestDetail`], for a later "show me the failing checks" view).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksSummary {
    pub success: u64,
    pub failure: u64,
    pub pending: u64,
    pub total: u64,
    /// `"success"` | `"failure"` | `"pending"` | `"none"` — failure beats
    /// pending beats success, `"none"` only when there are no checks at all.
    pub verdict: String,
}

impl Default for ChecksSummary {
    fn default() -> Self {
        Self {
            success: 0,
            failure: 0,
            pending: 0,
            total: 0,
            verdict: "none".to_string(),
        }
    }
}

/// One entry of `statusCheckRollup`. `gh` reports two different shapes here:
/// a CheckRun (`status` + `conclusion`, e.g. a GitHub Actions job) or a
/// StatusContext (`state`, e.g. a third-party CI posting the legacy Status
/// API). Both sets of fields are optional so one struct deserializes either
/// shape; [`classify_check`] resolves whichever is present.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckRollupEntry {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

/// The three buckets a check run collapses into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckOutcome {
    Success,
    Failure,
    Pending,
}

/// Classifies one `statusCheckRollup` entry per the `gh` state mapping:
/// SUCCESS/NEUTRAL/SKIPPED → success; FAILURE/ERROR/TIMED_OUT/CANCELLED/
/// ACTION_REQUIRED/STARTUP_FAILURE → failure; anything else (queued,
/// in-progress, pending, expected, …) → pending.
fn classify_check(entry: &CheckRollupEntry) -> CheckOutcome {
    if let Some(status) = entry.status.as_deref() {
        if !status.eq_ignore_ascii_case("COMPLETED") {
            return CheckOutcome::Pending;
        }
        return entry
            .conclusion
            .as_deref()
            .map(classify_state)
            .unwrap_or(CheckOutcome::Pending);
    }
    entry
        .state
        .as_deref()
        .map(classify_state)
        .unwrap_or(CheckOutcome::Pending)
}

fn classify_state(value: &str) -> CheckOutcome {
    match value.to_ascii_uppercase().as_str() {
        "SUCCESS" | "NEUTRAL" | "SKIPPED" => CheckOutcome::Success,
        "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => {
            CheckOutcome::Failure
        }
        _ => CheckOutcome::Pending,
    }
}

/// Folds a PR's `statusCheckRollup` entries into a [`ChecksSummary`].
fn summarize_checks(entries: &[CheckRollupEntry]) -> ChecksSummary {
    let mut success = 0u64;
    let mut failure = 0u64;
    let mut pending = 0u64;
    for entry in entries {
        match classify_check(entry) {
            CheckOutcome::Success => success += 1,
            CheckOutcome::Failure => failure += 1,
            CheckOutcome::Pending => pending += 1,
        }
    }
    let total = entries.len() as u64;
    let verdict = if total == 0 {
        "none"
    } else if failure > 0 {
        "failure"
    } else if pending > 0 {
        "pending"
    } else {
        "success"
    };
    ChecksSummary {
        success,
        failure,
        pending,
        total,
        verdict: verdict.to_string(),
    }
}

/// The little a terminal header needs to link a branch to its pull request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchPullRequest {
    pub number: u64,
    pub title: String,
    /// `OPEN`, `MERGED` or `CLOSED`, as `gh` reports it.
    pub state: String,
    pub is_draft: bool,
    pub url: String,
}

/// One row of the branch → PR lookup, as `gh pr list --json` returns it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchPrRow {
    number: u64,
    title: String,
    state: String,
    is_draft: bool,
    url: String,
    updated_at: String,
}

/// Picks the one pull request a branch should link to.
///
/// A long-lived branch can carry several (one merged, one reopened, …). Open
/// beats everything else because that is the PR the user is working in; among
/// PRs of equal standing the most recently updated wins. Timestamps are RFC
/// 3339 in UTC as `gh` reports them, so comparing the strings orders them
/// correctly without parsing dates.
fn pick_branch_pull_request(rows: Vec<BranchPrRow>) -> Option<BranchPullRequest> {
    rows.into_iter()
        .max_by(|a, b| {
            let open = |r: &BranchPrRow| r.state.eq_ignore_ascii_case("open");
            open(a)
                .cmp(&open(b))
                .then_with(|| a.updated_at.cmp(&b.updated_at))
        })
        .map(|row| BranchPullRequest {
            number: row.number,
            title: row.title,
            state: row.state,
            is_draft: row.is_draft,
            url: row.url,
        })
}

/// Args for [`GitHub::get_issue_state`] — pure so the `--repo` pin
/// composition is unit-testable without shelling out (review F1: without a
/// pin, `gh` resolves the repo from the cwd, which on a fork-with-upstream
/// checkout can be the wrong one).
fn issue_state_args<'a>(number: &'a str, repo_pin: Option<&'a str>) -> Vec<&'a str> {
    let mut args = vec!["issue", "view", number, "--json", "state"];
    if let Some(pin) = repo_pin {
        args.extend_from_slice(&["--repo", pin]);
    }
    args
}

/// Args for [`GitHub::get_pull_request_completion`] — same pin discipline as
/// [`issue_state_args`]; `closingIssuesReferences` carries the issues the PR
/// body links for auto-close (review F3).
fn pr_completion_args<'a>(number: &'a str, repo_pin: Option<&'a str>) -> Vec<&'a str> {
    let mut args = vec![
        "pr",
        "view",
        number,
        "--json",
        "state,closingIssuesReferences",
    ];
    if let Some(pin) = repo_pin {
        args.extend_from_slice(&["--repo", pin]);
    }
    args
}

/// Detailed pull request info including body and review info.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub author: PrAuthor,
    pub created_at: String,
    pub updated_at: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub is_draft: bool,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub url: String,
    #[serde(default)]
    pub labels: Vec<PrLabel>,
    #[serde(default)]
    pub merged_at: Option<String>,
    #[serde(default)]
    pub closed_at: Option<String>,
    #[serde(default)]
    pub mergeable: String,
    #[serde(default)]
    pub review_decision: Option<String>,
    /// Raw `statusCheckRollup` entries, kept as-is (unlike the list payload)
    /// so a future detail view can show individual failing check names.
    #[serde(default)]
    pub status_check_rollup: Vec<serde_json::Value>,
    #[serde(default)]
    pub checks_summary: ChecksSummary,
    #[serde(default)]
    pub comments: Vec<Comment>,
}

/// Issue information returned from `gh issue list`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueInfo {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: PrAuthor,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    #[serde(default)]
    pub labels: Vec<PrLabel>,
    #[serde(default)]
    pub closed_at: Option<String>,
}

/// Discussion information returned from GraphQL API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionInfo {
    pub number: u64,
    pub title: String,
    pub category: DiscussionCategory,
    pub author: PrAuthor,
    pub created_at: String,
    pub url: String,
    #[serde(default)]
    pub answer_chosen_at: Option<String>,
}

/// Discussion category.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscussionCategory {
    pub name: String,
    pub emoji: String,
}

/// A comment on an issue, PR, or discussion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: PrAuthor,
    pub body: String,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub reactions: CommentReactions,
    /// For discussions: indicates if this comment is the accepted answer.
    #[serde(default)]
    pub is_answer: bool,
}

/// Reactions on a comment.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentReactions {
    pub total_count: u64,
    #[serde(default)]
    pub thumbs_up: u64,
    #[serde(default)]
    pub thumbs_down: u64,
    #[serde(default)]
    pub laugh: u64,
    #[serde(default)]
    pub hooray: u64,
    #[serde(default)]
    pub confused: u64,
    #[serde(default)]
    pub heart: u64,
    #[serde(default)]
    pub rocket: u64,
    #[serde(default)]
    pub eyes: u64,
}

/// Detailed issue info including body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub author: PrAuthor,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    #[serde(default)]
    pub labels: Vec<PrLabel>,
    #[serde(default)]
    pub closed_at: Option<String>,
    #[serde(default)]
    pub comments: Vec<Comment>,
}

/// Detailed discussion info including body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub category: DiscussionCategory,
    pub author: PrAuthor,
    pub created_at: String,
    pub url: String,
    #[serde(default)]
    pub answer_chosen_at: Option<String>,
    #[serde(default)]
    pub comments: Vec<Comment>,
}

/// Filter options for listing pull requests.
#[derive(Debug, Clone, Default)]
pub struct PullRequestFilter {
    pub state: Option<String>, // "open", "closed", "merged", "all"
    pub limit: Option<u32>,
    pub search: Option<String>,
}

/// Filter options for listing issues.
#[derive(Debug, Clone, Default)]
pub struct IssueFilter {
    pub state: Option<String>, // "open", "closed", "all"
    pub limit: Option<u32>,
    pub search: Option<String>,
}

/// Merge method for pull requests.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    fn as_flag(&self) -> &'static str {
        match self {
            MergeMethod::Merge => "--merge",
            MergeMethod::Squash => "--squash",
            MergeMethod::Rebase => "--rebase",
        }
    }
}

/// Options for creating a pull request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePullRequestOptions {
    pub title: String,
    pub body: String,
    pub base: String,
    pub head: String,
    pub draft: bool,
}

/// GitHub operations using the `gh` CLI.
impl GitHub {
    /// Checks if the user is authenticated with GitHub.
    pub async fn auth_status(&self) -> Result<AuthStatus, GitHubError> {
        let result = self.run(&["auth", "status"]).await;

        match result {
            Ok(output) => {
                // Parse the output to extract username
                let stdout = output.stdout;
                let stderr = output.stderr;
                let combined = format!("{}\n{}", stdout, stderr);

                let username = combined
                    .lines()
                    .find(|line| line.contains("Logged in to"))
                    .and_then(|line| line.split("as ").nth(1))
                    .map(|s| s.trim().trim_end_matches([')', ' ']).to_string());

                Ok(AuthStatus {
                    logged_in: true,
                    username,
                    scopes: vec![],
                })
            }
            Err(GitHubError::NotAuthenticated) => Ok(AuthStatus {
                logged_in: false,
                username: None,
                scopes: vec![],
            }),
            Err(e) => Err(e),
        }
    }

    /// Lists pull requests with optional filtering.
    pub async fn list_pull_requests(
        &self,
        filter: PullRequestFilter,
    ) -> Result<Vec<PullRequestInfo>, GitHubError> {
        let mut args = vec![
            "pr", "list",
            "--json", "number,title,state,author,createdAt,updatedAt,headRefName,baseRefName,isDraft,additions,deletions,url,labels,mergedAt,closedAt,reviewDecision,statusCheckRollup",
        ];

        let state_arg;
        if let Some(ref state) = filter.state {
            state_arg = format!("--state={}", state);
            args.push(&state_arg);
        }

        let limit_arg;
        if let Some(limit) = filter.limit {
            limit_arg = format!("--limit={}", limit);
            args.push(&limit_arg);
        } else {
            args.push("--limit=50");
        }

        let search_arg;
        if let Some(ref search) = filter.search {
            search_arg = format!("--search={}", search);
            args.push(&search_arg);
        }

        // `statusCheckRollup` can be a large array of individual check runs;
        // summarize it into `checksSummary` here and drop the raw rollup so
        // the list payload stays small (the detail fetch keeps the raw form).
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PrListRow {
            number: u64,
            title: String,
            state: String,
            author: PrAuthor,
            created_at: String,
            updated_at: String,
            head_ref_name: String,
            base_ref_name: String,
            is_draft: bool,
            additions: u64,
            deletions: u64,
            url: String,
            #[serde(default)]
            labels: Vec<PrLabel>,
            #[serde(default)]
            merged_at: Option<String>,
            #[serde(default)]
            closed_at: Option<String>,
            #[serde(default)]
            review_decision: Option<String>,
            #[serde(default)]
            status_check_rollup: Vec<CheckRollupEntry>,
        }

        let rows: Vec<PrListRow> = self.run_json(&args).await?;
        Ok(rows
            .into_iter()
            .map(|row| PullRequestInfo {
                number: row.number,
                title: row.title,
                state: row.state,
                author: row.author,
                created_at: row.created_at,
                updated_at: row.updated_at,
                head_ref_name: row.head_ref_name,
                base_ref_name: row.base_ref_name,
                is_draft: row.is_draft,
                additions: row.additions,
                deletions: row.deletions,
                url: row.url,
                labels: row.labels,
                merged_at: row.merged_at,
                closed_at: row.closed_at,
                review_decision: row.review_decision,
                checks_summary: summarize_checks(&row.status_check_rollup),
            })
            .collect())
    }

    /// Finds the pull request opened from `branch`, if there is one.
    ///
    /// Powers the PR link in a terminal header, so it asks for the few fields a
    /// link needs and nothing else. `--state all` on purpose: a branch whose PR
    /// was merged or closed still deserves a link — that PR is where the work
    /// ended up. Open PRs win over closed ones, and among equals the most
    /// recently updated wins, because a long-lived branch can accumulate
    /// several.
    pub async fn pull_request_for_branch(
        &self,
        branch: &str,
    ) -> Result<Option<BranchPullRequest>, GitHubError> {
        let args = vec![
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "all",
            "--limit",
            "20",
            "--json",
            "number,title,state,isDraft,url,updatedAt",
        ];

        let rows: Vec<BranchPrRow> = self.run_json(&args).await?;
        Ok(pick_branch_pull_request(rows))
    }

    /// Gets detailed information about a specific pull request.
    pub async fn get_pull_request(&self, number: u64) -> Result<PullRequestDetail, GitHubError> {
        let number_str = number.to_string();
        let args = vec![
            "pr", "view", &number_str,
            "--json", "number,title,body,state,author,createdAt,updatedAt,headRefName,baseRefName,isDraft,additions,deletions,changedFiles,url,labels,mergedAt,closedAt,mergeable,reviewDecision,statusCheckRollup,comments",
        ];

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PrViewResponse {
            number: u64,
            title: String,
            body: String,
            state: String,
            author: PrAuthor,
            created_at: String,
            updated_at: String,
            head_ref_name: String,
            base_ref_name: String,
            is_draft: bool,
            additions: u64,
            deletions: u64,
            changed_files: u64,
            url: String,
            #[serde(default)]
            labels: Vec<PrLabel>,
            #[serde(default)]
            merged_at: Option<String>,
            #[serde(default)]
            closed_at: Option<String>,
            #[serde(default)]
            mergeable: String,
            #[serde(default)]
            review_decision: Option<String>,
            #[serde(default)]
            status_check_rollup: Vec<serde_json::Value>,
            #[serde(default)]
            comments: Vec<PrCommentRaw>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PrCommentRaw {
            id: String,
            author: PrAuthor,
            body: String,
            created_at: String,
            #[serde(default)]
            updated_at: Option<String>,
            #[serde(default)]
            reaction_groups: Vec<ReactionGroup>,
        }

        #[derive(Deserialize)]
        struct ReactionGroup {
            content: String,
            #[serde(default)]
            users: ReactionUsers,
        }

        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase")]
        struct ReactionUsers {
            total_count: u64,
        }

        let response: PrViewResponse = self.run_json(&args).await.map_err(|e| {
            if let GitHubError::CommandFailed { stderr, .. } = &e {
                if stderr.contains("Could not resolve") || stderr.contains("not found") {
                    return GitHubError::PullRequestNotFound { number };
                }
            }
            e
        })?;

        // Convert raw comments to Comment struct
        let comments: Vec<Comment> = response
            .comments
            .into_iter()
            .map(|c| {
                let mut reactions = CommentReactions::default();
                for rg in &c.reaction_groups {
                    let count = rg.users.total_count;
                    reactions.total_count += count;
                    match rg.content.as_str() {
                        "THUMBS_UP" => reactions.thumbs_up = count,
                        "THUMBS_DOWN" => reactions.thumbs_down = count,
                        "LAUGH" => reactions.laugh = count,
                        "HOORAY" => reactions.hooray = count,
                        "CONFUSED" => reactions.confused = count,
                        "HEART" => reactions.heart = count,
                        "ROCKET" => reactions.rocket = count,
                        "EYES" => reactions.eyes = count,
                        _ => {}
                    }
                }
                Comment {
                    id: c.id,
                    author: c.author,
                    body: c.body,
                    created_at: c.created_at,
                    updated_at: c.updated_at,
                    reactions,
                    is_answer: false,
                }
            })
            .collect();

        // Re-parse the raw rollup entries to compute the same summary the
        // list payload carries; the raw form is also kept on the detail for
        // a future "show me the failing checks" view.
        let checks_summary = {
            let entries: Vec<CheckRollupEntry> = response
                .status_check_rollup
                .iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect();
            summarize_checks(&entries)
        };

        Ok(PullRequestDetail {
            number: response.number,
            title: response.title,
            body: response.body,
            state: response.state,
            author: response.author,
            created_at: response.created_at,
            updated_at: response.updated_at,
            head_ref_name: response.head_ref_name,
            base_ref_name: response.base_ref_name,
            is_draft: response.is_draft,
            additions: response.additions,
            deletions: response.deletions,
            changed_files: response.changed_files,
            url: response.url,
            labels: response.labels,
            merged_at: response.merged_at,
            closed_at: response.closed_at,
            mergeable: response.mergeable,
            review_decision: response.review_decision,
            status_check_rollup: response.status_check_rollup,
            checks_summary,
            comments,
        })
    }

    /// State of one issue (`OPEN`/`CLOSED`), optionally pinned to a repo —
    /// the samurai completion verifier's probe (issue #96, review F1). The
    /// `--repo` pin bypasses cwd-based repo resolution, which on a
    /// fork-with-upstream checkout can answer for the WRONG repo.
    pub async fn get_issue_state(
        &self,
        number: u64,
        repo_pin: Option<&str>,
    ) -> Result<String, GitHubError> {
        let number_str = number.to_string();

        #[derive(Deserialize)]
        struct StateOnly {
            state: String,
        }

        let response: StateOnly = self
            .run_json(&issue_state_args(&number_str, repo_pin))
            .await?;
        Ok(response.state)
    }

    /// State of one pull request plus the numbers of the issues its body
    /// links for auto-close (`closingIssuesReferences`), optionally pinned
    /// to a repo — the samurai completion verifier's probe (issue #96,
    /// review F1/F3: an OPEN batch PR whose links cover the claimed issues
    /// is a verifiable completion state).
    pub async fn get_pull_request_completion(
        &self,
        number: u64,
        repo_pin: Option<&str>,
    ) -> Result<(String, Vec<u64>), GitHubError> {
        let number_str = number.to_string();

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PrCompletionResponse {
            state: String,
            #[serde(default)]
            closing_issues_references: Vec<ClosingIssueRef>,
        }

        #[derive(Deserialize)]
        struct ClosingIssueRef {
            number: u64,
        }

        let response: PrCompletionResponse = self
            .run_json(&pr_completion_args(&number_str, repo_pin))
            .await?;
        Ok((
            response.state,
            response
                .closing_issues_references
                .into_iter()
                .map(|r| r.number)
                .collect(),
        ))
    }

    /// Creates a new pull request.
    pub async fn create_pull_request(
        &self,
        options: CreatePullRequestOptions,
    ) -> Result<PullRequestInfo, GitHubError> {
        let mut args = vec![
            "pr",
            "create",
            "--title",
            &options.title,
            "--body",
            &options.body,
            "--base",
            &options.base,
            "--head",
            &options.head,
        ];

        if options.draft {
            args.push("--draft");
        }

        // Create the PR and get its number from the output URL
        let output = self.run(&args).await?;
        let url = output.trimmed();

        // Extract PR number from URL (e.g., https://github.com/owner/repo/pull/123)
        let number: u64 = url
            .split('/')
            .next_back()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| GitHubError::ParseError {
                message: format!("Could not parse PR number from URL: {}", url),
            })?;

        // Fetch the full PR info
        let detail = self.get_pull_request(number).await?;

        Ok(PullRequestInfo {
            number: detail.number,
            title: detail.title,
            state: detail.state,
            author: detail.author,
            created_at: detail.created_at,
            updated_at: detail.updated_at,
            head_ref_name: detail.head_ref_name,
            base_ref_name: detail.base_ref_name,
            is_draft: detail.is_draft,
            additions: detail.additions,
            deletions: detail.deletions,
            url: detail.url,
            labels: detail.labels,
            merged_at: detail.merged_at,
            closed_at: detail.closed_at,
            review_decision: detail.review_decision,
            checks_summary: detail.checks_summary,
        })
    }

    /// Merges a pull request.
    pub async fn merge_pull_request(
        &self,
        number: u64,
        method: MergeMethod,
        delete_branch: bool,
    ) -> Result<(), GitHubError> {
        let number_str = number.to_string();
        let mut args = vec!["pr", "merge", &number_str, method.as_flag()];

        if delete_branch {
            args.push("--delete-branch");
        }

        self.run(&args).await?;
        Ok(())
    }

    /// Closes a pull request without merging.
    pub async fn close_pull_request(&self, number: u64) -> Result<(), GitHubError> {
        let number_str = number.to_string();
        self.run(&["pr", "close", &number_str]).await?;
        Ok(())
    }

    /// Adds a comment to a pull request.
    pub async fn comment_pull_request(&self, number: u64, body: &str) -> Result<(), GitHubError> {
        let number_str = number.to_string();
        self.run(&["pr", "comment", &number_str, "--body", body])
            .await?;
        Ok(())
    }

    /// Lists issues with optional filtering.
    pub async fn list_issues(&self, filter: IssueFilter) -> Result<Vec<IssueInfo>, GitHubError> {
        let mut args = vec![
            "issue",
            "list",
            "--json",
            "number,title,state,author,createdAt,updatedAt,url,labels,closedAt",
        ];

        let state_arg;
        if let Some(ref state) = filter.state {
            state_arg = format!("--state={}", state);
            args.push(&state_arg);
        }

        let limit_arg;
        if let Some(limit) = filter.limit {
            limit_arg = format!("--limit={}", limit);
            args.push(&limit_arg);
        } else {
            args.push("--limit=50");
        }

        let search_arg;
        if let Some(ref search) = filter.search {
            search_arg = format!("--search={}", search);
            args.push(&search_arg);
        }

        self.run_json(&args).await
    }

    /// Gets detailed information about a specific issue.
    pub async fn get_issue(&self, number: u64) -> Result<IssueDetail, GitHubError> {
        let number_str = number.to_string();

        // First get the basic issue info with JSON
        let args = vec![
            "issue",
            "view",
            &number_str,
            "--json",
            "number,title,body,state,author,createdAt,updatedAt,url,labels,closedAt,comments",
        ];

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct IssueViewResponse {
            number: u64,
            title: String,
            body: String,
            state: String,
            author: PrAuthor,
            created_at: String,
            updated_at: String,
            url: String,
            #[serde(default)]
            labels: Vec<PrLabel>,
            #[serde(default)]
            closed_at: Option<String>,
            #[serde(default)]
            comments: Vec<IssueCommentRaw>,
        }

        // GitHub CLI returns comments with slightly different structure
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct IssueCommentRaw {
            id: String,
            author: PrAuthor,
            body: String,
            created_at: String,
            #[serde(default)]
            updated_at: Option<String>,
            #[serde(default)]
            reaction_groups: Vec<ReactionGroup>,
        }

        #[derive(Deserialize)]
        struct ReactionGroup {
            content: String,
            #[serde(default)]
            users: ReactionUsers,
        }

        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase")]
        struct ReactionUsers {
            total_count: u64,
        }

        let response: IssueViewResponse = self.run_json(&args).await.map_err(|e| {
            if let GitHubError::CommandFailed { stderr, .. } = &e {
                if stderr.contains("Could not resolve") || stderr.contains("not found") {
                    return GitHubError::IssueNotFound { number };
                }
            }
            e
        })?;

        // Convert raw comments to Comment struct
        let comments: Vec<Comment> = response
            .comments
            .into_iter()
            .map(|c| {
                let mut reactions = CommentReactions::default();
                for rg in &c.reaction_groups {
                    let count = rg.users.total_count;
                    reactions.total_count += count;
                    match rg.content.as_str() {
                        "THUMBS_UP" => reactions.thumbs_up = count,
                        "THUMBS_DOWN" => reactions.thumbs_down = count,
                        "LAUGH" => reactions.laugh = count,
                        "HOORAY" => reactions.hooray = count,
                        "CONFUSED" => reactions.confused = count,
                        "HEART" => reactions.heart = count,
                        "ROCKET" => reactions.rocket = count,
                        "EYES" => reactions.eyes = count,
                        _ => {}
                    }
                }
                Comment {
                    id: c.id,
                    author: c.author,
                    body: c.body,
                    created_at: c.created_at,
                    updated_at: c.updated_at,
                    reactions,
                    is_answer: false,
                }
            })
            .collect();

        Ok(IssueDetail {
            number: response.number,
            title: response.title,
            body: response.body,
            state: response.state,
            author: response.author,
            created_at: response.created_at,
            updated_at: response.updated_at,
            url: response.url,
            labels: response.labels,
            closed_at: response.closed_at,
            comments,
        })
    }

    /// Adds a comment to an issue.
    pub async fn comment_issue(&self, number: u64, body: &str) -> Result<(), GitHubError> {
        let number_str = number.to_string();
        self.run(&["issue", "comment", &number_str, "--body", body])
            .await?;
        Ok(())
    }

    /// Closes an issue.
    pub async fn close_issue(&self, number: u64) -> Result<(), GitHubError> {
        let number_str = number.to_string();
        self.run(&["issue", "close", &number_str]).await?;
        Ok(())
    }

    /// Reopens a closed issue.
    pub async fn reopen_issue(&self, number: u64) -> Result<(), GitHubError> {
        let number_str = number.to_string();
        self.run(&["issue", "reopen", &number_str]).await?;
        Ok(())
    }

    /// Lists discussions using the GraphQL API.
    pub async fn list_discussions(&self, limit: u32) -> Result<Vec<DiscussionInfo>, GitHubError> {
        // We need repo info first to fill in owner/name.
        let repo_output = self.run(&["repo", "view", "--json", "owner,name"]).await?;

        #[derive(Deserialize)]
        struct RepoInfo {
            owner: RepoOwner,
            name: String,
        }

        #[derive(Deserialize)]
        struct RepoOwner {
            login: String,
        }

        let repo_info: RepoInfo = serde_json::from_str(&repo_output.stdout)?;

        // Interpolate owner/name directly rather than via sequential
        // String::replace on shared placeholders: a login containing the literal
        // "REPO" would otherwise be partially rewritten by the second replace,
        // redirecting the query to a different repository. GitHub restricts
        // logins/repo names to [A-Za-z0-9._-], so they cannot break out of the
        // GraphQL string literal.
        let query = format!(
            r#"{{
                repository(owner: "{owner}", name: "{name}") {{
                    discussions(first: {limit}, orderBy: {{field: CREATED_AT, direction: DESC}}) {{
                        nodes {{
                            number
                            title
                            category {{
                                name
                                emoji
                            }}
                            author {{
                                login
                            }}
                            createdAt
                            url
                            answerChosenAt
                        }}
                    }}
                }}
            }}"#,
            owner = repo_info.owner.login,
            name = repo_info.name,
            limit = limit
        );

        let result = self.graphql(&query).await;

        match result {
            Ok(json) => {
                // Parse the nested response
                let discussions = json
                    .get("data")
                    .and_then(|d| d.get("repository"))
                    .and_then(|r| r.get("discussions"))
                    .and_then(|d| d.get("nodes"))
                    .ok_or_else(|| {
                        // Check if discussions are not enabled
                        if let Some(errors) = json.get("errors") {
                            if errors.to_string().contains("discussions") {
                                return GitHubError::DiscussionsNotEnabled;
                            }
                        }
                        GitHubError::ParseError {
                            message: "Could not parse discussions response".to_string(),
                        }
                    })?;

                let discussions: Vec<DiscussionInfo> = serde_json::from_value(discussions.clone())?;
                Ok(discussions)
            }
            Err(e) => {
                // Check if the error indicates discussions aren't enabled
                if let GitHubError::CommandFailed { stderr, .. } = &e {
                    if stderr.contains("Could not resolve") || stderr.contains("discussions") {
                        return Err(GitHubError::DiscussionsNotEnabled);
                    }
                }
                Err(e)
            }
        }
    }

    /// Gets detailed information about a specific discussion using GraphQL.
    pub async fn get_discussion(&self, number: u64) -> Result<DiscussionDetail, GitHubError> {
        // Get repo info first
        let repo_output = self.run(&["repo", "view", "--json", "owner,name"]).await?;

        #[derive(Deserialize)]
        struct RepoInfo {
            owner: RepoOwner,
            name: String,
        }

        #[derive(Deserialize)]
        struct RepoOwner {
            login: String,
        }

        let repo_info: RepoInfo = serde_json::from_str(&repo_output.stdout)?;

        let query = format!(
            r#"{{
                repository(owner: "{}", name: "{}") {{
                    discussion(number: {}) {{
                        number
                        title
                        body
                        category {{
                            name
                            emoji
                        }}
                        author {{
                            login
                        }}
                        createdAt
                        url
                        answerChosenAt
                        answer {{
                            id
                        }}
                        comments(first: 50) {{
                            nodes {{
                                id
                                author {{
                                    login
                                }}
                                body
                                createdAt
                                updatedAt
                                isAnswer
                                reactions {{
                                    totalCount
                                }}
                                reactionGroups {{
                                    content
                                    users {{
                                        totalCount
                                    }}
                                }}
                            }}
                        }}
                    }}
                }}
            }}"#,
            repo_info.owner.login, repo_info.name, number
        );

        let json = self.graphql(&query).await?;

        let discussion = json
            .get("data")
            .and_then(|d| d.get("repository"))
            .and_then(|r| r.get("discussion"))
            .ok_or_else(|| GitHubError::ParseError {
                message: format!("Discussion #{} not found", number),
            })?;

        // Parse the response
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct DiscussionResponse {
            number: u64,
            title: String,
            body: String,
            category: DiscussionCategory,
            author: PrAuthor,
            created_at: String,
            url: String,
            answer_chosen_at: Option<String>,
            comments: CommentsNodes,
        }

        #[derive(Deserialize)]
        struct CommentsNodes {
            nodes: Vec<DiscussionCommentRaw>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct DiscussionCommentRaw {
            id: String,
            author: PrAuthor,
            body: String,
            created_at: String,
            #[serde(default)]
            updated_at: Option<String>,
            #[serde(default)]
            is_answer: bool,
            #[serde(default)]
            reaction_groups: Vec<ReactionGroup>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ReactionGroup {
            content: String,
            #[serde(default)]
            users: ReactionUsers,
        }

        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase")]
        struct ReactionUsers {
            total_count: u64,
        }

        let response: DiscussionResponse = serde_json::from_value(discussion.clone())?;

        // Convert raw comments to Comment struct
        let comments: Vec<Comment> = response
            .comments
            .nodes
            .into_iter()
            .map(|c| {
                let mut reactions = CommentReactions::default();
                for rg in &c.reaction_groups {
                    let count = rg.users.total_count;
                    reactions.total_count += count;
                    match rg.content.as_str() {
                        "THUMBS_UP" => reactions.thumbs_up = count,
                        "THUMBS_DOWN" => reactions.thumbs_down = count,
                        "LAUGH" => reactions.laugh = count,
                        "HOORAY" => reactions.hooray = count,
                        "CONFUSED" => reactions.confused = count,
                        "HEART" => reactions.heart = count,
                        "ROCKET" => reactions.rocket = count,
                        "EYES" => reactions.eyes = count,
                        _ => {}
                    }
                }
                Comment {
                    id: c.id,
                    author: c.author,
                    body: c.body,
                    created_at: c.created_at,
                    updated_at: c.updated_at,
                    reactions,
                    is_answer: c.is_answer,
                }
            })
            .collect();

        Ok(DiscussionDetail {
            number: response.number,
            title: response.title,
            body: response.body,
            category: response.category,
            author: response.author,
            created_at: response.created_at,
            url: response.url,
            answer_chosen_at: response.answer_chosen_at,
            comments,
        })
    }

    /// Adds a comment to a discussion using GraphQL mutation.
    pub async fn comment_discussion(&self, number: u64, body: &str) -> Result<(), GitHubError> {
        // Get repo info first
        let repo_output = self.run(&["repo", "view", "--json", "owner,name"]).await?;

        #[derive(Deserialize)]
        struct RepoInfo {
            owner: RepoOwner,
            name: String,
        }

        #[derive(Deserialize)]
        struct RepoOwner {
            login: String,
        }

        let repo_info: RepoInfo = serde_json::from_str(&repo_output.stdout)?;

        // First, get the discussion ID (GraphQL node ID)
        let id_query = format!(
            r#"{{
                repository(owner: "{}", name: "{}") {{
                    discussion(number: {}) {{
                        id
                    }}
                }}
            }}"#,
            repo_info.owner.login, repo_info.name, number
        );

        let id_json = self.graphql(&id_query).await?;

        let discussion_id = id_json
            .get("data")
            .and_then(|d| d.get("repository"))
            .and_then(|r| r.get("discussion"))
            .and_then(|d| d.get("id"))
            .and_then(|id| id.as_str())
            .ok_or_else(|| GitHubError::ParseError {
                message: format!("Could not get discussion ID for #{}", number),
            })?;

        // Escape the body for GraphQL
        let escaped_body = body
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n");

        // Now add the comment using mutation
        let mutation = format!(
            r#"mutation {{
                addDiscussionComment(input: {{discussionId: "{}", body: "{}"}}) {{
                    comment {{
                        id
                    }}
                }}
            }}"#,
            discussion_id, escaped_body
        );

        self.graphql(&mutation).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_method_flag() {
        assert_eq!(MergeMethod::Merge.as_flag(), "--merge");
        assert_eq!(MergeMethod::Squash.as_flag(), "--squash");
        assert_eq!(MergeMethod::Rebase.as_flag(), "--rebase");
    }

    #[test]
    fn test_completion_probe_args_pin_the_repo_when_known() {
        // Review F1: with a stored pin, EVERY completion probe carries
        // `--repo` explicitly — cwd-based resolution on a fork-with-upstream
        // checkout can answer for the wrong repo.
        assert_eq!(
            issue_state_args("77", Some("nachogl1/maestro")),
            vec![
                "issue",
                "view",
                "77",
                "--json",
                "state",
                "--repo",
                "nachogl1/maestro"
            ]
        );
        assert_eq!(
            pr_completion_args("85", Some("nachogl1/maestro")),
            vec![
                "pr",
                "view",
                "85",
                "--json",
                "state,closingIssuesReferences",
                "--repo",
                "nachogl1/maestro"
            ]
        );
    }

    #[test]
    fn test_completion_probe_args_without_pin_keep_cwd_resolution() {
        // No pin stored (remote never parsed): the args carry no `--repo`
        // and gh resolves from the working directory — the caller logs it.
        assert_eq!(
            issue_state_args("77", None),
            vec!["issue", "view", "77", "--json", "state"]
        );
        assert_eq!(
            pr_completion_args("85", None),
            vec![
                "pr",
                "view",
                "85",
                "--json",
                "state,closingIssuesReferences"
            ]
        );
    }

    #[test]
    fn test_pr_filter_default() {
        let filter = PullRequestFilter::default();
        assert!(filter.state.is_none());
        assert!(filter.limit.is_none());
        assert!(filter.search.is_none());
    }

    #[test]
    fn test_issue_filter_default() {
        let filter = IssueFilter::default();
        assert!(filter.state.is_none());
        assert!(filter.limit.is_none());
        assert!(filter.search.is_none());
    }

    #[test]
    fn test_auth_status_serialization() {
        let status = AuthStatus {
            logged_in: true,
            username: Some("testuser".to_string()),
            scopes: vec!["repo".to_string(), "read:org".to_string()],
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("testuser"));
        assert!(json.contains("true"));
    }

    fn branch_row(number: u64, state: &str, updated_at: &str) -> BranchPrRow {
        BranchPrRow {
            number,
            title: format!("PR {}", number),
            state: state.to_string(),
            is_draft: false,
            url: format!("https://github.com/owner/repo/pull/{}", number),
            updated_at: updated_at.to_string(),
        }
    }

    #[test]
    fn pick_branch_pr_returns_none_when_the_branch_has_no_pr() {
        assert!(pick_branch_pull_request(vec![]).is_none());
    }

    #[test]
    fn pick_branch_pr_prefers_an_open_pr_over_a_newer_merged_one() {
        let picked = pick_branch_pull_request(vec![
            branch_row(1, "OPEN", "2026-08-01T00:00:00Z"),
            branch_row(2, "MERGED", "2026-08-07T00:00:00Z"),
        ])
        .expect("a PR should be picked");
        assert_eq!(picked.number, 1);
    }

    #[test]
    fn pick_branch_pr_falls_back_to_the_most_recently_updated() {
        let picked = pick_branch_pull_request(vec![
            branch_row(1, "CLOSED", "2026-08-01T00:00:00Z"),
            branch_row(2, "MERGED", "2026-08-07T00:00:00Z"),
        ])
        .expect("a PR should be picked");
        assert_eq!(picked.number, 2);
        assert_eq!(picked.state, "MERGED");
    }

    #[test]
    fn pick_branch_pr_deserializes_the_gh_row_shape() {
        let json = r#"[{
            "number": 42,
            "title": "Add the thing",
            "state": "OPEN",
            "isDraft": true,
            "url": "https://github.com/owner/repo/pull/42",
            "updatedAt": "2026-08-07T09:00:00Z"
        }]"#;

        let rows: Vec<BranchPrRow> = serde_json::from_str(json).unwrap();
        let picked = pick_branch_pull_request(rows).expect("a PR should be picked");
        assert_eq!(picked.number, 42);
        assert!(picked.is_draft);
        assert_eq!(picked.url, "https://github.com/owner/repo/pull/42");
    }

    #[test]
    fn test_pr_info_deserialization() {
        let json = r#"{
            "number": 123,
            "title": "Test PR",
            "state": "OPEN",
            "author": {"login": "testuser"},
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-02T00:00:00Z",
            "headRefName": "feature-branch",
            "baseRefName": "main",
            "isDraft": false,
            "additions": 10,
            "deletions": 5,
            "url": "https://github.com/owner/repo/pull/123",
            "labels": []
        }"#;

        let pr: PullRequestInfo = serde_json::from_str(json).unwrap();
        assert_eq!(pr.number, 123);
        assert_eq!(pr.title, "Test PR");
        assert_eq!(pr.author.login, "testuser");
        // reviewDecision/checksSummary absent from the payload (older gh, or
        // a repo with no CI/review data) fall back sanely.
        assert_eq!(pr.review_decision, None);
        assert_eq!(pr.checks_summary.total, 0);
        assert_eq!(pr.checks_summary.verdict, "none");
    }

    #[test]
    fn checks_summary_defaults_to_the_none_verdict() {
        let summary = ChecksSummary::default();
        assert_eq!(summary.total, 0);
        assert_eq!(summary.verdict, "none");
    }

    #[test]
    fn classify_check_reads_the_check_run_shape() {
        let completed_success: CheckRollupEntry =
            serde_json::from_str(r#"{"status": "COMPLETED", "conclusion": "SUCCESS"}"#).unwrap();
        assert_eq!(classify_check(&completed_success), CheckOutcome::Success);

        let completed_neutral: CheckRollupEntry =
            serde_json::from_str(r#"{"status": "COMPLETED", "conclusion": "NEUTRAL"}"#).unwrap();
        assert_eq!(classify_check(&completed_neutral), CheckOutcome::Success);

        let completed_failure: CheckRollupEntry =
            serde_json::from_str(r#"{"status": "COMPLETED", "conclusion": "FAILURE"}"#).unwrap();
        assert_eq!(classify_check(&completed_failure), CheckOutcome::Failure);

        let completed_cancelled: CheckRollupEntry =
            serde_json::from_str(r#"{"status": "COMPLETED", "conclusion": "CANCELLED"}"#).unwrap();
        assert_eq!(classify_check(&completed_cancelled), CheckOutcome::Failure);

        let in_progress: CheckRollupEntry =
            serde_json::from_str(r#"{"status": "IN_PROGRESS"}"#).unwrap();
        assert_eq!(classify_check(&in_progress), CheckOutcome::Pending);

        let queued: CheckRollupEntry = serde_json::from_str(r#"{"status": "QUEUED"}"#).unwrap();
        assert_eq!(classify_check(&queued), CheckOutcome::Pending);
    }

    #[test]
    fn classify_check_reads_the_status_context_shape() {
        let success: CheckRollupEntry = serde_json::from_str(r#"{"state": "SUCCESS"}"#).unwrap();
        assert_eq!(classify_check(&success), CheckOutcome::Success);

        let error: CheckRollupEntry = serde_json::from_str(r#"{"state": "ERROR"}"#).unwrap();
        assert_eq!(classify_check(&error), CheckOutcome::Failure);

        let pending: CheckRollupEntry = serde_json::from_str(r#"{"state": "PENDING"}"#).unwrap();
        assert_eq!(classify_check(&pending), CheckOutcome::Pending);
    }

    #[test]
    fn summarize_checks_verdict_prioritizes_failure_over_pending_over_success() {
        let all_success: Vec<CheckRollupEntry> = serde_json::from_str(
            r#"[{"status": "COMPLETED", "conclusion": "SUCCESS"}, {"state": "SUCCESS"}]"#,
        )
        .unwrap();
        let summary = summarize_checks(&all_success);
        assert_eq!(summary.total, 2);
        assert_eq!(summary.success, 2);
        assert_eq!(summary.verdict, "success");

        let mixed: Vec<CheckRollupEntry> = serde_json::from_str(
            r#"[{"status": "COMPLETED", "conclusion": "SUCCESS"}, {"status": "IN_PROGRESS"}]"#,
        )
        .unwrap();
        let summary = summarize_checks(&mixed);
        assert_eq!(summary.verdict, "pending");

        let with_failure: Vec<CheckRollupEntry> = serde_json::from_str(
            r#"[{"status": "COMPLETED", "conclusion": "FAILURE"}, {"status": "IN_PROGRESS"}, {"state": "SUCCESS"}]"#,
        )
        .unwrap();
        let summary = summarize_checks(&with_failure);
        assert_eq!(summary.failure, 1);
        assert_eq!(summary.pending, 1);
        assert_eq!(summary.success, 1);
        assert_eq!(summary.total, 3);
        assert_eq!(summary.verdict, "failure");
    }

    #[test]
    fn summarize_checks_verdict_is_none_when_there_are_no_checks() {
        let summary = summarize_checks(&[]);
        assert_eq!(summary.total, 0);
        assert_eq!(summary.verdict, "none");
    }

    #[test]
    fn test_pull_request_detail_deserializes_review_decision_and_defaults_checks() {
        // PullRequestDetail's own Deserialize impl (used directly only in
        // tests here; get_pull_request goes through the raw PrViewResponse)
        // still needs to accept the gh field names and default sanely when
        // check/review data is absent.
        let json = r#"{
            "number": 7,
            "title": "Add feature",
            "body": "",
            "state": "OPEN",
            "author": {"login": "testuser"},
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-02T00:00:00Z",
            "headRefName": "feature",
            "baseRefName": "main",
            "isDraft": false,
            "additions": 1,
            "deletions": 1,
            "changedFiles": 1,
            "url": "https://github.com/owner/repo/pull/7",
            "labels": [],
            "reviewDecision": "APPROVED"
        }"#;

        let detail: PullRequestDetail = serde_json::from_str(json).unwrap();
        assert_eq!(detail.review_decision, Some("APPROVED".to_string()));
        assert!(detail.status_check_rollup.is_empty());
        assert_eq!(detail.checks_summary.verdict, "none");
    }

    #[test]
    fn test_issue_info_deserialization() {
        let json = r#"{
            "number": 456,
            "title": "Test Issue",
            "state": "OPEN",
            "author": {"login": "testuser"},
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-02T00:00:00Z",
            "url": "https://github.com/owner/repo/issues/456",
            "labels": []
        }"#;

        let issue: IssueInfo = serde_json::from_str(json).unwrap();
        assert_eq!(issue.number, 456);
        assert_eq!(issue.title, "Test Issue");
    }
}
