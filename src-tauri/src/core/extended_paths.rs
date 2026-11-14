//! Path identity helpers shared across the app: the Windows `\\?\`
//! extended-length strip, the canonical per-project key, and the name of the
//! per-project store file.
//!
//! `fs::canonicalize` returns `\\?\`-prefixed (verbatim) paths on Windows,
//! and `\\?\UNC\server\share\…` for a network location. Every per-project
//! cache, working directory and saved record keys on the stripped spelling
//! these helpers produce, so it lives in one place. Moved here unchanged from
//! the Samurai file inventory and the Samurai injector (issue #610): MCP,
//! plugins, the marketplace, files, scratch projects, the CLI, CLAUDE.md, MCP
//! settings, the Work Journal and the AI runner all depend on them.

use std::path::{Path, PathBuf};

/// `fs::canonicalize` + `\\?\` strip: the one true on-disk identity of a
/// path (resolves `..`, short names and case), per fork convention. `None`
/// when the path does not exist.
///
/// `pub(crate)`: the Second Brain's guarded read
/// (`commands/samurai.rs::samurai_file_read`, issue #82) must canonicalize
/// both sides of its containment check exactly the way the managed delete
/// does — one canonicalization shared, never a second copy that can drift.
pub(crate) fn canonical_stripped(path: &Path) -> Option<PathBuf> {
    canonical_key(path).ok().map(PathBuf::from)
}

/// [`canonical_stripped`] as a STRING key, keeping the `io::Error` so a
/// command can report why the path was refused. The one spelling every
/// per-project cache (MCP, plugin, marketplace and session managers) keys
/// on: a raw `fs::canonicalize(..).to_string_lossy()` kept the `\\?\`
/// prefix on Windows, so the same project could sit under two keys next to
/// code that strips it. The strip is [`strip_extended_length`]'s plain
/// string rule, so it behaves the same on every host.
pub(crate) fn canonical_key(path: impl AsRef<Path>) -> std::io::Result<String> {
    let canonical = std::fs::canonicalize(path)?;
    Ok(strip_extended_length(&canonical.to_string_lossy()))
}

/// The `\\?\` / `\\?\UNC\` strip on its own, as a pure string step.
///
/// `\\?\UNC\server\share\…` is a NETWORK path: it must strip back to
/// `\\server\share\…`. Dropping only `\\?\` would leave a RELATIVE `UNC\…`
/// path, which resolves against the process cwd and fails every
/// `is_file()` — the case that hits any redirected AppData or share-hosted
/// worktree.
///
/// Split out of [`canonical_stripped`] so that rule is unit-testable on a
/// host that cannot produce the prefix: `fs::canonicalize` only ever emits
/// `\\?\` on Windows, and CI runs on Linux.
pub(crate) fn strip_extended_length(path: &str) -> String {
    match path.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => path.strip_prefix(r"\\?\").unwrap_or(path).to_string(),
    }
}

/// The persisted per-project store file (`maestro-<hash>.json`, a
/// tauri-plugin-store file holding MCP/skill/plugin defaults and branch
/// configs) for a [`canonical_key`].
///
/// The hash input is the LEGACY spelling — the raw
/// `fs::canonicalize(..).to_string_lossy()` these stores were always named
/// from, `\\?\`-prefixed on Windows — so files written before the switch to
/// the stripped key keep loading. Accepts either spelling; host-independent.
pub(crate) fn project_store_name(key: &str) -> String {
    use sha2::{Digest, Sha256};
    let legacy = legacy_extended_length(key);
    let digest = Sha256::digest(legacy.as_bytes());
    // First 12 hex characters: short but unique enough for a filename.
    format!("maestro-{}.json", &format!("{digest:x}")[..12])
}

/// Inverse of [`strip_extended_length`]: a drive path `C:\…` gets `\\?\`,
/// a share path `\\server\share\…` gets `\\?\UNC\server\share\…`, exactly
/// as `fs::canonicalize` emits them on Windows. Already-prefixed and
/// non-Windows paths pass through unchanged.
fn legacy_extended_length(key: &str) -> String {
    if key.starts_with(r"\\?\") {
        return key.to_string();
    }
    if let Some(rest) = key.strip_prefix(r"\\") {
        return format!(r"\\?\UNC\{rest}");
    }
    let bytes = key.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return format!(r"\\?\{key}");
    }
    key.to_string()
}

/// Any spelling of a Windows path a samurai store can hand back, mapped to
/// the plain ABSOLUTE one. Two rules:
///
/// * [`strip_extended_length`]: the `\\?\` / `\\?\UNC\` verbatim prefix
///   `fs::canonicalize` adds on Windows is dropped, keeping a
///   `\\?\UNC\server\share\…` path ABSOLUTE (`\\server\share\…`) rather
///   than stripping it to a relative-looking `UNC\server\share\…`.
/// * Legacy repair: a string already mangled to that relative spelling — by
///   the pre-#161 copies of this function, persisted in their stores, or
///   produced by older builds of `commands/ai_runner.rs::canonical_project_path`
///   (which stripped only `\\?\`) — is mapped back to `\\server\share\…`. A
///   leading `UNC\` component cannot occur in a genuine absolute path, so
///   the repair is unambiguous, and it is what lets every store accept its
///   own pre-#161 records without a rewrite.
///
/// Both path families that reach the samurai machinery go through this:
/// [`normalize_project`] for project identity (issue #161) and
/// [`strip_extended_prefix`] for the epic worktree that becomes a launch
/// working directory (issue #165). They had drifted apart once already — the
/// rule lives here so they cannot drift again.
pub(crate) fn normalize_extended_path(path: &str) -> String {
    let stripped = strip_extended_length(path);
    match stripped.strip_prefix(r"UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => stripped,
    }
}

/// The ONE project-identity normalization every samurai surface shares —
/// audit file names, run-config placement, schedule timers, journal entries,
/// PR-review records and the command boundary all key the same project on
/// this string, so it lives in exactly one place (issue #161; the per-module
/// copies it replaces had already drifted from [`strip_extended_length`]).
///
/// The rules are [`normalize_extended_path`]'s; this name is the contract
/// that says a string is a project KEY, not just any path.
pub(crate) fn normalize_project(project: &str) -> String {
    normalize_extended_path(project)
}

/// `fs::canonicalize` on Windows returns `\\?\`-prefixed extended-length
/// paths (the SessionManager and `WorktreeManager` store them verbatim);
/// `CreateProcess` rejects that form as a working directory. Strip it, same
/// as `commands/terminal.rs` / `commands/ai_runner.rs`. On other platforms
/// the prefix never occurs and this is a no-op. `pub(crate)`: the replicator
/// (issue #55) resolves session dirs through the same resolver and needs the
/// identical stripping.
///
/// Issue #165: the strip is [`normalize_extended_path`]'s, not a bare `\\?\`
/// chop. A worktree canonicalized on a share arrives as
/// `\\?\UNC\server\share\…`, and dropping only `\\?\` left the RELATIVE
/// `UNC\server\share\…` — which every consumer here (launch working
/// directory, handoff resolution, HEAD reads, orphan probes) then resolved
/// against the process cwd instead of the share. The same call also repairs a
/// `worktree_path` already persisted in a run config under that mangled
/// spelling, exactly as #161 did for `project_path`.
pub(crate) fn strip_extended_prefix(path: &str) -> String {
    normalize_extended_path(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// The shared project-identity rule (issue #161), pure string in / string
    /// out so every case — including the Windows verbatim spellings a Linux
    /// CI runner can never produce via `fs::canonicalize` — is asserted on
    /// any host.
    #[test]
    fn test_normalize_project_keeps_every_absolute_form_absolute() {
        // The verbatim prefix is dropped…
        assert_eq!(normalize_project(r"\\?\C:\git\maestro"), r"C:\git\maestro");
        // …and a verbatim UNC path stays ABSOLUTE — `UNC\server\share\…`
        // would be relative, which `staged_brief_path` rightly refuses.
        assert_eq!(
            normalize_project(r"\\?\UNC\server\share\maestro"),
            r"\\server\share\maestro"
        );
        // Already-plain spellings pass through untouched.
        assert_eq!(normalize_project(r"C:\git\maestro"), r"C:\git\maestro");
        assert_eq!(
            normalize_project(r"\\server\share\maestro"),
            r"\\server\share\maestro"
        );
        assert_eq!(normalize_project("/home/me/maestro"), "/home/me/maestro");
    }

    #[test]
    fn test_normalize_project_repairs_the_pre_161_relative_unc_spelling() {
        // What the pre-#161 normalization (and `canonical_project_path`
        // still) made of a verbatim UNC path — persisted in stores, so it
        // must be accepted on read and mapped back to the absolute form.
        assert_eq!(
            normalize_project(r"UNC\server\share\maestro"),
            r"\\server\share\maestro"
        );
        // Idempotent: repairing twice changes nothing.
        assert_eq!(
            normalize_project(&normalize_project(r"\\?\UNC\server\share\maestro")),
            r"\\server\share\maestro"
        );
    }

    #[test]
    fn test_canonical_key_is_the_stripped_canonical_spelling() {
        // The per-project cache key: one spelling whatever the input form,
        // never the `\\?\` verbatim prefix `fs::canonicalize` adds on
        // Windows, and the same string `canonical_stripped` resolves to.
        let dir = tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(project.join("sub")).unwrap();

        let key = canonical_key(&project).unwrap();
        assert!(!key.starts_with(r"\\?\"), "unstripped key: {key}");
        assert_eq!(
            Some(PathBuf::from(&key)),
            canonical_stripped(&project),
            "canonical_key and canonical_stripped must agree"
        );
        // A `..` spelling of the same directory lands on the same key.
        assert_eq!(canonical_key(project.join("sub").join("..")).unwrap(), key);
        // The key is itself a usable path that maps back to itself.
        assert_eq!(canonical_key(&key).unwrap(), key);
    }

    #[test]
    fn test_project_store_name_keeps_the_legacy_prefixed_hash() {
        // Store files were named from the raw `\\?\`-prefixed canonical on
        // Windows; the stripped key must resolve to the SAME file, or saved
        // MCP/skill/plugin defaults and branch configs stop loading.
        for (prefixed, stripped) in [
            (r"\\?\C:\git\maestro", r"C:\git\maestro"),
            (r"\\?\UNC\server\share\maestro", r"\\server\share\maestro"),
        ] {
            assert_eq!(strip_extended_length(prefixed), stripped);
            assert_eq!(project_store_name(stripped), project_store_name(prefixed));
        }
        // Pinned against the pre-change formula: sha256 of the prefixed
        // string, first 12 hex chars.
        use sha2::{Digest, Sha256};
        let legacy = format!("{:x}", Sha256::digest(r"\\?\C:\git\maestro".as_bytes()));
        assert_eq!(
            project_store_name(r"C:\git\maestro"),
            format!("maestro-{}.json", &legacy[..12])
        );
        // On a real directory, the key's store matches the old raw
        // `fs::canonicalize` spelling's store on whatever host runs this.
        let dir = tempdir().unwrap();
        let raw = std::fs::canonicalize(dir.path()).unwrap();
        let raw_hash = format!("{:x}", Sha256::digest(raw.to_string_lossy().as_bytes()));
        assert_eq!(
            project_store_name(&canonical_key(dir.path()).unwrap()),
            format!("maestro-{}.json", &raw_hash[..12])
        );
        // Non-Windows keys hash as-is, as before.
        let unix = format!("{:x}", Sha256::digest(b"/home/u/maestro"));
        assert_eq!(
            project_store_name("/home/u/maestro"),
            format!("maestro-{}.json", &unix[..12])
        );
    }

    #[test]
    fn test_project_store_name_is_pinned_for_a_fixed_list_of_inputs() {
        // Saved per-project store files on users' disks are named by this
        // hash, so it must never change. Values computed from the code before
        // the helpers moved out of the Samurai module (issue #610).
        for (key, expected) in [
            (r"C:\git\maestro", "maestro-d6a73308290b.json"),
            (r"\\?\C:\git\maestro", "maestro-d6a73308290b.json"),
            (r"\\server\share\maestro", "maestro-fed7fb8240f6.json"),
            (r"\\?\UNC\server\share\maestro", "maestro-fed7fb8240f6.json"),
            ("/home/u/maestro", "maestro-52f25210be02.json"),
            (r"relative\dir", "maestro-382185a5be70.json"),
            ("", "maestro-e3b0c44298fc.json"),
            ("d:", "maestro-972537e6c4eb.json"),
            (r"C:\Users\José\proj", "maestro-cef39b1d1cde.json"),
        ] {
            assert_eq!(project_store_name(key), expected, "store name of {key:?}");
        }
    }

    #[test]
    fn test_canonical_key_refuses_a_missing_path() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert!(canonical_key(&missing).is_err());
        assert!(canonical_stripped(&missing).is_none());
    }

    #[test]
    fn test_strip_extended_prefix() {
        assert_eq!(strip_extended_prefix(r"\\?\C:\git\proj"), r"C:\git\proj");
        assert_eq!(strip_extended_prefix(r"C:\git\proj"), r"C:\git\proj");
        assert_eq!(strip_extended_prefix("/home/x"), "/home/x");
    }

    /// Issue #165: a worktree canonicalized on a share must stay ABSOLUTE.
    /// Dropping only `\\?\` yielded `UNC\server\share\…`, which resolves
    /// against the process cwd — the launch working directory, the handoff
    /// resolution and every HEAD read then pointed at the wrong tree.
    #[test]
    fn test_strip_extended_prefix_keeps_a_unc_worktree_absolute() {
        assert_eq!(
            strip_extended_prefix(r"\\?\UNC\build01\shares\epic-wt"),
            r"\\build01\shares\epic-wt",
        );
        // Accept-on-read: a `worktree_path` already persisted under the
        // mangled spelling repairs back, same as #161 gave `project_path`.
        assert_eq!(
            strip_extended_prefix(r"UNC\build01\shares\epic-wt"),
            r"\\build01\shares\epic-wt",
        );
        // An already-plain UNC path is left alone (idempotent).
        assert_eq!(
            strip_extended_prefix(r"\\build01\shares\epic-wt"),
            r"\\build01\shares\epic-wt",
        );
    }

    #[cfg(windows)]
    #[test]
    fn test_canonical_stripped_keeps_unc_paths_absolute() {
        // `fs::canonicalize` returns `\\?\UNC\server\share\…` for anything
        // whose target is a network location (redirected AppData, a
        // share-hosted worktree). Stripping only `\\?\` leaves a RELATIVE
        // `UNC\…` path: the roots compare still passes (both sides mangled
        // alike) but `target.is_file()` resolves against the process cwd and
        // fails, so every managed delete died with "not a regular file".
        let dir = tempdir().unwrap();
        let file = dir.path().join("handoff-gen1.md");
        std::fs::write(&file, "# handoff\n").unwrap();

        let local = file.to_string_lossy().replace('/', "\\");
        // `C:\x\y` → `\\localhost\C$\x\y` (the admin share). Hosts with it
        // disabled simply skip — the test never asserts reachability.
        let Some((drive, rest)) = local.split_once(":\\") else {
            return;
        };
        let unc = format!(r"\\localhost\{drive}$\{rest}");
        if std::fs::metadata(&unc).is_err() {
            return;
        }

        let resolved = canonical_stripped(Path::new(&unc)).expect("a UNC path must resolve");
        assert!(
            resolved.is_absolute(),
            "{} must stay absolute",
            resolved.display()
        );
        assert!(
            resolved.is_file(),
            "{} must still resolve to the file",
            resolved.display()
        );
        assert!(
            !resolved.to_string_lossy().starts_with("UNC\\"),
            "{} must not keep the bare UNC\\ marker",
            resolved.display()
        );
    }
}
