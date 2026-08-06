//! Samurai per-epic run configs, persisted in app-data (issue #59; PRD §5.8,
//! §8 row 2).
//!
//! A run config is the small durable record Maestro keeps about an
//! autonomous epic run: which repo/worktree it lives in, which epic it
//! serves, and any per-run preferences. It is what cold-start reconciliation
//! (PRD §5.6) scans on launch, and what the resume path (P3.3, issue #61)
//! reads to spawn a successor. GitHub + the handoff file hold everything
//! else — the config stays lean on purpose.
//!
//! **Layout:** one JSON file per epic at
//! `<base>/<project-name>-<hash12>/<epic-slug>.json`. The app constructs the
//! store at `commands::ai_runner::artifact_base_dir("runs")`; the per-project
//! directory follows the existing `<sanitized-basename>-<hash12>` convention
//! (`commands/ai_runner.rs::project_artifact_dir`, replicated here like
//! `samurai_audit.rs` does), and the file name is
//! `samurai_prompts::epic_slug` — the same slug the handoff files use, so a
//! run's artifacts are trivially correlated.
//!
//! **Lifecycle:** configs are created ACTIVE and flipped to ARCHIVED at epic
//! completion (PRD §8 row 2 — "Auto: archived at epic completion"). The file
//! is kept on archive; the Second Brain Files panel (Phase 4) lists and
//! deletes it.
//!
//! **Durability:** every write is atomic — serialize to `<file>.tmp`, then
//! rename over the target (Rust's `fs::rename` replaces an existing file on
//! Windows too, via `MOVEFILE_REPLACE_EXISTING`) — so a crash mid-write can
//! never leave a torn JSON. A `Mutex` serializes writers within the process;
//! that is enough here (single-instance app, low write rate) — the
//! heavyweight single-writer-task pattern of `samurai_audit.rs` would be
//! overkill for whole-file replace semantics.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};

use super::samurai_config::SamuraiConfig;
use super::samurai_prompts::epic_slug;
use super::status_server::StatusServer;

/// Run config lifecycle state. SCREAMING on the wire like the audit event
/// kinds (`samurai_audit::AuditEventKind`) — dependent issues consume this
/// spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RunConfigStatus {
    Active,
    Archived,
}

/// One epic's run config (PRD §5.8: "repo, epic ref, model prefs,
/// thresholds, worktree path, `--repo` pin"). Fields are snake_case on the
/// wire like every samurai sibling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SamuraiRunConfig {
    /// Canonical project path, `\\?\`-stripped (fork convention — see
    /// `commands/ai_runner.rs::canonical_project_path`). [`RunConfigStore`]
    /// re-normalizes on every save/lookup so a verbatim and a plain spelling
    /// can never map to two different files.
    pub project_path: String,
    /// Epic reference (e.g. `#37` or a full issue URL).
    pub epic: String,
    /// `--repo owner/repo` pin for orchestrator prompts (PRD §10). `None`
    /// when the remote did not parse — the prompt then carries an explicit
    /// caution instead (same policy as `samurai_replicator::derive_repo_pin`,
    /// which computes this value at launch time in P3.2).
    #[serde(default)]
    pub repo_pin: Option<String>,
    /// The epic's stable worktree path (PRD §5.9 — stable across generations).
    pub worktree_path: String,
    /// Model preference for the orchestrator. `None` = whatever the spawn
    /// flow defaults to.
    #[serde(default)]
    pub model: Option<String>,
    /// Per-run threshold overrides. `None` = the global shared
    /// [`SamuraiConfig`] applies; `Some` replaces it wholesale for this run
    /// (the launcher UI seeds the struct from the global config and tweaks).
    #[serde(default)]
    pub thresholds: Option<SamuraiConfig>,
    pub status: RunConfigStatus,
    /// RFC 3339 UTC creation timestamp.
    pub created_at: String,
}

impl SamuraiRunConfig {
    /// Builds an ACTIVE config stamped with the current UTC time; the
    /// optional fields start `None` and are filled by the caller.
    pub fn new(
        project_path: impl Into<String>,
        epic: impl Into<String>,
        worktree_path: impl Into<String>,
    ) -> Self {
        Self {
            project_path: normalize_project(&project_path.into()),
            epic: epic.into(),
            repo_pin: None,
            worktree_path: worktree_path.into(),
            model: None,
            thresholds: None,
            status: RunConfigStatus::Active,
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

/// The on-disk store. Constructed once at app setup (rooted at
/// `artifact_base_dir("runs")`) and managed as `Arc<RunConfigStore>`; tests
/// root it at a tempdir.
pub struct RunConfigStore {
    base_dir: PathBuf,
    /// Serializes read-modify-write cycles (`save`, `archive`). Reads don't
    /// strictly need it (writes are atomic renames) but take it anyway —
    /// simplest reasoning, negligible cost at this write rate.
    lock: Mutex<()>,
}

impl RunConfigStore {
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            base_dir,
            lock: Mutex::new(()),
        }
    }

    /// Creates or replaces the config for `(config.project_path,
    /// config.epic)`. The project path is normalized before it is used for
    /// placement or persisted.
    pub fn save(&self, config: &SamuraiRunConfig) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let mut config = config.clone();
        config.project_path = normalize_project(&config.project_path);
        let path = self.config_path(&config.project_path, &config.epic);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create run-config dir {parent:?}: {e}"))?;
        }
        atomic_write_json(&path, &config)
    }

    /// Every ACTIVE config across all projects — what cold-start
    /// reconciliation (PRD §5.6) scans on launch. Corrupt or unreadable
    /// files are skipped with a warning, never a panic: one torn config must
    /// not take down the scan for every other epic.
    pub fn load_active(&self) -> Vec<SamuraiRunConfig> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        self.load_all()
            .into_iter()
            .filter(|c| c.status == RunConfigStatus::Active)
            .collect()
    }

    /// The config for `(project, epic)`, if a readable one exists. Corrupt
    /// files read as `None` (with a warning).
    pub fn get(&self, project: &str, epic: &str) -> Option<SamuraiRunConfig> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let path = self.config_path(&normalize_project(project), epic);
        match read_config(&path) {
            Ok(config) => Some(config),
            Err(ReadError::Missing) => None,
            Err(ReadError::Other(e)) => {
                log::warn!("samurai run-config: unreadable config {path:?}: {e}");
                None
            }
        }
    }

    /// Flips the config to ARCHIVED, keeping the file (PRD §8 row 2 — the
    /// Second Brain panel deletes it later). Idempotent on an already
    /// archived config; an error when no readable config exists.
    pub fn archive(&self, project: &str, epic: &str) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let path = self.config_path(&normalize_project(project), epic);
        let mut config = read_config(&path).map_err(|e| match e {
            ReadError::Missing => format!("no run config for epic {epic:?} at {path:?}"),
            ReadError::Other(e) => e,
        })?;
        if config.status == RunConfigStatus::Archived {
            return Ok(());
        }
        config.status = RunConfigStatus::Archived;
        atomic_write_json(&path, &config)
    }

    fn config_path(&self, normalized_project: &str, epic: &str) -> PathBuf {
        self.base_dir
            .join(project_dir_name(normalized_project))
            .join(format!("{}.json", epic_slug(epic)))
    }

    /// Reads every parseable config under `base_dir` (all project subdirs).
    fn load_all(&self) -> Vec<SamuraiRunConfig> {
        let mut configs = Vec::new();
        let projects = match std::fs::read_dir(&self.base_dir) {
            Ok(entries) => entries,
            // Nothing saved yet — a missing base dir is the normal
            // first-launch state, not an error.
            Err(_) => return configs,
        };
        for project in projects.flatten() {
            let dir = project.path();
            if !dir.is_dir() {
                continue;
            }
            let files = match std::fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(e) => {
                    log::warn!("samurai run-config: cannot list {dir:?}: {e}");
                    continue;
                }
            };
            for file in files.flatten() {
                let path = file.path();
                // Only real configs — never leftover `.tmp` files.
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                match read_config(&path) {
                    Ok(config) => configs.push(config),
                    Err(ReadError::Missing) => {}
                    Err(ReadError::Other(e)) => {
                        log::warn!("samurai run-config: skipping corrupt config {path:?}: {e}");
                    }
                }
            }
        }
        configs
    }
}

enum ReadError {
    Missing,
    Other(String),
}

fn read_config(path: &Path) -> Result<SamuraiRunConfig, ReadError> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ReadError::Missing),
        Err(e) => return Err(ReadError::Other(format!("read failed: {e}"))),
    };
    serde_json::from_str(&content).map_err(|e| ReadError::Other(format!("parse failed: {e}")))
}

/// Serialize-to-temp then rename: a crash at any point leaves either the old
/// file or the new one, never a torn JSON. In-process concurrency is handled
/// by [`RunConfigStore::lock`], so the fixed `.tmp` name cannot race itself.
fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("failed to serialize run config: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("failed to write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("failed to move {tmp:?} into place at {path:?}: {e}"))
}

/// Strips the Windows `\\?\` extended-length prefix `fs::canonicalize` adds,
/// per fork convention (see `commands/ai_runner.rs::canonical_project_path`
/// and `samurai_audit::normalize_project`). Applied on every save/lookup so
/// both spellings of one path always hit the same file.
fn normalize_project(project: &str) -> String {
    project.strip_prefix(r"\\?\").unwrap_or(project).to_string()
}

/// Directory name for a project: `<sanitized-basename>-<hash12>`. Same
/// convention as `commands/ai_runner.rs::project_artifact_dir` (replicated
/// here like `samurai_audit.rs::audit_file_name` — the hash disambiguates
/// same-named projects in different locations).
fn project_dir_name(project: &str) -> String {
    let name = Path::new(project)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "project".to_string());
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let hash = StatusServer::generate_project_hash(project);
    format!("{}-{}", sanitized, hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample(project: &str, epic: &str) -> SamuraiRunConfig {
        let mut config = SamuraiRunConfig::new(project, epic, format!("{project}-wt"));
        config.repo_pin = Some("nachogl1/maestro".to_string());
        config.model = Some("opus".to_string());
        config
    }

    #[test]
    fn test_save_get_roundtrip_and_wire_shape() {
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        let mut config = sample("C:/git/maestro", "#37");
        config.thresholds = Some(SamuraiConfig {
            park_hard_5h_pct: 2.0,
            ..SamuraiConfig::default()
        });

        store.save(&config).unwrap();
        let loaded = store.get("C:/git/maestro", "#37").unwrap();
        assert_eq!(loaded, config);

        // On-disk shape: snake_case keys, SCREAMING status — dependent
        // issues (P3.2/P3.3, Second Brain panel) consume this spelling.
        let path = store.config_path("C:/git/maestro", "#37");
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for key in [
            "project_path",
            "epic",
            "repo_pin",
            "worktree_path",
            "model",
            "thresholds",
            "status",
            "created_at",
        ] {
            assert!(raw.get(key).is_some(), "missing key {key} in {raw}");
        }
        assert_eq!(raw["status"], "ACTIVE");
        // No torn-write leftovers.
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn test_new_stamps_active_and_rfc3339_created_at() {
        let config = SamuraiRunConfig::new("C:/git/x", "#1", "C:/git/x-wt");
        assert_eq!(config.status, RunConfigStatus::Active);
        assert!(
            chrono::DateTime::parse_from_rfc3339(&config.created_at).is_ok(),
            "created_at must be RFC3339, got {:?}",
            config.created_at
        );
        assert_eq!(config.repo_pin, None);
        assert_eq!(config.thresholds, None);
    }

    #[test]
    fn test_load_active_skips_archived_and_corrupt() {
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        store.save(&sample("C:/git/alpha", "#1")).unwrap();
        store.save(&sample("C:/git/alpha", "#2")).unwrap();
        store.save(&sample("C:/git/beta", "#9")).unwrap();
        store.archive("C:/git/alpha", "#2").unwrap();

        // A torn/corrupt file in a project dir must be skipped, not fatal.
        let corrupt = dir
            .path()
            .join(project_dir_name("C:/git/alpha"))
            .join("broken.json");
        std::fs::write(&corrupt, "{ not json").unwrap();

        let mut epics: Vec<String> = store.load_active().into_iter().map(|c| c.epic).collect();
        epics.sort();
        assert_eq!(epics, vec!["#1".to_string(), "#9".to_string()]);
    }

    #[test]
    fn test_archive_flips_status_and_keeps_file() {
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        store.save(&sample("C:/git/maestro", "#37")).unwrap();

        store.archive("C:/git/maestro", "#37").unwrap();
        let archived = store.get("C:/git/maestro", "#37").unwrap();
        assert_eq!(archived.status, RunConfigStatus::Archived);
        assert!(store.config_path("C:/git/maestro", "#37").exists());

        // Idempotent on an already archived config.
        store.archive("C:/git/maestro", "#37").unwrap();
        // But an error when nothing exists to archive.
        assert!(store.archive("C:/git/maestro", "#99").is_err());
    }

    #[test]
    fn test_verbatim_prefix_maps_to_same_config() {
        // Windows `\\?\` canonicalized spelling and the plain spelling must
        // address the same file (fork convention).
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        store.save(&sample(r"\\?\C:\git\maestro", "#37")).unwrap();

        let loaded = store.get(r"C:\git\maestro", "#37").unwrap();
        assert_eq!(loaded.project_path, r"C:\git\maestro");
        // And the persisted path carries no prefix either.
        assert!(!loaded.project_path.starts_with(r"\\?\"));
    }

    #[test]
    fn test_save_replaces_existing_config() {
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        store.save(&sample("C:/git/maestro", "#37")).unwrap();

        let mut updated = sample("C:/git/maestro", "#37");
        updated.model = Some("sonnet".to_string());
        store.save(&updated).unwrap();

        assert_eq!(store.load_active().len(), 1);
        assert_eq!(
            store.get("C:/git/maestro", "#37").unwrap().model,
            Some("sonnet".to_string())
        );
    }

    #[test]
    fn test_projects_with_same_basename_do_not_collide() {
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        store.save(&sample("C:/git/maestro", "#1")).unwrap();
        store.save(&sample("C:/other/maestro", "#1")).unwrap();
        assert_eq!(store.load_active().len(), 2);
        assert_ne!(
            project_dir_name("C:/git/maestro"),
            project_dir_name("C:/other/maestro")
        );
    }
}
