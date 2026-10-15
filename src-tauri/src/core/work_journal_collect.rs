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
//! and never touch `gh`, the network or app data. A failing source is logged
//! and skipped; the collection itself never fails.

use std::collections::{HashMap, HashSet};
use std::fmt::Display;

use chrono::{DateTime, Local, TimeZone, Utc};

use crate::commands::claude_sessions::{list_claude_sessions, ClaudeSessionInfo};
use crate::commands::git::git_user_config;
use crate::commands::github::{github_auth_status, github_list_issues, github_list_prs};
use crate::commands::session_summary::{cached_session_summaries, SessionSummary};
use crate::core::work_journal_activity::{
    activity_dir, list_terminal_records, project_name_from_path, CandidateSource, TerminalRecord,
};
use crate::git::{CommitInfo, Git, GitUserConfig};
use crate::github::{IssueInfo, PullRequestInfo};

/// PRs or issues read per `gh` query.
const GITHUB_LIST_LIMIT: u32 = 100;

/// Field separator in the commit log format (ASCII unit separator), so a `|`
/// in a name or subject cannot shift the fields.
const LOG_FIELD_SEP: char = '\x1f';

/// The two `gh` searches run per project for PRs and for issues. The bool
/// says whether the user authored what the query returns. GitHub search has
/// no "merged by" or "closed by" qualifier, so a PR or issue the user merged
/// or closed is only found through being its author or assignee.
const GITHUB_QUERIES: [(&str, bool); 2] = [("author:@me", true), ("assignee:@me", false)];

/// One thing the user did, ready for the candidate run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityItem {
    /// Which source it came from (its source tag).
    pub source: CandidateSource,
    /// Local date it happened, `YYYY-MM-DD`. Every item's date and time lie
    /// inside the collected window (a terminal opened before it is timed at
    /// the window start).
    pub date: String,
    /// Local time it happened, `HH:MM`, inside the window like `date`.
    pub time: String,
    /// One line describing it.
    pub text: String,
    /// Project name (last component of the project path).
    pub project: String,
    /// Stable identity, the same in every window that lists this activity:
    /// the session id, the commit hash, `owner/repo#number:event` for a PR
    /// or issue event (`opened`, `merged`, `closed`, `updated`), or the
    /// terminal record id.
    pub key: String,
}

/// Where the collection reads each source from. The app uses
/// [`LiveSources`]; tests pass fakes.
trait ActivitySources {
    async fn claude_sessions(&self, project: &str) -> Result<Vec<ClaudeSessionInfo>, String>;
    async fn session_summaries(&self) -> HashMap<String, SessionSummary>;
    async fn git_user(&self, project: &str) -> Result<GitUserConfig, String>;
    async fn git_commits(
        &self,
        project: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<CommitInfo>, String>;
    async fn github_signed_in(&self) -> Result<bool, String>;
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
        let listing = list_claude_sessions(project.to_string(), None).await?;
        if listing.truncated {
            log::debug!(
                "Work journal: History listing for {project} truncated to {} of {} sessions",
                listing.sessions.len(),
                listing.total_found
            );
        }
        Ok(listing.sessions)
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

    async fn git_commits(
        &self,
        project: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<CommitInfo>, String> {
        let args = commit_log_args(start, end);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = Git::new(project)
            .run(&args)
            .await
            .map_err(|e| e.to_string())?;
        Ok(output
            .lines()
            .into_iter()
            .filter_map(parse_commit)
            .collect())
    }

    async fn github_signed_in(&self) -> Result<bool, String> {
        // `gh auth status` needs no repo, and a project folder may no longer
        // exist (the process would then fail to start): run it in the temp
        // folder, which always does.
        let dir = std::env::temp_dir().to_string_lossy().into_owned();
        github_auth_status(dir)
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

/// `git log` arguments for every non-merge commit committed in the window,
/// on any branch or remote ref except the stash, newest first. The window
/// bounds the output, so a long line of newer history elsewhere cannot push
/// in-window commits out. `--exclude` must come before `--all` to apply.
fn commit_log_args(start: DateTime<Utc>, end: DateTime<Utc>) -> Vec<String> {
    vec![
        "log".to_string(),
        "--no-merges".to_string(),
        "--date-order".to_string(),
        "--exclude=refs/stash".to_string(),
        "--all".to_string(),
        format!("--since={}", start.to_rfc3339()),
        format!("--until={}", end.to_rfc3339()),
        "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s".to_string(),
    ]
}

/// One line of [`commit_log_args`] output.
fn parse_commit(line: &str) -> Option<CommitInfo> {
    let parts: Vec<&str> = line.splitn(7, LOG_FIELD_SEP).collect();
    let [hash, short_hash, parents, name, email, time, subject] = parts.as_slice() else {
        return None;
    };
    Some(CommitInfo {
        hash: hash.to_string(),
        short_hash: short_hash.to_string(),
        parent_hashes: parents.split_whitespace().map(str::to_string).collect(),
        author_name: name.to_string(),
        author_email: email.to_string(),
        timestamp: time.parse().ok()?,
        summary: subject.to_string(),
    })
}

/// The window being collected and the time zone its items are dated in.
struct Window<Tz> {
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    tz: Tz,
}

impl<Tz: TimeZone> Window<Tz>
where
    Tz::Offset: Display,
{
    /// Whether `at` is inside the half-open window `[start, end)`.
    fn contains(&self, at: DateTime<Utc>) -> bool {
        self.start <= at && at < self.end
    }

    /// Local `HH:MM`.
    fn clock(&self, at: DateTime<Utc>) -> String {
        at.with_timezone(&self.tz).format("%H:%M").to_string()
    }

    /// Local `YYYY-MM-DD HH:MM`.
    fn day_clock(&self, at: DateTime<Utc>) -> String {
        at.with_timezone(&self.tz)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    }

    fn item(
        &self,
        source: CandidateSource,
        at: DateTime<Utc>,
        key: String,
        text: String,
        project: &str,
    ) -> Found {
        let local = at.with_timezone(&self.tz);
        Found {
            at,
            item: ActivityItem {
                source,
                date: local.format("%Y-%m-%d").to_string(),
                time: local.format("%H:%M").to_string(),
                text,
                project: project.to_string(),
                key,
            },
        }
    }
}

/// One collected item plus the instant it is sorted by.
struct Found {
    at: DateTime<Utc>,
    item: ActivityItem,
}

/// Everything the user did in `[start, end)` (UTC) across `projects` (their
/// paths), sorted by when it happened and dated in local time. Terminal
/// sessions are global, so they are listed whatever the projects. Never
/// fails: a source that errors is logged and left out.
pub async fn collect_activity(
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    projects: &[String],
) -> Vec<ActivityItem> {
    let window = Window {
        start,
        end,
        tz: Local,
    };
    collect_with(&LiveSources, &window, projects).await
}

async fn collect_with<S: ActivitySources, Tz: TimeZone>(
    sources: &S,
    window: &Window<Tz>,
    projects: &[String],
) -> Vec<ActivityItem>
where
    Tz::Offset: Display,
{
    if window.start >= window.end {
        return Vec::new();
    }
    let mut found: Vec<Found> = Vec::new();

    if !projects.is_empty() {
        let summaries = sources.session_summaries().await;
        // `gh` sign-in is per user, not per repo: ask once.
        let signed_in = match sources.github_signed_in().await {
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
                claude_items(sources, project, &name, &summaries, window),
                git_items(sources, project, &name, window),
                async {
                    if signed_in {
                        github_items(sources, project, &name, window).await
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

    match sources.terminal_records(window.start, window.end).await {
        Ok(records) => found.extend(records.iter().filter_map(|r| terminal_item(r, window))),
        Err(e) => log::warn!("Work journal: reading terminal records failed: {e}"),
    }

    // Two paths of one repo (a worktree, a nested folder) report the same
    // commit, PR or conversation: list it once.
    let mut seen = HashSet::new();
    found.retain(|f| seen.insert((format!("{:?}", f.item.source), f.item.key.clone())));
    found.sort_by_key(|f| f.at);
    found.into_iter().map(|f| f.item).collect()
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// Text folded to one line.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Claude conversations that started or were last active in the window,
/// timed by their start when it is inside, else by their last activity.
async fn claude_items<S: ActivitySources, Tz: TimeZone>(
    sources: &S,
    project: &str,
    name: &str,
    summaries: &HashMap<String, SessionSummary>,
    window: &Window<Tz>,
) -> Vec<Found>
where
    Tz::Offset: Display,
{
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
            let started = parse_time(&session.started_at).filter(|t| window.contains(*t));
            let last = parse_time(&session.last_active).filter(|t| window.contains(*t));
            let at = started.or(last)?;
            let text = claude_text(session, summaries.get(&session.session_id));
            Some(window.item(
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
/// `user.name`), timed by their author time. No configured user means no
/// commits can be called the user's, so none are listed.
async fn git_items<S: ActivitySources, Tz: TimeZone>(
    sources: &S,
    project: &str,
    name: &str,
    window: &Window<Tz>,
) -> Vec<Found>
where
    Tz::Offset: Display,
{
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
    let commits = match sources.git_commits(project, window.start, window.end).await {
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
            window.contains(at).then(|| {
                window.item(
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

/// One PR or issue as the event rules need it.
struct GithubThing<'a> {
    /// `PR` or `issue`.
    kind: &'static str,
    number: u64,
    title: &'a str,
    url: &'a str,
    /// Found through `author:@me` (else only through `assignee:@me`).
    authored: bool,
    created_at: &'a str,
    updated_at: &'a str,
    merged_at: Option<&'a str>,
    closed_at: Option<&'a str>,
}

/// `owner/repo` from a GitHub URL (`https://github.com/owner/repo/pull/12`),
/// or the URL itself when it has another shape.
fn repo_slug(url: &str) -> String {
    let parts: Vec<&str> = url.split('/').collect();
    match parts.len() {
        n if n >= 5 => format!("{}/{}", parts[n - 4], parts[n - 3]),
        _ => url.to_string(),
    }
}

/// What happened to a PR or issue inside the window, as (time, event, text).
///
/// For something the user authored: opened, merged or closed, and "updated"
/// when nothing else falls in the window. For something the user is only
/// assigned to, only facts are stated ("Assigned PR #3 was merged"), never
/// that the user did it, and an update alone (someone else's comment or
/// review) is not listed. These lines can reach the supervisor report, which
/// must state facts only.
fn github_events<Tz: TimeZone>(
    thing: &GithubThing,
    window: &Window<Tz>,
) -> Vec<(DateTime<Utc>, &'static str, String)>
where
    Tz::Offset: Display,
{
    let inside = |value: Option<&str>| value.and_then(parse_time).filter(|t| window.contains(*t));
    let (kind, number, title) = (thing.kind, thing.number, one_line(thing.title));
    let say = |verb: &str, event: &str| {
        if thing.authored {
            format!("{verb} {kind} #{number}: {title}")
        } else {
            format!("Assigned {kind} #{number} was {event}: {title}")
        }
    };
    let mut events = Vec::new();
    if let Some(at) = inside(Some(thing.created_at)) {
        events.push((at, "opened", say("Opened", "opened")));
    }
    if let Some(at) = inside(thing.merged_at) {
        events.push((at, "merged", say("Merged", "merged")));
    } else if let Some(at) = inside(thing.closed_at) {
        events.push((at, "closed", say("Closed", "closed")));
    }
    if events.is_empty() && thing.authored {
        if let Some(at) = inside(Some(thing.updated_at)) {
            events.push((at, "updated", say("Updated", "updated")));
        }
    }
    events
}

/// PRs and issues the user authored or is assigned to, with an event in the
/// window. A repo with no GitHub remote (or any `gh` failure) yields none.
async fn github_items<S: ActivitySources, Tz: TimeZone>(
    sources: &S,
    project: &str,
    name: &str,
    window: &Window<Tz>,
) -> Vec<Found>
where
    Tz::Offset: Display,
{
    // The search narrows by last update; the event rules below do the exact
    // window filtering.
    let since = window.start.format("%Y-%m-%dT%H:%M:%SZ");
    let mut prs: HashMap<u64, (PullRequestInfo, bool)> = HashMap::new();
    let mut issues: HashMap<u64, (IssueInfo, bool)> = HashMap::new();
    for (qualifier, authored) in GITHUB_QUERIES {
        let search = format!("{qualifier} updated:>={since}");
        match sources.github_prs(project, &search).await {
            Ok(list) => {
                note_truncated(list.len(), "pr", name, &search);
                for pr in list {
                    let entry = prs.entry(pr.number).or_insert((pr, false));
                    entry.1 |= authored;
                }
            }
            Err(e) => log::debug!("Work journal: gh pr list for {name} failed: {e}"),
        }
        match sources.github_issues(project, &search).await {
            Ok(list) => {
                note_truncated(list.len(), "issue", name, &search);
                for issue in list {
                    let entry = issues.entry(issue.number).or_insert((issue, false));
                    entry.1 |= authored;
                }
            }
            Err(e) => log::debug!("Work journal: gh issue list for {name} failed: {e}"),
        }
    }

    let prs = prs.values().map(|(pr, authored)| GithubThing {
        kind: "PR",
        number: pr.number,
        title: &pr.title,
        url: &pr.url,
        authored: *authored,
        created_at: &pr.created_at,
        updated_at: &pr.updated_at,
        merged_at: pr.merged_at.as_deref(),
        closed_at: pr.closed_at.as_deref(),
    });
    let issues = issues.values().map(|(issue, authored)| GithubThing {
        kind: "issue",
        number: issue.number,
        title: &issue.title,
        url: &issue.url,
        authored: *authored,
        created_at: &issue.created_at,
        updated_at: &issue.updated_at,
        merged_at: None,
        closed_at: issue.closed_at.as_deref(),
    });
    let mut out = Vec::new();
    for thing in prs.chain(issues) {
        for (at, event, text) in github_events(&thing, window) {
            let key = format!("{}#{}:{event}", repo_slug(thing.url), thing.number);
            out.push(window.item(CandidateSource::Github, at, key, text, name));
        }
    }
    out
}

/// Logs when a `gh` listing came back full, so older matches may be missing.
fn note_truncated(len: usize, what: &str, name: &str, search: &str) {
    if len >= GITHUB_LIST_LIMIT as usize {
        log::debug!(
            "Work journal: gh {what} list for {name} hit its {GITHUB_LIST_LIMIT} limit ({search})"
        );
    }
}

/// A terminal that ran in the window, timed by when it was opened. One
/// opened before the window is timed at the window start, so its item stays
/// on the window's day, and says "since <date time>", so a terminal left
/// open overnight is not mistaken for one opened that day.
fn terminal_item<Tz: TimeZone>(record: &TerminalRecord, window: &Window<Tz>) -> Option<Found>
where
    Tz::Offset: Display,
{
    let opened = parse_time(&record.opened_at)?;
    let closed = record.closed_at.as_deref().and_then(parse_time);
    let place = match &record.branch {
        Some(branch) => format!("{} on {branch}", record.project_name),
        None => record.project_name.clone(),
    };
    let span = match (opened < window.start, closed) {
        (false, Some(closed)) => {
            format!("from {} to {}", window.clock(opened), window.clock(closed))
        }
        (false, None) => format!("from {}, still open", window.clock(opened)),
        (true, Some(closed)) => format!(
            "since {}, closed at {}",
            window.day_clock(opened),
            window.clock(closed)
        ),
        (true, None) => format!("since {}, still open", window.day_clock(opened)),
    };
    Some(window.item(
        CandidateSource::Terminal,
        opened.max(window.start),
        record.id.clone(),
        format!("Terminal in {place} {span}"),
        &record.project_name,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, FixedOffset};
    use std::sync::Mutex;

    /// 2026-10-15 09:00 UTC (11:00 at the tests' +02:00 offset); the test
    /// window is the hour from here.
    fn start() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 15, 9, 0, 0).unwrap()
    }

    fn end() -> DateTime<Utc> {
        start() + Duration::hours(1)
    }

    /// The fixed offset every test dates its items in.
    fn plus_two() -> FixedOffset {
        FixedOffset::east_opt(2 * 3600).unwrap()
    }

    /// `minutes` after the window start (negative = before it).
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
        commit_windows: Mutex<Vec<(DateTime<Utc>, DateTime<Utc>)>>,
    }

    /// The rows a fake `gh` query returns: those tagged with its qualifier.
    fn rows_for<T: Clone>(
        rows: Option<&Result<Vec<(String, T)>, String>>,
        search: &str,
    ) -> Result<Vec<T>, String> {
        let qualifier = search.split(' ').next().unwrap_or_default();
        match rows.cloned().unwrap_or(Ok(Vec::new())) {
            Ok(rows) => Ok(rows
                .into_iter()
                .filter(|(q, _)| q == qualifier)
                .map(|(_, row)| row)
                .collect()),
            Err(e) => Err(e),
        }
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

        async fn git_commits(
            &self,
            project: &str,
            start: DateTime<Utc>,
            end: DateTime<Utc>,
        ) -> Result<Vec<CommitInfo>, String> {
            self.commit_windows.lock().unwrap().push((start, end));
            self.commits.get(project).cloned().unwrap_or(Ok(Vec::new()))
        }

        async fn github_signed_in(&self) -> Result<bool, String> {
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
            rows_for(self.prs.get(project), search)
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
            rows_for(self.issues.get(project), search)
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
            "author": { "login": "someone" },
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
            project_path: None,
            branch: Some("main".to_string()),
            opened_at: stamp(opened),
            closed_at: closed.map(stamp),
        }
    }

    fn window(start: DateTime<Utc>, end: DateTime<Utc>) -> Window<FixedOffset> {
        Window {
            start,
            end,
            tz: plus_two(),
        }
    }

    async fn collect(fake: &Fake, projects: &[&str]) -> Vec<ActivityItem> {
        let projects: Vec<String> = projects.iter().map(|p| p.to_string()).collect();
        collect_with(fake, &window(start(), end()), &projects).await
    }

    fn texts(items: &[ActivityItem]) -> Vec<&str> {
        items.iter().map(|i| i.text.as_str()).collect()
    }

    fn times(items: &[ActivityItem]) -> Vec<(&str, &str)> {
        items
            .iter()
            .map(|i| (i.date.as_str(), i.time.as_str()))
            .collect()
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
        assert_eq!(
            times(&items),
            vec![("2026-10-15", "11:10"), ("2026-10-15", "11:40")]
        );
        assert_eq!(items[0].key, "started-inside");
    }

    #[tokio::test]
    async fn more_than_fifty_claude_sessions_are_all_collected() {
        let mut fake = Fake::default();
        let sessions = (0..60).map(|n| session(&format!("s{n}"), n, 59)).collect();
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
        assert_eq!(
            times(&items),
            vec![("2026-10-15", "11:05"), ("2026-10-15", "11:15")]
        );
        assert_eq!(items[0].key, "a1");
        assert_eq!(*fake.commit_windows.lock().unwrap(), vec![(start(), end())]);
    }

    #[test]
    fn commit_log_is_bounded_by_the_window_and_skips_stash_and_merges() {
        let args = commit_log_args(start(), end());
        assert!(args.contains(&"--since=2026-10-15T09:00:00+00:00".to_string()));
        assert!(args.contains(&"--until=2026-10-15T10:00:00+00:00".to_string()));
        assert!(args.contains(&"--no-merges".to_string()));
        assert!(args.contains(&"--date-order".to_string()));
        let exclude = args.iter().position(|a| a == "--exclude=refs/stash");
        let all = args.iter().position(|a| a == "--all");
        assert!(exclude.unwrap() < all.unwrap());
    }

    /// Runs git in `dir` with author and committer dates set to `when`.
    fn git_at(dir: &std::path::Path, when: DateTime<Utc>, args: &[&str]) {
        let date = when.to_rfc3339();
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=Me Myself",
                "-c",
                "user.email=me@example.com",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=",
            ])
            .args(args)
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&status.stderr)
        );
    }

    #[tokio::test]
    async fn live_git_reads_window_commits_on_every_branch_but_not_stash_or_merges() {
        let repo = tempfile::tempdir().unwrap();
        let dir = repo.path();
        git_at(dir, at(-120), &["init", "-q"]);
        let commit_file = |name: &str, when: DateTime<Utc>, subject: &str| {
            std::fs::write(dir.join(name), subject).unwrap();
            git_at(dir, when, &["add", name]);
            git_at(dir, when, &["commit", "-q", "-m", subject]);
        };
        commit_file("a.txt", at(-60), "before the window");
        git_at(dir, at(-59), &["checkout", "-q", "-b", "feature"]);
        commit_file("b.txt", at(10), "feature | inside");
        git_at(dir, at(11), &["checkout", "-q", "-"]);
        commit_file("c.txt", at(20), "main inside");
        commit_file("d.txt", at(90), "after the window");
        git_at(
            dir,
            at(30),
            &["merge", "-q", "--no-ff", "-m", "merge", "feature"],
        );
        std::fs::write(dir.join("c.txt"), "dirty").unwrap();
        git_at(dir, at(40), &["stash", "-q"]);

        let path = dir.to_string_lossy().into_owned();
        let mut subjects: Vec<String> = LiveSources
            .git_commits(&path, start(), end())
            .await
            .unwrap()
            .into_iter()
            .map(|c| c.summary)
            .collect();
        subjects.sort();
        assert_eq!(subjects, vec!["feature | inside", "main inside"]);
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
    async fn a_window_across_midnight_dates_items_on_both_days() {
        let start = Utc.with_ymd_and_hms(2026, 10, 15, 21, 0, 0).unwrap();
        let end = start + Duration::hours(2);
        let mut fake = Fake::default();
        fake.users.insert(PROJECT.into(), me());
        fake.commits.insert(
            PROJECT.into(),
            Ok(vec![commit(
                "m1",
                "Me Myself",
                "me@example.com",
                start + Duration::minutes(30),
                "before midnight",
            )]),
        );
        let mut late = session("late", 0, 0);
        late.started_at = (start + Duration::minutes(90)).to_rfc3339();
        late.last_active = late.started_at.clone();
        fake.sessions.insert(PROJECT.into(), Ok(vec![late]));
        let mut overnight = terminal("overnight", 0, None);
        overnight.opened_at = (start - Duration::hours(1)).to_rfc3339();
        fake.terminals = Some(Ok(vec![overnight]));

        let projects = vec![PROJECT.to_string()];
        let items = collect_with(&fake, &window(start, end), &projects).await;
        assert_eq!(
            times(&items),
            vec![
                ("2026-10-15", "23:00"),
                ("2026-10-15", "23:30"),
                ("2026-10-16", "00:30"),
            ]
        );
        assert_eq!(
            items[0].text,
            "Terminal in proj on main since 2026-10-15 22:00, still open"
        );
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
    async fn github_states_what_the_user_did_and_only_facts_for_assigned_items() {
        let mut fake = Fake::default();
        fake.prs.insert(
            PROJECT.into(),
            Ok(vec![
                ("author:@me".into(), pr(1, 5, 30, Some(30))),
                ("author:@me".into(), pr(2, -600, -500, None)),
                ("assignee:@me".into(), pr(3, -600, 25, Some(25))),
                ("assignee:@me".into(), pr(5, -600, 35, None)),
                ("author:@me".into(), pr(6, -600, 45, None)),
                ("assignee:@me".into(), pr(6, -600, 45, None)),
            ]),
        );
        fake.issues.insert(
            PROJECT.into(),
            Ok(vec![
                ("assignee:@me".into(), issue(7, -600, 50, Some(50))),
                ("assignee:@me".into(), issue(8, 55, 55, None)),
                ("assignee:@me".into(), issue(9, -600, 70, None)),
            ]),
        );
        let items = collect(&fake, &[PROJECT]).await;
        assert_eq!(
            texts(&items),
            vec![
                "Opened PR #1: PR title 1",
                "Assigned PR #3 was merged: PR title 3",
                "Merged PR #1: PR title 1",
                "Updated PR #6: PR title 6",
                "Assigned issue #7 was closed: Issue title 7",
                "Assigned issue #8 was opened: Issue title 8",
            ]
        );
        assert!(items.iter().all(|i| i.source == CandidateSource::Github));
        assert_eq!(items[2].time, "11:30");
        assert_eq!(items[0].key, "o/r#1:opened");
        assert_eq!(items[2].key, "o/r#1:merged");
        assert_eq!(items[4].key, "o/r#7:closed");

        let searches = fake.gh_searches.lock().unwrap().clone();
        assert!(searches.contains(&"pr author:@me updated:>=2026-10-15T09:00:00Z".to_string()));
        assert!(searches.contains(&"issue assignee:@me updated:>=2026-10-15T09:00:00Z".to_string()));
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
    async fn failing_gh_listings_skip_only_themselves() {
        let mut fake = Fake::default();
        fake.prs
            .insert(PROJECT.into(), Err("no git remotes found".into()));
        fake.issues.insert(
            PROJECT.into(),
            Ok(vec![("author:@me".into(), issue(9, 1, 1, None))]),
        );
        fake.issues
            .insert(OTHER.into(), Err("no git remotes found".into()));
        fake.prs.insert(
            OTHER.into(),
            Ok(vec![("author:@me".into(), pr(4, 5, 5, None))]),
        );
        fake.terminals = Some(Ok(vec![terminal("t", 10, Some(20))]));
        let items = collect(&fake, &[PROJECT, OTHER]).await;
        assert_eq!(
            texts(&items),
            vec![
                "Opened issue #9: Issue title 9",
                "Opened PR #4: PR title 4",
                "Terminal in proj on main from 11:10 to 11:20",
            ]
        );
        assert_eq!(items[1].project, "other");
    }

    #[tokio::test]
    async fn terminal_records_become_one_line_each() {
        let mut fake = Fake::default();
        let mut no_branch = terminal("open", 30, None);
        no_branch.branch = None;
        fake.terminals = Some(Ok(vec![terminal("earlier", -30, Some(20)), no_branch]));
        let items = collect(&fake, &[]).await;
        assert_eq!(
            texts(&items),
            vec![
                "Terminal in proj on main since 2026-10-15 10:30, closed at 11:20",
                "Terminal in proj from 11:30, still open",
            ]
        );
        assert!(items.iter().all(|i| i.source == CandidateSource::Terminal));
        // Opened before the window: timed at its start, text keeps the open.
        assert_eq!(
            times(&items),
            vec![("2026-10-15", "11:00"), ("2026-10-15", "11:30")]
        );
        assert_eq!(items[0].key, "earlier");
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
        assert!(collect_with(&fake, &window(start(), start()), &projects)
            .await
            .is_empty());
    }

    #[test]
    fn repo_slug_reads_owner_and_repo() {
        assert_eq!(repo_slug("https://github.com/o/r/pull/12"), "o/r");
        assert_eq!(
            repo_slug("https://github.com/own/repo/issues/3"),
            "own/repo"
        );
        assert_eq!(repo_slug("odd"), "odd");
    }

    #[test]
    fn the_live_collection_can_run_on_a_spawned_task() {
        fn assert_send<T: Send>(_: &T) {}
        let projects = Vec::new();
        let future = collect_activity(start(), end(), &projects);
        assert_send(&future);
    }
}
