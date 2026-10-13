//! AI-written names and two-sentence summaries for the sidebar History tab.
//!
//! A past conversation's opening prompt rarely says what it turned into, so
//! each row is labelled by a short headless `claude -p` run (Haiku, no tools)
//! over a condensed copy of the transcript. Results are cached in app data,
//! keyed by session id and invalidated when the conversation grows, so a
//! summary costs one model call per conversation per change — not one per
//! sidebar render.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, Semaphore};

use crate::commands::ai_runner::artifact_base_dir;
use crate::commands::claude_sessions::{
    claude_projects_root, extract_prompt_text, is_safe_session_id, is_system_message, message_text,
};
use crate::core::atomic_write::atomic_write_async;

/// Characters kept from any one message — enough for its gist.
const MAX_MESSAGE_CHARS: usize = 400;
/// Condensed-transcript budget for the opening of the conversation.
const HEAD_BUDGET_CHARS: usize = 3_000;
/// Condensed-transcript budget for the end — where it ended up matters most.
const TAIL_BUDGET_CHARS: usize = 9_000;
/// Simultaneous `claude -p` runs. Expanding a project asks for every visible
/// row at once; this keeps that to a few processes instead of dozens.
const MAX_CONCURRENT_RUNS: usize = 3;
/// A Haiku summary takes ~5 s; anything past this is a hung CLI.
const RUN_TIMEOUT: Duration = Duration::from_secs(120);

/// Tells the model to label the conversation, not continue it. A full
/// `--system-prompt` (not an appended one) also keeps the user's own
/// CLAUDE.md style rules out of the reply (issue #97).
const SYSTEM_PROMPT: &str = "You label past coding-agent conversations so a developer can \
recognise them in a list. You are given a condensed transcript (User/Agent lines). Do not \
continue or answer the conversation. Reply with exactly two lines and nothing else:\n\
NAME: <a 2-6 word name for the session>\n\
SUMMARY: <exactly two plain sentences: what the user wanted, then what the agent did or \
where it ended up>\n\
No markdown, no emoji, no preamble.";

static RUN_SLOTS: Semaphore = Semaphore::const_new(MAX_CONCURRENT_RUNS);
/// Serialises the cache file's read-modify-write across concurrent commands.
static CACHE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// What the History row shows for one conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionSummary {
    pub name: String,
    pub summary: String,
}

/// One cached summary plus the transcript state it was written from.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    name: String,
    summary: String,
    message_count: usize,
    last_active: String,
}

fn cache_path() -> PathBuf {
    artifact_base_dir("history").join("session_summaries.json")
}

fn load_cache(path: &Path) -> HashMap<String, CacheEntry> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Returns the conversation's name and two-sentence summary, from the cache
/// when the transcript has not changed since, otherwise from a fresh
/// headless Haiku run.
#[tauri::command]
pub async fn summarize_claude_session(
    session_id: String,
    last_active: String,
    message_count: usize,
) -> Result<SessionSummary, String> {
    if !is_safe_session_id(&session_id) {
        return Err(format!("Invalid session id: {session_id}"));
    }
    let path = cache_path();

    {
        let _guard = CACHE_LOCK.lock().await;
        if let Some(hit) = load_cache(&path).get(&session_id) {
            if hit.message_count == message_count && hit.last_active == last_active {
                return Ok(SessionSummary {
                    name: hit.name.clone(),
                    summary: hit.summary.clone(),
                });
            }
        }
    }

    let id = session_id.clone();
    let transcript = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let root = claude_projects_root()
            .ok_or_else(|| "Could not determine home directory".to_string())?;
        let file = find_transcript(&root, &id)
            .ok_or_else(|| "its transcript file was not found".to_string())?;
        condense_transcript(&file)
    })
    .await
    .map_err(|e| format!("Transcript read task failed: {e}"))??;
    if transcript.trim().is_empty() {
        return Err("the transcript holds no messages to summarise".to_string());
    }

    let reply = {
        let _slot = RUN_SLOTS
            .acquire()
            .await
            .map_err(|e| format!("Summary queue closed: {e}"))?;
        run_claude(&transcript).await?
    };
    let result = parse_reply(&reply)
        .ok_or_else(|| format!("the model reply was not a name + summary: {reply}"))?;

    let _guard = CACHE_LOCK.lock().await;
    let mut cache = load_cache(&path);
    cache.insert(
        session_id,
        CacheEntry {
            name: result.name.clone(),
            summary: result.summary.clone(),
            message_count,
            last_active,
        },
    );
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot create {dir:?}: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(&cache).map_err(|e| e.to_string())?;
    // A failed cache write only costs a re-run later — still return the summary.
    if let Err(e) = atomic_write_async(path.clone(), path.with_extension("json.tmp"), json).await {
        log::warn!("Could not save session summary cache: {e}");
    }
    Ok(result)
}

/// The newest `<session_id>.jsonl` under any project directory of `root`.
/// A conversation resumed elsewhere can leave a copy in more than one.
fn find_transcript(root: &Path, session_id: &str) -> Option<PathBuf> {
    let file_name = format!("{session_id}.jsonl");
    fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|dir| dir.path().join(&file_name))
        .filter_map(|p| Some((fs::metadata(&p).ok()?.modified().ok()?, p)))
        .max_by_key(|(mtime, _)| *mtime)
        .map(|(_, p)| p)
}

/// One-line, char-safe cut of a message.
fn clip(text: &str, max_chars: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max_chars {
        return flat;
    }
    let cut: String = flat.chars().take(max_chars).collect();
    format!("{cut}…")
}

/// The conversation as `User:` / `Agent:` lines — real prompts and the
/// agent's prose only (tool traffic and system wrappers dropped). Long runs
/// keep their opening and their end, with the middle elided and counted.
fn condense_transcript(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("Cannot open {path:?}: {e}"))?;
    let mut lines: Vec<String> = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        // Cheap pre-filter: skip tool results, attachments and metadata lines
        // without parsing them.
        if !line.contains(r#""type":"user""#) && !line.contains(r#""type":"assistant""#) {
            continue;
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let speaker = match val.get("type").and_then(|v| v.as_str()) {
            Some("user") => "User",
            Some("assistant") => "Agent",
            _ => continue,
        };
        let Some(content) = message_text(&val) else {
            continue;
        };
        if is_system_message(&content) {
            continue;
        }
        let text = extract_prompt_text(&content);
        if text.is_empty() {
            continue;
        }
        lines.push(format!("{speaker}: {}", clip(&text, MAX_MESSAGE_CHARS)));
    }
    Ok(fit_budget(&lines))
}

/// Joins `lines`, keeping as many opening lines as fit the head budget and
/// as many closing lines as fit the tail budget.
fn fit_budget(lines: &[String]) -> String {
    let total: usize = lines.iter().map(|l| l.chars().count() + 1).sum();
    if total <= HEAD_BUDGET_CHARS + TAIL_BUDGET_CHARS {
        return lines.join("\n");
    }
    let mut head_end = 0;
    let mut used = 0;
    while head_end < lines.len() {
        let next = lines[head_end].chars().count() + 1;
        if used + next > HEAD_BUDGET_CHARS {
            break;
        }
        used += next;
        head_end += 1;
    }
    let mut tail_start = lines.len();
    used = 0;
    while tail_start > head_end {
        let next = lines[tail_start - 1].chars().count() + 1;
        if used + next > TAIL_BUDGET_CHARS {
            break;
        }
        used += next;
        tail_start -= 1;
    }
    let omitted = tail_start - head_end;
    let mut out = lines[..head_end].join("\n");
    out.push_str(&format!("\n[... {omitted} messages omitted ...]\n"));
    out.push_str(&lines[tail_start..].join("\n"));
    out
}

/// Runs `claude -p` on Haiku with no tools, no saved session (so the run never
/// appears in History itself) and the temp dir as cwd (so no project
/// CLAUDE.md is picked up). The transcript goes in on stdin.
async fn run_claude(transcript: &str) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("claude");
    cmd.args([
        "-p",
        "--model",
        "haiku",
        "--tools",
        "",
        "--no-session-persistence",
        "--system-prompt",
        SYSTEM_PROMPT,
        "Label the conversation transcript given on stdin.",
    ])
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
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(transcript.as_bytes())
            .await
            .map_err(|e| format!("could not send the transcript to claude ({e})"))?;
    }
    let output = tokio::time::timeout(RUN_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("claude did not answer within {}s", RUN_TIMEOUT.as_secs()))?
        .map_err(|e| format!("claude run failed ({e})"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        return Err(format!(
            "claude exited with {}: {}",
            output.status,
            clip(detail.trim(), 300)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Reads the `NAME:` / `SUMMARY:` reply. A reply without the `SUMMARY:` line
/// is rejected rather than shown as if it were a summary.
fn parse_reply(reply: &str) -> Option<SessionSummary> {
    let mut name: Option<String> = None;
    let mut summary: Option<String> = None;
    for line in reply.lines() {
        let line = line.trim().trim_start_matches(['*', '#', ' ']);
        if let Some(rest) = strip_label(line, "NAME:") {
            name = Some(rest.trim_matches(['*', '"', ' ']).to_string());
        } else if let Some(rest) = strip_label(line, "SUMMARY:") {
            summary = Some(rest.trim_matches(['*', ' ']).to_string());
        } else if let Some(s) = summary.as_mut() {
            // A summary the model wrapped onto a second line.
            if !line.is_empty() {
                s.push(' ');
                s.push_str(line);
            }
        }
    }
    let summary = summary.filter(|s| !s.is_empty())?;
    Some(SessionSummary {
        name: name.filter(|n| !n.is_empty()).unwrap_or_default(),
        summary,
    })
}

/// `line` without its case-insensitive `label` prefix.
fn strip_label<'a>(line: &'a str, label: &str) -> Option<&'a str> {
    let head = line.get(..label.len())?;
    head.eq_ignore_ascii_case(label)
        .then(|| line[label.len()..].trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reply_reads_name_and_summary() {
        let out = parse_reply(
            "NAME: Login crash fix\nSUMMARY: The user asked to fix a crash. The agent fixed it.\n",
        )
        .unwrap();
        assert_eq!(out.name, "Login crash fix");
        assert_eq!(
            out.summary,
            "The user asked to fix a crash. The agent fixed it."
        );
    }

    #[test]
    fn parse_reply_tolerates_markdown_and_wrapped_summaries() {
        let out = parse_reply("**Name:** Docs cleanup\n**Summary:** First.\nSecond.").unwrap();
        assert_eq!(out.name, "Docs cleanup");
        assert_eq!(out.summary, "First. Second.");
    }

    #[test]
    fn parse_reply_rejects_a_reply_without_a_summary() {
        assert_eq!(parse_reply("I cannot help with that."), None);
        assert_eq!(parse_reply("NAME: x\nSUMMARY:   "), None);
    }

    #[test]
    fn condense_keeps_prompts_and_prose_and_drops_tool_and_system_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = [
            r#"{"type":"user","message":{"content":"<local-command-caveat>x</local-command-caveat>"}}"#,
            r#"{"type":"user","message":{"content":"Fix the   login\ncrash"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"file"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Fixed it."}]}}"#,
            r#"{"type":"ai-title","aiTitle":"Login"}"#,
        ]
        .join("\n");
        fs::write(&path, jsonl).unwrap();
        assert_eq!(
            condense_transcript(&path).unwrap(),
            "User: Fix the login crash\nAgent: Fixed it."
        );
    }

    #[test]
    fn fit_budget_keeps_the_opening_and_the_end_and_counts_the_gap() {
        let lines: Vec<String> = (0..200)
            .map(|i| format!("User: {i:03} {}", "x".repeat(90)))
            .collect();
        let out = fit_budget(&lines);
        assert!(out.starts_with("User: 000"));
        assert!(out.ends_with(&lines[199]));
        assert!(out.contains("messages omitted"));
        assert!(out.chars().count() <= HEAD_BUDGET_CHARS + TAIL_BUDGET_CHARS + 50);
    }

    #[test]
    fn fit_budget_leaves_short_conversations_whole() {
        let lines = vec!["User: a".to_string(), "Agent: b".to_string()];
        assert_eq!(fit_budget(&lines), "User: a\nAgent: b");
    }

    #[test]
    fn find_transcript_picks_the_file_named_after_the_session() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("C--repo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("abc-123.jsonl"), "{}").unwrap();
        fs::write(dir.join("other.jsonl"), "{}").unwrap();
        assert_eq!(
            find_transcript(root.path(), "abc-123"),
            Some(dir.join("abc-123.jsonl"))
        );
        assert_eq!(find_transcript(root.path(), "missing"), None);
    }
}
