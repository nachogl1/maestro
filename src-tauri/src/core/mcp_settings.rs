//! Read/write management of Claude Code's real MCP configuration.
//!
//! Unlike `mcp_manager` (read-only discovery used at session launch), this
//! module edits the files Claude Code itself reads:
//! - Project scope: `<project>/.mcp.json` → `mcpServers`
//! - User scope:    `~/.claude.json` → top-level `mcpServers`
//! - Local scope:   `~/.claude.json` → `projects[<key>].mcpServers`
//!
//! Enable/disable piggybacks on Claude Code's own per-project lists in
//! `~/.claude.json` `projects[<key>]`:
//! - `.mcp.json` servers: `enabledMcpjsonServers` / `disabledMcpjsonServers`
//!   (tri-state: a server in neither list is *pending approval*, not enabled)
//! - user/local servers and claude.ai connectors: `disabledMcpServers`
//!
//! claude.ai connectors (account-level, e.g. "claude.ai Atlassian") are not
//! defined in any local file; the names Claude Code has seen are cached in the
//! top-level `claudeAiMcpEverConnected` array, and per-project disabling works
//! through `disabledMcpServers` — so they can be listed and toggled, but not
//! added, edited or removed locally.
//!
//! Write safety:
//! - Only the addressed subtree is mutated; all other keys round-trip intact
//!   (serde_json `preserve_order` keeps the file's key order).
//! - The first write to a file in an app run copies it to
//!   `<file>.maestro-backup`.
//! - Writes go through a temp file + rename so a crash can't truncate.
//! - `~/.claude.json` read-modify-write cycles are serialized in-process via
//!   [`CLAUDE_JSON_LOCK`]; project `.mcp.json` writes must be serialized by
//!   the caller via `mcp_config_writer::dir_lock` (shared with session-launch
//!   injection). Races with the Claude CLI rewriting `~/.claude.json` are
//!   inherent to the shared-file design; the window is kept minimal.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::config_recovery::read_json_or_recover;
use super::mcp_error::{McpError, McpResult};
use super::samurai_files::strip_extended_length;

/// Serializes all in-process read-modify-write cycles on ~/.claude.json.
static CLAUDE_JSON_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Files already backed up in this app run. One backup per file per run is
/// enough to undo a bad editing session without copying a potentially large
/// ~/.claude.json on every toggle click.
static BACKED_UP: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// Scope of a managed MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpScope {
    /// `<project>/.mcp.json`
    Project,
    /// `~/.claude.json` top-level `mcpServers`
    User,
    /// `~/.claude.json` `projects[<key>].mcpServers`
    Local,
    /// claude.ai account connector (toggle only)
    Connector,
}

/// A server as shown in the management UI, with its raw JSON config so any
/// transport type (stdio/http/sse/…) round-trips without loss.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpManagedServer {
    pub name: String,
    pub scope: McpScope,
    pub enabled: bool,
    /// Project-scope only: the server is in neither the enabled nor the
    /// disabled list, so Claude Code treats it as awaiting user approval.
    pub pending: bool,
    /// "stdio" | "http" | "sse" | … (explicit `type` or inferred)
    pub transport: String,
    /// Raw entry from the config file, for display and editing.
    pub config: Value,
}

/// A claude.ai account connector (from `claudeAiMcpEverConnected`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnector {
    pub name: String,
    pub enabled: bool,
}

/// Everything the management UI needs, read fresh from disk (no cache).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatusView {
    pub servers: Vec<McpManagedServer>,
    pub connectors: Vec<McpConnector>,
}

/// Servers injected by Maestro itself for session status reporting.
/// Matches exactly the names `mcp_config_writer` writes or wrote: the current
/// "maestro-status" entry, legacy per-session "maestro-status-N" and
/// "maestro-N" (numeric suffix) entries, and the original "maestro" name.
/// Deliberately NOT a blanket `maestro-` prefix: a user's own server named
/// e.g. "maestro-tools" stays manageable.
pub fn is_internal_server(name: &str) -> bool {
    if name == "maestro" || name == "maestro-status" || name.starts_with("maestro-status-") {
        return true;
    }
    name.strip_prefix("maestro-")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

fn claude_json_path() -> McpResult<PathBuf> {
    BaseDirs::new()
        .map(|d| d.home_dir().join(".claude.json"))
        .ok_or(McpError::NoHomeDir)
}

/// Converts a project path into the key format Claude Code uses in
/// `~/.claude.json` `projects`: forward slashes, no `\\?\` prefix.
pub fn claude_project_key(project_path: &str) -> String {
    let canonical = fs::canonicalize(project_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| project_path.to_string());
    strip_extended_length(&canonical).replace('\\', "/")
}

/// Compares two project keys leniently: slash direction, trailing slash and
/// (on Windows) case differences must not cause a miss.
pub(crate) fn project_keys_match(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    let (a, b) = (norm(a), norm(b));
    if cfg!(windows) {
        a.eq_ignore_ascii_case(&b)
    } else {
        a == b
    }
}

/// Finds the existing key in `projects` matching this project, if any.
fn find_project_key(projects: &Map<String, Value>, project_key: &str) -> Option<String> {
    projects
        .keys()
        .find(|k| project_keys_match(k, project_key))
        .cloned()
}

/// Strict read for WRITE paths: a corrupt file is an error, never silently
/// replaced — a read-modify-write over `{}` would wipe the user's config.
fn read_json_strict(path: &Path) -> McpResult<Value> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let content = fs::read_to_string(path).map_err(|source| McpError::ReadFile {
        path: path.to_path_buf(),
        source,
    })?;
    if content.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&content).map_err(|source| McpError::ParseFile {
        path: path.to_path_buf(),
        source,
    })
}

/// Lenient read for the STATUS view: a missing or corrupt file just
/// contributes no servers (logged), so one bad file doesn't blank the whole
/// sidebar section. Never modifies or moves the file.
fn read_json_lenient(path: &Path) -> Value {
    match read_json_strict(path) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("MCP status: {} — showing no servers from this file", e);
            json!({})
        }
    }
}

/// Writes `value` to `path` via temp file + rename. The first write to a
/// given path in this app run also copies the original to
/// `<file>.maestro-backup`.
fn write_json_file(path: &Path, value: &Value) -> McpResult<()> {
    let should_backup = {
        let mut done = BACKED_UP
            .lock()
            .map_err(|e| McpError::LockPoisoned(e.to_string()))?;
        path.exists() && done.insert(path.to_path_buf())
    };
    if should_backup {
        let backup = path.with_extension(match path.extension().and_then(|e| e.to_str()) {
            Some(ext) => format!("{}.maestro-backup", ext),
            None => "maestro-backup".to_string(),
        });
        fs::copy(path, &backup).map_err(|source| McpError::Backup {
            path: path.to_path_buf(),
            backup: backup.clone(),
            source,
        })?;
    }

    let pretty = serde_json::to_string_pretty(value).map_err(|source| McpError::SerializeFile {
        path: path.to_path_buf(),
        source,
    })?;

    let tmp = path.with_extension("maestro-tmp");
    fs::write(&tmp, pretty).map_err(|source| McpError::WriteFile {
        path: tmp.clone(),
        source,
    })?;
    fs::rename(&tmp, path).map_err(|source| McpError::ReplaceFile {
        path: path.to_path_buf(),
        source,
    })
}

/// Infers the transport label from a raw server entry.
fn transport_of(config: &Value) -> String {
    if let Some(t) = config.get("type").and_then(|v| v.as_str()) {
        return t.to_string();
    }
    if config.get("url").is_some() {
        return "http".to_string();
    }
    "stdio".to_string()
}

/// Returns the string items of `projects[<key>].<list>` (empty if absent).
fn project_list(project_entry: Option<&Value>, list: &str) -> Vec<String> {
    project_entry
        .and_then(|p| p.get(list))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Names disabled for this project via Claude Code's per-project lists
/// (both the `.mcp.json` list and the user/connector list). Used by the
/// session-launch writers so a server disabled in the sidebar is never
/// copied into a session config. Lenient: unreadable config disables nothing.
pub fn disabled_server_names(project_path: &str) -> HashSet<String> {
    let Ok(path) = claude_json_path() else {
        return HashSet::new();
    };
    let root = read_json_lenient(&path);
    let project_key = claude_project_key(project_path);
    let empty_map = Map::new();
    let projects = root
        .get("projects")
        .and_then(|v| v.as_object())
        .unwrap_or(&empty_map);
    let entry = find_project_key(projects, &project_key).and_then(|k| projects.get(&k));

    let mut names: HashSet<String> = HashSet::new();
    names.extend(project_list(entry, "disabledMcpjsonServers"));
    names.extend(project_list(entry, "disabledMcpServers"));
    names
}

/// Reads the full management view for a project, fresh from disk.
///
/// Degrades per file: a corrupt `~/.claude.json` still shows `.mcp.json`
/// servers and vice versa.
pub fn get_status(project_path: &str) -> McpResult<McpStatusView> {
    let project_key = claude_project_key(project_path);
    let claude_root = read_json_lenient(&claude_json_path()?);

    let empty_map = Map::new();
    let projects = claude_root
        .get("projects")
        .and_then(|v| v.as_object())
        .unwrap_or(&empty_map);
    let project_entry = find_project_key(projects, &project_key).and_then(|k| projects.get(&k));

    let enabled_mcpjson = project_list(project_entry, "enabledMcpjsonServers");
    let disabled_mcpjson = project_list(project_entry, "disabledMcpjsonServers");
    let disabled_mcp = project_list(project_entry, "disabledMcpServers");
    let approve_all = project_entry
        .and_then(|p| p.get("enableAllProjectMcpServers"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut servers = Vec::new();

    // Project scope: <project>/.mcp.json. Claude Code's approval model for
    // these is tri-state: disabled list > enabled list / approve-all > pending.
    let mcp_json = read_json_lenient(&Path::new(project_path).join(".mcp.json"));
    if let Some(entries) = mcp_json.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, config) in entries {
            if is_internal_server(name) {
                continue;
            }
            let disabled = disabled_mcpjson.contains(name);
            let approved = approve_all || enabled_mcpjson.contains(name);
            servers.push(McpManagedServer {
                name: name.clone(),
                scope: McpScope::Project,
                enabled: !disabled && approved,
                pending: !disabled && !approved,
                transport: transport_of(config),
                config: config.clone(),
            });
        }
    }

    // Local scope: ~/.claude.json projects[<key>].mcpServers
    if let Some(entries) = project_entry
        .and_then(|p| p.get("mcpServers"))
        .and_then(|v| v.as_object())
    {
        for (name, config) in entries {
            if is_internal_server(name) {
                continue;
            }
            servers.push(McpManagedServer {
                name: name.clone(),
                scope: McpScope::Local,
                enabled: !disabled_mcp.contains(name),
                pending: false,
                transport: transport_of(config),
                config: config.clone(),
            });
        }
    }

    // User scope: ~/.claude.json top-level mcpServers
    if let Some(entries) = claude_root.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, config) in entries {
            if is_internal_server(name) {
                continue;
            }
            servers.push(McpManagedServer {
                name: name.clone(),
                scope: McpScope::User,
                enabled: !disabled_mcp.contains(name),
                pending: false,
                transport: transport_of(config),
                config: config.clone(),
            });
        }
    }

    // claude.ai connectors: names cached in claudeAiMcpEverConnected
    let connectors = claude_root
        .get("claudeAiMcpEverConnected")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|name| McpConnector {
                    name: name.to_string(),
                    enabled: !disabled_mcp.iter().any(|d| d == name),
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(McpStatusView {
        servers,
        connectors,
    })
}

/// Adds or replaces a server entry in the file for the given scope.
///
/// With `overwrite == false`, an existing entry with the same name in that
/// scope is an error — protects against the Add flow silently clobbering a
/// server (and its credentials) the user forgot they had.
///
/// Project-scope callers must hold `mcp_config_writer::dir_lock(project_path)`.
pub fn upsert_server(
    project_path: &str,
    scope: McpScope,
    name: &str,
    config: Value,
    overwrite: bool,
) -> McpResult<()> {
    if name.trim().is_empty() {
        return Err(McpError::EmptyName);
    }
    if is_internal_server(name) {
        return Err(McpError::ReservedName(name.to_string()));
    }
    if !config.is_object() {
        return Err(McpError::ConfigNotObject);
    }

    let check_collision = |servers: &Map<String, Value>| -> McpResult<()> {
        if !overwrite && servers.contains_key(name) {
            return Err(McpError::AlreadyExists(name.to_string()));
        }
        Ok(())
    };

    match scope {
        McpScope::Project => {
            let path = Path::new(project_path).join(".mcp.json");
            // Self-heal a corrupt .mcp.json the same way session launch does.
            let mut root = read_json_or_recover(&path)?;
            let servers = ensure_object(&mut root, "mcpServers")?;
            check_collision(servers)?;
            servers.insert(name.to_string(), config);
            write_json_file(&path, &root)
        }
        McpScope::User => {
            let _guard = CLAUDE_JSON_LOCK
                .lock()
                .map_err(|e| McpError::LockPoisoned(e.to_string()))?;
            let path = claude_json_path()?;
            let mut root = read_json_strict(&path)?;
            let servers = ensure_object(&mut root, "mcpServers")?;
            check_collision(servers)?;
            servers.insert(name.to_string(), config);
            write_json_file(&path, &root)
        }
        McpScope::Local => {
            let _guard = CLAUDE_JSON_LOCK
                .lock()
                .map_err(|e| McpError::LockPoisoned(e.to_string()))?;
            let path = claude_json_path()?;
            let mut root = read_json_strict(&path)?;
            let entry = ensure_project_entry(&mut root, project_path)?;
            let servers = ensure_object(entry, "mcpServers")?;
            check_collision(servers)?;
            servers.insert(name.to_string(), config);
            write_json_file(&path, &root)
        }
        McpScope::Connector => Err(McpError::ConnectorReadOnly("edited")),
    }
}

/// Removes a server entry from the file for the given scope, and cleans its
/// name out of the project's enable/disable lists.
///
/// Project-scope callers must hold `mcp_config_writer::dir_lock(project_path)`.
pub fn remove_server(project_path: &str, scope: McpScope, name: &str) -> McpResult<()> {
    if is_internal_server(name) {
        return Err(McpError::InternalServer {
            name: name.to_string(),
            action: "removed",
        });
    }

    let remove_from = |root: &mut Value, name: &str| -> bool {
        root.get_mut("mcpServers")
            .and_then(|v| v.as_object_mut())
            .map(|m| m.remove(name).is_some())
            .unwrap_or(false)
    };

    match scope {
        McpScope::Project => {
            let path = Path::new(project_path).join(".mcp.json");
            let mut root = read_json_or_recover(&path)?;
            if !remove_from(&mut root, name) {
                return Err(McpError::NotFound {
                    name: name.to_string(),
                    location: ".mcp.json",
                });
            }
            write_json_file(&path, &root)?;
            // Best-effort cleanup of stale approve/deny list entries.
            let _ = prune_from_lists(project_path, name);
            Ok(())
        }
        McpScope::User => {
            let _guard = CLAUDE_JSON_LOCK
                .lock()
                .map_err(|e| McpError::LockPoisoned(e.to_string()))?;
            let path = claude_json_path()?;
            let mut root = read_json_strict(&path)?;
            if !remove_from(&mut root, name) {
                return Err(McpError::NotFound {
                    name: name.to_string(),
                    location: "~/.claude.json",
                });
            }
            write_json_file(&path, &root)
        }
        McpScope::Local => {
            let _guard = CLAUDE_JSON_LOCK
                .lock()
                .map_err(|e| McpError::LockPoisoned(e.to_string()))?;
            let path = claude_json_path()?;
            let mut root = read_json_strict(&path)?;
            let entry = ensure_project_entry(&mut root, project_path)?;
            let removed = entry
                .get_mut("mcpServers")
                .and_then(|v| v.as_object_mut())
                .map(|m| m.remove(name).is_some())
                .unwrap_or(false);
            if !removed {
                return Err(McpError::NotFound {
                    name: name.to_string(),
                    location: "local scope for this project",
                });
            }
            write_json_file(&path, &root)
        }
        McpScope::Connector => Err(McpError::ConnectorReadOnly("removed")),
    }
}

/// Enables or disables a server for this project using Claude Code's own
/// per-project lists in ~/.claude.json.
pub fn set_server_enabled(
    project_path: &str,
    scope: McpScope,
    name: &str,
    enabled: bool,
) -> McpResult<()> {
    if is_internal_server(name) {
        return Err(McpError::InternalServer {
            name: name.to_string(),
            action: "toggled",
        });
    }

    let _guard = CLAUDE_JSON_LOCK
        .lock()
        .map_err(|e| McpError::LockPoisoned(e.to_string()))?;
    let path = claude_json_path()?;
    let mut root = read_json_strict(&path)?;
    let entry = ensure_project_entry(&mut root, project_path)?;

    match scope {
        McpScope::Project => {
            // Claude Code semantics for .mcp.json servers: approved names live in
            // enabledMcpjsonServers, rejected ones in disabledMcpjsonServers.
            if enabled {
                list_remove(entry, "disabledMcpjsonServers", name);
                list_add(entry, "enabledMcpjsonServers", name);
            } else {
                list_remove(entry, "enabledMcpjsonServers", name);
                list_add(entry, "disabledMcpjsonServers", name);
            }
        }
        McpScope::User | McpScope::Local | McpScope::Connector => {
            if enabled {
                list_remove(entry, "disabledMcpServers", name);
            } else {
                list_add(entry, "disabledMcpServers", name);
            }
        }
    }

    write_json_file(&path, &root)
}

/// Removes `name` from both mcpjson approve/deny lists (used after deleting a
/// project-scope server).
fn prune_from_lists(project_path: &str, name: &str) -> McpResult<()> {
    let _guard = CLAUDE_JSON_LOCK
        .lock()
        .map_err(|e| McpError::LockPoisoned(e.to_string()))?;
    let path = claude_json_path()?;
    let mut root = read_json_strict(&path)?;
    let project_key = claude_project_key(project_path);

    let Some(projects) = root.get_mut("projects").and_then(|v| v.as_object_mut()) else {
        return Ok(());
    };
    let Some(key) = find_project_key(projects, &project_key) else {
        return Ok(());
    };
    let Some(entry) = projects.get_mut(&key) else {
        return Ok(());
    };

    let removed_enabled = list_remove(entry, "enabledMcpjsonServers", name);
    let removed_disabled = list_remove(entry, "disabledMcpjsonServers", name);

    if removed_enabled || removed_disabled {
        write_json_file(&path, &root)?;
    }
    Ok(())
}

/// Gets `root[key]` as a mutable object, creating an empty one if absent.
fn ensure_object<'a>(root: &'a mut Value, key: &str) -> McpResult<&'a mut Map<String, Value>> {
    let obj = root.as_object_mut().ok_or(McpError::RootNotObject)?;
    if !obj.get(key).map(|v| v.is_object()).unwrap_or(false) {
        obj.insert(key.to_string(), json!({}));
    }
    Ok(obj
        .get_mut(key)
        .and_then(|v| v.as_object_mut())
        .expect("just inserted object"))
}

/// Gets the mutable `projects[<key>]` entry for this project in ~/.claude.json,
/// creating a minimal one (Claude Code fills in the rest lazily) if absent.
fn ensure_project_entry<'a>(root: &'a mut Value, project_path: &str) -> McpResult<&'a mut Value> {
    let project_key = claude_project_key(project_path);
    let projects = ensure_object(root, "projects")?;
    let key = find_project_key(projects, &project_key).unwrap_or(project_key);
    if !projects.get(&key).map(|v| v.is_object()).unwrap_or(false) {
        projects.insert(key.clone(), json!({}));
    }
    Ok(projects.get_mut(&key).expect("just inserted project entry"))
}

/// Adds `name` to the string array `entry[list]` if not present (creates the array).
fn list_add(entry: &mut Value, list: &str, name: &str) {
    let Some(obj) = entry.as_object_mut() else {
        return;
    };
    if !obj.get(list).map(|v| v.is_array()).unwrap_or(false) {
        obj.insert(list.to_string(), json!([]));
    }
    let arr = obj.get_mut(list).and_then(|v| v.as_array_mut()).unwrap();
    if !arr.iter().any(|v| v.as_str() == Some(name)) {
        arr.push(json!(name));
    }
}

/// Removes `name` from the string array `entry[list]`; returns whether it was present.
fn list_remove(entry: &mut Value, list: &str, name: &str) -> bool {
    if let Some(arr) = entry
        .as_object_mut()
        .and_then(|o| o.get_mut(list))
        .and_then(|v| v.as_array_mut())
    {
        let before = arr.len();
        arr.retain(|v| v.as_str() != Some(name));
        return arr.len() != before;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_claude_project_key_normalizes_backslashes() {
        // Non-existent path: canonicalize fails, falls back to raw input.
        assert_eq!(
            claude_project_key(r"D:\nonexistent\proj"),
            "D:/nonexistent/proj"
        );
    }

    #[test]
    fn test_project_keys_match_lenient() {
        assert!(project_keys_match("C:/git/maestro", r"C:\git\maestro"));
        assert!(project_keys_match("C:/git/maestro/", "C:/git/maestro"));
        #[cfg(windows)]
        assert!(project_keys_match("c:/git/maestro", "C:/git/maestro"));
        assert!(!project_keys_match("C:/git/other", "C:/git/maestro"));
    }

    #[test]
    fn test_is_internal_server() {
        assert!(is_internal_server("maestro"));
        assert!(is_internal_server("maestro-status"));
        assert!(is_internal_server("maestro-status-3"));
        // Legacy per-session numeric entries are Maestro's own.
        assert!(is_internal_server("maestro-1"));
        assert!(is_internal_server("maestro-42"));
        // A user's own server that merely shares the prefix stays manageable.
        assert!(!is_internal_server("maestro-tools"));
        assert!(!is_internal_server("maestro-1a"));
        assert!(!is_internal_server("playwright"));
    }

    #[test]
    fn test_transport_inference() {
        assert_eq!(transport_of(&json!({"type": "sse", "url": "x"})), "sse");
        assert_eq!(transport_of(&json!({"url": "http://x"})), "http");
        assert_eq!(transport_of(&json!({"command": "npx"})), "stdio");
    }

    #[test]
    fn test_list_add_remove() {
        let mut entry = json!({});
        list_add(&mut entry, "disabledMcpServers", "foo");
        list_add(&mut entry, "disabledMcpServers", "foo");
        assert_eq!(entry["disabledMcpServers"], json!(["foo"]));
        assert!(list_remove(&mut entry, "disabledMcpServers", "foo"));
        assert!(!list_remove(&mut entry, "disabledMcpServers", "foo"));
        assert_eq!(entry["disabledMcpServers"], json!([]));
    }

    #[test]
    fn test_upsert_and_remove_project_scope() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().into_owned();

        upsert_server(
            &project,
            McpScope::Project,
            "test-server",
            json!({"type": "stdio", "command": "npx", "args": ["-y", "pkg"]}),
            false,
        )
        .unwrap();

        let written = read_json_strict(&dir.path().join(".mcp.json")).unwrap();
        assert_eq!(written["mcpServers"]["test-server"]["command"], "npx");

        // Adding a same-name server without overwrite is rejected…
        let err = upsert_server(
            &project,
            McpScope::Project,
            "test-server",
            json!({"type": "stdio", "command": "other"}),
            false,
        );
        assert!(err.is_err());
        // …but an explicit edit (overwrite) goes through.
        upsert_server(
            &project,
            McpScope::Project,
            "test-server",
            json!({"type": "stdio", "command": "other"}),
            true,
        )
        .unwrap();

        // Upsert preserves sibling entries (e.g. Maestro's injected server).
        upsert_server(
            &project,
            McpScope::Project,
            "second",
            json!({"type": "http", "url": "http://localhost:1"}),
            false,
        )
        .unwrap();
        let written = read_json_strict(&dir.path().join(".mcp.json")).unwrap();
        assert_eq!(written["mcpServers"]["test-server"]["command"], "other");

        remove_server(&project, McpScope::Project, "test-server").unwrap();
        let written = read_json_strict(&dir.path().join(".mcp.json")).unwrap();
        assert!(written["mcpServers"]["test-server"].is_null());
        assert!(written["mcpServers"]["second"].is_object());
    }

    /// Read-only smoke test against the developer's real config files.
    /// Ignored by default: only meaningful on a machine with Claude Code set up.
    #[test]
    #[ignore]
    fn smoke_get_status_real_files() {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let status = get_status(&repo_root).unwrap();
        println!("servers:");
        for s in &status.servers {
            println!(
                "  [{:?}] {} ({}) enabled={} pending={}",
                s.scope, s.name, s.transport, s.enabled, s.pending
            );
        }
        println!("connectors:");
        for c in &status.connectors {
            println!("  {} enabled={}", c.name, c.enabled);
        }
    }

    #[test]
    fn test_upsert_rejects_internal_names() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().into_owned();
        let err = upsert_server(
            &project,
            McpScope::Project,
            "maestro-status",
            json!({}),
            false,
        );
        assert!(err.is_err());
    }

    #[test]
    fn test_corrupt_mcp_json_self_heals_on_write() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().into_owned();
        std::fs::write(dir.path().join(".mcp.json"), "{ not json").unwrap();

        upsert_server(
            &project,
            McpScope::Project,
            "fresh",
            json!({"type": "stdio", "command": "npx"}),
            false,
        )
        .unwrap();

        let written = read_json_strict(&dir.path().join(".mcp.json")).unwrap();
        assert_eq!(written["mcpServers"]["fresh"]["command"], "npx");
        // The corrupt original is preserved for debugging.
        assert!(dir.path().join(".mcp.corrupt").exists());
    }
}
