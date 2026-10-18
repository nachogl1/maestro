use std::time::Duration;

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

/// How many times an update check runs before its failure is reported.
const CHECK_ATTEMPTS: u32 = 3;
/// Pause between check attempts: long enough for a network blip, or a
/// release GitHub is still publishing, to clear.
const CHECK_RETRY_DELAY: Duration = Duration::from_secs(3);
/// Shown in place of the raw request error, whose long URL means nothing to
/// the user; the full cause goes to the log.
const UNREACHABLE_MESSAGE: &str =
    "Couldn't reach the update server. Check your connection and try again.";

/// Runs `op` up to `attempts` times, waiting `delay` between tries, as long
/// as it fails with an error `is_transient` accepts. Any other result,
/// including the last attempt's failure, is returned as is.
async fn retry_transient<T, E, Op, Fut>(
    attempts: u32,
    delay: Duration,
    is_transient: impl Fn(&E) -> bool,
    mut op: Op,
) -> Result<T, E>
where
    E: std::error::Error,
    Op: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let mut attempt = 1;
    loop {
        match op().await {
            Err(e) if attempt < attempts && is_transient(&e) => {
                log::warn!(
                    "Update check attempt {attempt} failed, retrying: {}",
                    error_chain(&e)
                );
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            result => return result,
        }
    }
}

/// Whether the request itself failed (DNS, connect, TLS, timeout), which is
/// worth retrying, as opposed to a bad or missing release manifest.
fn is_network_error(error: &tauri_plugin_updater::Error) -> bool {
    matches!(error, tauri_plugin_updater::Error::Reqwest(_))
}

/// The error's message followed by each underlying cause. A request error's
/// own message ("error sending request for url ...") hides the real reason.
fn error_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// The message shown to the user for a failed update check.
fn describe_check_error(error: &tauri_plugin_updater::Error) -> String {
    if is_network_error(error) {
        UNREACHABLE_MESSAGE.to_string()
    } else {
        format!("Failed to check for updates: {error}")
    }
}

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    custom_endpoint: Option<String>,
) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    let mut builder = app.updater_builder();
    if let Some(endpoint) = custom_endpoint {
        let url: Url = endpoint
            .parse()
            .map_err(|e| format!("Invalid endpoint URL: {e}"))?;
        builder = builder
            .endpoints(vec![url])
            .map_err(|e| format!("Failed to configure updater: {e}"))?;
    }
    let updater = builder
        .build()
        .map_err(|e| format!("Failed to build updater: {e}"))?;
    let update = retry_transient(CHECK_ATTEMPTS, CHECK_RETRY_DELAY, is_network_error, || {
        updater.check()
    })
    .await
    .map_err(|e| {
        log::error!("Update check failed: {}", error_chain(&e));
        describe_check_error(&e)
    })?;

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

    #[derive(Debug, thiserror::Error)]
    enum TestError {
        #[error("flaky")]
        Flaky,
        #[error("broken")]
        Broken,
        #[error("error sending request")]
        Wrapped(#[source] std::io::Error),
    }

    fn is_flaky(e: &TestError) -> bool {
        matches!(e, TestError::Flaky)
    }

    /// Runs `retry_transient` over a scripted list of outcomes, returning its
    /// result and how many attempts it made.
    async fn run_script(script: Vec<Result<u8, TestError>>) -> (Result<u8, TestError>, usize) {
        let attempts = std::sync::atomic::AtomicUsize::new(0);
        let script = std::sync::Mutex::new(script.into_iter());
        let result = retry_transient(3, Duration::ZERO, is_flaky, || {
            attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let next = script.lock().unwrap().next().expect("script ran out");
            async move { next }
        })
        .await;
        (result, attempts.into_inner())
    }

    #[tokio::test]
    async fn retry_transient_retries_a_transient_failure_until_it_succeeds() {
        let (result, attempts) = run_script(vec![Err(TestError::Flaky), Ok(7)]).await;
        assert_eq!(result.unwrap(), 7);
        assert_eq!(attempts, 2);
    }

    #[tokio::test]
    async fn retry_transient_gives_up_after_the_last_attempt() {
        let script = vec![
            Err(TestError::Flaky),
            Err(TestError::Flaky),
            Err(TestError::Flaky),
        ];
        let (result, attempts) = run_script(script).await;
        assert!(matches!(result, Err(TestError::Flaky)));
        assert_eq!(attempts, 3);
    }

    #[tokio::test]
    async fn retry_transient_reports_a_permanent_failure_at_once() {
        let (result, attempts) = run_script(vec![Err(TestError::Broken)]).await;
        assert!(matches!(result, Err(TestError::Broken)));
        assert_eq!(attempts, 1);
    }

    #[test]
    fn error_chain_names_the_underlying_cause() {
        let cause = std::io::Error::new(std::io::ErrorKind::TimedOut, "connection timed out");
        let chain = error_chain(&TestError::Wrapped(cause));
        assert_eq!(chain, "error sending request: connection timed out");
    }

    #[test]
    fn describe_check_error_keeps_the_detail_of_a_non_network_error() {
        let error = tauri_plugin_updater::Error::ReleaseNotFound;
        assert_eq!(
            describe_check_error(&error),
            "Failed to check for updates: Could not fetch a valid release JSON from the remote"
        );
    }
}
