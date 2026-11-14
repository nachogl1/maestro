//! The Work Journal's spelling fixer (issue #569): the page sends the texts
//! of the selection, or of the whole day page, and a headless `claude -p`
//! (the same CLI call the suggestions and the report use) fixes their
//! spelling, grammar and punctuation, each in its own language.
//!
//! Contract: the texts go in on stdin as one JSON array of strings, and the
//! reply must be one JSON array of strings of the same length and order
//! ([`parse_reply`]). Anything else is [`SpellingError::UnusableReply`], so
//! the page is never changed by a reply it cannot trust. The page itself
//! decides which parts of a fix it applies (it never touches times, links,
//! code or a card's bold split).
//!
//! [`fix_spelling_with`] takes the Claude call as a closure, so tests never
//! start the real `claude` CLI.

use std::future::Future;
use std::time::Duration;

use serde_json::Value;

use crate::core::work_journal_run::{is_safe_model, run_process};

/// One fix call; a day page is short, anything past this is a hung CLI.
pub const SPELLING_TIMEOUT: Duration = Duration::from_secs(120);

/// The most text one fix sends, in characters (all texts together): more
/// risks the timeout or the model's context.
pub const MAX_SPELLING_INPUT_CHARS: usize = 60_000;

/// The positional prompt; the texts go in on stdin.
const USER_PROMPT: &str = "Fix the texts in the JSON array given on stdin.";

/// A full `--system-prompt` (not an appended one); with `--safe-mode` the
/// user's own CLAUDE.md never reaches the run.
pub const SYSTEM_PROMPT: &str = "You fix the spelling, grammar and punctuation of short \
notes from a developer's Work Journal. You are given a JSON array of strings; each string is \
one piece of text from a page.\n\
Rules, follow them exactly:\n\
- Fix each string on its own, in that string's own language. Never translate.\n\
- Fix only spelling, grammar and punctuation. Never change the wording, the order of \
sentences or the meaning. Never add or remove information.\n\
- Never change times (like 10:30), dates, numbers, project names, names of people, links, \
web addresses, file names, commands or code.\n\
- Keep the quick-note style: a short fragment stays a short fragment; do not make it a full \
sentence and do not add a final full stop to a fragment that has none.\n\
- Keep the leading and trailing spaces and the capitalisation style of each string unless \
it is a mistake.\n\
- A string with nothing to fix comes back exactly as it was.\n\
Output contract, follow it exactly: reply with one JSON array of strings only, with exactly \
as many strings as the input, in the same order, string N being the fixed string N. No \
preamble, no explanation, no markdown, no code fence.";

/// Words in a failed run's message that mean the CLI could not reach the
/// network (lower case).
const NETWORK_SIGNS: &[&str] = &[
    "connection error",
    "unable to connect",
    "network",
    "enotfound",
    "econnrefused",
    "econnreset",
    "etimedout",
    "eai_again",
    "getaddrinfo",
    "fetch failed",
    "offline",
];

/// Why a fix failed; each message is a plain sentence the page shows.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SpellingError {
    #[error("Claude Code is not installed or could not be started.")]
    NoCli,
    #[error("Claude could not reach the network. Check your connection and try again.")]
    NoNetwork,
    #[error(
        "Your Claude Code is too old for the spelling fixer (it does not know --safe-mode). \
         Update Claude Code and try again."
    )]
    CliTooOld,
    /// A bad model setting; the message comes from [`claude_args`].
    #[error("{0}")]
    Model(String),
    #[error("There is too much text to fix at once; select a part of the page.")]
    InputTooLarge,
    #[error("Claude could not fix the text: {0}")]
    Claude(String),
    #[error("Claude's reply could not be read. Try again.")]
    UnusableReply,
}

/// The `claude` arguments for a fix: print mode, `--safe-mode`, no built-in
/// tools, no MCP servers, no saved session, the fixer's own system prompt,
/// and `--model` only when the shared Work Journal model setting names one
/// (blank = the user's default model). The texts go in on stdin.
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
                "The Work Journal model setting \"{model}\" is not a valid model name."
            ));
        }
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    args.push(USER_PROMPT.to_string());
    Ok(args)
}

/// Reads Claude's reply: one JSON array of exactly `expected` strings,
/// alone or inside one code fence. Anything else (other text around it, not
/// JSON, not an array, a wrong length, an element that is not a string, a
/// null) is [`SpellingError::UnusableReply`].
pub fn parse_reply(reply: &str, expected: usize) -> Result<Vec<String>, SpellingError> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(unfenced(reply)) else {
        return Err(SpellingError::UnusableReply);
    };
    if items.len() != expected {
        return Err(SpellingError::UnusableReply);
    }
    items
        .into_iter()
        .map(|item| match item {
            Value::String(text) => Ok(text),
            _ => Err(SpellingError::UnusableReply),
        })
        .collect()
}

/// `reply` without the code fence (```` ``` ```` or ```` ```json ````) a
/// model may put around it, trimmed.
fn unfenced(reply: &str) -> &str {
    let reply = reply.trim();
    let Some(inner) = reply
        .strip_prefix("```")
        .and_then(|r| r.strip_suffix("```"))
    else {
        return reply;
    };
    let inner = inner.trim_start();
    inner.strip_prefix("json").unwrap_or(inner).trim()
}

/// Maps a failed `claude` call to the reason the page shows: the CLI could
/// not be started, it is too old for `--safe-mode`, it could not reach the
/// network, or any other Claude error.
pub fn claude_error(message: String) -> SpellingError {
    let lower = message.to_lowercase();
    if lower.starts_with("could not start the claude cli") {
        SpellingError::NoCli
    } else if lower.contains("unknown option") {
        SpellingError::CliTooOld
    } else if NETWORK_SIGNS.iter().any(|sign| lower.contains(sign)) {
        SpellingError::NoNetwork
    } else {
        SpellingError::Claude(message)
    }
}

/// Fixes `texts` through `ask` (the `claude` arguments and the stdin input)
/// and returns the fixed texts in the same order. No texts: nothing is
/// asked. Refuses an input over [`MAX_SPELLING_INPUT_CHARS`] before asking.
pub async fn fix_spelling_with<F, Fut>(
    texts: &[String],
    model: Option<&str>,
    ask: F,
) -> Result<Vec<String>, SpellingError>
where
    F: FnOnce(Vec<String>, String) -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    if texts.iter().map(|text| text.chars().count()).sum::<usize>() > MAX_SPELLING_INPUT_CHARS {
        return Err(SpellingError::InputTooLarge);
    }
    let args = claude_args(model).map_err(SpellingError::Model)?;
    let input = serde_json::to_string(texts).map_err(|_| SpellingError::UnusableReply)?;
    let reply = ask(args, input).await.map_err(claude_error)?;
    parse_reply(&reply, texts.len())
}

/// [`fix_spelling_with`] with the real headless `claude` (from the temp
/// dir, hidden console, input on stdin, [`SPELLING_TIMEOUT`]).
pub async fn fix_spelling(
    texts: &[String],
    model: Option<&str>,
) -> Result<Vec<String>, SpellingError> {
    fix_spelling_with(texts, model, |args, input| async move {
        run_process("claude", &args, &input, SPELLING_TIMEOUT, true).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn texts(items: &[&str]) -> Vec<String> {
        items.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn test_a_reply_with_one_string_per_text_is_read_in_order() {
        let replies = [
            r#"["I fixed the bug.", "Réunion avec l'équipe"]"#,
            "```json\n[\"I fixed the bug.\", \"Réunion avec l'équipe\"]\n```",
            "\n```\n[\"I fixed the bug.\", \"Réunion avec l'équipe\"]\n```\n",
        ];
        for reply in replies {
            assert_eq!(
                parse_reply(reply, 2),
                Ok(texts(&["I fixed the bug.", "Réunion avec l'équipe"])),
                "{reply}"
            );
        }
        // Two equal texts are two answers, not one.
        assert_eq!(
            parse_reply(r#"["Same", "Same"]"#, 2),
            Ok(texts(&["Same", "Same"]))
        );
    }

    #[test]
    fn test_a_malformed_reply_is_unusable() {
        let replies = [
            "",
            "Sorry, I cannot help with that.",
            "Here you go: [\"a\", \"b\"]",
            "null",
            r#"{"texts": ["a", "b"]}"#,
            r#"["only one"]"#,
            r#"["a", "b", "c"]"#,
            r#"["a", null]"#,
            r#"[null, null]"#,
            r#"["a", 2]"#,
            r#"["a", ["b"]]"#,
            r#"["a", {"text": "b"}]"#,
            r#"["a", "b""#,
            "] [",
            "```",
        ];
        for reply in replies {
            assert_eq!(
                parse_reply(reply, 2),
                Err(SpellingError::UnusableReply),
                "{reply}"
            );
        }
    }

    #[test]
    fn test_each_failed_run_names_its_reason() {
        let cases = [
            (
                "could not start the claude CLI (program not found)",
                SpellingError::NoCli,
            ),
            (
                "claude exited with exit code: 1: unknown option",
                SpellingError::CliTooOld,
            ),
            (
                "claude exited with exit code: 1: API Error: Connection error.",
                SpellingError::NoNetwork,
            ),
            (
                "claude exited with exit code: 1: getaddrinfo ENOTFOUND api.anthropic.com",
                SpellingError::NoNetwork,
            ),
            (
                "claude exited with exit code: 1: Invalid API key",
                SpellingError::Claude(
                    "claude exited with exit code: 1: Invalid API key".to_string(),
                ),
            ),
        ];
        for (message, expected) in cases {
            assert_eq!(claude_error(message.to_string()), expected, "{message}");
        }
        assert_eq!(
            SpellingError::NoCli.to_string(),
            "Claude Code is not installed or could not be started."
        );
    }

    #[test]
    fn test_the_args_keep_the_users_setup_out_and_pass_only_a_safe_model() {
        let args = claude_args(None).unwrap();
        for flag in [
            "-p",
            "--safe-mode",
            "--no-session-persistence",
            "--strict-mcp-config",
        ] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        assert!(!args.iter().any(|a| a == "--model"));
        assert!(!args.iter().any(|a| a == "--bare"));
        assert_eq!(args.last().map(String::as_str), Some(USER_PROMPT));

        let args = claude_args(Some(" sonnet ")).unwrap();
        let at = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[at + 1], "sonnet");
        assert!(claude_args(Some("  "))
            .unwrap()
            .iter()
            .all(|a| a != "--model"));
        assert!(claude_args(Some("--dangerous")).is_err());
    }

    #[tokio::test]
    async fn test_the_texts_go_in_as_one_json_array_and_the_fixes_come_back() {
        let seen: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let record = Arc::clone(&seen);
        let fixed = fix_spelling_with(
            &texts(&["I fixd the bug", "say \"hi\""]),
            None,
            |_args, input| async move {
                *record.lock().unwrap() = Some(input);
                Ok(r#"["I fixed the bug", "say \"hi\""]"#.to_string())
            },
        )
        .await;
        assert_eq!(fixed, Ok(texts(&["I fixed the bug", "say \"hi\""])));
        assert_eq!(
            seen.lock().unwrap().as_deref(),
            Some(r#"["I fixd the bug","say \"hi\""]"#)
        );
    }

    #[tokio::test]
    async fn test_nothing_is_asked_for_no_texts_or_too_much_text() {
        // Being asked shows as this error, which none of the asserts expect.
        let never = |_args: Vec<String>, _input: String| async move {
            Err::<String, String>("claude was asked".to_string())
        };
        assert_eq!(fix_spelling_with(&[], None, never).await, Ok(Vec::new()));
        let huge = vec!["x".repeat(MAX_SPELLING_INPUT_CHARS + 1)];
        assert_eq!(
            fix_spelling_with(&huge, None, never).await,
            Err(SpellingError::InputTooLarge)
        );
        assert!(matches!(
            fix_spelling_with(&texts(&["a"]), Some("-x"), never).await,
            Err(SpellingError::Model(_))
        ));
    }

    #[tokio::test]
    async fn test_a_failed_run_or_a_bad_reply_is_an_error() {
        let failed = fix_spelling_with(&texts(&["a"]), None, |_a, _i| async move {
            Err("could not start the claude CLI (program not found)".to_string())
        })
        .await;
        assert_eq!(failed, Err(SpellingError::NoCli));
        let bad = fix_spelling_with(&texts(&["a", "b"]), None, |_a, _i| async move {
            Ok(r#"["a"]"#.to_string())
        })
        .await;
        assert_eq!(bad, Err(SpellingError::UnusableReply));
    }
}
