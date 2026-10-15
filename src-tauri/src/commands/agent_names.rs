//! Live Claude Code agent names.
//!
//! Every running `claude` registers itself in `~/.claude/sessions/<pid>.json`
//! with the name other sessions message it by (`"name"`), next to the
//! conversation id it is on (`"sessionId"`). Maestro reads that registry so a
//! terminal's title can follow the agent's real name — including names Claude
//! picked itself (derived, or changed after a collision) and `/rename`s typed
//! straight into the terminal.
//!
//! Each registry entry also carries the claude process id. Walking that
//! process's ancestors up to a shell Maestro spawned tells which terminal the
//! agent runs in WITHOUT the SessionStart hook: a claude typed by hand, or one
//! whose hooks config never got written, still reports its name to its own
//! terminal.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use directories::BaseDirs;
use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::State;

use crate::core::process_manager::ProcessManager;
use crate::core::samurai_pty;

/// Registry files are a few hundred bytes; anything larger is not one.
const MAX_REGISTRY_FILE_BYTES: u64 = 64 * 1024;

/// Longest agent name Maestro will set (mirrors `src/lib/agentName.ts`).
const MAX_AGENT_NAME_CHARS: usize = 64;

/// Upper bound when walking a claude process's parent chain to the shell
/// Maestro spawned; also breaks PID-reuse cycles.
const MAX_ANCESTOR_HOPS: usize = 32;

/// One live agent: the conversation it is on and the name it answers to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LiveAgentName {
    /// Claude conversation id (`sessionId` in the registry file).
    pub session_id: String,
    pub name: String,
    /// The Maestro terminal this claude runs in, found by walking its process
    /// ancestors to a shell Maestro spawned. `None` when the registry entry
    /// has no pid or no tracked shell is among its ancestors (a claude
    /// started outside Maestro).
    pub maestro_session: Option<u32>,
}

/// One registry file, before its process is matched to a terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RegistryEntry {
    session_id: String,
    name: String,
    /// The claude process id (`pid` in the registry file), if present.
    pid: Option<u32>,
}

/// `~/.claude/sessions` — Claude Code's live session registry.
fn claude_sessions_registry() -> Option<PathBuf> {
    let base_dirs = BaseDirs::new()?;
    Some(base_dirs.home_dir().join(".claude").join("sessions"))
}

/// Reads every `*.json` registry entry in `dir` that carries both a
/// conversation id and a name. Unreadable or malformed files are skipped:
/// the registry is written concurrently by every running CLI.
fn read_registry(dir: &Path) -> Vec<RegistryEntry> {
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
        let pid = val
            .get("pid")
            .and_then(|v| v.as_u64())
            .and_then(|p| u32::try_from(p).ok());
        if let (Some(session_id), Some(name)) = (session_id, name) {
            if !session_id.is_empty() && !name.is_empty() {
                names.push(RegistryEntry {
                    session_id: session_id.to_string(),
                    name: name.to_string(),
                    pid,
                });
            }
        }
    }
    names
}

/// Parent pid of every process on the machine, from one sysinfo snapshot.
fn parent_map() -> HashMap<u32, u32> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new());
    sys.processes()
        .iter()
        .filter_map(|(pid, p)| p.parent().map(|pp| (pid.as_u32(), pp.as_u32())))
        .collect()
}

/// The Maestro terminal whose shell is `pid` or one of its ancestors.
/// `shell_sessions` maps each tracked shell pid to its session id. Stops at
/// the hop cap, a self-parented root, or a pid already visited (PID reuse
/// can make the parent chain loop).
fn owning_session(
    pid: u32,
    parent_of: &HashMap<u32, u32>,
    shell_sessions: &HashMap<u32, u32>,
) -> Option<u32> {
    let mut cur = pid;
    let mut seen = HashSet::new();
    for _ in 0..MAX_ANCESTOR_HOPS {
        if let Some(session) = shell_sessions.get(&cur) {
            return Some(*session);
        }
        if !seen.insert(cur) {
            return None;
        }
        match parent_of.get(&cur) {
            Some(&parent) if parent != cur => cur = parent,
            _ => return None,
        }
    }
    None
}

/// Attaches each registry entry to the Maestro terminal its process runs in.
fn attach_sessions(
    entries: Vec<RegistryEntry>,
    parent_of: &HashMap<u32, u32>,
    shell_sessions: &HashMap<u32, u32>,
) -> Vec<LiveAgentName> {
    entries
        .into_iter()
        .map(|entry| LiveAgentName {
            maestro_session: entry
                .pid
                .and_then(|pid| owning_session(pid, parent_of, shell_sessions)),
            session_id: entry.session_id,
            name: entry.name,
        })
        .collect()
}

/// Lists the names of every live Claude Code agent on this machine, each
/// with the Maestro terminal it runs in when one of Maestro's shells is
/// among its process ancestors.
#[tauri::command]
pub async fn list_live_agent_names(
    processes: State<'_, ProcessManager>,
) -> Result<Vec<LiveAgentName>, String> {
    let shell_sessions: HashMap<u32, u32> = processes
        .session_pids()
        .into_iter()
        .filter_map(|(session, pid)| u32::try_from(pid).ok().map(|pid| (pid, session)))
        .collect();
    tokio::task::spawn_blocking(move || {
        let entries = claude_sessions_registry()
            .map(|dir| read_registry(&dir))
            .unwrap_or_default();
        if entries.is_empty() {
            return Vec::new();
        }
        // Only snapshot the process table when there is something to match;
        // the poll runs every few seconds.
        let parent_of = if entries.iter().any(|e| e.pid.is_some()) && !shell_sessions.is_empty() {
            parent_map()
        } else {
            HashMap::new()
        };
        attach_sessions(entries, &parent_of, &shell_sessions)
    })
    .await
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
            vec![RegistryEntry {
                session_id: "aaa".into(),
                name: "maestro-16".into(),
                pid: Some(1),
            }]
        );
    }

    #[test]
    fn an_entry_without_a_pid_still_reads() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(
            tmp.path().join("1.json"),
            r#"{"sessionId":"aaa","name":"maestro-16"}"#,
        )
        .unwrap();
        let names = read_registry(tmp.path());
        assert_eq!(names.len(), 1);
        assert_eq!(names[0].pid, None);
    }

    #[test]
    fn owning_session_walks_up_to_a_tracked_shell() {
        // claude 40 <- cmd 30 <- maestro 20; the shell of session 3 is 30.
        let parent_of = HashMap::from([(40, 30), (30, 20), (20, 1)]);
        let shells = HashMap::from([(30, 3), (99, 7)]);
        assert_eq!(owning_session(40, &parent_of, &shells), Some(3));
        // A process whose ancestors hold no tracked shell belongs to nobody.
        assert_eq!(owning_session(20, &parent_of, &shells), None);
        // An unknown pid (process already gone) belongs to nobody.
        assert_eq!(owning_session(555, &parent_of, &shells), None);
    }

    #[test]
    fn owning_session_survives_cycles_and_self_parents() {
        let shells = HashMap::from([(30, 3)]);
        let cycle = HashMap::from([(40, 41), (41, 40)]);
        assert_eq!(owning_session(40, &cycle, &shells), None);
        let self_parent = HashMap::from([(7, 7)]);
        assert_eq!(owning_session(7, &self_parent, &shells), None);
    }

    #[test]
    fn attach_sessions_keeps_entries_it_cannot_place() {
        let parent_of = HashMap::from([(40, 30)]);
        let shells = HashMap::from([(30, 3)]);
        let entries = vec![
            RegistryEntry {
                session_id: "aaa".into(),
                name: "maestro-16".into(),
                pid: Some(40),
            },
            RegistryEntry {
                session_id: "bbb".into(),
                name: "outside-9".into(),
                pid: Some(500),
            },
            RegistryEntry {
                session_id: "ccc".into(),
                name: "no-pid".into(),
                pid: None,
            },
        ];
        let live = attach_sessions(entries, &parent_of, &shells);
        assert_eq!(
            live.iter().map(|l| l.maestro_session).collect::<Vec<_>>(),
            vec![Some(3), None, None]
        );
        assert_eq!(live[0].name, "maestro-16");
        assert_eq!(live[0].session_id, "aaa");
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
