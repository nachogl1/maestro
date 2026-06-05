//! IPC command for live system metrics (CPU + memory).
//!
//! Backed by a single long-lived `sysinfo::System` held in Tauri managed
//! state behind a `Mutex`. CPU usage requires two samples to compute a delta;
//! since the frontend polls every ~2s, the gap between successive calls is
//! large enough for `sysinfo` to report an accurate global CPU percentage.

use std::sync::Mutex;

use serde::Serialize;
use sysinfo::System;
use tauri::State;

/// Shared system probe. Wrapped in a `Mutex` so the refresh delta between
/// successive polls yields an accurate CPU reading.
pub struct SystemMetricsState(pub Mutex<System>);

impl SystemMetricsState {
    /// Create the probe with an initial refresh so the first reading already
    /// has a baseline sample to diff against.
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        Self(Mutex::new(sys))
    }
}

impl Default for SystemMetricsState {
    fn default() -> Self {
        Self::new()
    }
}

/// System metrics snapshot returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetrics {
    /// Global CPU usage across all cores (0-100).
    pub cpu_percent: f32,
    /// Memory currently in use, in bytes.
    pub mem_used_bytes: u64,
    /// Total physical memory, in bytes.
    pub mem_total_bytes: u64,
    /// Memory usage as a percentage of total (0-100).
    pub mem_percent: f32,
}

/// Returns a fresh CPU + memory snapshot.
///
/// Refreshes the managed `System` on each call; the delta against the previous
/// poll gives an accurate global CPU percentage (sysinfo 0.32 API).
#[tauri::command]
pub fn get_system_metrics(state: State<'_, SystemMetricsState>) -> Result<SystemMetrics, String> {
    let mut sys = state
        .0
        .lock()
        .map_err(|e| format!("System metrics state poisoned: {e}"))?;

    sys.refresh_cpu_all();
    sys.refresh_memory();

    let cpu_percent = sys.global_cpu_usage();
    let mem_used_bytes = sys.used_memory();
    let mem_total_bytes = sys.total_memory();
    let mem_percent = if mem_total_bytes > 0 {
        (mem_used_bytes as f64 / mem_total_bytes as f64 * 100.0) as f32
    } else {
        0.0
    };

    Ok(SystemMetrics {
        cpu_percent,
        mem_used_bytes,
        mem_total_bytes,
        mem_percent,
    })
}
