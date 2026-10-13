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
//! None of the callers set permissions or fsync; this module preserves that.

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
}
