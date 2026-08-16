//! Commands for the agent graph.
//!
//! The frontend holds every sub-agent's brief, report and counters in memory;
//! this is the one thing it cannot do itself — put that text on disk.

use std::path::Path;

use crate::core::mcp_config_writer::atomic_write;

/// Write an exported agent run to `path`.
///
/// `path` comes from the OS save dialog the user just confirmed, so the
/// destination is their choice — but the extension is still checked and the
/// parent directory must already exist, so a malformed path fails loudly
/// instead of scattering files. Writes atomically (temp file + rename) so a
/// crash mid-write cannot leave a half-written report behind.
#[tauri::command]
pub async fn export_agent_run(path: String, content: String) -> Result<(), String> {
    let target = Path::new(&path);

    let extension = target
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(
        extension.as_deref(),
        Some("md") | Some("json") | Some("txt")
    ) {
        return Err("Export must be a .md, .json or .txt file".to_string());
    }

    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "Export path has no parent directory".to_string())?;
    if !parent.is_dir() {
        return Err(format!("Directory does not exist: {}", parent.display()));
    }

    atomic_write(target, &content).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn writes_the_report_to_the_chosen_path() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("agents-session-3.md");

        export_agent_run(path.to_string_lossy().into_owned(), "# Run\n".into())
            .await
            .expect("export should succeed");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# Run\n");
    }

    #[tokio::test]
    async fn rejects_an_unexpected_extension() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("agents.exe");

        let err = export_agent_run(path.to_string_lossy().into_owned(), "x".into())
            .await
            .expect_err("an .exe export should be refused");

        assert!(err.contains(".md"), "unexpected error: {err}");
        assert!(!path.exists(), "nothing should be written");
    }

    #[tokio::test]
    async fn rejects_a_missing_directory() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nope").join("agents.md");

        let err = export_agent_run(path.to_string_lossy().into_owned(), "x".into())
            .await
            .expect_err("a missing directory should be refused");

        assert!(err.contains("does not exist"), "unexpected error: {err}");
    }
}
