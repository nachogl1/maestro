//! The Work Journal's supervisor report (issue #316): for a from/to date
//! range, a headless `claude -p` turns the text of the day pages in that
//! range into an achievement-focused summary, and Maestro fills one fixed,
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
//! [`build_input`], [`claude_args`], [`parse_reply`], [`render_html`]) are
//! unit-tested; [`generate_report_with`] takes the Claude call as a closure,
//! so tests never start the real `claude` CLI.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::NaiveDate;
use tokio::sync::{Mutex, MutexGuard};

use crate::core::atomic_write::atomic_write_durable_async;
use crate::core::work_journal::WorkJournal;
use crate::core::work_journal_run::{is_safe_model, page_text, run_process};

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
page starts with a line giving its date and title, followed by the page text.\n\
Summarise the work the pages record: work delivered, problems fixed, decisions made and \
help given to others. Put the strongest items first and group related work by theme or \
project. Do not write a day-by-day log.\n\
Facts only, follow these rules exactly:\n\
- Describe each item in the page's own words or a plain paraphrase of them.\n\
- Never add significance, impact or quality words the page does not contain: no \
\"security\", \"critical\", \"major\", \"key\", \"significantly\", \"robust\", \
\"successfully\" or similar, unless the page itself uses that word.\n\
- Never add outcomes, numbers, names or reasons that are not written in the pages.\n\
- You choose which items to include and in which order, but never upgrade an item: a small \
change stays a small change.\n\
- When unsure how to describe an item, quote the page's wording.\n\
Output contract, follow it exactly:\n\
- Plain text only: no HTML, no markdown emphasis (no ** or _), no tables, no code blocks, \
no preamble and no closing remarks.\n\
- A line starting with \"# \" is a section heading, for example: # Delivered\n\
- A line starting with \"- \" is one bullet point.\n\
- Any other line is paragraph text.\n\
- Separate blocks with one blank line.\n\
- Start with a one or two sentence overview that only names what was done, then a few \
sections, each a heading followed by bullets.\n\
- Write in English, in the first person and the past tense.\n\
- If the pages hold nothing worth reporting, reply with exactly: NONE";

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
}

/// One block of the report, from the reply contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReportBlock {
    /// A section heading (`# text`).
    Heading(String),
    /// One list of consecutive bullets (`- `, `* `, `• ` or `1. ` lines),
    /// markers stripped.
    Bullets(Vec<String>),
    /// Consecutive plain lines joined into one paragraph.
    Paragraph(String),
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
            Some((
                date,
                ReportPage {
                    date: page.date.clone(),
                    title: page.title.clone(),
                    text,
                },
            ))
        })
        .collect();
    pages.sort_by_key(|(date, _)| *date);
    pages.into_iter().map(|(_, page)| page).collect()
}

/// The stdin input: the range, then per page a `Page <date>: <title>` line
/// and its text, pages separated by a blank line.
pub fn build_input(from: &str, to: &str, pages: &[ReportPage]) -> String {
    let mut input = format!("Work Journal pages from {from} to {to}.\n");
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

/// Adds the block being built (if any) to `blocks`.
fn end_block(blocks: &mut Vec<ReportBlock>, current: &mut Option<ReportBlock>) {
    if let Some(block) = current.take() {
        blocks.push(block);
    }
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

/// Parses the reply contract into blocks. `Ok(None)` when the reply says
/// `NONE` (see [`says_none`]).
///
/// - `# text` is a heading (deeper `## text` levels are read as headings
///   too, so a stray markdown level never shows its `#` signs).
/// - `- text` is a bullet (`* `, `• ` and `1. ` markers too, stripped);
///   consecutive bullets form one list.
/// - Any other line is paragraph text; consecutive lines form one paragraph.
/// - A blank line ends the block.
/// - Code fences and lines with no letter or digit (`---`, `***`, a lone
///   `#`) are dropped.
///
/// A reply with no block left is an error.
pub fn parse_reply(reply: &str) -> Result<Option<Vec<ReportBlock>>, ReportError> {
    if says_none(reply) {
        return Ok(None);
    }
    let mut blocks = Vec::new();
    let mut current: Option<ReportBlock> = None;
    for line in reply.lines() {
        let line = line.trim();
        if line.is_empty() {
            end_block(&mut blocks, &mut current);
            continue;
        }
        if line.starts_with("```") || !line.chars().any(char::is_alphanumeric) {
            continue;
        }
        let unhashed = line.trim_start_matches('#');
        if unhashed.len() < line.len() && unhashed.starts_with(' ') {
            end_block(&mut blocks, &mut current);
            blocks.push(ReportBlock::Heading(unhashed.trim().to_string()));
        } else if let Some(bullet) = bullet_text(line) {
            let bullet = bullet.trim().to_string();
            match &mut current {
                Some(ReportBlock::Bullets(items)) => items.push(bullet),
                _ => {
                    end_block(&mut blocks, &mut current);
                    current = Some(ReportBlock::Bullets(vec![bullet]));
                }
            }
        } else {
            match &mut current {
                Some(ReportBlock::Paragraph(text)) => {
                    text.push(' ');
                    text.push_str(line);
                }
                _ => {
                    end_block(&mut blocks, &mut current);
                    current = Some(ReportBlock::Paragraph(line.to_string()));
                }
            }
        }
    }
    end_block(&mut blocks, &mut current);
    if blocks.is_empty() {
        return Err(ReportError::UnusableReply);
    }
    Ok(Some(blocks))
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
const P_STYLE: &str = "margin:0 0 12px;";
const UL_STYLE: &str = "margin:0 0 12px;padding-left:22px;";
const LI_STYLE: &str = "margin:0 0 6px;";

/// The fixed, self-contained report page: the title `Work report <from> to
/// <to>`, a generated-on line, then the blocks. Inline styles only; no
/// script, no external link, no image. Every piece of text is escaped.
pub fn render_html(from: &str, to: &str, generated_on: &str, blocks: &[ReportBlock]) -> String {
    let title = escape_html(&format!("Work report {from} to {to}"));
    let mut sections = String::new();
    for block in blocks {
        match block {
            ReportBlock::Heading(text) => sections.push_str(&format!(
                "<h2 style=\"{H2_STYLE}\">{}</h2>\n",
                escape_html(text)
            )),
            ReportBlock::Paragraph(text) => sections.push_str(&format!(
                "<p style=\"{P_STYLE}\">{}</p>\n",
                escape_html(text)
            )),
            ReportBlock::Bullets(items) => {
                sections.push_str(&format!("<ul style=\"{UL_STYLE}\">\n"));
                for item in items {
                    sections.push_str(&format!(
                        "<li style=\"{LI_STYLE}\">{}</li>\n",
                        escape_html(item)
                    ));
                }
                sections.push_str("</ul>\n");
            }
        }
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
    let Some(blocks) = parse_reply(&reply)? else {
        return Ok(ReportResult::NothingToReport);
    };
    let html = render_html(from, to, generated_on, &blocks);
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
            "Put the strongest items first",
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
        // The old spin-inviting wording is gone.
        for gone in ["look good", "how to frame it"] {
            assert!(!SYSTEM_PROMPT.contains(gone), "still has {gone}");
        }
    }

    #[test]
    fn test_parse_reply_reads_headings_bullets_and_paragraphs() {
        let reply = "I delivered the login fix and the export.\nIt went well.\n\n\
                     # Delivered\n- Fixed the login bug\n- Shipped the export\n\n\
                     ## Reviews\n- Reviewed a PR\nA closing line.\n";
        assert_eq!(
            parse_reply(reply).unwrap().unwrap(),
            vec![
                ReportBlock::Paragraph(
                    "I delivered the login fix and the export. It went well.".into()
                ),
                ReportBlock::Heading("Delivered".into()),
                ReportBlock::Bullets(vec![
                    "Fixed the login bug".into(),
                    "Shipped the export".into()
                ]),
                ReportBlock::Heading("Reviews".into()),
                ReportBlock::Bullets(vec!["Reviewed a PR".into()]),
                ReportBlock::Paragraph("A closing line.".into()),
            ]
        );
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
            assert_eq!(parse_reply(reply).unwrap(), None, "{reply:?}");
        }
        // NONE inside other text, or not on the first line, is just text.
        assert!(parse_reply("NONE of that\n- x").unwrap().is_some());
        assert!(parse_reply("Overview.\nNONE").unwrap().is_some());
        assert!(parse_reply("Nonetheless I shipped it.").unwrap().is_some());
    }

    #[test]
    fn test_parse_reply_reads_other_bullet_markers_without_the_marker() {
        let reply = "* Fixed the login bug\n• Shipped the export\n1. Reviewed a PR\n\
                     12) Helped a teammate\n- Wrote docs";
        assert_eq!(
            parse_reply(reply).unwrap().unwrap(),
            vec![ReportBlock::Bullets(vec![
                "Fixed the login bug".into(),
                "Shipped the export".into(),
                "Reviewed a PR".into(),
                "Helped a teammate".into(),
                "Wrote docs".into(),
            ])]
        );
        // A number without its marker, or a marker without a space, is text.
        assert_eq!(
            parse_reply("2026 was busy.\n*bold*").unwrap().unwrap(),
            vec![ReportBlock::Paragraph("2026 was busy. *bold*".into())]
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
        let reply = "```\n# Delivered\n---\n- Fixed it\n***\n#\n-\n```\n";
        assert_eq!(
            parse_reply(reply).unwrap().unwrap(),
            vec![
                ReportBlock::Heading("Delivered".into()),
                ReportBlock::Bullets(vec!["Fixed it".into()]),
            ]
        );
        // "#tag" is not a heading (no space), so it stays text.
        assert_eq!(
            parse_reply("#tag line").unwrap().unwrap(),
            vec![ReportBlock::Paragraph("#tag line".into())]
        );
    }

    #[test]
    fn test_parse_reply_with_nothing_usable_is_an_error() {
        for reply in ["", "   \n\n", "```\n---\n```"] {
            assert!(
                matches!(parse_reply(reply), Err(ReportError::UnusableReply)),
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

    fn sample_blocks() -> Vec<ReportBlock> {
        vec![
            ReportBlock::Paragraph("Overview text.".into()),
            ReportBlock::Heading("Delivered".into()),
            ReportBlock::Bullets(vec!["Fixed the login bug".into(), "Shipped".into()]),
        ]
    }

    #[test]
    fn test_render_html_is_the_fixed_self_contained_template() {
        let html = render_html(
            "2026-10-05",
            "2026-10-09",
            "15 Oct 2026 at 14:05",
            &sample_blocks(),
        );
        assert!(html.starts_with("<!DOCTYPE html>"));
        assert!(html.contains("<title>Work report 2026-10-05 to 2026-10-09</title>"));
        assert!(html.contains(">Work report 2026-10-05 to 2026-10-09</h1>"));
        assert!(html.contains("Generated on 15 Oct 2026 at 14:05 from the Work Journal."));
        assert!(html.contains(">Overview text.</p>"));
        assert!(html.contains(">Delivered</h2>"));
        assert!(html.contains(">Fixed the login bug</li>"));
        assert!(html.contains(">Shipped</li>"));
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
        let blocks = vec![
            ReportBlock::Heading("<b>bold</b>".into()),
            ReportBlock::Paragraph("<script>alert(1)</script>".into()),
            ReportBlock::Bullets(vec!["<img src=x onerror=alert(1)>".into()]),
        ];
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

    const REPLY: &str = "Overview.\n\n# Delivered\n- Fixed the login bug";

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
        assert!(html.contains(">Fixed the login bug</li>"));
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

    #[test]
    fn test_only_one_report_at_a_time() {
        let first = try_begin_report().expect("free");
        assert!(try_begin_report().is_none());
        drop(first);
        assert!(try_begin_report().is_some());
    }
}
