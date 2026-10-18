//! Workshop commands (issue #415): the panel's status, a run (scheduled or
//! "Run now") and one kept run's texts. The logic lives in
//! [`crate::core::workshop`]; this module wires it to the real `claude` CLI
//! and Maestro's app-data folder.

use std::path::PathBuf;
use std::time::SystemTime;

use chrono::Utc;
use directories::BaseDirs;
use tokio::sync::Mutex;

use super::ai_runner;
use crate::core::work_journal_run::run_process;
use crate::core::workshop::{
    self, RunOutcome, WorkshopRunContent, WorkshopSources, WorkshopStatus, WorkshopStore,
    INSIGHTS_ARGS, INSIGHTS_TIMEOUT, SUMMARY_TIMEOUT,
};

/// Artifact kind — the folder under the app data dir.
const KIND: &str = "workshop";

/// One Workshop run at a time, scheduled or not.
static RUN_LOCK: Mutex<()> = Mutex::const_new(());

fn store() -> WorkshopStore {
    WorkshopStore::new(ai_runner::artifact_base_dir(KIND))
}

/// `~/.claude/usage-data`, where `/insights` writes its report.
fn usage_dir() -> PathBuf {
    BaseDirs::new()
        .map(|dirs| dirs.home_dir().join(".claude"))
        .unwrap_or_else(|| PathBuf::from(".claude"))
        .join("usage-data")
}

/// The real `claude` CLI, run headless from the temp dir.
struct ClaudeSources;

impl WorkshopSources for ClaudeSources {
    async fn insights(&self) -> Result<String, String> {
        let started = SystemTime::now();
        let args: Vec<String> = INSIGHTS_ARGS.iter().map(|arg| arg.to_string()).collect();
        let stdout = run_process("claude", &args, "", INSIGHTS_TIMEOUT, true).await?;
        let usage = usage_dir();
        let report =
            tokio::task::spawn_blocking(move || workshop::locate_report(&stdout, &usage, started))
                .await
                .map_err(|e| format!("Looking for the insights report failed ({e})."))?
                .ok_or_else(|| "/insights finished but wrote no report.".to_string())?;
        tokio::fs::read_to_string(&report)
            .await
            .map_err(|e| format!("The insights report could not be read ({e})."))
    }

    async fn summarise(&self, report_text: &str) -> Result<String, String> {
        let reply = run_process(
            "claude",
            &workshop::summary_args(),
            report_text,
            SUMMARY_TIMEOUT,
            true,
        )
        .await?;
        Ok(ai_runner::strip_ansi(&reply).trim().to_string())
    }
}

/// The kept runs (newest first), the next run and whether one is going.
#[tauri::command]
pub async fn workshop_status() -> Result<WorkshopStatus, String> {
    let running = RUN_LOCK.try_lock().is_err();
    let index = store().load_index().await?;
    Ok(workshop::status(&index, running))
}

/// Runs `/insights` and its summary when due, or now when `force` is set.
#[tauri::command]
pub async fn workshop_run(force: bool) -> Result<RunOutcome, String> {
    Ok(workshop::run(&RUN_LOCK, &store(), &ClaudeSources, Utc::now(), force).await)
}

/// One kept run's report HTML and summary.
#[tauri::command]
pub async fn workshop_read(id: String) -> Result<WorkshopRunContent, String> {
    store().read_run(&id).await
}
