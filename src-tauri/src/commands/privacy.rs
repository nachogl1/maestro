//! Privacy commands (issue #684): the frontend passes on the user's answers
//! for the features that send conversation text to Claude, and (issue #709)
//! the usage bar's switch.

use crate::core::privacy_consent::CONSENT;

/// Records whether the Workshop and History summaries may send text to
/// Claude (sent by the frontend on start and on every change).
#[tauri::command]
pub async fn set_privacy_consent(workshop: bool, history_summaries: bool) {
    CONSENT.set(workshop, history_summaries);
}

/// Records whether the usage bar may ask Anthropic's usage endpoint (sent by
/// the frontend on start and on every change; on until told otherwise).
#[tauri::command]
pub async fn set_usage_bar_allowed(allowed: bool) {
    CONSENT.set_usage_bar(allowed);
}
