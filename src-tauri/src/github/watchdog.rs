//! Background GitHub watchdog.
//!
//! Polls every configured project repository for open PRs requesting the
//! user's review and open issues assigned to the user, then emits one
//! [`WatchdogSnapshot`] to the frontend per poll cycle. The frontend keeps
//! the previous snapshot and derives "new item" transitions from it, so this
//! module deliberately does no diffing.
//!
//! `gh` calls take 1-3s each, so all calls in a cycle run strictly one after
//! another with a small pause between them. When `gh` is missing or
//! unauthenticated the cycle stops early and the snapshot carries that status
//! instead of per-project errors — the UI shows it once, nothing is spammed.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use super::error::GitHubError;
use super::ops::{IssueFilter, IssueInfo, PullRequestFilter, PullRequestInfo};
use super::runner::GitHub;

/// How often the watchdog polls. One constant so it is easy to change.
pub const POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Pause between consecutive `gh` invocations within one poll cycle, so a
/// many-project cycle doesn't fire a burst of subprocesses.
const STAGGER_DELAY: Duration = Duration::from_millis(750);

/// Per-list cap; the badge only needs counts and toasts only need new items.
const LIST_LIMIT: u32 = 50;

/// GitHub search-syntax filters (same syntax the git panel chips use).
pub const PR_SEARCH: &str = "review-requested:@me";
pub const ISSUE_SEARCH: &str = "assignee:@me";

/// Tauri event carrying a [`WatchdogSnapshot`] payload after every cycle.
pub const WATCHDOG_EVENT: &str = "github-watchdog-update";

/// One project registered by the frontend for watching.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedProject {
    /// Display name (workspace tab name); echoed back in results.
    pub name: String,
    /// Repository directory `gh` runs in.
    pub repo_path: String,
}

/// Global `gh` health, reported with every snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GhStatus {
    /// `gh` ran fine (individual repos may still have been skipped).
    Ok,
    /// The `gh` binary is not installed / not on PATH.
    GhMissing,
    /// `gh` is installed but not authenticated.
    NotAuthenticated,
}

/// Poll results for one watched project.
///
/// A failed list is NOT the same as an empty list: `review_requests_errored`
/// / `assigned_issues_errored` mark lists whose fetch failed (or was never
/// attempted) this cycle. The frontend keeps its previous data for flagged
/// lists, so a transient failure (laptop sleep/resume, network blip) neither
/// zeroes the badge nor re-toasts every still-open item on recovery.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectResult {
    pub name: String,
    pub repo_path: String,
    /// Open PRs where the user's review is requested.
    pub review_requests: Vec<PullRequestInfo>,
    /// Open issues assigned to the user.
    pub assigned_issues: Vec<IssueInfo>,
    /// `review_requests` could not be fetched this cycle; ignore its contents.
    pub review_requests_errored: bool,
    /// `assigned_issues` could not be fetched this cycle; ignore its contents.
    pub assigned_issues_errored: bool,
}

/// Full result of one poll cycle, emitted as the [`WATCHDOG_EVENT`] payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogSnapshot {
    pub status: GhStatus,
    pub projects: Vec<ProjectResult>,
    /// Unix epoch milliseconds of when the cycle finished.
    pub polled_at: u64,
}

/// Shared watchdog state: the watched project set plus a wake-up signal for
/// the poll loop. Managed as Tauri state; the frontend replaces the project
/// set via the `github_watchdog_set_projects` command whenever tabs change.
#[derive(Default)]
pub struct GitHubWatchdog {
    projects: Mutex<Vec<WatchedProject>>,
    changed: Notify,
}

impl GitHubWatchdog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the watched project set. Returns `true` (and wakes the poll
    /// loop for an immediate refresh) only when the set actually changed, so
    /// repeated syncs of an identical list don't trigger extra polls.
    pub fn set_projects(&self, projects: Vec<WatchedProject>) -> bool {
        let mut guard = self
            .projects
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *guard == projects {
            return false;
        }
        *guard = projects;
        drop(guard);
        self.changed.notify_one();
        true
    }

    fn projects_snapshot(&self) -> Vec<WatchedProject> {
        self.projects
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

/// Spawns the poll loop. Called once from app setup; runs for the app's
/// lifetime. With no projects registered the loop just sleeps until the
/// frontend syncs a non-empty set (which wakes it via [`Notify`]).
pub fn spawn_watchdog(watchdog: std::sync::Arc<GitHubWatchdog>, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let projects = watchdog.projects_snapshot();
            // Always emit, even for an empty set: closing the last project
            // must clear the badge, and a cycle that was already in flight
            // when the set emptied gets corrected by the notify-triggered
            // re-poll that lands right after it.
            let snapshot = poll_projects(&projects).await;
            if let Err(e) = app.emit(WATCHDOG_EVENT, &snapshot) {
                log::warn!("github watchdog: failed to emit snapshot: {e}");
            }
            // Sleep until the next interval OR an immediate wake from
            // set_projects (project list changed).
            tokio::select! {
                _ = tokio::time::sleep(POLL_INTERVAL) => {}
                _ = watchdog.changed.notified() => {}
            }
        }
    });
}

/// Runs one poll cycle: for each project, list matching PRs then issues.
/// All `gh` calls are serialized with [`STAGGER_DELAY`] between them.
///
/// Error policy (deliberately quiet — this runs unattended every 5 minutes):
/// - `GhNotFound` / `NotAuthenticated`: record the status and stop the
///   cycle. The current AND all un-polled projects are still reported —
///   flagged as errored — so the frontend never mistakes "not polled" for
///   "gone" (which would later re-toast everything as first-poll data).
/// - any other per-repo error (not a GitHub repo, network, rate limit):
///   flag that project's list(s) with a debug log and keep going.
async fn poll_projects(projects: &[WatchedProject]) -> WatchdogSnapshot {
    let mut status = GhStatus::Ok;
    let mut results: Vec<ProjectResult> = Vec::with_capacity(projects.len());
    let mut first_call = true;

    let mut remaining = projects.iter();
    while let Some(project) = remaining.next() {
        let gh = GitHub::new(&project.repo_path);
        let mut result = ProjectResult {
            name: project.name.clone(),
            repo_path: project.repo_path.clone(),
            review_requests: Vec::new(),
            assigned_issues: Vec::new(),
            review_requests_errored: false,
            assigned_issues_errored: false,
        };

        if !std::mem::take(&mut first_call) {
            tokio::time::sleep(STAGGER_DELAY).await;
        }
        match gh
            .list_pull_requests(PullRequestFilter {
                state: Some("open".to_string()),
                limit: Some(LIST_LIMIT),
                search: Some(PR_SEARCH.to_string()),
            })
            .await
        {
            Ok(prs) => result.review_requests = prs,
            Err(e) => {
                // Issues weren't attempted either — both lists are unknown.
                result.review_requests_errored = true;
                result.assigned_issues_errored = true;
                results.push(result);
                if let Some(fatal) = fatal_status(&e) {
                    status = fatal;
                    results.extend(remaining.map(errored_result));
                    break;
                }
                log::debug!(
                    "github watchdog: PR poll skipped for {}: {e}",
                    project.repo_path
                );
                continue;
            }
        }

        tokio::time::sleep(STAGGER_DELAY).await;
        match gh
            .list_issues(IssueFilter {
                state: Some("open".to_string()),
                limit: Some(LIST_LIMIT),
                search: Some(ISSUE_SEARCH.to_string()),
            })
            .await
        {
            Ok(issues) => result.assigned_issues = issues,
            Err(e) => {
                result.assigned_issues_errored = true;
                if let Some(fatal) = fatal_status(&e) {
                    status = fatal;
                    results.push(result);
                    results.extend(remaining.map(errored_result));
                    break;
                }
                log::debug!(
                    "github watchdog: issue poll skipped for {}: {e}",
                    project.repo_path
                );
            }
        }

        results.push(result);
    }

    WatchdogSnapshot {
        status,
        projects: results,
        polled_at: now_ms(),
    }
}

/// A result for a project whose lists could not be fetched this cycle.
fn errored_result(project: &WatchedProject) -> ProjectResult {
    ProjectResult {
        name: project.name.clone(),
        repo_path: project.repo_path.clone(),
        review_requests: Vec::new(),
        assigned_issues: Vec::new(),
        review_requests_errored: true,
        assigned_issues_errored: true,
    }
}

/// Maps errors that make the whole cycle pointless to a [`GhStatus`];
/// per-repo errors return `None` so the cycle can continue.
fn fatal_status(error: &GitHubError) -> Option<GhStatus> {
    match error {
        GitHubError::GhNotFound => Some(GhStatus::GhMissing),
        GitHubError::NotAuthenticated => Some(GhStatus::NotAuthenticated),
        _ => None,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, path: &str) -> WatchedProject {
        WatchedProject {
            name: name.to_string(),
            repo_path: path.to_string(),
        }
    }

    #[test]
    fn test_set_projects_reports_change() {
        let watchdog = GitHubWatchdog::new();
        assert!(watchdog.set_projects(vec![project("maestro", "C:/git/maestro")]));
        // Identical list again: no change, no wake-up.
        assert!(!watchdog.set_projects(vec![project("maestro", "C:/git/maestro")]));
        // Different list: change.
        assert!(watchdog.set_projects(vec![
            project("maestro", "C:/git/maestro"),
            project("other", "C:/git/other"),
        ]));
        assert_eq!(watchdog.projects_snapshot().len(), 2);
        // Emptying is a change too.
        assert!(watchdog.set_projects(vec![]));
        assert!(watchdog.projects_snapshot().is_empty());
    }

    #[test]
    fn test_watched_project_uses_camel_case() {
        // Pins the invoke-argument contract with the frontend.
        let parsed: WatchedProject =
            serde_json::from_str(r#"{"name":"maestro","repoPath":"C:/git/maestro"}"#).unwrap();
        assert_eq!(parsed.name, "maestro");
        assert_eq!(parsed.repo_path, "C:/git/maestro");
    }

    #[test]
    fn test_snapshot_serialization_contract() {
        // Pins the event-payload contract with the frontend store.
        let snapshot = WatchdogSnapshot {
            status: GhStatus::NotAuthenticated,
            projects: vec![ProjectResult {
                name: "maestro".to_string(),
                repo_path: "C:/git/maestro".to_string(),
                review_requests: vec![],
                assigned_issues: vec![],
                review_requests_errored: false,
                assigned_issues_errored: true,
            }],
            polled_at: 1234,
        };
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["status"], "not-authenticated");
        assert_eq!(json["polledAt"], 1234);
        assert_eq!(json["projects"][0]["repoPath"], "C:/git/maestro");
        assert!(json["projects"][0]["reviewRequests"].is_array());
        assert!(json["projects"][0]["assignedIssues"].is_array());
        assert_eq!(json["projects"][0]["reviewRequestsErrored"], false);
        assert_eq!(json["projects"][0]["assignedIssuesErrored"], true);

        let ok = serde_json::to_value(GhStatus::Ok).unwrap();
        assert_eq!(ok, "ok");
        let missing = serde_json::to_value(GhStatus::GhMissing).unwrap();
        assert_eq!(missing, "gh-missing");
    }

    /// A failing project must still appear in the snapshot, flagged as
    /// errored — never silently dropped and never reported as empty lists.
    /// Runs against a non-repo temp dir so every environment fails the same
    /// project: gh missing → GhMissing, unauthenticated → NotAuthenticated,
    /// authenticated → per-repo "not a git repository" error. In all three
    /// cases the contract is identical: the project is present with both
    /// lists flagged.
    #[tokio::test]
    async fn test_poll_projects_reports_failed_project_as_errored() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();

        let projects = vec![project("broken", dir.to_string_lossy().as_ref())];
        let snapshot = poll_projects(&projects).await;

        assert_eq!(snapshot.projects.len(), 1);
        let result = &snapshot.projects[0];
        assert_eq!(result.name, "broken");
        assert!(result.review_requests_errored);
        assert!(result.assigned_issues_errored);
        assert!(result.review_requests.is_empty());
        assert!(result.assigned_issues.is_empty());
    }

    #[tokio::test]
    async fn test_poll_projects_empty_set_yields_empty_snapshot() {
        // The loop always emits; an empty watch set must produce an empty
        // (badge-clearing) snapshot rather than being skipped.
        let snapshot = poll_projects(&[]).await;
        assert_eq!(snapshot.status, GhStatus::Ok);
        assert!(snapshot.projects.is_empty());
    }
}
