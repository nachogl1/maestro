//! The Work Journal's activity collection: everything the user did in a time
//! window, across the given projects, as one-line [`ActivityItem`]s for the
//! candidate run (issue #313). PRD "Candidates" names the sources:
//!
//! - **Claude conversations** from the History listing, labelled with the AI
//!   name and two-sentence summary History already caches (the cache is only
//!   read; the summariser is never run here).
//! - **Git commits** made by the repo's configured user.
//! - **PRs and issues** through the GitHub CLI, skipped silently when `gh` is
//!   not signed in or a repo has no GitHub remote.
//! - **Terminal sessions** from the temporary activity file.
//!
//! The window is half-open, `[start, end)`, in UTC — the same rule as
//! [`list_terminal_records`]. Each item's `date` and `time` are when the
//! activity happened, in local time, so a catch-up window that crosses
//! midnight yields items on two dates.
//!
//! Every source is reached through [`ActivitySources`], so tests use fakes
//! and never touch git, `gh`, the network or app data. A failing source is
//! logged and skipped; the collection itself never fails.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Local, Utc};

use crate::commands::claude_sessions::{list_claude_sessions, ClaudeSessionInfo};
use crate::commands::git::{git_commit_log, git_user_config};
use crate::commands::github::{github_auth_status, github_list_issues, github_list_prs};
use crate::commands::session_summary::{cached_session_summaries, SessionSummary};
use crate::core::work_journal_activity::{
    activity_dir, list_terminal_records, project_name_from_path, CandidateSource, TerminalRecord,
};
use crate::git::{CommitInfo, GitUserConfig};
use crate::github::{IssueInfo, PullRequestInfo};

/// Commits read per project (newest first, all branches). Far more than one
/// person makes in a catch-up window.
const MAX_COMMITS_PER_PROJECT: usize = 1000;

/// PRs or issues read per `gh` query.
const GITHUB_LIST_LIMIT: u32 = 100;

/// The two `gh` searches run per project for PRs and for issues. The bool
/// says whether the user authored what the query returns. GitHub search has
/// no "merged by" or "closed by" qualifier, so a PR or issue the user merged
/// or closed is found through being its author or assignee.
const GITHUB_QUERIES: [(&str, bool); 2] = [("author:@me", true), ("assignee:@me", false)];

/// One thing the user did, ready for the candidate run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityItem {
    /// Which source it came from (its source tag).
    pub source: CandidateSource,
    /// Local date it happened, `YYYY-MM-DD`.
    pub date: String,
    /// Local time it happened, `HH:MM`.
    pub time: String,
    /// One line describing it.
    pub text: String,
    /// Project name (last component of the project path).
    pub project: String,
}

/// Where the collection reads each source from. The app uses
/// [`LiveSources`]; tests pass fakes.
trait ActivitySources {
    async fn claude_sessions(&self, project: &str) -> Result<Vec<ClaudeSessionInfo>, String>;
    async fn session_summaries(&self) -> HashMap<String, SessionSummary>;
    async fn git_user(&self, project: &str) -> Result<GitUserConfig, String>;
    async fn git_commits(&self, project: &str) -> Result<Vec<CommitInfo>, String>;
    async fn github_signed_in(&self, project: &str) -> Result<bool, String>;
    async fn github_prs(&self, project: &str, search: &str)
        -> Result<Vec<PullRequestInfo>, String>;
    async fn github_issues(&self, project: &str, search: &str) -> Result<Vec<IssueInfo>, String>;
    async fn terminal_records(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<TerminalRecord>, String>;
}

/// The real sources: the existing History, git and GitHub commands, and the
/// activity file.
struct LiveSources;

impl ActivitySources for LiveSources {
    async fn claude_sessions(&self, project: &str) -> Result<Vec<ClaudeSessionInfo>, String> {
        // The History listing returns at most 50 sessions per project (the
        // most recently active ones). A window near "now" is covered unless
        // more than 50 conversations in one project were active since it
        // began; older windows can lose sessions (PRD "Known risks").
        list_claude_sessions(project.to_string(), None)
            .await
            .map(|listing| listing.sessions)
    }

    async fn session_summaries(&self) -> HashMap<String, SessionSummary> {
        tokio::task::spawn_blocking(cached_session_summaries)
            .await
            .unwrap_or_else(|e| {
                log::warn!("Work journal: reading the session summary cache failed: {e}");
                HashMap::new()
            })
    }

    async fn git_user(&self, project: &str) -> Result<GitUserConfig, String> {
        git_user_config(project.to_string())
            .await
            .map_err(|e| e.to_string())
    }

    async fn git_commits(&self, project: &str) -> Result<Vec<CommitInfo>, String> {
        git_commit_log(project.to_string(), MAX_COMMITS_PER_PROJECT, true)
            .await
            .map_err(|e| e.to_string())
    }

    async fn github_signed_in(&self, project: &str) -> Result<bool, String> {
        github_auth_status(project.to_string())
            .await
            .map(|status| status.logged_in)
            .map_err(|e| e.to_string())
    }

    async fn github_prs(
        &self,
        project: &str,
        search: &str,
    ) -> Result<Vec<PullRequestInfo>, String> {
        let state = Some("all".to_string());
        github_list_prs(
            project.to_string(),
            state,
            Some(GITHUB_LIST_LIMIT),
            Some(search.to_string()),
        )
        .await
        .map_err(|e| e.to_string())
    }

    async fn github_issues(&self, project: &str, search: &str) -> Result<Vec<IssueInfo>, String> {
        let state = Some("all".to_string());
        github_list_issues(
            project.to_string(),
            state,
            Some(GITHUB_LIST_LIMIT),
            Some(search.to_string()),
        )
        .await
        .map_err(|e| e.to_string())
    }

    async fn terminal_records(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<TerminalRecord>, String> {
        list_terminal_records(&activity_dir(), start, end)
            .await
            .map_err(|e| e.to_string())
    }
}

/// One collected item plus what it is sorted and de-duplicated by.
struct Found {
    at: DateTime<Utc>,
    /// Identity across projects: two paths of one repo (a worktree, a nested
    /// folder) report the same commit, PR or conversation.
    key: String,
    item: ActivityItem,
}

/// Everything the user did in `[start, end)` (UTC) across `projects` (their
/// paths), sorted by when it happened. Terminal sessions are global, so they
/// are listed whatever the projects. Never fails: a source that errors is
/// logged and left out.
#[allow(dead_code)] // first used by issue #313 (scheduled candidate run)
pub async fn collect_activity(
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    projects: &[String],
) -> Vec<ActivityItem> {
    collect_with(&LiveSources, start, end, projects).await
}

async fn collect_with<S: ActivitySources>(
    sources: &S,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    projects: &[String],
) -> Vec<ActivityItem> {
    if start >= end {
        return Vec::new();
    }
    let mut found: Vec<Found> = Vec::new();

    if !projects.is_empty() {
        let summaries = sources.session_summaries().await;
        // `gh` sign-in is per user, not per repo: ask once.
        let signed_in = match sources.github_signed_in(&projects[0]).await {
            Ok(signed_in) => signed_in,
            Err(e) => {
                log::debug!("Work journal: gh sign-in check failed, skipping GitHub: {e}");
                false
            }
        };
        if !signed_in {
            log::debug!("Work journal: gh is not signed in, skipping GitHub");
        }
        for project in projects {
            let name = project_name_from_path(project);
            let (claude, git, github) = tokio::join!(
                claude_items(sources, project, &name, &summaries, start, end),
                git_items(sources, project, &name, start, end),
                async {
                    if signed_in {
                        github_items(sources, project, &name, start, end).await
                    } else {
                        Vec::new()
                    }
                },
            );
            found.extend(claude);
            found.extend(git);
            found.extend(github);
        }
    }

    match sources.terminal_records(start, end).await {
        Ok(records) => found.extend(records.iter().filter_map(|r| terminal_item(r, start))),
        Err(e) => log::warn!("Work journal: reading terminal records failed: {e}"),
    }

    let mut seen = HashSet::new();
    found.retain(|f| seen.insert((format!("{:?}", f.item.source), f.key.clone())));
    found.sort_by_key(|f| f.at);
    found.into_iter().map(|f| f.item).collect()
}

/// Whether `at` is inside the half-open window `[start, end)`.
fn in_window(at: DateTime<Utc>, start: DateTime<Utc>, end: DateTime<Utc>) -> bool {
    start <= at && at < end
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// Local `HH:MM`.
fn clock(at: DateTime<Utc>) -> String {
    at.with_timezone(&Local).format("%H:%M").to_string()
}

/// Text folded to one line.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn item_at(
    source: CandidateSource,
    at: DateTime<Utc>,
    key: String,
    text: String,
    project: &str,
) -> Found {
    let local = at.with_timezone(&Local);
    Found {
        at,
        key,
        item: ActivityItem {
            source,
            date: local.format("%Y-%m-%d").to_string(),
            time: local.format("%H:%M").to_string(),
            text,
            project: project.to_string(),
        },
    }
}

/// Claude conversations that started or were last active in the window,
/// timed by their start when it is inside, else by their last activity.
async fn claude_items<S: ActivitySources>(
    sources: &S,
    project: &str,
    name: &str,
    summaries: &HashMap<String, SessionSummary>,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Vec<Found> {
    let sessions = match sources.claude_sessions(project).await {
        Ok(sessions) => sessions,
        Err(e) => {
            log::warn!("Work journal: listing Claude sessions for {name} failed: {e}");
            return Vec::new();
        }
    };
    sessions
        .iter()
        .filter_map(|session| {
            let started = parse_time(&session.started_at).filter(|t| in_window(*t, start, end));
            let last = parse_time(&session.last_active).filter(|t| in_window(*t, start, end));
            let at = started.or(last)?;
            let text = claude_text(session, summaries.get(&session.session_id));
            Some(item_at(
                CandidateSource::Claude,
                at,
                session.session_id.clone(),
                text,
                name,
            ))
        })
        .collect()
}

/// The cached AI name and summary when there is one; otherwise the session's
/// own title or a prompt.
fn claude_text(session: &ClaudeSessionInfo, summary: Option<&SessionSummary>) -> String {
    if let Some(summary) = summary {
        return one_line(&format!("{}: {}", summary.name, summary.summary));
    }
    let label = [
        &session.title,
        &session.summary,
        &session.agent_name,
        &session.first_prompt,
        &session.last_prompt,
    ]
    .into_iter()
    .flatten()
    .map(|text| one_line(text))
    .find(|text| !text.is_empty());
    match label {
        Some(label) => format!("Claude conversation: {label}"),
        None => "Claude conversation".to_string(),
    }
}

/// Commits in the window by the repo's configured user (`user.email` or
/// `user.name`). No configured user means no commits can be called the
/// user's, so none are listed.
async fn git_items<S: ActivitySources>(
    sources: &S,
    project: &str,
    name: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Vec<Found> {
    let user = match sources.git_user(project).await {
        Ok(user) => user,
        Err(e) => {
            log::debug!("Work journal: no git user for {name}, skipping commits: {e}");
            return Vec::new();
        }
    };
    let email = user
        .email
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty());
    let user_name = user
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    if email.is_none() && user_name.is_none() {
        log::debug!("Work journal: {name} has no git user configured, skipping commits");
        return Vec::new();
    }
    let commits = match sources.git_commits(project).await {
        Ok(commits) => commits,
        Err(e) => {
            log::debug!("Work journal: reading commits for {name} failed: {e}");
            return Vec::new();
        }
    };
    commits
        .iter()
        .filter(|c| {
            email.is_some_and(|e| c.author_email.trim().eq_ignore_ascii_case(e))
                || user_name.is_some_and(|n| c.author_name.trim() == n)
        })
        .filter_map(|c| {
            let at = DateTime::from_timestamp(c.timestamp, 0)?;
            in_window(at, start, end).then(|| {
                item_at(
                    CandidateSource::Git,
                    at,
                    c.hash.clone(),
                    one_line(&c.summary),
                    name,
                )
            })
        })
        .collect()
}

/// What happened to a PR or issue inside the window, as (time, verb) pairs:
/// opened (only when the user authored it), merged or closed, and "updated"
/// when nothing else falls in the window.
fn github_events(
    authored: bool,
    created_at: &str,
    updated_at: &str,
    merged_at: Option<&str>,
    closed_at: Option<&str>,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Vec<(DateTime<Utc>, &'static str)> {
    let inside = |value: Option<&str>| {
        value
            .and_then(parse_time)
            .filter(|t| in_window(*t, start, end))
    };
    let mut events = Vec::new();
    if authored {
        if let Some(at) = inside(Some(created_at)) {
            events.push((at, "Opened"));
        }
    }
    if let Some(at) = inside(merged_at) {
        events.push((at, "Merged"));
    } else if let Some(at) = inside(closed_at) {
        events.push((at, "Closed"));
    }
    if events.is_empty() {
        if let Some(at) = inside(Some(updated_at)) {
            events.push((at, "Updated"));
        }
    }
    events
}

/// PRs and issues the user authored or is assigned to, with an event in the
/// window. A repo with no GitHub remote (or any `gh` failure) yields none.
async fn github_items<S: ActivitySources>(
    sources: &S,
    project: &str,
    name: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Vec<Found> {
    // Search dates are whole days; a day of slack covers any time zone, and
    // the window check below does the exact filtering.
    let since = (start - Duration::days(1)).format("%Y-%m-%d");
    let mut prs: HashMap<u64, (PullRequestInfo, bool)> = HashMap::new();
    let mut issues: HashMap<u64, (IssueInfo, bool)> = HashMap::new();
    for (qualifier, authored) in GITHUB_QUERIES {
        let search = format!("{qualifier} updated:>={since}");
        match sources.github_prs(project, &search).await {
            Ok(list) => {
                for pr in list {
                    let entry = prs.entry(pr.number).or_insert((pr, false));
                    entry.1 |= authored;
                }
            }
            Err(e) => {
                // Usually "no GitHub remote": the issue queries would fail
                // the same way, so stop here.
                log::debug!("Work journal: gh pr list for {name} failed, skipping GitHub: {e}");
                return Vec::new();
            }
        }
        match sources.github_issues(project, &search).await {
            Ok(list) => {
                for issue in list {
                    let entry = issues.entry(issue.number).or_insert((issue, false));
                    entry.1 |= authored;
                }
            }
            Err(e) => log::debug!("Work journal: gh issue list for {name} failed: {e}"),
        }
    }

    let mut out = Vec::new();
    for (pr, authored) in prs.values() {
        let events = github_events(
            *authored,
            &pr.created_at,
            &pr.updated_at,
            pr.merged_at.as_deref(),
            pr.closed_at.as_deref(),
            start,
            end,
        );
        for (at, verb) in events {
            let text = format!("{verb} PR #{}: {}", pr.number, one_line(&pr.title));
            out.push(item_at(
                CandidateSource::Github,
                at,
                format!("{} {verb}", pr.url),
                text,
                name,
            ));
        }
    }
    for (issue, authored) in issues.values() {
        let events = github_events(
            *authored,
            &issue.created_at,
            &issue.updated_at,
            None,
            issue.closed_at.as_deref(),
            start,
            end,
        );
        for (at, verb) in events {
            let text = format!("{verb} issue #{}: {}", issue.number, one_line(&issue.title));
            let key = format!("{} {verb}", issue.url);
            out.push(item_at(CandidateSource::Github, at, key, text, name));
        }
    }
    out
}

/// A terminal that ran in the window, timed by its opening, or by the window
/// start when it was opened earlier.
fn terminal_item(record: &TerminalRecord, start: DateTime<Utc>) -> Option<Found> {
    let opened = parse_time(&record.opened_at)?;
    let place = match &record.branch {
        Some(branch) => format!("{} on {branch}", record.project_name),
        None => record.project_name.clone(),
    };
    let span = match record.closed_at.as_deref().and_then(parse_time) {
        Some(closed) => format!("from {} to {}", clock(opened), clock(closed)),
        None => format!("from {}, still open", clock(opened)),
    };
    Some(item_at(
        CandidateSource::Terminal,
        opened.max(start),
        record.id.clone(),
        format!("Terminal in {place} {span}"),
        &record.project_name,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::sync::Mutex;

    /// 2026-10-15 09:00 UTC; the test window is the hour from here.
    fn start() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 15, 9, 0, 0).unwrap()
    }

    fn end() -> DateTime<Utc> {
        start() + Duration::hours(1)
    }

    /// `minutes` after the window start (negative = before it), RFC 3339.
    fn at(minutes: i64) -> DateTime<Utc> {
        start() + Duration::minutes(minutes)
    }

    fn stamp(minutes: i64) -> String {
        at(minutes).to_rfc3339()
    }

    const PROJECT: &str = "C:\\git\\proj";
    const OTHER: &str = "/home/me/other";

    #[derive(Default)]
    struct Fake {
        sessions: HashMap<String, Result<Vec<ClaudeSessionInfo>, String>>,
        summaries: HashMap<String, SessionSummary>,
        users: HashMap<String, GitUserConfig>,
        commits: HashMap<String, Result<Vec<CommitInfo>, String>>,
        signed_in: Option<Result<bool, String>>,
        prs: HashMap<String, Result<Vec<(String, PullRequestInfo)>, String>>,
        issues: HashMap<String, Result<Vec<(String, IssueInfo)>, String>>,
        terminals: Option<Result<Vec<TerminalRecord>, String>>,
        gh_searches: Mutex<Vec<String>>,
    }

    impl ActivitySources for Fake {
        async fn claude_sessions(&self, project: &str) -> Result<Vec<ClaudeSessionInfo>, String> {
            self.sessions
                .get(project)
                .cloned()
                .unwrap_or(Ok(Vec::new()))
        }

        async fn session_summaries(&self) -> HashMap<String, SessionSummary> {
            self.summaries.clone()
        }

        async fn git_user(&self, project: &str) -> Result<GitUserConfig, String> {
            self.users
                .get(project)
                .cloned()
                .ok_or_else(|| "not a git repository".to_string())
        }

        async fn git_commits(&self, project: &str) -> Result<Vec<CommitInfo>, String> {
            self.commits.get(project).cloned().unwrap_or(Ok(Vec::new()))
        }

        async fn github_signed_in(&self, _project: &str) -> Result<bool, String> {
            self.signed_in.clone().unwrap_or(Ok(true))
        }

        async fn github_prs(
            &self,
            project: &str,
            search: &str,
        ) -> Result<Vec<PullRequestInfo>, String> {
            self.gh_searches
                .lock()
                .unwrap()
                .push(format!("pr {search}"));
            let qualifier = search.split(' ').next().unwrap_or_default();
            match self.prs.get(project).cloned().unwrap_or(Ok(Vec::new())) {
                Ok(rows) => Ok(rows
                    .into_iter()
                    .filter(|(q, _)| q == qualifier)
                    .map(|(_, pr)| pr)
                    .collect()),
                Err(e) => Err(e),
            }
        }

        async fn github_issues(
            &self,
            project: &str,
            search: &str,
        ) -> Result<Vec<IssueInfo>, String> {
            self.gh_searches
                .lock()
                .unwrap()
                .push(format!("issue {search}"));
            let qualifier = search.split(' ').next().unwrap_or_default();
            match self.issues.get(project).cloned().unwrap_or(Ok(Vec::new())) {
                Ok(rows) => Ok(rows
                    .into_iter()
                    .filter(|(q, _)| q == qualifier)
                    .map(|(_, issue)| issue)
                    .collect()),
                Err(e) => Err(e),
            }
        }

        async fn terminal_records(
            &self,
            _start: DateTime<Utc>,
            _end: DateTime<Utc>,
        ) -> Result<Vec<TerminalRecord>, String> {
            self.terminals.clone().unwrap_or(Ok(Vec::new()))
        }
    }

    fn session(id: &str, started: i64, last_active: i64) -> ClaudeSessionInfo {
        ClaudeSessionInfo {
            session_id: id.to_string(),
            summary: None,
            title: None,
            agent_name: None,
            first_prompt: Some(format!("prompt of {id}")),
            last_prompt: None,
            last_activity: None,
            started_at: stamp(started),
            last_active: stamp(last_active),
            message_count: 3,
            git_branch: None,
            cwd: None,
            cwd_exists: false,
            resumable: false,
            resume_blocked_reason: None,
        }
    }

    fn me() -> GitUserConfig {
        GitUserConfig {
            name: Some("Me Myself".to_string()),
            email: Some("me@example.com".to_string()),
        }
    }

    fn commit(hash: &str, name: &str, email: &str, at: DateTime<Utc>, subject: &str) -> CommitInfo {
        CommitInfo {
            hash: hash.to_string(),
            short_hash: hash.chars().take(7).collect(),
            parent_hashes: Vec::new(),
            author_name: name.to_string(),
            author_email: email.to_string(),
            timestamp: at.timestamp(),
            summary: subject.to_string(),
        }
    }

    fn pr(number: u64, created: i64, updated: i64, merged: Option<i64>) -> PullRequestInfo {
        serde_json::from_value(serde_json::json!({
            "number": number,
            "title": format!("PR title {number}"),
            "state": if merged.is_some() { "MERGED" } else { "OPEN" },
            "author": { "login": "me" },
            "createdAt": stamp(created),
            "updatedAt": stamp(updated),
            "headRefName": "feat/x",
            "baseRefName": "main",
            "isDraft": false,
            "additions": 1,
            "deletions": 0,
            "url": format!("https://github.com/o/r/pull/{number}"),
            "mergedAt": merged.map(stamp),
            "closedAt": merged.map(stamp),
        }))
        .unwrap()
    }

    fn issue(number: u64, created: i64, updated: i64, closed: Option<i64>) -> IssueInfo {
        serde_json::from_value(serde_json::json!({
            "number": number,
            "title": format!("Issue title {number}"),
            "state": if closed.is_some() { "CLOSED" } else { "OPEN" },
            "author": { "login": "someone" },
            "createdAt": stamp(created),
            "updatedAt": stamp(updated),
            "url": format!("https://github.com/o/r/issues/{number}"),
            "closedAt": closed.map(stamp),
            "assignees": [{ "login": "me" }],
        }))
        .unwrap()
    }

    fn terminal(id: &str, opened: i64, closed: Option<i64>) -> TerminalRecord {
        TerminalRecord {
            id: id.to_string(),
            launch_id: "launch".to_string(),
            session_id: 1,
            project_name: "proj".to_string(),
            branch: Some("main".to_string()),
            opened_at: stamp(opened),
            closed_at: closed.map(stamp),
        }
    }

    async fn collect(fake: &Fake, projects: &[&str]) -> Vec<ActivityItem> {
        let projects: Vec<String> = projects.iter().map(|p| p.to_string()).collect();
        collect_with(fake, start(), end(), &projects).await
    }

    fn texts(items: &[ActivityItem]) -> Vec<&str> {
        items.iter().map(|i| i.text.as_str()).collect()
    }

    #[tokio::test]
    async fn claude_sessions_in_the_window_use_the_cached_summary() {
        let mut fake = Fake::default();
        fake.sessions.insert(
            PROJECT.into(),
            Ok(vec![
                session("started-inside", 10, 90),
                session("active-inside", -120, 40),
                session("before", -120, -30),
                session("after", 70, 80),
                session("spans-whole-window", -10, 70),
            ]),
        );
        fake.summaries.insert(
            "started-inside".into(),
            SessionSummary {
                name: "Fix login".into(),
                summary: "The user wanted a fix.\nThe agent fixed it.".into(),
            },
        );
        let items = collect(&fake, &[PROJECT]).await;
        assert_eq!(
            texts(&items),
            vec![
                "Fix login: The user wanted a fix. The agent fixed it.",
                "Claude conversation: prompt of active-inside",
            ]
        );
        assert!(items.iter().all(|i| i.source == CandidateSource::Claude));
        assert!(items.iter().all(|i| i.project == "proj"));
        assert_eq!(items[0].time, clock(at(10)));
        assert_eq!(items[1].time, clock(at(40)));
        assert_eq!(
            items[0].date,
            at(10).with_timezone(&Local).format("%Y-%m-%d").to_string()
        );
    }

    #[tokio::test]
    async fn more_than_fifty_claude_sessions_are_all_collected() {
        let mut fake = Fake::default();
        let sessions = (0..60)
            .map(|n| session(&format!("s{n}"), n % 60, 59))
            .collect();
        fake.sessions.insert(PROJECT.into(), Ok(sessions));
        let items = collect(&fake, &[PROJECT]).await;
        assert_eq!(items.len(), 60);
    }

    #[tokio::test]
    async fn git_keeps_only_the_configured_users_commits_in_the_window() {
        let mut fake = Fake::default();
        fake.users.insert(PROJECT.into(), me());
        fake.commits.insert(
            PROJECT.into(),
            Ok(vec![
                commit("a1", "Someone", "ME@example.com", at(5), "by email"),
                commit("a2", "Me Myself", "other@example.com", at(15), "by name"),
                commit("a3", "Colleague", "them@example.com", at(20), "not mine"),
                commit("a4", "Me Myself", "me@example.com", at(-5), "too early"),
                commit("a5", "Me Myself", "me@example.com", at(65), "too late"),
            ]),
        );
        let items = collect(&fake, &[PROJECT]).await;
        assert_eq!(texts(&items), vec!["by email", "by name"]);
        assert!(items.iter().all(|i| i.source == CandidateSource::Git));
        assert_eq!(items[0].time, clock(at(5)));
    }

    #[tokio::test]
    async fn window_is_half_open() {
        let mut fake = Fake::default();
        fake.users.insert(PROJECT.into(), me());
        fake.commits.insert(
            PROJECT.into(),
            Ok(vec![
                commit("b1", "Me Myself", "me@example.com", start(), "at start"),
                commit("b2", "Me Myself", "me@example.com", end(), "at end"),
            ]),
        );
        fake.sessions
            .insert(PROJECT.into(), Ok(vec![session("ends-at-end", -30, 60)]));
        let items = collect(&fake, &[PROJECT]).await;
        assert_eq!(texts(&items), vec!["at start"]);
    }

    #[tokio::test]
    async fn no_git_user_or_no_repo_lists_no_commits_and_no_error() {
        let mut fake = Fake::default();
        fake.users.insert(
            PROJECT.into(),
            GitUserConfig {
                name: None,
                email: Some("  ".into()),
            },
        );
        fake.commits.insert(
            PROJECT.into(),
            Ok(vec![commit("c1", "Me", "me@example.com", at(5), "hidden")]),
        );
        fake.commits
            .insert(OTHER.into(), Err("not a git repository".into()));
        fake.sessions
            .insert(OTHER.into(), Ok(vec![session("s", 5, 6)]));
        let items = collect(&fake, &[PROJECT, OTHER]).await;
        assert_eq!(texts(&items), vec!["Claude conversation: prompt of s"]);
    }

    #[tokio::test]
    async fn github_lists_what_the_user_did_in_the_window() {
        let mut fake = Fake::default();
        fake.prs.insert(
            PROJECT.into(),
            Ok(vec![
                ("author:@me".into(), pr(1, 5, 30, Some(30))),
                ("author:@me".into(), pr(2, -600, -500, None)),
                ("assignee:@me".into(), pr(3, 20, 25, None)),
            ]),
        );
        fake.issues.insert(
            PROJECT.into(),
            Ok(vec![
                ("assignee:@me".into(), issue(7, -600, 50, Some(50))),
                ("assignee:@me".into(), issue(8, -600, 70, None)),
            ]),
        );
        let items = collect(&fake, &[PROJECT]).await;
        assert_eq!(
            texts(&items),
            vec![
                "Opened PR #1: PR title 1",
                "Updated PR #3: PR title 3",
                "Merged PR #1: PR title 1",
                "Closed issue #7: Issue title 7",
            ]
        );
        assert!(items.iter().all(|i| i.source == CandidateSource::Github));
        assert_eq!(items[2].time, clock(at(30)));

        let searches = fake.gh_searches.lock().unwrap().clone();
        let since = (start() - Duration::days(1)).format("%Y-%m-%d").to_string();
        assert!(searches.contains(&format!("pr author:@me updated:>={since}")));
        assert!(searches.contains(&format!("issue assignee:@me updated:>={since}")));
    }

    #[tokio::test]
    async fn signed_out_gh_is_skipped_and_other_sources_still_return() {
        for signed_in in [Ok(false), Err("gh is not installed".to_string())] {
            let mut fake = Fake {
                signed_in: Some(signed_in),
                ..Fake::default()
            };
            fake.prs.insert(
                PROJECT.into(),
                Ok(vec![("author:@me".into(), pr(1, 5, 5, None))]),
            );
            fake.sessions
                .insert(PROJECT.into(), Ok(vec![session("s", 5, 6)]));
            let items = collect(&fake, &[PROJECT]).await;
            assert_eq!(texts(&items), vec!["Claude conversation: prompt of s"]);
            assert!(fake.gh_searches.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn repo_without_github_remote_is_skipped_and_others_still_return() {
        let mut fake = Fake::default();
        fake.prs
            .insert(PROJECT.into(), Err("no git remotes found".into()));
        fake.issues
            .insert(PROJECT.into(), Err("no git remotes found".into()));
        fake.prs.insert(
            OTHER.into(),
            Ok(vec![("author:@me".into(), pr(4, 5, 5, None))]),
        );
        fake.terminals = Some(Ok(vec![terminal("t", 10, Some(20))]));
        let items = collect(&fake, &[PROJECT, OTHER]).await;
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].text, "Opened PR #4: PR title 4");
        assert_eq!(items[0].project, "other");
        assert_eq!(items[1].source, CandidateSource::Terminal);
    }

    #[tokio::test]
    async fn terminal_records_become_one_line_each() {
        let mut fake = Fake::default();
        let mut no_branch = terminal("open", 30, None);
        no_branch.branch = None;
        fake.terminals = Some(Ok(vec![terminal("closed", -30, Some(20)), no_branch]));
        let items = collect(&fake, &[]).await;
        assert_eq!(
            texts(&items),
            vec![
                format!(
                    "Terminal in proj on main from {} to {}",
                    clock(at(-30)),
                    clock(at(20))
                ),
                format!("Terminal in proj from {}, still open", clock(at(30))),
            ]
        );
        assert!(items.iter().all(|i| i.source == CandidateSource::Terminal));
        // Opened before the window: timed at the window start.
        assert_eq!(items[0].time, clock(start()));
        assert_eq!(items[1].time, clock(at(30)));
    }

    #[tokio::test]
    async fn a_failing_terminal_file_leaves_the_rest() {
        let mut fake = Fake {
            terminals: Some(Err("activity file unreadable".into())),
            ..Fake::default()
        };
        fake.sessions
            .insert(PROJECT.into(), Ok(vec![session("s", 5, 6)]));
        let items = collect(&fake, &[PROJECT]).await;
        assert_eq!(items.len(), 1);
    }

    #[tokio::test]
    async fn items_are_sorted_by_time_and_shared_commits_listed_once() {
        let mut fake = Fake::default();
        let shared = vec![commit(
            "d1",
            "Me Myself",
            "me@example.com",
            at(40),
            "shared commit",
        )];
        for project in [PROJECT, OTHER] {
            fake.users.insert(project.into(), me());
            fake.commits.insert(project.into(), Ok(shared.clone()));
        }
        fake.sessions
            .insert(PROJECT.into(), Ok(vec![session("s", 50, 55)]));
        fake.terminals = Some(Ok(vec![terminal("t", 10, Some(15))]));
        let items = collect(&fake, &[PROJECT, OTHER]).await;
        let sources: Vec<CandidateSource> = items.iter().map(|i| i.source).collect();
        assert_eq!(
            sources,
            vec![
                CandidateSource::Terminal,
                CandidateSource::Git,
                CandidateSource::Claude
            ]
        );
    }

    #[tokio::test]
    async fn an_empty_window_lists_nothing() {
        let mut fake = Fake::default();
        fake.sessions
            .insert(PROJECT.into(), Ok(vec![session("s", 0, 0)]));
        let projects = vec![PROJECT.to_string()];
        assert!(collect_with(&fake, start(), start(), &projects)
            .await
            .is_empty());
    }

    #[test]
    fn the_live_collection_can_run_on_a_spawned_task() {
        fn assert_send<T: Send>(_: &T) {}
        let projects = Vec::new();
        let future = collect_activity(start(), end(), &projects);
        assert_send(&future);
    }
}
