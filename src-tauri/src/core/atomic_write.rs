//! The one temp-file + rename writer shared by every config/state file that
//! must never be left torn on disk (`.mcp.json`, samurai run configs,
//! schedule, latches, journal rewrites).
//!
//! Pattern: write the full content to a temp file in the SAME directory as
//! the target (so the rename never crosses a filesystem), then rename it over
//! the target. A crash at any point leaves either the old file or the new
//! one. On Windows the rename can fail transiently while another process
//! (antivirus, an indexer, an appender) holds the target open, so the rename
//! is retried a few times with a short sleep — the behaviour the samurai
//! journal introduced, now shared by every writer.
//!
//! [`atomic_write_via`] callers set no permissions and do not fsync; that is
//! kept. Files that must survive a power cut (the Work Journal) opt in to
//! [`atomic_write_durable`]: an unpredictable temp name created fresh (never
//! following a planted link), fsync before the rename, a parent-folder fsync
//! on Unix, and no temp file left behind on failure.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Total rename attempts before giving up (the journal's original budget).
pub(crate) const RENAME_ATTEMPTS: u32 = 5;
/// Sleep between rename attempts.
pub(crate) const RENAME_RETRY_DELAY: Duration = Duration::from_millis(100);

/// Renames `tmp` over `target`, retrying up to [`RENAME_ATTEMPTS`] times.
///
/// `before_each` runs before EVERY attempt — the journal uses it to re-verify
/// the target and fold in same-window appends; an `Err` from it aborts.
/// `rename` is injectable so tests can fail attempts deterministically.
pub(crate) fn rename_with_retry(
    tmp: &Path,
    target: &Path,
    mut before_each: impl FnMut() -> Result<(), String>,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let mut attempt = 1;
    loop {
        before_each()?;
        match rename(tmp, target) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < RENAME_ATTEMPTS => {
                log::warn!(
                    "rename of {tmp:?} over {target:?} failed \
                     (attempt {attempt}/{RENAME_ATTEMPTS}): {e} — retrying"
                );
                attempt += 1;
                std::thread::sleep(RENAME_RETRY_DELAY);
            }
            Err(e) => {
                return Err(format!(
                    "failed to move {tmp:?} into place at {target:?}: {e}"
                ));
            }
        }
    }
}

/// Writes `content` to `tmp`, then renames it over `path` with retry.
///
/// The caller picks `tmp` (each site keeps its own temp naming); it must sit
/// in the same directory as `path`. Blocking — async callers use
/// [`atomic_write_async`].
pub(crate) fn atomic_write_via(path: &Path, tmp: &Path, content: &[u8]) -> Result<(), String> {
    std::fs::write(tmp, content).map_err(|e| format!("failed to write {tmp:?}: {e}"))?;
    rename_with_retry(tmp, path, || Ok(()), |from, to| std::fs::rename(from, to))
}

/// [`atomic_write_via`] on a blocking thread, so the retry sleeps never stall
/// the async runtime.
pub(crate) async fn atomic_write_async(
    path: PathBuf,
    tmp: PathBuf,
    content: Vec<u8>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || atomic_write_via(&path, &tmp, &content))
        .await
        .map_err(|e| format!("atomic write task failed: {e}"))?
}

/// A durable write's temp file older than this is left over from a crash.
/// Younger ones may belong to a write still in flight and are kept.
const STALE_TMP_AGE: Duration = Duration::from_secs(60);

/// Whether `candidate` is exactly `<target>.<pid digits>.<32 hex>.tmp`, the
/// name [`unique_tmp_path`] makes. Never the target itself, the old fixed
/// `<target>.tmp`, or any other file.
fn is_durable_tmp_name(target: &std::ffi::OsStr, candidate: &std::ffi::OsStr) -> bool {
    let (Some(target), Some(candidate)) = (target.to_str(), candidate.to_str()) else {
        return false;
    };
    let Some(rest) = candidate
        .strip_prefix(target)
        .and_then(|r| r.strip_prefix('.'))
        .and_then(|r| r.strip_suffix(".tmp"))
    else {
        return false;
    };
    let Some((pid, id)) = rest.split_once('.') else {
        return false;
    };
    !pid.is_empty()
        && pid.bytes().all(|b| b.is_ascii_digit())
        && id.len() == 32
        && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Removes temp files a crashed durable write of `path` left beside it, so
/// they never pile up (in a synced backup folder too). Only regular files
/// with the exact durable temp name and older than [`STALE_TMP_AGE`];
/// every error is ignored.
fn remove_stale_temps(path: &Path) {
    let (Some(dir), Some(target)) = (path.parent(), path.file_name()) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !is_durable_tmp_name(target, &entry.file_name()) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        let stale = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age >= STALE_TMP_AGE);
        if meta.is_file() && stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// A fresh temp path next to `path`: `<file>.<pid>.<random>.tmp`, so no
/// other process can predict it and plant a link there in advance.
fn unique_tmp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    path.with_file_name(name)
}

/// Creates `tmp` (refusing an existing file or link at that name), writes
/// `content` and flushes it to disk. Returns whether `tmp` was created, so
/// the caller removes only a file it made.
fn write_synced_new(tmp: &Path, target: &Path, content: &[u8]) -> (bool, Result<(), String>) {
    use std::io::Write;
    #[cfg(test)]
    if test_hooks::is_blocked(target) {
        return (
            false,
            Err(format!("failed to create {tmp:?}: blocked by test")),
        );
    }
    #[cfg(not(test))]
    let _ = target;
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp)
    {
        Ok(file) => file,
        Err(e) => return (false, Err(format!("failed to create {tmp:?}: {e}"))),
    };
    let written = file
        .write_all(content)
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("failed to write {tmp:?}: {e}"));
    (true, written)
}

/// Flushes the folder entry so the rename itself survives a power cut.
/// Unix only: Windows has no directory fsync and NTFS journals the rename.
/// A failure only logs, since the new file is already in place.
fn sync_parent_dir(path: &Path) {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::File::open(parent).and_then(|dir| dir.sync_all()) {
            log::warn!("could not fsync folder {parent:?} after writing {path:?}: {e}");
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Writes `content` to `path` so that neither a crash nor a power cut can
/// leave it empty or half-written, through a fresh unpredictable temp file
/// (see the module note). Any failure removes the temp file, and stale temps
/// from earlier crashed writes are cleared first. Blocking.
pub(crate) fn atomic_write_durable(path: &Path, content: &[u8]) -> Result<(), String> {
    remove_stale_temps(path);
    atomic_write_durable_via(path, &unique_tmp_path(path), content)
}

/// [`atomic_write_durable`] with the temp path chosen by the caller (tests).
fn atomic_write_durable_via(path: &Path, tmp: &Path, content: &[u8]) -> Result<(), String> {
    let (created, written) = write_synced_new(tmp, path, content);
    let result = written
        .and_then(|()| rename_with_retry(tmp, path, || Ok(()), |a, b| std::fs::rename(a, b)));
    match result {
        Ok(()) => {
            sync_parent_dir(path);
            Ok(())
        }
        Err(e) => {
            if created {
                if let Err(rm) = std::fs::remove_file(tmp) {
                    log::warn!("could not remove temp file {tmp:?}: {rm}");
                }
            }
            Err(e)
        }
    }
}

/// [`atomic_write_durable`] on a blocking thread, so the fsync and the
/// retry sleeps never stall the async runtime.
pub(crate) async fn atomic_write_durable_async(
    path: PathBuf,
    content: Vec<u8>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || atomic_write_durable(&path, &content))
        .await
        .map_err(|e| format!("atomic write task failed: {e}"))?
}

/// Test seam: makes durable writes to chosen targets fail at the temp-file
/// step on the current thread, since tests cannot plant anything at a
/// random temp name.
#[cfg(test)]
pub(crate) mod test_hooks {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    thread_local! {
        static BLOCKED: RefCell<Vec<PathBuf>> = const { RefCell::new(Vec::new()) };
    }

    /// Durable writes to `target` on this thread fail until the guard drops.
    pub(crate) fn block_durable_writes_to(target: &Path) -> BlockGuard {
        BLOCKED.with(|b| b.borrow_mut().push(target.to_path_buf()));
        BlockGuard(target.to_path_buf())
    }

    pub(super) fn is_blocked(target: &Path) -> bool {
        BLOCKED.with(|b| b.borrow().iter().any(|p| same_target(p, target)))
    }

    /// Equal paths, or the same file name in the same (canonical) folder, so
    /// a caller that spells the folder differently still matches.
    fn same_target(a: &Path, b: &Path) -> bool {
        if a == b {
            return true;
        }
        let parent = |p: &Path| p.parent().and_then(|d| std::fs::canonicalize(d).ok());
        a.file_name() == b.file_name() && parent(a).is_some() && parent(a) == parent(b)
    }

    /// Unblocks its target when dropped.
    pub(crate) struct BlockGuard(PathBuf);

    impl Drop for BlockGuard {
        fn drop(&mut self) {
            BLOCKED.with(|b| b.borrow_mut().retain(|p| p != &self.0));
        }
    }

    /// Temp files (`*.tmp`) left in `dir`.
    pub(crate) fn leftover_temps(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.extension().is_some_and(|x| x == "tmp"))
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_atomic_write_via_replaces_target_and_removes_tmp() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.json");
        let tmp = dir.path().join("state.json.tmp");
        std::fs::write(&path, "old").unwrap();

        atomic_write_via(&path, &tmp, b"new").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert!(!tmp.exists(), "the temp file is consumed by the rename");
    }

    #[test]
    fn test_atomic_write_via_creates_missing_target() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("fresh.json");
        let tmp = dir.path().join("fresh.json.tmp");

        atomic_write_via(&path, &tmp, b"{}").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
    }

    #[test]
    fn test_atomic_write_via_errors_when_dir_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nope").join("x.json");
        let tmp = dir.path().join("nope").join("x.json.tmp");

        let err = atomic_write_via(&path, &tmp, b"{}").unwrap_err();
        assert!(err.contains("failed to write"), "got: {err}");
    }

    #[test]
    fn test_rename_with_retry_recovers_from_transient_failures() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.json");
        let tmp = dir.path().join("t.json.tmp");
        std::fs::write(&tmp, "v").unwrap();

        let mut calls = 0;
        let mut checks = 0;
        rename_with_retry(
            &tmp,
            &path,
            || {
                checks += 1;
                Ok(())
            },
            |from, to| {
                calls += 1;
                if calls < 3 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "target held open",
                    ));
                }
                std::fs::rename(from, to)
            },
        )
        .unwrap();

        assert_eq!(calls, 3);
        assert_eq!(checks, 3, "before_each runs before every attempt");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "v");
    }

    #[test]
    fn test_rename_with_retry_gives_up_after_the_attempt_budget() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.json");
        let tmp = dir.path().join("t.json.tmp");

        let mut calls = 0;
        let err = rename_with_retry(
            &tmp,
            &path,
            || Ok(()),
            |_, _| {
                calls += 1;
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "always locked",
                ))
            },
        )
        .unwrap_err();

        assert_eq!(calls, RENAME_ATTEMPTS);
        assert!(err.contains("failed to move"), "got: {err}");
    }

    #[test]
    fn test_rename_with_retry_aborts_when_before_each_fails() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.json");
        let tmp = dir.path().join("t.json.tmp");

        let mut calls = 0;
        let err = rename_with_retry(
            &tmp,
            &path,
            || Err("changed underneath".to_string()),
            |_, _| {
                calls += 1;
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(err, "changed underneath");
        assert_eq!(calls, 0, "no rename once the pre-check refuses");
    }

    #[tokio::test]
    async fn test_atomic_write_async_writes_target() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.json");
        let tmp = dir.path().join("a.json.tmp.1");

        atomic_write_async(path.clone(), tmp.clone(), b"async".to_vec())
            .await
            .unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "async");
        assert!(!tmp.exists());
    }

    #[test]
    fn test_atomic_write_durable_writes_exact_bytes_and_leaves_no_temp() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("journal.json");
        std::fs::write(&path, "old").unwrap();
        let bytes: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();

        atomic_write_durable(&path, &bytes).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(test_hooks::leftover_temps(dir.path()).is_empty());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn test_durable_temp_names_are_unpredictable_and_beside_the_target() {
        let path = Path::new("dir").join("journal.json");
        let a = unique_tmp_path(&path);
        let b = unique_tmp_path(&path);
        assert_ne!(a, b, "each write picks a fresh name");
        assert_eq!(
            a.parent(),
            path.parent(),
            "same folder, so the rename stays local"
        );
        let name = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("journal.json."), "got: {name}");
        assert!(name.ends_with(".tmp"), "got: {name}");
        assert_ne!(name, "journal.json.tmp", "never the old fixed name");
    }

    #[test]
    fn test_atomic_write_durable_never_reuses_an_existing_temp_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("journal.json");
        let tmp = dir.path().join("journal.json.planted.tmp");
        std::fs::write(&path, "old").unwrap();
        std::fs::write(&tmp, "planted").unwrap();

        let err = atomic_write_durable_via(&path, &tmp, b"secret").unwrap_err();

        assert!(err.contains("failed to create"), "got: {err}");
        assert_eq!(
            std::fs::read_to_string(&tmp).unwrap(),
            "planted",
            "not overwritten"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "old",
            "target untouched"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_atomic_write_durable_does_not_follow_a_planted_symlink() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("journal.json");
        let victim = dir.path().join("victim.txt");
        let tmp = dir.path().join("journal.json.link.tmp");
        std::fs::write(&victim, "victim").unwrap();
        std::os::unix::fs::symlink(&victim, &tmp).unwrap();

        let err = atomic_write_durable_via(&path, &tmp, b"secret").unwrap_err();

        assert!(err.contains("failed to create"), "got: {err}");
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "victim");
        assert!(!path.exists());
    }

    #[test]
    fn test_atomic_write_durable_removes_the_temp_when_the_rename_fails() {
        let dir = tempdir().unwrap();
        // A folder at the target makes every rename attempt fail.
        let path = dir.path().join("journal.json");
        std::fs::create_dir(&path).unwrap();

        let err = atomic_write_durable(&path, b"data").unwrap_err();

        assert!(err.contains("failed to move"), "got: {err}");
        assert!(path.is_dir(), "the folder is untouched");
        assert!(
            test_hooks::leftover_temps(dir.path()).is_empty(),
            "temp removed"
        );
    }

    #[test]
    fn test_atomic_write_durable_errors_when_dir_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nope").join("x.json");

        let err = atomic_write_durable(&path, b"{}").unwrap_err();
        assert!(err.contains("failed to create"), "got: {err}");
    }

    #[test]
    fn test_blocked_durable_write_fails_until_the_guard_drops() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("j.json");
        let guard = test_hooks::block_durable_writes_to(&path);
        assert!(atomic_write_durable(&path, b"x").is_err());
        assert!(!path.exists());
        drop(guard);
        atomic_write_durable(&path, b"x").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "x");
    }

    #[tokio::test]
    async fn test_atomic_write_durable_async_writes_target() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("report.html");

        atomic_write_durable_async(path.clone(), b"<html>".to_vec())
            .await
            .unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "<html>");
        assert!(test_hooks::leftover_temps(dir.path()).is_empty());
    }

    #[test]
    fn test_durable_tmp_name_matches_only_its_own_pattern() {
        let target = std::ffi::OsStr::new("journal.json");
        let made = unique_tmp_path(Path::new("journal.json"));
        assert!(is_durable_tmp_name(target, made.file_name().unwrap()));
        let hex = "0123456789abcdef0123456789abcdef";
        for other in [
            "journal.json".to_string(),
            "journal.json.tmp".to_string(),
            "journal.json.bak.tmp".to_string(),
            format!("journal.json.12.{hex}"),
            format!("journal.json..{hex}.tmp"),
            format!("journal.json.12.{hex}0.tmp"),
            format!("journal.json.x1.{hex}.tmp"),
            format!("other.json.12.{hex}.tmp"),
            format!("journal.jsonx.12.{hex}.tmp"),
        ] {
            assert!(
                !is_durable_tmp_name(target, std::ffi::OsStr::new(&other)),
                "must not match {other}"
            );
        }
    }

    #[test]
    fn test_atomic_write_durable_clears_stale_temps_and_nothing_else() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("journal.json");
        let hex = "0123456789abcdef0123456789abcdef";
        let old = std::time::SystemTime::now() - Duration::from_secs(3600);
        let make = |name: &str, aged: bool| {
            let p = dir.path().join(name);
            std::fs::write(&p, "x").unwrap();
            if aged {
                let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
                f.set_modified(old).unwrap();
            }
            p
        };
        let stale = make(&format!("journal.json.42.{hex}.tmp"), true);
        let in_flight = make(&format!("journal.json.43.{hex}.tmp"), false);
        let fixed = make("journal.json.tmp", true);
        let other = make(&format!("other.json.42.{hex}.tmp"), true);

        atomic_write_durable(&path, b"new").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert!(!stale.exists(), "a crashed write's temp is removed");
        assert!(in_flight.exists(), "a young temp may be in flight");
        assert!(fixed.exists(), "not the durable pattern");
        assert!(other.exists(), "another file's temp");
    }
}
