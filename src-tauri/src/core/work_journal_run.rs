//! The Work Journal's candidate run (issue #313): every few hours while
//! Maestro is open, on start (catching up since the last run) and on "Run
//! now", a headless `claude -p` turns the window's activity into one-line
//! candidates and stores them as pending in the temporary activity file.
//!
//! PRD "Candidates": the run is given, per date, that date's activity, its
//! page text and its pending and rejected candidates (same-day duplicate
//! removal only, never older pages). The reply contract is one candidate per
//! line, `HH:MM - action | source`, parsed strictly.
//!
//! The pure pieces ([`run_window`], [`page_text`], [`claude_args`],
//! [`build_prompt`], [`parse_reply`]) are unit-tested; the run itself reaches
//! the outside world through [`RunSources`], so tests use fakes and never
//! start the real `claude` CLI.

use std::collections::{BTreeMap, HashSet};
use std::process::Stdio;
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDate, SubsecRound, TimeDelta, TimeZone, Utc};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, MutexGuard};

use crate::core::work_journal::WorkJournal;
use crate::core::work_journal_activity::{
    activity_dir, add_candidates, list_candidates, validate_candidate, Candidate, CandidateSource,
    NewCandidate,
};
use crate::core::work_journal_collect::{collect_activity, ActivityItem};

/// Hours between runs when the setting is absent.
pub const DEFAULT_RUN_EVERY_HOURS: u32 = 1;

/// The largest "run every X hours" accepted; larger values are capped.
pub const MAX_RUN_EVERY_HOURS: u32 = 24;

/// How far back a catch-up run reaches at most, however old the last run.
pub const MAX_CATCH_UP_DAYS: i64 = 7;

/// Event emitted when a run added candidates; the payload is a
/// [`CandidatesAdded`].
pub const CANDIDATES_EVENT: &str = "work-journal:candidates";

/// One `claude` call per date; anything past this is a hung CLI.
const RUN_TIMEOUT: Duration = Duration::from_secs(180);

/// The positional prompt; the run's real input goes in on stdin.
const USER_PROMPT: &str = "Write Work Journal lines for the activity given on stdin.";

/// A full `--system-prompt` (not an appended one), so the user's own
/// CLAUDE.md never reaches the run and breaks the reply format (issue #97).
pub const SYSTEM_PROMPT: &str = "You write a developer's Work Journal. You are given what \
they did on one day (one activity per line: time, source tag, project, text), what is \
already on that day's journal page, and the lines already suggested or rejected for that \
day. Turn the activity into short journal lines.\n\
Output contract, follow it exactly:\n\
- Plain text lines only: no markdown, no bullets, no numbering, no preamble, no closing \
remarks.\n\
- One line per journal entry, in the form: HH:MM - action | source\n\
- HH:MM is when the activity happened (24-hour, from the activity line), not the time now.\n\
- action is one short action in English, in the past tense, for example: Merged the PR \
for the login fix\n\
- source is the source tag of the activity line it came from: github, git, claude or \
terminal.\n\
- Do not repeat anything already on the page or in the suggested or rejected lines, even \
in other words.\n\
- Merge closely related activity into one line; skip activity not worth a journal line.\n\
- If nothing is worth a line, reply with exactly: NONE";

/// The source tags a reply line may carry (Granola is not part of this run).
const REPLY_SOURCES: [CandidateSource; 4] = [
    CandidateSource::Github,
    CandidateSource::Git,
    CandidateSource::Claude,
    CandidateSource::Terminal,
];

/// Only one run at a time in this process.
static RUN_LOCK: Mutex<()> = Mutex::const_new(());

/// Claims the one run slot; `None` while another run holds it. Keep the
/// guard for the whole run.
pub fn try_begin_run() -> Option<MutexGuard<'static, ()>> {
    RUN_LOCK.try_lock().ok()
}

/// Payload of [`CANDIDATES_EVENT`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CandidatesAdded {
    /// Dates (`YYYY-MM-DD`) that got new candidates.
    pub dates: Vec<String>,
    /// How many candidates were added in all.
    pub added: usize,
}

/// What one run did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunReport {
    /// Candidates added in all.
    pub added: usize,
    /// Dates that got candidates, oldest first.
    pub dates: Vec<String>,
    /// Activity up to this instant is done; the caller saves it as
    /// `last_run_at`. The window end on success; on a failure, the start of
    /// the earliest date that failed (never before the window start), so the
    /// next run repeats that date and the ones after it.
    pub covered_until: DateTime<Utc>,
    /// Why one or more dates failed, if any did. Candidates of the dates
    /// that succeeded stay.
    pub error: Option<String>,
}

/// "Run every X hours" as used: absent or 0 is the default, more than
/// [`MAX_RUN_EVERY_HOURS`] is capped.
pub fn effective_run_every_hours(setting: Option<u32>) -> u32 {
    match setting {
        None | Some(0) => DEFAULT_RUN_EVERY_HOURS,
        Some(hours) => hours.min(MAX_RUN_EVERY_HOURS),
    }
}

/// The run's half-open UTC window `[start, end)`. `end` is `now` (whole
/// seconds, so the next window starts exactly where this one ended). `start`
/// is `last_run_at` when it parses and is not after `now` (equal = an empty
/// window: nothing to do), else (missing, unparsable, or in the future after
/// a clock change) one run interval back; never more than
/// [`MAX_CATCH_UP_DAYS`] back.
pub fn run_window(
    last_run_at: Option<&str>,
    run_every_hours: Option<u32>,
    now: DateTime<Utc>,
) -> (DateTime<Utc>, DateTime<Utc>) {
    let end = now.trunc_subsecs(0);
    let interval = TimeDelta::hours(i64::from(effective_run_every_hours(run_every_hours)));
    let start = last_run_at
        .and_then(|at| DateTime::parse_from_rfc3339(at.trim()).ok())
        .map(|at| at.with_timezone(&Utc))
        .filter(|at| *at <= end)
        .unwrap_or(end - interval);
    (start.max(end - TimeDelta::days(MAX_CATCH_UP_DAYS)), end)
}

/// A page's plain text: every text node of its TipTap JSON, each paragraph,
/// heading or list item on its own line (blank lines dropped).
pub fn page_text(body: &Value) -> String {
    let mut lines = Vec::new();
    let mut current = String::new();
    collect_text(body, &mut lines, &mut current);
    flush_line(&mut lines, &mut current);
    lines.join("\n")
}

/// Node types whose content ends a line.
const LINE_NODES: [&str; 3] = ["paragraph", "heading", "codeBlock"];

fn collect_text(node: &Value, lines: &mut Vec<String>, current: &mut String) {
    let kind = node.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "text" => {
            if let Some(text) = node.get("text").and_then(Value::as_str) {
                current.push_str(text);
            }
        }
        "hardBreak" => flush_line(lines, current),
        _ => {
            if let Some(children) = node.get("content").and_then(Value::as_array) {
                for child in children {
                    collect_text(child, lines, current);
                }
            }
            if LINE_NODES.contains(&kind) {
                flush_line(lines, current);
            }
        }
    }
}

fn flush_line(lines: &mut Vec<String>, current: &mut String) {
    let line = current.trim();
    if !line.is_empty() {
        lines.push(line.to_string());
    }
    current.clear();
}

/// True for a model name safe to pass as one argument: letters, digits and
/// `-._:[]/@` only (for example `sonnet`, `claude-opus-5-5[1m]`), and not
/// starting with `-` (it would read as a flag).
fn is_safe_model(model: &str) -> bool {
    !model.starts_with('-')
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._:[]/@".contains(c))
}

/// The `claude` arguments for one run: print mode, no built-in tools, no
/// saved session, the run's own system prompt, and `--model` only when the
/// setting names one (blank = the user's default model). Never `--bare`
/// (bare mode never reads stored sign-ins) and never an appended system
/// prompt. The input goes in on stdin.
pub fn claude_args(model: Option<&str>) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = [
        "-p",
        "--tools",
        "",
        "--no-session-persistence",
        "--system-prompt",
        SYSTEM_PROMPT,
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    if let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) {
        if !is_safe_model(model) {
            return Err(format!(
                "The Work Journal model \"{model}\" is not a valid model name. Change it in \
                 Settings or leave it blank for your default model."
            ));
        }
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    args.push(USER_PROMPT.to_string());
    Ok(args)
}

/// The tag a source has in prompts and replies.
fn source_tag(source: CandidateSource) -> &'static str {
    match source {
        CandidateSource::Github => "github",
        CandidateSource::Git => "git",
        CandidateSource::Claude => "claude",
        CandidateSource::Terminal => "terminal",
        CandidateSource::Granola => "granola",
    }
}

/// Folds text to one line.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The stdin input for one date: its activity (`HH:MM [source] project:
/// text`, one per line), its page text, and its pending and rejected
/// candidates, with the rule not to repeat any of them. Items and candidates
/// of other dates are left out.
pub fn build_prompt(
    date: &str,
    items: &[ActivityItem],
    page_text: &str,
    existing: &[Candidate],
) -> String {
    let activity: Vec<String> = items
        .iter()
        .filter(|item| item.date == date)
        .map(|item| {
            format!(
                "{} [{}] {}: {}",
                item.time,
                source_tag(item.source),
                one_line(&item.project),
                one_line(&item.text)
            )
        })
        .collect();
    let suggested: Vec<String> = existing
        .iter()
        .filter(|c| c.date == date)
        .map(|c| match &c.time {
            Some(time) => format!("{time} - {} | {}", one_line(&c.text), source_tag(c.source)),
            None => format!("{} | {}", one_line(&c.text), source_tag(c.source)),
        })
        .collect();
    let page = if page_text.trim().is_empty() {
        "(empty)".to_string()
    } else {
        page_text.trim().to_string()
    };
    let suggested = if suggested.is_empty() {
        "(none)".to_string()
    } else {
        suggested.join("\n")
    };
    format!(
        "Date: {date}\n\n\
         Activity (HH:MM [source] project: text):\n{}\n\n\
         Already on the journal page for this date (do not repeat):\n{page}\n\n\
         Already suggested or rejected for this date (do not repeat):\n{suggested}\n\n\
         Reply with one line per new journal entry, HH:MM - action | source, or NONE.",
        activity.join("\n")
    )
}

/// Comparison key for duplicate text: one line, lower case.
fn dedupe_key(text: &str) -> String {
    one_line(text).to_lowercase()
}

/// Parses one reply line, `HH:MM - action | source`; `None` when it does
/// not match.
fn parse_line(line: &str, date: &str) -> Option<NewCandidate> {
    let (time, rest) = line.trim().split_once('-')?;
    let time = time.trim();
    chrono::NaiveTime::parse_from_str(time, "%H:%M").ok()?;
    let (action, source) = rest.rsplit_once('|')?;
    let action = one_line(action);
    if action.is_empty() {
        return None;
    }
    let source = source.trim();
    let source = REPLY_SOURCES
        .into_iter()
        .find(|s| source_tag(*s).eq_ignore_ascii_case(source))?;
    Some(NewCandidate {
        date: date.to_string(),
        time: Some(time.to_string()),
        text: action,
        source,
    })
}

/// Reads the reply strictly: one candidate per `HH:MM - action | source`
/// line; other lines are dropped (logged at debug). `NONE` or an empty reply
/// yields nothing. A line whose text equals (ignoring case and spacing) an
/// existing candidate's text for `date`, or an earlier line's, is dropped.
///
/// A reply with text but not one line in the format and no `NONE` (markdown
/// bullets, a notice printed instead of an answer) is an error, so the date
/// is tried again on the next run instead of being marked done.
pub fn parse_reply(
    reply: &str,
    date: &str,
    existing: &[Candidate],
) -> Result<Vec<NewCandidate>, String> {
    let mut seen: HashSet<String> = existing
        .iter()
        .filter(|c| c.date == date)
        .map(|c| dedupe_key(&c.text))
        .collect();
    let mut parsed = Vec::new();
    let mut matched = 0;
    let mut said_none = false;
    let mut other_text = false;
    for line in reply.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.eq_ignore_ascii_case("NONE") {
            said_none = true;
            continue;
        }
        let Some(candidate) = parse_line(trimmed, date) else {
            log::debug!("Work journal: dropped a candidate reply line that does not match");
            other_text = true;
            continue;
        };
        matched += 1;
        if seen.insert(dedupe_key(&candidate.text)) {
            parsed.push(candidate);
        } else {
            log::debug!("Work journal: dropped a duplicate candidate for {date}");
        }
    }
    if matched == 0 && other_text && !said_none {
        // Only the reply is logged, never the activity sent with it.
        let head: String = reply.trim().chars().take(REPLY_LOG_CHARS).collect();
        log::debug!("Work journal: unusable candidate reply for {date}: {head}");
        return Err("claude's reply had no line in the expected format".to_string());
    }
    Ok(parsed)
}

/// How much of an unusable reply is logged (at debug only).
const REPLY_LOG_CHARS: usize = 200;

/// The UTC instant local midnight of `date` begins at.
fn start_of_local_date(date: &str) -> Option<DateTime<Utc>> {
    let day = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    Local
        .from_local_datetime(&day.and_hms_opt(0, 0, 0)?)
        .earliest()
        .map(|at| at.with_timezone(&Utc))
}

/// Where a run reads and writes. The app uses [`LiveSources`]; tests pass
/// fakes.
trait RunSources {
    async fn collect(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        projects: &[String],
    ) -> Vec<ActivityItem>;
    async fn candidates(&self, date: &str) -> Result<Vec<Candidate>, String>;
    async fn ask_claude(&self, args: &[String], input: &str) -> Result<String, String>;
    async fn add(&self, new: Vec<NewCandidate>) -> Result<usize, String>;
}

/// The real sources: activity collection, the activity file and `claude`.
struct LiveSources;

impl RunSources for LiveSources {
    async fn collect(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        projects: &[String],
    ) -> Vec<ActivityItem> {
        collect_activity(start, end, projects).await
    }

    async fn candidates(&self, date: &str) -> Result<Vec<Candidate>, String> {
        list_candidates(&activity_dir(), date)
            .await
            .map_err(|e| e.to_string())
    }

    async fn ask_claude(&self, args: &[String], input: &str) -> Result<String, String> {
        run_claude(args, input).await
    }

    async fn add(&self, new: Vec<NewCandidate>) -> Result<usize, String> {
        add_candidates(&activity_dir(), new)
            .await
            .map(|added| added.len())
            .map_err(|e| e.to_string())
    }
}

/// Runs `claude` with `args` from the temp dir (so no project CLAUDE.md is
/// picked up), `input` on stdin, a timeout and a hidden console on Windows.
/// The child is killed if the run is dropped or times out.
async fn run_claude(args: &[String], input: &str) -> Result<String, String> {
    run_process("claude", args, input, RUN_TIMEOUT).await
}

/// Runs `program` with `input` on stdin and returns its stdout. Sending the
/// input and waiting for the exit share ONE `timeout`, so a child that never
/// reads stdin (a pipe holds only a few KB) cannot hold the run (and its
/// one-run lock) past the limit. The child handle lives only inside the
/// timed future: on timeout that future is dropped with it, and
/// `kill_on_drop` kills the child.
async fn run_process(
    program: &str,
    args: &[String],
    input: &str,
    limit: Duration,
) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use crate::core::windows_process::TokioCommandExt;
        cmd.hide_console_window();
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start the claude CLI ({e})"))?;
    let stdin = child.stdin.take();
    // Write and wait side by side, so a child that fills stdout before it
    // reads stdin cannot deadlock either. `stdin` is dropped after the write,
    // which closes it and lets the child see the end of the input.
    let send = async move {
        if let Some(mut stdin) = stdin {
            stdin.write_all(input.as_bytes()).await?;
        }
        Ok::<(), std::io::Error>(())
    };
    let exchange = async move { tokio::join!(send, child.wait_with_output()) };
    let (sent, output) = tokio::time::timeout(limit, exchange)
        .await
        .map_err(|_| format!("claude did not answer within {}s", limit.as_secs()))?;
    let output = output.map_err(|e| format!("claude run failed ({e})"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        let detail: String = one_line(&detail).chars().take(300).collect();
        return Err(format!("claude exited with {}: {detail}", output.status));
    }
    // Checked after the exit status, which says more when the child quit
    // early; a reply to half the input is never used.
    sent.map_err(|e| format!("could not send the activity to claude ({e})"))?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// One run over the window from `journal`'s settings at `now`, across
/// `projects` (their paths). Does not save `last_run_at`; the caller saves
/// [`RunReport::covered_until`].
pub async fn run_candidates(
    journal: &WorkJournal,
    projects: &[String],
    now: DateTime<Utc>,
) -> RunReport {
    run_with(&LiveSources, journal, projects, now).await
}

async fn run_with<S: RunSources>(
    sources: &S,
    journal: &WorkJournal,
    projects: &[String],
    now: DateTime<Utc>,
) -> RunReport {
    let settings = &journal.settings;
    let (start, end) = run_window(
        settings.last_run_at.as_deref(),
        settings.run_every_hours,
        now,
    );
    let mut report = RunReport {
        added: 0,
        dates: Vec::new(),
        covered_until: start,
        error: None,
    };
    let args = match claude_args(settings.model.as_deref()) {
        Ok(args) => args,
        Err(e) => {
            report.error = Some(e);
            return report;
        }
    };

    let mut by_date: BTreeMap<String, Vec<ActivityItem>> = BTreeMap::new();
    for item in sources.collect(start, end, projects).await {
        by_date.entry(item.date.clone()).or_default().push(item);
    }

    // A failed date does not stop the run: later dates (today included) still
    // get their candidates. `covered_until` stops at the earliest failed
    // date, so it and every later date run again next time; the later dates
    // then get their own candidates fed back, which bounds repeats.
    let mut earliest_failed: Option<DateTime<Utc>> = None;
    let mut errors: Vec<String> = Vec::new();
    for (date, items) in by_date {
        match run_date(sources, journal, &args, &date, &items).await {
            Ok(0) => {}
            Ok(added) => {
                report.added += added;
                report.dates.push(date);
            }
            Err(e) => {
                log::warn!("Work journal: candidate run for {date} failed: {e}");
                if earliest_failed.is_none() {
                    earliest_failed = Some(
                        start_of_local_date(&date).map_or(start, |midnight| midnight.max(start)),
                    );
                }
                errors.push(format!("Candidate run for {date} failed: {e}"));
            }
        }
    }
    report.covered_until = earliest_failed.unwrap_or(end);
    if !errors.is_empty() {
        report.error = Some(errors.join("; "));
    }
    report
}

/// One `claude` call for one date; returns how many candidates were added.
async fn run_date<S: RunSources>(
    sources: &S,
    journal: &WorkJournal,
    args: &[String],
    date: &str,
    items: &[ActivityItem],
) -> Result<usize, String> {
    let existing = sources.candidates(date).await?;
    let page = journal
        .pages
        .get(date)
        .map(|page| page_text(&page.body))
        .unwrap_or_default();
    let input = build_prompt(date, items, &page, &existing);
    let reply = sources.ask_claude(args, &input).await?;
    let valid: Vec<NewCandidate> = parse_reply(&reply, date, &existing)?
        .iter()
        .filter_map(|candidate| match validate_candidate(candidate) {
            Ok(valid) => Some(valid),
            Err(e) => {
                log::debug!("Work journal: dropped an invalid candidate: {e}");
                None
            }
        })
        .collect();
    if valid.is_empty() {
        return Ok(0);
    }
    sources.add(valid).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::work_journal::{PageOrigin, WorkJournalPage};
    use crate::core::work_journal_activity::CandidateState;
    use serde_json::json;
    use std::sync::Mutex as StdMutex;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 15, 12, 0, 0).unwrap()
    }

    fn item(date: &str, time: &str, source: CandidateSource, text: &str) -> ActivityItem {
        ActivityItem {
            source,
            date: date.to_string(),
            time: time.to_string(),
            text: text.to_string(),
            project: "maestro".to_string(),
            key: format!("{date}{time}{text}"),
        }
    }

    fn candidate(date: &str, text: &str, state: CandidateState) -> Candidate {
        Candidate {
            id: format!("id-{text}"),
            date: date.to_string(),
            time: Some("09:00".to_string()),
            text: text.to_string(),
            source: CandidateSource::Git,
            state,
            created_at: "2026-10-15T09:00:00Z".to_string(),
        }
    }

    // --- run_window ---

    #[test]
    fn test_run_window_without_last_run_covers_one_interval() {
        assert_eq!(
            run_window(None, None, now()),
            (now() - TimeDelta::hours(1), now())
        );
        assert_eq!(
            run_window(None, Some(3), now()),
            (now() - TimeDelta::hours(3), now())
        );
    }

    #[test]
    fn test_run_window_catches_up_since_last_run() {
        let five_hours_ago = (now() - TimeDelta::hours(5)).to_rfc3339();
        assert_eq!(
            run_window(Some(&five_hours_ago), Some(1), now()),
            (now() - TimeDelta::hours(5), now())
        );
    }

    #[test]
    fn test_run_window_ignores_a_future_or_unparsable_last_run() {
        let future = (now() + TimeDelta::hours(2)).to_rfc3339();
        let interval = (now() - TimeDelta::hours(2), now());
        assert_eq!(run_window(Some(&future), Some(2), now()), interval);
        assert_eq!(run_window(Some("yesterday"), Some(2), now()), interval);
    }

    #[test]
    fn test_run_window_is_empty_when_the_last_run_is_now() {
        assert_eq!(
            run_window(Some(&now().to_rfc3339()), Some(2), now()),
            (now(), now())
        );
    }

    #[test]
    fn test_run_window_caps_the_catch_up() {
        let long_ago = (now() - TimeDelta::days(30)).to_rfc3339();
        assert_eq!(
            run_window(Some(&long_ago), None, now()),
            (now() - TimeDelta::days(MAX_CATCH_UP_DAYS), now())
        );
    }

    #[test]
    fn test_run_window_end_is_whole_seconds() {
        let precise = now() + TimeDelta::milliseconds(750);
        assert_eq!(run_window(None, None, precise).1, now());
    }

    #[test]
    fn test_effective_run_every_hours_defaults_and_caps() {
        assert_eq!(effective_run_every_hours(None), 1);
        assert_eq!(effective_run_every_hours(Some(0)), 1);
        assert_eq!(effective_run_every_hours(Some(6)), 6);
        assert_eq!(effective_run_every_hours(Some(99)), 24);
    }

    // --- page_text ---

    #[test]
    fn test_page_text_puts_blocks_and_list_items_on_their_own_lines() {
        let body = json!({
            "type": "doc",
            "content": [
                {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Morning"}]},
                {"type": "paragraph", "content": [
                    {"type": "text", "text": "Fixed the "},
                    {"type": "text", "marks": [{"type": "bold"}], "text": "login"},
                    {"type": "text", "text": " bug"}
                ]},
                {"type": "paragraph"},
                {"type": "bulletList", "content": [
                    {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "one"}]}]},
                    {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "two"}]}]}
                ]},
                {"type": "taskList", "content": [
                    {"type": "taskItem", "attrs": {"checked": true}, "content": [{"type": "paragraph", "content": [
                        {"type": "text", "text": "a"}, {"type": "hardBreak"}, {"type": "text", "text": "b"}
                    ]}]}
                ]}
            ]
        });
        assert_eq!(
            page_text(&body),
            "Morning\nFixed the login bug\none\ntwo\na\nb"
        );
    }

    #[test]
    fn test_page_text_of_an_empty_or_odd_body_is_empty() {
        assert_eq!(
            page_text(&json!({"type": "doc", "content": [{"type": "paragraph"}]})),
            ""
        );
        assert_eq!(page_text(&json!(null)), "");
        assert_eq!(page_text(&json!("text")), "");
    }

    // --- claude_args ---

    #[test]
    fn test_claude_args_without_model_use_the_default_model() {
        let args = claude_args(None).unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "--tools",
                "",
                "--no-session-persistence",
                "--system-prompt",
                SYSTEM_PROMPT,
                USER_PROMPT
            ]
        );
        assert_eq!(claude_args(Some("  ")).unwrap(), args);
    }

    #[test]
    fn test_claude_args_with_model_pass_it() {
        let args = claude_args(Some(" sonnet ")).unwrap();
        let at = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[at + 1], "sonnet");
        assert_eq!(args.last().unwrap(), USER_PROMPT);
        assert!(claude_args(Some("claude-opus-5-5[1m]")).is_ok());
    }

    #[test]
    fn test_claude_args_never_bare_or_appended() {
        for model in [None, Some("haiku")] {
            let args = claude_args(model).unwrap();
            assert!(!args.iter().any(|a| a == "--bare"));
            assert!(!args.iter().any(|a| a == "--append-system-prompt"));
            assert!(args.iter().any(|a| a == "--no-session-persistence"));
        }
    }

    #[test]
    fn test_claude_args_refuse_an_unsafe_model_name() {
        let err = claude_args(Some("sonnet & calc")).unwrap_err();
        assert!(err.contains("not a valid model name"));
        assert!(claude_args(Some("--bare")).is_err());
        assert!(claude_args(Some("-p")).is_err());
    }

    #[test]
    fn test_system_prompt_states_the_contract() {
        for needle in [
            "HH:MM - action | source",
            "NONE",
            "no markdown",
            "English",
            "happened",
        ] {
            assert!(SYSTEM_PROMPT.contains(needle), "missing {needle}");
        }
    }

    // --- build_prompt ---

    #[test]
    fn test_build_prompt_feeds_activity_page_and_existing_candidates_of_that_date_only() {
        let items = vec![
            item(
                "2026-10-15",
                "09:05",
                CandidateSource::Git,
                "Commit abc: fix login",
            ),
            item(
                "2026-10-14",
                "23:30",
                CandidateSource::Github,
                "Opened PR #9 late",
            ),
            item(
                "2026-10-15",
                "10:00",
                CandidateSource::Claude,
                "Session: plan the backup",
            ),
        ];
        let existing = vec![
            candidate("2026-10-15", "Planned the backup", CandidateState::Pending),
            candidate("2026-10-15", "Read email", CandidateState::Rejected),
            candidate("2026-10-14", "Yesterday's line", CandidateState::Pending),
        ];
        let prompt = build_prompt("2026-10-15", &items, "08:00 - Standup", &existing);

        assert!(prompt.contains("Date: 2026-10-15"));
        assert!(prompt.contains("09:05 [git] maestro: Commit abc: fix login"));
        assert!(prompt.contains("10:00 [claude] maestro: Session: plan the backup"));
        assert!(prompt.contains("08:00 - Standup"));
        assert!(prompt.contains("09:00 - Planned the backup | git"));
        assert!(prompt.contains("09:00 - Read email | git"));
        assert!(!prompt.contains("Opened PR #9 late"));
        assert!(!prompt.contains("Yesterday's line"));
    }

    #[test]
    fn test_build_prompt_marks_an_empty_page_and_no_candidates() {
        let items = vec![item(
            "2026-10-15",
            "09:05",
            CandidateSource::Terminal,
            "Terminal",
        )];
        let prompt = build_prompt("2026-10-15", &items, "  ", &[]);
        assert!(prompt.contains("this date (do not repeat):\n(empty)"));
        assert!(prompt.contains("for this date (do not repeat):\n(none)"));
    }

    // --- parse_reply ---

    #[test]
    fn test_parse_reply_reads_valid_lines() {
        let reply =
            "09:05 - Fixed the login bug | git\n14:30 - Merged the PR for the backup | GitHub\n";
        let parsed = parse_reply(reply, "2026-10-15", &[]).unwrap();
        assert_eq!(
            parsed,
            vec![
                NewCandidate {
                    date: "2026-10-15".to_string(),
                    time: Some("09:05".to_string()),
                    text: "Fixed the login bug".to_string(),
                    source: CandidateSource::Git,
                },
                NewCandidate {
                    date: "2026-10-15".to_string(),
                    time: Some("14:30".to_string()),
                    text: "Merged the PR for the backup".to_string(),
                    source: CandidateSource::Github,
                },
            ]
        );
    }

    #[test]
    fn test_parse_reply_drops_malformed_lines_and_keeps_the_rest() {
        let reply = "Here are your lines:\n\
                     - 09:05 - Bulleted | git\n\
                     9am - Bad time | git\n\
                     10:00 - No source\n\
                     10:15 - Unknown source | slack\n\
                     10:20 -  | git\n\
                     25:00 - Not a time | git\n\
                     11:00 - Reviewed a PR - with a dash | a | claude\n\
                     12:00 - Ran the tests | Terminal";
        let parsed = parse_reply(reply, "2026-10-15", &[]).unwrap();
        let texts: Vec<&str> = parsed.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(
            texts,
            vec!["Reviewed a PR - with a dash | a", "Ran the tests"]
        );
        assert_eq!(parsed[0].source, CandidateSource::Claude);
        assert_eq!(parsed[1].source, CandidateSource::Terminal);
    }

    #[test]
    fn test_parse_reply_none_or_empty_yields_nothing() {
        assert!(parse_reply("NONE", "2026-10-15", &[]).unwrap().is_empty());
        assert!(parse_reply("  none \n", "2026-10-15", &[])
            .unwrap()
            .is_empty());
        assert!(parse_reply("", "2026-10-15", &[]).unwrap().is_empty());
        assert!(parse_reply("Nothing new.\nNONE", "2026-10-15", &[])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_parse_reply_without_one_matching_line_is_an_error() {
        let bullets = "- 09:05 - Fixed the login bug | git\n- 10:00 - Ran tests | terminal";
        assert!(parse_reply(bullets, "2026-10-15", &[]).is_err());
        let notice = "Your session has expired. Please run /login.";
        assert!(parse_reply(notice, "2026-10-15", &[])
            .unwrap_err()
            .contains("expected format"));
    }

    #[test]
    fn test_parse_reply_with_only_duplicates_is_not_an_error() {
        let existing = vec![candidate(
            "2026-10-15",
            "Fixed the login bug",
            CandidateState::Pending,
        )];
        let parsed = parse_reply("09:05 - Fixed the login bug | git", "2026-10-15", &existing);
        assert!(parsed.unwrap().is_empty());
    }

    #[test]
    fn test_parse_reply_drops_text_already_suggested_that_day() {
        let existing = vec![
            candidate(
                "2026-10-15",
                "Fixed the login bug",
                CandidateState::Rejected,
            ),
            candidate("2026-10-14", "Ran the tests", CandidateState::Pending),
        ];
        let reply = "09:05 - fixed the  login bug | git\n\
                     12:00 - Ran the tests | terminal\n\
                     12:05 - Ran the tests | terminal";
        let parsed = parse_reply(reply, "2026-10-15", &existing).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].text, "Ran the tests");
        assert_eq!(parsed[0].time.as_deref(), Some("12:00"));
    }

    // --- run_with ---

    /// Fake sources: canned activity and replies, recording every call.
    #[derive(Default)]
    struct Fake {
        items: Vec<ActivityItem>,
        existing: Vec<Candidate>,
        /// Replies by date; a missing date fails the call.
        replies: BTreeMap<String, String>,
        windows: StdMutex<Vec<(DateTime<Utc>, DateTime<Utc>)>>,
        asked: StdMutex<Vec<(Vec<String>, String)>>,
        added: StdMutex<Vec<NewCandidate>>,
    }

    impl RunSources for Fake {
        async fn collect(
            &self,
            start: DateTime<Utc>,
            end: DateTime<Utc>,
            _projects: &[String],
        ) -> Vec<ActivityItem> {
            self.windows.lock().unwrap().push((start, end));
            self.items.clone()
        }

        async fn candidates(&self, date: &str) -> Result<Vec<Candidate>, String> {
            Ok(self
                .existing
                .iter()
                .filter(|c| c.date == date)
                .cloned()
                .collect())
        }

        async fn ask_claude(&self, args: &[String], input: &str) -> Result<String, String> {
            self.asked
                .lock()
                .unwrap()
                .push((args.to_vec(), input.to_string()));
            let date = input
                .lines()
                .next()
                .and_then(|l| l.strip_prefix("Date: "))
                .unwrap_or("");
            self.replies
                .get(date)
                .cloned()
                .ok_or_else(|| "timed out".to_string())
        }

        async fn add(&self, new: Vec<NewCandidate>) -> Result<usize, String> {
            let count = new.len();
            self.added.lock().unwrap().extend(new);
            Ok(count)
        }
    }

    fn journal_with(last_run_at: Option<String>, model: Option<&str>) -> WorkJournal {
        let mut journal = WorkJournal::default();
        journal.settings.last_run_at = last_run_at;
        journal.settings.model = model.map(str::to_string);
        journal
    }

    #[tokio::test]
    async fn test_run_without_activity_never_asks_claude() {
        let fake = Fake::default();
        let report = run_with(&fake, &journal_with(None, None), &[], now()).await;
        assert_eq!(report.added, 0);
        assert_eq!(report.covered_until, now());
        assert!(report.error.is_none());
        assert!(fake.asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_run_adds_candidates_per_date_with_time_text_and_source() {
        let mut fake = Fake {
            items: vec![
                item("2026-10-14", "23:10", CandidateSource::Git, "Commit a"),
                item(
                    "2026-10-15",
                    "09:05",
                    CandidateSource::Github,
                    "Merged PR #3",
                ),
            ],
            existing: vec![candidate(
                "2026-10-15",
                "Already there",
                CandidateState::Pending,
            )],
            ..Fake::default()
        };
        fake.replies
            .insert("2026-10-14".into(), "23:10 - Committed a | git".into());
        fake.replies.insert(
            "2026-10-15".into(),
            "09:05 - Merged the PR | github\n09:06 - already there | github\nnoise".into(),
        );
        let mut journal = journal_with(Some((now() - TimeDelta::hours(5)).to_rfc3339()), None);
        journal.pages.insert(
            "2026-10-15".into(),
            WorkJournalPage {
                date: "2026-10-15".into(),
                title: "Thursday".into(),
                body: json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "08:00 - Standup"}]}]}),
                origin: PageOrigin::Auto,
            },
        );

        let report = run_with(&fake, &journal, &["C:\\git\\p".to_string()], now()).await;

        assert_eq!(report.added, 2);
        assert_eq!(report.dates, vec!["2026-10-14", "2026-10-15"]);
        assert_eq!(report.covered_until, now());
        assert!(report.error.is_none());
        assert_eq!(
            *fake.windows.lock().unwrap(),
            vec![(now() - TimeDelta::hours(5), now())]
        );
        let added = fake.added.lock().unwrap();
        assert_eq!(added.len(), 2);
        assert_eq!(added[1].date, "2026-10-15");
        assert_eq!(added[1].time.as_deref(), Some("09:05"));
        assert_eq!(added[1].text, "Merged the PR");
        assert_eq!(added[1].source, CandidateSource::Github);
        let asked = fake.asked.lock().unwrap();
        assert_eq!(asked.len(), 2);
        assert!(asked[1].1.contains("08:00 - Standup"));
        assert!(asked[1].1.contains("Already there"));
        assert!(!asked[0].1.contains("08:00 - Standup"));
    }

    /// The start of `date` as a run starting at `start` records it.
    fn date_start(date: &str, start: DateTime<Utc>) -> DateTime<Utc> {
        start_of_local_date(date).unwrap().max(start)
    }

    #[tokio::test]
    async fn test_run_failure_keeps_earlier_dates_and_resumes_at_the_failed_date() {
        let mut fake = Fake {
            items: vec![
                item("2026-10-14", "23:10", CandidateSource::Git, "Commit a"),
                item("2026-10-15", "09:05", CandidateSource::Git, "Commit b"),
            ],
            ..Fake::default()
        };
        fake.replies
            .insert("2026-10-14".into(), "23:10 - Committed a | git".into());
        let start = now() - TimeDelta::days(2);
        let journal = journal_with(Some(start.to_rfc3339()), None);

        let report = run_with(&fake, &journal, &[], now()).await;

        assert_eq!(report.added, 1);
        assert_eq!(report.dates, vec!["2026-10-14"]);
        let error = report.error.unwrap();
        assert!(error.contains("2026-10-15") && error.contains("timed out"));
        assert_eq!(report.covered_until, date_start("2026-10-15", start));
    }

    #[tokio::test]
    async fn test_run_failure_on_the_first_date_covers_from_that_date_start() {
        let fake = Fake {
            items: vec![item(
                "2026-10-14",
                "11:05",
                CandidateSource::Git,
                "Commit b",
            )],
            ..Fake::default()
        };
        let start = now() - TimeDelta::days(2);
        let journal = journal_with(Some(start.to_rfc3339()), None);
        let report = run_with(&fake, &journal, &[], now()).await;
        assert_eq!(report.added, 0);
        assert!(report.error.is_some());
        assert_eq!(report.covered_until, date_start("2026-10-14", start));
        assert!(report.covered_until < now());
    }

    #[tokio::test]
    async fn test_run_failure_on_the_first_date_still_runs_the_later_dates() {
        let mut fake = Fake {
            items: vec![
                item("2026-10-14", "23:10", CandidateSource::Git, "Commit a"),
                item("2026-10-15", "09:05", CandidateSource::Git, "Commit b"),
            ],
            ..Fake::default()
        };
        fake.replies
            .insert("2026-10-15".into(), "09:05 - Committed b | git".into());
        let start = now() - TimeDelta::days(2);
        let journal = journal_with(Some(start.to_rfc3339()), None);

        let report = run_with(&fake, &journal, &[], now()).await;

        assert_eq!(report.added, 1);
        assert_eq!(report.dates, vec!["2026-10-15"]);
        assert_eq!(fake.added.lock().unwrap()[0].text, "Committed b");
        assert!(report.error.unwrap().contains("2026-10-14"));
        assert_eq!(report.covered_until, date_start("2026-10-14", start));
    }

    #[tokio::test]
    async fn test_run_with_an_unusable_reply_fails_that_date() {
        let mut fake = Fake {
            items: vec![item(
                "2026-10-14",
                "11:05",
                CandidateSource::Git,
                "Commit b",
            )],
            ..Fake::default()
        };
        fake.replies.insert(
            "2026-10-14".into(),
            "Here you go:\n- 11:05 - Committed b | git".into(),
        );
        let start = now() - TimeDelta::days(2);
        let journal = journal_with(Some(start.to_rfc3339()), None);
        let report = run_with(&fake, &journal, &[], now()).await;
        assert_eq!(report.added, 0);
        assert!(report
            .error
            .unwrap()
            .contains("no line in the expected format"));
        assert_eq!(report.covered_until, date_start("2026-10-14", start));
        assert!(fake.added.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_run_with_last_run_now_does_nothing() {
        let fake = Fake {
            items: vec![item(
                "2026-10-15",
                "11:05",
                CandidateSource::Git,
                "Commit b",
            )],
            ..Fake::default()
        };
        let journal = journal_with(Some(now().to_rfc3339()), None);
        let report = run_with(&fake, &journal, &[], now()).await;
        // The fake ignores the window, so it is checked directly.
        assert_eq!(*fake.windows.lock().unwrap(), vec![(now(), now())]);
        assert_eq!(report.covered_until, now());
    }

    // --- run_process ---

    /// A program that never reads its stdin and lives well past the limit.
    fn idle_program() -> (&'static str, Vec<String>) {
        if cfg!(windows) {
            ("ping", vec!["-n".into(), "30".into(), "127.0.0.1".into()])
        } else {
            ("sleep", vec!["30".into()])
        }
    }

    #[tokio::test]
    async fn test_run_process_times_out_when_the_child_never_reads_stdin() {
        let (program, args) = idle_program();
        // Far more than a pipe holds, so the write itself would block.
        let input = "x".repeat(4 * 1024 * 1024);
        let started = std::time::Instant::now();
        let result = run_process(program, &args, &input, Duration::from_secs(1)).await;
        let err = result.unwrap_err();
        assert!(err.contains("did not answer within 1s"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(15));
    }

    #[tokio::test]
    async fn test_run_passes_the_model_and_refuses_a_bad_one() {
        let mut fake = Fake {
            items: vec![item(
                "2026-10-15",
                "11:05",
                CandidateSource::Git,
                "Commit b",
            )],
            ..Fake::default()
        };
        fake.replies.insert("2026-10-15".into(), "NONE".into());
        let report = run_with(&fake, &journal_with(None, Some("haiku")), &[], now()).await;
        assert_eq!(report.added, 0);
        assert!(report.error.is_none());
        assert!(fake.asked.lock().unwrap()[0]
            .0
            .contains(&"haiku".to_string()));

        let fake = Fake::default();
        let report = run_with(&fake, &journal_with(None, Some("a b")), &[], now()).await;
        assert!(report.error.is_some());
        assert_eq!(report.covered_until, now() - TimeDelta::hours(1));
        assert!(fake.windows.lock().unwrap().is_empty());
    }

    #[test]
    fn test_only_one_run_at_a_time() {
        let first = try_begin_run().expect("free");
        assert!(try_begin_run().is_none());
        drop(first);
        assert!(try_begin_run().is_some());
    }
}
