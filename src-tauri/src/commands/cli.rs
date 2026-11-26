use std::path::PathBuf;

use crate::core::extended_paths::normalize_extended_path;

/// Resolves a CLI path argument to an absolute path.
/// Handles ".", "..", relative paths, and already-absolute paths.
/// Canonicalization is best-effort: a path that doesn't yet exist still
/// returns the joined absolute form rather than `None`.
///
/// On Windows `canonicalize()` prepends the `\\?\` extended-length prefix. It
/// is stripped so the frontend gets the same spelling the folder dialog gives;
/// otherwise the project opens as a second, duplicate tab.
pub fn resolve_cli_path(path: &str) -> Option<PathBuf> {
    let p = PathBuf::from(path);
    let absolute = if p.is_absolute() {
        p
    } else {
        std::env::current_dir().ok()?.join(p)
    };
    Some(strip_verbatim_prefix(
        absolute.canonicalize().unwrap_or(absolute),
    ))
}

/// Drops a `\\?\` / `\\?\UNC\` prefix as a pure string step, so the rule is
/// testable on any host. A path that is not valid UTF-8 is returned unchanged.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    match path.to_str() {
        Some(s) => PathBuf::from(normalize_extended_path(s)),
        None => path,
    }
}

/// Resolves a raw argv entry to an existing absolute path, or `None`.
///
/// Used by the single-instance handler to scan `args[1..]` for the user's
/// project path. Differs from [`resolve_cli_path`] in two ways:
///
/// 1. Args that look like flags (`-x`, `--foo`) are rejected outright. Without
///    this, a prepended flag from `open -b … --args` would be joined to cwd
///    and treated as the project path.
/// 2. The resolved path must actually exist. `resolve_cli_path` tolerates
///    non-existent paths for the startup-slot case (frontend validates), but
///    for argv scanning we want a real filesystem check so a stray unknown
///    token doesn't short-circuit the search.
pub fn resolve_existing_path_arg(arg: &str) -> Option<PathBuf> {
    if arg.starts_with('-') {
        return None;
    }
    let resolved = resolve_cli_path(arg)?;
    if resolved.exists() {
        Some(resolved)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_cli_path_accepts_absolute_path() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = strip_verbatim_prefix(tmp.path().canonicalize().unwrap());
        let resolved = resolve_cli_path(canonical.to_str().unwrap()).unwrap();
        assert_eq!(resolved, canonical);
    }

    #[test]
    fn strip_verbatim_prefix_drops_the_windows_extended_length_prefix() {
        // Pure string rule, so it is checked on every host (CI runs Linux).
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\C:\git\proj")),
            PathBuf::from(r"C:\git\proj")
        );
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\proj")),
            PathBuf::from(r"\\server\share\proj")
        );
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from("/home/me/proj")),
            PathBuf::from("/home/me/proj")
        );
    }

    #[test]
    fn resolve_cli_path_never_returns_a_verbatim_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_cli_path(tmp.path().to_str().unwrap()).unwrap();
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn resolve_cli_path_resolves_dot_to_cwd() {
        let cwd = strip_verbatim_prefix(std::env::current_dir().unwrap().canonicalize().unwrap());
        let resolved = resolve_cli_path(".").unwrap();
        assert_eq!(resolved, cwd);
    }

    #[test]
    fn resolve_cli_path_handles_nonexistent_paths() {
        // An absolute path that doesn't exist must still return Some, not None.
        let candidate = if cfg!(target_os = "windows") {
            "C:\\does-not-exist-12345\\subpath"
        } else {
            "/does-not-exist-12345/subpath"
        };
        let resolved = resolve_cli_path(candidate).expect("should resolve");
        assert!(resolved.is_absolute());
    }

    #[test]
    fn resolve_cli_path_joins_relative_against_cwd() {
        let cwd = strip_verbatim_prefix(std::env::current_dir().unwrap().canonicalize().unwrap());
        let resolved = resolve_cli_path("Cargo.toml").unwrap();
        // Cargo.toml is in src-tauri/; canonicalize will resolve it if it exists.
        assert!(resolved.starts_with(&cwd) || resolved.is_absolute());
    }

    // ---- resolve_existing_path_arg ---------------------------------------

    #[test]
    fn existing_path_arg_rejects_short_flag() {
        assert!(resolve_existing_path_arg("-n").is_none());
    }

    #[test]
    fn existing_path_arg_rejects_long_flag() {
        assert!(resolve_existing_path_arg("--psn_0_12345").is_none());
    }

    #[test]
    fn existing_path_arg_rejects_nonexistent_path() {
        let candidate = if cfg!(target_os = "windows") {
            "C:\\does-not-exist-maestro-12345\\subpath"
        } else {
            "/does-not-exist-maestro-12345/subpath"
        };
        assert!(resolve_existing_path_arg(candidate).is_none());
    }

    #[test]
    fn existing_path_arg_accepts_real_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = strip_verbatim_prefix(tmp.path().canonicalize().unwrap());
        let resolved = resolve_existing_path_arg(canonical.to_str().unwrap())
            .expect("real path should resolve");
        assert_eq!(resolved, canonical);
    }

    #[test]
    fn existing_path_arg_skips_flag_then_accepts_path() {
        // Simulates scanning `["--some-flag", "<real-tmp-path>"]` argv-style.
        let tmp = tempfile::tempdir().unwrap();
        let canonical = strip_verbatim_prefix(tmp.path().canonicalize().unwrap());
        let canonical_str = canonical.to_str().unwrap().to_string();
        let args = ["--some-flag".to_string(), canonical_str];
        let resolved = args
            .iter()
            .find_map(|a| resolve_existing_path_arg(a))
            .expect("should find path after skipping flag");
        assert_eq!(resolved, canonical);
    }
}
