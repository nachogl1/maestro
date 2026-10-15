//! PATH augmentation for CLI subprocesses spawned from the GUI.
//!
//! macOS apps launched from Finder/Dock/Spotlight inherit a minimal PATH from
//! launchd (typically `/usr/bin:/bin:/usr/sbin:/sbin`), which does not include
//! Homebrew, user installs, or most language toolchains. This causes
//! `Command::new("gh")` (and similar) to fail with `ErrorKind::NotFound` even
//! when the binary is installed. Linux has the same symptom when a DE launcher
//! runs with a restricted PATH.
//!
//! `augmented_path()` returns a PATH string combining the inherited PATH with
//! the common install directories, so subprocesses can find their executables.
//!
//! Windows has its own version of the problem: when the MSI updater relaunches
//! Maestro at the end of an install, the new process inherits the installer's
//! environment, whose PATH lacks the per-user entries (`%USERPROFILE%\.local\bin`
//! is where the native `claude` installer puts `claude.exe`). `where.exe claude`
//! then fails, the launch flow decides the CLI is "not installed" and a new
//! terminal opens on a bare shell — and `claude -p` runs fail with "program not
//! found". [`adopt_user_path`] repairs the process PATH from the registry once
//! at startup so every child (PTY shells, `where.exe`, `claude`, `git`, `gh`)
//! inherits the PATH a normally launched app would have had.

use std::sync::OnceLock;

/// Returns a PATH value that merges the process's inherited PATH with common
/// install directories missed by macOS/Linux GUI launchers.
///
/// The result is cached for the lifetime of the process.
#[cfg(unix)]
pub fn augmented_path() -> &'static str {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED.get_or_init(build_augmented_path)
}

#[cfg(unix)]
fn build_augmented_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<String> = if inherited.is_empty() {
        Vec::new()
    } else {
        inherited.split(':').map(String::from).collect()
    };

    let mut extras: Vec<String> = vec![
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/local/sbin".to_string(),
    ];

    if let Ok(home) = std::env::var("HOME") {
        extras.push(format!("{home}/.npm-global/bin"));
        extras.push(format!("{home}/node_modules/.bin"));
        extras.push(format!("{home}/.cargo/bin"));
        extras.push(format!("{home}/go/bin"));
        extras.push(format!("{home}/.local/bin"));
        extras.push(format!("{home}/.pyenv/shims"));
        extras.push(format!("{home}/.rbenv/shims"));
    }

    for dir in extras {
        if !parts.iter().any(|p| p == &dir) {
            parts.push(dir);
        }
    }

    parts.join(":")
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;

    #[test]
    fn augmented_path_includes_common_dirs() {
        let path = augmented_path();
        assert!(path.contains("/opt/homebrew/bin"));
        assert!(path.contains("/usr/local/bin"));
    }

    #[test]
    fn augmented_path_preserves_inherited_entries() {
        let inherited = std::env::var("PATH").unwrap_or_default();
        let path = augmented_path();
        for entry in inherited.split(':').filter(|s| !s.is_empty()) {
            assert!(
                path.split(':').any(|p| p == entry),
                "expected inherited entry {entry:?} in augmented PATH"
            );
        }
    }
}

/// Separator between PATH entries on Windows.
#[cfg(windows)]
const PATH_SEP: char = ';';

/// Returns a PATH value that merges the process's inherited PATH with the
/// user and machine PATH values stored in the registry, plus the install
/// directories the `claude` installers use. Cached for the process lifetime.
#[cfg(windows)]
pub fn augmented_path() -> &'static str {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED.get_or_init(|| {
        let inherited = std::env::var("PATH").unwrap_or_default();
        merge_path_entries(&inherited, registry_and_known_dirs())
    })
}

/// Number of PATH entries [`adopt_user_path`] added, for the startup log.
#[cfg(windows)]
static ADOPTED_ENTRIES: OnceLock<usize> = OnceLock::new();

/// Repairs this process's own PATH from the registry (see the module docs).
/// Call once, before any thread or child process exists; `Command`s and
/// PTY shells spawned afterwards inherit the repaired value. Returns how
/// many entries were missing from the inherited PATH.
#[cfg(windows)]
pub fn adopt_user_path() -> usize {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let merged = augmented_path();
    let before = inherited
        .split(PATH_SEP)
        .filter(|s| !s.trim().is_empty())
        .count();
    let after = merged.split(PATH_SEP).filter(|s| !s.is_empty()).count();
    let added = after.saturating_sub(before);
    if added > 0 {
        std::env::set_var("PATH", merged);
    }
    let _ = ADOPTED_ENTRIES.set(added);
    added
}

/// Logs what [`adopt_user_path`] did. Separate from it because the file
/// logger is only attached once the Tauri setup hook runs.
#[cfg(windows)]
pub fn log_adopted_path() {
    match ADOPTED_ENTRIES.get().copied() {
        Some(0) => log::info!("PATH already carried the user/machine entries"),
        Some(n) => log::warn!(
            "PATH was missing {n} user/machine entries (stripped launch environment) — restored from the registry"
        ),
        None => log::warn!("PATH repair did not run"),
    }
}

/// The user PATH, the machine PATH (both from the registry, `%VAR%` tokens
/// expanded) and the known CLI install dirs, in that order.
#[cfg(windows)]
fn registry_and_known_dirs() -> Vec<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let mut dirs = Vec::new();
    let user = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Environment")
        .and_then(|k| k.get_value::<String, _>("Path"));
    let machine = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")
        .and_then(|k| k.get_value::<String, _>("Path"));
    for value in [user, machine].into_iter().flatten() {
        dirs.extend(
            value
                .split(PATH_SEP)
                .filter(|s| !s.trim().is_empty())
                .map(expand_env_tokens),
        );
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        dirs.push(format!("{profile}\\.local\\bin"));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(format!("{appdata}\\npm"));
    }
    dirs
}

/// Expands `%NAME%` tokens from the process environment, leaving unknown
/// names as they are (registry PATH values are `REG_EXPAND_SZ`).
#[cfg(windows)]
fn expand_env_tokens(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// `inherited` first, then every entry of `extras` not already present
/// (compared case-insensitively, ignoring a trailing backslash), joined
/// with `;`. Empty entries are dropped.
#[cfg(windows)]
pub fn merge_path_entries(inherited: &str, extras: impl IntoIterator<Item = String>) -> String {
    fn key(entry: &str) -> String {
        entry.trim().trim_end_matches('\\').to_ascii_lowercase()
    }
    let candidates = inherited.split(PATH_SEP).map(String::from).chain(extras);
    let mut parts: Vec<String> = Vec::new();
    for entry in candidates {
        let entry = entry.trim();
        if entry.is_empty() || parts.iter().any(|p| key(p) == key(entry)) {
            continue;
        }
        parts.push(entry.to_string());
    }
    parts.join(";")
}

#[cfg(test)]
#[cfg(windows)]
mod windows_tests {
    use super::*;

    #[test]
    fn merge_appends_missing_entries_and_dedupes_case_insensitively() {
        let merged = merge_path_entries(
            r"C:\Windows\system32;C:\Windows",
            vec![
                r"c:\windows\".to_string(),
                r"C:\Users\me\.local\bin".to_string(),
                "".to_string(),
                r"C:\Users\me\.local\bin".to_string(),
            ],
        );
        assert_eq!(
            merged,
            r"C:\Windows\system32;C:\Windows;C:\Users\me\.local\bin"
        );
    }

    #[test]
    fn expand_env_tokens_replaces_known_names_only() {
        std::env::set_var("MAESTRO_CLI_PATH_TEST", r"C:\t");
        assert_eq!(
            expand_env_tokens(r"%MAESTRO_CLI_PATH_TEST%\bin"),
            r"C:\t\bin"
        );
        assert_eq!(
            expand_env_tokens(r"%NO_SUCH_VAR_X%\bin"),
            r"%NO_SUCH_VAR_X%\bin"
        );
        assert_eq!(expand_env_tokens("100%"), "100%");
    }

    #[test]
    fn augmented_path_contains_the_local_bin_dir() {
        let profile = std::env::var("USERPROFILE").unwrap();
        let wanted = format!("{profile}\\.local\\bin").to_ascii_lowercase();
        assert!(augmented_path()
            .split(';')
            .any(|p| p.trim_end_matches('\\').to_ascii_lowercase() == wanted));
    }
}
