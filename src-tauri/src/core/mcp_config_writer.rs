//! Writes session-specific `.mcp.json` configuration files for Claude CLI.
//!
//! This module handles generating and writing MCP configuration files to the
//! working directory before launching the Claude CLI. It merges Maestro's
//! session-specific server configuration with any existing user-defined servers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use dashmap::DashMap;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::config_recovery::read_json_or_recover;
use super::mcp_manager::{McpServerConfig, McpServerType};
use crate::commands::mcp::McpCustomServer;

/// Per-directory lock map to serialize concurrent .mcp.json read-modify-write operations.
static DIR_LOCKS: LazyLock<DashMap<PathBuf, Arc<Mutex<()>>>> = LazyLock::new(DashMap::new);

/// Acquire a per-directory lock for atomic .mcp.json operations.
///
/// `pub(crate)` so other writers of the same `.mcp.json` (the MCP management
/// commands in `commands::mcp`) serialize against session-launch injection —
/// two unsynchronized read-modify-write paths would silently lose updates.
pub(crate) fn dir_lock(dir: &Path) -> Arc<Mutex<()>> {
    DIR_LOCKS
        .entry(dir.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .value()
        .clone()
}

/// Write content to a file atomically: write to a temp file in the same directory, then rename.
///
/// `pub(crate)` so the other config writers that share files with external
/// tools (hook_config_writer / plugin_config_writer on settings.local.json)
/// use the same temp-file+rename pattern instead of a truncating write.
pub(crate) async fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("No parent directory")?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("No file name")?;
    let temp_path = parent.join(format!("{}.tmp.{}", file_name, std::process::id()));

    tokio::fs::write(&temp_path, content)
        .await
        .map_err(|e| format!("Failed to write temp file: {}", e))?;

    tokio::fs::rename(&temp_path, path).await.map_err(|e| {
        // Clean up temp file on rename failure
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to rename temp file: {}", e)
    })?;

    Ok(())
}

/// Finds the maestro-mcp-server binary in common installation locations.
///
/// Searches in order:
/// 1. Next to the current executable — covers both dev builds (target/{profile}/)
///    and production sidecar bundles (Contents/MacOS/ on macOS, next to exe on
///    Linux/Windows) since Tauri's `externalBin` places sidecars alongside the main binary.
/// 2. Inside Resources for macOS app bundle (legacy fallback)
/// 3. Development: relative to src-tauri/target/debug or release
/// 4. macOS Application Support (~Library/Application Support/Claude Maestro/)
/// 5. Linux local share (~/.local/share/maestro/)
fn find_maestro_mcp_path() -> Option<PathBuf> {
    // Determine the binary name based on platform
    #[cfg(target_os = "windows")]
    let binary_name = "maestro-mcp-server.exe";
    #[cfg(not(target_os = "windows"))]
    let binary_name = "maestro-mcp-server";

    let current_exe = std::env::current_exe().ok();
    log::debug!("find_maestro_mcp_path: current_exe = {:?}", current_exe);

    let candidates: Vec<Option<PathBuf>> = vec![
        // Candidate [0]: Next to the executable.
        // - Dev: build.rs copies to target/{profile}/ which is where current_exe lives
        // - Prod: Tauri's externalBin places sidecar in Contents/MacOS/ (macOS) or
        //   next to the exe (Linux/Windows), which is also current_exe's parent dir
        current_exe
            .as_ref()
            .and_then(|p| p.parent().map(|d| d.join(binary_name))),
        // Inside Resources for macOS app bundle
        current_exe.as_ref().and_then(|p| {
            p.parent()
                .and_then(|d| d.parent())
                .map(|d| d.join("Resources").join(binary_name))
        }),
        // Workspace development: MCP binary in release, main app in debug (or vice versa)
        // In workspace builds, exe is at target/{profile}/maestro.exe
        // and MCP binary is at target/release/maestro-mcp-server.exe
        current_exe.as_ref().and_then(|p| {
            p.parent() // target/{profile}
                .and_then(|d| d.parent()) // target
                .map(|d| d.join("release").join(binary_name))
        }),
        // Workspace development: also check debug build of MCP server
        current_exe.as_ref().and_then(|p| {
            p.parent() // target/{profile}
                .and_then(|d| d.parent()) // target
                .map(|d| d.join("debug").join(binary_name))
        }),
        // Non-workspace development: relative to src-tauri/target/debug or release
        // e.g., src-tauri/target/debug/../../../maestro-mcp-server/target/release/
        current_exe.as_ref().and_then(|p| {
            p.parent() // target/debug or target/release
                .and_then(|d| d.parent()) // target
                .and_then(|d| d.parent()) // src-tauri
                .and_then(|d| d.parent()) // project root
                .map(|d| {
                    d.join("maestro-mcp-server/target/release")
                        .join(binary_name)
                })
        }),
        // Non-workspace development: also check debug build of MCP server
        current_exe.as_ref().and_then(|p| {
            p.parent() // target/debug or target/release
                .and_then(|d| d.parent()) // target
                .and_then(|d| d.parent()) // src-tauri
                .and_then(|d| d.parent()) // project root
                .map(|d| d.join("maestro-mcp-server/target/debug").join(binary_name))
        }),
        // macOS Application Support
        directories::BaseDirs::new().map(|d| d.data_dir().join("Claude Maestro").join(binary_name)),
        // Linux local share
        directories::BaseDirs::new().map(|d| d.data_local_dir().join("maestro").join(binary_name)),
        // Windows AppData
        #[cfg(target_os = "windows")]
        directories::BaseDirs::new().map(|d| d.data_local_dir().join("Maestro").join(binary_name)),
    ];

    for (i, candidate) in candidates.iter().enumerate() {
        if let Some(path) = candidate {
            let exists = path.exists();
            log::debug!(
                "find_maestro_mcp_path: candidate[{}] = {:?}, exists = {}",
                i,
                path,
                exists
            );
            if exists {
                log::info!("find_maestro_mcp_path: found at {:?}", path);
                return Some(path.clone());
            }
        }
    }

    log::warn!("find_maestro_mcp_path: no binary found in any candidate location");
    None
}

/// Converts an McpServerConfig to the JSON format expected by `.mcp.json`.
fn server_config_to_json(config: &McpServerConfig) -> Value {
    match &config.server_type {
        McpServerType::Stdio { command, args, env } => {
            let mut obj = json!({
                "type": "stdio",
                "command": command,
                "args": args,
            });
            if !env.is_empty() {
                obj["env"] = json!(env);
            }
            obj
        }
        McpServerType::Http { url } => {
            json!({
                "type": "http",
                "url": url
            })
        }
    }
}

/// Converts a custom MCP server to the JSON format expected by `.mcp.json`.
fn custom_server_to_json(server: &McpCustomServer) -> Value {
    let mut obj = json!({
        "type": "stdio",
        "command": server.command,
        "args": server.args,
    });
    if !server.env.is_empty() {
        obj["env"] = json!(server.env);
    }
    obj
}

/// Checks if a server entry should be removed when updating the MCP config.
///
/// Delegates to `mcp_settings::is_internal_server`, the single tested
/// definition of "Maestro's own entry" ("maestro", "maestro-status", legacy
/// "maestro-status-N"). Deliberately NOT a blanket `maestro-` prefix: a user's
/// own server named e.g. "maestro-tools" must survive session launches.
fn should_remove_server(name: &str, _config: &Value, _session_id: u32) -> bool {
    let internal = crate::core::mcp_settings::is_internal_server(name);
    log::debug!("[MCP] should_remove_server('{}') = {}", name, internal);
    internal
}

/// Merges new MCP servers with an existing `.mcp.json` file.
///
/// This function preserves user-defined servers while removing all Maestro-related
/// entries (they'll be replaced with the new single "maestro-status" entry).
/// This follows the Swift pattern: ONE MCP entry per project with session ID in env.
fn merge_with_existing(
    mcp_path: &Path,
    new_servers: HashMap<String, Value>,
    session_id: u32,
) -> Result<Value, String> {
    log::debug!(
        "[MCP] merge_with_existing: {:?} for session {}",
        mcp_path,
        session_id
    );

    // A corrupt .mcp.json (e.g. from a crashed/interleaved write) is moved aside
    // and treated as empty so launching self-heals — and the maestro-status
    // server is always re-added below — instead of erroring on every session.
    let existing = read_json_or_recover(mcp_path)?;

    // Start from the existing root so sibling top-level keys the user has
    // (`$schema`, ...) survive the rewrite — `.mcp.json` may be committed to
    // the repo, and only `mcpServers` is ours to rebuild. (Same rule as
    // merge_with_opencode_existing.)
    let mut root = if existing.is_object() {
        existing
    } else {
        json!({})
    };

    // Keep all servers EXCEPT this session's Maestro entry
    let mut final_servers: serde_json::Map<String, Value> = root
        .get("mcpServers")
        .and_then(|s| s.as_object())
        .map(|obj| {
            obj.iter()
                .filter(|(name, v)| {
                    let should_remove = should_remove_server(name, v, session_id);
                    if should_remove {
                        log::info!(
                            "merge_with_existing: removing session {}'s server '{}'",
                            session_id,
                            name
                        );
                    }
                    !should_remove
                })
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<serde_json::Map<_, _>>()
        })
        .unwrap_or_default();

    // Add new servers for this session
    for (name, config) in new_servers {
        log::info!(
            "merge_with_existing: adding server '{}' for session {}",
            name,
            session_id
        );
        final_servers.insert(name, config);
    }

    log::info!(
        "merge_with_existing: final servers for session {}: {:?}",
        session_id,
        final_servers.keys().collect::<Vec<_>>()
    );

    root["mcpServers"] = Value::Object(final_servers);
    Ok(root)
}

/// Writes a session-specific `.mcp.json` to the working directory.
///
/// This function:
/// 1. Creates the Maestro MCP server entry with HTTP-based status reporting
/// 2. Adds enabled discovered servers from the project's .mcp.json
/// 3. Adds enabled custom servers (user-defined, global)
/// 4. Merges with any existing `.mcp.json` (preserving user servers)
/// 5. Writes the final config to the working directory
///
/// # Arguments
///
/// * `working_dir` - Directory where `.mcp.json` will be written
/// * `session_id` - Session identifier for the Maestro MCP server
/// * `status_url` - HTTP URL for the status server endpoint
/// * `instance_id` - UUID for this Maestro instance (prevents cross-instance pollution)
/// * `enabled_servers` - List of discovered MCP server configs enabled for this session
/// * `custom_servers` - List of custom MCP servers that are enabled
pub async fn write_session_mcp_config(
    working_dir: &Path,
    session_id: u32,
    status_url: &str,
    instance_id: &str,
    enabled_servers: &[McpServerConfig],
    custom_servers: &[McpCustomServer],
) -> Result<(), String> {
    let mut mcp_servers: HashMap<String, Value> = HashMap::new();

    // Add Maestro MCP server with HTTP-based status reporting.
    // Uses a SINGLE "maestro-status" entry with session ID in env vars (Swift pattern).
    // Each Claude instance spawns its own MCP server process with the env vars from when
    // it read the config. This avoids memory bloat from loading N servers per project.
    if let Some(mcp_path) = find_maestro_mcp_path() {
        log::info!(
            "Found maestro-mcp-server at {:?}, adding single maestro-status entry for session {} with status_url={}",
            mcp_path,
            session_id,
            status_url
        );

        // Use fixed name "maestro-status" - session ID is in env vars
        mcp_servers.insert(
            "maestro-status".to_string(),
            json!({
                "type": "stdio",
                "command": mcp_path.to_string_lossy(),
                "args": [],
                "env": {
                    "MAESTRO_SESSION_ID": session_id.to_string(),
                    "MAESTRO_STATUS_URL": status_url,
                    "MAESTRO_INSTANCE_ID": instance_id
                }
            }),
        );
    } else {
        log::warn!(
            "maestro-mcp-server binary not found, maestro_status tool will not be available"
        );
    }

    // Add enabled discovered servers from project .mcp.json
    for server in enabled_servers {
        mcp_servers.insert(server.name.clone(), server_config_to_json(server));
    }

    // Add enabled custom servers (user-defined, global)
    for server in custom_servers {
        mcp_servers.insert(server.name.clone(), custom_server_to_json(server));
    }

    // Acquire per-directory lock to serialize concurrent read-modify-write
    let lock = dir_lock(working_dir);
    let _guard = lock.lock().await;

    // Merge with existing .mcp.json if present (preserve user servers AND other sessions)
    let mcp_path = working_dir.join(".mcp.json");
    let final_config = merge_with_existing(&mcp_path, mcp_servers, session_id)?;

    // Write the file atomically (temp file + rename)
    let content = serde_json::to_string_pretty(&final_config)
        .map_err(|e| format!("Failed to serialize MCP config: {}", e))?;

    atomic_write(&mcp_path, &content).await?;

    log::debug!("Wrote session {} MCP config to {:?}", session_id, mcp_path);

    Ok(())
}

/// Converts an McpServerConfig to the JSON format expected by OpenCode's `opencode.json`.
///
/// OpenCode uses a different format than Claude:
/// - Uses `mcp` key instead of `mcpServers`
/// - Uses `type: "local"` instead of `type: "stdio"`
/// - Uses `command` as an array instead of a string
fn server_config_to_opencode_json(config: &McpServerConfig) -> Value {
    match &config.server_type {
        McpServerType::Stdio { command, args, env } => {
            let mut cmd_array = vec![command.clone()];
            cmd_array.extend(args.iter().cloned());
            let mut obj = json!({
                "type": "local",
                "command": cmd_array,
            });
            if !env.is_empty() {
                obj["environment"] = json!(env);
            }
            obj
        }
        McpServerType::Http { url } => {
            json!({
                "type": "remote",
                "url": url
            })
        }
    }
}

/// Converts a custom MCP server to the JSON format expected by OpenCode's `opencode.json`
fn custom_server_to_opencode_json(server: &McpCustomServer) -> Value {
    let mut cmd_array = vec![server.command.clone()];
    cmd_array.extend(server.args.iter().cloned());
    let mut obj = json!({
        "type": "local",
        "command": cmd_array,
    });
    if !server.env.is_empty() {
        obj["environment"] = json!(server.env);
    }
    obj
}

/// Writes a session-specific `opencode.json` to the working directory for OpenCode CLI.
///
/// This function:
/// 1. Creates the Maestro MCP server entry with HTTP-based status reporting
/// 2. Adds enabled discovered servers (translated to OpenCode format)
/// 3. Adds enabled custom servers (user-defined, global)
/// 4. Merges with any existing `opencode.json` (preserving user servers)
/// 5. Writes the final config to the working directory
///
/// OpenCode uses a different config format:
/// - File: `opencode.json` instead of `.mcp.json`
/// - Key: `mcp` instead of `mcpServers`
/// - Type: `local` instead of `stdio`, `remote` instead of `http`
/// - Command: array instead of string
pub async fn write_opencode_mcp_config(
    working_dir: &Path,
    session_id: u32,
    status_url: &str,
    instance_id: &str,
    enabled_servers: &[McpServerConfig],
    custom_servers: &[McpCustomServer],
) -> Result<(), String> {
    let mut mcp_servers: HashMap<String, Value> = HashMap::new();

    // Add Maestro MCP server with HTTP-based status reporting.
    if let Some(mcp_path) = find_maestro_mcp_path() {
        log::info!(
            "Found maestro-mcp-server at {:?}, adding maestro-status entry for OpenCode session {} with status_url={}",
            mcp_path,
            session_id,
            status_url
        );

        mcp_servers.insert(
            "maestro-status".to_string(),
            json!({
                "type": "local",
                "command": [mcp_path.to_string_lossy().to_string()],
                "enabled": true,
                "environment": {
                    "MAESTRO_SESSION_ID": session_id.to_string(),
                    "MAESTRO_STATUS_URL": status_url,
                    "MAESTRO_INSTANCE_ID": instance_id
                }
            }),
        );
    } else {
        log::warn!(
            "maestro-mcp-server binary not found, maestro_status tool will not be available for OpenCode"
        );
    }

    // Add enabled discovered servers (translated to OpenCode format)
    for server in enabled_servers {
        mcp_servers.insert(server.name.clone(), server_config_to_opencode_json(server));
    }

    // Add enabled custom servers (translated to OpenCode format)
    for server in custom_servers {
        mcp_servers.insert(server.name.clone(), custom_server_to_opencode_json(server));
    }

    // Acquire per-directory lock to serialize concurrent read-modify-write
    let lock = dir_lock(working_dir);
    let _guard = lock.lock().await;

    // Merge with existing opencode.json if present
    let opencode_path = working_dir.join("opencode.json");
    let final_config = merge_with_opencode_existing(&opencode_path, mcp_servers, session_id)?;

    // Write the file atomically
    let content = serde_json::to_string_pretty(&final_config)
        .map_err(|e| format!("Failed to serialize OpenCode MCP config: {}", e))?;

    atomic_write(&opencode_path, &content).await?;

    log::debug!(
        "Wrote session {} OpenCode MCP config to {:?}",
        session_id,
        opencode_path
    );

    Ok(())
}

/// Merges new MCP servers with an existing `opencode.json` file.
///
/// Starts from the existing file's root so every non-`mcp` key the user has
/// (`$schema`, `theme`, `model`, `permission`, `keybinds`, ...) survives the
/// rewrite — `opencode.json` is OpenCode's MAIN config file, not just an MCP
/// manifest. Only the `mcp` key is rebuilt.
fn merge_with_opencode_existing(
    opencode_path: &Path,
    new_servers: HashMap<String, Value>,
    _session_id: u32,
) -> Result<Value, String> {
    let mut root = if opencode_path.exists() {
        let content = std::fs::read_to_string(opencode_path)
            .map_err(|e| format!("Failed to read existing opencode.json: {}", e))?;

        match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(existing) if existing.is_object() => existing,
            Ok(_) => {
                log::warn!("Existing opencode.json is not a JSON object, will overwrite");
                json!({})
            }
            Err(e) => {
                log::warn!(
                    "Failed to parse existing opencode.json: {}, will overwrite",
                    e
                );
                json!({})
            }
        }
    } else {
        json!({})
    };

    // New (Maestro-injected) servers first; existing user entries override on
    // name collision, matching the pre-existing precedence. Maestro's own
    // entries are never carried forward — new_servers has the fresh one.
    let mut final_servers: serde_json::Map<String, Value> = new_servers.into_iter().collect();
    if let Some(existing_mcp) = root.get("mcp").and_then(|m| m.as_object()) {
        log::debug!(
            "Merging with existing opencode.json, {} existing servers",
            existing_mcp.len()
        );
        for (name, config) in existing_mcp {
            if !crate::core::mcp_settings::is_internal_server(name) {
                final_servers.insert(name.clone(), config.clone());
            }
        }
    }

    root["mcp"] = Value::Object(final_servers);
    Ok(root)
}

/// Removes Maestro server entries from `opencode.json`.
///
/// This should be called when a session is killed to clean up the config file.
pub async fn remove_opencode_mcp_config(working_dir: &Path, session_id: u32) -> Result<(), String> {
    let opencode_path = working_dir.join("opencode.json");
    if !opencode_path.exists() {
        return Ok(());
    }

    // Acquire per-directory lock
    let lock = dir_lock(working_dir);
    let _guard = lock.lock().await;

    let content = tokio::fs::read_to_string(&opencode_path)
        .await
        .map_err(|e| format!("Failed to read opencode.json: {}", e))?;

    let mut root: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse opencode.json: {}", e))?;

    // Remove only Maestro's own entry, preserving every other key in the file
    // (opencode.json holds the user's main OpenCode settings — it must never
    // be truncated to `{}` here).
    let mut removed = false;
    if let Some(mcp) = root.get_mut("mcp").and_then(|m| m.as_object_mut()) {
        removed = mcp.remove("maestro-status").is_some();
        let now_empty = mcp.is_empty();
        if now_empty {
            if let Some(obj) = root.as_object_mut() {
                obj.remove("mcp");
            }
        }
    }

    if !removed {
        // Nothing of ours in the file — don't rewrite it at all.
        return Ok(());
    }

    let output = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("Failed to serialize opencode.json: {}", e))?;

    atomic_write(&opencode_path, &output).await?;

    log::debug!("Removed session {} from opencode.json", session_id);

    Ok(())
}

/// Removes Maestro server entries from `.mcp.json`.
///
/// This should be called when a session is killed to clean up the config file.
/// Removes the single "maestro-status" entry and any legacy per-session entries.
/// The function is idempotent - it does nothing if no entries exist.
///
/// Note: With the single-entry pattern, this removes the entry entirely.
/// The next session to start will write a fresh entry with its session ID.
///
/// # Arguments
///
/// * `working_dir` - Directory containing the `.mcp.json` file
/// * `session_id` - Session identifier (used for logging, cleanup removes all Maestro entries)
pub async fn remove_session_mcp_config(working_dir: &Path, session_id: u32) -> Result<(), String> {
    let mcp_path = working_dir.join(".mcp.json");
    if !mcp_path.exists() {
        return Ok(());
    }

    // Acquire per-directory lock to serialize concurrent read-modify-write
    let lock = dir_lock(working_dir);
    let _guard = lock.lock().await;

    let content = tokio::fs::read_to_string(&mcp_path)
        .await
        .map_err(|e| format!("Failed to read .mcp.json: {}", e))?;

    let mut config: Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse .mcp.json: {}", e))?;

    if let Some(servers) = config.get_mut("mcpServers").and_then(|s| s.as_object_mut()) {
        // Remove the single maestro-status entry
        if servers.remove("maestro-status").is_some() {
            log::debug!(
                "Removed maestro-status MCP config from {:?} (session {})",
                mcp_path,
                session_id
            );
        }

        // Also clean up any legacy per-session entries that might exist.
        // Uses is_internal_server, NOT a blanket "maestro-" prefix: a user's
        // own server named e.g. "maestro-tools" must survive session teardown.
        let legacy_keys: Vec<String> = servers
            .keys()
            .filter(|k| crate::core::mcp_settings::is_internal_server(k))
            .cloned()
            .collect();

        for key in legacy_keys {
            if servers.remove(&key).is_some() {
                log::debug!("Removed legacy {} MCP config from {:?}", key, mcp_path);
            }
        }
    }

    let output = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    atomic_write(&mcp_path, &output).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the tests build a full `McpServerConfig`, so the variant they
    // need is imported here rather than at module scope.
    use super::super::mcp_manager::McpServerSource;
    use std::collections::HashMap;
    use tempfile::tempdir;

    #[test]
    fn test_server_config_to_json_stdio() {
        let config = McpServerConfig {
            name: "test".to_string(),
            server_type: McpServerType::Stdio {
                command: "/usr/bin/test".to_string(),
                args: vec!["--flag".to_string()],
                env: {
                    let mut env = HashMap::new();
                    env.insert("KEY".to_string(), "value".to_string());
                    env
                },
            },
            source: McpServerSource::Project,
        };

        let json = server_config_to_json(&config);
        assert_eq!(json["type"], "stdio");
        assert_eq!(json["command"], "/usr/bin/test");
        assert_eq!(json["args"][0], "--flag");
        assert_eq!(json["env"]["KEY"], "value");
    }

    #[test]
    fn test_server_config_to_json_http() {
        let config = McpServerConfig {
            name: "test".to_string(),
            server_type: McpServerType::Http {
                url: "http://localhost:3000".to_string(),
            },
            source: McpServerSource::Project,
        };

        let json = server_config_to_json(&config);
        assert_eq!(json["type"], "http");
        assert_eq!(json["url"], "http://localhost:3000");
    }

    #[tokio::test]
    async fn test_write_session_mcp_config_creates_file() {
        let dir = tempdir().unwrap();
        let result = write_session_mcp_config(
            dir.path(),
            1,
            "http://127.0.0.1:9900/status",
            "test-instance-id",
            &[],
            &[],
        )
        .await;

        assert!(result.is_ok());
        assert!(dir.path().join(".mcp.json").exists());
    }

    #[test]
    fn test_merge_preserves_user_servers_removes_all_maestro() {
        let dir = tempdir().unwrap();
        let mcp_path = dir.path().join(".mcp.json");

        // Write an existing config with a user server and multiple legacy Maestro entries
        let existing = json!({
            "mcpServers": {
                "user-server": {
                    "type": "stdio",
                    "command": "/usr/bin/user-server",
                    "args": []
                },
                "maestro": {
                    "type": "stdio",
                    "command": "/usr/bin/old-maestro",
                    "args": []
                },
                "maestro-status-1": {
                    "type": "stdio",
                    "command": "/usr/bin/maestro-status-1",
                    "args": [],
                    "env": {
                        "MAESTRO_SESSION_ID": "1"
                    }
                },
                "maestro-status-2": {
                    "type": "stdio",
                    "command": "/usr/bin/maestro-status-2",
                    "args": [],
                    "env": {
                        "MAESTRO_SESSION_ID": "2"
                    }
                },
                "maestro-status": {
                    "type": "stdio",
                    "command": "/usr/bin/old-maestro-status",
                    "args": [],
                    "env": {
                        "MAESTRO_SESSION_ID": "old"
                    }
                }
            }
        });
        std::fs::write(&mcp_path, serde_json::to_string(&existing).unwrap()).unwrap();

        // Merge with new single maestro-status entry for session 3
        let mut new_servers = HashMap::new();
        new_servers.insert(
            "maestro-status".to_string(),
            json!({
                "type": "stdio",
                "command": "/usr/bin/new-maestro-status",
                "args": [],
                "env": {
                    "MAESTRO_SESSION_ID": "3",
                    "MAESTRO_STATUS_URL": "http://127.0.0.1:9900/status",
                    "MAESTRO_INSTANCE_ID": "test-instance"
                }
            }),
        );

        let result = merge_with_existing(&mcp_path, new_servers, 3).unwrap();
        let servers = result["mcpServers"].as_object().unwrap();

        // User server should be preserved
        assert!(
            servers.contains_key("user-server"),
            "user-server should be preserved"
        );
        // ALL legacy Maestro entries should be removed
        assert!(
            !servers.contains_key("maestro"),
            "bare 'maestro' should be removed"
        );
        assert!(
            !servers.contains_key("maestro-status-1"),
            "legacy session 1 entry should be removed"
        );
        assert!(
            !servers.contains_key("maestro-status-2"),
            "legacy session 2 entry should be removed"
        );
        // New single maestro-status entry should be present with updated command and session ID
        assert!(
            servers.contains_key("maestro-status"),
            "maestro-status entry should be present"
        );
        assert_eq!(
            servers["maestro-status"]["command"], "/usr/bin/new-maestro-status",
            "maestro-status should have new command"
        );
        assert_eq!(
            servers["maestro-status"]["env"]["MAESTRO_SESSION_ID"], "3",
            "maestro-status should have session ID 3 in env"
        );
    }

    #[test]
    fn test_merge_recovers_from_corrupt_mcp_json() {
        let dir = tempdir().unwrap();
        let mcp_path = dir.path().join(".mcp.json");

        // Invalid JSON — merge must not error; it should move it aside and
        // still produce a config containing the maestro-status entry.
        std::fs::write(&mcp_path, "{ \"mcpServers\": { } }\": [ leftover tail").unwrap();

        let mut new_servers = HashMap::new();
        new_servers.insert(
            "maestro-status".to_string(),
            json!({ "type": "stdio", "command": "/usr/bin/maestro-status", "args": [] }),
        );

        let result = merge_with_existing(&mcp_path, new_servers, 3).unwrap();
        let servers = result["mcpServers"].as_object().unwrap();
        assert!(servers.contains_key("maestro-status"));
        assert!(dir.path().join(".mcp.corrupt").exists());
    }

    #[tokio::test]
    async fn test_atomic_write_produces_valid_json() {
        let dir = tempdir().unwrap();
        let mcp_path = dir.path().join(".mcp.json");

        let content = serde_json::to_string_pretty(&json!({
            "mcpServers": { "test": { "type": "stdio", "command": "test" } }
        }))
        .unwrap();

        atomic_write(&mcp_path, &content).await.unwrap();

        let read_back = std::fs::read_to_string(&mcp_path).unwrap();
        let parsed: Value = serde_json::from_str(&read_back).unwrap();
        assert!(parsed["mcpServers"]["test"].is_object());
    }

    #[tokio::test]
    async fn test_concurrent_writes_produce_valid_json() {
        let dir = tempdir().unwrap();
        let dir_path = dir.path().to_path_buf();

        // Seed an initial file
        let initial = json!({ "mcpServers": {} });
        std::fs::write(
            dir_path.join(".mcp.json"),
            serde_json::to_string_pretty(&initial).unwrap(),
        )
        .unwrap();

        // Launch 10 concurrent merge+write operations
        let mut handles = vec![];
        for i in 0..10u32 {
            let dp = dir_path.clone();
            handles.push(tokio::spawn(async move {
                let lock = dir_lock(&dp);
                let _guard = lock.lock().await;

                let mcp_path = dp.join(".mcp.json");
                let content = std::fs::read_to_string(&mcp_path).unwrap();
                let mut config: Value = serde_json::from_str(&content).unwrap();

                // Each task adds its own server entry
                config["mcpServers"][format!("server-{}", i)] =
                    json!({ "type": "stdio", "command": format!("/bin/server-{}", i) });

                let output = serde_json::to_string_pretty(&config).unwrap();
                atomic_write(&mcp_path, &output).await.unwrap();
            }));
        }

        for h in handles {
            h.await.unwrap();
        }

        // Verify the final file is valid JSON with all 10 servers
        let final_content = std::fs::read_to_string(dir_path.join(".mcp.json")).unwrap();
        let final_config: Value =
            serde_json::from_str(&final_content).expect("final .mcp.json should be valid JSON");
        let servers = final_config["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 10, "should have all 10 server entries");
        for i in 0..10u32 {
            assert!(
                servers.contains_key(&format!("server-{}", i)),
                "missing server-{}",
                i
            );
        }
    }

    #[test]
    fn test_merge_removes_all_legacy_formats() {
        let dir = tempdir().unwrap();
        let mcp_path = dir.path().join(".mcp.json");

        // Write config with various legacy format entries
        let existing = json!({
            "mcpServers": {
                "maestro-1": {
                    "type": "stdio",
                    "command": "/usr/bin/maestro-1",
                    "args": [],
                    "env": {
                        "MAESTRO_SESSION_ID": "1"
                    }
                },
                "maestro-2": {
                    "type": "stdio",
                    "command": "/usr/bin/maestro-2",
                    "args": [],
                    "env": {
                        "MAESTRO_SESSION_ID": "2"
                    }
                },
                "other-server": {
                    "type": "stdio",
                    "command": "/usr/bin/other",
                    "args": []
                }
            }
        });
        std::fs::write(&mcp_path, serde_json::to_string(&existing).unwrap()).unwrap();

        // Add new single entry
        let mut new_servers = HashMap::new();
        new_servers.insert(
            "maestro-status".to_string(),
            json!({
                "type": "stdio",
                "command": "/usr/bin/new-maestro-status",
                "args": [],
                "env": {
                    "MAESTRO_SESSION_ID": "5"
                }
            }),
        );

        let result = merge_with_existing(&mcp_path, new_servers, 5).unwrap();
        let servers = result["mcpServers"].as_object().unwrap();

        // All legacy entries should be removed
        assert!(
            !servers.contains_key("maestro-1"),
            "maestro-1 legacy entry should be removed"
        );
        assert!(
            !servers.contains_key("maestro-2"),
            "maestro-2 legacy entry should be removed"
        );
        // Non-Maestro server should be preserved
        assert!(
            servers.contains_key("other-server"),
            "other-server should be preserved"
        );
        // New entry should be present
        assert!(
            servers.contains_key("maestro-status"),
            "new maestro-status entry should be present"
        );
    }

    #[test]
    fn test_merge_keeps_user_server_with_maestro_prefix() {
        let dir = tempdir().unwrap();
        let mcp_path = dir.path().join(".mcp.json");

        // A user-owned server that merely shares the "maestro-" prefix must
        // survive a session launch (regression: blanket prefix deleted it).
        let existing = json!({
            "mcpServers": {
                "maestro-tools": {
                    "type": "stdio",
                    "command": "/usr/bin/maestro-tools",
                    "args": [],
                    "env": { "SECRET": "keep-me" }
                }
            }
        });
        std::fs::write(&mcp_path, serde_json::to_string(&existing).unwrap()).unwrap();

        let mut new_servers = HashMap::new();
        new_servers.insert(
            "maestro-status".to_string(),
            json!({ "type": "stdio", "command": "/usr/bin/maestro-status", "args": [] }),
        );

        let result = merge_with_existing(&mcp_path, new_servers, 7).unwrap();
        let servers = result["mcpServers"].as_object().unwrap();

        assert!(
            servers.contains_key("maestro-tools"),
            "user server 'maestro-tools' must survive session launch"
        );
        assert_eq!(servers["maestro-tools"]["env"]["SECRET"], "keep-me");
        assert!(servers.contains_key("maestro-status"));
    }

    #[tokio::test]
    async fn test_remove_session_config_keeps_user_server_with_maestro_prefix() {
        let dir = tempdir().unwrap();
        let mcp_path = dir.path().join(".mcp.json");

        let existing = json!({
            "mcpServers": {
                "maestro-status": { "type": "stdio", "command": "/usr/bin/maestro-status", "args": [] },
                "maestro-tools": { "type": "stdio", "command": "/usr/bin/maestro-tools", "args": [] }
            }
        });
        std::fs::write(&mcp_path, serde_json::to_string(&existing).unwrap()).unwrap();

        remove_session_mcp_config(dir.path(), 7).await.unwrap();

        let read_back: Value =
            serde_json::from_str(&std::fs::read_to_string(&mcp_path).unwrap()).unwrap();
        let servers = read_back["mcpServers"].as_object().unwrap();
        assert!(
            !servers.contains_key("maestro-status"),
            "maestro-status should be cleaned up"
        );
        assert!(
            servers.contains_key("maestro-tools"),
            "user server 'maestro-tools' must survive session teardown"
        );
    }

    #[test]
    fn test_opencode_merge_preserves_non_mcp_keys() {
        let dir = tempdir().unwrap();
        let opencode_path = dir.path().join("opencode.json");

        // opencode.json is OpenCode's MAIN config file — every non-`mcp` key
        // must round-trip (regression: file was rebuilt as bare {"mcp": ...}).
        let existing = json!({
            "$schema": "https://opencode.ai/config.json",
            "theme": "tokyonight",
            "model": "anthropic/claude-sonnet-4-5",
            "permission": { "edit": "ask" },
            "mcp": {
                "playwright": { "type": "local", "command": ["npx", "playwright-mcp"] }
            }
        });
        std::fs::write(&opencode_path, serde_json::to_string(&existing).unwrap()).unwrap();

        let mut new_servers = HashMap::new();
        new_servers.insert(
            "maestro-status".to_string(),
            json!({ "type": "local", "command": ["/usr/bin/maestro-status"] }),
        );

        let result = merge_with_opencode_existing(&opencode_path, new_servers, 3).unwrap();

        assert_eq!(result["$schema"], "https://opencode.ai/config.json");
        assert_eq!(result["theme"], "tokyonight");
        assert_eq!(result["model"], "anthropic/claude-sonnet-4-5");
        assert_eq!(result["permission"]["edit"], "ask");
        let servers = result["mcp"].as_object().unwrap();
        assert!(
            servers.contains_key("playwright"),
            "existing user server preserved"
        );
        assert!(
            servers.contains_key("maestro-status"),
            "maestro entry added"
        );
    }

    #[tokio::test]
    async fn test_remove_opencode_config_preserves_non_mcp_keys() {
        let dir = tempdir().unwrap();
        let opencode_path = dir.path().join("opencode.json");

        // Removing our only entry must NOT truncate the file to {} —
        // the user's settings live at the root.
        let existing = json!({
            "theme": "tokyonight",
            "keybinds": { "leader": "space" },
            "mcp": {
                "maestro-status": { "type": "local", "command": ["/usr/bin/maestro-status"] }
            }
        });
        std::fs::write(&opencode_path, serde_json::to_string(&existing).unwrap()).unwrap();

        remove_opencode_mcp_config(dir.path(), 3).await.unwrap();

        let read_back: Value =
            serde_json::from_str(&std::fs::read_to_string(&opencode_path).unwrap()).unwrap();
        assert_eq!(read_back["theme"], "tokyonight");
        assert_eq!(read_back["keybinds"]["leader"], "space");
        assert!(
            read_back.get("mcp").is_none(),
            "empty mcp object should be dropped, not kept as clutter"
        );
    }
}
