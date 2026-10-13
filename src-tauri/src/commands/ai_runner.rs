//! Shared helpers for Maestro's app-data artifact stores (harvest, samurai):
//! the per-kind artifact directory, project-path canonicalisation, today's
//! date, and text cleanup/interpolation for prompts and saved output.
//!
//! Artifacts live under `<app data>/<kind>/`.

use std::path::PathBuf;

use chrono::Local;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
