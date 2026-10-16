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
use std::sync::LazyLock;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::config_recovery::read_json_or_recover;
use super::mcp_config_writer::{atomic_write, dir_lock};
use super::plugin_error::{PluginError, PluginResult};

/// For one settings.local.json: each `enabledPlugins` key Maestro has written,
/// with the value it had before Maestro's first write (`None` = absent).
type OriginalEntries = HashMap<String, Option<Value>>;

/// The ownership record: settings.local.json path -> [`OriginalEntries`].
type OwnershipRecord = HashMap<String, OriginalEntries>;

/// File name of the ownership record in Maestro's app data dir.
const RECORD_FILE_NAME: &str = "plugin-config-ownership.json";

/// Serializes every read-modify-write of the ownership record in this process.
/// Always taken AFTER the per-directory lock, so the order never inverts.
static RECORD_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Where the ownership record lives: Maestro's app data dir (the same base as
/// the managed worktrees), falling back to the temp dir.
///
/// Claude Code's own `/plugin` local scope stores the user's plugins in the
/// same `enabledPlugins` map Maestro writes, so Maestro must know exactly which
/// keys it set and what they held before (same goal as the hook writer's
/// merge-only fix, issue #109). The record is on disk, not only in memory, so
/// a quit with terminals open or a crash does not make Maestro's leftover
/// entries look like the user's own on the next run: the next close in that
/// folder still restores them.
fn record_path() -> PathBuf {
    directories::ProjectDirs::from("com", "maestro", "maestro")
        .map(|p| p.data_dir().to_path_buf())
        .unwrap_or_else(std::env::temp_dir)
        .join(RECORD_FILE_NAME)
}

/// Reads the ownership record. Missing -> empty; a corrupt file is moved aside
/// and treated as empty (same self-heal as the settings files).
fn load_record(path: &Path) -> PluginResult<OwnershipRecord> {
    let value = read_json_or_recover(path)?;
    Ok(serde_json::from_value(value).unwrap_or_else(|e| {
        log::warn!(
            "plugin ownership record {path:?} has an unexpected shape ({e}); starting fresh"
        );
        OwnershipRecord::new()
    }))
}

/// Writes the ownership record atomically; an empty record deletes the file.
async fn save_record(path: &Path, record: &OwnershipRecord) -> PluginResult<()> {
    if record.is_empty() {
        return match tokio::fs::remove_file(path).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(PluginError::Shared(
                format!("Failed to delete {path:?}: {e}"),
            )),
            _ => Ok(()),
        };
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(PluginError::CreateDir)?;
    }
    let content =
        serde_json::to_string_pretty(record).map_err(|source| PluginError::Serialize {
            what: "plugin ownership record",
            source,
        })?;
    atomic_write(path, &content).await?;
    Ok(())
}

/// Merges Maestro's `enabledPlugins` keys into an existing settings.local.json.
///
/// Preserves user-defined settings and the user's own `enabledPlugins`
/// entries: only Maestro's keys are set, and each key's prior value is added to
/// `originals` (first value only) for close to restore. Also removes the legacy
/// `plugins` array if present.
fn merge_with_existing(
    settings_path: &Path,
    enabled_plugins: &HashMap<String, bool>,
    originals: &mut OriginalEntries,
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
/// 2. Merges Maestro's keys into `enabledPlugins` (preserving other settings
///    and the user's own entries)
/// 3. Saves the ownership record first, then writes the final config, so a
///    crash in between never leaves Maestro's values unrecorded
///
/// # Arguments
///
/// * `working_dir` - Directory where `.claude/settings.local.json` will be written
/// * `enabled_plugins` - Map of CLI plugin IDs to enabled state (e.g. "name@marketplace" -> true/false)
pub async fn write_session_plugin_config(
    working_dir: &Path,
    enabled_plugins: &HashMap<String, bool>,
) -> PluginResult<()> {
    write_session_plugin_config_at(working_dir, enabled_plugins, &record_path()).await
}

/// [`write_session_plugin_config`] with an explicit ownership record file.
async fn write_session_plugin_config_at(
    working_dir: &Path,
    enabled_plugins: &HashMap<String, bool>,
    record_file: &Path,
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
    let _record_guard = RECORD_LOCK.lock().await;

    // Merge with existing settings, recording what Maestro's keys held before
    let settings_path = claude_dir.join("settings.local.json");
    let record_key = settings_path.to_string_lossy().into_owned();
    let mut record = load_record(record_file)?;
    let originals = record.entry(record_key).or_default();
    let final_config = merge_with_existing(&settings_path, enabled_plugins, originals)?;
    // Keep the record bounded: no entry for a folder Maestro owns nothing in.
    record.retain(|_, keys| !keys.is_empty());
    save_record(record_file, &record).await?;

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
/// Restores only the `enabledPlugins` keys the ownership record says Maestro
/// wrote (also after an app restart) to their earlier values, and drops
/// `enabledPlugins` only once it is empty. Also removes the legacy `plugins`
/// array. Preserves other settings in the file. Deletes the file if it becomes
/// empty. The folder's record entry is dropped once restored.
///
/// # Arguments
///
/// * `working_dir` - Directory containing the `.claude/settings.local.json` file
pub async fn remove_session_plugin_config(working_dir: &Path) -> PluginResult<()> {
    remove_session_plugin_config_at(working_dir, &record_path()).await
}

/// [`remove_session_plugin_config`] with an explicit ownership record file.
async fn remove_session_plugin_config_at(
    working_dir: &Path,
    record_file: &Path,
) -> PluginResult<()> {
    let claude_dir = working_dir.join(".claude");
    let settings_path = claude_dir.join("settings.local.json");
    let record_key = settings_path.to_string_lossy().into_owned();

    // Serialize against the hooks writer (see write_session_plugin_config).
    let lock = dir_lock(&claude_dir);
    let _guard = lock.lock().await;
    let _record_guard = RECORD_LOCK.lock().await;

    let mut record = load_record(record_file)?;
    let originals = record.remove(&record_key);
    let had_record = originals.is_some();

    if !settings_path.exists() {
        // Nothing to restore into; drop the folder's entry so it cannot go stale.
        if had_record {
            save_record(record_file, &record).await?;
        }
        return Ok(());
    }

    let content = tokio::fs::read_to_string(&settings_path)
        .await
        .map_err(PluginError::ReadSettings)?;

    let mut config: Value = serde_json::from_str(&content).map_err(PluginError::ParseSettings)?;

    // Restore Maestro's enabledPlugins keys and remove the legacy plugins array
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

    // Only after the settings file is restored: a failed write above keeps the
    // entry, so a later close can still undo Maestro's keys.
    if had_record {
        save_record(record_file, &record).await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::{tempdir, TempDir};

    /// A per-test ownership record, so tests never touch the real app data dir.
    fn record_file(dir: &TempDir) -> PathBuf {
        dir.path().join("ownership-record.json")
    }

    #[tokio::test]
    async fn test_write_session_plugin_config_creates_directory_and_file() {
        let dir = tempdir().unwrap();
        let mut plugins = HashMap::new();
        plugins.insert("plugin-a@official".to_string(), true);
        plugins.insert("plugin-b@official".to_string(), false);

        let result = write_session_plugin_config_at(dir.path(), &plugins, &record_file(&dir)).await;
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
        write_session_plugin_config_at(dir.path(), &plugins, &record_file(&dir))
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
        write_session_plugin_config_at(dir.path(), &plugins, &record_file(&dir))
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
        write_session_plugin_config_at(dir.path(), &plugins, &record_file(&dir))
            .await
            .unwrap();

        remove_session_plugin_config_at(dir.path(), &record_file(&dir))
            .await
            .unwrap();

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
        write_session_plugin_config_at(dir.path(), &plugins, &record_file(&dir))
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

        remove_session_plugin_config_at(dir.path(), &record_file(&dir))
            .await
            .unwrap();

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
        write_session_plugin_config_at(dir.path(), &plugins, &record_file(&dir))
            .await
            .unwrap();

        remove_session_plugin_config_at(dir.path(), &record_file(&dir))
            .await
            .unwrap();

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
        write_session_plugin_config_at(dir.path(), &plugins, &record_file(&dir))
            .await
            .unwrap();
        // A second launch in the same directory must not record Maestro's
        // own value as the user's original.
        write_session_plugin_config_at(dir.path(), &plugins, &record_file(&dir))
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

        remove_session_plugin_config_at(dir.path(), &record_file(&dir))
            .await
            .unwrap();

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

        remove_session_plugin_config_at(dir.path(), &record_file(&dir))
            .await
            .unwrap();

        let content = std::fs::read_to_string(claude_dir.join("settings.local.json")).unwrap();
        let config: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(config, existing);
    }

    #[tokio::test]
    async fn test_restart_keeps_ownership_so_close_removes_maestro_leftovers() {
        let dir = tempdir().unwrap();
        let claude_dir = dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();
        let settings = claude_dir.join("settings.local.json");
        let user_only = json!({ "enabledPlugins": { "user@market": true } });
        std::fs::write(&settings, serde_json::to_string(&user_only).unwrap()).unwrap();

        // Launch, then the app quits or crashes with the terminal open: no close.
        let plugins = HashMap::from([
            ("user@market".to_string(), false),
            ("unselected@market".to_string(), false),
        ]);
        write_session_plugin_config_at(dir.path(), &plugins, &record_file(&dir))
            .await
            .unwrap();

        // The record is on disk (there is no in-memory copy to lose)...
        let record: OwnershipRecord =
            serde_json::from_str(&std::fs::read_to_string(record_file(&dir)).unwrap()).unwrap();
        let key = settings.to_string_lossy().into_owned();
        assert_eq!(record[&key]["user@market"], Some(json!(true)));
        assert_eq!(record[&key]["unselected@market"], None);

        // ...so after the restart a new launch does not take Maestro's
        // leftovers for the user's values, and its close removes them.
        write_session_plugin_config_at(dir.path(), &plugins, &record_file(&dir))
            .await
            .unwrap();
        remove_session_plugin_config_at(dir.path(), &record_file(&dir))
            .await
            .unwrap();

        let after: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(after, user_only);
        // Nothing Maestro-owned remains, so the record file is gone (bounded).
        assert!(!record_file(&dir).exists());
    }

    #[tokio::test]
    async fn test_record_drops_only_the_closed_folder() {
        let dir = tempdir().unwrap();
        let repo_a = dir.path().join("a");
        let repo_b = dir.path().join("b");
        let record = record_file(&dir);
        let plugins = HashMap::from([("p@market".to_string(), true)]);
        write_session_plugin_config_at(&repo_a, &plugins, &record)
            .await
            .unwrap();
        write_session_plugin_config_at(&repo_b, &plugins, &record)
            .await
            .unwrap();

        remove_session_plugin_config_at(&repo_a, &record)
            .await
            .unwrap();

        let left: OwnershipRecord =
            serde_json::from_str(&std::fs::read_to_string(&record).unwrap()).unwrap();
        assert_eq!(left.len(), 1);
        let b_key = repo_b
            .join(".claude")
            .join("settings.local.json")
            .to_string_lossy()
            .into_owned();
        assert!(left.contains_key(&b_key));
        assert!(!repo_a.join(".claude/settings.local.json").exists());
    }

    #[tokio::test]
    async fn test_remove_handles_missing_file() {
        let dir = tempdir().unwrap();
        // No .claude directory or settings file exists
        let result = remove_session_plugin_config_at(dir.path(), &record_file(&dir)).await;
        assert!(result.is_ok());
    }
}
