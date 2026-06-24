//! Recovery for reading JSON config files that Maestro merges into before
//! launching Claude CLI (`.claude/settings.local.json`, `.mcp.json`).
//!
//! Both Maestro and Claude CLI write these files. A crash mid-write, a race
//! between two writers, or a non-atomic external write can leave one as invalid
//! JSON. If we propagated the parse error, every later session launch would
//! abort on that file and it could never be repaired automatically — permanently
//! breaking the project for Maestro. Instead we move the unparseable file aside
//! and start from a fresh object, so the next launch self-heals.

use std::path::Path;

use serde_json::{json, Value};

/// Reads and parses `path` as a JSON value, recovering from corruption.
///
/// - Missing file -> `Ok({})`.
/// - Valid JSON -> `Ok(value)`.
/// - Unreadable (genuine IO error) -> `Err(..)`, surfaced to the caller.
/// - Invalid JSON -> the corrupt file is renamed to `<path>.corrupt` (best
///   effort) and `Ok({})` is returned so the caller writes a clean file.
pub fn read_json_or_recover(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }

    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

    match serde_json::from_str::<Value>(&content) {
        Ok(value) => Ok(value),
        Err(parse_err) => {
            let backup = path.with_extension("corrupt");
            log::warn!(
                "{} is not valid JSON ({}); moving it to {} and starting fresh",
                path.display(),
                parse_err,
                backup.display()
            );
            // Best effort: even if the rename fails we still recover with a
            // fresh config rather than bricking the session launch.
            if let Err(rename_err) = std::fs::rename(path, &backup) {
                log::warn!(
                    "Failed to move corrupt {} aside: {}",
                    path.display(),
                    rename_err
                );
            }
            Ok(json!({}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_file_yields_empty_object() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.local.json");
        let value = read_json_or_recover(&path).unwrap();
        assert_eq!(value, json!({}));
    }

    #[test]
    fn valid_json_is_returned_untouched() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.local.json");
        std::fs::write(&path, r#"{"enabledPlugins": {"a@m": true}}"#).unwrap();

        let value = read_json_or_recover(&path).unwrap();
        assert_eq!(value["enabledPlugins"]["a@m"], true);
        // The original file must be left in place when it parses.
        assert!(path.exists());
        assert!(!dir.path().join("settings.local.corrupt").exists());
    }

    #[test]
    fn corrupt_json_is_moved_aside_and_recovered() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.local.json");
        // The exact failure mode seen in the wild: a short write left the tail
        // of a longer previous write, producing invalid JSON.
        std::fs::write(&path, "{\n  \"enabledPlugins\": {}\n}\": [ leftover").unwrap();

        let value = read_json_or_recover(&path).unwrap();

        // Caller gets a clean slate to write into.
        assert_eq!(value, json!({}));
        // Corrupt content is preserved next to the original for debugging.
        let backup = dir.path().join("settings.local.corrupt");
        assert!(backup.exists(), "corrupt file should be moved to .corrupt");
        assert!(!path.exists(), "corrupt original should be moved away");
        assert!(std::fs::read_to_string(&backup)
            .unwrap()
            .contains("leftover"));
    }
}
