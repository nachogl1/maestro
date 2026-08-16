//! Writes Claude Code hooks configuration into `.claude/settings.local.json`.
//!
//! This module handles generating and writing hook configuration that tells
//! Claude Code to POST hook events (SessionStart, SessionEnd, PreToolUse,
//! PostToolUse, Stop, Notification, UserPromptSubmit) back to Maestro's HTTP
//! status server via curl commands.
//!
//! Maestro MANAGES ONLY ITS OWN ENTRIES in the file (issue #109): its hooks
//! are recognizable by the `X-Maestro-Instance` header their curl command
//! sends, writes replace exactly those, and cleanup removes exactly those —
//! user-authored hooks in the same file survive both.

use std::path::Path;

use serde_json::{json, Value};

use super::config_recovery::read_json_or_recover;
use super::mcp_config_writer::{atomic_write, dir_lock};

/// Builds the hooks configuration JSON for a session.
///
/// Generates hook entries for SessionStart, SessionEnd, PreToolUse, and Stop.
/// Each hook uses curl to POST event data back to Maestro's HTTP server.
///
/// Note: PreToolUse is marked `"async": true` (fire-and-forget) so it doesn't
/// block Claude Code. The other hooks do NOT have the async flag.
fn build_hooks_config(session_id: u32, status_port: u16, instance_id: &str) -> Value {
    let base_url = format!("http://127.0.0.1:{}", status_port);
    let common_headers = format!(
        "-H 'Content-Type: application/json' -H 'X-Maestro-Session: {}' -H 'X-Maestro-Instance: {}'",
        session_id, instance_id
    );

    // Tolerant suffix swallows non-zero curl exit codes so a stale
    // settings.local.json (e.g. Maestro crashed without cleanup, or Claude
    // Code is launched outside Maestro) doesn't surface a hook error every
    // session. `cd .` is cmd.exe's no-op-that-exits-0; `true` is sh's.
    #[cfg(target_os = "windows")]
    let tolerant_suffix = " || cd .";
    #[cfg(not(target_os = "windows"))]
    let tolerant_suffix = " || true";

    let make_hook = |endpoint: &str, is_async: bool| -> Value {
        // `@-` reads POST body from stdin and works on Windows, macOS, and Linux.
        // `@/dev/stdin` is Unix-only and fails on Windows with
        // "curl: option -d: error encountered when reading a file".
        let command = format!(
            "curl -s -X POST {}/{} {} -d @-{}",
            base_url, endpoint, common_headers, tolerant_suffix
        );

        let mut hook = json!({
            "type": "command",
            "command": command,
        });

        if is_async {
            hook["async"] = json!(true);
        }

        json!([{ "hooks": [hook] }])
    };

    // Notification is the only reliable signal for mid-turn waits (permission
    // prompts, idle-prompt reminder) and UserPromptSubmit the only reliable
    // "a turn started" signal (issue #105). PostToolUse (issue #109) closes
    // the digit-shortcut gap: approving the turn's LAST long tool fires no
    // later PreToolUse, so without it the status stays NeedsInput for that
    // tool's whole runtime. All three are async fire-and-forget: they must
    // never block or inject context into the prompt (UserPromptSubmit stdout
    // would otherwise be appended to the user's prompt).
    json!({
        "SessionStart": make_hook("hook/session-start", false),
        "SessionEnd": make_hook("hook/session-end", false),
        "PreToolUse": make_hook("hook/pre-tool", true),
        "PostToolUse": make_hook("hook/post-tool", true),
        "Stop": make_hook("hook/stop", false),
        "Notification": make_hook("hook/notification", true),
        "UserPromptSubmit": make_hook("hook/user-prompt", true),
    })
}

/// Whether one hook entry (the `{type, command, ...}` object) is Maestro's.
///
/// Maestro's entries are the only ones that POST with the
/// `X-Maestro-Instance` header (see [`build_hooks_config`]) — a marker that
/// survives port and instance-id changes across launches, so entries written
/// by ANY past Maestro run are recognized. Everything else in the file is
/// user-authored and must never be touched (issue #109: the writer used to
/// wholesale-replace the `hooks` key, destroying user hooks on every launch).
fn is_maestro_hook_entry(entry: &Value) -> bool {
    entry["command"]
        .as_str()
        .is_some_and(|cmd| cmd.contains("X-Maestro-Instance"))
}

/// Strips Maestro's hook entries from one event's matcher-group array,
/// dropping groups left empty. Non-array shapes are left untouched (they are
/// user-authored, however invalid). Returns whether the array is now empty.
fn strip_maestro_entries(groups: &mut Value) -> bool {
    let Some(groups) = groups.as_array_mut() else {
        return false;
    };
    for group in groups.iter_mut() {
        if let Some(hooks) = group["hooks"].as_array_mut() {
            hooks.retain(|h| !is_maestro_hook_entry(h));
        }
    }
    groups.retain(|group| {
        group["hooks"]
            .as_array()
            .is_none_or(|hooks| !hooks.is_empty())
    });
    groups.is_empty()
}

/// Merges Maestro's hook entries into `config["hooks"]`, preserving every
/// user-authored entry (issue #109 — this used to wholesale-replace the
/// key): for each event Maestro manages, its own stale entries (recognized
/// via [`is_maestro_hook_entry`], whatever port/instance wrote them) are
/// removed first — so repeated launches never accumulate duplicates — and
/// the fresh group is appended after the user's groups.
fn merge_maestro_hooks(config: &mut Value, fresh: Value) {
    if !config["hooks"].is_object() {
        // Absent — or not an object, which no hooks schema accepts anyway:
        // Maestro's fresh map becomes the whole value.
        config["hooks"] = fresh;
        return;
    }
    let Some(hooks) = config["hooks"].as_object_mut() else {
        unreachable!("just checked is_object");
    };
    let Value::Object(fresh) = fresh else {
        return; // build_hooks_config always yields an object
    };
    for (event, groups) in fresh {
        match hooks.get_mut(&event) {
            Some(existing) if existing.is_array() => {
                strip_maestro_entries(existing);
                if let (Some(arr), Some(new_groups)) = (existing.as_array_mut(), groups.as_array())
                {
                    arr.extend(new_groups.iter().cloned());
                }
            }
            Some(existing) => {
                // A non-array under an event key is invalid hooks schema;
                // replacing it is the same self-heal spirit as the corrupt-
                // file recovery.
                log::warn!("hooks.{event} in settings.local.json is not an array — rebuilding it");
                *existing = groups;
            }
            None => {
                hooks.insert(event, groups);
            }
        }
    }
}

/// Writes session hooks configuration to `.claude/settings.local.json`.
///
/// This function:
/// 1. Creates the `.claude/` directory if it doesn't exist
/// 2. Reads existing `.claude/settings.local.json` or starts with `{}`
/// 3. Builds hooks config with `build_hooks_config()`
/// 4. MERGES it into `config["hooks"]` (issue #109): Maestro's own stale
///    entries are replaced, user-authored hook entries are preserved
/// 5. Writes back with `serde_json::to_string_pretty`
///
/// Other keys in settings.local.json (e.g. `enabledPlugins`) are preserved.
///
/// # Arguments
///
/// * `working_dir` - Directory where `.claude/settings.local.json` will be written
/// * `session_id` - Session identifier for the hook curl headers
/// * `status_port` - Port of the Maestro HTTP status server
/// * `instance_id` - UUID for this Maestro instance
pub async fn write_session_hooks_config(
    working_dir: &Path,
    session_id: u32,
    status_port: u16,
    instance_id: &str,
) -> Result<(), String> {
    // Create .claude directory if needed
    let claude_dir = working_dir.join(".claude");
    if !claude_dir.exists() {
        tokio::fs::create_dir_all(&claude_dir)
            .await
            .map_err(|e| format!("Failed to create .claude directory: {}", e))?;
    }

    // Serialize against the plugin writer: both read-modify-write the same
    // settings.local.json, and unsynchronized tasks either resurrect each
    // other's removed keys or interleave truncating writes into corrupt JSON.
    let lock = dir_lock(&claude_dir);
    let _guard = lock.lock().await;

    // Read existing settings or start fresh. A corrupt settings.local.json is
    // moved aside and treated as empty so launching self-heals instead of
    // erroring on every future session.
    let settings_path = claude_dir.join("settings.local.json");
    let mut config: Value = read_json_or_recover(&settings_path)?;

    // Valid JSON that isn't an object (a bare string or array) would make the
    // index-assignment below panic — self-heal it to an object, same spirit
    // as the corrupt-file recovery above.
    if !config.is_object() {
        log::warn!("settings.local.json is not a JSON object, rebuilding it");
        config = serde_json::json!({});
    }

    // Build and MERGE the hooks config — never wholesale-replace the key
    // (issue #109: that destroyed user-authored hooks on every launch).
    let hooks = build_hooks_config(session_id, status_port, instance_id);
    merge_maestro_hooks(&mut config, hooks);

    // Write back atomically (temp file + rename) so a concurrent reader never
    // sees a truncated file.
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize hooks config: {}", e))?;

    atomic_write(&settings_path, &content).await?;

    log::debug!(
        "Wrote session {} hooks config to {:?} (port={}, instance={})",
        session_id,
        settings_path,
        status_port,
        instance_id,
    );

    Ok(())
}

/// Removes Maestro's session hooks from `.claude/settings.local.json`.
///
/// Removes ONLY Maestro's own hook entries (issue #109) — user-authored
/// hooks survive cleanup. Event keys left empty are dropped, and the
/// `hooks` key itself is dropped once nothing remains, so legacy files
/// where Maestro previously owned the whole key still clean up to no
/// `hooks` key at all. No-op if the file doesn't exist.
///
/// # Arguments
///
/// * `working_dir` - Directory containing the `.claude/settings.local.json` file
pub async fn remove_session_hooks_config(working_dir: &Path) -> Result<(), String> {
    let claude_dir = working_dir.join(".claude");
    let settings_path = claude_dir.join("settings.local.json");
    if !settings_path.exists() {
        return Ok(());
    }

    // Serialize against the plugin writer (see write_session_hooks_config).
    let lock = dir_lock(&claude_dir);
    let _guard = lock.lock().await;

    let content = tokio::fs::read_to_string(&settings_path)
        .await
        .map_err(|e| format!("Failed to read settings.local.json: {}", e))?;

    let mut config: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse settings.local.json: {}", e))?;

    // Strip Maestro's entries per event, then prune what emptied out.
    if let Some(hooks) = config.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        let mut emptied: Vec<String> = Vec::new();
        for (event, groups) in hooks.iter_mut() {
            if strip_maestro_entries(groups) {
                emptied.push(event.clone());
            }
        }
        for event in emptied {
            hooks.remove(&event);
        }
        if hooks.is_empty() {
            if let Some(obj) = config.as_object_mut() {
                obj.remove("hooks");
            }
            log::debug!("Removed hooks config from {:?}", settings_path);
        }
    }

    // Write back the updated config atomically
    let output = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    atomic_write(&settings_path, &output).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_write_hooks_config_fresh() {
        let dir = tempdir().unwrap();

        let result = write_session_hooks_config(dir.path(), 3, 9900, "test-instance-abc").await;
        assert!(
            result.is_ok(),
            "write_session_hooks_config failed: {:?}",
            result.err()
        );

        // Verify the file exists
        let settings_path = dir.path().join(".claude/settings.local.json");
        assert!(settings_path.exists(), "settings.local.json should exist");

        // Parse and verify hooks content
        let content = std::fs::read_to_string(&settings_path).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();

        assert!(config.get("hooks").is_some(), "hooks key should exist");

        // Verify SessionStart curl has correct port and session_id
        let session_start = &config["hooks"]["SessionStart"];
        let command = session_start[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(
            command.contains("127.0.0.1:9900"),
            "SessionStart command should contain port 9900, got: {}",
            command
        );
        assert!(
            command.contains("X-Maestro-Session: 3"),
            "SessionStart command should contain session_id 3, got: {}",
            command
        );
        assert!(
            command.contains("X-Maestro-Instance: test-instance-abc"),
            "SessionStart command should contain instance_id, got: {}",
            command
        );
        assert!(
            command.contains("hook/session-start"),
            "SessionStart command should target /hook/session-start, got: {}",
            command
        );
        // Hook command must tolerate connection failures so a stale
        // settings.local.json (server down) doesn't error every session.
        #[cfg(target_os = "windows")]
        let expected_suffix = "|| cd .";
        #[cfg(not(target_os = "windows"))]
        let expected_suffix = "|| true";
        assert!(
            command.ends_with(expected_suffix),
            "SessionStart command should end with tolerant suffix `{}`, got: {}",
            expected_suffix,
            command
        );
    }

    #[tokio::test]
    async fn test_write_hooks_preserves_existing() {
        let dir = tempdir().unwrap();
        let claude_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();

        // Write pre-existing config with enabledPlugins
        let existing = json!({
            "enabledPlugins": {
                "some-plugin@official": true
            }
        });
        std::fs::write(
            claude_dir.join("settings.local.json"),
            serde_json::to_string_pretty(&existing).unwrap(),
        )
        .unwrap();

        // Write hooks config
        write_session_hooks_config(dir.path(), 1, 8080, "inst-xyz")
            .await
            .unwrap();

        // Read back and verify both keys exist
        let content = std::fs::read_to_string(claude_dir.join("settings.local.json")).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();

        // enabledPlugins should be preserved
        assert!(
            config.get("enabledPlugins").is_some(),
            "enabledPlugins should be preserved"
        );
        let plugins = config["enabledPlugins"].as_object().unwrap();
        assert_eq!(plugins["some-plugin@official"], true);

        // hooks should also be present
        assert!(config.get("hooks").is_some(), "hooks key should exist");
        assert!(
            config["hooks"].get("SessionStart").is_some(),
            "SessionStart hook should exist"
        );
    }

    #[tokio::test]
    async fn test_write_recovers_from_corrupt_settings() {
        let dir = tempdir().unwrap();
        let claude_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();

        // Invalid JSON — must not brick the launch.
        std::fs::write(
            claude_dir.join("settings.local.json"),
            "{\n  \"enabledPlugins\": {}\n}\": [ leftover hooks tail",
        )
        .unwrap();

        write_session_hooks_config(dir.path(), 1, 9900, "inst-recover")
            .await
            .unwrap();

        let content = std::fs::read_to_string(claude_dir.join("settings.local.json")).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();
        assert!(config["hooks"].get("SessionStart").is_some());
        assert!(claude_dir.join("settings.local.corrupt").exists());
    }

    #[tokio::test]
    async fn test_remove_hooks_config_legacy_maestro_owned_key() {
        let dir = tempdir().unwrap();
        let claude_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();

        // A legacy file where Maestro previously owned the WHOLE hooks key
        // (every entry carries the X-Maestro-Instance marker) — cleanup must
        // still remove the key entirely (issue #109).
        let existing = json!({
            "someOtherSetting": "keep-me",
            "hooks": {
                "SessionStart": [{"hooks": [{"type": "command", "command": "curl -s -X POST http://127.0.0.1:9905/hook/session-start -H 'X-Maestro-Instance: old-inst' -d @- || cd ."}]}],
                "Stop": [{"hooks": [{"type": "command", "command": "curl -s -X POST http://127.0.0.1:9905/hook/stop -H 'X-Maestro-Instance: old-inst' -d @- || cd ."}]}]
            }
        });
        std::fs::write(
            claude_dir.join("settings.local.json"),
            serde_json::to_string_pretty(&existing).unwrap(),
        )
        .unwrap();

        // Remove hooks
        remove_session_hooks_config(dir.path()).await.unwrap();

        // Read back and verify
        let content = std::fs::read_to_string(claude_dir.join("settings.local.json")).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();

        // hooks should be gone
        assert!(config.get("hooks").is_none(), "hooks key should be removed");

        // other settings should be preserved
        assert_eq!(
            config["someOtherSetting"], "keep-me",
            "other settings should be preserved"
        );
    }

    /// A user-authored hook entry — no X-Maestro-Instance marker anywhere.
    fn user_hook_group(command: &str) -> Value {
        json!({"matcher": "Bash", "hooks": [{"type": "command", "command": command}]})
    }

    /// Counts entries under one event that carry Maestro's marker.
    fn maestro_entries(config: &Value, event: &str) -> usize {
        config["hooks"][event]
            .as_array()
            .map(|groups| {
                groups
                    .iter()
                    .flat_map(|g| g["hooks"].as_array().cloned().unwrap_or_default())
                    .filter(is_maestro_hook_entry)
                    .count()
            })
            .unwrap_or(0)
    }

    #[tokio::test]
    async fn test_user_hooks_survive_write_and_cleanup() {
        // Issue #109: the writer used to wholesale-replace the hooks key,
        // destroying user-authored hooks on every launch, and cleanup used
        // to delete the whole key.
        let dir = tempdir().unwrap();
        let claude_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();
        let existing = json!({
            "hooks": {
                // An event Maestro also manages…
                "PreToolUse": [user_hook_group("my-linter --check")],
                // …and one it does not touch at all.
                "SubagentStop": [user_hook_group("notify-send done")],
            }
        });
        std::fs::write(
            claude_dir.join("settings.local.json"),
            serde_json::to_string_pretty(&existing).unwrap(),
        )
        .unwrap();

        write_session_hooks_config(dir.path(), 4, 9902, "inst-merge")
            .await
            .unwrap();

        let content = std::fs::read_to_string(claude_dir.join("settings.local.json")).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();
        // The user's PreToolUse group is still first; Maestro's follows it.
        let pre_tool = config["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre_tool.len(), 2, "user group + Maestro group");
        assert_eq!(pre_tool[0]["hooks"][0]["command"], "my-linter --check");
        assert!(is_maestro_hook_entry(&pre_tool[1]["hooks"][0]));
        // The unmanaged event is untouched.
        assert_eq!(
            config["hooks"]["SubagentStop"][0]["hooks"][0]["command"],
            "notify-send done"
        );

        remove_session_hooks_config(dir.path()).await.unwrap();

        let content = std::fs::read_to_string(claude_dir.join("settings.local.json")).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();
        // Maestro's entries are gone everywhere…
        assert_eq!(maestro_entries(&config, "PreToolUse"), 0);
        assert!(config["hooks"].get("SessionStart").is_none());
        // …and BOTH user hooks survived the full write + cleanup cycle.
        assert_eq!(
            config["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "my-linter --check"
        );
        assert_eq!(
            config["hooks"]["SubagentStop"][0]["hooks"][0]["command"],
            "notify-send done"
        );
    }

    #[tokio::test]
    async fn test_repeated_writes_are_idempotent_per_event() {
        // Re-launching (new session id, port, instance) must REPLACE
        // Maestro's stale entries, never accumulate duplicates (issue #109).
        let dir = tempdir().unwrap();

        write_session_hooks_config(dir.path(), 1, 9900, "inst-a")
            .await
            .unwrap();
        write_session_hooks_config(dir.path(), 2, 9950, "inst-b")
            .await
            .unwrap();

        let settings_path = dir.path().join(".claude/settings.local.json");
        let content = std::fs::read_to_string(&settings_path).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();
        for event in [
            "SessionStart",
            "SessionEnd",
            "PreToolUse",
            "PostToolUse",
            "Stop",
            "Notification",
            "UserPromptSubmit",
        ] {
            assert_eq!(
                maestro_entries(&config, event),
                1,
                "exactly one Maestro entry for {event} after two writes"
            );
        }
        // The surviving entry is the LATEST write's.
        let command = config["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(
            command.contains("127.0.0.1:9950"),
            "stale entry replaced: {command}"
        );
        assert!(command.contains("X-Maestro-Session: 2"));
    }

    #[tokio::test]
    async fn test_async_flag_on_pre_tool_use() {
        let hooks = build_hooks_config(5, 7777, "instance-123");

        // PreToolUse should have "async": true
        let pre_tool_hook = &hooks["PreToolUse"][0]["hooks"][0];
        assert_eq!(
            pre_tool_hook["async"],
            json!(true),
            "PreToolUse should have async: true"
        );

        // SessionStart should NOT have "async"
        let session_start_hook = &hooks["SessionStart"][0]["hooks"][0];
        assert!(
            session_start_hook.get("async").is_none() || session_start_hook["async"].is_null(),
            "SessionStart should NOT have async flag, got: {:?}",
            session_start_hook.get("async")
        );

        // SessionEnd should NOT have "async"
        let session_end_hook = &hooks["SessionEnd"][0]["hooks"][0];
        assert!(
            session_end_hook.get("async").is_none() || session_end_hook["async"].is_null(),
            "SessionEnd should NOT have async flag"
        );

        // Stop should NOT have "async"
        let stop_hook = &hooks["Stop"][0]["hooks"][0];
        assert!(
            stop_hook.get("async").is_none() || stop_hook["async"].is_null(),
            "Stop should NOT have async flag"
        );

        // Notification and UserPromptSubmit are fire-and-forget: async keeps
        // them from blocking the CLI or injecting stdout into the prompt.
        let notification_hook = &hooks["Notification"][0]["hooks"][0];
        assert_eq!(
            notification_hook["async"],
            json!(true),
            "Notification should have async: true"
        );
        let user_prompt_hook = &hooks["UserPromptSubmit"][0]["hooks"][0];
        assert_eq!(
            user_prompt_hook["async"],
            json!(true),
            "UserPromptSubmit should have async: true"
        );

        // PostToolUse (issue #109) is wired like PreToolUse: fire-and-forget.
        let post_tool_hook = &hooks["PostToolUse"][0]["hooks"][0];
        assert_eq!(
            post_tool_hook["async"],
            json!(true),
            "PostToolUse should have async: true"
        );
    }

    #[tokio::test]
    async fn test_notification_and_user_prompt_hooks_target_their_routes() {
        let hooks = build_hooks_config(9, 9911, "inst-105");

        let notification_cmd = hooks["Notification"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(
            notification_cmd.contains("hook/notification"),
            "Notification should POST to /hook/notification, got: {}",
            notification_cmd
        );

        let user_prompt_cmd = hooks["UserPromptSubmit"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(
            user_prompt_cmd.contains("hook/user-prompt"),
            "UserPromptSubmit should POST to /hook/user-prompt, got: {}",
            user_prompt_cmd
        );

        // Issue #109: PostToolUse closes the digit-shortcut gap.
        let post_tool_cmd = hooks["PostToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(
            post_tool_cmd.contains("hook/post-tool"),
            "PostToolUse should POST to /hook/post-tool, got: {}",
            post_tool_cmd
        );
    }

    #[tokio::test]
    async fn test_remove_handles_missing_file() {
        let dir = tempdir().unwrap();
        // No .claude directory or settings file exists
        let result = remove_session_hooks_config(dir.path()).await;
        assert!(result.is_ok(), "remove should be a no-op for missing file");
    }
}
