//! Error type for the plugin domain (`plugin_config_writer`).
//!
//! Display strings are the exact messages the frontend has always shown, so
//! converting to `String` at the `#[tauri::command]` boundary is lossless.

/// Errors from writing or removing session plugin configuration.
#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    #[error("Failed to create .claude directory: {0}")]
    CreateDir(#[source] std::io::Error),
    #[error("Failed to read settings.local.json: {0}")]
    ReadSettings(#[source] std::io::Error),
    #[error("Failed to parse settings.local.json: {0}")]
    ParseSettings(#[source] serde_json::Error),
    #[error("Failed to delete empty settings.local.json: {0}")]
    DeleteSettings(#[source] std::io::Error),
    #[error("Failed to serialize {what}: {source}")]
    Serialize {
        what: &'static str,
        source: serde_json::Error,
    },
    /// Message from a shared helper that still reports `String` errors
    /// (`atomic_write`, `config_recovery::read_json_or_recover`).
    #[error("{0}")]
    Shared(String),
}

impl From<String> for PluginError {
    fn from(msg: String) -> Self {
        Self::Shared(msg)
    }
}

/// Result type for plugin domain operations.
pub type PluginResult<T> = Result<T, PluginError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_keeps_frontend_messages() {
        let io = std::io::Error::other("boom");
        assert_eq!(
            PluginError::ReadSettings(io).to_string(),
            "Failed to read settings.local.json: boom"
        );
        assert_eq!(PluginError::from("raw".to_string()).to_string(), "raw");
    }
}
