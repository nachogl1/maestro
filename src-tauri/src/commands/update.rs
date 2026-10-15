use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

use crate::core::ProcessManager;

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadProgress {
    pub chunk_length: usize,
    pub content_length: Option<u64>,
}

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    custom_endpoint: Option<String>,
) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    let update = if let Some(endpoint) = custom_endpoint {
        let url: Url = endpoint
            .parse()
            .map_err(|e| format!("Invalid endpoint URL: {e}"))?;
        app.updater_builder()
            .endpoints(vec![url])
            .map_err(|e| format!("Failed to configure updater: {e}"))?
            .build()
            .map_err(|e| format!("Failed to build updater: {e}"))?
            .check()
            .await
            .map_err(|e| format!("Failed to check for updates: {e}"))?
    } else {
        app.updater()
            .map_err(|e| format!("Failed to get updater: {e}"))?
            .check()
            .await
            .map_err(|e| format!("Failed to check for updates: {e}"))?
    };

    match update {
        Some(update) => Ok(UpdateInfo {
            available: true,
            current_version,
            latest_version: update.version.clone(),
            release_notes: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        }),
        None => Ok(UpdateInfo {
            available: false,
            current_version: current_version.clone(),
            latest_version: current_version,
            release_notes: None,
            date: None,
        }),
    }
}

#[tauri::command]
pub async fn download_and_install_update(
    app: AppHandle,
    process_manager: tauri::State<'_, ProcessManager>,
    custom_endpoint: Option<String>,
) -> Result<(), String> {
    // Always go through the builder so the before-exit hook below covers the
    // default and the custom-endpoint path alike. On Windows the plugin starts
    // msiexec and then calls `std::process::exit(0)` from inside
    // `download_and_install`, so nothing after that `.await` runs there: the
    // hook is the only place the terminals can be shut down first. Otherwise
    // the Claude CLIs (and the bundled MCP server they spawn from the install
    // dir) keep files open and msiexec asks for a reboot (#324).
    let mut builder = app.updater_builder();
    if let Some(endpoint) = custom_endpoint {
        let url: Url = endpoint
            .parse()
            .map_err(|e| format!("Invalid endpoint URL: {e}"))?;
        builder = builder
            .endpoints(vec![url])
            .map_err(|e| format!("Failed to configure updater: {e}"))?;
    }
    let hook_app = app.clone();
    let hook_manager = process_manager.inner().clone();
    let update = builder
        .on_before_exit(move || {
            log::info!("Update ready to install. Shutting down terminals first...");
            let manager = hook_manager.clone();
            run_blocking(async move {
                match manager.kill_all_sessions().await {
                    Ok(count) => log::info!("Shut down {count} terminal(s) before the update"),
                    Err(e) => log::warn!("Failed to shut down terminals before the update: {e}"),
                }
                // Work journal: record the close before the app goes.
                crate::core::work_journal_activity::close_all_terminals().await;
            });
            // The plugin's own default hook, which setting ours replaced:
            // flushes Tauri state (plugins, stores) before the process exits.
            hook_app.cleanup_before_exit();
        })
        .build()
        .map_err(|e| format!("Failed to build updater: {e}"))?
        .check()
        .await
        .map_err(|e| format!("Failed to check for updates: {e}"))?;

    let update = update.ok_or_else(|| "No update available".to_string())?;

    let app_handle = app.clone();
    let install_handle = app.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                let _ = app_handle.emit(
                    "update-download-progress",
                    DownloadProgress {
                        chunk_length,
                        content_length,
                    },
                );
            },
            move || {
                // Download finished, about to install. Emitted here rather
                // than after the await: on Windows the await never returns.
                let _ = install_handle.emit("update-installing", ());
            },
        )
        .await
        .map_err(|e| format!("Failed to download and install update: {e}"))?;

    // Only reached on platforms whose installer returns (macOS/Linux); on
    // Windows the before-exit hook above has already done this.
    log::info!("Update installed. Cleaning up PTY sessions before restart...");
    if let Ok(count) = process_manager.kill_all_sessions().await {
        log::info!("Cleaned up {} PTY session(s)", count);
    }

    // Restart the app to apply the update
    log::info!("Restarting app to apply update...");
    app.restart();
}

/// Runs an async job to completion from synchronous code and waits for it.
///
/// The updater's before-exit hook is a plain `Fn()` invoked on an async
/// runtime worker, where a direct `block_on` panics ("cannot start a runtime
/// from within a runtime"). A throwaway thread may block on the global
/// runtime, and the job's own tasks still run on the other workers.
fn run_blocking<F>(job: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let joined = std::thread::spawn(move || tauri::async_runtime::block_on(job)).join();
    if joined.is_err() {
        log::warn!("Blocking job panicked before the update");
    }
}

#[tauri::command]
pub async fn get_app_version(app: AppHandle) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The before-exit hook runs on a runtime worker thread; a plain
    /// `block_on` there would panic. This mirrors that call site.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_blocking_kills_sessions_from_inside_a_runtime() {
        let manager = ProcessManager::new();
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = done.clone();
        run_blocking(async move {
            let count = manager.kill_all_sessions().await.unwrap();
            assert_eq!(count, 0);
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        assert!(done.load(std::sync::atomic::Ordering::SeqCst));
    }
}
