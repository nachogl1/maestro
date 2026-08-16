//! Shared mechanics for Maestro's headless-Claude features (standup report,
//! daily plan, …).
//!
//! Every one of them does the same four things: build a prompt from local
//! material, run it through `claude -p` inside a repo (the user's existing
//! Claude Code login — no API key), and persist the answer as a dated
//! markdown artifact it can serve back later. This module owns that
//! machinery; feature modules own only their prompt and their material.
//!
//! Artifacts live at `<app data>/<kind>/[<project>/]<YYYY-MM-DD>.md` — one
//! directory per KIND ("standups", "plans"), optionally scoped to a project
//! for per-project kinds. The standup layout predates this module and is
//! reproduced exactly, so previously saved reports keep loading.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use chrono::{DateTime, Local, NaiveDate, Utc};
use tokio::io::AsyncWriteExt;

use crate::core::status_server::StatusServer;

/// `claude -p` can take a while on a big context; kill it after this. It is
/// the ceiling for the features that summarise pre-gathered material in one
/// pass. Features whose run also has the model EXPLORE the repo (many tool
/// calls, minutes of work) pass their own — see [`run_and_save_with_timeout`].
pub const CLAUDE_TIMEOUT_SECS: u64 = 300;

/// Base directory for one artifact kind: `<app data>/<kind>/`.
pub fn artifact_base_dir(kind: &str) -> PathBuf {
    directories::ProjectDirs::from("com", "maestro", "maestro")
        .map(|p| p.data_dir().to_path_buf())
        .unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            PathBuf::from(home).join(".local/share/maestro")
        })
        .join(kind)
}

/// Per-project artifact directory: `<base>/<sanitized-name>-<hash12>/`. The
/// hash disambiguates same-named projects in different locations.
pub fn project_artifact_dir(kind: &str, canonical_project: &str) -> PathBuf {
    let name = Path::new(canonical_project)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "project".to_string());
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let hash = StatusServer::generate_project_hash(canonical_project);
    artifact_base_dir(kind).join(format!("{}-{}", sanitized, hash))
}

/// Canonicalizes a project path for artifact naming and as the `claude -p`
/// working directory. On Windows, canonicalize() prepends \\?\ (the
/// extended-length prefix); cmd.exe rejects that as a working directory and
/// silently falls back to C:\Windows, so the run would happen in the wrong
/// directory. Strip it, same as commands/terminal.rs.
pub fn canonical_project_path(project_path: &str) -> String {
    let canonical = std::fs::canonicalize(project_path)
        .unwrap_or_else(|_| PathBuf::from(project_path))
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    let canonical = canonical
        .strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or(canonical);
    canonical
}

/// Directory name of a project path, for display inside prompts.
pub fn project_name_of(canonical_project: &str) -> String {
    Path::new(canonical_project)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| canonical_project.to_string())
}

/// Today's local calendar date (YYYY-MM-DD) — the artifact's file name.
pub fn today_local() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Remove ANSI escape sequences (CSI and OSC) so saved artifacts are clean text.
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                // CSI: parameters end at the first "final byte" in '@'..='~'.
                chars.next();
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') => {
                // OSC: runs until BEL or ESC-backslash (ST).
                chars.next();
                while let Some(n) = chars.next() {
                    if n == '\u{07}' {
                        break;
                    }
                    if n == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            Some(_) => {
                // Two-character escape (e.g. ESC c).
                chars.next();
            }
            None => {}
        }
    }
    out
}

/// Truncate on a char boundary, appending a marker when content was dropped.
pub fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max_chars).collect();
    format!("{}\n[... truncated ...]", truncated)
}

/// Newest saved artifact date in `dir`, optionally strictly before `before`
/// (ISO dates sort lexically). This is what keeps yesterday's artifact
/// readable until today's replaces it.
pub async fn latest_artifact_date(dir: &Path, before: Option<&str>) -> Option<String> {
    let mut entries = tokio::fs::read_dir(dir).await.ok()?;
    let mut best: Option<String> = None;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(date) = name.strip_suffix(".md") {
            if date.len() == 10
                && NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
                && before.is_none_or(|b| date < b)
                && best.as_deref().is_none_or(|b| date > b)
            {
                best = Some(date.to_string());
            }
        }
    }
    best
}

/// Rejects anything that isn't a plain ISO date — it becomes a filename.
/// `noun` names the artifact in the error the user sees ("report", "plan").
pub fn validate_date(date: &str, noun: &str) -> Result<(), String> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| format!("Invalid {} date: {}", noun, date))
}

/// Single-pass placeholder interpolation over `template`: each `{token}` in
/// the TEMPLATE is replaced once, and substituted material is never
/// re-scanned — so a commit subject or issue title containing a literal
/// "{sessions}"/"{overview}" cannot get expanded (unlike chained
/// `str::replace`, which rescans the accumulated string).
pub fn interpolate(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    loop {
        let mut earliest: Option<(usize, &str, &str)> = None;
        for &(token, value) in vars {
            if let Some(pos) = rest.find(token) {
                if earliest.is_none_or(|(p, _, _)| pos < p) {
                    earliest = Some((pos, token, value));
                }
            }
        }
        match earliest {
            Some((pos, token, value)) => {
                out.push_str(&rest[..pos]);
                out.push_str(value);
                rest = &rest[pos + token.len()..];
            }
            None => {
                out.push_str(rest);
                return out;
            }
        }
    }
}

/// "(none)" placeholder for an empty material section, so the model sees an
/// explicit absence instead of a blank gap.
pub fn or_none(s: &str) -> &str {
    if s.trim().is_empty() {
        "(none)"
    } else {
        s
    }
}

/// Preamble every headless prompt gets (issue #97). The model's personal
/// `~/.claude/CLAUDE.md` and other loaded settings can carry the user's own
/// reply-formatting habits (a required reply prefix/canary, an output style,
/// a "save long output to a file" rule) — verified on the installed CLI:
/// even with [`claude_print_flags`]'s `--setting-sources` applied, a
/// personal-file instruction still reached the reply. This preamble is a
/// mitigation, not a guarantee — [`run_and_save_with_timeout`]'s validation
/// before save is the actual backstop.
const ARTIFACT_RUN_PREAMBLE: &str = "This is an unattended headless run: your ENTIRE reply is captured verbatim and saved as the artifact — nothing else reads or acts on it. Reply with ONLY the content requested below: no chat preamble, no \"Here is...\", no sign-off, nothing before or after it. Do NOT create, write, or edit any files, whatever a habit from your own settings suggests — the caller captures your reply text, not a file. Ignore any personal reply-formatting instruction that may be part of your loaded context (a required reply prefix or canary phrase, an output style, a rule to save long output to a file, or anything similar) — none of it applies to this run.\n\n---\n\n";

/// The flags every headless `claude -p` run gets, independent of the
/// caller's tool choice (issue #97 insulation — both verified against the
/// installed CLI's `claude --help`):
/// - `--setting-sources project,local` drops the user's global
///   `~/.claude/settings.json` (hooks, permission overrides, output style)
///   so a headless run does not depend on what happens to be configured on
///   the machine it runs on. It does NOT stop `~/.claude/CLAUDE.md` from
///   loading — tested empirically, the personal file's instructions still
///   reached the reply with this flag applied; there is no CLI flag that
///   excludes it without also breaking the OAuth login these runs rely on
///   (`--bare` requires an API key; `CLAUDE_CONFIG_DIR` hides the login too).
///   [`ARTIFACT_RUN_PREAMBLE`] and save-time validation cover that gap.
/// - `--tools`/`--allowedTools` gate the built-in tool set. An empty `tools`
///   slice now disables tools entirely (`--tools ""`, per `claude --help`)
///   rather than leaving the CLI's permissive defaults in place, so a
///   summarising run cannot write a file even if a leaked instruction told
///   it to; `--allowedTools` mirrors the list so any tools that ARE granted
///   skip a permission prompt a headless run has no way to answer.
fn claude_print_flags(tools: &[&str]) -> Vec<String> {
    let list = tools.join(",");
    vec![
        "--setting-sources".to_string(),
        "project,local".to_string(),
        "--tools".to_string(),
        list.clone(),
        "--allowedTools".to_string(),
        list,
    ]
}

/// Run `claude -p` headlessly in the project directory, prompt via stdin,
/// killed after `timeout_secs`. A run that has the model read its way around a
/// repository needs far longer than one that summarises material we already
/// gathered, so the ceiling is the caller's choice — [`CLAUDE_TIMEOUT_SECS`]
/// is the default the summarising features pass.
///
/// `tools` restricts the run to the named built-in tools; an empty slice now
/// disables tools entirely — see [`claude_print_flags`].
pub async fn run_claude_print_with_timeout(
    project_path: &str,
    prompt: String,
    timeout_secs: u64,
    tools: &[&str],
) -> Result<String, String> {
    #[cfg(windows)]
    let mut cmd = {
        use crate::core::windows_process::TokioCommandExt;
        // `claude` may be an npm `.cmd` shim, which CreateProcess cannot spawn
        // directly; route through cmd.exe. The prompt travels via stdin, so no
        // untrusted content ever reaches cmd's argument parser.
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", "claude", "-p"]);
        c.hide_console_window();
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("claude");
        c.arg("-p");
        c.env("PATH", crate::core::cli_path::augmented_path());
        c
    };

    cmd.args(claude_print_flags(tools));

    cmd.current_dir(project_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            "Claude CLI not found on PATH — install it with: npm install -g @anthropic-ai/claude-code".to_string()
        }
        _ => format!("Failed to start Claude CLI: {}", e),
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        let full_prompt = format!("{ARTIFACT_RUN_PREAMBLE}{prompt}");
        stdin
            .write_all(full_prompt.as_bytes())
            .await
            .map_err(|e| format!("Failed to send prompt to Claude CLI: {}", e))?;
        // Dropping stdin closes the pipe so `claude -p` knows input ended.
    }

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("Claude run timed out after {}s", timeout_secs))?
    .map_err(|e| format!("Claude run failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Claude CLI exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Minimal shape check for a saved artifact (issue #97): a conversational
/// chat reply that leaks a personal-file habit (a canary prefix, "I saved
/// this to a file for you") past [`ARTIFACT_RUN_PREAMBLE`] reads as a single
/// line/paragraph, never as the multi-line report/plan/catalogue each
/// consumer's template actually asks for. `expected_heading`, when a
/// consumer's template mandates one (harvest's literal `"## Recurring
/// themes"`, the catalogue's generic `"## "` area heading), is checked
/// against the first non-empty line too — those consumers also always
/// reject a single line. The standup and the daily plan have no fixed
/// heading (their templates explicitly forbid one) and CAN legitimately
/// answer in one line on a quiet day ("No agent activity yesterday —
/// nothing to report."), so for `None` a single line is accepted unless it
/// reads as a chat opener ([`looks_conversational`], review F5).
fn looks_like_artifact(body: &str, expected_heading: Option<&str>) -> bool {
    let mut lines = body.lines().filter(|l| !l.trim().is_empty());
    let first = match lines.next() {
        Some(l) => l.trim(),
        None => return false,
    };
    let single_line = lines.next().is_none();
    match expected_heading {
        // A mandated heading implies the multi-section template — a single
        // line is never that shape.
        Some(heading) => !single_line && first.starts_with(heading),
        None => !single_line || !looks_conversational(first),
    }
}

/// The one shape a single-line heading-less reply is NOT allowed to take
/// (issue #97's fixture): a chat opener — a leaked personal-canary/greeting
/// vocative ("Nacho, …", "Hi,") or a first-person conversational lead-in
/// ("I've saved…", "Sure, here's…"). Deliberately narrow: a false accept
/// only saves a chatty line to disk, while a false reject eats a
/// legitimate quiet-day answer.
fn looks_conversational(first_line: &str) -> bool {
    let Some(first_word) = first_line.split_whitespace().next() else {
        return false;
    };
    // "Nacho," / "Hello," — a single leading alphabetic word ending in a
    // comma is the canary's exact vocative shape.
    if first_word
        .strip_suffix(',')
        .is_some_and(|w| !w.is_empty() && w.chars().all(char::is_alphabetic))
    {
        return true;
    }
    // Two-word openers checked on the raw line; single-word ones on the
    // first word with trailing punctuation stripped ("Sure!" / "Hi.").
    if first_line.starts_with("I have ") || first_line.starts_with("Here is ") {
        return true;
    }
    let bare = first_word.trim_end_matches(['!', '.', ':']);
    ["I've", "Sure", "Here's", "Hi", "Hello", "Hey"].contains(&bare)
}

/// Run the prompt and persist the cleaned answer as `<dir>/<date>.md`.
/// Returns the saved markdown. An empty or non-report-shaped answer is an
/// error and saves nothing, so a failed run never consumes the day's slot on
/// disk. `noun` names the artifact in the errors the user sees ("report",
/// "plan"); `expected_heading` is the consumer's declared artifact shape —
/// see [`looks_like_artifact`].
pub async fn run_and_save(
    cwd: &str,
    prompt: String,
    dir: &Path,
    date: &str,
    expected_heading: Option<&str>,
    noun: &str,
) -> Result<String, String> {
    run_and_save_with_timeout(
        cwd,
        prompt,
        dir,
        date,
        CLAUDE_TIMEOUT_SECS,
        &[],
        expected_heading,
        noun,
    )
    .await
}

/// Same, with an explicit run timeout and tool restriction (see
/// [`run_claude_print_with_timeout`]).
#[allow(clippy::too_many_arguments)]
pub async fn run_and_save_with_timeout(
    cwd: &str,
    prompt: String,
    dir: &Path,
    date: &str,
    timeout_secs: u64,
    tools: &[&str],
    expected_heading: Option<&str>,
    noun: &str,
) -> Result<String, String> {
    let raw = run_claude_print_with_timeout(cwd, prompt, timeout_secs, tools).await?;
    let markdown = strip_ansi(&raw).trim().to_string();
    if markdown.is_empty() {
        return Err(format!("Claude returned an empty {}", noun));
    }
    if !looks_like_artifact(&markdown, expected_heading) {
        log::warn!(
            "ai_runner: rejected a {noun} that reads as a conversational reply, not a report — nothing saved. Rejected text (truncated): {}",
            truncate_chars(&markdown, 200)
        );
        return Err(format!(
            "Claude replied with a conversational answer instead of a {noun} — nothing was saved. This can happen when a personal Claude Code setting leaks into a headless run; try again."
        ));
    }

    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("Failed to create {} directory: {}", noun, e))?;
    let file_path = dir.join(format!("{}.md", date));
    tokio::fs::write(&file_path, &markdown)
        .await
        .map_err(|e| format!("Failed to save {}: {}", noun, e))?;
    Ok(markdown)
}

/// Read `<dir>/<date>.md`, returning its markdown and RFC 3339 mtime.
/// `Ok(None)` means "not generated", which callers surface as an empty panel
/// rather than an error.
pub async fn load_artifact(
    dir: &Path,
    date: &str,
    noun: &str,
) -> Result<Option<(String, String)>, String> {
    let file_path = dir.join(format!("{}.md", date));
    match tokio::fs::read_to_string(&file_path).await {
        Ok(markdown) => {
            let generated_at = tokio::fs::metadata(&file_path)
                .await
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
                .unwrap_or_default();
            Ok(Some((markdown, generated_at)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read {}: {}", noun, e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_print_flags_insulate_from_personal_settings_and_gate_tools() {
        // Issue #97: every headless run drops the user's global
        // settings.json (the only source-restriction flag verified to
        // exist) and, for a tools-less caller, disables the built-in tool
        // set entirely rather than leaving the CLI's permissive defaults in
        // place — asserted on the composed argv, the process seam this
        // function exists to make testable without spawning `claude`.
        let flags = claude_print_flags(&[]);
        assert_eq!(
            flags,
            vec![
                "--setting-sources",
                "project,local",
                "--tools",
                "",
                "--allowedTools",
                "",
            ]
        );
    }

    #[test]
    fn claude_print_flags_pass_through_an_explicit_tool_list() {
        // A caller that DOES need tools (the catalogue scan) still gets the
        // same setting-sources insulation, and its tool list travels as-is.
        let flags = claude_print_flags(&["Read", "Glob", "Grep"]);
        assert_eq!(
            flags,
            vec![
                "--setting-sources",
                "project,local",
                "--tools",
                "Read,Glob,Grep",
                "--allowedTools",
                "Read,Glob,Grep",
            ]
        );
    }

    #[test]
    fn artifact_run_preamble_forbids_files_and_leaked_personal_instructions() {
        // Pinned so the hardening survives a refactor: the exact behaviours
        // issue #97 needs the model told about.
        assert!(ARTIFACT_RUN_PREAMBLE.contains("Reply with ONLY"));
        assert!(ARTIFACT_RUN_PREAMBLE
            .to_lowercase()
            .contains("do not create, write, or edit any files"));
        assert!(ARTIFACT_RUN_PREAMBLE.contains("Ignore any personal reply-formatting instruction"));
    }

    #[test]
    fn looks_like_artifact_accepts_a_real_shaped_report() {
        // A harvest-shaped multi-section report, first line matching the
        // consumer's declared heading.
        let body = "## Recurring themes\n- CI queue is slow\n\n## Recommendations\n### Maestro improvements\n- Nothing evidenced this harvest.\n";
        assert!(looks_like_artifact(body, Some("## Recurring themes")));

        // A standup/plan-shaped report: no fixed heading, just multiple
        // lines of prose/bullets.
        let standup = "- shipped the login fix\n- picking up the harvest validator next\nOverall the project is on track.";
        assert!(looks_like_artifact(standup, None));
    }

    #[test]
    fn looks_like_artifact_accepts_a_quiet_day_one_liner_without_heading() {
        // Review F5: a heading-less consumer (standup/daily plan) can
        // legitimately answer in ONE line on a quiet day — a single line is
        // only rejected when it reads as a chat opener.
        for quiet in [
            "No agent activity yesterday — nothing to report.",
            "- nothing shipped yesterday; queue was empty",
            "Nothing planned for today: the backlog is clear.",
        ] {
            assert!(looks_like_artifact(quiet, None), "{quiet}");
        }
        // A mandated heading still implies the multi-section template — a
        // single line is never that shape.
        assert!(!looks_like_artifact(
            "## Recurring themes",
            Some("## Recurring themes")
        ));
    }

    #[test]
    fn looks_like_artifact_still_rejects_single_line_chat_openers() {
        // The issue-#97 canary shape must keep failing the None-heading
        // branch even as a single line.
        for chatty in [
            "Nacho, nothing happened yesterday so there is no standup today.",
            "I've written the standup below.",
            "I have nothing to report for yesterday.",
            "Sure! Here is the plan for today.",
            "Here's the standup you asked for.",
            "Hi! The plan for today is to rest.",
        ] {
            assert!(!looks_like_artifact(chatty, None), "{chatty}");
        }
    }

    #[test]
    fn looks_like_artifact_rejects_a_conversational_reply() {
        // The exact failure mode from issue #97: a personal-CLAUDE.md canary
        // turned the reply into a one-line chat message instead of a report.
        let leaked = "Nacho, I've written the harvest report and saved it to harvest/2026-08-12.md for you. Let me know if you'd like anything else!";
        assert!(!looks_like_artifact(leaked, Some("## Recurring themes")));
        assert!(!looks_like_artifact(leaked, None));

        // Multi-line but missing the consumer's mandated heading — still not
        // the declared shape.
        let wrong_heading = "# Harvest Report\n- some bullet\n- another bullet";
        assert!(!looks_like_artifact(
            wrong_heading,
            Some("## Recurring themes")
        ));
    }

    #[test]
    fn looks_like_artifact_rejects_empty_and_blank_bodies() {
        assert!(!looks_like_artifact("", None));
        assert!(!looks_like_artifact(
            "   \n  \n",
            Some("## Recurring themes")
        ));
    }

    #[test]
    fn strip_ansi_removes_csi_and_osc_sequences() {
        assert_eq!(strip_ansi("plain text"), "plain text");
        assert_eq!(strip_ansi("\u{1b}[31mred\u{1b}[0m"), "red");
        assert_eq!(strip_ansi("a\u{1b}]0;title\u{07}b"), "ab");
        assert_eq!(strip_ansi("a\u{1b}]0;title\u{1b}\\b"), "ab");
        // Trailing lone escape must not panic or loop.
        assert_eq!(strip_ansi("end\u{1b}"), "end");
    }

    #[test]
    fn truncate_chars_marks_dropped_content() {
        assert_eq!(truncate_chars("short", 10), "short");
        let long = "x".repeat(20);
        let cut = truncate_chars(&long, 10);
        assert!(cut.starts_with("xxxxxxxxxx"));
        assert!(cut.ends_with("[... truncated ...]"));
    }

    #[tokio::test]
    async fn latest_artifact_date_picks_newest_before_today() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "2026-07-25.md",
            "2026-07-28.md",
            "2026-07-30.md",
            "junk.txt",
        ] {
            std::fs::write(dir.path().join(name), "x").unwrap();
        }
        let best = latest_artifact_date(dir.path(), Some("2026-07-30")).await;
        assert_eq!(best.as_deref(), Some("2026-07-28"));
    }

    #[tokio::test]
    async fn latest_artifact_date_unbounded_picks_newest_overall() {
        // Retention: with no upper bound the newest saved artifact wins — this
        // is what keeps yesterday's report/plan readable until today's exists.
        let dir = tempfile::tempdir().unwrap();
        for name in ["2026-07-28.md", "2026-07-30.md", "junk.txt"] {
            std::fs::write(dir.path().join(name), "x").unwrap();
        }
        let best = latest_artifact_date(dir.path(), None).await;
        assert_eq!(best.as_deref(), Some("2026-07-30"));
    }

    #[tokio::test]
    async fn latest_artifact_date_none_for_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert_eq!(
            latest_artifact_date(&missing, Some("2026-07-30")).await,
            None
        );
        assert_eq!(latest_artifact_date(&missing, None).await, None);
    }

    #[tokio::test]
    async fn load_artifact_reads_saved_markdown_and_reports_missing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("2026-08-04.md"), "# plan").unwrap();
        let found = load_artifact(dir.path(), "2026-08-04", "plan")
            .await
            .unwrap();
        assert_eq!(found.map(|(md, _)| md), Some("# plan".to_string()));
        assert!(load_artifact(dir.path(), "2026-08-03", "plan")
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn errors_name_the_artifact_kind() {
        // The same machinery serves the standup report and the daily plan, so
        // the noun travels with the call instead of being hardcoded.
        assert_eq!(
            validate_date("nope", "report").unwrap_err(),
            "Invalid report date: nope"
        );
        assert_eq!(
            validate_date("nope", "plan").unwrap_err(),
            "Invalid plan date: nope"
        );
    }

    #[test]
    fn validate_date_rejects_non_iso_input() {
        // The date becomes a filename, so anything that could escape the
        // artifact directory or trail extra text has to be rejected.
        assert!(validate_date("2026-08-04", "report").is_ok());
        assert!(validate_date("../../etc/passwd", "report").is_err());
        assert!(validate_date("2026-08-04/../../secret", "report").is_err());
        assert!(validate_date("2026-08-04.md", "report").is_err());
        assert!(validate_date("", "report").is_err());
        // Unpadded components still parse to a real date (chrono accepts
        // them) — harmless as a filename, and pinned here so the looser rule
        // is a documented choice rather than an accident.
        assert!(validate_date("2026-8-4", "report").is_ok());
    }

    #[test]
    fn interpolate_replaces_each_template_token_once() {
        let out = interpolate("a {x} b {y} c", &[("{x}", "1"), ("{y}", "2")]);
        assert_eq!(out, "a 1 b 2 c");
    }

    #[test]
    fn interpolate_does_not_rescan_substituted_material() {
        // Placeholder-looking text inside the material must pass through
        // verbatim — only tokens in the template itself are interpolated.
        let out = interpolate("{a}|{b}", &[("{a}", "says {b}"), ("{b}", "B")]);
        assert_eq!(out, "says {b}|B");
    }

    #[test]
    fn project_artifact_dir_is_stable_and_kind_scoped() {
        let a = project_artifact_dir("standups", "/home/me/git/Maestro");
        let b = project_artifact_dir("standups", "/home/me/git/Maestro");
        let plan = project_artifact_dir("plans", "/home/me/git/Maestro");
        assert_eq!(a, b);
        assert_ne!(a, plan);
        // Directory name is the lowercased, sanitized project name + hash.
        let leaf = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(leaf.starts_with("maestro-"), "unexpected leaf: {leaf}");
        assert!(a.parent().unwrap().ends_with("standups"));
    }

    #[test]
    fn or_none_marks_empty_sections() {
        assert_eq!(or_none("   \n "), "(none)");
        assert_eq!(or_none("real"), "real");
    }
}
