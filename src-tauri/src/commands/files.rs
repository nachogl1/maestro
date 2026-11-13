//! The Files panel's backend (PRD §4.5): list one folder level and read a file
//! for preview. Both are read-only and refuse any path outside the folder the
//! panel is browsing; opening a file reuses the opener plugin.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri_plugin_opener::OpenerExt;

use crate::core::samurai_files::canonical_stripped;
use crate::core::windows_process::StdCommandExt;

/// Text files up to this size preview; bigger ones show "Can't preview".
pub const PREVIEW_MAX_BYTES: u64 = 1024 * 1024;

/// Everything the Files panel can fail on, sent to the front end as one
/// plain sentence it shows as is.
#[derive(Debug, thiserror::Error)]
pub enum FilesError {
    #[error("This is outside the folder being shown.")]
    OutsideRoot,
    #[error("It no longer exists.")]
    Missing,
    #[error("It can't be read: {0}")]
    Unreadable(String),
    #[error("This is a folder, not a file.")]
    NotAFile,
    #[error("This file is {0}. Preview shows text files up to about 1 MB.")]
    TooLarge(String),
    #[error("This is not a text file.")]
    NotText,
    #[error("It couldn't be opened: {0}")]
    OpenFailed(String),
}

impl Serialize for FilesError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<std::io::Error> for FilesError {
    fn from(err: std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::NotFound {
            FilesError::Missing
        } else {
            FilesError::Unreadable(err.to_string())
        }
    }
}

/// One entry of a folder listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// Absolute path: the folder's path joined with the name.
    pub path: String,
    pub is_dir: bool,
    /// Git ignores it (shown dimmed, never hidden).
    pub ignored: bool,
}

/// `path` when it lies inside `root` (or is `root`), else `OutsideRoot`; a
/// path that does not exist is `Missing`.
///
/// Two checks: the path's own components (`..` is refused outright), then the
/// real location on disk, so a symlink or junction inside the folder that
/// leads out of it is refused while a link that stays inside still works. The
/// link entry itself still lists in its parent. The path comes back as given,
/// so the entries listed under it keep the spelling the front end sent.
fn resolve_inside(root: &str, path: &str) -> Result<PathBuf, FilesError> {
    let root = Path::new(root);
    let path = Path::new(path);
    let climbs = |p: &Path| p.components().any(|c| matches!(c, Component::ParentDir));
    if !root.is_absolute() || !path.is_absolute() || climbs(root) || climbs(path) {
        return Err(FilesError::OutsideRoot);
    }
    if !path.starts_with(root) {
        return Err(FilesError::OutsideRoot);
    }
    let real_root = canonical_stripped(root).ok_or(FilesError::Missing)?;
    let real_path = canonical_stripped(path).ok_or(FilesError::Missing)?;
    if !real_path.starts_with(&real_root) {
        return Err(FilesError::OutsideRoot);
    }
    Ok(path.to_path_buf())
}

/// A byte count as a person reads it: `512 bytes`, `48 KB`, `2.4 MB`.
fn format_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        format!("{bytes} bytes")
    } else if b < KB * KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{:.1} MB", b / (KB * KB))
    }
}

/// The names in `dir` that git ignores. Not a repository, or git missing,
/// means nothing is ignored: the listing never fails because of git.
///
/// Browsing a folder must never make git run a command a repository's config
/// names. `--no-index` keeps git out of the index, so neither its fsmonitor
/// nor a lazy fetch of a missing `.gitignore` in a partial clone can run;
/// fsmonitor and lazy fetch are also switched off outright as second guards.
/// The cost: a tracked file that matches an ignore pattern is dimmed too.
fn ignored_names(dir: &Path, names: &[String]) -> HashSet<String> {
    if names.is_empty() {
        return HashSet::new();
    }
    let child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "core.fsmonitor=false",
            "check-ignore",
            "--no-index",
            "--stdin",
            "-z",
        ])
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .hide_console_window()
        .spawn();
    let Ok(mut child) = child else {
        return HashSet::new();
    };
    let mut input = Vec::new();
    for name in names {
        input.extend_from_slice(name.as_bytes());
        input.push(0);
    }
    // Written from its own thread so a full output pipe never blocks the write.
    let writer = child.stdin.take().map(|mut stdin| {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        })
    });
    let output = child.wait_with_output();
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    // Exit 0: some are ignored; 1: none are; anything else: not a repository.
    match output {
        Ok(out) if out.status.success() => out
            .stdout
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect(),
        _ => HashSet::new(),
    }
}

fn list_dir_blocking(root: &str, dir: &str) -> Result<Vec<FileEntry>, FilesError> {
    let dir = resolve_inside(root, dir)?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        // Follows symlinks, so a linked folder opens like a folder.
        let is_dir = std::fs::metadata(&path)
            .map(|m| m.is_dir())
            .unwrap_or_else(|_| entry.file_type().map(|t| t.is_dir()).unwrap_or(false));
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            is_dir,
            ignored: false,
        });
    }
    let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
    let ignored = ignored_names(&dir, &names);
    for entry in &mut entries {
        entry.ignored = ignored.contains(&entry.name);
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn read_preview_blocking(root: &str, path: &str) -> Result<String, FilesError> {
    let path = resolve_inside(root, path)?;
    let meta = std::fs::metadata(&path)?;
    if meta.is_dir() {
        return Err(FilesError::NotAFile);
    }
    if meta.len() > PREVIEW_MAX_BYTES {
        return Err(FilesError::TooLarge(format_size(meta.len())));
    }
    let bytes = std::fs::read(&path)?;
    if bytes.contains(&0) {
        return Err(FilesError::NotText);
    }
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    String::from_utf8(bytes.to_vec()).map_err(|_| FilesError::NotText)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, FilesError> + Send + 'static,
) -> Result<T, FilesError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| FilesError::Unreadable(e.to_string()))?
}

/// One level of `dir` (inside `root`): folders first, then files, by name,
/// each with its git-ignored flag. Hidden files are listed like any other.
#[tauri::command]
pub async fn files_list_dir(root: String, dir: String) -> Result<Vec<FileEntry>, FilesError> {
    blocking(move || list_dir_blocking(&root, &dir)).await
}

/// The text of `path` (inside `root`) for the read-only preview; a file over
/// about 1 MB, a binary one, a missing or unreadable one is an error saying why.
#[tauri::command]
pub async fn files_read_preview(root: String, path: String) -> Result<String, FilesError> {
    blocking(move || read_preview_blocking(&root, &path)).await
}

/// The path `files_open_default` opens: inside `root`, and still there.
fn open_target(root: &str, path: &str) -> Result<PathBuf, FilesError> {
    resolve_inside(root, path)
}

/// Opens `path` (inside `root`) in the computer's default app; a folder opens
/// in the file manager.
#[tauri::command]
pub async fn files_open_default<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: String,
    path: String,
) -> Result<(), FilesError> {
    let path = open_target(&root, &path)?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| FilesError::OpenFailed(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} failed");
    }

    /// A small synthetic repository: a hidden file, an ignored folder and file.
    fn sample_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        std::fs::write(root.join(".gitignore"), "dist/\n.env\n").unwrap();
        std::fs::write(root.join(".env"), "API_URL=http://localhost:8080\n").unwrap();
        std::fs::write(root.join("README.md"), "# shop\n").unwrap();
        std::fs::write(root.join("b.txt"), "b").unwrap();
        std::fs::create_dir_all(root.join("src/lib")).unwrap();
        std::fs::write(root.join("src/main.ts"), "export {};\n").unwrap();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/app.js"), "x").unwrap();
        dir
    }

    #[test]
    fn lists_one_level_folders_first_with_hidden_files_and_ignored_flags() {
        let repo = sample_repo();
        let root = s(repo.path());
        let entries = list_dir_blocking(&root, &root).unwrap();
        let view: Vec<(&str, bool, bool)> = entries
            .iter()
            .map(|e| (e.name.as_str(), e.is_dir, e.ignored))
            .collect();
        assert_eq!(
            view,
            vec![
                (".git", true, false),
                ("dist", true, true),
                ("src", true, false),
                (".env", false, true),
                (".gitignore", false, false),
                ("b.txt", false, false),
                ("README.md", false, false),
            ]
        );
        assert_eq!(entries[2].path, s(&repo.path().join("src")));
    }

    #[test]
    fn lists_a_subfolder_without_its_grandchildren_and_flags_inside_ignored_folders() {
        let repo = sample_repo();
        let root = s(repo.path());
        let src = list_dir_blocking(&root, &s(&repo.path().join("src"))).unwrap();
        let names: Vec<&str> = src.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["lib", "main.ts"]);
        let dist = list_dir_blocking(&root, &s(&repo.path().join("dist"))).unwrap();
        assert!(
            dist[0].ignored,
            "a file inside an ignored folder is ignored"
        );
    }

    #[test]
    fn outside_a_repository_nothing_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "A=1").unwrap();
        let root = s(dir.path());
        let entries = list_dir_blocking(&root, &root).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].ignored);
    }

    #[test]
    fn refuses_paths_outside_the_folder_being_shown() {
        let repo = sample_repo();
        let root = repo.path().join("src");
        let root_s = s(&root);
        let outside = [
            s(repo.path()),
            s(&repo.path().join("README.md")),
            s(&root.join("..").join("README.md")),
            "README.md".to_string(),
            s(&repo.path().join("srcx")),
        ];
        for path in outside {
            assert!(
                matches!(
                    list_dir_blocking(&root_s, &path),
                    Err(FilesError::OutsideRoot)
                ),
                "list {path}"
            );
            assert!(
                matches!(
                    read_preview_blocking(&root_s, &path),
                    Err(FilesError::OutsideRoot)
                ),
                "read {path}"
            );
        }
    }

    /// A directory link at `link` to `target`: a symlink on unix, a junction
    /// on Windows (no admin rights needed).
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let ok = Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(ok, "mklink /J failed");
        }
    }

    #[test]
    fn a_link_leading_out_of_the_folder_is_refused_but_still_listed() {
        let repo = sample_repo();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "not yours").unwrap();
        let link = repo.path().join("jlink");
        link_dir(outside.path(), &link);
        let inner = repo.path().join("srclink");
        link_dir(&repo.path().join("src"), &inner);
        let root = s(repo.path());

        let listed = list_dir_blocking(&root, &root).unwrap();
        assert!(
            listed.iter().any(|e| e.name == "jlink"),
            "the link itself shows"
        );
        let secret = s(&link.join("secret.txt"));
        assert!(matches!(
            list_dir_blocking(&root, &s(&link)),
            Err(FilesError::OutsideRoot)
        ));
        assert!(matches!(
            read_preview_blocking(&root, &secret),
            Err(FilesError::OutsideRoot)
        ));
        assert!(matches!(
            open_target(&root, &secret),
            Err(FilesError::OutsideRoot)
        ));
        // A link that stays inside the folder opens like any folder.
        let names: Vec<String> = list_dir_blocking(&root, &s(&inner))
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["lib", "main.ts"]);
        assert!(matches!(
            open_target(&root, &s(&repo.path().join("gone.txt"))),
            Err(FilesError::Missing)
        ));
    }

    /// A shell script in `dir` that writes a marker file when run: returns the
    /// value a git config setting names it by, and the marker's path.
    fn marker_script(dir: &Path, name: &str) -> (String, PathBuf) {
        let marker = dir.join(format!("{name}-ran"));
        let script = dir.join(format!("{name}.sh"));
        let marker_sh = s(&marker).replace('\\', "/");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho ran > '{marker_sh}'\nexit 1\n"),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        (s(&script).replace('\\', "/"), marker)
    }

    #[test]
    fn listing_a_repository_never_runs_its_fsmonitor_command() {
        let repo = sample_repo();
        let nested = repo.path().join("vendor").join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        git(&nested, &["init", "-q"]);
        std::fs::write(nested.join("a.txt"), "a").unwrap();
        let (script, marker) = marker_script(repo.path(), "fsmonitor");
        git(&nested, &["config", "core.fsmonitor", &script]);

        let root = s(repo.path());
        list_dir_blocking(&root, &s(&nested)).unwrap();
        assert!(!marker.exists(), "git ran the folder's fsmonitor command");
    }

    #[test]
    fn listing_a_partial_clone_never_fetches_a_missing_ignore_file() {
        // A source repository whose `sub/.gitignore` the clone leaves out.
        let source = tempfile::tempdir().unwrap();
        let src = source.path();
        git(src, &["init", "-q"]);
        std::fs::write(src.join("README.md"), "# demo\n").unwrap();
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("sub/.gitignore"), "*.log\n").unwrap();
        git(src, &["add", "."]);
        git(
            src,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.invalid",
                "commit",
                "-qm",
                "init",
            ],
        );
        git(src, &["config", "uploadpack.allowFilter", "true"]);

        // A blob-less partial clone with a sparse checkout: `sub/.gitignore`
        // is skip-worktree and its blob is missing.
        let work = tempfile::tempdir().unwrap();
        let clone = work.path().join("clone");
        let url = format!(
            "file:///{}",
            s(src).replace('\\', "/").trim_start_matches('/')
        );
        let ok = Command::new("git")
            .args(["clone", "-q", "--filter=blob:none", "--no-checkout", &url])
            .arg(&clone)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "partial clone failed");
        git(
            &clone,
            &["sparse-checkout", "set", "--no-cone", "/README.md"],
        );
        git(&clone, &["checkout", "-q"]);
        std::fs::create_dir_all(clone.join("sub")).unwrap();
        std::fs::write(clone.join("sub/run.log"), "x").unwrap();
        // A lazy fetch of the missing blob would run this ssh command.
        let (script, marker) = marker_script(work.path(), "ssh");
        git(
            &clone,
            &["remote", "set-url", "origin", "ssh://example.invalid/x"],
        );
        git(&clone, &["config", "core.sshCommand", &script]);

        let root = s(&clone);
        list_dir_blocking(&root, &s(&clone.join("sub"))).unwrap();
        assert!(!marker.exists(), "git fetched from the repository's remote");
    }

    #[test]
    fn previews_a_text_file_and_drops_a_byte_order_mark() {
        let repo = sample_repo();
        let root = s(repo.path());
        let readme = s(&repo.path().join("README.md"));
        assert_eq!(read_preview_blocking(&root, &readme).unwrap(), "# shop\n");
        let bom = repo.path().join("bom.txt");
        std::fs::write(&bom, b"\xEF\xBB\xBFhello").unwrap();
        assert_eq!(read_preview_blocking(&root, &s(&bom)).unwrap(), "hello");
    }

    #[test]
    fn a_file_up_to_one_megabyte_previews_and_a_bigger_one_says_its_size() {
        let repo = sample_repo();
        let root = s(repo.path());
        let at_limit = repo.path().join("limit.txt");
        std::fs::write(&at_limit, vec![b'a'; PREVIEW_MAX_BYTES as usize]).unwrap();
        assert!(read_preview_blocking(&root, &s(&at_limit)).is_ok());
        let big = repo.path().join("big.js");
        std::fs::write(&big, vec![b'a'; 2_516_582]).unwrap();
        let err = read_preview_blocking(&root, &s(&big)).unwrap_err();
        assert_eq!(
            err.to_string(),
            "This file is 2.4 MB. Preview shows text files up to about 1 MB."
        );
    }

    #[test]
    fn binary_missing_and_folder_paths_are_one_plain_error() {
        let repo = sample_repo();
        let root = s(repo.path());
        let png = repo.path().join("logo.png");
        std::fs::write(&png, [0x89, b'P', b'N', b'G', 0, 0, 1]).unwrap();
        let latin1 = repo.path().join("latin1.txt");
        std::fs::write(&latin1, [b'c', b'a', b'f', 0xE9]).unwrap();
        let cases = [
            (s(&png), "This is not a text file."),
            (s(&latin1), "This is not a text file."),
            (s(&repo.path().join("gone.txt")), "It no longer exists."),
            (s(&repo.path().join("src")), "This is a folder, not a file."),
        ];
        for (path, message) in cases {
            let err = read_preview_blocking(&root, &path).unwrap_err();
            assert_eq!(serde_json::to_value(&err).unwrap(), message, "{path}");
        }
        let missing_dir = s(&repo.path().join("gone"));
        assert!(matches!(
            list_dir_blocking(&root, &missing_dir),
            Err(FilesError::Missing)
        ));
    }

    #[test]
    fn sizes_read_as_a_person_says_them() {
        assert_eq!(format_size(512), "512 bytes");
        assert_eq!(format_size(48 * 1024), "48 KB");
        assert_eq!(format_size(2_516_582), "2.4 MB");
    }
}
