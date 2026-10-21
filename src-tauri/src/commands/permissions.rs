//! IPC command for the macOS Full Disk Access check.
//!
//! The `tauri-plugin-macos-permissions` check reads another app's container
//! (`~/Library/Containers/com.apple.stocks`). Since macOS 14 that read makes
//! macOS ask "Maestro would like to access data from other apps", a
//! permission Maestro never needs. This check probes a file only Full Disk
//! Access unlocks, and macOS denies it silently instead of prompting.

use std::path::Path;

/// The user's TCC database, relative to the home directory. Only an app
/// with Full Disk Access can open it, and macOS never offers a prompt for it.
#[cfg(target_os = "macos")]
const TCC_DB: &str = "Library/Application Support/com.apple.TCC/TCC.db";

/// Whether `path` can be opened for reading.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn can_open(path: &Path) -> bool {
    std::fs::File::open(path).is_ok()
}

/// Whether Maestro has Full Disk Access. Always `true` off macOS.
#[tauri::command]
pub async fn check_full_disk_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        directories::BaseDirs::new()
            .map(|dirs| can_open(&dirs.home_dir().join(TCC_DB)))
            .unwrap_or(false)
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn can_open_reads_an_existing_file_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("probe");
        std::fs::write(&file, b"x").unwrap();
        assert!(can_open(&file));
        assert!(!can_open(&dir.path().join("missing")));
    }
}
