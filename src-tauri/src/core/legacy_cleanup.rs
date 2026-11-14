//! One-time cleanup of what Samurai left on disk (issue #615).
//!
//! Samurai is gone from Maestro; its files are not. On the first start of a
//! version without it, this module removes them wherever no work can be lost,
//! once (a marker in Maestro's data folder records that it ran), and reports
//! the run worktrees it kept so the person can be told where they are.
//!
//! **Fail closed.** Only the exact paths named below are touched; anything
//! that is a link (symlink or Windows junction), or holds one, is left alone
//! so a delete can never reach outside the folder it was aimed at; nothing is
//! force-deleted (a file that will not go stays, and `git worktree remove`
//! runs without `--force`); one failed item is logged and the rest still runs.
//!
//! - **Maestro's data folder:** `audit/`, `journal/`, `harvest/`,
//!   `samurai/schedule.json`, `samurai/latches.json`, and the per-project run
//!   records `runs/<project-key>/` (never `runs/pr/`, which PR review uses).
//! - **The settings folder:** `samurai-config.json`, `samurai-workflow.json`.
//! - **Each project a run record names:** `.maestro/handoffs/`
//!   (`.maestro/briefs/` stays: PR review uses it).
//! - **Each run worktree a run record names:** removed only when its commit is
//!   already on the project's default branch and it has no uncommitted or
//!   untracked files; any other is kept untouched and reported.
//!
//! The paths are the ones the Samurai code wrote before it was deleted
//! (`samurai_files_roots`, `samurai_run_config` and `samurai_files` in git
//! history at 30c9ac5^).

use std::collections::BTreeSet;
use std::fs::Metadata;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::extended_paths::{canonical_stripped, strip_extended_length};
use super::pr_runs::{PrRunStore, PR_RUNS_DIR};
use crate::git::{Git, GitError};

/// Written in the data folder once the cleanup has run; its presence makes
/// every later start skip the cleanup.
pub const MARKER_FILE: &str = "samurai-cleanup-done";

/// Samurai-only folders directly inside the data folder.
const DATA_DIRS: [&str; 3] = ["audit", "journal", "harvest"];
/// The Samurai folder in the data folder, and the two files deleted from it.
const SAMURAI_DIR: &str = "samurai";
const SAMURAI_FILES: [&str; 2] = ["schedule.json", "latches.json"];
/// Samurai's settings files in the settings folder.
const SETTINGS_FILES: [&str; 2] = ["samurai-config.json", "samurai-workflow.json"];
/// The run records' folder in the data folder.
const RUNS_DIR: &str = "runs";
/// The hand-over folder inside a project, as path components.
const MAESTRO_DIR: &str = ".maestro";
const HANDOFFS_DIR: &str = "handoffs";
/// Length of the hash at the end of a run-record folder name.
const PROJECT_KEY_HASH_LEN: usize = 12;

/// Where the cleanup looks: Maestro's data folder (`artifact_base_dir`'s
/// parent) and the settings folder the store plugin writes to, when known.
#[derive(Debug, Clone)]
pub struct CleanupRoots {
    pub data_dir: PathBuf,
    pub settings_dir: Option<PathBuf>,
}

/// A run worktree the cleanup did not remove, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeptWorktree {
    pub path: String,
    pub reasons: Vec<String>,
}

/// Why a run worktree was kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeepReason {
    UnmergedCommits,
    UncommittedFiles,
    UsedByPrReview,
    ContainsLink,
    NotAWorktree,
    CheckFailed,
    RemoveFailed,
}

impl KeepReason {
    fn text(self) -> &'static str {
        match self {
            Self::UnmergedCommits => "unmerged commits",
            Self::UncommittedFiles => "uncommitted files",
            Self::UsedByPrReview => "used by a PR review",
            Self::ContainsLink => "contains a link to another folder",
            Self::NotAWorktree => "not a git worktree of its project",
            Self::CheckFailed => "could not be checked with git",
            Self::RemoveFailed => "git could not remove it",
        }
    }
}

/// The two fields of a Samurai run record the cleanup needs.
#[derive(Debug, Deserialize)]
struct RunRecord {
    project_path: String,
    worktree_path: String,
}

/// Runs the cleanup unless the marker says it already ran, and returns the
/// run worktrees it kept. Never fails: every error is logged and skipped.
pub async fn run_once(roots: &CleanupRoots) -> Vec<KeptWorktree> {
    let marker = roots.data_dir.join(MARKER_FILE);
    if marker.exists() {
        return Vec::new();
    }
    log::info!("samurai cleanup: first start without Samurai, removing its leftovers");

    let runs_dir = roots.data_dir.join(RUNS_DIR);
    let record_dirs = run_record_dirs(&runs_dir);
    let records = read_run_records(&record_dirs);
    let pr_review_paths = pr_review_paths(&runs_dir);

    let mut kept = Vec::new();
    let mut seen = BTreeSet::new();
    for record in &records {
        if !seen.insert((record.project_path.clone(), record.worktree_path.clone())) {
            continue;
        }
        if let Some(reasons) = clean_up_worktree(record, &pr_review_paths).await {
            log::info!(
                "samurai cleanup: kept run worktree {} ({})",
                record.worktree_path,
                reasons.join(", ")
            );
            kept.push(KeptWorktree {
                path: record.worktree_path.clone(),
                reasons,
            });
        }
    }

    let projects: BTreeSet<&str> = records.iter().map(|r| r.project_path.as_str()).collect();
    for project in projects {
        remove_handoffs(Path::new(project));
    }

    for dir in DATA_DIRS {
        remove_tree(&roots.data_dir.join(dir));
    }
    let samurai_dir = roots.data_dir.join(SAMURAI_DIR);
    for file in SAMURAI_FILES {
        remove_file(&samurai_dir.join(file));
    }
    // Only an EMPTY folder goes; anything else left in it stays.
    let _ = std::fs::remove_dir(&samurai_dir);
    for dir in &record_dirs {
        remove_tree(dir);
    }
    if let Some(settings_dir) = &roots.settings_dir {
        for file in SETTINGS_FILES {
            remove_file(&settings_dir.join(file));
        }
    }

    write_marker(&roots.data_dir, &marker);
    kept
}

/// The run-record folders under `runs/`: every real folder named like a
/// Samurai project key (`<name>-<12 hex>`), never `pr/`.
fn run_record_dirs(runs_dir: &Path) -> Vec<PathBuf> {
    let entries = match std::fs::read_dir(runs_dir) {
        Ok(entries) => entries,
        Err(e) => {
            if e.kind() != io::ErrorKind::NotFound {
                log::warn!("samurai cleanup: cannot list {}: {e}", runs_dir.display());
            }
            return Vec::new();
        }
    };
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name != PR_RUNS_DIR && is_project_key(&name)
        })
        .filter(|entry| {
            std::fs::symlink_metadata(entry.path())
                .map(|meta| meta.is_dir() && !is_link(&meta))
                .unwrap_or(false)
        })
        .map(|entry| entry.path())
        .collect()
}

/// `<name>-<12 lowercase hex>`, the shape Samurai named a project's run-record
/// folder with: name chars are lowercase ASCII letters, digits, `-` and `_`.
fn is_project_key(name: &str) -> bool {
    let Some((stem, hash)) = name.rsplit_once('-') else {
        return false;
    };
    !stem.is_empty()
        && stem
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        && hash.len() == PROJECT_KEY_HASH_LEN
        && hash
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// Every run record in the given folders that parses; the rest are logged.
fn read_run_records(dirs: &[PathBuf]) -> Vec<RunRecord> {
    let mut records = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for path in entries.flatten().map(|e| e.path()) {
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let parsed = std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|text| {
                    serde_json::from_str::<RunRecord>(&text).map_err(|e| e.to_string())
                });
            match parsed {
                Ok(record) => records.push(record),
                Err(e) => log::warn!(
                    "samurai cleanup: skipping unreadable run record {}: {e}",
                    path.display()
                ),
            }
        }
    }
    records
}

/// Folders a PR review record points at; a run worktree among them is kept.
fn pr_review_paths(runs_dir: &Path) -> Vec<String> {
    PrRunStore::new(runs_dir.to_path_buf())
        .list_with_paths()
        .into_iter()
        .flat_map(|(_, run)| std::iter::once(run.project_path).chain(run.brief_root))
        .collect()
}

/// Removes one run worktree when that loses nothing. `None` when it was
/// removed or there is nothing to keep (already gone, or it is the project's
/// own checkout); otherwise the reasons it was kept.
async fn clean_up_worktree(record: &RunRecord, pr_review_paths: &[String]) -> Option<Vec<String>> {
    let worktree = PathBuf::from(strip_extended_length(&record.worktree_path));
    match std::fs::symlink_metadata(&worktree) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
        Err(_) => return Some(reasons(&[KeepReason::CheckFailed])),
        Ok(meta) if is_link(&meta) => return Some(reasons(&[KeepReason::ContainsLink])),
        Ok(_) => {}
    }
    let project = Git::new(strip_extended_length(&record.project_path));
    let Ok(listed) = project.worktree_list().await else {
        return Some(reasons(&[KeepReason::CheckFailed]));
    };
    let Some(entry) = listed
        .iter()
        .find(|w| same_path(Path::new(&w.path), &worktree))
    else {
        return Some(reasons(&[KeepReason::NotAWorktree]));
    };
    if entry.is_main_worktree {
        return None;
    }
    if pr_review_paths
        .iter()
        .any(|p| same_path(Path::new(&strip_extended_length(p)), &worktree))
    {
        return Some(reasons(&[KeepReason::UsedByPrReview]));
    }

    let mut found = Vec::new();
    match is_on_default_branch(&project, &entry.head).await {
        Ok(true) => {}
        Ok(false) => found.push(KeepReason::UnmergedCommits),
        Err(()) => found.push(KeepReason::CheckFailed),
    }
    match Git::new(&worktree)
        .run(&["status", "--porcelain", "--untracked-files=all"])
        .await
    {
        Ok(out) if out.trimmed().is_empty() => {}
        Ok(_) => found.push(KeepReason::UncommittedFiles),
        Err(_) => found.push(KeepReason::CheckFailed),
    }
    if !found.is_empty() {
        found.dedup();
        return Some(reasons(&found));
    }
    if contains_link(&worktree) {
        return Some(reasons(&[KeepReason::ContainsLink]));
    }
    // No `--force`: git refuses a worktree that is dirty or locked.
    match project.worktree_remove(&worktree, false).await {
        Ok(()) => {
            log::info!("samurai cleanup: removed merged run worktree {}", worktree.display());
            None
        }
        Err(e) => {
            log::warn!("samurai cleanup: could not remove {}: {e}", worktree.display());
            Some(reasons(&[KeepReason::RemoveFailed]))
        }
    }
}

fn reasons(list: &[KeepReason]) -> Vec<String> {
    list.iter().map(|r| r.text().to_string()).collect()
}

/// Whether `head` is already contained in the project's default branch, local
/// or `origin`'s. `Err` when no default branch can be found or git fails.
async fn is_on_default_branch(project: &Git, head: &str) -> Result<bool, ()> {
    if head.is_empty() {
        return Err(());
    }
    let refs = default_branch_refs(project).await;
    if refs.is_empty() {
        return Err(());
    }
    for target in &refs {
        match project
            .run(&["merge-base", "--is-ancestor", head, target])
            .await
        {
            Ok(_) => return Ok(true),
            Err(GitError::CommandFailed { code: 1, .. }) => {}
            Err(_) => return Err(()),
        }
    }
    Ok(false)
}

/// The refs that hold the default branch: `origin/HEAD`'s target, else `main`,
/// else `master`; as a local branch and as `origin`'s, whichever exist.
async fn default_branch_refs(project: &Git) -> Vec<String> {
    let from_origin = project
        .run(&["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
        .await
        .ok()
        .and_then(|out| out.trimmed().strip_prefix("origin/").map(str::to_string));
    let mut name = from_origin;
    if name.is_none() {
        for candidate in ["main", "master"] {
            if ref_exists(project, &format!("refs/heads/{candidate}")).await {
                name = Some(candidate.to_string());
                break;
            }
        }
    }
    let Some(name) = name else {
        return Vec::new();
    };
    let mut refs = Vec::new();
    for candidate in [
        format!("refs/heads/{name}"),
        format!("refs/remotes/origin/{name}"),
    ] {
        if ref_exists(project, &candidate).await {
            refs.push(candidate);
        }
    }
    refs
}

async fn ref_exists(project: &Git, reference: &str) -> bool {
    project
        .run(&["rev-parse", "--verify", "--quiet", reference])
        .await
        .is_ok()
}

/// Removes `<project>/.maestro/handoffs/` unless a link is on the way.
fn remove_handoffs(project: &Path) {
    let maestro = PathBuf::from(strip_extended_length(&project.to_string_lossy())).join(MAESTRO_DIR);
    match std::fs::symlink_metadata(&maestro) {
        Ok(meta) if meta.is_dir() && !is_link(&meta) => remove_tree(&maestro.join(HANDOFFS_DIR)),
        Ok(_) => log::warn!(
            "samurai cleanup: {} is not a plain folder, leaving it alone",
            maestro.display()
        ),
        Err(_) => {}
    }
}

/// Deletes a folder and everything in it, unless it is a link or holds one.
fn remove_tree(dir: &Path) {
    let meta = match std::fs::symlink_metadata(dir) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!("samurai cleanup: cannot inspect {}: {e}", dir.display());
            return;
        }
    };
    if is_link(&meta) || !meta.is_dir() || contains_link(dir) {
        log::warn!(
            "samurai cleanup: {} is not a plain folder or holds a link, leaving it alone",
            dir.display()
        );
        return;
    }
    match std::fs::remove_dir_all(dir) {
        Ok(()) => log::info!("samurai cleanup: removed {}", dir.display()),
        Err(e) => log::warn!("samurai cleanup: could not remove {}: {e}", dir.display()),
    }
}

/// Deletes one plain file; a link, a folder or a file that will not go stays.
fn remove_file(file: &Path) {
    let meta = match std::fs::symlink_metadata(file) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!("samurai cleanup: cannot inspect {}: {e}", file.display());
            return;
        }
    };
    if is_link(&meta) || !meta.is_file() {
        log::warn!(
            "samurai cleanup: {} is not a plain file, leaving it alone",
            file.display()
        );
        return;
    }
    match std::fs::remove_file(file) {
        Ok(()) => log::info!("samurai cleanup: removed {}", file.display()),
        Err(e) => log::warn!("samurai cleanup: could not remove {}: {e}", file.display()),
    }
}

/// Whether anything under `root` is a link. An unreadable entry counts as one:
/// what cannot be inspected is never deleted.
fn contains_link(root: &Path) -> bool {
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return true;
        };
        for entry in entries {
            let Ok(path) = entry.map(|e| e.path()) else {
                return true;
            };
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                return true;
            };
            if is_link(&meta) {
                return true;
            }
            if meta.is_dir() {
                pending.push(path);
            }
        }
    }
    false
}

/// A symlink, or on Windows any reparse point (junctions included).
fn is_link(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

/// Whether two paths name the same folder on disk.
fn same_path(a: &Path, b: &Path) -> bool {
    match (canonical_stripped(a), canonical_stripped(b)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn write_marker(data_dir: &Path, marker: &Path) {
    let stamp = chrono::Utc::now().to_rfc3339();
    let written = std::fs::create_dir_all(data_dir).and_then(|()| std::fs::write(marker, stamp));
    if let Err(e) = written {
        log::warn!(
            "samurai cleanup: could not write {} ({e}); it will run again next start",
            marker.display()
        );
    }
}

/// Hands the kept worktrees from the background cleanup to the front end,
/// whichever of the two is ready first.
pub struct CleanupNotice {
    kept: watch::Sender<Option<Vec<KeptWorktree>>>,
}

impl Default for CleanupNotice {
    fn default() -> Self {
        Self {
            kept: watch::channel(None).0,
        }
    }
}

impl CleanupNotice {
    pub fn publish(&self, kept: Vec<KeptWorktree>) {
        self.kept.send_replace(Some(kept));
    }

    /// Waits for the cleanup to finish and returns what it kept.
    pub async fn wait(&self) -> Vec<KeptWorktree> {
        let mut rx = self.kept.subscribe();
        let kept = match rx.wait_for(Option::is_some).await {
            Ok(kept) => kept.clone().unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        kept
    }
}

/// The run worktrees the one-time cleanup kept, once it has finished; empty
/// when nothing was kept or the cleanup ran on an earlier start.
#[tauri::command]
pub async fn samurai_cleanup_kept_worktrees(
    notice: tauri::State<'_, std::sync::Arc<CleanupNotice>>,
) -> Result<Vec<KeptWorktree>, String> {
    Ok(notice.wait().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    use tempfile::TempDir;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn run_record(dir: &Path, name: &str, project: &Path, worktree: &Path) {
        let record = serde_json::json!({
            "project_path": project.to_string_lossy(),
            "epic": name,
            "worktree_path": worktree.to_string_lossy(),
            "status": "ACTIVE",
            "created_at": "2026-11-01T00:00:00Z",
        });
        write(&dir.join(format!("{name}.json")), &record.to_string());
    }

    fn roots(data: &TempDir, settings: &TempDir) -> CleanupRoots {
        CleanupRoots {
            data_dir: data.path().to_path_buf(),
            settings_dir: Some(settings.path().to_path_buf()),
        }
    }

    async fn git(dir: &Path, args: &[&str]) {
        Git::new(dir).run(args).await.unwrap();
    }

    async fn repo(root: &Path) -> PathBuf {
        let repo = root.join("project");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]).await;
        git(&repo, &["config", "user.email", "test@example.com"]).await;
        git(&repo, &["config", "user.name", "Test"]).await;
        write(&repo.join("README.md"), "# test\n");
        git(&repo, &["add", "README.md"]).await;
        git(&repo, &["commit", "-m", "initial"]).await;
        repo
    }

    /// A folder link: a symlink on Unix, a junction on Windows.
    fn make_dir_link(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap()
                .status;
            assert!(status.success(), "mklink /J failed");
        }
    }

    #[tokio::test]
    async fn deletes_the_samurai_files_and_keeps_pr_review_data() {
        let data = TempDir::new().unwrap();
        let settings = TempDir::new().unwrap();
        let projects = TempDir::new().unwrap();
        let project = projects.path().join("app");
        let d = data.path();
        let record_dir = d.join("runs").join("app-0123456789ab");
        run_record(&record_dir, "37", &project, &projects.path().join("gone-wt"));
        for file in [
            "audit/app-0123456789ab.jsonl",
            "journal/journal.jsonl",
            "harvest/2026-11-01.md",
            "samurai/schedule.json",
            "samurai/latches.json",
            "runs/pr/o-r-142.json",
            "runs/notes/keep.txt",
            "work-journal/entry.md",
            "worktrees/app-1/file.txt",
        ] {
            write(&d.join(file), "x");
        }
        for file in ["samurai-config.json", "samurai-workflow.json", "maestro-0123456789ab.json"] {
            write(&settings.path().join(file), "{}");
        }
        write(&project.join(".maestro/handoffs/37-gen2.md"), "handoff");
        write(&project.join(".maestro/briefs/pr-142.md"), "brief");

        let kept = run_once(&roots(&data, &settings)).await;

        assert!(kept.is_empty());
        for gone in ["audit", "journal", "harvest", "samurai", "runs/app-0123456789ab"] {
            assert!(!d.join(gone).exists(), "{gone} should be deleted");
        }
        for stays in [
            "runs/pr/o-r-142.json",
            "runs/notes/keep.txt",
            "work-journal/entry.md",
            "worktrees/app-1/file.txt",
            MARKER_FILE,
        ] {
            assert!(d.join(stays).exists(), "{stays} should stay");
        }
        assert!(!settings.path().join("samurai-config.json").exists());
        assert!(!settings.path().join("samurai-workflow.json").exists());
        assert!(settings.path().join("maestro-0123456789ab.json").exists());
        assert!(!project.join(".maestro/handoffs").exists());
        assert!(project.join(".maestro/briefs/pr-142.md").exists());
    }

    #[tokio::test]
    async fn removes_only_the_merged_clean_run_worktree_and_reports_the_rest() {
        let data = TempDir::new().unwrap();
        let settings = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let project = repo(root.path()).await;
        let record_dir = data.path().join("runs").join("project-0123456789ab");
        let wt = |name: &str| root.path().join(name);
        for name in ["merged", "unmerged", "dirty"] {
            let path = wt(name).to_string_lossy().into_owned();
            git(&project, &["worktree", "add", "-b", name, &path]).await;
            run_record(&record_dir, name, &project, &wt(name));
        }
        write(&wt("unmerged").join("work.txt"), "work\n");
        git(&wt("unmerged"), &["add", "work.txt"]).await;
        git(&wt("unmerged"), &["commit", "-m", "work"]).await;
        write(&wt("dirty").join("draft.txt"), "draft\n");

        let mut kept = run_once(&roots(&data, &settings)).await;
        kept.sort_by(|a, b| a.path.cmp(&b.path));

        assert!(!wt("merged").exists(), "the merged clean worktree is removed");
        assert!(wt("unmerged").join("work.txt").exists());
        assert!(wt("dirty").join("draft.txt").exists());
        assert_eq!(
            kept,
            vec![
                KeptWorktree {
                    path: wt("dirty").to_string_lossy().into_owned(),
                    reasons: vec!["uncommitted files".to_string()],
                },
                KeptWorktree {
                    path: wt("unmerged").to_string_lossy().into_owned(),
                    reasons: vec!["unmerged commits".to_string()],
                },
            ]
        );
    }

    #[tokio::test]
    async fn a_second_start_does_nothing() {
        let data = TempDir::new().unwrap();
        let settings = TempDir::new().unwrap();
        run_once(&roots(&data, &settings)).await;
        write(&data.path().join("audit/new.jsonl"), "x");

        let kept = run_once(&roots(&data, &settings)).await;

        assert!(kept.is_empty());
        assert!(data.path().join("audit/new.jsonl").exists());
    }

    #[tokio::test]
    async fn a_failed_item_is_logged_and_the_rest_still_runs() {
        let data = TempDir::new().unwrap();
        let settings = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let d = data.path();
        // A folder where a file is expected: never force-deleted.
        std::fs::create_dir_all(d.join("samurai/schedule.json/inner")).unwrap();
        // A run worktree whose project is not a git repository.
        let not_a_repo = root.path().join("plain");
        let worktree = root.path().join("plain-wt");
        std::fs::create_dir_all(&not_a_repo).unwrap();
        write(&worktree.join("file.txt"), "x");
        run_record(&d.join("runs/plain-0123456789ab"), "1", &not_a_repo, &worktree);
        write(&d.join("audit/a.jsonl"), "x");
        write(&d.join("samurai/latches.json"), "{}");

        let kept = run_once(&roots(&data, &settings)).await;

        assert!(d.join("samurai/schedule.json/inner").exists());
        assert!(worktree.join("file.txt").exists());
        assert_eq!(kept[0].reasons, vec!["could not be checked with git".to_string()]);
        assert!(!d.join("audit").exists());
        assert!(!d.join("samurai/latches.json").exists());
        assert!(d.join(MARKER_FILE).exists());
    }

    #[tokio::test]
    async fn never_follows_a_link_out_of_the_data_folder() {
        let data = TempDir::new().unwrap();
        let settings = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        write(&outside.path().join("precious.txt"), "keep me");
        std::fs::create_dir_all(data.path().join("audit")).unwrap();
        make_dir_link(outside.path(), &data.path().join("audit").join("escape"));

        run_once(&roots(&data, &settings)).await;

        assert!(outside.path().join("precious.txt").exists());
    }
}
