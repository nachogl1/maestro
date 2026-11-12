//! Project pop-out windows: a project tab moved out of the main window into
//! its own OS window (so it can live on another monitor).
//!
//! The main window stays the single owner of workspace state. A pop-out loads
//! the same frontend with `?projectWindow=<tabId>` and receives the project's
//! terminal layout from the main window over events; PTY sessions are never
//! respawned, only re-attached (see `core::output_tap`).

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Label of the window that owns workspace state and the quit prompt.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Label prefix shared by every project pop-out window. Capabilities grant
/// `project-*`, so the prefix must stay in sync with `capabilities/project-window.json`.
pub const PROJECT_WINDOW_PREFIX: &str = "project-";

/// Sent to the main window when a pop-out is destroyed, carrying its tab id,
/// so the main window docks the tab back.
pub const PROJECT_WINDOW_CLOSED_EVENT: &str = "project-window-closed";

/// Window label for a tab id. Tab ids are UUIDs; anything outside the label
/// alphabet is replaced so a malformed id can never produce an invalid label.
pub fn project_window_label(tab_id: &str) -> String {
    let safe: String = tab_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{PROJECT_WINDOW_PREFIX}{safe}")
}

/// Tab id encoded in a pop-out window label, or `None` for any other window.
pub fn tab_id_from_label(label: &str) -> Option<&str> {
    label
        .strip_prefix(PROJECT_WINDOW_PREFIX)
        .filter(|id| !id.is_empty())
}

/// Opens (or focuses, if already open) the pop-out window for a project tab.
/// `x`/`y` place a new window's top-left corner, in logical screen
/// coordinates (a tab dropped on another monitor opens there); without them
/// the OS picks the position. Returns the window label.
#[tauri::command]
pub async fn open_project_window(
    app: AppHandle,
    tab_id: String,
    title: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String, String> {
    let label = project_window_label(&tab_id);
    if let Some(existing) = app.get_webview_window(&label) {
        // A live pop-out is focused. One left behind hidden (closed but still
        // registered) would swallow every later move silently: replace it.
        if existing.is_visible().unwrap_or(false) {
            existing.set_focus().map_err(|e| {
                log::error!("Failed to focus project window {label}: {e}");
                e.to_string()
            })?;
            return Ok(label);
        }
        log::warn!("Replacing hidden project window {label}");
        if let Err(e) = existing.destroy() {
            log::error!("Failed to remove hidden project window {label}: {e}");
        }
    }

    let url = format!("index.html?projectWindow={}", urlencode(&tab_id));
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(format!("{title} — Maestro"))
        .inner_size(1100.0, 750.0)
        .min_inner_size(640.0, 400.0)
        .resizable(true);
    let builder = match (x, y) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => builder.position(x, y),
        _ => builder,
    };

    // Mirror the main window's chrome (tauri.macos.conf.json): overlay title
    // bar on macOS. Elsewhere the main window draws its own controls, which
    // the pop-out does not, so it keeps native decorations.
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .background_color(tauri::window::Color(0x1a, 0x1a, 0x1e, 0xff))
        .traffic_light_position(tauri::LogicalPosition::new(12.0, 20.0));
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(true);

    builder.build().map_err(|e| {
        log::error!("Failed to open project window {label}: {e}");
        e.to_string()
    })?;
    log::info!("Opened project window {label}");
    Ok(label)
}

/// Window-destroyed hook, called from the app-wide `on_window_event`: a
/// destroyed pop-out hands its tab back to the main window. (When the main
/// window goes, `on_window_event` closes every other window itself.)
pub fn handle_window_destroyed(app: &AppHandle, label: &str) {
    if let Some(tab_id) = tab_id_from_label(label) {
        let _ = app.emit_to(MAIN_WINDOW_LABEL, PROJECT_WINDOW_CLOSED_EVENT, tab_id);
    }
}

/// Minimal query-component encoding (tab ids are UUIDs; this only guards
/// against a malformed id breaking the URL).
fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_round_trips_a_uuid_tab_id() {
        let id = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
        let label = project_window_label(id);
        assert_eq!(label, format!("project-{id}"));
        assert_eq!(tab_id_from_label(&label), Some(id));
    }

    #[test]
    fn label_sanitizes_characters_outside_the_label_alphabet() {
        assert_eq!(project_window_label("a/b c"), "project-a_b_c");
    }

    #[test]
    fn non_project_labels_have_no_tab_id() {
        assert_eq!(tab_id_from_label("main"), None);
        assert_eq!(tab_id_from_label("project-"), None);
    }

    #[test]
    fn urlencode_escapes_reserved_characters() {
        assert_eq!(urlencode("ab-1_~."), "ab-1_~.");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
    }
}
