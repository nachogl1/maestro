//! The single `<sanitized-basename>-<hash12>` key that names a project's
//! on-disk Samurai artifacts: the audit log file (`samurai_audit`) and the
//! per-project run-config directory (`samurai_run_config`).
//!
//! These names already exist on users' disks, so the output must never
//! change: the tests below pin exact strings. Any change here orphans
//! existing audit logs and run configs.

use std::path::Path;

use super::status_server::StatusServer;

/// `<sanitized-basename>-<hash12>` for a project path.
///
/// - basename: the path's last component, lowercased; `project` when the path
///   has none (e.g. `/`).
/// - sanitized: every char that is not ASCII alphanumeric, `-` or `_` becomes
///   `-`.
/// - hash12: `StatusServer::generate_project_hash` of the path exactly as
///   given (callers normalize first), so same-named projects in different
///   locations get different keys.
pub(crate) fn project_key(project: &str) -> String {
    let name = Path::new(project)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "project".to_string());
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let hash = StatusServer::generate_project_hash(project);
    format!("{}-{}", sanitized, hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_key_for_a_name_with_spaces_and_capitals() {
        assert_eq!(
            project_key("/Users/test/My Project"),
            "my-project-049925235b59"
        );
    }

    #[test]
    fn pins_key_for_a_windows_style_path() {
        // Only meaningful on Windows, where `\` separates components; on other
        // hosts the whole string is one component, so pin per host.
        let expected = if cfg!(windows) {
            "maestro-af8aa5a9036d"
        } else {
            "c--git-maestro-af8aa5a9036d"
        };
        assert_eq!(project_key(r"C:\git\maestro"), expected);
    }

    #[test]
    fn falls_back_to_project_when_there_is_no_basename() {
        assert_eq!(project_key("/"), "project-8a5edab28263");
    }

    #[test]
    fn same_name_in_different_locations_gets_different_keys() {
        assert_ne!(project_key("/a/app"), project_key("/b/app"));
    }
}
