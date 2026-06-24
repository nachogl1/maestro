//! IPC commands for context documents (CLAUDE.md, AGENTS.md, README.md)
//! at user and project tiers.

use directories::BaseDirs;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Status of CLAUDE.md file at project root (legacy shape kept for compatibility).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMdStatus {
    pub exists: bool,
    pub path: String,
    pub content: Option<String>,
}

/// One context doc descriptor surfaced in the sidebar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextDoc {
    /// "user" | "project"
    pub tier: String,
    /// "claude" | "agents" | "readme" | "gitignore" | "settings" | "mcp"
    pub kind: String,
    /// Display label (the filename, e.g. "CLAUDE.md").
    pub label: String,
    pub path: String,
    pub exists: bool,
}

/// Allowed basenames for read/write — basename validation is the single
/// safeguard against the frontend asking us to touch arbitrary files.
const ALLOWED_BASENAMES: &[&str] = &[
    "CLAUDE.md",
    "AGENTS.md",
    "README.md",
    ".gitignore",
    // Basename of the global git excludes file (`~/.config/git/ignore`).
    "ignore",
    "settings.json",
    ".mcp.json",
];

/// Resolve the path to the user's global git excludes file the way git does
/// for the common case: `$XDG_CONFIG_HOME/git/ignore`, falling back to
/// `~/.config/git/ignore`. (A custom `core.excludesfile` is not honored here —
/// the default location covers the overwhelming majority of setups.)
fn global_gitignore_path(home_dir: &Path) -> PathBuf {
    let config_dir = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| home_dir.join(".config"));
    config_dir.join("git").join("ignore")
}

fn validate_basename(path: &Path) -> Result<(), String> {
    let basename = path
        .file_name()
        .and_then(|f| f.to_str())
        .ok_or_else(|| format!("Invalid path: {}", path.display()))?;
    if !ALLOWED_BASENAMES.contains(&basename) {
        return Err(format!(
            "'{}' is not an allowed context doc filename",
            basename
        ));
    }
    Ok(())
}

/// List the context docs that may exist for the active project.
///
/// Always returns the user-tier entries (anchored at `~/.claude/`, plus the
/// global git excludes file at `~/.config/git/ignore`).
/// If `project_path` is non-empty and resolvable, also returns project-tier
/// entries (`<repo>/CLAUDE.md`, `AGENTS.md`, `README.md`, `.gitignore`,
/// `.claude/settings.json`, `.mcp.json`).
#[tauri::command]
pub async fn list_context_docs(project_path: String) -> Result<Vec<ContextDoc>, String> {
    let mut docs: Vec<ContextDoc> = Vec::new();

    let push = |docs: &mut Vec<ContextDoc>, tier: &str, kind: &str, label: &str, p: PathBuf| {
        docs.push(ContextDoc {
            tier: tier.into(),
            kind: kind.into(),
            label: label.into(),
            exists: p.exists(),
            path: p.to_string_lossy().into_owned(),
        });
    };

    // User tier — anchored at ~/.claude/
    if let Some(base_dirs) = BaseDirs::new() {
        let user_dir = base_dirs.home_dir().join(".claude");
        push(
            &mut docs,
            "user",
            "claude",
            "CLAUDE.md",
            user_dir.join("CLAUDE.md"),
        );
        push(
            &mut docs,
            "user",
            "agents",
            "AGENTS.md",
            user_dir.join("AGENTS.md"),
        );
        push(
            &mut docs,
            "user",
            "settings",
            ".claude/settings.json",
            user_dir.join("settings.json"),
        );
        push(
            &mut docs,
            "user",
            "gitignore",
            "git/ignore (global)",
            global_gitignore_path(base_dirs.home_dir()),
        );
    }

    if !project_path.is_empty() {
        let canonical = std::fs::canonicalize(&project_path)
            .map_err(|e| format!("Invalid project path '{}': {}", project_path, e))?;

        // Project tier — committed docs / config at the repo root
        push(
            &mut docs,
            "project",
            "claude",
            "CLAUDE.md",
            canonical.join("CLAUDE.md"),
        );
        push(
            &mut docs,
            "project",
            "agents",
            "AGENTS.md",
            canonical.join("AGENTS.md"),
        );
        push(
            &mut docs,
            "project",
            "readme",
            "README.md",
            canonical.join("README.md"),
        );
        push(
            &mut docs,
            "project",
            "gitignore",
            ".gitignore",
            canonical.join(".gitignore"),
        );
        push(
            &mut docs,
            "project",
            "settings",
            ".claude/settings.json",
            canonical.join(".claude").join("settings.json"),
        );
        push(
            &mut docs,
            "project",
            "mcp",
            ".mcp.json",
            canonical.join(".mcp.json"),
        );
    }

    Ok(docs)
}

/// Read a context doc by absolute path. Returns empty string if the file
/// does not exist (caller can treat that as "create new").
#[tauri::command]
pub async fn read_context_doc(path: String) -> Result<String, String> {
    let pb = PathBuf::from(&path);
    validate_basename(&pb)?;
    if !pb.exists() {
        return Ok(String::new());
    }
    tokio::fs::read_to_string(&pb)
        .await
        .map_err(|e| format!("Failed to read {}: {}", path, e))
}

/// Write a context doc by absolute path. Creates parent directories if
/// missing (so the user can create `~/.claude/CLAUDE.md` even if `~/.claude/`
/// doesn't exist yet).
#[tauri::command]
pub async fn write_context_doc(path: String, content: String) -> Result<(), String> {
    let pb = PathBuf::from(&path);
    validate_basename(&pb)?;
    if let Some(parent) = pb.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
        }
    }
    tokio::fs::write(&pb, content)
        .await
        .map_err(|e| format!("Failed to write {}: {}", path, e))
}

/// Check if CLAUDE.md exists at project root and optionally return its content.
#[tauri::command]
pub async fn check_claude_md(project_path: String) -> Result<ClaudeMdStatus, String> {
    let canonical = std::fs::canonicalize(&project_path)
        .map_err(|e| format!("Invalid project path '{}': {}", project_path, e))?;

    let claude_md_path = canonical.join("CLAUDE.md");
    let path_str = claude_md_path.to_string_lossy().into_owned();

    if claude_md_path.exists() {
        // Read content if file exists
        let content = tokio::fs::read_to_string(&claude_md_path).await.ok();

        Ok(ClaudeMdStatus {
            exists: true,
            path: path_str,
            content,
        })
    } else {
        Ok(ClaudeMdStatus {
            exists: false,
            path: path_str,
            content: None,
        })
    }
}

/// Read CLAUDE.md content from project root.
#[tauri::command]
pub async fn read_claude_md(project_path: String) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&project_path)
        .map_err(|e| format!("Invalid project path '{}': {}", project_path, e))?;

    let claude_md_path = canonical.join("CLAUDE.md");

    tokio::fs::read_to_string(&claude_md_path)
        .await
        .map_err(|e| format!("Failed to read CLAUDE.md: {}", e))
}

/// Write content to CLAUDE.md at project root (creates if doesn't exist).
#[tauri::command]
pub async fn write_claude_md(project_path: String, content: String) -> Result<(), String> {
    let canonical = std::fs::canonicalize(&project_path)
        .map_err(|e| format!("Invalid project path '{}': {}", project_path, e))?;

    let claude_md_path = canonical.join("CLAUDE.md");

    tokio::fs::write(&claude_md_path, content)
        .await
        .map_err(|e| format!("Failed to write CLAUDE.md: {}", e))
}
