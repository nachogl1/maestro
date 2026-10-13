//! Terminal backend descriptors reported to the frontend by
//! `commands::terminal::get_backend_info`.

/// Capabilities advertised by a terminal backend.
#[derive(Debug, Clone, Default)]
pub struct BackendCapabilities {
    /// Backend supports enhanced terminal state queries.
    pub enhanced_state: bool,
    /// Backend supports text reflow on resize.
    pub text_reflow: bool,
    /// Backend supports Kitty graphics protocol.
    pub kitty_graphics: bool,
    /// Backend supports shell integration hooks.
    pub shell_integration: bool,
    /// Name of the backend implementation.
    pub backend_name: &'static str,
}

/// Identifies the active backend type for the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendType {
    /// xterm.js passthrough - raw PTY output sent directly to xterm.js.
    XtermPassthrough,
}

impl BackendType {
    /// Returns the default backend type for the current platform.
    pub fn platform_default() -> Self {
        BackendType::XtermPassthrough
    }
}
