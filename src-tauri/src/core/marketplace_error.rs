//! Error types for marketplace operations.

/// Errors that can occur during marketplace operations.
#[derive(Debug, thiserror::Error)]
pub enum MarketplaceError {
    /// Failed to fetch marketplace catalog.
    #[error("Failed to fetch marketplace: {0}")]
    FetchError(String),
    /// Failed to parse marketplace catalog.
    #[error("Failed to parse marketplace catalog: {0}")]
    ParseError(String),
    /// Failed to clone repository.
    #[error("Failed to clone repository: {0}")]
    CloneError(String),
    /// Plugin not found.
    #[error("Plugin not found: {0}")]
    PluginNotFound(String),
    /// Marketplace source not found.
    #[error("Marketplace source not found: {0}")]
    SourceNotFound(String),
    /// Plugin already installed.
    #[error("Plugin already installed: {0}")]
    AlreadyInstalled(String),
    /// Plugin not installed.
    #[error("Plugin not installed: {0}")]
    NotInstalled(String),
    /// Invalid path or directory.
    #[error("Invalid path: {0}")]
    InvalidPath(String),
    /// IO error.
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    /// Serialization/deserialization error.
    #[error("Serialization error: {0}")]
    SerdeError(#[from] serde_json::Error),
    /// Network error.
    #[error("Network error: {0}")]
    NetworkError(String),
    /// Store error.
    #[error("Store error: {0}")]
    StoreError(String),
}

impl From<MarketplaceError> for String {
    fn from(e: MarketplaceError) -> Self {
        e.to_string()
    }
}

/// Result type for marketplace operations.
pub type MarketplaceResult<T> = Result<T, MarketplaceError>;
