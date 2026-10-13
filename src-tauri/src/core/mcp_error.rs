//! Error type for the MCP domain (`mcp_settings`, `mcp_config_writer`).
//!
//! Display strings are the exact messages the frontend has always shown, so
//! converting to `String` at the `#[tauri::command]` boundary is lossless.

use std::path::PathBuf;

/// Errors from reading, editing and writing MCP configuration files.
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("Cannot resolve home directory")]
    NoHomeDir,
    #[error("Failed to read {path:?}: {source}")]
    ReadFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("Failed to parse {path:?}: {source}")]
    ParseFile {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("Failed to back up {path:?} to {backup:?}: {source}")]
    Backup {
        path: PathBuf,
        backup: PathBuf,
        source: std::io::Error,
    },
    #[error("Failed to serialize JSON for {path:?}: {source}")]
    SerializeFile {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("Failed to write {path:?}: {source}")]
    WriteFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("Failed to replace {path:?}: {source}")]
    ReplaceFile {
        path: PathBuf,
        source: std::io::Error,
    },
    /// Reading a named session config file (`.mcp.json`, `opencode.json`).
    #[error("Failed to read {file}: {source}")]
    ReadConfig {
        file: &'static str,
        source: std::io::Error,
    },
    #[error("Failed to parse {file}: {source}")]
    ParseConfig {
        file: &'static str,
        source: serde_json::Error,
    },
    #[error("Failed to serialize {what}: {source}")]
    SerializeConfig {
        what: &'static str,
        source: serde_json::Error,
    },
    /// A std `Mutex` was poisoned by a panicking holder.
    #[error("{0}")]
    LockPoisoned(String),
    #[error("Server name cannot be empty")]
    EmptyName,
    #[error("'{0}' is reserved for Maestro's internal status server")]
    ReservedName(String),
    #[error("'{name}' is managed by Maestro and cannot be {action}")]
    InternalServer { name: String, action: &'static str },
    #[error("Server config must be a JSON object")]
    ConfigNotObject,
    #[error("Config root is not a JSON object")]
    RootNotObject,
    #[error("A server named '{0}' already exists in this scope — edit it instead")]
    AlreadyExists(String),
    #[error("Server '{name}' not found in {location}")]
    NotFound {
        name: String,
        location: &'static str,
    },
    #[error("claude.ai connectors are managed by your claude.ai account and cannot be {0} here")]
    ConnectorReadOnly(&'static str),
    /// Message from a shared helper that still reports `String` errors
    /// (`atomic_write`, `config_recovery::read_json_or_recover`).
    #[error("{0}")]
    Shared(String),
}

impl From<String> for McpError {
    fn from(msg: String) -> Self {
        Self::Shared(msg)
    }
}

/// Result type for MCP domain operations.
pub type McpResult<T> = Result<T, McpError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_keeps_frontend_messages() {
        assert_eq!(
            McpError::AlreadyExists("x".into()).to_string(),
            "A server named 'x' already exists in this scope — edit it instead"
        );
        assert_eq!(
            McpError::InternalServer {
                name: "maestro".into(),
                action: "toggled"
            }
            .to_string(),
            "'maestro' is managed by Maestro and cannot be toggled"
        );
        assert_eq!(
            McpError::NotFound {
                name: "x".into(),
                location: ".mcp.json"
            }
            .to_string(),
            "Server 'x' not found in .mcp.json"
        );
        assert_eq!(
            McpError::ConnectorReadOnly("removed").to_string(),
            "claude.ai connectors are managed by your claude.ai account and cannot be removed here"
        );
        assert_eq!(McpError::from("raw".to_string()).to_string(), "raw");
    }
}
