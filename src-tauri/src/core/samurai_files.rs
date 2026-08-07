//! Samurai file inventory + guarded delete (issue #65; PRD §5.11, §8, §9).
//!
//! One listing of every Samurai-managed resource — handoff files, run
//! configs, pending timers, audit logs, journal + harvest reports — with
//! size, modified time, project/epic association and an `in_use` flag, plus
//! a delete that only ever touches paths inside the managed roots it
//! computed itself. The Second Brain Files panel (issue #66) is the consumer.
//!
//! **`in_use` semantics (issue #65):** an entry is in use when it is
//! referenced by an ACTIVE run config, a live (non-terminal) supervised
//! session, or a pending resume timer. Deleting an in-use file requires an
//! explicit `force` — the refusal is a structured error the UI can
//! distinguish by [`IN_USE_ERROR_PREFIX`] (string errors are the command
//! convention, so the structure is a fixed prefix, like the injector's
//! marker strings).
//!
//! **Path validation (fork convention):** every comparison happens on
//! `fs::canonicalize`d paths with the Windows `\\?\` extended-length prefix
//! stripped (`commands/ai_runner.rs::canonical_project_path` precedent) —
//! a traversal spelling (`..`), an 8.3 short name or a case variant all
//! resolve to the same on-disk identity before the roots check.
//!
//! This module stays tauri-free like its siblings: the command layer
//! (`commands/samurai.rs`) assembles the roots from
//! `commands::ai_runner::artifact_base_dir` and the managed stores; tests
//! root everything in tempdirs.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::samurai_audit::audit_file_name;
use super::samurai_prompts::epic_slug;
use super::samurai_run_config::{RunConfigStatus, SamuraiRunConfig};
use super::samurai_schedule::ScheduleEntry;
use super::supervisor::SessionSnapshot;

/// Fixed prefix of the "file is in use, pass `force`" refusal. The UI keys
/// its harder-confirm flow off this (PRD §5.11: "in-use files (active run)
/// get a harder confirm"). Mirrored as `SAMURAI_IN_USE_ERROR_PREFIX` in
/// `src/lib/samurai.ts` — keep the spellings identical.
pub const IN_USE_ERROR_PREFIX: &str = "IN_USE:";

/// What a listed file is (PRD §8 rows 1–5). SCREAMING on the wire like every
/// samurai sibling enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SamuraiFileKind {
    /// `.maestro/handoffs/*.md` in an epic worktree (PRD §8 row 1).
    Handoff,
    /// A per-epic run config JSON, ACTIVE or ARCHIVED (row 2).
    RunConfig,
    /// One pending resume timer inside `schedule.json` (row 3) — the `path`
    /// is the shared file, the row is the timer.
    Timer,
    /// A per-project audit JSONL (row 4 — user-deleted only by design).
    AuditLog,
    /// Phase 5 ops-journal file (row 5); listed once Phase 5 writes them.
    Journal,
    /// Phase 5 harvest report (row 5); listed once Phase 5 writes them.
    HarvestReport,
}

impl SamuraiFileKind {
    /// Stable presentation order (the PRD §8 table order) for the sort.
    fn order(self) -> u8 {
        match self {
            Self::Handoff => 0,
            Self::RunConfig => 1,
            Self::Timer => 2,
            Self::AuditLog => 3,
            Self::Journal => 4,
            Self::HarvestReport => 5,
        }
    }
}

/// One inventory row. snake_case on the wire like every samurai sibling.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SamuraiFileEntry {
    pub kind: SamuraiFileKind,
    /// Absolute path, `\\?\`-stripped. For [`SamuraiFileKind::Timer`] rows
    /// this is the shared `schedule.json`.
    pub path: String,
    pub size_bytes: u64,
    /// RFC 3339 UTC modified time; `None` when the filesystem reports none.
    pub modified_at: Option<String>,
    /// Owning project, when the association is known.
    pub project_path: Option<String>,
    /// Owning epic, when the association is known.
    pub epic: Option<String>,
    /// Referenced by an ACTIVE run config, a live supervised session, or a
    /// pending timer — deleting requires `force`.
    pub in_use: bool,
    /// [`SamuraiFileKind::Timer`] rows only: the RFC 3339 fire time, so the
    /// UI can render "resumes at 14:32" (PRD §5.11).
    pub fire_at: Option<String>,
}

/// The app-data roots the inventory scans. Assembled by the command layer
/// from `commands::ai_runner::artifact_base_dir` (the same roots the stores
/// themselves are constructed with in `lib.rs`); tests pass tempdirs.
pub struct SamuraiFilesRoots {
    /// `<app data>/audit` — per-project audit JSONL (`samurai_audit`).
    pub audit_dir: PathBuf,
    /// `<app data>/runs` — run configs (`samurai_run_config`).
    pub runs_dir: PathBuf,
    /// `<app data>/samurai` — `schedule.json` (`samurai_schedule`).
    pub samurai_dir: PathBuf,
    /// `<app data>/journal` — Phase 5 ops journal (PRD §5.12). Empty until
    /// Phase 5 lands; Phase 5 must write here to be inventoried.
    pub journal_dir: PathBuf,
    /// `<app data>/harvest` — Phase 5 harvest reports (PRD §5.12). Same.
    pub harvest_dir: PathBuf,
}

/// The handoff directory inside an epic worktree (PRD §6:
/// `.maestro/handoffs/`). Input may carry the `\\?\` prefix; the result is
/// stripped.
pub fn handoff_dir(worktree_path: &str) -> PathBuf {
    PathBuf::from(strip_prefix_str(worktree_path))
        .join(".maestro")
        .join("handoffs")
}

/// Every Samurai-managed file as one flat list (issue #65). Inputs are
/// snapshots the command layer takes from the managed stores: ALL run
/// configs (active + archived) with their on-disk paths, the pending
/// timers, and the supervised-session snapshots.
pub fn list_files(
    roots: &SamuraiFilesRoots,
    configs: &[(PathBuf, SamuraiRunConfig)],
    timers: &[ScheduleEntry],
    sessions: &[SessionSnapshot],
) -> Vec<SamuraiFileEntry> {
    let live = Liveness::compute(configs, timers, sessions);
    let mut entries: Vec<SamuraiFileEntry> = Vec::new();

    // 1. Handoffs: `.maestro/handoffs/*.md` in each epic worktree a run
    //    config points at. Archived configs keep their file (PRD §8 row 2),
    //    so completed epics' handoffs stay findable until cleanup.
    let mut seen_dirs: HashSet<PathBuf> = HashSet::new();
    for (_, config) in configs {
        let dir = handoff_dir(&config.worktree_path);
        if !seen_dirs.insert(dir.clone()) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&dir) else {
            // No handoff dir (worktree cleaned up, or none written yet) —
            // the normal case, not an error.
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some((size_bytes, modified_at)) = stat(&path) else {
                continue;
            };
            entries.push(SamuraiFileEntry {
                kind: SamuraiFileKind::Handoff,
                path: stripped(&path),
                size_bytes,
                modified_at,
                project_path: Some(config.project_path.clone()),
                epic: Some(config.epic.clone()),
                in_use: live.pair(&config.project_path, &config.epic),
                fire_at: None,
            });
        }
    }

    // 2. Run configs, ACTIVE and ARCHIVED. An ACTIVE config is in use by
    //    definition; an archived one only while a live session or pending
    //    timer still references its epic.
    for (path, config) in configs {
        let Some((size_bytes, modified_at)) = stat(path) else {
            continue;
        };
        entries.push(SamuraiFileEntry {
            kind: SamuraiFileKind::RunConfig,
            path: stripped(path),
            size_bytes,
            modified_at,
            project_path: Some(config.project_path.clone()),
            epic: Some(config.epic.clone()),
            in_use: config.status == RunConfigStatus::Active
                || live.pair(&config.project_path, &config.epic),
            fire_at: None,
        });
    }

    // 3. Pending timers: one row per timer, all sharing `schedule.json` as
    //    their path. Every listed timer is pending by definition → in use.
    let schedule_path = roots.samurai_dir.join("schedule.json");
    let schedule_stat = stat(&schedule_path);
    for timer in timers {
        let (size_bytes, modified_at) = schedule_stat.clone().unwrap_or((0, None));
        entries.push(SamuraiFileEntry {
            kind: SamuraiFileKind::Timer,
            path: stripped(&schedule_path),
            size_bytes,
            modified_at,
            project_path: Some(timer.project_path.clone()),
            epic: Some(timer.epic.clone()),
            in_use: true,
            fire_at: Some(timer.fire_at.clone()),
        });
    }

    // 4. Audit logs. The file name is `<sanitized>-<hash12>.jsonl` — the
    //    hash is one-way, so association is best-effort: every project the
    //    stores know about (any config/timer/session, live or not) is mapped
    //    to its expected file name; unmatched files list unassociated.
    let mut name_to_project: HashMap<String, String> = HashMap::new();
    for project in known_projects(configs, timers, sessions) {
        name_to_project.insert(audit_file_name(&project), project);
    }
    if let Ok(files) = std::fs::read_dir(&roots.audit_dir) {
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some((size_bytes, modified_at)) = stat(&path) else {
                continue;
            };
            let project = path
                .file_name()
                .and_then(|n| name_to_project.get(&n.to_string_lossy().to_string()))
                .cloned();
            let in_use = project.as_deref().is_some_and(|p| live.project(p));
            entries.push(SamuraiFileEntry {
                kind: SamuraiFileKind::AuditLog,
                path: stripped(&path),
                size_bytes,
                modified_at,
                project_path: project,
                epic: None,
                in_use,
                fire_at: None,
            });
        }
    }

    // 5. Journal + harvest reports (PRD §5.12 — Phase 5 writes them; the
    //    inventory lists whatever exists, so these stay empty until then).
    push_dir_files(&mut entries, &roots.journal_dir, SamuraiFileKind::Journal);
    push_dir_files(
        &mut entries,
        &roots.harvest_dir,
        SamuraiFileKind::HarvestReport,
    );

    entries.sort_by(|a, b| {
        (a.kind.order(), &a.path, &a.epic, &a.fire_at).cmp(&(
            b.kind.order(),
            &b.path,
            &b.epic,
            &b.fire_at,
        ))
    });
    entries
}

/// Deletes one managed file, guarded twice (issue #65):
///
/// 1. **Roots:** the canonicalized, `\\?\`-stripped target must live inside
///    a managed root computed HERE from the stores — the five app-data dirs
///    plus each run config's `.maestro/handoffs/` dir. Anything else is
///    refused. The caller's `path` never contributes a root.
/// 2. **In use:** a target matching an `in_use` inventory row is refused
///    without `force`, with an [`IN_USE_ERROR_PREFIX`]-prefixed error the UI
///    can distinguish for its harder confirm.
///
/// Never silent: a missing/unresolvable target, a directory, or a failed
/// remove all return the error (PRD §5.11 — delete is explicit and visible).
pub fn delete_file(
    roots: &SamuraiFilesRoots,
    configs: &[(PathBuf, SamuraiRunConfig)],
    entries: &[SamuraiFileEntry],
    path: &str,
    force: bool,
) -> Result<(), String> {
    let target = canonical_stripped(Path::new(path)).ok_or_else(|| {
        format!("cannot delete {path:?}: the file does not exist or cannot be resolved")
    })?;
    if !target.is_file() {
        return Err(format!(
            "refusing to delete {}: not a regular file",
            target.display()
        ));
    }

    let mut managed: Vec<PathBuf> = vec![
        roots.audit_dir.clone(),
        roots.runs_dir.clone(),
        roots.samurai_dir.clone(),
        roots.journal_dir.clone(),
        roots.harvest_dir.clone(),
    ];
    managed.extend(configs.iter().map(|(_, c)| handoff_dir(&c.worktree_path)));

    // A root that fails to canonicalize does not exist, and an existing
    // target cannot live under a non-existent root — skipping it is sound.
    let inside_managed = managed.iter().any(|root| {
        canonical_stripped(root).is_some_and(|root| target != root && target.starts_with(&root))
    });
    if !inside_managed {
        return Err(format!(
            "refusing to delete {}: the path is outside every Samurai-managed root",
            target.display()
        ));
    }

    if !force {
        let in_use = entries
            .iter()
            .filter(|e| e.in_use)
            .any(|e| canonical_stripped(Path::new(&e.path)).is_some_and(|p| p == target));
        if in_use {
            return Err(format!(
                "{IN_USE_ERROR_PREFIX} {} is in use (referenced by an active run config, a live \
                 supervised session, or a pending timer) — pass force to delete it anyway",
                target.display()
            ));
        }
    }

    std::fs::remove_file(&target).map_err(|e| format!("failed to delete {}: {e}", target.display()))
}

/// The liveness index behind `in_use`: (project, epic-slug) pairs and
/// projects referenced by an ACTIVE config, a pending timer, or a live
/// (non-terminal) supervised session. Slug identity, not raw spelling —
/// `#38` and `38` are the same epic everywhere else (worktree, handoffs,
/// config lookups), so they must be here too.
struct Liveness {
    pairs: HashSet<(String, String)>,
    projects: HashSet<String>,
}

impl Liveness {
    fn compute(
        configs: &[(PathBuf, SamuraiRunConfig)],
        timers: &[ScheduleEntry],
        sessions: &[SessionSnapshot],
    ) -> Self {
        let mut live = Self {
            pairs: HashSet::new(),
            projects: HashSet::new(),
        };
        for (_, config) in configs {
            if config.status == RunConfigStatus::Active {
                live.insert(&config.project_path, &config.epic);
            }
        }
        for timer in timers {
            live.insert(&timer.project_path, &timer.epic);
        }
        for session in sessions {
            if !session.state.is_terminal() {
                live.insert(&session.project, &session.epic);
            }
        }
        live
    }

    fn insert(&mut self, project: &str, epic: &str) {
        self.pairs.insert((project.to_string(), epic_slug(epic)));
        self.projects.insert(project.to_string());
    }

    fn pair(&self, project: &str, epic: &str) -> bool {
        self.pairs.contains(&(project.to_string(), epic_slug(epic)))
    }

    fn project(&self, project: &str) -> bool {
        self.projects.contains(project)
    }
}

/// Every project path any store snapshot mentions — for audit-file
/// association (NOT liveness: archived configs and terminal sessions still
/// name the project their audit file belongs to).
fn known_projects(
    configs: &[(PathBuf, SamuraiRunConfig)],
    timers: &[ScheduleEntry],
    sessions: &[SessionSnapshot],
) -> HashSet<String> {
    let mut projects: HashSet<String> = HashSet::new();
    projects.extend(configs.iter().map(|(_, c)| c.project_path.clone()));
    projects.extend(timers.iter().map(|t| t.project_path.clone()));
    projects.extend(sessions.iter().map(|s| s.project.clone()));
    projects
}

/// Lists every regular file directly under `dir` as `kind` rows (journal +
/// harvest — flat dirs, no association until Phase 5 defines their naming).
fn push_dir_files(entries: &mut Vec<SamuraiFileEntry>, dir: &Path, kind: SamuraiFileKind) {
    let Ok(files) = std::fs::read_dir(dir) else {
        return;
    };
    for file in files.flatten() {
        let path = file.path();
        if !path.is_file() {
            continue;
        }
        let Some((size_bytes, modified_at)) = stat(&path) else {
            continue;
        };
        entries.push(SamuraiFileEntry {
            kind,
            path: stripped(&path),
            size_bytes,
            modified_at,
            project_path: None,
            epic: None,
            in_use: false,
            fire_at: None,
        });
    }
}

/// Size + RFC 3339 modified time; `None` when the file cannot be stat'ed
/// (deleted between listing and stat — skip the row rather than lie).
fn stat(path: &Path) -> Option<(u64, Option<String>)> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());
    Some((meta.len(), modified))
}

/// `fs::canonicalize` + `\\?\` strip: the one true on-disk identity of a
/// path (resolves `..`, short names and case), per fork convention. `None`
/// when the path does not exist.
fn canonical_stripped(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    let s = canonical.to_string_lossy();
    Some(PathBuf::from(
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_string(),
    ))
}

/// Lossless `\\?\`-strip of a path for display/wire use (no canonicalize —
/// listing must not require every path to exist).
fn stripped(path: &Path) -> String {
    strip_prefix_str(&path.to_string_lossy()).to_string()
}

fn strip_prefix_str(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::samurai_run_config::RunConfigStore;
    use crate::core::supervisor::SupervisorState;
    use tempfile::{tempdir, TempDir};

    fn roots_in(base: &Path) -> SamuraiFilesRoots {
        SamuraiFilesRoots {
            audit_dir: base.join("audit"),
            runs_dir: base.join("runs"),
            samurai_dir: base.join("samurai"),
            journal_dir: base.join("journal"),
            harvest_dir: base.join("harvest"),
        }
    }

    /// A fake epic worktree with `.maestro/handoffs/` and the given files.
    fn worktree_with_handoffs(base: &Path, name: &str, files: &[&str]) -> PathBuf {
        let wt = base.join(name);
        let handoffs = wt.join(".maestro").join("handoffs");
        std::fs::create_dir_all(&handoffs).unwrap();
        for file in files {
            std::fs::write(handoffs.join(file), format!("# {file}\n")).unwrap();
        }
        wt
    }

    fn timer(project: &str, epic: &str, fire_at: &str) -> ScheduleEntry {
        ScheduleEntry {
            project_path: project.to_string(),
            epic: epic.to_string(),
            fire_at: fire_at.to_string(),
            reason: "park".to_string(),
        }
    }

    fn session(project: &str, epic: &str, state: SupervisorState) -> SessionSnapshot {
        SessionSnapshot {
            session_id: 1,
            project: project.to_string(),
            epic: epic.to_string(),
            generation: 1,
            state,
            previous_state: None,
            in_flight: None,
            ts: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// Writes `schedule.json` the way `samurai_schedule::persist` does, so
    /// the TIMER rows have a real file to stat.
    fn write_schedule(roots: &SamuraiFilesRoots, timers: &[ScheduleEntry]) {
        std::fs::create_dir_all(&roots.samurai_dir).unwrap();
        std::fs::write(
            roots.samurai_dir.join("schedule.json"),
            serde_json::to_string_pretty(timers).unwrap(),
        )
        .unwrap();
    }

    /// The full fixture behind most tests: one ACTIVE epic (`#9`, two
    /// handoffs), one ARCHIVED epic (`#7`), a pending `#9` timer, an audit
    /// file for the project plus an orphan one, and one harvest report.
    struct Fixture {
        base: TempDir,
        roots: SamuraiFilesRoots,
        store: RunConfigStore,
        project: String,
        timers: Vec<ScheduleEntry>,
    }

    fn fixture() -> Fixture {
        let base = tempdir().unwrap();
        let roots = roots_in(base.path());
        let store = RunConfigStore::new(roots.runs_dir.clone());
        let project = "C:/git/alpha".to_string();

        let wt9 = worktree_with_handoffs(base.path(), "wt-9", &["9-gen1.md", "9-gen2.md"]);
        // A non-md file in the handoff dir must be ignored by the listing.
        std::fs::write(wt9.join(".maestro/handoffs/notes.txt"), "not a handoff").unwrap();
        store
            .save(&SamuraiRunConfig::new(
                project.clone(),
                "#9",
                wt9.to_string_lossy().into_owned(),
            ))
            .unwrap();

        let wt7 = worktree_with_handoffs(base.path(), "wt-7", &["7-gen1.md"]);
        store
            .save(&SamuraiRunConfig::new(
                project.clone(),
                "#7",
                wt7.to_string_lossy().into_owned(),
            ))
            .unwrap();
        store.archive(&project, "#7").unwrap();

        let timers = vec![timer(&project, "#9", "2030-01-01T14:32:00+00:00")];
        write_schedule(&roots, &timers);

        std::fs::create_dir_all(&roots.audit_dir).unwrap();
        std::fs::write(
            roots.audit_dir.join(audit_file_name(&project)),
            "{\"ts\":\"t\"}\n",
        )
        .unwrap();
        std::fs::write(roots.audit_dir.join("orphan-000000000000.jsonl"), "{}\n").unwrap();

        std::fs::create_dir_all(&roots.harvest_dir).unwrap();
        std::fs::write(roots.harvest_dir.join("harvest-2026-08-07.md"), "# report").unwrap();

        Fixture {
            base,
            roots,
            store,
            project,
            timers,
        }
    }

    fn list(f: &Fixture, sessions: &[SessionSnapshot]) -> Vec<SamuraiFileEntry> {
        list_files(&f.roots, &f.store.list_with_paths(), &f.timers, sessions)
    }

    fn of_kind<'a>(
        entries: &'a [SamuraiFileEntry],
        kind: SamuraiFileKind,
    ) -> Vec<&'a SamuraiFileEntry> {
        entries.iter().filter(|e| e.kind == kind).collect()
    }

    #[test]
    fn test_inventory_lists_every_kind_with_shape() {
        let f = fixture();
        let entries = list(&f, &[]);

        // Handoffs: the three .md files across both worktrees; notes.txt is
        // ignored. Association comes from the owning config.
        let handoffs = of_kind(&entries, SamuraiFileKind::Handoff);
        assert_eq!(handoffs.len(), 3);
        assert!(handoffs.iter().all(|e| e.path.ends_with(".md")));
        assert!(handoffs
            .iter()
            .all(|e| e.project_path.as_deref() == Some(f.project.as_str())));
        let epic9: Vec<_> = handoffs
            .iter()
            .filter(|e| e.epic.as_deref() == Some("#9"))
            .collect();
        assert_eq!(epic9.len(), 2);

        // Run configs: both statuses listed.
        let configs = of_kind(&entries, SamuraiFileKind::RunConfig);
        assert_eq!(configs.len(), 2);

        // Timer: one row, path = schedule.json, fire time exposed for the
        // "resumes at 14:32" rendering.
        let timers = of_kind(&entries, SamuraiFileKind::Timer);
        assert_eq!(timers.len(), 1);
        assert!(timers[0].path.ends_with("schedule.json"));
        assert_eq!(
            timers[0].fire_at.as_deref(),
            Some("2030-01-01T14:32:00+00:00")
        );
        assert!(timers[0].size_bytes > 0);

        // Audit logs: the project's file is associated, the orphan is not.
        let audits = of_kind(&entries, SamuraiFileKind::AuditLog);
        assert_eq!(audits.len(), 2);
        let associated = audits
            .iter()
            .find(|e| e.project_path.is_some())
            .expect("the project's audit file must be associated");
        assert_eq!(associated.project_path.as_deref(), Some(f.project.as_str()));
        assert!(audits.iter().any(|e| e.project_path.is_none()));

        // Phase 5: harvest report listed, journal dir absent → empty.
        assert_eq!(of_kind(&entries, SamuraiFileKind::HarvestReport).len(), 1);
        assert!(of_kind(&entries, SamuraiFileKind::Journal).is_empty());

        // Every row carries size + RFC 3339 modified time and a stripped path.
        for e in &entries {
            assert!(!e.path.starts_with(r"\\?\"), "unstripped path: {}", e.path);
            let modified = e.modified_at.as_deref().expect("modified time reported");
            assert!(
                chrono::DateTime::parse_from_rfc3339(modified).is_ok(),
                "modified_at must be RFC 3339, got {modified:?}"
            );
        }

        // Wire shape: snake_case keys, SCREAMING kind — issue #66 consumes
        // this exact spelling.
        let raw = serde_json::to_value(&entries[0]).unwrap();
        for key in [
            "kind",
            "path",
            "size_bytes",
            "modified_at",
            "project_path",
            "epic",
            "in_use",
            "fire_at",
        ] {
            assert!(raw.get(key).is_some(), "missing key {key} in {raw}");
        }
        assert_eq!(raw["kind"], "HANDOFF");
    }

    #[test]
    fn test_in_use_marking() {
        let f = fixture();
        let entries = list(&f, &[]);

        // ACTIVE epic #9: its config, its handoffs, its timer row and the
        // project's audit log are all in use.
        for e in &entries {
            let epic9 = e.epic.as_deref() == Some("#9");
            let associated_audit = e.kind == SamuraiFileKind::AuditLog && e.project_path.is_some();
            if epic9 || associated_audit {
                assert!(e.in_use, "expected in_use: {e:?}");
            }
        }
        // ARCHIVED epic #7 (no session, no timer): config + handoff free.
        for e in &entries {
            if e.epic.as_deref() == Some("#7") {
                assert!(!e.in_use, "expected NOT in_use: {e:?}");
            }
        }
        // Orphan audit + harvest report: never in use.
        assert!(entries
            .iter()
            .filter(|e| e.kind == SamuraiFileKind::HarvestReport
                || (e.kind == SamuraiFileKind::AuditLog && e.project_path.is_none()))
            .all(|e| !e.in_use));

        // A live session on the archived epic flips it in-use — matched by
        // slug ("7" vs the config's "#7"), like every other samurai surface.
        let live = [session(&f.project, "7", SupervisorState::Working)];
        let entries = list(&f, &live);
        assert!(entries
            .iter()
            .filter(|e| e.epic.as_deref() == Some("#7"))
            .all(|e| e.in_use));

        // A terminal session does NOT.
        let parked = [session(&f.project, "7", SupervisorState::Parked)];
        let entries = list(&f, &parked);
        assert!(entries
            .iter()
            .filter(|e| e.epic.as_deref() == Some("#7"))
            .all(|e| !e.in_use));
    }

    #[test]
    fn test_delete_rejects_paths_outside_managed_roots() {
        let f = fixture();
        let entries = list(&f, &[]);
        let configs = f.store.list_with_paths();

        // A file that simply lives elsewhere.
        let outside_dir = f.base.path().join("elsewhere");
        std::fs::create_dir_all(&outside_dir).unwrap();
        let outside = outside_dir.join("evil.txt");
        std::fs::write(&outside, "keep me").unwrap();
        let err = delete_file(
            &f.roots,
            &configs,
            &entries,
            &outside.to_string_lossy(),
            true,
        )
        .unwrap_err();
        assert!(err.contains("outside"), "{err}");
        assert!(outside.exists());

        // A traversal spelling that STARTS inside a managed root must be
        // resolved before the check — `audit/../elsewhere/evil.txt` is the
        // same outside file.
        let traversal = f
            .roots
            .audit_dir
            .join("..")
            .join("elsewhere")
            .join("evil.txt");
        let err = delete_file(
            &f.roots,
            &configs,
            &entries,
            &traversal.to_string_lossy(),
            true,
        )
        .unwrap_err();
        assert!(err.contains("outside"), "{err}");
        assert!(outside.exists());

        // The epic WORKTREE is not a managed root — only its handoff dir is.
        let in_worktree = PathBuf::from(&configs[0].1.worktree_path).join("src-file.rs");
        std::fs::write(&in_worktree, "code").unwrap();
        let err = delete_file(
            &f.roots,
            &configs,
            &entries,
            &in_worktree.to_string_lossy(),
            true,
        )
        .unwrap_err();
        assert!(err.contains("outside"), "{err}");
        assert!(in_worktree.exists());

        // A directory inside a root is refused too — files only.
        let err = delete_file(
            &f.roots,
            &configs,
            &entries,
            &f.roots.audit_dir.to_string_lossy(),
            true,
        )
        .unwrap_err();
        assert!(
            err.contains("not a regular file") || err.contains("outside"),
            "{err}"
        );

        // A missing file errors — never a silent no-op.
        let missing = f.roots.audit_dir.join("never-existed.jsonl");
        let err = delete_file(
            &f.roots,
            &configs,
            &entries,
            &missing.to_string_lossy(),
            true,
        )
        .unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }

    #[test]
    fn test_guarded_delete_in_use_requires_force() {
        let f = fixture();
        let entries = list(&f, &[]);
        let configs = f.store.list_with_paths();

        // An in-use handoff (ACTIVE epic #9): refused without force, with
        // the structured prefix the UI keys its harder confirm off.
        let handoff = entries
            .iter()
            .find(|e| e.kind == SamuraiFileKind::Handoff && e.in_use)
            .expect("fixture has in-use handoffs");
        let err = delete_file(&f.roots, &configs, &entries, &handoff.path, false).unwrap_err();
        assert!(err.starts_with(IN_USE_ERROR_PREFIX), "{err}");
        assert!(Path::new(&handoff.path).exists(), "refusal must not delete");

        // force=true deletes it.
        delete_file(&f.roots, &configs, &entries, &handoff.path, true).unwrap();
        assert!(!Path::new(&handoff.path).exists());

        // schedule.json holds a pending timer → in use → same guard.
        let schedule = f.roots.samurai_dir.join("schedule.json");
        let err = delete_file(
            &f.roots,
            &configs,
            &entries,
            &schedule.to_string_lossy(),
            false,
        )
        .unwrap_err();
        assert!(err.starts_with(IN_USE_ERROR_PREFIX), "{err}");
        assert!(schedule.exists());
    }

    #[test]
    fn test_delete_not_in_use_needs_no_force() {
        let f = fixture();
        let entries = list(&f, &[]);
        let configs = f.store.list_with_paths();

        // The ARCHIVED #7 run config is not in use — plain delete works.
        let archived = entries
            .iter()
            .find(|e| e.kind == SamuraiFileKind::RunConfig && !e.in_use)
            .expect("fixture has an archived config");
        assert_eq!(archived.epic.as_deref(), Some("#7"));
        delete_file(&f.roots, &configs, &entries, &archived.path, false).unwrap();
        assert!(!Path::new(&archived.path).exists());

        // So does the harvest report.
        let harvest = entries
            .iter()
            .find(|e| e.kind == SamuraiFileKind::HarvestReport)
            .unwrap();
        delete_file(&f.roots, &configs, &entries, &harvest.path, false).unwrap();
        assert!(!Path::new(&harvest.path).exists());
    }

    #[test]
    fn test_handoff_dir_strips_extended_prefix() {
        let dir = handoff_dir(r"\\?\C:\wt\epic-9");
        assert_eq!(
            dir,
            PathBuf::from(r"C:\wt\epic-9")
                .join(".maestro")
                .join("handoffs")
        );
        assert_eq!(
            handoff_dir("C:/wt/epic-9"),
            PathBuf::from("C:/wt/epic-9")
                .join(".maestro")
                .join("handoffs")
        );
    }
}
