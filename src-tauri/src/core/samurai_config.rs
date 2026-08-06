//! Samurai supervisor configuration (issue #45; `docs/samurai/prd.md` §7).
//!
//! Every threshold is configurable because **low thresholds ARE the test
//! mode** (PRD decision #7): set the park threshold to 2% and a real
//! park cycle runs in minutes — no simulation machinery exists.
//!
//! Persistence follows the existing app-data settings pattern
//! (`tauri_plugin_store`, like `commands/marketplace.rs`): the command layer
//! stores this struct as JSON under the `config` key of
//! `samurai-config.json`. This module stays tauri-free so defaults,
//! validation and the (de)serialization shape are unit-testable.
//!
//! Field notes:
//! - Durations carry explicit `_secs` suffixes (the issue text says
//!   `ack_timeout` / `staleness_window`; unitless duration fields are a
//!   footgun, so the unit is in the name).
//! - `staleness_window_secs` is consumed by the silent-death watchdog
//!   (issue #44, parallel branch) — it lives here so that merge is trivial.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};

/// Shared, live-updatable handle to the current config. Managed as tauri
/// state and read by the allowance evaluation loop each tick, so a settings
/// change applies on the next tick without a restart.
pub type SharedSamuraiConfig = Arc<RwLock<SamuraiConfig>>;

/// All Samurai thresholds (PRD §7). Serialized in snake_case — the same
/// spelling the issue, the PRD table and the audit rows use — both into the
/// settings store and over IPC to the frontend.
///
/// `#[serde(default)]` per container: a partial or older stored JSON
/// deserializes with PRD defaults for every missing field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SamuraiConfig {
    /// Handoff trigger: orchestrator context % that requests a handoff.
    pub handoff_context_pct: f64,
    /// Park soft threshold on the 5-hour window: stop spawning new
    /// subagents, wind down (PRD §5.5 — parking itself costs turns).
    pub park_soft_5h_pct: f64,
    /// Park hard threshold on the 5-hour window: park sequentially.
    pub park_hard_5h_pct: f64,
    /// Park hard threshold on the 7-day window.
    pub park_hard_7d_pct: f64,
    /// How long to wait for an injected instruction's ACK before the single
    /// retry → ALERT (PRD §5.3 "few minutes").
    pub ack_timeout_secs: u64,
    /// Transcript-staleness window for the silent-death watchdog (issue #44).
    pub staleness_window_secs: u64,
    /// How long handoff files are kept after an epic completes (PRD §8).
    pub handoff_retention_days: u32,
}

impl Default for SamuraiConfig {
    fn default() -> Self {
        Self {
            handoff_context_pct: 45.0,
            park_soft_5h_pct: 78.0,
            park_hard_5h_pct: 90.0,
            park_hard_7d_pct: 95.0,
            ack_timeout_secs: 180,
            staleness_window_secs: 300,
            handoff_retention_days: 14,
        }
    }
}

impl SamuraiConfig {
    /// Sanity-checks a config before it is persisted or applied.
    ///
    /// Deliberately minimal: percentages must be real values in 0–100 and
    /// the timing windows non-zero. No `soft < hard` ordering is enforced —
    /// low/odd threshold combinations are exactly how the user tests live
    /// (PRD decision #7).
    pub fn validate(&self) -> Result<(), String> {
        let pcts = [
            ("handoff_context_pct", self.handoff_context_pct),
            ("park_soft_5h_pct", self.park_soft_5h_pct),
            ("park_hard_5h_pct", self.park_hard_5h_pct),
            ("park_hard_7d_pct", self.park_hard_7d_pct),
        ];
        for (name, value) in pcts {
            if !value.is_finite() || !(0.0..=100.0).contains(&value) {
                return Err(format!("{name} must be a percentage between 0 and 100"));
            }
        }
        if self.ack_timeout_secs == 0 {
            return Err("ack_timeout_secs must be at least 1".to_string());
        }
        if self.staleness_window_secs == 0 {
            return Err("staleness_window_secs must be at least 1".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_prd_section_7() {
        let cfg = SamuraiConfig::default();
        assert_eq!(cfg.handoff_context_pct, 45.0);
        assert_eq!(cfg.park_soft_5h_pct, 78.0);
        assert_eq!(cfg.park_hard_5h_pct, 90.0);
        assert_eq!(cfg.park_hard_7d_pct, 95.0);
        assert_eq!(cfg.handoff_retention_days, 14);
        // PRD gives "few minutes" / no number — but they must be non-zero.
        assert!(cfg.ack_timeout_secs > 0);
        assert!(cfg.staleness_window_secs > 0);
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn empty_json_deserializes_to_defaults() {
        // The store starts empty; an absent/empty value must mean "PRD
        // defaults", never zeros.
        let cfg: SamuraiConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(cfg, SamuraiConfig::default());
    }

    #[test]
    fn partial_json_keeps_defaults_for_missing_fields() {
        // An older stored config (fewer fields) must load with defaults
        // filling the gaps — this is what makes the #44 merge trivial.
        let cfg: SamuraiConfig = serde_json::from_str(r#"{"park_hard_5h_pct": 2.0}"#).unwrap();
        assert_eq!(cfg.park_hard_5h_pct, 2.0);
        assert_eq!(cfg.handoff_context_pct, 45.0);
        assert_eq!(
            cfg.staleness_window_secs,
            SamuraiConfig::default().staleness_window_secs
        );
    }

    #[test]
    fn serde_roundtrip_preserves_every_field() {
        let cfg = SamuraiConfig {
            handoff_context_pct: 5.0,
            park_soft_5h_pct: 1.0,
            park_hard_5h_pct: 2.0,
            park_hard_7d_pct: 3.0,
            ack_timeout_secs: 60,
            staleness_window_secs: 120,
            handoff_retention_days: 7,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: SamuraiConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
        // The wire/store spelling is the issue's snake_case naming — the
        // frontend and issue #46 consume these exact keys.
        for key in [
            "handoff_context_pct",
            "park_soft_5h_pct",
            "park_hard_5h_pct",
            "park_hard_7d_pct",
            "ack_timeout_secs",
            "staleness_window_secs",
            "handoff_retention_days",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "missing {key} in {json}"
            );
        }
    }

    #[test]
    fn validate_rejects_out_of_range_values() {
        let mut cfg = SamuraiConfig::default();
        cfg.park_hard_5h_pct = 101.0;
        assert!(cfg.validate().is_err());

        let mut cfg = SamuraiConfig::default();
        cfg.handoff_context_pct = -1.0;
        assert!(cfg.validate().is_err());

        let mut cfg = SamuraiConfig::default();
        cfg.park_soft_5h_pct = f64::NAN;
        assert!(cfg.validate().is_err());

        let mut cfg = SamuraiConfig::default();
        cfg.ack_timeout_secs = 0;
        assert!(cfg.validate().is_err());

        let mut cfg = SamuraiConfig::default();
        cfg.staleness_window_secs = 0;
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn validate_accepts_test_mode_thresholds() {
        // PRD decision #7: absurdly low thresholds are the supported way to
        // test live. They must not be "corrected".
        let cfg = SamuraiConfig {
            handoff_context_pct: 5.0,
            park_soft_5h_pct: 1.0,
            park_hard_5h_pct: 2.0,
            park_hard_7d_pct: 2.0,
            ..SamuraiConfig::default()
        };
        assert!(cfg.validate().is_ok());
    }
}
