//! Privacy commands (issue #684): the frontend passes on the user's answers
//! for the features that send conversation text to Claude.

use crate::core::privacy_consent::CONSENT;

/// Records whether the Workshop and History summaries may send text to
/// Claude (sent by the frontend on start and on every change).
#[tauri::command]
pub async fn set_privacy_consent(workshop: bool, history_summaries: bool) {
    CONSENT.set(workshop, history_summaries);
}
