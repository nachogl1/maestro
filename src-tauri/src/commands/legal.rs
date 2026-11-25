//! The licence and third-party notices that ship inside the app (issue #688).

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

/// Where the notices sit among the app's resources: `bundle.resources` in `tauri.conf.json`
/// ships the repository's `legal/` folder as `legal/`.
const THIRD_PARTY_NOTICES: &str = "legal/THIRD-PARTY-NOTICES.txt";

/// Opens Maestro's licence and third-party notices in the computer's default text viewer.
#[tauri::command]
pub async fn open_third_party_notices<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let path = app
        .path()
        .resolve(THIRD_PARTY_NOTICES, BaseDirectory::Resource)
        .map_err(|e| format!("Cannot find the app's resources: {e}"))?;
    if !path.is_file() {
        return Err(format!(
            "The notices file is missing from this copy of Maestro: {}",
            path.display()
        ));
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("Cannot open the notices file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The command looks the notices up where the bundle puts them; a renamed resource folder
    /// would leave the Settings link opening nothing.
    #[test]
    fn notices_path_is_inside_the_bundled_legal_folder() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let resources = &config["bundle"]["resources"];
        let (folder, _file) = THIRD_PARTY_NOTICES.rsplit_once('/').unwrap();

        assert_eq!(resources["../legal/"], format!("{folder}/"));
    }
}
