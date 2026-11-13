//! The Work Journal's supervisor report (issue #316): for a from/to date
//! range, a headless `claude -p` turns the text of the day pages in that
//! range into a summary with one heading per project and dated bullets
//! (issue #567), and Maestro fills one fixed,
//! self-contained HTML template with it. The file is saved as
//! `work-report_<from>_to_<to>.html` in the report folder, replacing the
//! same range's earlier file.
//!
//! PRD "Supervisor report": Claude returns plain text only (the line
//! contract in [`SYSTEM_PROMPT`], parsed by [`parse_reply`]); every piece of
//! text is HTML-escaped into the template, so no markup or script from the
//! journal or the model can reach the file. Empty pages and pages that only
//! say "Weekend" are skipped; candidates are never used.
//!
//! The pure pieces ([`report_file_name`], [`parse_range`], [`select_pages`],
//! [`build_input`], [`claude_args`], [`parse_reply`], [`bullet_line`],
//! [`render_html`]) are
//! unit-tested; [`generate_report_with`] takes the Claude call as a closure,
//! so tests never start the real `claude` CLI.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{NaiveDate, NaiveTime};
use tokio::sync::{Mutex, MutexGuard};

use crate::core::atomic_write::atomic_write_durable_async;
use crate::core::work_journal::WorkJournal;
use crate::core::work_journal_run::{is_safe_model, page_cards, page_text, run_process};

/// One report call; summarising many pages takes longer than one candidate
/// date, anything past this is a hung CLI.
pub const REPORT_TIMEOUT: Duration = Duration::from_secs(300);

/// The longest range one report covers, in days, both ends included (about
/// a quarter): longer ranges risk running past [`REPORT_TIMEOUT`] while the
/// dialog cannot be closed. The report dialog checks the same limit.
pub const MAX_REPORT_DAYS: i64 = 92;

/// The most text one report sends to Claude, in characters: more risks the
/// timeout or the model's context.
pub const MAX_REPORT_INPUT_CHARS: usize = 200_000;

/// The positional prompt; the pages go in on stdin.
const USER_PROMPT: &str = "Write the work report for the Work Journal pages given on stdin.";

/// A full `--system-prompt` (not an appended one). Together with
/// `--safe-mode` (see [`claude_args`]) the user's own CLAUDE.md never
/// reaches the run, so it cannot add text to the report.
pub const SYSTEM_PROMPT: &str = "You write a short work report that a developer sends to \
their supervisor. You are given the developer's Work Journal pages for a date range: each \
page starts with a line \"Page YYYY-MM-DD: <title>\", followed by the page text. An entry \
card on a page is one line \"HH:MM - <text> | <source> | <project>\": \"HH:MM - \" is left \
out when the card has no time, and \" | <project>\" is left out when it has no project. \
Older pages may hold plain lines that start with a time, like \"14:20 - <text>\".\n\
Report the work the pages record: work delivered, problems fixed, decisions made and help \
given to others. Group it by project: one section per project named on the cards, and the \
work with no project (a meeting, helping someone) in a last section called Other. Do not \
write an overview or a summary paragraph, and do not group by theme. Do not write a \
day-by-day log: work on one thing over several days is one item.\n\
Facts only, follow these rules exactly:\n\
- Describe each item in the page's own words or a plain paraphrase of them.\n\
- Never add significance, impact or quality words the page does not contain: no \
\"security\", \"critical\", \"major\", \"key\", \"significantly\", \"robust\", \
\"successfully\" or similar, unless the page itself uses that word.\n\
- Never add outcomes, numbers, names or reasons that are not written in the pages.\n\
- You choose which items to include, but never upgrade an item: a small change stays a \
small change.\n\
- When unsure how to describe an item, quote the page's wording.\n\
Output contract, follow it exactly:\n\
- Plain text only: no HTML, no markdown emphasis (no ** or _), no tables, no code blocks, \
no preamble and no closing remarks.\n\
- A line starting with \"# \" is a section heading: a project's name exactly as the cards \
write it, or Other. Each project has one heading only.\n\
- Under each heading, every item is one line starting with \"- \", then the item's date, \
then \" | \", then one sentence of about 120 characters, for example: \
- 2026-11-03 14:20 | Fixed the login timeout.\n\
- The date is the date of the page the item comes from, written YYYY-MM-DD. Add a space \
and the time as HH:MM only when the item rests on exactly one entry that has a time (a \
card's time, or a line starting with a time).\n\
- An item from several days lists every day, separated by \", \", with no time, for \
example: - 2026-11-03, 2026-11-05 | Reviewed the export changes.\n\
- Separate sections with one blank line.\n\
- Write in English, in the first person and the past tense.\n\
- If the pages hold nothing worth reporting, reply with exactly: NONE";

/// The section for work with no project, or with a project no card names;
/// always the report's last heading.
pub const OTHER_HEADING: &str = "Other";

/// Joins a bullet's rendered day (and time) to its sentence.
const DATE_SEPARATOR: &str = " — ";

/// Errors from making a report.
#[derive(Debug, thiserror::Error)]
pub enum ReportError {
    #[error("Not a valid date (expected YYYY-MM-DD): {0}")]
    InvalidDate(String),
    #[error("The start date {from} is after the end date {to}.")]
    RangeReversed { from: String, to: String },
    #[error("Choose a range of at most {max} days.")]
    RangeTooLong { max: i64 },
    #[error("That range holds too much text for one report; pick a shorter range.")]
    InputTooLarge,
    #[error(
        "The report folder {0} does not exist. Choose another folder in Settings or create it \
         again."
    )]
    FolderMissing(String),
    #[error("The report folder {0} is a file, not a folder. Choose a folder in Settings.")]
    FolderNotAFolder(String),
    /// A bad model setting; the message comes from [`claude_args`].
    #[error("{0}")]
    Model(String),
    #[error("Claude could not write the report: {0}")]
    Claude(String),
    /// The installed `claude` rejected `--safe-mode`; never retried without it.
    #[error(
        "Your Claude Code is too old for reports (it does not know --safe-mode). Update Claude \
         Code and try again."
    )]
    CliTooOld,
    #[error("Claude's reply held no report text. Try again.")]
    UnusableReply,
    #[error("The report could not be saved: {0}")]
    Write(String),
}

/// What [`generate_report_with`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReportResult {
    /// The report was written to this file.
    Saved(PathBuf),
    /// No page in the range has text worth a report (or Claude said so); no
    /// file was written.
    NothingToReport,
    /// No report folder is set yet; nothing was asked or written.
    NoFolder,
}

/// One page as the report sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportPage {
    /// The page's date, `YYYY-MM-DD`.
    pub date: String,
    /// The page's title as the user wrote it; sent with the text, since
    /// titles are user-written headings.
    pub title: String,
    /// The page's plain text ([`page_text`]), never empty.
    pub text: String,
    /// The projects the page's entry cards name, in page order, each once.
    pub projects: Vec<String>,
}

/// One bullet of the report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportBullet {
    /// The days the item rests on, oldest first, each inside the report's
    /// range; empty when the reply gave no readable date in the range.
    pub days: Vec<NaiveDate>,
    /// The time, only when the item rests on exactly one timed entry.
    pub time: Option<NaiveTime>,
    /// The sentence, without its marker and date.
    pub text: String,
}

/// One project's heading and its bullets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportSection {
    /// The project's name as the cards write it, or [`OTHER_HEADING`].
    pub heading: String,
    /// Never empty, oldest day first.
    pub bullets: Vec<ReportBullet>,
}

/// Only one report at a time in this process. Separate from the candidate
/// run's lock: a report only reads the journal, so an hourly run never
/// blocks it.
static REPORT_LOCK: Mutex<()> = Mutex::const_new(());

/// Claims the one report slot; `None` while another report is being made.
/// Keep the guard until the report is saved.
pub fn try_begin_report() -> Option<MutexGuard<'static, ()>> {
    REPORT_LOCK.try_lock().ok()
}

/// `work-report_<from>_to_<to>.html` (dates as `YYYY-MM-DD`): one file per
/// range, so the same range again replaces its file and a different range
/// makes a new one. Takes parsed dates, so no unvalidated text can reach the
/// file name.
pub fn report_file_name(from: NaiveDate, to: NaiveDate) -> String {
    format!(
        "work-report_{}_to_{}.html",
        from.format("%Y-%m-%d"),
        to.format("%Y-%m-%d")
    )
}

/// Parses a real calendar date written exactly as `YYYY-MM-DD`.
fn parse_date(date: &str) -> Result<NaiveDate, ReportError> {
    let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| ReportError::InvalidDate(date.to_string()))?;
    // parse_from_str accepts "2026-1-5"; the file name needs the canonical form.
    if parsed.format("%Y-%m-%d").to_string() != date {
        return Err(ReportError::InvalidDate(date.to_string()));
    }
    Ok(parsed)
}

/// The inclusive range `from..=to`; both `YYYY-MM-DD`, `from` not after `to`,
/// at most [`MAX_REPORT_DAYS`] days.
pub fn parse_range(from: &str, to: &str) -> Result<(NaiveDate, NaiveDate), ReportError> {
    let start = parse_date(from)?;
    let end = parse_date(to)?;
    if start > end {
        return Err(ReportError::RangeReversed {
            from: from.to_string(),
            to: to.to_string(),
        });
    }
    if (end - start).num_days() + 1 > MAX_REPORT_DAYS {
        return Err(ReportError::RangeTooLong {
            max: MAX_REPORT_DAYS,
        });
    }
    Ok((start, end))
}

/// True for page text that holds nothing to report: empty, or only
/// "Weekend" (an untouched weekend page; any case, any surrounding space).
fn is_blank_page(text: &str) -> bool {
    let text = text.trim();
    text.is_empty() || text.eq_ignore_ascii_case("weekend")
}

/// The pages dated inside `start..=end`, oldest first, without empty pages
/// and pages that only say "Weekend".
pub fn select_pages(journal: &WorkJournal, start: NaiveDate, end: NaiveDate) -> Vec<ReportPage> {
    let mut pages: Vec<(NaiveDate, ReportPage)> = journal
        .pages
        .values()
        .filter_map(|page| {
            let date = parse_date(&page.date).ok()?;
            if date < start || date > end {
                return None;
            }
            let text = page_text(&page.body);
            if is_blank_page(&text) {
                return None;
            }
            let mut projects: Vec<String> = Vec::new();
            for project in page_cards(&page.body)
                .into_iter()
                .filter_map(|card| card.project)
            {
                if find_project(&projects, &project).is_none() {
                    projects.push(project);
                }
            }
            Some((
                date,
                ReportPage {
                    date: page.date.clone(),
                    title: page.title.clone(),
                    text,
                    projects,
                },
            ))
        })
        .collect();
    pages.sort_by_key(|(date, _)| *date);
    pages.into_iter().map(|(_, page)| page).collect()
}

/// The project in `projects` that `name` names, ignoring case and outer
/// space.
fn find_project<'a>(projects: &'a [String], name: &str) -> Option<&'a String> {
    let name = name.trim();
    projects
        .iter()
        .find(|project| project.trim().eq_ignore_ascii_case(name))
}

/// Every project the pages' cards name, in first-seen order, each once.
pub fn known_projects(pages: &[ReportPage]) -> Vec<String> {
    let mut projects: Vec<String> = Vec::new();
    for project in pages.iter().flat_map(|page| &page.projects) {
        if find_project(&projects, project).is_none() {
            projects.push(project.clone());
        }
    }
    projects
}

/// The stdin input: the range, a `Projects on the cards:` line when any card
/// names one, then per page a `Page <date>: <title>` line and its text,
/// pages separated by a blank line.
pub fn build_input(from: &str, to: &str, pages: &[ReportPage]) -> String {
    let mut input = format!("Work Journal pages from {from} to {to}.\n");
    let projects = known_projects(pages);
    if !projects.is_empty() {
        input.push_str(&format!(
            "Projects on the cards: {}.\n",
            projects.join(", ")
        ));
    }
    for page in pages {
        input.push_str(&format!(
            "\nPage {}: {}\n{}\n",
            page.date, page.title, page.text
        ));
    }
    input
}

/// The `claude` arguments for a report: print mode, `--safe-mode` (no
/// CLAUDE.md, skills, plugins, hooks or MCP servers of the user's; sign-in
/// and model selection still work), no built-in tools, no MCP servers, no
/// saved session, the report's own system prompt, and `--model` only when
/// the shared Work Journal model setting names one (blank = the user's
/// default model). Never `--bare` (bare mode never reads stored sign-ins)
/// and never an appended system prompt. The input goes in on stdin.
pub fn claude_args(model: Option<&str>) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = [
        "-p",
        "--safe-mode",
        "--tools",
        "",
        "--no-session-persistence",
        "--strict-mcp-config",
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

/// True when the reply says there is nothing to report: its first non-empty
/// line is `NONE` in any case, trailing punctuation ignored (`None.`,
/// `none`, or `NONE` followed by an explanation on later lines).
fn says_none(reply: &str) -> bool {
    reply
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.trim_end_matches(|c: char| c.is_ascii_punctuation()))
        .is_some_and(|line| line.trim().eq_ignore_ascii_case("none"))
}

/// The text of a bullet line without its marker: `- `, `* `, `• ` or a
/// number followed by `. ` or `) ` (`1. text`); `None` for any other line.
fn bullet_text(line: &str) -> Option<&str> {
    for marker in ["- ", "* ", "• "] {
        if let Some(text) = line.strip_prefix(marker) {
            return Some(text);
        }
    }
    let digits = line.len() - line.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 {
        return None;
    }
    let rest = &line[digits..];
    rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))
}

/// Words a model may write where a date or a sentence belongs when it has
/// none; read as no date, and a sentence of only one of them is dropped.
const NO_VALUE_WORDS: [&str; 7] = [
    "null",
    "none",
    "nil",
    "n/a",
    "unknown",
    "undated",
    "undefined",
];

/// One date the reply gives a bullet, with the time written after it.
type Stamp = (NaiveDate, Option<NaiveTime>);

/// One word of a bullet's date column.
enum StampToken {
    Date(NaiveDate),
    Time(NaiveTime),
    /// No letter or digit (`-`, `—`): a separator.
    Separator,
    /// One of [`NO_VALUE_WORDS`].
    NoDate,
}

/// True for text that is empty, has no letter or digit, or is only one of
/// [`NO_VALUE_WORDS`].
fn is_no_value(text: &str) -> bool {
    let text = text
        .trim()
        .trim_end_matches(|c: char| c.is_ascii_punctuation());
    !text.chars().any(char::is_alphanumeric)
        || NO_VALUE_WORDS
            .iter()
            .any(|word| text.eq_ignore_ascii_case(word))
}

/// Reads one word of a date column, brackets and a trailing `:` or `.`
/// ignored; `None` for a word that is none of the [`StampToken`]s.
fn stamp_token(word: &str) -> Option<StampToken> {
    let word = word.trim_matches(|c: char| matches!(c, '[' | ']' | '(' | ')' | ':' | '.'));
    if let Ok(date) = parse_date(word) {
        Some(StampToken::Date(date))
    } else if let Ok(time) = NaiveTime::parse_from_str(word, "%H:%M") {
        Some(StampToken::Time(time))
    } else if !word.chars().any(char::is_alphanumeric) {
        Some(StampToken::Separator)
    } else if is_no_value(word) {
        Some(StampToken::NoDate)
    } else {
        None
    }
}

/// Adds a date column word to `stamps`: a time belongs to the date before
/// it (a second time on one date counts as a second entry); a time with no
/// date before it is ignored.
fn push_stamp(stamps: &mut Vec<Stamp>, token: StampToken) {
    match token {
        StampToken::Date(date) => stamps.push((date, None)),
        StampToken::Time(time) => match stamps.last_mut() {
            Some((_, slot @ None)) => *slot = Some(time),
            Some((date, Some(_))) => {
                let date = *date;
                stamps.push((date, Some(time)));
            }
            None => {}
        },
        StampToken::Separator | StampToken::NoDate => {}
    }
}

/// True for the characters that split a date column into words.
fn is_word_break(c: char) -> bool {
    c == ',' || c.is_whitespace()
}

/// Splits a bullet into its dates and its sentence. The contract's form is
/// `<dates> | <sentence>`; when the part before the first `|` is not a date
/// column (or there is no `|`), dates written straight before the sentence
/// (`2026-11-03 14:20 — text`) are read instead. A bullet that starts with
/// no date keeps its whole text.
fn split_stamps(bullet: &str) -> (Vec<Stamp>, &str) {
    if let Some((column, sentence)) = bullet.split_once('|') {
        let mut stamps = Vec::new();
        let mut is_column = true;
        for word in column.split(is_word_break).filter(|word| !word.is_empty()) {
            match stamp_token(word) {
                Some(token) => push_stamp(&mut stamps, token),
                None => {
                    is_column = false;
                    break;
                }
            }
        }
        if is_column {
            return (stamps, sentence);
        }
    }
    let mut stamps = Vec::new();
    let mut rest = bullet;
    loop {
        let trimmed = rest.trim_start_matches(is_word_break);
        let word_end = trimmed.find(is_word_break).unwrap_or(trimmed.len());
        if word_end == 0 {
            break;
        }
        let token = stamp_token(&trimmed[..word_end]);
        let takes = match &token {
            Some(StampToken::Date(_)) => true,
            Some(StampToken::Time(_) | StampToken::Separator) => !stamps.is_empty(),
            _ => false,
        };
        let Some(token) = token.filter(|_| takes) else {
            break;
        };
        push_stamp(&mut stamps, token);
        rest = &trimmed[word_end..];
    }
    if stamps.is_empty() {
        (stamps, bullet)
    } else {
        (stamps, rest)
    }
}

/// One bullet from its text (marker stripped): the dates inside
/// `start..=end` kept, oldest first and each once, the others dropped; the
/// time kept only when the bullet gives exactly one date and that date is
/// kept. `None` when no sentence is left.
fn parse_bullet(bullet: &str, start: NaiveDate, end: NaiveDate) -> Option<ReportBullet> {
    let (stamps, sentence) = split_stamps(bullet);
    let text = sentence.trim();
    if is_no_value(text) {
        return None;
    }
    let mut days: Vec<NaiveDate> = stamps
        .iter()
        .map(|(day, _)| *day)
        .filter(|day| (start..=end).contains(day))
        .collect();
    days.sort();
    days.dedup();
    let time = match stamps.as_slice() {
        [(_, time)] if !days.is_empty() => *time,
        _ => None,
    };
    Some(ReportBullet {
        days,
        time,
        text: text.to_string(),
    })
}

/// The section a reply heading goes to: the project of `projects` it names
/// (ignoring case), else [`OTHER_HEADING`], so a project no card names
/// never gets a heading of its own.
fn section_heading(heading: &str, projects: &[String]) -> String {
    find_project(projects, heading)
        .cloned()
        .unwrap_or_else(|| OTHER_HEADING.to_string())
}

/// The index of the section headed `heading`, added at the end if new.
fn section_index(sections: &mut Vec<ReportSection>, heading: &str) -> usize {
    if let Some(at) = sections
        .iter()
        .position(|section| section.heading == heading)
    {
        return at;
    }
    sections.push(ReportSection {
        heading: heading.to_string(),
        bullets: Vec::new(),
    });
    sections.len() - 1
}

/// Parses the reply contract into project sections. `Ok(None)` when the
/// reply says `NONE` (see [`says_none`]).
///
/// - `# text` is a heading (deeper `## text` levels too); it names one of
///   `projects`, else its bullets go under [`OTHER_HEADING`]. A heading
///   given twice is one section; bullets before any heading go to Other.
/// - `- text` is a bullet (`* `, `• ` and `1. ` markers too, stripped),
///   read by [`parse_bullet`]: dates outside `start..=end` are dropped, and
///   a bullet with no date left still shows.
/// - A plain line straight after a bullet, not starting with a date,
///   continues that bullet; any other plain line is a bullet of its own, so
///   no line of the reply is lost.
/// - Code fences and lines with no letter or digit are dropped, and so is a
///   bullet with no sentence (`- 2026-11-03 |`, `- null`).
///
/// Sections come most bullets first, Other last; inside each, bullets
/// oldest day first (then timed ones by time, then untimed), undated ones
/// last. A reply with no bullet left is an error.
pub fn parse_reply(
    reply: &str,
    start: NaiveDate,
    end: NaiveDate,
    projects: &[String],
) -> Result<Option<Vec<ReportSection>>, ReportError> {
    if says_none(reply) {
        return Ok(None);
    }
    let mut sections: Vec<ReportSection> = Vec::new();
    let mut heading = OTHER_HEADING.to_string();
    // The section and bullet a plain line may continue.
    let mut last: Option<(usize, usize)> = None;
    for line in reply.lines() {
        let line = line.trim();
        if line.is_empty() {
            last = None;
            continue;
        }
        if line.starts_with("```") || !line.chars().any(char::is_alphanumeric) {
            continue;
        }
        let unhashed = line.trim_start_matches('#');
        if unhashed.len() < line.len() && unhashed.starts_with(' ') {
            heading = section_heading(unhashed, projects);
            last = None;
            continue;
        }
        let bullet = match bullet_text(line) {
            Some(bullet) => bullet,
            None => {
                if let Some((at, item)) = last.filter(|_| split_stamps(line).0.is_empty()) {
                    let text = &mut sections[at].bullets[item].text;
                    text.push(' ');
                    text.push_str(line);
                    continue;
                }
                line
            }
        };
        last = None;
        if let Some(bullet) = parse_bullet(bullet, start, end) {
            let at = section_index(&mut sections, &heading);
            sections[at].bullets.push(bullet);
            last = Some((at, sections[at].bullets.len() - 1));
        }
    }
    sections.retain(|section| !section.bullets.is_empty());
    if sections.is_empty() {
        return Err(ReportError::UnusableReply);
    }
    for section in &mut sections {
        section.bullets.sort_by_key(|bullet| {
            (
                bullet.days.is_empty(),
                bullet.days.first().copied(),
                bullet.time.is_none(),
                bullet.time,
            )
        });
    }
    sections.sort_by_key(|section| {
        (
            section.heading == OTHER_HEADING,
            std::cmp::Reverse(section.bullets.len()),
        )
    });
    Ok(Some(sections))
}

/// How a bullet's day shows: `Mon 3 Nov`.
const DAY_FORMAT: &str = "%a %-d %b";

/// A bullet as the report shows it: `Mon 3 Nov, 14:20 — text`, `Mon 3 Nov,
/// Wed 5 Nov — text` (a time only with one day), or the text alone when it
/// has no day.
pub fn bullet_line(bullet: &ReportBullet) -> String {
    if bullet.days.is_empty() {
        return bullet.text.clone();
    }
    let mut label: Vec<String> = bullet
        .days
        .iter()
        .map(|day| day.format(DAY_FORMAT).to_string())
        .collect();
    if let (Some(time), [_]) = (bullet.time, bullet.days.as_slice()) {
        label.push(time.format("%H:%M").to_string());
    }
    format!("{}{DATE_SEPARATOR}{}", label.join(", "), bullet.text)
}

/// Escapes text for HTML element content and attribute values.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

// Inline styles on each element (no <style> block), so the file reads the
// same in a browser and in mail clients that drop <head> styles.
const BODY_STYLE: &str = "margin:0;padding:32px 16px;background:#f6f7f9;color:#1f2328;\
font-family:'Segoe UI',-apple-system,Roboto,Helvetica,Arial,sans-serif;font-size:15px;\
line-height:1.55;";
const MAIN_STYLE: &str = "max-width:760px;margin:0 auto;background:#ffffff;\
border:1px solid #d8dee4;border-radius:8px;padding:32px 40px;";
const H1_STYLE: &str = "font-size:24px;line-height:1.3;margin:0 0 4px;";
const GENERATED_STYLE: &str = "color:#59636e;font-size:13px;margin:0 0 24px;";
const H2_STYLE: &str = "font-size:17px;margin:28px 0 8px;padding-bottom:4px;\
border-bottom:1px solid #d8dee4;";
const UL_STYLE: &str = "margin:0 0 12px;padding-left:22px;";
const LI_STYLE: &str = "margin:0 0 6px;";

/// The fixed, self-contained report page: the title `Work report <from> to
/// <to>`, a generated-on line, then per section its heading and its bullets
/// ([`bullet_line`]). Inline styles only; no script, no external link, no
/// image. Every piece of text is escaped.
pub fn render_html(from: &str, to: &str, generated_on: &str, report: &[ReportSection]) -> String {
    let title = escape_html(&format!("Work report {from} to {to}"));
    let mut sections = String::new();
    for section in report {
        sections.push_str(&format!(
            "<h2 style=\"{H2_STYLE}\">{}</h2>\n<ul style=\"{UL_STYLE}\">\n",
            escape_html(&section.heading)
        ));
        for bullet in &section.bullets {
            sections.push_str(&format!(
                "<li style=\"{LI_STYLE}\">{}</li>\n",
                escape_html(&bullet_line(bullet))
            ));
        }
        sections.push_str("</ul>\n");
    }
    format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{title}</title>\n</head>\n<body style=\"{BODY_STYLE}\">\n\
         <main style=\"{MAIN_STYLE}\">\n<h1 style=\"{H1_STYLE}\">{title}</h1>\n\
         <p style=\"{GENERATED_STYLE}\">Generated on {} from the Work Journal.</p>\n\
         {sections}</main>\n</body>\n</html>\n",
        escape_html(generated_on)
    )
}

/// The configured report folder, if one is set (blank counts as unset).
fn configured_report_folder(journal: &WorkJournal) -> Option<PathBuf> {
    journal
        .settings
        .report_folder
        .as_deref()
        .filter(|folder| !folder.trim().is_empty())
        .map(PathBuf::from)
}

/// Checks the report folder exists; it is never created here (same rule as
/// the backup folder).
fn check_folder(folder: &Path) -> Result<(), ReportError> {
    if folder.is_dir() {
        return Ok(());
    }
    let shown = folder.display().to_string();
    Err(if folder.exists() {
        ReportError::FolderNotAFolder(shown)
    } else {
        ReportError::FolderMissing(shown)
    })
}

/// Maps a failed `claude` call: an older CLI that does not know
/// `--safe-mode` (`error: unknown option '--safe-mode'`) gets its own plain
/// message; anything else is [`ReportError::Claude`].
pub fn claude_error(message: String) -> ReportError {
    let lower = message.to_lowercase();
    if lower.contains("unknown option") && lower.contains("--safe-mode") {
        ReportError::CliTooOld
    } else {
        ReportError::Claude(message)
    }
}

/// Makes the report for `from..=to` from `journal`: checks the range and
/// the folder, selects the pages, refuses an input over
/// [`MAX_REPORT_INPUT_CHARS`], asks Claude through `ask` (the `claude`
/// arguments and the stdin input) only when a page qualifies, and writes
/// the file crash-safely (temp file, then rename over the same range's
/// file). `generated_on` is the generated-on text shown in the report.
pub async fn generate_report_with<F, Fut>(
    journal: &WorkJournal,
    from: &str,
    to: &str,
    generated_on: &str,
    ask: F,
) -> Result<ReportResult, ReportError>
where
    F: FnOnce(Vec<String>, String) -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    let (start, end) = parse_range(from, to)?;
    let Some(folder) = configured_report_folder(journal) else {
        return Ok(ReportResult::NoFolder);
    };
    check_folder(&folder)?;
    let pages = select_pages(journal, start, end);
    if pages.is_empty() {
        return Ok(ReportResult::NothingToReport);
    }
    let args = claude_args(journal.settings.model.as_deref()).map_err(ReportError::Model)?;
    let input = build_input(from, to, &pages);
    if input.chars().count() > MAX_REPORT_INPUT_CHARS {
        return Err(ReportError::InputTooLarge);
    }
    let reply = ask(args, input).await.map_err(claude_error)?;
    let Some(sections) = parse_reply(&reply, start, end, &known_projects(&pages))? else {
        return Ok(ReportResult::NothingToReport);
    };
    let html = render_html(from, to, generated_on, &sections);
    let target = folder.join(report_file_name(start, end));
    atomic_write_durable_async(target.clone(), html.into_bytes())
        .await
        .map_err(ReportError::Write)?;
    Ok(ReportResult::Saved(target))
}

/// [`generate_report_with`] with the real headless `claude` (from the temp
/// dir, hidden console, input on stdin, [`REPORT_TIMEOUT`]).
pub async fn generate_report(
    journal: &WorkJournal,
    from: &str,
    to: &str,
    generated_on: &str,
) -> Result<ReportResult, ReportError> {
    generate_report_with(journal, from, to, generated_on, |args, input| async move {
        run_process("claude", &args, &input, REPORT_TIMEOUT, true).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::work_journal::{
        merge_settings, parse_journal, weekend_page_body, PageOrigin, WorkJournalPage,
    };
    use serde_json::{json, Map, Value};
    use std::sync::{Arc, Mutex as StdMutex};
    use tempfile::tempdir;

    fn day(date: &str) -> NaiveDate {
        NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap()
    }

    fn body(lines: &[&str]) -> Value {
        let content: Vec<Value> = lines
            .iter()
            .map(|line| json!({"type": "paragraph", "content": [{"type": "text", "text": line}]}))
            .collect();
        json!({"type": "doc", "content": content})
    }

    fn add_page(journal: &mut WorkJournal, date: &str, body: Value) {
        journal.pages.insert(
            date.to_string(),
            WorkJournalPage {
                date: date.to_string(),
                title: format!("Title {date}"),
                body,
                origin: PageOrigin::Auto,
                rev: 0,
            },
        );
    }

    /// A journal with pages around 2026-10-05..=2026-10-09: two outside the
    /// range, an empty one, a "Weekend" one, and three with text.
    fn sample_journal() -> WorkJournal {
        let mut journal = WorkJournal::default();
        add_page(&mut journal, "2026-10-04", body(&["Before the range"]));
        add_page(
            &mut journal,
            "2026-10-09",
            body(&["Last day: shipped the export"]),
        );
        add_page(
            &mut journal,
            "2026-10-05",
            body(&["First day: fixed the login bug"]),
        );
        add_page(
            &mut journal,
            "2026-10-06",
            json!({"type": "doc", "content": [{"type": "paragraph"}]}),
        );
        add_page(&mut journal, "2026-10-07", weekend_page_body());
        add_page(
            &mut journal,
            "2026-10-08",
            body(&["  weekend  ", "Reviewed the PR"]),
        );
        add_page(&mut journal, "2026-10-10", body(&["After the range"]));
        journal
    }

    #[test]
    fn test_report_file_name_is_named_after_the_range() {
        assert_eq!(
            report_file_name(day("2026-10-05"), day("2026-10-16")),
            "work-report_2026-10-05_to_2026-10-16.html"
        );
        assert_eq!(
            report_file_name(day("2026-10-05"), day("2026-10-05")),
            "work-report_2026-10-05_to_2026-10-05.html"
        );
    }

    #[test]
    fn test_parse_range_checks_dates_and_order() {
        assert_eq!(
            parse_range("2026-10-05", "2026-10-05").unwrap(),
            (day("2026-10-05"), day("2026-10-05"))
        );
        assert!(matches!(
            parse_range("2026-10-06", "2026-10-05"),
            Err(ReportError::RangeReversed { .. })
        ));
        for bad in ["2026-1-5", "2026-02-30", "yesterday", "", "2026-10-05/../x"] {
            assert!(
                matches!(
                    parse_range(bad, "2026-10-09"),
                    Err(ReportError::InvalidDate(_))
                ),
                "{bad}"
            );
            assert!(parse_range("2026-10-01", bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn test_select_pages_keeps_the_inclusive_range_in_date_order() {
        let pages = select_pages(&sample_journal(), day("2026-10-05"), day("2026-10-09"));
        let dates: Vec<&str> = pages.iter().map(|p| p.date.as_str()).collect();
        // 10-04 and 10-10 are outside; 10-06 is empty; 10-07 only says Weekend.
        assert_eq!(dates, ["2026-10-05", "2026-10-08", "2026-10-09"]);
        assert_eq!(pages[0].title, "Title 2026-10-05");
        assert_eq!(pages[0].text, "First day: fixed the login bug");
        // A weekend page with more text is kept, its text whole.
        assert_eq!(pages[1].text, "weekend\nReviewed the PR");
    }

    #[test]
    fn test_select_pages_skips_weekend_in_any_case_and_out_of_range_pages() {
        let mut journal = WorkJournal::default();
        add_page(&mut journal, "2026-10-10", body(&["  WEEKEND "]));
        add_page(&mut journal, "2026-10-11", body(&["Weekend"]));
        add_page(&mut journal, "2026-10-12", body(&["   "]));
        assert!(select_pages(&journal, day("2026-10-10"), day("2026-10-12")).is_empty());
        assert!(select_pages(&sample_journal(), day("2026-11-01"), day("2026-11-30")).is_empty());
    }

    #[test]
    fn test_build_input_gives_each_page_date_title_and_text() {
        let pages = select_pages(&sample_journal(), day("2026-10-05"), day("2026-10-08"));
        let input = build_input("2026-10-05", "2026-10-08", &pages);
        assert_eq!(
            input,
            "Work Journal pages from 2026-10-05 to 2026-10-08.\n\
             \nPage 2026-10-05: Title 2026-10-05\nFirst day: fixed the login bug\n\
             \nPage 2026-10-08: Title 2026-10-08\nweekend\nReviewed the PR\n"
        );
    }

    /// A card as the page JSON stores it.
    fn card(time: Option<&str>, source: &str, project: Option<&str>, text: &str) -> Value {
        json!({
            "type": "journalEntry",
            "attrs": { "time": time, "source": source, "project": project },
            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }],
        })
    }

    /// A made-up week of card pages, Mon 5 Oct to Thu 8 Oct 2026.
    fn card_week(folder: Option<&Path>) -> WorkJournal {
        let mut journal = WorkJournal::default();
        journal.settings.report_folder = folder.map(|f| f.display().to_string());
        let page = |cards: Vec<Value>| json!({"type": "doc", "content": cards});
        add_page(
            &mut journal,
            "2026-10-05",
            page(vec![
                card(
                    Some("09:15"),
                    "github",
                    Some("Maestro"),
                    "Fixed the login timeout",
                ),
                card(Some("11:00"), "granola", None, "Planning meeting"),
            ]),
        );
        add_page(
            &mut journal,
            "2026-10-06",
            page(vec![card(
                None,
                "typed",
                Some("Orion"),
                "Wrote the update notes",
            )]),
        );
        add_page(
            &mut journal,
            "2026-10-07",
            page(vec![card(
                Some("14:20"),
                "github",
                Some("maestro"),
                "Added the export button",
            )]),
        );
        add_page(
            &mut journal,
            "2026-10-08",
            body(&["16:00 - Reviewed the export PR"]),
        );
        journal
    }

    #[test]
    fn test_build_input_names_the_cards_projects_and_gives_each_card_line() {
        let pages = select_pages(&card_week(None), day("2026-10-05"), day("2026-10-08"));
        assert_eq!(pages[0].projects, ["Maestro"]);
        assert!(pages[3].projects.is_empty(), "an old page names no project");
        assert_eq!(
            known_projects(&pages),
            ["Maestro", "Orion"],
            "once each, any case"
        );
        let input = build_input("2026-10-05", "2026-10-08", &pages);
        assert!(input.starts_with(
            "Work Journal pages from 2026-10-05 to 2026-10-08.\n\
             Projects on the cards: Maestro, Orion.\n\nPage 2026-10-05: Title 2026-10-05\n"
        ));
        for line in [
            "09:15 - Fixed the login timeout | github | Maestro",
            "11:00 - Planning meeting | granola\n",
            "Wrote the update notes | typed | Orion",
            "16:00 - Reviewed the export PR",
        ] {
            assert!(input.contains(line), "missing {line:?} in {input}");
        }
    }

    #[test]
    fn test_claude_args_are_safe_tool_less_and_use_the_default_model() {
        let args = claude_args(None).unwrap();
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
        assert_eq!(claude_args(Some("  ")).unwrap(), args);
        assert!(!args.iter().any(|a| a == "--model"));
    }

    #[test]
    fn test_claude_args_pass_a_set_model_and_refuse_a_bad_one() {
        let args = claude_args(Some(" sonnet ")).unwrap();
        let at = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[at + 1], "sonnet");
        assert_eq!(args.last().unwrap(), USER_PROMPT);
        assert!(claude_args(Some("sonnet & calc"))
            .unwrap_err()
            .contains("not a valid model name"));
        assert!(claude_args(Some("--bare")).is_err());
    }

    #[test]
    fn test_claude_args_never_bare_or_appended() {
        for model in [None, Some("haiku")] {
            let args = claude_args(model).unwrap();
            assert!(!args.iter().any(|a| a == "--bare"));
            assert!(!args.iter().any(|a| a == "--append-system-prompt"));
            assert!(!args.iter().any(|a| a == "--mcp-config"));
            assert!(args.iter().any(|a| a == "--strict-mcp-config"));
            assert!(args.iter().any(|a| a == "--no-session-persistence"));
        }
    }

    #[test]
    fn test_system_prompt_states_the_rules_and_the_contract() {
        for needle in [
            "Group it by project",
            "a last section called Other",
            "Do not write a day-by-day log",
            "in the page's own words or a plain paraphrase",
            "Never add significance, impact or quality words",
            "\"security\"",
            "\"significantly\"",
            "unless the page itself uses that word",
            "Never add outcomes, numbers, names or reasons that are not written",
            "never upgrade an item",
            "quote the page's wording",
            "Plain text only",
            "\"# \"",
            "\"- \"",
            "NONE",
        ] {
            assert!(SYSTEM_PROMPT.contains(needle), "missing {needle}");
        }
        // The old spin-inviting wording, the overview and the themes are gone.
        for gone in [
            "look good",
            "how to frame it",
            "Put the strongest items first",
            "one or two sentence overview",
            "group related work by theme",
            "Any other line is paragraph text",
        ] {
            assert!(!SYSTEM_PROMPT.contains(gone), "still has {gone}");
        }
        assert!(SYSTEM_PROMPT.contains("Do not write an overview"));
        assert!(SYSTEM_PROMPT.contains("do not group by theme"));
    }

    /// The range of the parser tests: Mon 5 Oct to Fri 9 Oct 2026.
    fn week() -> (NaiveDate, NaiveDate) {
        (day("2026-10-05"), day("2026-10-09"))
    }

    fn projects() -> Vec<String> {
        vec!["Maestro".to_string(), "Orion".to_string()]
    }

    fn parse(reply: &str) -> Vec<ReportSection> {
        let (start, end) = week();
        parse_reply(reply, start, end, &projects())
            .unwrap()
            .unwrap()
    }

    fn bullet(days: &[&str], time: Option<&str>, text: &str) -> ReportBullet {
        ReportBullet {
            days: days.iter().map(|d| day(d)).collect(),
            time: time.map(|t| NaiveTime::parse_from_str(t, "%H:%M").unwrap()),
            text: text.to_string(),
        }
    }

    fn headings(sections: &[ReportSection]) -> Vec<(&str, usize)> {
        sections
            .iter()
            .map(|s| (s.heading.as_str(), s.bullets.len()))
            .collect()
    }

    #[test]
    fn test_parse_reply_has_one_heading_per_project_most_bullets_first_other_last() {
        let reply = "# Other\n- 2026-10-05 | Joined the planning meeting.\n\n\
                     # Orion\n- 2026-10-06 | Wrote the update notes.\n\n\
                     # Maestro\n- 2026-10-05 | Fixed the login timeout.\n\
                     - 2026-10-07 | Added the export button.\n\n\
                     # Secret project\n- 2026-10-08 | Helped a teammate.\n\n\
                     ## maestro\n- 2026-10-09 | Reviewed the export pull request.\n\n\
                     # Orion\n";
        let sections = parse(reply);
        // A project no card names goes to Other; a heading given twice (any
        // case) is one section under the cards' spelling; an empty one goes.
        assert_eq!(
            headings(&sections),
            [("Maestro", 3), ("Orion", 1), ("Other", 2)]
        );
        assert_eq!(sections[2].bullets[1].text, "Helped a teammate.");
    }

    #[test]
    fn test_parse_reply_puts_bullets_oldest_day_first_and_reads_days_and_times() {
        let reply = "# Maestro\n\
                     - Kept notes on the export.\n\
                     - 2026-10-09 | Shipped the export.\n\
                     - 2026-10-07, 2026-10-05 | Reviewed the login changes.\n\
                     - 2026-10-06 16:00 | Paired on the parser.\n\
                     - 2026-10-06 09:15 | Fixed the login timeout.\n\
                     - 2026-10-08 10:00 11:00 | Answered two questions.\n";
        assert_eq!(
            parse(reply)[0].bullets,
            vec![
                // Several days: every day, oldest first, sorted by the first.
                bullet(
                    &["2026-10-05", "2026-10-07"],
                    None,
                    "Reviewed the login changes."
                ),
                bullet(&["2026-10-06"], Some("09:15"), "Fixed the login timeout."),
                bullet(&["2026-10-06"], Some("16:00"), "Paired on the parser."),
                // Two timed entries on one day: the day only.
                bullet(&["2026-10-08"], None, "Answered two questions."),
                bullet(&["2026-10-09"], None, "Shipped the export."),
                // No date: still shown, last.
                bullet(&[], None, "Kept notes on the export."),
            ]
        );
    }

    #[test]
    fn test_parse_reply_drops_dates_outside_the_range_but_keeps_the_bullet() {
        let reply = "# Maestro\n\
                     - 2026-09-30 14:00 | Before the range.\n\
                     - 2026-10-05, 2026-12-01 | Partly after the range.\n\
                     - 2026-10-06 10:00, 2027-01-01 | One real day of two.\n\
                     - 2026-10-07, 2026-10-07 | The same day twice.\n";
        assert_eq!(
            parse(reply)[0].bullets,
            vec![
                bullet(&["2026-10-05"], None, "Partly after the range."),
                // It rested on two entries, so no time even with one day left.
                bullet(&["2026-10-06"], None, "One real day of two."),
                bullet(&["2026-10-07"], None, "The same day twice."),
                bullet(&[], None, "Before the range."),
            ]
        );
    }

    #[test]
    fn test_parse_reply_reads_untidy_dates_separators_and_nulls_safely() {
        let cases: [(&str, ReportBullet); 12] = [
            (
                "- 2026-10-05 14:20 — Fixed it.",
                bullet(&["2026-10-05"], Some("14:20"), "Fixed it."),
            ),
            (
                "- [2026-10-05] Fixed it.",
                bullet(&["2026-10-05"], None, "Fixed it."),
            ),
            (
                "- 2026-10-05: Fixed it.",
                bullet(&["2026-10-05"], None, "Fixed it."),
            ),
            (
                "- (2026-10-05 14:20) | Fixed it.",
                bullet(&["2026-10-05"], Some("14:20"), "Fixed it."),
            ),
            (
                "- 2026-10-05,2026-10-06|Fixed it.",
                bullet(&["2026-10-05", "2026-10-06"], None, "Fixed it."),
            ),
            ("- null | Fixed it.", bullet(&[], None, "Fixed it.")),
            ("- N/A | Fixed it.", bullet(&[], None, "Fixed it.")),
            ("- | Fixed it.", bullet(&[], None, "Fixed it.")),
            ("- 14:20 | Fixed it.", bullet(&[], None, "Fixed it.")),
            (
                "- 2026-1-5 | Fixed it.",
                bullet(&[], None, "2026-1-5 | Fixed it."),
            ),
            (
                "- Fixed the a | b toggle.",
                bullet(&[], None, "Fixed the a | b toggle."),
            ),
            (
                "- 2026-10-05 # 3 = done | Fixed it.",
                bullet(&["2026-10-05"], None, "3 = done | Fixed it."),
            ),
        ];
        for (line, expected) in cases {
            let reply = format!("# Maestro\n{line}");
            assert_eq!(parse(&reply)[0].bullets, vec![expected], "{line:?}");
        }
        // A bullet with no sentence is dropped, never shown empty.
        let reply = "# Maestro\n- 2026-10-05 |\n- null\n- None.\n- 2026-10-06 | undefined\n\
                     - 2026-10-07 | Kept.";
        assert_eq!(
            parse(reply)[0].bullets,
            vec![bullet(&["2026-10-07"], None, "Kept.")]
        );
    }

    #[test]
    fn test_parse_reply_keeps_every_plain_line() {
        // A wrapped bullet's next line continues it; a plain line starting
        // with a date, or after a blank line or heading, is its own bullet.
        let reply = "Here is the report.\n\n# Maestro\n- 2026-10-05 | Fixed the login\n\
                     timeout for long sessions.\n2026-10-06 | Added the export.\n\n\
                     Wrote the docs.";
        let sections = parse(reply);
        assert_eq!(headings(&sections), [("Maestro", 3), ("Other", 1)]);
        assert_eq!(
            sections[0].bullets,
            vec![
                bullet(
                    &["2026-10-05"],
                    None,
                    "Fixed the login timeout for long sessions."
                ),
                bullet(&["2026-10-06"], None, "Added the export."),
                bullet(&[], None, "Wrote the docs."),
            ]
        );
        assert_eq!(sections[1].bullets[0].text, "Here is the report.");
    }

    #[test]
    fn test_parse_reply_with_no_card_projects_puts_everything_under_other() {
        let (start, end) = week();
        let sections = parse_reply("# Maestro\n- 2026-10-05 | Fixed it.", start, end, &[])
            .unwrap()
            .unwrap();
        assert_eq!(headings(&sections), [("Other", 1)]);
    }

    #[test]
    fn test_system_prompt_examples_are_what_the_parser_reads() {
        let examples: Vec<&str> = SYSTEM_PROMPT
            .split("for example: ")
            .skip(1)
            .map(|rest| rest.lines().next().unwrap())
            .collect();
        assert_eq!(examples.len(), 2, "{examples:?}");
        let (start, end) = (day("2026-11-01"), day("2026-11-30"));
        let reply = format!("# Maestro\n{}\n{}", examples[0], examples[1]);
        let sections = parse_reply(&reply, start, end, &projects())
            .unwrap()
            .unwrap();
        assert_eq!(
            sections[0].bullets,
            vec![
                bullet(&["2026-11-03"], Some("14:20"), "Fixed the login timeout."),
                bullet(
                    &["2026-11-03", "2026-11-05"],
                    None,
                    "Reviewed the export changes."
                ),
            ]
        );
    }

    #[test]
    fn test_bullet_line_starts_with_the_day_and_a_time_only_for_one_day() {
        assert_eq!(
            bullet_line(&bullet(&["2026-10-05"], Some("14:20"), "Fixed it.")),
            "Mon 5 Oct, 14:20 — Fixed it."
        );
        assert_eq!(
            bullet_line(&bullet(&["2026-10-05"], None, "Fixed it.")),
            "Mon 5 Oct — Fixed it."
        );
        assert_eq!(
            bullet_line(&bullet(
                &["2026-10-05", "2026-10-07"],
                Some("14:20"),
                "Fixed it."
            )),
            "Mon 5 Oct, Wed 7 Oct — Fixed it."
        );
        assert_eq!(bullet_line(&bullet(&[], None, "Fixed it.")), "Fixed it.");
    }

    #[test]
    fn test_parse_reply_none_is_nothing_to_report() {
        for reply in [
            "NONE",
            "  NONE\n",
            "None",
            "none",
            "NONE.",
            "None!",
            "\n\nNONE\nThe pages only say Weekend.",
            "none.\n\n# Delivered\n- x",
        ] {
            let (start, end) = week();
            assert_eq!(
                parse_reply(reply, start, end, &projects()).unwrap(),
                None,
                "{reply:?}"
            );
        }
        // NONE inside other text, or not on the first line, is just text.
        for reply in [
            "NONE of that\n- x",
            "Overview.\nNONE",
            "Nonetheless I shipped it.",
        ] {
            assert!(!parse(reply).is_empty(), "{reply:?}");
        }
    }

    #[test]
    fn test_parse_reply_reads_other_bullet_markers_without_the_marker() {
        let reply = "# Maestro\n* 2026-10-05 | Fixed the login bug\n• 2026-10-06 | Shipped the \
                     export\n1. 2026-10-07 | Reviewed a PR\n12) 2026-10-08 | Helped a teammate\n\
                     - 2026-10-09 | Wrote docs";
        let texts: Vec<String> = parse(reply)[0]
            .bullets
            .iter()
            .map(|b| b.text.clone())
            .collect();
        assert_eq!(
            texts,
            [
                "Fixed the login bug",
                "Shipped the export",
                "Reviewed a PR",
                "Helped a teammate",
                "Wrote docs"
            ]
        );
        // A number without its marker, or a marker without a space, is text:
        // "*bold*" continues the line before it.
        assert_eq!(
            parse("2026 was busy.\n*bold*")[0].bullets,
            vec![bullet(&[], None, "2026 was busy. *bold*")]
        );
    }

    #[test]
    fn test_an_old_cli_without_safe_mode_gets_a_plain_message() {
        let err = claude_error(
            "claude exited with exit code: 1: error: unknown option '--safe-mode'".into(),
        );
        assert!(matches!(err, ReportError::CliTooOld));
        assert_eq!(
            err.to_string(),
            "Your Claude Code is too old for reports (it does not know --safe-mode). Update \
             Claude Code and try again."
        );
        // Any other failure keeps its own message, prefixed once.
        let other = claude_error("claude did not answer within 300s".into());
        assert_eq!(
            other.to_string(),
            "Claude could not write the report: claude did not answer within 300s"
        );
        let unrelated = claude_error("error: unknown option '--frobnicate'".into());
        assert!(matches!(unrelated, ReportError::Claude(_)));
    }

    #[tokio::test]
    async fn test_generate_with_an_old_cli_writes_nothing_and_never_retries() {
        let dir = tempdir().unwrap();
        let journal = journal_in(dir.path());
        let fake = FakeClaude::default();
        let err = generate_report_with(
            &journal,
            "2026-10-05",
            "2026-10-09",
            "now",
            fake.ask(Err(
                "claude exited with exit code: 1: error: unknown option '--safe-mode'",
            )),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ReportError::CliTooOld));
        assert_eq!(fake.calls().len(), 1, "no second run without --safe-mode");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn test_parse_reply_drops_garbage_lines() {
        let reply = "```\n# Maestro\n---\n- Fixed it\n***\n#\n-\n```\n";
        let sections = parse(reply);
        assert_eq!(headings(&sections), [("Maestro", 1)]);
        assert_eq!(sections[0].bullets, vec![bullet(&[], None, "Fixed it")]);
        // "#tag" is not a heading (no space), so it stays text.
        assert_eq!(
            parse("#tag line")[0].bullets,
            vec![bullet(&[], None, "#tag line")]
        );
    }

    #[test]
    fn test_parse_reply_with_nothing_usable_is_an_error() {
        let (start, end) = week();
        for reply in [
            "",
            "   \n\n",
            "```\n---\n```",
            "# Maestro\n\n# Other\n",
            "# Maestro\n- null\n- 2026-10-05 |\n- None.",
        ] {
            assert!(
                matches!(
                    parse_reply(reply, start, end, &projects()),
                    Err(ReportError::UnusableReply)
                ),
                "{reply:?}"
            );
        }
    }

    #[test]
    fn test_escape_html_escapes_every_special_character() {
        assert_eq!(
            escape_html(r#"<script>alert("x" & 'y')</script>"#),
            "&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;"
        );
    }

    fn sample_sections() -> Vec<ReportSection> {
        vec![
            ReportSection {
                heading: "Maestro".into(),
                bullets: vec![
                    bullet(&["2026-10-05"], Some("14:20"), "Fixed the login bug"),
                    bullet(&[], None, "Shipped"),
                ],
            },
            ReportSection {
                heading: OTHER_HEADING.into(),
                bullets: vec![bullet(&["2026-10-06", "2026-10-08"], None, "Met the team")],
            },
        ]
    }

    #[test]
    fn test_render_html_is_the_fixed_self_contained_template() {
        let html = render_html(
            "2026-10-05",
            "2026-10-09",
            "15 Oct 2026 at 14:05",
            &sample_sections(),
        );
        assert!(html.starts_with("<!DOCTYPE html>"));
        assert!(html.contains("<title>Work report 2026-10-05 to 2026-10-09</title>"));
        assert!(html.contains(">Work report 2026-10-05 to 2026-10-09</h1>"));
        assert!(html.contains("Generated on 15 Oct 2026 at 14:05 from the Work Journal."));
        assert!(
            !html.contains("<p style=\"margin:0 0 12px;\">"),
            "no overview paragraph"
        );
        let maestro = html.find(">Maestro</h2>").unwrap();
        let other = html.find(">Other</h2>").unwrap();
        assert!(maestro < other);
        assert!(html.contains(">Mon 5 Oct, 14:20 — Fixed the login bug</li>"));
        assert!(html.contains(">Shipped</li>"));
        assert!(html.contains(">Tue 6 Oct, Thu 8 Oct — Met the team</li>"));
        assert!(html.contains("<meta charset=\"utf-8\">"));
        let lower = html.to_lowercase();
        for banned in [
            "<script", "http://", "https://", "<img", "<link", "src=", "href=",
        ] {
            assert!(!lower.contains(banned), "the template holds {banned}");
        }
    }

    #[test]
    fn test_render_html_escapes_model_text_title_and_dates() {
        let blocks = vec![ReportSection {
            heading: "<b>bold</b>".into(),
            bullets: vec![
                bullet(&[], None, "<script>alert(1)</script>"),
                bullet(&["2026-10-05"], None, "<img src=x onerror=alert(1)>"),
            ],
        }];
        let html = render_html("<a>", "\"b\"", "<i>now</i>", &blocks);
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(html.contains("&lt;b&gt;bold&lt;/b&gt;"));
        assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;"));
        assert!(html.contains("Work report &lt;a&gt; to &quot;b&quot;"));
        assert!(html.contains("&lt;i&gt;now&lt;/i&gt;"));
        let lower = html.to_lowercase();
        assert!(!lower.contains("<script"));
        assert!(!lower.contains("<img"));
        assert!(!lower.contains("<b>"));
    }

    #[test]
    fn test_report_folder_is_a_named_setting_patched_alone() {
        let mut journal =
            parse_journal(r#"{"layout_version": 1, "settings": {"model": "haiku"}}"#).unwrap();
        assert_eq!(journal.settings.report_folder, None);
        let patch = Map::from_iter([("report_folder".to_string(), json!("D:\\Reports"))]);
        merge_settings(&mut journal, patch).unwrap();
        assert_eq!(
            journal.settings.report_folder.as_deref(),
            Some("D:\\Reports")
        );
        assert_eq!(journal.settings.model.as_deref(), Some("haiku"));
        assert!(journal.settings.extra.is_empty());
        assert_eq!(
            serde_json::to_value(&journal.settings).unwrap()["report_folder"],
            json!("D:\\Reports")
        );
    }

    // --- generate_report_with (fake Claude) ---

    /// One Claude call: its arguments and its stdin input.
    type Call = (Vec<String>, String);

    /// Records each Claude call's arguments and input, and replies `reply`.
    #[derive(Clone, Default)]
    struct FakeClaude {
        calls: Arc<StdMutex<Vec<Call>>>,
    }

    impl FakeClaude {
        fn ask(
            &self,
            reply: Result<&str, &str>,
        ) -> impl FnOnce(Vec<String>, String) -> std::future::Ready<Result<String, String>>
        {
            let calls = self.calls.clone();
            let reply = reply.map(str::to_string).map_err(str::to_string);
            move |args, input| {
                calls.lock().unwrap().push((args, input));
                std::future::ready(reply)
            }
        }

        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }
    }

    fn journal_in(folder: &Path) -> WorkJournal {
        let mut journal = sample_journal();
        journal.settings.report_folder = Some(folder.display().to_string());
        journal
    }

    const REPLY: &str = "# Other\n- 2026-10-05 | Fixed the login bug";

    #[tokio::test]
    async fn test_generate_saves_the_report_and_overwrites_the_same_range() {
        let dir = tempdir().unwrap();
        let mut journal = journal_in(dir.path());
        add_page(
            &mut journal,
            "2026-10-08",
            body(&["<script>alert(1)</script>"]),
        );
        let fake = FakeClaude::default();

        let result = generate_report_with(
            &journal,
            "2026-10-05",
            "2026-10-09",
            "now",
            fake.ask(Ok(REPLY)),
        )
        .await
        .unwrap();
        let target = dir.path().join("work-report_2026-10-05_to_2026-10-09.html");
        assert_eq!(result, ReportResult::Saved(target.clone()));
        let html = std::fs::read_to_string(&target).unwrap();
        assert!(html.contains(">Mon 5 Oct — Fixed the login bug</li>"));
        assert!(html.contains("Work report 2026-10-05 to 2026-10-09"));

        // Claude got the pages' text (the script as plain text) and the
        // report's own command line.
        let calls = fake.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, claude_args(None).unwrap());
        assert!(calls[0].1.contains("<script>alert(1)</script>"));
        assert!(!calls[0].1.contains("Before the range"));

        // A page body's script echoed by the model ends up escaped.
        let echo = "# Notes\n- <script>alert(1)</script>";
        generate_report_with(
            &journal,
            "2026-10-05",
            "2026-10-09",
            "later",
            fake.ask(Ok(echo)),
        )
        .await
        .unwrap();
        let html = std::fs::read_to_string(&target).unwrap();
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(!html.to_lowercase().contains("<script"));
        assert!(
            !html.contains("Fixed the login bug"),
            "the old report was replaced"
        );
        let files: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(files.len(), 1, "one file per range, no temp file left");
    }

    #[tokio::test]
    async fn test_generate_a_different_range_makes_a_new_file() {
        let dir = tempdir().unwrap();
        let journal = journal_in(dir.path());
        let fake = FakeClaude::default();
        for (from, to) in [("2026-10-05", "2026-10-09"), ("2026-10-08", "2026-10-09")] {
            generate_report_with(&journal, from, to, "now", fake.ask(Ok(REPLY)))
                .await
                .unwrap();
        }
        assert!(dir
            .path()
            .join("work-report_2026-10-05_to_2026-10-09.html")
            .exists());
        assert!(dir
            .path()
            .join("work-report_2026-10-08_to_2026-10-09.html")
            .exists());
    }

    #[tokio::test]
    async fn test_generate_with_only_weekend_and_empty_pages_is_nothing_to_report() {
        let dir = tempdir().unwrap();
        let journal = journal_in(dir.path());
        let fake = FakeClaude::default();
        let result = generate_report_with(
            &journal,
            "2026-10-06",
            "2026-10-07",
            "now",
            fake.ask(Ok(REPLY)),
        )
        .await
        .unwrap();
        assert_eq!(result, ReportResult::NothingToReport);
        assert!(fake.calls().is_empty(), "Claude is never asked");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "no file");
    }

    #[tokio::test]
    async fn test_generate_when_claude_says_none_writes_nothing() {
        let dir = tempdir().unwrap();
        let journal = journal_in(dir.path());
        let fake = FakeClaude::default();
        let result = generate_report_with(
            &journal,
            "2026-10-05",
            "2026-10-09",
            "now",
            fake.ask(Ok("NONE")),
        )
        .await
        .unwrap();
        assert_eq!(result, ReportResult::NothingToReport);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn test_generate_without_a_folder_asks_nothing() {
        let mut journal = sample_journal();
        let fake = FakeClaude::default();
        for folder in [None, Some("  ".to_string())] {
            journal.settings.report_folder = folder;
            let result = generate_report_with(
                &journal,
                "2026-10-05",
                "2026-10-09",
                "now",
                fake.ask(Ok(REPLY)),
            )
            .await
            .unwrap();
            assert_eq!(result, ReportResult::NoFolder);
        }
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn test_generate_into_a_missing_folder_errors_and_never_creates_it() {
        let dir = tempdir().unwrap();
        let gone = dir.path().join("gone");
        let journal = journal_in(&gone);
        let fake = FakeClaude::default();
        let err = generate_report_with(
            &journal,
            "2026-10-05",
            "2026-10-09",
            "now",
            fake.ask(Ok(REPLY)),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ReportError::FolderMissing(_)), "{err}");
        assert!(err.to_string().contains("does not exist"));
        assert!(!gone.exists(), "the folder is never created");
        assert!(fake.calls().is_empty());

        let file = dir.path().join("a-file");
        std::fs::write(&file, "x").unwrap();
        let err = generate_report_with(
            &journal_in(&file),
            "2026-10-05",
            "2026-10-09",
            "now",
            fake.ask(Ok(REPLY)),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ReportError::FolderNotAFolder(_)), "{err}");
    }

    #[tokio::test]
    async fn test_generate_reports_claude_failures_and_bad_input_without_a_file() {
        let dir = tempdir().unwrap();
        let mut journal = journal_in(dir.path());
        let fake = FakeClaude::default();

        let err = generate_report_with(
            &journal,
            "2026-10-05",
            "2026-10-09",
            "now",
            fake.ask(Err("claude did not answer within 300s")),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("did not answer"), "{err}");

        let err = generate_report_with(
            &journal,
            "2026-10-05",
            "2026-10-09",
            "now",
            fake.ask(Ok("```\n```")),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ReportError::UnusableReply));

        let err = generate_report_with(
            &journal,
            "2026-10-09",
            "2026-10-05",
            "now",
            fake.ask(Ok(REPLY)),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ReportError::RangeReversed { .. }));

        journal.settings.model = Some("bad model".into());
        let err = generate_report_with(
            &journal,
            "2026-10-05",
            "2026-10-09",
            "now",
            fake.ask(Ok(REPLY)),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ReportError::Model(_)));

        assert_eq!(
            fake.calls().len(),
            2,
            "only the two runs that got that far asked"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn test_generate_passes_the_shared_model_setting() {
        let dir = tempdir().unwrap();
        let mut journal = journal_in(dir.path());
        journal.settings.model = Some("haiku".into());
        let fake = FakeClaude::default();
        generate_report_with(
            &journal,
            "2026-10-05",
            "2026-10-09",
            "now",
            fake.ask(Ok(REPLY)),
        )
        .await
        .unwrap();
        assert_eq!(fake.calls()[0].0, claude_args(Some("haiku")).unwrap());
    }

    #[test]
    fn test_parse_range_allows_at_most_the_day_cap_inclusive() {
        assert_eq!(
            parse_range("2026-01-01", "2026-04-02").unwrap(),
            (day("2026-01-01"), day("2026-04-02")),
            "92 days, both ends included"
        );
        let err = parse_range("2026-01-01", "2026-04-03").unwrap_err();
        assert!(
            matches!(err, ReportError::RangeTooLong { max: 92 }),
            "{err}"
        );
        assert_eq!(err.to_string(), "Choose a range of at most 92 days.");
    }

    #[tokio::test]
    async fn test_generate_refuses_a_too_long_range_or_too_much_text_without_asking() {
        let dir = tempdir().unwrap();
        let mut journal = journal_in(dir.path());
        let fake = FakeClaude::default();

        let err = generate_report_with(
            &journal,
            "2026-01-01",
            "2026-10-09",
            "now",
            fake.ask(Ok(REPLY)),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ReportError::RangeTooLong { .. }), "{err}");

        let long = "x".repeat(MAX_REPORT_INPUT_CHARS);
        add_page(&mut journal, "2026-10-08", body(&[&long]));
        let err = generate_report_with(
            &journal,
            "2026-10-05",
            "2026-10-09",
            "now",
            fake.ask(Ok(REPLY)),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ReportError::InputTooLarge), "{err}");
        assert!(err.to_string().contains("pick a shorter range"), "{err}");

        assert!(fake.calls().is_empty(), "Claude is never asked");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn test_generate_a_sample_week_has_project_headings_and_dated_bullets() {
        let dir = tempdir().unwrap();
        let journal = card_week(Some(dir.path()));
        let fake = FakeClaude::default();
        // An untidy reply: Other first, a project twice in another case, a
        // project no card names, days out of order and one outside the range.
        let reply = "# Other\n- 2026-10-05 11:00 | Joined the planning meeting.\n\n\
                     # Orion\n- 2026-10-06 | Wrote the update notes.\n\n\
                     # Maestro\n- 2026-10-07 14:20 | Added the export button.\n\
                     - 2026-10-05 09:15 | Fixed the login timeout.\n\n\
                     # MAESTRO\n- 2026-10-08 16:00 | Reviewed the export pull request.\n\
                     - 2026-10-07, 2026-10-05 | Tested the login and the export.\n\n\
                     # Billing\n- 2026-11-20 | Helped with an invoice question.\n";
        generate_report_with(
            &journal,
            "2026-10-05",
            "2026-10-08",
            "now",
            fake.ask(Ok(reply)),
        )
        .await
        .unwrap();
        let html =
            std::fs::read_to_string(dir.path().join("work-report_2026-10-05_to_2026-10-08.html"))
                .unwrap();
        let items: Vec<&str> = html
            .lines()
            .filter_map(|line| {
                line.split_once("\">")
                    .filter(|_| line.starts_with("<h2") || line.starts_with("<li"))
                    .map(|(_, rest)| rest)
            })
            .collect();
        assert_eq!(
            items,
            [
                "Maestro</h2>",
                "Mon 5 Oct, 09:15 — Fixed the login timeout.</li>",
                "Mon 5 Oct, Wed 7 Oct — Tested the login and the export.</li>",
                "Wed 7 Oct, 14:20 — Added the export button.</li>",
                "Thu 8 Oct, 16:00 — Reviewed the export pull request.</li>",
                "Orion</h2>",
                "Tue 6 Oct — Wrote the update notes.</li>",
                "Other</h2>",
                "Mon 5 Oct, 11:00 — Joined the planning meeting.</li>",
                "Helped with an invoice question.</li>",
            ]
        );
        assert!(fake.calls()[0]
            .1
            .contains("Projects on the cards: Maestro, Orion."));
    }

    #[test]
    fn test_only_one_report_at_a_time() {
        let first = try_begin_report().expect("free");
        assert!(try_begin_report().is_none());
        drop(first);
        assert!(try_begin_report().is_some());
    }
}
