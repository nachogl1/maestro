//! Live Claude Code agent names.
//!
//! Every running `claude` registers itself in `~/.claude/sessions/<pid>.json`
//! with the name other sessions message it by (`"name"`), next to the
//! conversation id it is on (`"sessionId"`). Maestro reads that registry so a
//! terminal's title can follow the agent's real name — including names Claude
//! picked itself (derived, or changed after a collision) and `/rename`s typed
//! straight into the terminal.

use std::fs;
use std::path::{Path, PathBuf};

use directories::BaseDirs;
use serde::Serialize;
use tauri::State;

use crate::core::process_manager::ProcessManager;
use crate::core::samurai_pty;

/// Registry files are a few hundred bytes; anything larger is not one.
const MAX_REGISTRY_FILE_BYTES: u64 = 64 * 1024;

/// Longest agent name Maestro will set (mirrors `src/lib/agentName.ts`).
const MAX_AGENT_NAME_CHARS: usize = 64;

/// One live agent: the conversation it is on and the name it answers to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LiveAgentName {
    /// Claude conversation id (`sessionId` in the registry file).
    pub session_id: String,
    pub name: String,
}

/// `~/.claude/sessions` — Claude Code's live session registry.
fn claude_sessions_registry() -> Option<PathBuf> {
    let base_dirs = BaseDirs::new()?;
    Some(base_dirs.home_dir().join(".claude").join("sessions"))
}

/// Reads every `*.json` registry entry in `dir` that carries both a
/// conversation id and a name. Unreadable or malformed files are skipped:
/// the registry is written concurrently by every running CLI.
fn read_registry(dir: &Path) -> Vec<LiveAgentName> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if entry.metadata().map(|m| m.len()).unwrap_or(u64::MAX) > MAX_REGISTRY_FILE_BYTES {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let session_id = val.get("sessionId").and_then(|v| v.as_str());
        let name = val.get("name").and_then(|v| v.as_str()).map(str::trim);
        if let (Some(session_id), Some(name)) = (session_id, name) {
            if !session_id.is_empty() && !name.is_empty() {
                names.push(LiveAgentName {
                    session_id: session_id.to_string(),
                    name: name.to_string(),
                });
            }
        }
    }
    names
}

/// Lists the names of every live Claude Code agent on this machine.
#[tauri::command]
pub async fn list_live_agent_names() -> Result<Vec<LiveAgentName>, String> {
    tokio::task::spawn_blocking(|| claude_sessions_registry().map(|dir| read_registry(&dir)))
        .await
        .map(|names| names.unwrap_or_default())
        .map_err(|e| format!("Agent name lookup failed: {e}"))
}

/// Whether `name` is safe to type into a terminal and to put on a launch
/// command line unquoted: letters, digits, `.`, `_` and `-`, starting with a
/// letter or digit. Same rule as `isValidAgentName` in `src/lib/agentName.ts`.
fn is_valid_agent_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    name.chars().count() <= MAX_AGENT_NAME_CHARS
        && first.is_ascii_alphanumeric()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Renames the Claude agent running in Maestro terminal `session_id` by typing
/// `/rename <name>` into it — the same command a user would type, so Claude
/// applies its own rules (collisions, registry update, transcript entry).
///
/// Uses the two-frame submit every injected instruction uses (body, then a
/// lone Enter after a gap — issue #103). When the agent is busy, Claude
/// queues the command and applies it after the current turn.
#[tauri::command]
pub async fn rename_agent(
    processes: State<'_, ProcessManager>,
    session_id: u32,
    name: String,
) -> Result<(), String> {
    if !is_valid_agent_name(&name) {
        return Err(format!("Invalid agent name: {name}"));
    }
    samurai_pty::submit_instruction(
        processes.inner().clone(),
        session_id,
        format!("/rename {name}"),
        "rename",
        Box::new(move |outcome| {
            if let Err(e) = outcome {
                log::warn!("rename: /rename never reached session {session_id}: {e}");
            }
        }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_named_entries_and_skips_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        fs::write(
            dir.join("1.json"),
            r#"{"pid":1,"sessionId":"aaa","name":"maestro-16","nameSource":"derived"}"#,
        )
        .unwrap();
        fs::write(dir.join("2.json"), r#"{"pid":2,"sessionId":"bbb"}"#).unwrap();
        fs::write(dir.join("3.json"), "{torn").unwrap();
        fs::write(dir.join("4.key"), r#"{"sessionId":"ccc","name":"x"}"#).unwrap();
        fs::write(dir.join("5.json"), r#"{"sessionId":"ddd","name":"  "}"#).unwrap();

        let names = read_registry(dir);
        assert_eq!(
            names,
            vec![LiveAgentName {
                session_id: "aaa".into(),
                name: "maestro-16".into()
            }]
        );
    }

    #[test]
    fn agent_names_are_limited_to_terminal_safe_characters() {
        assert!(is_valid_agent_name("maestro-16"));
        assert!(is_valid_agent_name("Review_2.b"));
        assert!(!is_valid_agent_name(""));
        assert!(!is_valid_agent_name("-leading"));
        assert!(!is_valid_agent_name("two words"));
        assert!(!is_valid_agent_name("x\r/exit"));
        assert!(!is_valid_agent_name("a;rm"));
        assert!(!is_valid_agent_name(&"a".repeat(65)));
    }

    #[test]
    fn a_missing_registry_lists_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_registry(&tmp.path().join("absent")).is_empty());
    }
}
