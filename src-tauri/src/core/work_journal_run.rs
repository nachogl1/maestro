//! The Work Journal's candidate run (issue #313): every few hours while
//! Maestro is open, on start (catching up since the last run) and on "Run
//! now", a headless `claude -p` turns the window's activity into one-line
//! candidates and stores them as pending in the temporary activity file.
//!
//! PRD "Candidates": the run is given, per date, that date's activity, its
//! page text and its pending and rejected candidates (same-day duplicate
//! removal only, never older pages). The reply contract is one candidate per
//! line, `HH:MM - action | source`, parsed strictly. When the user opted in
//! to Granola and it is connected (issue #315), a run may also read that
//! date's meetings and reply `Meeting - <title>: <outcome> | granola` for a
//! meeting without a time.
//!
//! The pure pieces ([`run_window`], [`page_text`], [`claude_args`],
//! [`build_prompt`], [`parse_reply`]) are unit-tested; the run itself reaches
//! the outside world through [`RunSources`], so tests use fakes and never
//! start the real `claude` CLI.

use std::collections::{BTreeMap, HashSet};
use std::process::Stdio;
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDate, Offset, SubsecRound, TimeDelta, TimeZone, Utc};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Child;
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

/// One `claude` call per date when Granola is on: listing and reading the
/// day's meetings are extra tool calls, each a network round trip.
const GRANOLA_RUN_TIMEOUT: Duration = Duration::from_secs(300);

/// `claude mcp list` health-checks every MCP server the user has; anything
/// past this means "Granola off" for the run.
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(30);

/// The only Granola tools a run may call: the read tools, listed one by one
/// (never a wildcard; never transcripts, attachments, search, sign-out or
/// switching workspace).
pub const GRANOLA_TOOLS: [&str; 2] = ["mcp__granola__list_meetings", "mcp__granola__get_meetings"];

/// Granola tools a Granola run denies by name, so a user's own "always
/// allow" rule for one of them never reaches the run (a deny beats an
/// allow): transcripts, attachments, search, sign-out, switching
/// workspace, meeting folders and account info.
pub const GRANOLA_DENIED_TOOLS: [&str; 7] = [
    "mcp__granola__get_meeting_transcript",
    "mcp__granola__get_meeting_attachment",
    "mcp__granola__sign_out",
    "mcp__granola__switch_workspace",
    "mcp__granola__query_granola_meetings",
    "mcp__granola__list_meeting_folders",
    "mcp__granola__get_account_info",
];

/// Granola's official MCP server (the URL the PRD's setup command adds),
/// used when the user's `granola` line in `claude mcp list` names no
/// `https://` URL of its own.
pub const GRANOLA_URL: &str = "https://mcp.granola.ai/mcp";

/// How far before the run's window a meeting may start and still count, so
/// a meeting whose notes were not written yet at the last run is read once
/// they are (the fed-back candidates stop repeats).
const MEETING_LOOKBACK: TimeDelta = TimeDelta::hours(3);

/// The positional prompt; the run's real input goes in on stdin.
const USER_PROMPT: &str = "Write Work Journal lines for the activity given on stdin.";

/// A full `--system-prompt` (not an appended one), replacing Claude Code's
/// default prompt. It does NOT keep the user's own CLAUDE.md out (checked
/// with Claude Code 2.1.300); `--safe-mode` or `--setting-sources ""` does
/// (see [`claude_args`]), or it breaks the reply format (issue #97).
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

/// The rules added to [`SYSTEM_PROMPT`] when Granola is on for a run. The
/// input then ends with the date's meetings window and UTC offset (see
/// [`granola_input`]).
const GRANOLA_RULES: &str = "Meetings: this run also has two Granola tools, \
mcp__granola__list_meetings and mcp__granola__get_meetings.\n\
- List the meetings held on the date given, then read with mcp__granola__get_meetings \
only the meetings whose meeting_at falls inside the meetings window given at the end of \
the input. A meeting without meeting_at may be read in any run. Skip meetings held on any \
other date.\n\
- Write one line per meeting worth a journal line, in the form: HH:MM - Meeting: <title>, \
<outcome> | granola\n\
- HH:MM is the meeting's meeting_at time in local time (the input gives the date's UTC \
offset), 24-hour.\n\
- If a meeting has no meeting_at time, write instead: Meeting - <title>: <outcome> | granola\n\
- outcome is a few words in your own words on what was decided or done. Never quote or copy \
the meeting notes.\n\
- The source tag granola is only for meeting lines.";

/// The system prompt for a run: [`SYSTEM_PROMPT`] as is when Granola is
/// off, plus [`GRANOLA_RULES`] when it is on.
pub fn system_prompt(granola: bool) -> String {
    if granola {
        format!("{SYSTEM_PROMPT}\n{GRANOLA_RULES}")
    } else {
        SYSTEM_PROMPT.to_string()
    }
}

/// The `<target>` when `claude mcp list` output says the `granola` server is
/// connected: its line is `granola: <target> - <tick> Connected`, where the
/// tick is U+2714. The CLI prints U+221A instead when it thinks the console
/// has no Unicode (as for a child of a GUI app on Windows, seen with Claude
/// Code 2.1.300), so both count. Any other status (`! Needs
/// authentication`, `<cross> Failed to connect`, `! Connected - tools fetch
/// failed`), another server, or no `granola` line at all is "not
/// connected" (`None`).
fn connected_granola_target(output: &str) -> Option<&str> {
    output.lines().find_map(|line| {
        let (name, rest) = line.trim().split_once(": ")?;
        let (target, status) = rest.rsplit_once(" - ")?;
        (name.trim() == "granola"
            && matches!(status.trim(), "\u{2714} Connected" | "\u{221A} Connected"))
        .then(|| target.trim())
    })
}

/// The URL a Granola run reaches Granola at, from `claude mcp list` output:
/// the user's own server (`granola: <url> (HTTP) - <tick> Connected`) when
/// it is an `https://` URL, so the run reuses their stored sign-in, else
/// [`GRANOLA_URL`]. `None` when Granola is not connected.
pub fn parse_granola_url(output: &str) -> Option<String> {
    let target = connected_granola_target(output)?;
    let own = target
        .strip_suffix(" (HTTP)")
        .map(str::trim)
        .filter(|url| url.starts_with("https://") && !url.contains(char::is_whitespace));
    Some(own.unwrap_or(GRANOLA_URL).to_string())
}

/// The preflight: runs `claude mcp list` and says whether Granola is
/// connected. Every failure (no CLI, a timeout, an error exit) is "not
/// connected"; nothing but that outcome is logged.
pub async fn granola_preflight() -> bool {
    granola_preflight_url().await.is_some()
}

/// [`granola_preflight`], giving the URL to reach Granola at (see
/// [`parse_granola_url`]); `None` = not connected.
pub async fn granola_preflight_url() -> Option<String> {
    let args = ["mcp".to_string(), "list".to_string()];
    match run_process("claude", &args, "", PREFLIGHT_TIMEOUT, false).await {
        Ok(output) => {
            let url = parse_granola_url(&output);
            let outcome = if url.is_some() {
                "connected"
            } else {
                "not connected"
            };
            log::info!("Work journal: Granola preflight: {outcome}");
            url
        }
        Err(_) => {
            log::info!("Work journal: Granola preflight: failed");
            None
        }
    }
}

/// The UTC offset `tz` has at local noon of `date`, as `+01:00`: per date,
/// so a catch-up across a clock change gives each day its own offset.
fn utc_offset_on<Tz: TimeZone>(tz: &Tz, date: NaiveDate) -> Option<String> {
    let noon = tz
        .from_local_datetime(&date.and_hms_opt(12, 0, 0)?)
        .earliest()?;
    Some(noon.offset().fix().to_string())
}

/// The part of `[start, end)`, widened back by [`MEETING_LOOKBACK`], that
/// falls on `date` in `tz`, as local `HH:MM` (`24:00` for the end of the
/// day). `None` when it misses the date.
fn meetings_window_on<Tz: TimeZone>(
    tz: &Tz,
    date: NaiveDate,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Option<(String, String)>
where
    Tz::Offset: std::fmt::Display,
{
    let day_start = tz
        .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
        .earliest()?
        .with_timezone(&Utc);
    let next_day = date.succ_opt()?.and_hms_opt(0, 0, 0)?;
    let day_end = tz
        .from_local_datetime(&next_day)
        .earliest()?
        .with_timezone(&Utc);
    let from = (start - MEETING_LOOKBACK).max(day_start);
    let to = end.min(day_end);
    if from >= to {
        return None;
    }
    let local = |at: DateTime<Utc>| at.with_timezone(tz).format("%H:%M").to_string();
    let to = if to == day_end {
        "24:00".to_string()
    } else {
        local(to)
    };
    Some((local(from), to))
}

/// The lines a Granola run adds to a date's input: the meetings window and
/// the date's UTC offset, in the user's time zone.
fn granola_input(date: &str, start: DateTime<Utc>, end: DateTime<Utc>) -> String {
    granola_input_in(&Local, date, start, end)
}

fn granola_input_in<Tz: TimeZone>(
    tz: &Tz,
    date: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let Ok(day) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
        return String::new();
    };
    let offset = utc_offset_on(tz, day).unwrap_or_else(|| "+00:00".to_string());
    let (from, to) = meetings_window_on(tz, day, start, end)
        .unwrap_or_else(|| ("00:00".to_string(), "24:00".to_string()));
    format!(
        "\n\nMeetings window for this date (local time, UTC{offset}): {from} to {to}. Read only \
         meetings whose meeting_at falls inside it; a meeting without meeting_at may be read \
         in any run."
    )
}

/// The source tags a reply line may carry; `granola` only when Granola was
/// on for the call (see [`parse_line`]).
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
pub(crate) fn is_safe_model(model: &str) -> bool {
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
///
/// `granola` is the URL to reach Granola at (`None` = Granola off). The
/// user's own setup never reaches a run (checked with Claude Code 2.1.300;
/// `--system-prompt` alone lets the user's CLAUDE.md in):
/// - Granola off: `--safe-mode` (no CLAUDE.md, hooks, skills, plugins or
///   MCP servers; sign-in and model selection still work), as the report
///   run does, plus `--strict-mcp-config`.
/// - Granola on: `--safe-mode` would turn Granola off too (it drops even a
///   server given by `--mcp-config`), so `--setting-sources ""` instead: no
///   CLAUDE.md, and no user, project or local settings (so no hooks,
///   plugins or "always allow" rules). `--strict-mcp-config` with an
///   `--mcp-config` naming only the `granola` server at `granola` (which
///   reuses the stored sign-in) loads no other MCP server. The system prompt
///   carries the Granola rules, the two [`GRANOLA_TOOLS`] are allowed, the
///   [`GRANOLA_DENIED_TOOLS`] are denied by name, and `--permission-mode
///   dontAsk` denies everything not allowed. `--mcp-config`,
///   `--allowedTools` and `--disallowedTools` take several values, so each
///   is followed by another flag, and `--permission-mode` ends the lists
///   before the prompt.
pub fn claude_args(model: Option<&str>, granola: Option<&str>) -> Result<Vec<String>, String> {
    let confine: &[&str] = match granola {
        None => &["--safe-mode"],
        Some(_) => &["--setting-sources", ""],
    };
    let mut args: Vec<String> = ["-p"]
        .iter()
        .chain(confine)
        .chain(&[
            "--tools",
            "",
            "--no-session-persistence",
            "--strict-mcp-config",
        ])
        .map(|arg| arg.to_string())
        .collect();
    if let Some(url) = granola {
        args.push("--mcp-config".to_string());
        args.push(granola_mcp_config(url));
    }
    args.push("--system-prompt".to_string());
    args.push(system_prompt(granola.is_some()));
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
    if granola.is_some() {
        args.push("--allowedTools".to_string());
        args.extend(GRANOLA_TOOLS.iter().map(|tool| tool.to_string()));
        args.push("--disallowedTools".to_string());
        args.extend(GRANOLA_DENIED_TOOLS.iter().map(|tool| tool.to_string()));
        args.push("--permission-mode".to_string());
        args.push("dontAsk".to_string());
    }
    args.push(USER_PROMPT.to_string());
    Ok(args)
}

/// The `--mcp-config` JSON for a Granola run: only the `granola` HTTP
/// server at `url`.
fn granola_mcp_config(url: &str) -> String {
    serde_json::json!({ "mcpServers": { "granola": { "type": "http", "url": url } } }).to_string()
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
    // Only a Granola run asks about a date without activity (its meetings).
    let activity = if activity.is_empty() {
        "(none)".to_string()
    } else {
        activity.join("\n")
    };
    format!(
        "Date: {date}\n\n\
         Activity (HH:MM [source] project: text):\n{activity}\n\n\
         Already on the journal page for this date (do not repeat):\n{page}\n\n\
         Already suggested or rejected for this date (do not repeat):\n{suggested}\n\n\
         Reply with one line per new journal entry, HH:MM - action | source, or NONE."
    )
}

/// Comparison key for duplicate text: one line, lower case.
fn dedupe_key(text: &str) -> String {
    one_line(text).to_lowercase()
}

/// Parses one reply line, `HH:MM - action | source`; `None` when it does
/// not match. With `granola` on, `granola` is a valid source too, and a
/// meeting without a time, `Meeting - <title>: <outcome> | granola`, is a
/// candidate with no time whose text is the whole `Meeting - ...` part.
fn parse_line(line: &str, date: &str, granola: bool) -> Option<NewCandidate> {
    if granola {
        if let Some(candidate) = parse_untimed_meeting(line, date) {
            return Some(candidate);
        }
    }
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
        .chain(granola.then_some(CandidateSource::Granola))
        .find(|s| source_tag(*s).eq_ignore_ascii_case(source))?;
    Some(NewCandidate {
        date: date.to_string(),
        time: Some(time.to_string()),
        text: action,
        source,
    })
}

/// The time-less meeting line `Meeting - <title>: <outcome> | granola`.
fn parse_untimed_meeting(line: &str, date: &str) -> Option<NewCandidate> {
    let (text, source) = line.trim().rsplit_once('|')?;
    if !source
        .trim()
        .eq_ignore_ascii_case(source_tag(CandidateSource::Granola))
    {
        return None;
    }
    let text = one_line(text);
    let (head, rest) = text.split_once(" - ")?;
    if !head.eq_ignore_ascii_case("Meeting") || rest.trim().is_empty() {
        return None;
    }
    Some(NewCandidate {
        date: date.to_string(),
        time: None,
        text,
        source: CandidateSource::Granola,
    })
}

/// Reads the reply strictly: one candidate per `HH:MM - action | source`
/// line (and, with `granola` on, per `Meeting - ... | granola` line; see
/// [`parse_line`]); other lines are dropped (logged at debug). `NONE`
/// yields nothing.
/// A line whose text equals (ignoring case and spacing) an existing
/// candidate's text for `date`, or an earlier line's, is dropped.
///
/// A reply without one line in the format and without `NONE` (empty,
/// markdown bullets, a notice printed instead of an answer) is an error, so
/// the date is tried again on the next run instead of being marked done.
/// Its first characters are logged at debug, except when Granola was on:
/// the reply could then echo meeting notes, which never reach a log.
pub fn parse_reply(
    reply: &str,
    date: &str,
    existing: &[Candidate],
    granola: bool,
) -> Result<Vec<NewCandidate>, String> {
    let mut seen: HashSet<String> = existing
        .iter()
        .filter(|c| c.date == date)
        .map(|c| dedupe_key(&c.text))
        .collect();
    let mut parsed = Vec::new();
    let mut matched = 0;
    let mut said_none = false;
    for line in reply.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.eq_ignore_ascii_case("NONE") {
            said_none = true;
            continue;
        }
        let Some(candidate) = parse_line(trimmed, date, granola) else {
            log::debug!("Work journal: dropped a candidate reply line that does not match");
            continue;
        };
        matched += 1;
        if seen.insert(dedupe_key(&candidate.text)) {
            parsed.push(candidate);
        } else {
            log::debug!("Work journal: dropped a duplicate candidate for {date}");
        }
    }
    if matched == 0 && !said_none {
        if granola {
            // The reply could echo meeting notes: only the fact is logged.
            log::debug!("Work journal: unusable candidate reply for {date}");
        } else {
            // Only the reply is logged, never the activity sent with it.
            let head: String = reply.trim().chars().take(REPLY_LOG_CHARS).collect();
            log::debug!("Work journal: unusable candidate reply for {date}: {head}");
        }
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
    /// `granola`: Granola is on for the call (longer timeout, and no reply
    /// text in the error, see [`run_claude`]).
    async fn ask_claude(
        &self,
        args: &[String],
        input: &str,
        granola: bool,
    ) -> Result<String, String>;
    async fn add(&self, new: Vec<NewCandidate>) -> Result<usize, String>;
    /// The Granola preflight (see [`granola_preflight_url`]): the URL to
    /// reach Granola at, `None` = not connected.
    async fn granola_url(&self) -> Option<String>;
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

    async fn ask_claude(
        &self,
        args: &[String],
        input: &str,
        granola: bool,
    ) -> Result<String, String> {
        run_claude(args, input, granola).await
    }

    async fn add(&self, new: Vec<NewCandidate>) -> Result<usize, String> {
        add_candidates(&activity_dir(), new)
            .await
            .map(|added| added.len())
            .map_err(|e| e.to_string())
    }

    async fn granola_url(&self) -> Option<String> {
        granola_preflight_url().await
    }
}

/// Runs `claude` with `args` from the temp dir (so no project CLAUDE.md is
/// picked up), `input` on stdin, a timeout and a hidden console on Windows.
/// The child is killed if the run is dropped or times out. With `granola`
/// on, the timeout is [`GRANOLA_RUN_TIMEOUT`] and a failed exit's error
/// never quotes the output (it could hold meeting notes).
async fn run_claude(args: &[String], input: &str, granola: bool) -> Result<String, String> {
    if granola {
        run_process("claude", args, input, GRANOLA_RUN_TIMEOUT, false).await
    } else {
        run_process("claude", args, input, RUN_TIMEOUT, true)
            .await
            .map_err(safe_mode_error)
    }
}

/// Maps a failed run of a `claude` too old for `--safe-mode` (`error:
/// unknown option '--safe-mode'`) to a plain "update Claude Code" message;
/// any other error is kept. Never retried without `--safe-mode`.
fn safe_mode_error(message: String) -> String {
    let lower = message.to_lowercase();
    if lower.contains("unknown option") && lower.contains("--safe-mode") {
        "Your Claude Code is too old for Work Journal suggestions (it does not know \
         --safe-mode). Update Claude Code and try again."
            .to_string()
    } else {
        message
    }
}

/// Runs `program` with `input` on stdin and returns its stdout, within
/// `limit` (see [`exchange`]). Also used by the supervisor report
/// ([`crate::core::work_journal_report`]).
pub(crate) async fn run_process(
    program: &str,
    args: &[String],
    input: &str,
    limit: Duration,
    quote_output: bool,
) -> Result<String, String> {
    let mut child = spawn_process(program, args)?;
    exchange(&mut child, input, limit, quote_output).await
}

/// Starts `program` from the temp dir with piped stdio, a hidden console on
/// Windows, and `kill_on_drop` as a last resort.
fn spawn_process(program: &str, args: &[String]) -> Result<Child, String> {
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
    cmd.spawn()
        .map_err(|e| format!("could not start the claude CLI ({e})"))
}

/// Sends `input` to `child`, reads its output and waits for its exit, all
/// under ONE `timeout`: a child that never reads stdin (a pipe holds only a
/// few KB) cannot hold the run (and its one-run lock) past `limit`. On
/// timeout the child is killed here and reaped before returning. A failed
/// exit's error quotes the start of stderr (or stdout) only when
/// `quote_output` is set.
async fn exchange(
    child: &mut Child,
    input: &str,
    limit: Duration,
    quote_output: bool,
) -> Result<String, String> {
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // Write, read and wait side by side, so a child that fills stdout before
    // it reads stdin cannot deadlock either. `stdin` is dropped after the
    // write, which closes it and lets the child see the end of the input.
    let send = async move {
        if let Some(mut stdin) = stdin {
            stdin.write_all(input.as_bytes()).await?;
        }
        Ok::<(), std::io::Error>(())
    };
    let read_out = read_all(stdout);
    let read_err = read_all(stderr);
    let timed = tokio::time::timeout(limit, async {
        tokio::join!(send, read_out, read_err, child.wait())
    })
    .await;
    let Ok((sent, stdout, stderr, status)) = timed else {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(KILL_WAIT, child.wait()).await;
        return Err(format!("claude did not answer within {}s", limit.as_secs()));
    };
    let status = status.map_err(|e| format!("claude run failed ({e})"))?;
    let stdout = stdout.map_err(|e| format!("claude run failed ({e})"))?;
    if !status.success() {
        if !quote_output {
            return Err(format!("claude exited with {status}"));
        }
        let stderr = String::from_utf8_lossy(stderr.as_deref().unwrap_or_default());
        let stdout = String::from_utf8_lossy(&stdout);
        let detail = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        let detail: String = one_line(&detail).chars().take(300).collect();
        return Err(format!("claude exited with {status}: {detail}"));
    }
    // Checked after the exit status, which says more when the child quit
    // early; a reply to half the input is never used.
    sent.map_err(|e| format!("could not send the activity to claude ({e})"))?;
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

/// How long a killed child is waited for before giving up on reaping it.
const KILL_WAIT: Duration = Duration::from_secs(5);

/// Reads a pipe to its end (nothing when the pipe is absent).
async fn read_all(pipe: Option<impl AsyncRead + Unpin>) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut buf).await?;
    }
    Ok(buf)
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
    // One preflight per run, and only for a "yes": a "no" or a choice not
    // made yet never even checks Granola.
    let granola_url = if start < end && settings.granola_opt_in == Some(true) {
        sources.granola_url().await
    } else {
        None
    };
    let granola = granola_url.is_some();
    let args = match claude_args(settings.model.as_deref(), granola_url.as_deref()) {
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
    // Meetings happen on days without other activity too, so with Granola on
    // every local date the window touches gets its call.
    if granola {
        for date in local_dates(start, end) {
            by_date.entry(date).or_default();
        }
    }

    // A failed date does not stop the run: later dates (today included) still
    // get their candidates. `covered_until` stops at the earliest failed
    // date, so it and every later date run again next time; the later dates
    // then get their own candidates fed back, which bounds repeats.
    let mut earliest_failed: Option<DateTime<Utc>> = None;
    let mut errors: Vec<String> = Vec::new();
    for (date, items) in by_date {
        let window = granola.then_some((start, end));
        match run_date(sources, journal, &args, window, &date, &items).await {
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

/// The local dates (`YYYY-MM-DD`) the window `[start, end)` touches, oldest
/// first; none for an empty window.
fn local_dates(start: DateTime<Utc>, end: DateTime<Utc>) -> Vec<String> {
    if start >= end {
        return Vec::new();
    }
    let first = start.with_timezone(&Local).date_naive();
    let last = (end - TimeDelta::seconds(1))
        .with_timezone(&Local)
        .date_naive();
    first
        .iter_days()
        .take_while(|day| *day <= last)
        .map(|day| day.format("%Y-%m-%d").to_string())
        .collect()
}

/// One `claude` call for one date; returns how many candidates were added.
/// `granola_window` is the run's window when Granola is on (`None` = off).
async fn run_date<S: RunSources>(
    sources: &S,
    journal: &WorkJournal,
    args: &[String],
    granola_window: Option<(DateTime<Utc>, DateTime<Utc>)>,
    date: &str,
    items: &[ActivityItem],
) -> Result<usize, String> {
    let existing = sources.candidates(date).await?;
    let page = journal
        .pages
        .get(date)
        .map(|page| page_text(&page.body))
        .unwrap_or_default();
    let mut input = build_prompt(date, items, &page, &existing);
    let granola = granola_window.is_some();
    if let Some((start, end)) = granola_window {
        input.push_str(&granola_input(date, start, end));
    }
    let reply = sources.ask_claude(args, &input, granola).await?;
    let valid: Vec<NewCandidate> = parse_reply(&reply, date, &existing, granola)?
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
        let args = claude_args(None, None).unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "--safe-mode",
                "--tools",
                "",
                "--no-session-persistence",
                "--strict-mcp-config",
                "--system-prompt",
                SYSTEM_PROMPT,
                USER_PROMPT
            ]
        );
        assert_eq!(claude_args(Some("  "), None).unwrap(), args);
    }

    #[test]
    fn test_claude_args_with_model_pass_it() {
        let args = claude_args(Some(" sonnet "), None).unwrap();
        let at = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[at + 1], "sonnet");
        assert_eq!(args.last().unwrap(), USER_PROMPT);
        assert!(claude_args(Some("claude-opus-5-5[1m]"), None).is_ok());
    }

    #[test]
    fn test_claude_args_never_bare_or_appended() {
        for model in [None, Some("haiku")] {
            let args = claude_args(model, None).unwrap();
            assert!(!args.iter().any(|a| a == "--bare"));
            assert!(!args.iter().any(|a| a == "--append-system-prompt"));
            assert!(args.iter().any(|a| a == "--no-session-persistence"));
        }
    }

    #[test]
    fn test_claude_args_refuse_an_unsafe_model_name() {
        let err = claude_args(Some("sonnet & calc"), None).unwrap_err();
        assert!(err.contains("not a valid model name"));
        assert!(claude_args(Some("--bare"), None).is_err());
        assert!(claude_args(Some("-p"), None).is_err());
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

    // --- Granola: command line and system prompt ---

    #[test]
    fn test_claude_args_without_granola_have_no_granola_flags_and_no_mcp_servers() {
        for model in [None, Some("haiku")] {
            let args = claude_args(model, None).unwrap();
            assert!(!args.iter().any(|a| a.contains("granola")), "{args:?}");
            assert!(!args.iter().any(|a| a == "--allowedTools"));
            assert!(!args.iter().any(|a| a == "--disallowedTools"));
            assert!(!args.iter().any(|a| a == "--permission-mode"));
            assert!(!args.iter().any(|a| a == "dontAsk"));
            assert!(!args.iter().any(|a| a == "--mcp-config"));
            assert!(args.iter().any(|a| a == "--strict-mcp-config"));
            assert!(
                args.iter().any(|a| a == "--safe-mode"),
                "no CLAUDE.md, hooks, plugins or MCP servers"
            );
            assert!(!args.iter().any(|a| a == "--setting-sources"));
            assert!(args.contains(&SYSTEM_PROMPT.to_string()));
            assert_eq!(args.last().unwrap(), USER_PROMPT);
        }
    }

    #[tokio::test]
    async fn test_every_granola_off_case_builds_the_same_command_line() {
        // Opt-in unset, opt-in no, and yes but not connected (a failed
        // preflight answers not connected too).
        let mut lines = Vec::new();
        for (opt_in, connected) in [(None, true), (Some(false), true), (Some(true), false)] {
            let mut fake = Fake {
                items: vec![item(
                    "2026-10-15",
                    "11:05",
                    CandidateSource::Git,
                    "Commit b",
                )],
                granola: connected,
                ..Fake::default()
            };
            fake.replies.insert("2026-10-15".into(), "NONE".into());
            let mut journal = journal_with(None, None);
            journal.settings.granola_opt_in = opt_in;
            run_with(&fake, &journal, &[], now()).await;
            lines.push(fake.asked.lock().unwrap()[0].clone());
        }
        assert!(lines.iter().all(|line| *line == lines[0]), "{lines:?}");
        assert_eq!(lines[0].0, claude_args(None, None).unwrap());
        assert!(!lines[0].1.contains("Meetings window"));
    }

    #[test]
    fn test_claude_args_with_granola_allow_exactly_the_two_read_tools() {
        let args = claude_args(Some("sonnet"), Some(GRANOLA_URL)).unwrap();
        let at = args.iter().position(|a| a == "--allowedTools").unwrap();
        assert_eq!(
            args[at..],
            [
                "--allowedTools",
                "mcp__granola__list_meetings",
                "mcp__granola__get_meetings",
                "--disallowedTools",
                "mcp__granola__get_meeting_transcript",
                "mcp__granola__get_meeting_attachment",
                "mcp__granola__sign_out",
                "mcp__granola__switch_workspace",
                "mcp__granola__query_granola_meetings",
                "mcp__granola__list_meeting_folders",
                "mcp__granola__get_account_info",
                "--permission-mode",
                "dontAsk",
                USER_PROMPT,
            ],
            "--permission-mode ends the tool lists, and the prompt stays last"
        );
        let allowed: Vec<&String> = args[at + 1..at + 3].iter().collect();
        assert_eq!(allowed, GRANOLA_TOOLS);
        assert!(!args.iter().any(|a| a.contains('*')), "never a wildcard");
        for denied in GRANOLA_DENIED_TOOLS {
            assert!(!allowed.iter().any(|a| *a == denied));
        }
        assert_eq!(
            args[..9],
            [
                "-p",
                "--setting-sources",
                "",
                "--tools",
                "",
                "--no-session-persistence",
                "--strict-mcp-config",
                "--mcp-config",
                r#"{"mcpServers":{"granola":{"type":"http","url":"https://mcp.granola.ai/mcp"}}}"#,
            ],
            "no settings files or CLAUDE.md, and Granola is the only MCP server"
        );
        assert_eq!(
            args[9], "--system-prompt",
            "a flag ends the --mcp-config list"
        );
        assert!(
            !args.iter().any(|a| a == "--safe-mode"),
            "safe mode would drop the Granola server too"
        );
        let tools = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[tools + 1], "", "--tools \"\" is kept");
        assert!(args.iter().any(|a| a == "--no-session-persistence"));
        assert!(!args.iter().any(|a| a == "--bare"));
        let model = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[model + 1], "sonnet");
        let prompt = args.iter().position(|a| a == "--system-prompt").unwrap();
        assert_eq!(args[prompt + 1], system_prompt(true));
    }

    #[test]
    fn test_claude_args_with_granola_use_the_url_given() {
        let args = claude_args(None, Some("https://eu.granola.example/mcp")).unwrap();
        let at = args.iter().position(|a| a == "--mcp-config").unwrap();
        let config: Value = serde_json::from_str(&args[at + 1]).unwrap();
        assert_eq!(
            config,
            serde_json::json!({ "mcpServers": { "granola": {
                "type": "http", "url": "https://eu.granola.example/mcp"
            } } })
        );
    }

    #[test]
    fn test_an_old_cli_without_safe_mode_gets_a_plain_message() {
        let err = safe_mode_error(
            "claude exited with exit code: 1: error: unknown option '--safe-mode'".into(),
        );
        assert_eq!(
            err,
            "Your Claude Code is too old for Work Journal suggestions (it does not know \
             --safe-mode). Update Claude Code and try again."
        );
        let other = "claude did not answer within 180s".to_string();
        assert_eq!(safe_mode_error(other.clone()), other);
        let unrelated = "error: unknown option '--frobnicate'".to_string();
        assert_eq!(safe_mode_error(unrelated.clone()), unrelated);
    }

    #[test]
    fn test_system_prompt_has_the_granola_rules_only_when_granola_is_on() {
        assert_eq!(system_prompt(false), SYSTEM_PROMPT);
        assert!(!system_prompt(false).contains("granola"));
        let on = system_prompt(true);
        assert!(on.starts_with(SYSTEM_PROMPT));
        for needle in [
            "mcp__granola__list_meetings",
            "mcp__granola__get_meetings",
            "HH:MM - Meeting: <title>, <outcome> | granola",
            "Meeting - <title>: <outcome> | granola",
            "meeting_at",
            "local time",
            "meetings window",
            "without meeting_at may be read in any run",
            "UTC offset",
            "Never quote",
            "any other date",
        ] {
            assert!(on.contains(needle), "missing {needle}");
        }
    }

    // --- Granola: meetings window and offset ---

    /// A UK-like zone for tests: UTC+01:00 until 2026-10-25 01:00 UTC, then
    /// UTC+00:00 (the 2026 autumn clock change).
    #[derive(Debug, Clone, Copy)]
    struct UkLike;

    impl UkLike {
        fn change() -> chrono::NaiveDateTime {
            NaiveDate::from_ymd_opt(2026, 10, 25)
                .unwrap()
                .and_hms_opt(1, 0, 0)
                .unwrap()
        }

        fn offset_at_utc(utc: &chrono::NaiveDateTime) -> chrono::FixedOffset {
            let hours = if *utc < Self::change() { 1 } else { 0 };
            chrono::FixedOffset::east_opt(hours * 3600).unwrap()
        }
    }

    impl TimeZone for UkLike {
        type Offset = chrono::FixedOffset;

        fn from_offset(_offset: &chrono::FixedOffset) -> Self {
            UkLike
        }

        fn offset_from_local_date(
            &self,
            local: &NaiveDate,
        ) -> chrono::LocalResult<chrono::FixedOffset> {
            self.offset_from_local_datetime(&local.and_hms_opt(12, 0, 0).unwrap())
        }

        fn offset_from_local_datetime(
            &self,
            local: &chrono::NaiveDateTime,
        ) -> chrono::LocalResult<chrono::FixedOffset> {
            // Good enough for tests away from the changeover hour itself.
            let summer = chrono::FixedOffset::east_opt(3600).unwrap();
            chrono::LocalResult::Single(Self::offset_at_utc(&(*local - summer)))
        }

        fn offset_from_utc_date(&self, utc: &NaiveDate) -> chrono::FixedOffset {
            Self::offset_at_utc(&utc.and_hms_opt(0, 0, 0).unwrap())
        }

        fn offset_from_utc_datetime(&self, utc: &chrono::NaiveDateTime) -> chrono::FixedOffset {
            Self::offset_at_utc(utc)
        }
    }

    fn day(date: &str) -> NaiveDate {
        NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap()
    }

    fn utc(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn test_utc_offset_is_taken_per_date_across_a_clock_change() {
        assert_eq!(utc_offset_on(&UkLike, day("2026-10-24")).unwrap(), "+01:00");
        assert_eq!(utc_offset_on(&UkLike, day("2026-10-26")).unwrap(), "+00:00");
        // One catch-up run across the change gives each date its own offset.
        let (start, end) = (utc("2026-10-24T08:00:00Z"), utc("2026-10-26T10:00:00Z"));
        assert!(granola_input_in(&UkLike, "2026-10-24", start, end).contains("UTC+01:00"));
        assert!(granola_input_in(&UkLike, "2026-10-26", start, end).contains("UTC+00:00"));
    }

    #[test]
    fn test_meetings_window_is_the_run_window_clipped_to_the_date() {
        let utc_zone = Utc;
        // An hourly run: the window, widened back by the lookback.
        assert_eq!(
            meetings_window_on(
                &utc_zone,
                day("2026-10-15"),
                utc("2026-10-15T11:00:00Z"),
                utc("2026-10-15T12:00:00Z")
            ),
            Some(("08:00".to_string(), "12:00".to_string()))
        );
        // Early in the day the lookback stops at midnight.
        assert_eq!(
            meetings_window_on(
                &utc_zone,
                day("2026-10-15"),
                utc("2026-10-15T01:00:00Z"),
                utc("2026-10-15T02:00:00Z")
            ),
            Some(("00:00".to_string(), "02:00".to_string()))
        );
        // A catch-up over two days: the first date to its end, the second
        // from midnight; a date the window misses has none.
        let (start, end) = (utc("2026-10-14T16:00:00Z"), utc("2026-10-15T09:30:00Z"));
        assert_eq!(
            meetings_window_on(&utc_zone, day("2026-10-14"), start, end),
            Some(("13:00".to_string(), "24:00".to_string()))
        );
        assert_eq!(
            meetings_window_on(&utc_zone, day("2026-10-15"), start, end),
            Some(("00:00".to_string(), "09:30".to_string()))
        );
        assert_eq!(
            meetings_window_on(&utc_zone, day("2026-10-16"), start, end),
            None
        );
        // Local time, not UTC.
        assert_eq!(
            meetings_window_on(
                &UkLike,
                day("2026-10-15"),
                utc("2026-10-15T11:00:00Z"),
                utc("2026-10-15T12:00:00Z")
            ),
            Some(("09:00".to_string(), "13:00".to_string()))
        );
    }

    #[test]
    fn test_granola_input_states_the_window_and_the_rule() {
        let input = granola_input_in(
            &UkLike,
            "2026-10-15",
            utc("2026-10-15T11:00:00Z"),
            utc("2026-10-15T12:00:00Z"),
        );
        assert_eq!(
            input,
            "\n\nMeetings window for this date (local time, UTC+01:00): 09:00 to 13:00. Read \
             only meetings whose meeting_at falls inside it; a meeting without meeting_at may \
             be read in any run."
        );
    }

    // --- Granola: preflight ---

    fn parse_granola_connected(output: &str) -> bool {
        connected_granola_target(output).is_some()
    }

    #[test]
    fn test_parse_granola_connected_reads_the_mcp_list_line() {
        let connected = "Checking MCP server health\u{2026}\n\n\
            playwright: npx @playwright/mcp@latest - \u{2714} Connected\n\
            granola: https://mcp.granola.ai/mcp (HTTP) - \u{2714} Connected\n";
        assert!(parse_granola_connected(connected));
        let ascii_tick = "granola: https://mcp.granola.ai/mcp (HTTP) - \u{221A} Connected";
        assert!(
            parse_granola_connected(ascii_tick),
            "the CLI's non-Unicode tick"
        );
        assert!(parse_granola_connected(
            "granola: https://mcp.granola.ai/mcp (HTTP) - \u{2714} Connected\r\n"
        ));
    }

    #[test]
    fn test_parse_granola_url_takes_the_users_own_https_url() {
        let output = "playwright: npx @playwright/mcp@latest - \u{2714} Connected\n\
            granola: https://eu.granola.example/mcp (HTTP) - \u{2714} Connected\n";
        assert_eq!(
            parse_granola_url(output).as_deref(),
            Some("https://eu.granola.example/mcp")
        );
        for fallback in [
            "granola: https://mcp.granola.ai/mcp (HTTP) - \u{221A} Connected",
            "granola: npx granola-proxy - \u{2714} Connected",
            "granola: https://mcp.granola.ai/sse (SSE) - \u{2714} Connected",
            "granola: http://localhost:9000/mcp (HTTP) - \u{2714} Connected",
        ] {
            assert_eq!(
                parse_granola_url(fallback).as_deref(),
                Some(GRANOLA_URL),
                "{fallback:?}"
            );
        }
        assert_eq!(
            parse_granola_url(
                "granola: https://mcp.granola.ai/mcp (HTTP) - ! Needs authentication"
            ),
            None
        );
    }

    #[test]
    fn test_granola_not_connected_for_any_other_status_or_server() {
        for output in [
            "granola: https://mcp.granola.ai/mcp (HTTP) - ! Needs authentication",
            "granola: https://mcp.granola.ai/mcp (HTTP) - \u{2718} Failed to connect",
            "granola: https://mcp.granola.ai/mcp (HTTP) - ! Connected \u{b7} tools fetch failed",
            "playwright: npx @playwright/mcp@latest - \u{2714} Connected\n\
             railway: npx railway - ! Needs authentication",
            "claude.ai Granola: https://claude.ai/granola - \u{2714} Connected",
            "granola-old: https://example.com/mcp (HTTP) - \u{2714} Connected",
            "No MCP servers configured. Use `claude mcp add` to add a server.",
            "",
            "\u{fffd}\u{fffd} garbage - - : Connected",
            "granola Connected",
        ] {
            assert!(!parse_granola_connected(output), "{output:?}");
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
        let parsed = parse_reply(reply, "2026-10-15", &[], false).unwrap();
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
        let parsed = parse_reply(reply, "2026-10-15", &[], false).unwrap();
        let texts: Vec<&str> = parsed.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(
            texts,
            vec!["Reviewed a PR - with a dash | a", "Ran the tests"]
        );
        assert_eq!(parsed[0].source, CandidateSource::Claude);
        assert_eq!(parsed[1].source, CandidateSource::Terminal);
    }

    #[test]
    fn test_parse_reply_none_yields_nothing() {
        assert!(parse_reply("NONE", "2026-10-15", &[], false)
            .unwrap()
            .is_empty());
        assert!(parse_reply("  none \n", "2026-10-15", &[], false)
            .unwrap()
            .is_empty());
        assert!(parse_reply("Nothing new.\nNONE", "2026-10-15", &[], false)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_parse_reply_without_one_matching_line_is_an_error() {
        let bullets = "- 09:05 - Fixed the login bug | git\n- 10:00 - Ran tests | terminal";
        assert!(parse_reply(bullets, "2026-10-15", &[], false).is_err());
        assert!(parse_reply("", "2026-10-15", &[], false).is_err());
        assert!(parse_reply("  \n\t\n", "2026-10-15", &[], false).is_err());
        let notice = "Your session has expired. Please run /login.";
        assert!(parse_reply(notice, "2026-10-15", &[], false)
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
        let parsed = parse_reply(
            "09:05 - Fixed the login bug | git",
            "2026-10-15",
            &existing,
            false,
        );
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
        let parsed = parse_reply(reply, "2026-10-15", &existing, false).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].text, "Ran the tests");
        assert_eq!(parsed[0].time.as_deref(), Some("12:00"));
    }

    // --- Granola: replies ---

    #[test]
    fn test_parse_reply_with_granola_reads_timed_and_untimed_meetings() {
        let reply = "14:30 - Meeting: Design sync, agreed the backup plan | granola\n\
                     Meeting - Planning: picked the next issue | Granola\n\
                     09:05 - Fixed the login bug | git";
        let parsed = parse_reply(reply, "2026-10-15", &[], true).unwrap();
        assert_eq!(
            parsed,
            vec![
                NewCandidate {
                    date: "2026-10-15".to_string(),
                    time: Some("14:30".to_string()),
                    text: "Meeting: Design sync, agreed the backup plan".to_string(),
                    source: CandidateSource::Granola,
                },
                NewCandidate {
                    date: "2026-10-15".to_string(),
                    time: None,
                    text: "Meeting - Planning: picked the next issue".to_string(),
                    source: CandidateSource::Granola,
                },
                NewCandidate {
                    date: "2026-10-15".to_string(),
                    time: Some("09:05".to_string()),
                    text: "Fixed the login bug".to_string(),
                    source: CandidateSource::Git,
                },
            ]
        );
        for candidate in &parsed {
            assert!(validate_candidate(candidate).is_ok());
        }
    }

    #[test]
    fn test_parse_reply_without_granola_rejects_granola_lines() {
        let reply = "14:30 - Meeting: Design sync, agreed the backup plan | granola\n\
                     Meeting - Planning: picked the next issue | granola";
        assert!(parse_reply(reply, "2026-10-15", &[], false).is_err());
        let mixed = format!("{reply}\n09:05 - Fixed the login bug | git");
        let parsed = parse_reply(&mixed, "2026-10-15", &[], false).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].source, CandidateSource::Git);
    }

    #[test]
    fn test_parse_reply_with_granola_keeps_untimed_lines_strict() {
        let reply = "Meeting - Planning: no tag\n\
                     Meeting -  | granola\n\
                     Standup - talked | granola\n\
                     Meeting - Planning: wrong tag | git\n\
                     NONE";
        assert!(parse_reply(reply, "2026-10-15", &[], true)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_parse_reply_with_granola_drops_a_meeting_already_suggested() {
        let existing = vec![Candidate {
            time: None,
            source: CandidateSource::Granola,
            ..candidate(
                "2026-10-15",
                "Meeting - Planning: picked the next issue",
                CandidateState::Rejected,
            )
        }];
        let reply = "Meeting - planning:  picked the next issue | granola";
        assert!(parse_reply(reply, "2026-10-15", &existing, true)
            .unwrap()
            .is_empty());
        let prompt = build_prompt("2026-10-15", &[], "", &existing);
        assert!(prompt.contains("Meeting - Planning: picked the next issue | granola"));
        assert!(prompt.contains("Activity (HH:MM [source] project: text):\n(none)"));
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
        /// What the Granola preflight answers.
        granola: bool,
        /// How often the preflight ran.
        preflights: StdMutex<usize>,
        /// The `granola` flag of every `claude` call.
        asked_granola: StdMutex<Vec<bool>>,
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

        async fn ask_claude(
            &self,
            args: &[String],
            input: &str,
            granola: bool,
        ) -> Result<String, String> {
            self.asked_granola.lock().unwrap().push(granola);
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

        async fn granola_url(&self) -> Option<String> {
            *self.preflights.lock().unwrap() += 1;
            self.granola.then(|| GRANOLA_URL.to_string())
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
        let mut child = spawn_process(program, &args).unwrap();
        let result = exchange(&mut child, &input, Duration::from_secs(1), true).await;
        let err = result.unwrap_err();
        assert!(err.contains("did not answer within 1s"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(15));
        // The child was killed and reaped, not left running.
        assert!(
            child.try_wait().unwrap().is_some(),
            "the child is still running after the timeout"
        );
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

    // --- Granola: runs ---

    fn granola_journal(opt_in: Option<bool>) -> WorkJournal {
        let mut journal = journal_with(None, None);
        journal.settings.granola_opt_in = opt_in;
        journal
    }

    #[tokio::test]
    async fn test_run_without_a_yes_never_checks_or_allows_granola() {
        for opt_in in [None, Some(false)] {
            let mut fake = Fake {
                items: vec![item(
                    "2026-10-15",
                    "11:05",
                    CandidateSource::Git,
                    "Commit b",
                )],
                granola: true,
                ..Fake::default()
            };
            fake.replies.insert(
                "2026-10-15".into(),
                "11:00 - Meeting: Sync, agreed | granola\n11:05 - Committed b | git".into(),
            );
            let report = run_with(&fake, &granola_journal(opt_in), &[], now()).await;
            assert!(report.error.is_none());
            assert_eq!(*fake.preflights.lock().unwrap(), 0, "{opt_in:?}");
            let asked = fake.asked.lock().unwrap();
            assert_eq!(asked[0].0, claude_args(None, None).unwrap());
            assert_eq!(*fake.asked_granola.lock().unwrap(), vec![false]);
            let added = fake.added.lock().unwrap();
            assert_eq!(added.len(), 1, "the granola line is not accepted");
            assert_eq!(added[0].source, CandidateSource::Git);
        }
    }

    #[tokio::test]
    async fn test_run_with_a_yes_but_granola_not_connected_is_a_normal_run() {
        let mut fake = Fake {
            items: vec![item(
                "2026-10-15",
                "11:05",
                CandidateSource::Git,
                "Commit b",
            )],
            granola: false,
            ..Fake::default()
        };
        fake.replies
            .insert("2026-10-15".into(), "11:05 - Committed b | git".into());
        let report = run_with(&fake, &granola_journal(Some(true)), &[], now()).await;
        assert!(report.error.is_none());
        assert_eq!(report.added, 1);
        assert_eq!(*fake.preflights.lock().unwrap(), 1);
        assert_eq!(
            fake.asked.lock().unwrap()[0].0,
            claude_args(None, None).unwrap()
        );
        assert_eq!(*fake.asked_granola.lock().unwrap(), vec![false]);
    }

    #[tokio::test]
    async fn test_run_with_granola_allows_the_tools_and_adds_meetings() {
        let today = now().with_timezone(&Local).format("%Y-%m-%d").to_string();
        let mut fake = Fake {
            granola: true,
            ..Fake::default()
        };
        fake.replies.insert(
            today.clone(),
            "14:30 - Meeting: Design sync, agreed the backup plan | granola\n\
             Meeting - Planning: picked the next issue | granola"
                .into(),
        );
        let report = run_with(&fake, &granola_journal(Some(true)), &[], now()).await;

        assert!(report.error.is_none(), "{:?}", report.error);
        assert_eq!(report.added, 2);
        assert_eq!(*fake.preflights.lock().unwrap(), 1);
        let asked = fake.asked.lock().unwrap();
        assert_eq!(asked.len(), 1, "a date without other activity still runs");
        assert_eq!(asked[0].0, claude_args(None, Some(GRANOLA_URL)).unwrap());
        assert!(asked[0].1.starts_with(&format!("Date: {today}")));
        assert!(asked[0]
            .1
            .ends_with(&granola_input(&today, now() - TimeDelta::hours(1), now())));
        assert_eq!(*fake.asked_granola.lock().unwrap(), vec![true]);
        let added = fake.added.lock().unwrap();
        assert_eq!(added[0].time.as_deref(), Some("14:30"));
        assert_eq!(added[1].time, None);
        assert!(added.iter().all(|c| c.source == CandidateSource::Granola));
    }

    #[tokio::test]
    async fn test_run_with_granola_checks_once_for_every_date_of_the_window() {
        let start = now() - TimeDelta::days(2);
        let fake = Fake {
            items: vec![item(
                "2026-10-14",
                "11:05",
                CandidateSource::Git,
                "Commit b",
            )],
            granola: true,
            ..Fake::default()
        };
        let report = run_with(
            &fake,
            &{
                let mut journal = granola_journal(Some(true));
                journal.settings.last_run_at = Some(start.to_rfc3339());
                journal
            },
            &[],
            now(),
        )
        .await;
        let dates = local_dates(start, now());
        assert!(dates.len() >= 3);
        assert_eq!(*fake.preflights.lock().unwrap(), 1, "one preflight per run");
        assert_eq!(fake.asked.lock().unwrap().len(), dates.len());
        // The fake has no replies, so every date failed and is tried again.
        assert!(report.error.is_some());
    }

    #[tokio::test]
    async fn test_run_with_an_empty_window_skips_the_preflight() {
        let fake = Fake {
            granola: true,
            ..Fake::default()
        };
        let mut journal = granola_journal(Some(true));
        journal.settings.last_run_at = Some(now().to_rfc3339());
        let report = run_with(&fake, &journal, &[], now()).await;
        assert!(report.error.is_none());
        assert_eq!(*fake.preflights.lock().unwrap(), 0);
        assert!(fake.asked.lock().unwrap().is_empty());
    }

    #[test]
    fn test_local_dates_cover_the_window_oldest_first() {
        let end = now();
        assert!(local_dates(end, end).is_empty());
        let one = local_dates(end - TimeDelta::minutes(5), end);
        assert_eq!(
            one,
            vec![end.with_timezone(&Local).format("%Y-%m-%d").to_string()]
        );
        let three = local_dates(end - TimeDelta::days(2), end);
        assert_eq!(three.len(), 3);
        assert!(three.windows(2).all(|pair| pair[0] < pair[1]));
    }

    /// A program that prints `secret` and exits with an error.
    fn failing_program() -> (&'static str, Vec<String>) {
        if cfg!(windows) {
            ("cmd", vec!["/C".into(), "echo secret & exit 3".into()])
        } else {
            ("sh", vec!["-c".into(), "echo secret; exit 3".into()])
        }
    }

    #[tokio::test]
    async fn test_a_failed_exit_quotes_the_output_only_when_allowed() {
        let (program, args) = failing_program();
        let mut child = spawn_process(program, &args).unwrap();
        let quoted = exchange(&mut child, "", Duration::from_secs(20), true)
            .await
            .unwrap_err();
        assert!(quoted.contains("secret"), "{quoted}");

        // A Granola call's error never carries what the CLI printed, which
        // could be meeting notes. (The unusable-reply debug log in
        // `parse_reply` follows the same rule; there is no log capture here.)
        let mut child = spawn_process(program, &args).unwrap();
        let bare = exchange(&mut child, "", Duration::from_secs(20), false)
            .await
            .unwrap_err();
        assert!(bare.starts_with("claude exited with"), "{bare}");
        assert!(!bare.contains("secret"), "{bare}");
    }

    #[test]
    fn test_only_one_run_at_a_time() {
        let first = try_begin_run().expect("free");
        assert!(try_begin_run().is_none());
        drop(first);
        assert!(try_begin_run().is_some());
    }
}
