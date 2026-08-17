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
//! **Lifecycle:** configs are created ACTIVE, flipped to COMPLETED when the
//! orchestrator's completion declaration passes Maestro's `gh` verification
//! (issue #96 — `samurai_completion`; a COMPLETED run is finished and awaits
//! the manual 🗑 cleanup, and cold-start reconciliation never touches it),
//! and flipped to ARCHIVED by that cleanup (PRD §5.9/§8 row 2). The file is
//! kept on archive; the Second Brain Files panel (Phase 4) lists and deletes
//! it. Configs written before COMPLETED existed carry only ACTIVE/ARCHIVED
//! and deserialize unchanged.
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
use super::samurai_pr_runs;
use super::samurai_prompts::{epic_slug, RunRefs};
use super::samurai_workflow::WorkflowGraph;
use super::status_server::StatusServer;

/// Run config lifecycle state. SCREAMING on the wire like the audit event
/// kinds (`samurai_audit::AuditEventKind`) — dependent issues consume this
/// spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RunConfigStatus {
    Active,
    /// Verified complete (issue #96): the orchestrator declared completion
    /// and Maestro confirmed via `gh` that the batch PR is open with every
    /// batch issue closed or linked for close by it — or already merged
    /// with every issue closed (PRD §5.9, review F3).
    /// Finished-awaiting-cleanup — the manual 🗑 cleanup (PRD §5.9) flips
    /// it on to ARCHIVED.
    Completed,
    Archived,
}

/// A ref's human title, captured best effort at launch (issue #139) so the
/// Second Brain can label a run `Epic #38 — Samurai supervision` instead of
/// `Epic #38`. snake_case on the wire like every samurai sibling; `ref` is a
/// Rust keyword, hence the raw identifier — the serialized key is plain `ref`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefTitle {
    /// The BARE ref (`38`), spelled exactly as [`SamuraiRunConfig::epics`] and
    /// [`SamuraiRunConfig::issues`] hold it, so a title looks up by equality.
    pub r#ref: String,
    /// The issue/epic title as GitHub reported it.
    pub title: String,
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
    /// The run's IDENTITY string and the key everything else is built from:
    /// [`epic_slug`] turns it into this file's name, the branch, the worktree
    /// folder and the handoff filenames. Since issue #83 a launch stores
    /// [`RunRefs::label`] here (`epic #5 · issues #7, #9`); configs written
    /// before that hold a single raw ref (`#37`) and keep working unchanged —
    /// both are just strings this field never interprets.
    pub epic: String,
    /// Parent epic refs, bare (`5`), in the order the launcher gave them
    /// (issue #83). `#[serde(default)]` — a config written before the split
    /// has no such key and loads with an empty list, which must never break
    /// listing, archiving or cleanup: [`epic`](Self::epic) alone still keys
    /// the run.
    #[serde(default)]
    pub epics: Vec<String>,
    /// Standalone issue refs, bare (`7`) — the issues named directly rather
    /// than discovered from an epic (issue #83). Same back-compat contract as
    /// [`epics`](Self::epics).
    #[serde(default)]
    pub issues: Vec<String>,
    /// Titles for the refs above, captured best effort at launch (issue #139)
    /// — the title half of the Second Brain's `Epic #38 — Samurai supervision`
    /// label. `#[serde(default)]`: a config written before titles existed has
    /// no such key, loads with an empty list, and simply labels refs-only.
    /// A ref with no entry here is never blocked or hidden for it — which is
    /// every samurai run today: nothing populates this yet, so run labels are
    /// refs-only until the launch-time `gh` title lookup lands (#141). A PR
    /// review's title travels on its own record and already renders.
    #[serde(default)]
    pub ref_titles: Vec<RefTitle>,
    /// The free-text launch request this run was started from, verbatim
    /// (issue #128) — the durable record of what the user asked for. `None`
    /// on configs written before free-text launches existed.
    #[serde(default)]
    pub launch_text: Option<String>,
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
    /// The workflow graph snapshotted at launch (issue #91) — successor
    /// briefs recompile THIS graph after handoffs, so the run's process
    /// never drifts mid-run. `None` (configs written before workflows
    /// existed) reads as the default template
    /// (`samurai_workflow::compiled_for_run`).
    #[serde(default)]
    pub workflow: Option<WorkflowGraph>,
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
            epics: Vec::new(),
            issues: Vec::new(),
            ref_titles: Vec::new(),
            launch_text: None,
            repo_pin: None,
            worktree_path: worktree_path.into(),
            model: None,
            thresholds: None,
            workflow: None,
            status: RunConfigStatus::Active,
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// Records the structured refs behind the run (issue #83). `refs` must be
    /// the same value whose [`RunRefs::label`] was passed as `epic`, so the
    /// two lists always describe the identity string rather than contradict
    /// it. Chained onto [`new`](Self::new) at launch; a config that never
    /// calls it keeps the pre-#83 shape (empty lists), which is exactly what
    /// an old on-disk file deserialises to.
    pub fn with_refs(mut self, refs: &RunRefs) -> Self {
        self.epics = refs.epics().to_vec();
        self.issues = refs.issues().to_vec();
        self
    }
}

/// What a single-config read found: the config, nothing at all, or a file
/// that exists but could not be read. The third case is deliberately NOT
/// folded into the second — "unreadable" is not evidence that a run ended.
#[derive(Debug)]
pub enum ConfigLookup {
    /// Boxed: the config dwarfs the other variants (clippy's
    /// `large_enum_variant`), and this value is moved out immediately.
    Found(Box<SamuraiRunConfig>),
    Missing,
    /// The file exists but could not be read/parsed; carries the reason.
    Unreadable(String),
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
            .filter(|(_, c)| c.status == RunConfigStatus::Active)
            .map(|(_, c)| c)
            .collect()
    }

    /// Every config that still represents a run — ACTIVE plus COMPLETED
    /// (finished-awaiting-cleanup) — across all projects. The launcher
    /// panel's runs list (issue #96): a completed run must stay visible
    /// until the human's 🗑 cleanup archives it.
    pub fn load_unarchived(&self) -> Vec<SamuraiRunConfig> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        self.load_all()
            .into_iter()
            .filter(|(_, c)| c.status != RunConfigStatus::Archived)
            .map(|(_, c)| c)
            .collect()
    }

    /// Every readable config — ACTIVE and ARCHIVED — with its on-disk path.
    /// The Second Brain file inventory (`samurai_files`, issue #65) lists
    /// these; corrupt files are skipped like everywhere else.
    pub fn list_with_paths(&self) -> Vec<(PathBuf, SamuraiRunConfig)> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        self.load_all()
    }

    /// The config for `(project, epic)`, if a readable one exists. Corrupt
    /// files read as `None` (with a warning).
    ///
    /// Callers that must not treat "unreadable" as "the run is over" — the
    /// resume timer above all — use [`Self::lookup`] instead.
    pub fn get(&self, project: &str, epic: &str) -> Option<SamuraiRunConfig> {
        match self.lookup(project, epic) {
            ConfigLookup::Found(config) => Some(*config),
            ConfigLookup::Missing | ConfigLookup::Unreadable(_) => None,
        }
    }

    /// [`Self::get`] with "the file is not there" kept distinct from "the
    /// file is there and could not be read". Collapsing the two makes a
    /// torn or locked config look exactly like a finished run, which is how
    /// a live parked run ended up stranded behind a false "the run is over"
    /// trail.
    pub fn lookup(&self, project: &str, epic: &str) -> ConfigLookup {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let path = self.config_path(&normalize_project(project), epic);
        match read_config(&path) {
            Ok(config) => ConfigLookup::Found(Box::new(config)),
            Err(ReadError::Missing) => ConfigLookup::Missing,
            Err(ReadError::Other(e)) => {
                log::warn!("samurai run-config: unreadable config {path:?}: {e}");
                ConfigLookup::Unreadable(e)
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

    /// Flips an ACTIVE config to COMPLETED (issue #96) — called ONLY after
    /// the orchestrator's completion declaration passed `gh` verification
    /// (`samurai_completion`). Keeps the file: the run stays listed as
    /// finished-awaiting-cleanup until the manual cleanup archives it.
    /// Idempotent on an already COMPLETED config; an error when no readable
    /// config exists or the config is already ARCHIVED (a cleaned-up run
    /// must never be resurrected into the runs list).
    pub fn complete(&self, project: &str, epic: &str) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let path = self.config_path(&normalize_project(project), epic);
        let mut config = read_config(&path).map_err(|e| match e {
            ReadError::Missing => format!("no run config for epic {epic:?} at {path:?}"),
            ReadError::Other(e) => e,
        })?;
        match config.status {
            RunConfigStatus::Completed => return Ok(()),
            RunConfigStatus::Archived => {
                return Err(format!(
                    "run config for epic {epic:?} is ARCHIVED — cannot mark it complete"
                ));
            }
            RunConfigStatus::Active => {}
        }
        config.status = RunConfigStatus::Completed;
        atomic_write_json(&path, &config)
    }

    /// Overwrites `ref_titles` on the config for `(project, epic)` — the
    /// launch-time title lookup's writer (issue #141). Unlike
    /// [`Self::archive`]/[`Self::complete`], this carries NO status guard:
    /// the lookup races nothing that cares, so a late-arriving title is
    /// written whatever state the config is found in (Active, Completed or
    /// Archived all accept it). `Err` on a missing config is a normal,
    /// non-panicking outcome the caller logs and drops (the run was
    /// archived/cleaned up before the lookup finished).
    pub fn set_ref_titles(
        &self,
        project: &str,
        epic: &str,
        titles: Vec<RefTitle>,
    ) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let path = self.config_path(&normalize_project(project), epic);
        let mut config = read_config(&path).map_err(|e| match e {
            ReadError::Missing => format!("no run config for epic {epic:?} at {path:?}"),
            ReadError::Other(e) => e,
        })?;
        config.ref_titles = titles;
        atomic_write_json(&path, &config)
    }

    fn config_path(&self, normalized_project: &str, epic: &str) -> PathBuf {
        self.base_dir
            .join(project_dir_name(normalized_project))
            .join(format!("{}.json", epic_slug(epic)))
    }

    /// Reads every parseable config under `base_dir` (all project subdirs),
    /// paired with the file it was read from.
    fn load_all(&self) -> Vec<(PathBuf, SamuraiRunConfig)> {
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
            // `runs/pr/` holds PR-review records (issue #139), not run
            // configs. It shares this root so those records fall inside an
            // existing Samurai-managed delete root; skipping it by name is
            // sound because a project directory is always
            // `<sanitized-basename>-<hash12>`, which `pr` can never be.
            if dir.file_name().and_then(|n| n.to_str()) == Some(samurai_pr_runs::PR_RUNS_DIR) {
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
                    Ok(config) => configs.push((path, config)),
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
            "epics",
            "issues",
            "repo_pin",
            "worktree_path",
            "model",
            "thresholds",
            "workflow",
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
        // Issue #83: the structured refs start empty — the pre-split shape.
        assert!(config.epics.is_empty());
        assert!(config.issues.is_empty());
    }

    #[test]
    fn test_with_refs_records_the_lists_behind_the_label() {
        // Issue #83: `epic` stays the identity string ([`RunRefs::label`]) and
        // the two lists say what it was built from, normalised to bare refs.
        let refs = RunRefs::new(["#5"], ["7", "#9"]);
        let config =
            SamuraiRunConfig::new("C:/git/maestro", refs.label(), "C:/wt").with_refs(&refs);
        assert_eq!(config.epic, "epic #5 · issues #7, #9");
        assert_eq!(config.epics, vec!["5".to_string()]);
        assert_eq!(config.issues, vec!["7".to_string(), "9".to_string()]);

        // The label is what keys the file, so one launch of an epic plus two
        // issues lands on the combined slug — the same slug the branch,
        // worktree and handoff filenames use.
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        store.save(&config).unwrap();
        let path = store.config_path("C:/git/maestro", &config.epic);
        assert!(
            path.ends_with("epic-5-issues-7-9.json"),
            "unexpected config path {path:?}"
        );
        assert_eq!(store.get("C:/git/maestro", &config.epic).unwrap(), config);
    }

    #[test]
    fn test_pre_split_config_still_loads_lists_and_archives() {
        // Issue #83 back-compat — the acceptance criterion that matters most:
        // a config written BEFORE `epics`/`issues` existed has neither key. It
        // must deserialise, list, and stay findable by its `epic` for the
        // lookup/archive/cleanup path, because a broken deserialise silently
        // orphans a LIVE run's worktree. The literal old JSON is written by
        // hand on purpose: round-tripping today's struct would prove nothing.
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        let project = "C:/git/maestro";
        // `r##` on purpose — the JSON contains `"#37"`, which would close an
        // `r#` raw string.
        let old_json = r##"{
  "project_path": "C:/git/maestro",
  "epic": "#37",
  "repo_pin": "nachogl1/maestro",
  "worktree_path": "C:/worktrees/maestro-37",
  "model": "opus",
  "thresholds": null,
  "status": "ACTIVE",
  "created_at": "2026-08-01T09:00:00+00:00"
}"##;
        let path = dir.path().join(project_dir_name(project)).join("37.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, old_json).unwrap();

        // Cold-start reconciliation still sees it…
        let active = store.load_active();
        assert_eq!(active.len(), 1, "pre-split config must still list");
        assert_eq!(active[0].epic, "#37");
        assert_eq!(active[0].worktree_path, "C:/worktrees/maestro-37");
        // …with the new fields defaulted rather than fatal.
        assert!(active[0].epics.is_empty());
        assert!(active[0].issues.is_empty());
        // …the file inventory too.
        assert_eq!(store.list_with_paths().len(), 1);

        // Lookup by the run's epic works, in either spelling (both slug to
        // `37`), which is how cleanup and resume find it.
        let loaded = store.get(project, "#37").expect("found by its own epic");
        assert_eq!(loaded.repo_pin.as_deref(), Some("nachogl1/maestro"));
        assert_eq!(loaded.model.as_deref(), Some("opus"));
        assert!(store.get(project, "37").is_some());

        // And cleanup can archive it in place, keeping the file.
        store.archive(project, "#37").unwrap();
        assert_eq!(
            store.get(project, "#37").unwrap().status,
            RunConfigStatus::Archived
        );
        assert!(path.exists());
        assert!(store.load_active().is_empty());
    }

    #[test]
    fn test_ref_titles_roundtrip_and_default_to_empty() {
        // Issue #139: the title half of a Second Brain run label. Absent on an
        // old config (no key at all) → empty list, refs-only labels, no
        // migration; present → byte-identical through the save/get roundtrip.
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        let mut config = sample("C:/git/maestro", "#38");
        assert!(config.ref_titles.is_empty(), "new configs start refs-only");
        config.ref_titles = vec![RefTitle {
            r#ref: "38".to_string(),
            title: "Samurai supervision".to_string(),
        }];

        store.save(&config).unwrap();
        let loaded = store.get("C:/git/maestro", "#38").unwrap();
        assert_eq!(loaded.ref_titles, config.ref_titles);

        // On the wire the key is plain `ref`, not the raw identifier.
        let raw: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(store.config_path("C:/git/maestro", "#38")).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["ref_titles"][0]["ref"], "38");
        assert_eq!(raw["ref_titles"][0]["title"], "Samurai supervision");

        // A config written before the field existed still loads.
        let old = store.config_path("C:/git/old", "#1");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(
            &old,
            r##"{"project_path":"C:/git/old","epic":"#1","worktree_path":"C:/git/old-wt",
                "status":"ACTIVE","created_at":"2026-08-01T00:00:00+00:00"}"##,
        )
        .unwrap();
        assert!(store.get("C:/git/old", "#1").unwrap().ref_titles.is_empty());
    }

    #[test]
    fn test_set_ref_titles_overwrites_and_persists() {
        // Issue #141: the launch-time title-lookup writer. `set_ref_titles`
        // is a plain overwrite — no read-then-merge — so a later call simply
        // replaces whatever the previous lookup found.
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        let config = sample("C:/git/maestro", "#38");
        store.save(&config).unwrap();

        store
            .set_ref_titles(
                "C:/git/maestro",
                "#38",
                vec![RefTitle {
                    r#ref: "38".to_string(),
                    title: "Samurai supervision".to_string(),
                }],
            )
            .unwrap();

        let loaded = store.get("C:/git/maestro", "#38").unwrap();
        assert_eq!(
            loaded.ref_titles,
            vec![RefTitle {
                r#ref: "38".to_string(),
                title: "Samurai supervision".to_string(),
            }]
        );
    }

    #[test]
    fn test_set_ref_titles_on_missing_config_returns_err_not_panic() {
        // A lookup racing a run that got cleaned up before it finished: the
        // caller logs and drops the error, but the store must never panic
        // and must never create a file for a run that no longer exists.
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());

        let err = store
            .set_ref_titles(
                "C:/git/maestro",
                "#38",
                vec![RefTitle {
                    r#ref: "38".to_string(),
                    title: "Samurai supervision".to_string(),
                }],
            )
            .unwrap_err();
        assert!(!err.is_empty());
        assert!(!store.config_path("C:/git/maestro", "#38").exists());
    }

    #[test]
    fn test_set_ref_titles_overwrites_regardless_of_status() {
        // Unlike `archive`/`complete`, `set_ref_titles` carries no status
        // guard: a title lookup racing a fast-completing run must not be
        // swallowed just because the config moved on to COMPLETED.
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        let config = sample("C:/git/maestro", "#38");
        store.save(&config).unwrap();
        store.complete("C:/git/maestro", "#38").unwrap();

        store
            .set_ref_titles(
                "C:/git/maestro",
                "#38",
                vec![RefTitle {
                    r#ref: "38".to_string(),
                    title: "Samurai supervision".to_string(),
                }],
            )
            .unwrap();

        let loaded = store.get("C:/git/maestro", "#38").unwrap();
        assert_eq!(loaded.status, RunConfigStatus::Completed);
        assert_eq!(loaded.ref_titles[0].title, "Samurai supervision");
    }

    #[test]
    fn test_pr_review_records_are_not_scanned_as_run_configs() {
        // Issue #139: PR-review records share the `runs` root (so the existing
        // delete guard covers them) but are NOT run configs — the scan must
        // skip their directory outright, not fall into the corrupt-file
        // warning path on every listing.
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        store.save(&sample("C:/git/maestro", "#38")).unwrap();

        let pr_dir = dir.path().join(samurai_pr_runs::PR_RUNS_DIR);
        std::fs::create_dir_all(&pr_dir).unwrap();
        std::fs::write(
            pr_dir.join("nachogl1-maestro-142-x.json"),
            r#"{"kind":"PR_REVIEW","pr":142,"title":"t","repo":"nachogl1/maestro",
                "project_path":"C:/git/maestro","steps":["check"],"brief":null,
                "session_id":7,"created_at":"2026-08-17T12:00:00+00:00"}"#,
        )
        .unwrap();

        assert_eq!(store.list_with_paths().len(), 1);
        assert_eq!(store.load_active().len(), 1);
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
    fn test_complete_flips_active_and_keeps_file() {
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        store.save(&sample("C:/git/maestro", "#37")).unwrap();

        store.complete("C:/git/maestro", "#37").unwrap();
        let completed = store.get("C:/git/maestro", "#37").unwrap();
        assert_eq!(completed.status, RunConfigStatus::Completed);
        assert!(store.config_path("C:/git/maestro", "#37").exists());

        // On the wire: SCREAMING, like the sibling statuses (the frontend
        // and dependent issues consume this spelling).
        let raw: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(store.config_path("C:/git/maestro", "#37")).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["status"], "COMPLETED");

        // Idempotent on an already completed config.
        store.complete("C:/git/maestro", "#37").unwrap();
        // But an error when nothing exists to complete…
        assert!(store.complete("C:/git/maestro", "#99").is_err());
        // …and on an ARCHIVED (cleaned-up) config: never resurrect it.
        store.archive("C:/git/maestro", "#37").unwrap();
        assert!(store.complete("C:/git/maestro", "#37").is_err());
    }

    #[test]
    fn test_completed_leaves_active_scan_but_stays_unarchived() {
        // Issue #96: cold-start reconciliation iterates load_active() only —
        // a COMPLETED run must vanish from that scan (no respawn into a
        // finished worktree) while staying in the runs list until cleanup.
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        store.save(&sample("C:/git/alpha", "#1")).unwrap();
        store.save(&sample("C:/git/alpha", "#2")).unwrap();
        store.save(&sample("C:/git/alpha", "#3")).unwrap();
        store.complete("C:/git/alpha", "#2").unwrap();
        store.archive("C:/git/alpha", "#3").unwrap();

        let active: Vec<String> = store.load_active().into_iter().map(|c| c.epic).collect();
        assert_eq!(active, vec!["#1".to_string()]);

        let mut unarchived: Vec<String> = store
            .load_unarchived()
            .into_iter()
            .map(|c| c.epic)
            .collect();
        unarchived.sort();
        assert_eq!(unarchived, vec!["#1".to_string(), "#2".to_string()]);
    }

    #[test]
    fn test_pre_completed_era_config_still_reads_as_active() {
        // Backward compat (issue #96): a config written before COMPLETED
        // existed carries only ACTIVE/ARCHIVED — it must deserialize
        // unchanged and read as ACTIVE.
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        let path = store.config_path("C:/git/maestro", "#37");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r##"{
              "project_path": "C:/git/maestro",
              "epic": "#37",
              "repo_pin": null,
              "worktree_path": "C:/git/maestro-wt",
              "model": null,
              "thresholds": null,
              "status": "ACTIVE",
              "created_at": "2026-08-01T00:00:00+00:00"
            }"##,
        )
        .unwrap();

        let loaded = store.get("C:/git/maestro", "#37").unwrap();
        assert_eq!(loaded.status, RunConfigStatus::Active);
        assert_eq!(store.load_active().len(), 1);
        // Issue #91 backward compat: no `workflow` key on disk → None,
        // which `samurai_workflow::compiled_for_run` reads as the default
        // template.
        assert_eq!(loaded.workflow, None);
    }

    #[test]
    fn test_workflow_snapshot_roundtrips() {
        // Issue #91: the graph snapshotted at launch survives the save/get
        // roundtrip byte-identically, so successor briefs recompile exactly
        // the workflow the run launched with.
        let dir = tempdir().unwrap();
        let store = RunConfigStore::new(dir.path().to_path_buf());
        let mut config = sample("C:/git/maestro", "#37");
        let mut graph = WorkflowGraph::default();
        graph
            .nodes
            .iter_mut()
            .find(|n| n.id == "review")
            .unwrap()
            .text = "Custom review ritual".to_string();
        config.workflow = Some(graph.clone());

        store.save(&config).unwrap();
        let loaded = store.get("C:/git/maestro", "#37").unwrap();
        assert_eq!(loaded.workflow, Some(graph));
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
