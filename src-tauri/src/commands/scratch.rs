//! Scratch projects (PRD §4.10): throwaway project folders for work that
//! belongs to no real project. Each one is a plain folder (never a git
//! repository) directly inside the scratch folder, which defaults to
//! `Maestro Scratch` in the home folder and can be changed in Settings.
//!
//! Three commands: make one, list them (name and age), and delete one. Delete
//! refuses any path that is not a direct subfolder of the scratch folder, so a
//! bad path from the front end can never remove anything else.

use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use directories::BaseDirs;
use serde::Serialize;

use crate::core::samurai_files::canonical_stripped;

/// The scratch folder's name inside the home folder when Settings names none.
pub const DEFAULT_SCRATCH_FOLDER_NAME: &str = "Maestro Scratch";

/// Longest scratch project name, in characters.
const MAX_NAME_CHARS: usize = 100;

/// Characters no folder name may hold on Windows; refused on every OS so a
/// scratch folder made on one computer can be copied to any other.
const FORBIDDEN_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Names Windows keeps for devices, with or without an extension.
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// How many times delete tries again when a file is still held open (a
/// terminal that was just closed can keep its folder busy for a moment).
const DELETE_ATTEMPTS: u32 = 10;

/// Pause between two delete attempts.
const DELETE_RETRY_PAUSE: Duration = Duration::from_millis(200);

/// Everything scratch projects can fail on, sent to the front end as one plain
/// sentence it shows as is.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ScratchError {
    #[error("Type a name for the scratch project.")]
    EmptyName,
    #[error("A name can't contain < > : \" / \\ | ? * or control characters.")]
    ForbiddenCharacters,
    #[error("A name can't be . or .., or end with a dot.")]
    BadDots,
    #[error("\"{0}\" is a name Windows keeps for itself; pick another.")]
    ReservedName(String),
    #[error("A name can be at most 100 characters long.")]
    TooLong,
    #[error("A scratch project named \"{0}\" already exists.")]
    AlreadyExists(String),
    #[error("Maestro can't find your home folder; choose a scratch folder in Settings.")]
    NoHomeFolder,
    #[error("The scratch folder must be a full path.")]
    RelativeFolder,
    #[error("Only a folder directly inside the scratch folder can be deleted.")]
    OutsideScratchFolder,
    #[error("That scratch project no longer exists.")]
    Missing,
    #[error("{0}")]
    Io(String),
}

impl Serialize for ScratchError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<std::io::Error> for ScratchError {
    fn from(err: std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::NotFound {
            ScratchError::Missing
        } else {
            ScratchError::Io(err.to_string())
        }
    }
}

/// One scratch project as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchProject {
    pub name: String,
    /// Absolute path: the scratch folder joined with the name.
    pub path: String,
    /// When the folder was made (its last change where the OS keeps no
    /// creation time), in milliseconds since 1970.
    pub created_at_ms: u64,
}

/// The scratch folder in use and every scratch project in it, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchListing {
    pub folder: String,
    pub projects: Vec<ScratchProject>,
}

/// The scratch folder: the one Settings names, else `Maestro Scratch` in
/// `home`. A blank setting counts as none.
fn resolve_folder(setting: Option<&str>, home: Option<&Path>) -> Result<PathBuf, ScratchError> {
    match setting.map(str::trim).filter(|s| !s.is_empty()) {
        Some(folder) => {
            let path = PathBuf::from(folder);
            if path.is_absolute() {
                Ok(path)
            } else {
                Err(ScratchError::RelativeFolder)
            }
        }
        None => home
            .map(|h| h.join(DEFAULT_SCRATCH_FOLDER_NAME))
            .ok_or(ScratchError::NoHomeFolder),
    }
}

/// The scratch folder for a command, using the real home folder.
fn scratch_folder(setting: Option<&str>) -> Result<PathBuf, ScratchError> {
    let base_dirs = BaseDirs::new();
    resolve_folder(setting, base_dirs.as_ref().map(|d| d.home_dir()))
}

/// The typed name, trimmed, when it is a folder name every OS accepts.
fn validate_name(raw: &str) -> Result<String, ScratchError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(ScratchError::EmptyName);
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(ScratchError::TooLong);
    }
    if name
        .chars()
        .any(|c| c.is_control() || FORBIDDEN_CHARS.contains(&c))
    {
        return Err(ScratchError::ForbiddenCharacters);
    }
    if name.ends_with('.') {
        return Err(ScratchError::BadDots);
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    if RESERVED_NAMES.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return Err(ScratchError::ReservedName(name.to_string()));
    }
    Ok(name.to_string())
}

/// Makes the plain folder `name` inside `root` (creating `root` on first use)
/// and returns its path. A name already taken, in any letter case, is refused.
fn create_in(root: &Path, raw_name: &str) -> Result<PathBuf, ScratchError> {
    let name = validate_name(raw_name)?;
    std::fs::create_dir_all(root)?;
    let taken = std::fs::read_dir(root)?
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(&name)
        });
    if taken {
        return Err(ScratchError::AlreadyExists(name));
    }
    let target = root.join(&name);
    match std::fs::create_dir(&target) {
        Ok(()) => Ok(target),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(ScratchError::AlreadyExists(name))
        }
        Err(err) => Err(err.into()),
    }
}

/// Milliseconds since 1970 for a file time; 0 when the OS gives none.
fn millis_since_epoch(time: std::io::Result<SystemTime>) -> u64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Every folder directly inside `root`, newest first. A scratch folder that
/// does not exist yet simply holds none. Files and links are left out.
fn list_in(root: &Path) -> Result<Vec<ScratchProject>, ScratchError> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };
    let mut projects: Vec<ScratchProject> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| {
            let metadata = entry.metadata().ok();
            let created_at_ms = metadata
                .map(|m| millis_since_epoch(m.created().or_else(|_| m.modified())))
                .unwrap_or(0);
            ScratchProject {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: root.join(entry.file_name()).to_string_lossy().into_owned(),
                created_at_ms,
            }
        })
        .collect();
    projects.sort_by(|a, b| {
        b.created_at_ms
            .cmp(&a.created_at_ms)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(projects)
}

/// `path` when it is a real folder directly inside `root`, else
/// `OutsideScratchFolder` (`Missing` when it is gone).
///
/// Two checks, as the Files panel does: the path's own components (`..` is
/// refused outright), then the real location on disk, so a link inside the
/// scratch folder that leads elsewhere is refused too.
fn direct_child_of(root: &Path, path: &Path) -> Result<PathBuf, ScratchError> {
    let wanders = |p: &Path| p.components().any(|c| matches!(c, Component::ParentDir));
    if !root.is_absolute() || !path.is_absolute() || wanders(root) || wanders(path) {
        return Err(ScratchError::OutsideScratchFolder);
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Err(ScratchError::OutsideScratchFolder);
    }
    let real_root = canonical_stripped(root).ok_or(ScratchError::OutsideScratchFolder)?;
    let real_path = canonical_stripped(path).ok_or(ScratchError::Missing)?;
    if real_path.parent() != Some(real_root.as_path()) {
        return Err(ScratchError::OutsideScratchFolder);
    }
    Ok(real_path)
}

/// Removes the scratch project at `path`, one attempt.
fn delete_in(root: &Path, path: &Path) -> Result<(), ScratchError> {
    let target = direct_child_of(root, path)?;
    std::fs::remove_dir_all(target)?;
    Ok(())
}

/// Lists the scratch projects in the scratch folder (`folder`, or the
/// default when it is none).
#[tauri::command]
pub async fn scratch_list(folder: Option<String>) -> Result<ScratchListing, ScratchError> {
    let root = scratch_folder(folder.as_deref())?;
    let projects = list_in(&root)?;
    Ok(ScratchListing {
        folder: root.to_string_lossy().into_owned(),
        projects,
    })
}

/// Makes the scratch project `name` and returns its path.
#[tauri::command]
pub async fn scratch_create(folder: Option<String>, name: String) -> Result<String, ScratchError> {
    let root = scratch_folder(folder.as_deref())?;
    let path = create_in(&root, &name)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Deletes the scratch project at `path` with every file in it. Tries again
/// for a short while when a file is still held open by a terminal that was
/// just closed.
#[tauri::command]
pub async fn scratch_delete(folder: Option<String>, path: String) -> Result<(), ScratchError> {
    let root = scratch_folder(folder.as_deref())?;
    let path = PathBuf::from(path);
    let mut attempt = 1;
    loop {
        match delete_in(&root, &path) {
            Err(ScratchError::Io(_)) if attempt < DELETE_ATTEMPTS => {
                attempt += 1;
                tokio::time::sleep(DELETE_RETRY_PAUSE).await;
            }
            result => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("Scratch");
        (dir, root)
    }

    #[test]
    fn the_default_scratch_folder_is_maestro_scratch_in_the_home_folder() {
        let home = Path::new("/home/someone");
        for setting in [None, Some(""), Some("   ")] {
            assert_eq!(
                resolve_folder(setting, Some(home)).unwrap(),
                home.join("Maestro Scratch")
            );
        }
        assert_eq!(
            resolve_folder(None, None).unwrap_err(),
            ScratchError::NoHomeFolder
        );
    }

    #[test]
    fn a_scratch_folder_from_settings_must_be_a_full_path() {
        let (_dir, root) = temp_root();
        let chosen = root.to_string_lossy().into_owned();
        assert_eq!(resolve_folder(Some(&chosen), None).unwrap(), root);
        assert_eq!(
            resolve_folder(Some("relative/scratch"), None).unwrap_err(),
            ScratchError::RelativeFolder
        );
    }

    #[test]
    fn create_makes_a_plain_folder_and_the_scratch_folder_on_first_use() {
        let (_dir, root) = temp_root();
        assert!(!root.exists());

        let made = create_in(&root, "  scratch-13-nov-1822  ").unwrap();

        assert_eq!(made, root.join("scratch-13-nov-1822"));
        assert!(made.is_dir());
        assert!(!made.join(".git").exists());
    }

    #[test]
    fn create_refuses_bad_names_and_makes_nothing() {
        let (_dir, root) = temp_root();
        let too_long = "a".repeat(MAX_NAME_CHARS + 1);
        let cases: Vec<(&str, ScratchError)> = vec![
            ("", ScratchError::EmptyName),
            ("   ", ScratchError::EmptyName),
            ("a/b", ScratchError::ForbiddenCharacters),
            ("a\\b", ScratchError::ForbiddenCharacters),
            ("../escape", ScratchError::ForbiddenCharacters),
            ("what?", ScratchError::ForbiddenCharacters),
            ("tab\there", ScratchError::ForbiddenCharacters),
            ("..", ScratchError::BadDots),
            (".", ScratchError::BadDots),
            ("trailing.", ScratchError::BadDots),
            ("con", ScratchError::ReservedName("con".into())),
            ("LPT1.txt", ScratchError::ReservedName("LPT1.txt".into())),
            (too_long.as_str(), ScratchError::TooLong),
        ];
        for (name, expected) in cases {
            assert_eq!(
                create_in(&root, name).unwrap_err(),
                expected,
                "name {name:?}"
            );
        }
        assert!(list_in(&root).unwrap().is_empty());
    }

    #[test]
    fn create_refuses_a_name_already_taken_in_any_letter_case() {
        let (_dir, root) = temp_root();
        create_in(&root, "demo").unwrap();

        for name in ["demo", "DEMO"] {
            assert_eq!(
                create_in(&root, name).unwrap_err(),
                ScratchError::AlreadyExists(name.to_string())
            );
        }
        assert_eq!(list_in(&root).unwrap().len(), 1);
    }

    #[test]
    fn list_shows_only_direct_subfolders_with_name_path_and_age() {
        let (_dir, root) = temp_root();
        assert!(
            list_in(&root).unwrap().is_empty(),
            "no folder yet holds none"
        );

        create_in(&root, "first").unwrap();
        create_in(&root, "second").unwrap();
        std::fs::write(root.join("notes.txt"), "not a project").unwrap();
        std::fs::create_dir(root.join("first").join("nested")).unwrap();

        let projects = list_in(&root).unwrap();
        let mut names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["first", "second"]);
        for project in &projects {
            assert_eq!(PathBuf::from(&project.path), root.join(&project.name));
            assert!(project.created_at_ms > 0);
        }
    }

    #[test]
    fn delete_removes_a_scratch_project_with_its_files() {
        let (_dir, root) = temp_root();
        let made = create_in(&root, "doomed").unwrap();
        std::fs::create_dir(made.join("src")).unwrap();
        std::fs::write(made.join("src").join("main.txt"), "x").unwrap();

        delete_in(&root, &made).unwrap();

        assert!(!made.exists());
        assert!(root.exists(), "the scratch folder itself stays");
    }

    #[test]
    fn delete_refuses_any_path_that_is_not_a_direct_subfolder() {
        let (dir, root) = temp_root();
        let kept = create_in(&root, "kept").unwrap();
        std::fs::create_dir(kept.join("inner")).unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(root.join("file.txt"), "x").unwrap();

        let refused = [
            outside.clone(),
            root.join("..").join("outside"),
            root.join("kept").join("..").join("kept"),
            kept.join("inner"),
            root.clone(),
            root.join("file.txt"),
            PathBuf::from("kept"),
        ];
        for path in refused {
            assert_eq!(
                delete_in(&root, &path).unwrap_err(),
                ScratchError::OutsideScratchFolder,
                "path {path:?}"
            );
        }
        assert!(outside.is_dir());
        assert!(kept.join("inner").is_dir());
        assert!(root.join("file.txt").is_file());
    }

    #[test]
    fn delete_of_a_folder_already_gone_says_so() {
        let (_dir, root) = temp_root();
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(
            delete_in(&root, &root.join("gone")).unwrap_err(),
            ScratchError::Missing
        );
    }

    #[test]
    fn errors_reach_the_front_end_as_plain_sentences() {
        let json = serde_json::to_string(&ScratchError::AlreadyExists("demo".into())).unwrap();
        assert_eq!(
            json,
            "\"A scratch project named \\\"demo\\\" already exists.\""
        );
    }
}
