//! Writes session-specific plugin configuration for Claude CLI.
//!
//! This module handles writing `enabledPlugins` to the session's
//! `.claude/settings.local.json` file so Claude CLI knows which plugins
//! to enable or disable. The format matches Claude CLI's native format:
//! ```json
//! {
//!   "enabledPlugins": {
//!     "plugin-name@marketplace": true,
//!     "other-plugin@marketplace": false
//!   }
//! }
//! ```

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde_json::{json, Value};

use super::config_recovery::read_json_or_recover;
use super::mcp_config_writer::{atomic_write, dir_lock};
use super::plugin_error::{PluginError, PluginResult};

/// The original value of one `enabledPlugins` key before Maestro first wrote it
/// (`None` = the key was absent).
type OriginalEntries = HashMap<String, Option<Value>>;

/// Per settings.local.json: every `enabledPlugins` key Maestro has written, with
/// the value it had before Maestro's first write. Claude Code's own `/plugin`
/// local scope stores the user's entries in the same map, so close restores
/// exactly these keys and leaves every other entry alone (same goal as the hook
/// writer's merge-only fix, issue #109). Kept in memory only: after an app
/// restart there is no record, and close leaves `enabledPlugins` untouched
/// rather than guess which keys are Maestro's.
static WRITTEN_KEYS: LazyLock<Mutex<HashMap<PathBuf, OriginalEntries>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Merges `enabledPlugins` into an existing settings.local.json file.
///
/// Preserves user-defined settings and the user's own `enabledPlugins`
/// entries: only Maestro's keys are set, and their prior values are recorded
/// in [`WRITTEN_KEYS`] for close to restore. Also removes the legacy `plugins`
/// array if present.
fn merge_with_existing(
    settings_path: &Path,
    enabled_plugins: &HashMap<String, bool>,
) -> PluginResult<Value> {
    // A corrupt settings.local.json (e.g. from a crashed/interleaved write) is
    // moved aside and treated as empty so the launch self-heals instead of
    // erroring on every future session.
    let mut config: Value = read_json_or_recover(settings_path)?;

    // Valid JSON that isn't an object (a bare string or array) would make the
    // index-assignment below panic — self-heal it to an object too.
    if !config.is_object() {
        log::warn!("settings.local.json is not a JSON object, rebuilding it");
        config = json!({});
    }

    // Remove legacy plugins array if present
    if let Some(obj) = config.as_object_mut() {
        obj.remove("plugins");
    }

    // Merge Maestro's keys into the existing enabledPlugins object — never
    // replace the whole map (that dropped the user's local-scope plugins).
    if !config["enabledPlugins"].is_object() {
        config["enabledPlugins"] = json!({});
    }
    let Some(plugins_obj) = config["enabledPlugins"].as_object_mut() else {
        unreachable!("just made it an object");
    };
    let mut written = WRITTEN_KEYS.lock().unwrap_or_else(|e| e.into_inner());
    let originals = written.entry(settings_path.to_path_buf()).or_default();
    for (id, enabled) in enabled_plugins {
        // Record only the first value seen: a later launch in the same
        // directory must not mistake Maestro's own earlier value for the user's.
        originals
            .entry(id.clone())
            .or_insert_with(|| plugins_obj.get(id).cloned());
        plugins_obj.insert(id.clone(), json!(*enabled));
    }

    Ok(config)
}

/// Writes plugin enabled/disabled state to the session's .claude/settings.local.json.
///
/// This function:
/// 1. Creates the .claude directory if it doesn't exist
/// 2. Builds the `enabledPlugins` object from the provided map
/// 3. Merges with any existing settings.local.json (preserving other settings)
/// 4. Writes the final config
///
/// # Arguments
///
/// * `working_dir` - Directory where `.claude/settings.local.json` will be written
/// * `enabled_plugins` - Map of CLI plugin IDs to enabled state (e.g. "name@marketplace" -> true/false)
pub async fn write_session_plugin_config(
    working_dir: &Path,
    enabled_plugins: &HashMap<String, bool>,
) -> PluginResult<()> {
    // Create .claude directory if needed
    let claude_dir = working_dir.join(".claude");
    if !claude_dir.exists() {
        tokio::fs::create_dir_all(&claude_dir)
            .await
            .map_err(PluginError::CreateDir)?;
    }

    // Serialize against the hooks writer: both read-modify-write the same
    // settings.local.json, and unsynchronized tasks either resurrect each
    // other's removed keys or interleave truncating writes into corrupt JSON.
    let lock = dir_lock(&claude_dir);
    let _guard = lock.lock().await;

    // Merge with existing settings
    let settings_path = claude_dir.join("settings.local.json");
    let final_config = merge_with_existing(&settings_path, enabled_plugins)?;

    // Write the file atomically (temp file + rename)
    let content =
        serde_json::to_string_pretty(&final_config).map_err(|source| PluginError::Serialize {
            what: "plugin config",
            source,
        })?;

    atomic_write(&settings_path, &content).await?;

    let enabled_count = enabled_plugins.values().filter(|v| **v).count();
    let disabled_count = enabled_plugins.len() - enabled_count;
    log::debug!(
        "Wrote session plugin config to {:?} ({} enabled, {} disabled)",
        settings_path,
        enabled_count,
        disabled_count,
    );

    Ok(())
}

/// Removes session plugin config from the session's .claude/settings.local.json.
///
/// Restores only the `enabledPlugins` keys Maestro wrote (see [`WRITTEN_KEYS`])
/// to their earlier values, and drops `enabledPlugins` only once it is empty.
/// Also removes the legacy `plugins` array. Preserves other settings in the
/// file. Deletes the file if it becomes empty.
///
/// # Arguments
///
/// * `working_dir` - Directory containing the `.claude/settings.local.json` file
pub async fn remove_session_plugin_config(working_dir: &Path) -> PluginResult<()> {
    let claude_dir = working_dir.join(".claude");
    let settings_path = claude_dir.join("settings.local.json");
    if !settings_path.exists() {
        // Nothing to restore into; drop the record so it cannot go stale.
        WRITTEN_KEYS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&settings_path);
        return Ok(());
    }

    // Serialize against the hooks writer (see write_session_plugin_config).
    let lock = dir_lock(&claude_dir);
    let _guard = lock.lock().await;

    let content = tokio::fs::read_to_string(&settings_path)
        .await
        .map_err(PluginError::ReadSettings)?;

    let mut config: Value = serde_json::from_str(&content).map_err(PluginError::ParseSettings)?;

    // Restore Maestro's enabledPlugins keys and remove the legacy plugins array
    let originals = WRITTEN_KEYS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&settings_path);
    if let Some(obj) = config.as_object_mut() {
        let mut restored_enabled = false;
        if let (Some(originals), Some(plugins)) = (
            originals,
            obj.get_mut("enabledPlugins").and_then(Value::as_object_mut),
        ) {
            for (id, original) in originals {
                match original {
                    Some(value) => plugins.insert(id, value),
                    None => plugins.remove(&id),
                };
            }
            restored_enabled = true;
            if plugins.is_empty() {
                obj.remove("enabledPlugins");
            }
        }
        let removed_legacy = obj.remove("plugins").is_some();
        if restored_enabled || removed_legacy {
            log::debug!("Removed plugin config from {:?}", settings_path);
        }
    }

    // If the config is now empty, delete the file
    if config.as_object().map(|o| o.is_empty()).unwrap_or(false) {
        tokio::fs::remove_file(&settings_path)
            .await
            .map_err(PluginError::DeleteSettings)?;
        log::debug!("Deleted empty settings.local.json at {:?}", settings_path);
    } else {
        // Otherwise, write the updated config atomically
        let output =
            serde_json::to_string_pretty(&config).map_err(|source| PluginError::Serialize {
                what: "config",
                source,
            })?;

        atomic_write(&settings_path, &output).await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_write_session_plugin_config_creates_directory_and_file() {
        let dir = tempdir().unwrap();
        let mut plugins = HashMap::new();
        plugins.insert("plugin-a@official".to_string(), true);
        plugins.insert("plugin-b@official".to_string(), false);

        let result = write_session_plugin_config(dir.path(), &plugins).await;
        assert!(result.is_ok());

        let settings_path = dir.path().join(".claude/settings.local.json");
        assert!(settings_path.exists());

        let content = std::fs::read_to_string(&settings_path).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();

        let enabled_plugins = config["enabledPlugins"].as_object().unwrap();
        assert_eq!(enabled_plugins.len(), 2);
        assert_eq!(enabled_plugins["plugin-a@official"], true);
        assert_eq!(enabled_plugins["plugin-b@official"], false);
    }

    #[tokio::test]
    async fn test_write_preserves_other_settings_and_removes_legacy() {
        let dir = tempdir().unwrap();
        let claude_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();

        // Write existing settings with legacy plugins array
        let existing = json!({
            "someOtherSetting": "value",
            "plugins": [
                {"path": "/old/plugin", "enabled": false}
            ]
        });
        std::fs::write(
            claude_dir.join("settings.local.json"),
            serde_json::to_string(&existing).unwrap(),
        )
        .unwrap();

        // Write new enabledPlugins
        let mut plugins = HashMap::new();
        plugins.insert("new-plugin@official".to_string(), true);
        write_session_plugin_config(dir.path(), &plugins)
            .await
            .unwrap();

        let content = std::fs::read_to_string(claude_dir.join("settings.local.json")).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();

        // Other settings should be preserved
        assert_eq!(config["someOtherSetting"], "value");

        // Legacy plugins array should be removed
        assert!(config.get("plugins").is_none());

        // enabledPlugins should be set
        let enabled_plugins = config["enabledPlugins"].as_object().unwrap();
        assert_eq!(enabled_plugins.len(), 1);
        assert_eq!(enabled_plugins["new-plugin@official"], true);
    }

    #[tokio::test]
    async fn test_write_recovers_from_corrupt_settings() {
        let dir = tempdir().unwrap();
        let claude_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();

        // Invalid JSON (the in-the-wild failure: short write left a stale tail).
        std::fs::write(
            claude_dir.join("settings.local.json"),
            "{\n  \"enabledPlugins\": {}\n}\": [ leftover hooks tail",
        )
        .unwrap();

        let mut plugins = HashMap::new();
        plugins.insert("recovered@official".to_string(), true);
        // Must NOT error on corrupt input — it should self-heal.
        write_session_plugin_config(dir.path(), &plugins)
            .await
            .unwrap();

        let content = std::fs::read_to_string(claude_dir.join("settings.local.json")).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(config["enabledPlugins"]["recovered@official"], true);
        // Corrupt original is preserved alongside for debugging.
        assert!(claude_dir.join("settings.local.corrupt").exists());
    }

    #[tokio::test]
    async fn test_remove_session_plugin_config() {
        let dir = tempdir().unwrap();
        let claude_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();

        // Existing settings, then a Maestro launch writes its plugin key
        let existing = json!({ "someOtherSetting": "value" });
        std::fs::write(
            claude_dir.join("settings.local.json"),
            serde_json::to_string(&existing).unwrap(),
        )
        .unwrap();
        let plugins = HashMap::from([("test-plugin@official".to_string(), true)]);
        write_session_plugin_config(dir.path(), &plugins)
            .await
            .unwrap();

        remove_session_plugin_config(dir.path()).await.unwrap();

        let content = std::fs::read_to_string(claude_dir.join("settings.local.json")).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();

        // enabledPlugins held only Maestro's key, so it is pruned
        assert!(config.get("enabledPlugins").is_none());
        // Other settings should be preserved
        assert_eq!(config["someOtherSetting"], "value");
    }

    #[tokio::test]
    async fn test_remove_cleans_up_legacy_plugins_too() {
        let dir = tempdir().unwrap();
        let claude_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();

        // Maestro launch writes its key, then a legacy plugins array reappears
        let plugins = HashMap::from([("test@official".to_string(), true)]);
        write_session_plugin_config(dir.path(), &plugins)
            .await
            .unwrap();
        let existing = json!({
            "someOtherSetting": "value",
            "enabledPlugins": { "test@official": true },
            "plugins": [{"path": "/old", "enabled": true}]
        });
        std::fs::write(
            claude_dir.join("settings.local.json"),
            serde_json::to_string(&existing).unwrap(),
        )
        .unwrap();

        remove_session_plugin_config(dir.path()).await.unwrap();

        let content = std::fs::read_to_string(claude_dir.join("settings.local.json")).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();

        assert!(config.get("enabledPlugins").is_none());
        assert!(config.get("plugins").is_none());
        assert_eq!(config["someOtherSetting"], "value");
    }

    #[tokio::test]
    async fn test_remove_deletes_empty_file() {
        let dir = tempdir().unwrap();
        let claude_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();

        // A Maestro launch writes a file holding only its own plugin key
        let plugins = HashMap::from([("test-plugin@official".to_string(), true)]);
        write_session_plugin_config(dir.path(), &plugins)
            .await
            .unwrap();

        remove_session_plugin_config(dir.path()).await.unwrap();

        // File should be deleted since it would be empty
        assert!(!claude_dir.join("settings.local.json").exists());
    }

    #[tokio::test]
    async fn test_user_plugin_entries_survive_launch_and_close() {
        let dir = tempdir().unwrap();
        let claude_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();

        // The user's own local-scope entries (written by Claude's /plugin),
        // one of which Maestro also manages for its session.
        let existing = json!({
            "enabledPlugins": {
                "user-only@market": true,
                "shared@market": true
            }
        });
        std::fs::write(
            claude_dir.join("settings.local.json"),
            serde_json::to_string(&existing).unwrap(),
        )
        .unwrap();

        let plugins = HashMap::from([
            ("shared@market".to_string(), false),
            ("maestro-only@market".to_string(), true),
        ]);
        write_session_plugin_config(dir.path(), &plugins)
            .await
            .unwrap();
        // A second launch in the same directory must not record Maestro's
        // own value as the user's original.
        write_session_plugin_config(dir.path(), &plugins)
            .await
            .unwrap();

        let read = || -> Value {
            serde_json::from_str(
                &std::fs::read_to_string(claude_dir.join("settings.local.json")).unwrap(),
            )
            .unwrap()
        };
        let during = read();
        assert_eq!(during["enabledPlugins"]["user-only@market"], true);
        assert_eq!(during["enabledPlugins"]["shared@market"], false);
        assert_eq!(during["enabledPlugins"]["maestro-only@market"], true);

        remove_session_plugin_config(dir.path()).await.unwrap();

        // Exactly the user's entries are back; Maestro's own key is gone.
        assert_eq!(read(), existing);
    }

    #[tokio::test]
    async fn test_remove_without_maestro_write_leaves_enabled_plugins() {
        let dir = tempdir().unwrap();
        let claude_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();

        let existing = json!({ "enabledPlugins": { "user@market": true } });
        std::fs::write(
            claude_dir.join("settings.local.json"),
            serde_json::to_string(&existing).unwrap(),
        )
        .unwrap();

        remove_session_plugin_config(dir.path()).await.unwrap();

        let content = std::fs::read_to_string(claude_dir.join("settings.local.json")).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(config, existing);
    }

    #[tokio::test]
    async fn test_remove_handles_missing_file() {
        let dir = tempdir().unwrap();
        // No .claude directory or settings file exists
        let result = remove_session_plugin_config(dir.path()).await;
        assert!(result.is_ok());
    }
}
