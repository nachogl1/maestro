//! Persistent PR-review run records (issue #139; epic #136).
//!
//! A samurai run leaves a run config, handoffs, briefs and audit rows behind.
//! A **PR review** left nothing at all: the Git tab opened a terminal, typed a
//! prompt and forgot. With no artifact on disk the review had no identity, so
//! the Second Brain could not group its brief (issue #138) under anything, and
//! no audit row could ever attach to it.
//!
//! So every PR-review launch writes one small JSON record here — PR number and
//! title, the repo it belongs to, the checkout it ran in, the ticked steps, the
//! brief it was delivered as, and the terminal session it opened. That record
//! IS the group's identity ([`pr_group_id`]), exactly the way a run config is a
//! run's.
//!
//! **Layout:** one file per review terminal at
//! `<app data>/runs/<PR_RUNS_DIR>/<owner>-<repo>-<number>-<session>.json`.
//! Inside the `runs` root on purpose — that root is already a Samurai delete
//! root (`samurai_files::delete_file`), so a record is deletable through the
//! same guard as every other managed file with no new root to authorise. The
//! `pr` subdirectory can never collide with a run config's project directory:
//! those are always `<sanitized-basename>-<hash12>`
//! (`samurai_run_config::project_dir_name`), which `pr` is not, and
//! `RunConfigStore::load_all` skips this name explicitly.
//!
//! **Best effort, never blocking:** a launch that cannot write its record logs
//! and carries on. The review still runs; it simply groups under nothing until
//! the next launch — the same policy the brief write itself follows.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::samurai_brief::StagedBrief;
use super::samurai_files::normalize_project;

/// Directory name, inside the `runs` root, holding PR-review records.
pub const PR_RUNS_DIR: &str = "pr";

/// This app launch's id, computed once per process.
///
/// Records outlive the app; Maestro's PTY session ids do not — they restart at
/// 1 on every launch (`process_manager`'s `AtomicU32::new(1)`). Comparing a
/// stored `session_id` against the open terminals therefore matched an
/// unrelated shell after a restart, and the dead review reported itself LIVE:
/// its record and brief came back `in_use`, deletable only with `force`.
/// Pairing the session with the launch that issued it makes the comparison
/// mean what it reads as. Filesystem-safe by construction, because
/// [`record_file_name`] carries it too.
pub fn launch_id() -> &'static str {
    static LAUNCH_ID: OnceLock<String> = OnceLock::new();
    LAUNCH_ID.get_or_init(|| {
        format!(
            "{}-{}",
            chrono::Utc::now().format("%Y%m%d%H%M%S"),
            std::process::id()
        )
    })
}

/// Is this review's terminal one of the CURRENTLY open ones? True only when
/// the record was written by this app launch AND its session is still open —
/// a record from an earlier launch (or a pre-#136 record carrying no launch at
/// all) can never prove liveness, so it is treated as closed.
pub fn is_live(run: &PrReviewRun, open_session_ids: &HashSet<u32>) -> bool {
    run.launch_id == launch_id() && open_session_ids.contains(&run.session_id)
}

/// The record's `kind` discriminator. A one-variant enum so the SCREAMING wire
/// spelling is pinned by serde rather than by a string literal (the
/// `samurai_journal::MarkerKind` precedent).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PrRunKind {
    PrReview,
}

/// What a PR-review launch tells the store about itself. Everything the record
/// carries EXCEPT the two facts only the delivery path knows — the session the
/// terminal opened under and the brief it was actually staged as.
///
/// snake_case on the wire like every samurai sibling: this crosses the Tauri
/// boundary as a `terminal_arm_initial_prompt` parameter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrReviewLaunch {
    /// The pull request number.
    pub pr: u32,
    /// The PR title as the Git tab already had it — the label's title half.
    /// Empty when the payload carried none: the label then degrades to the
    /// ref alone, and the launch is never blocked for it.
    pub title: String,
    /// `owner/repo`. Empty when the PR url did not parse into a slug; the
    /// group id then keys off the empty slug, which still separates PRs by
    /// number within a checkout.
    pub repo: String,
    /// The checkout the review terminal opened in.
    pub project_path: String,
    /// The workflow step ids the user ticked, in order.
    pub steps: Vec<String>,
}

/// One PR review, on disk. Fields are snake_case on the wire like every
/// samurai sibling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrReviewRun {
    pub kind: PrRunKind,
    pub pr: u32,
    pub title: String,
    pub repo: String,
    pub project_path: String,
    pub steps: Vec<String>,
    /// Path of the brief the prompt was staged as (`samurai_brief`),
    /// RELATIVE to [`Self::brief_root`], or `None` when the prompt was short
    /// enough to type inline — a review is not required to have a brief.
    #[serde(default)]
    pub brief: Option<String>,
    /// The directory that relative path resolves against: the checkout the
    /// brief was actually written into (the arm call's `brief_dir`, which is
    /// the TAB's project). This is NOT [`Self::project_path`] — in a
    /// multi-repo workspace the tab's project and the PR's own checkout are
    /// different trees on purpose (`PrActionsMenu`, review finding C10), so
    /// resolving the brief against `project_path` looks for it in the wrong
    /// tree and, worse, can name a same-titled file that belongs to the user
    /// (issue #145).
    ///
    /// `None` on records written before this field existed. Such a record
    /// carries no evidence of where its brief landed, so the retention sweep
    /// skips it entirely rather than guess — missing evidence never deletes.
    #[serde(default)]
    pub brief_root: Option<String>,
    /// The Maestro terminal session the review opened in. Its liveness is what
    /// makes the group live — but only together with [`Self::launch_id`], see
    /// [`is_live`].
    pub session_id: u32,
    /// The app launch that opened that session ([`launch_id`]). Empty on
    /// records written before this field existed, which simply never match the
    /// running launch — the safe reading.
    #[serde(default)]
    pub launch_id: String,
    /// RFC 3339 UTC creation timestamp.
    pub created_at: String,
}

impl PrReviewRun {
    /// Builds a record from a launch plus the two delivery facts, stamped with
    /// the current UTC time and this app launch's id.
    pub fn now(launch: PrReviewLaunch, session_id: u32, brief: Option<StagedBrief>) -> Self {
        let (brief, brief_root) = match brief {
            Some(staged) => (
                Some(staged.relpath),
                Some(normalize_project(&staged.root.to_string_lossy())),
            ),
            None => (None, None),
        };
        Self {
            kind: PrRunKind::PrReview,
            pr: launch.pr,
            title: launch.title,
            repo: launch.repo,
            project_path: normalize_project(&launch.project_path),
            steps: launch.steps,
            brief,
            brief_root,
            session_id,
            launch_id: launch_id().to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// This review's group id (see [`pr_group_id`]).
    pub fn group_id(&self) -> String {
        pr_group_id(&self.repo, self.pr)
    }
}

/// The Second Brain group id of a PR review: `pr:<owner/repo>#<number>`
/// (issue #139). Stable across calls and across launches — two reviews of the
/// same PR are the same group, which is the point: their briefs and records
/// belong together.
pub fn pr_group_id(repo: &str, number: u32) -> String {
    format!("pr:{repo}#{number}")
}

/// The on-disk store, rooted at `<app data>/runs/<PR_RUNS_DIR>`. Constructed
/// once at app setup and managed as `Arc<PrRunStore>`; tests root it at a
/// tempdir.
pub struct PrRunStore {
    base_dir: PathBuf,
}

impl PrRunStore {
    /// `runs_dir` is the `runs` root itself — the store appends
    /// [`PR_RUNS_DIR`], so callers never have to know the layout.
    pub fn new(runs_dir: PathBuf) -> Self {
        Self {
            base_dir: runs_dir.join(PR_RUNS_DIR),
        }
    }

    /// Writes one record, returning its path. One file per review TERMINAL
    /// (see [`record_file_name`]): a relaunch of the same PR in a new terminal
    /// keeps its own record — they share a group, not a file — while a re-arm
    /// of the same terminal rewrites the one record it already has.
    pub fn record(&self, run: &PrReviewRun) -> Result<PathBuf, String> {
        std::fs::create_dir_all(&self.base_dir).map_err(|e| {
            format!(
                "failed to create the PR run directory {}: {e}",
                self.base_dir.display()
            )
        })?;
        let path = self.base_dir.join(record_file_name(run));
        let json = serde_json::to_string_pretty(run)
            .map_err(|e| format!("failed to serialize the PR review record: {e}"))?;
        std::fs::write(&path, json)
            .map_err(|e| format!("failed to write {}: {e}", path.display()))?;
        Ok(path)
    }

    /// Every readable record with its on-disk path — the Second Brain
    /// inventory's input. Corrupt files are skipped with a warning, like
    /// `RunConfigStore::load_all`: one torn record must not blank the panel.
    pub fn list_with_paths(&self) -> Vec<(PathBuf, PrReviewRun)> {
        let mut runs: Vec<(PathBuf, PrReviewRun)> = Vec::new();
        let Ok(files) = std::fs::read_dir(&self.base_dir) else {
            // Nothing recorded yet — the normal first-launch state.
            return runs;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|c| serde_json::from_str::<PrReviewRun>(&c).map_err(|e| e.to_string()))
            {
                Ok(mut run) => {
                    // A record written before #161 carries the mangled
                    // relative spelling of a UNC checkout. Repaired here, in
                    // memory only: the brief provably landed under the same
                    // directory — `UNC\server\share\…` was only ever produced
                    // from `\\?\UNC\server\share\…` — so the sweep and the
                    // Second Brain get the absolute root back without the
                    // record file being rewritten.
                    run.project_path = normalize_project(&run.project_path);
                    run.brief_root = run.brief_root.as_deref().map(normalize_project);
                    runs.push((path, run));
                }
                Err(e) => log::warn!("samurai pr runs: skipping unreadable record {path:?}: {e}"),
            }
        }
        runs
    }
}

/// `<owner>-<repo>-<number>-<launch>-<session>.json`, the repo segment
/// sanitized to `[a-z0-9-]` because `owner/repo` carries a slash, which is not
/// a legal Windows file name character.
///
/// Keyed on the SESSION, not the creation timestamp. A timestamp made the name
/// unstable in both directions: two launches in the same tick produced the
/// same name and overwrote each other, while a re-arm of one session — which
/// replaces the staged prompt rather than queueing a second one
/// (`InitialPromptInjector::arm`) — produced a second name and left one review
/// with several records. One review terminal now owns exactly one record file,
/// rewritten in place if it is re-armed.
///
/// And keyed on the LAUNCH as well as the session, for the reason
/// [`launch_id`] exists: session ids restart at 1 each launch, so the session
/// alone would let today's terminal 3 overwrite last week's review of the same
/// PR — silently destroying the only record it left.
fn record_file_name(run: &PrReviewRun) -> String {
    let repo = sanitize(&run.repo);
    format!(
        "{repo}-{}-{}-{}.json",
        run.pr, run.launch_id, run.session_id
    )
}

/// Lowercased, with every run of non-`[a-z0-9]` characters collapsed to one
/// `-` and the ends trimmed (the `prActionBriefStem` rule, in Rust).
fn sanitize(value: &str) -> String {
    let collapsed: String = value
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let mut out = String::with_capacity(collapsed.len());
    let mut last_dash = false;
    for c in collapsed.chars() {
        if c == '-' {
            if !last_dash {
                out.push(c);
            }
            last_dash = true;
        } else {
            out.push(c);
            last_dash = false;
        }
    }
    out.trim_matches('-').to_string()
}

/// Path of the brief a PR review was staged as, for LISTING. Whenever the
/// record carries a staging root this is exactly [`staged_brief_path`] — the
/// listed row and the deletable path are then the same file by construction,
/// which is what keeps the Second Brain from offering a Delete the guard must
/// refuse.
///
/// Only a record written BEFORE [`PrReviewRun::brief_root`] existed falls back
/// to the checkout, and that fallback is explicitly best-effort ATTRIBUTION:
/// it is right whenever the tab's project and the PR's checkout coincide (the
/// single-repo case) and, when they do not, it can name a same-titled brief in
/// the PR's checkout that belongs to a DIFFERENT review of the same PR. Both
/// trees' `.maestro/briefs/` are Maestro-owned, so the cost is a misattributed
/// row, never a file outside Maestro — and it applies to legacy records only,
/// which stop being written the moment this version runs.
///
/// A record whose root is present but unusable (not absolute) resolves to
/// `None` rather than to a guess: there is nothing honest to list.
pub fn brief_path(run: &PrReviewRun) -> Option<PathBuf> {
    if run.brief_root.is_some() {
        return staged_brief_path(run);
    }
    let brief = run.brief.as_deref()?;
    Some(Path::new(&run.project_path).join(brief))
}

/// Where the brief PROVABLY landed: `Some` only when the record carries both
/// halves ([`PrReviewRun::brief`] and [`PrReviewRun::brief_root`]) and the
/// root is ABSOLUTE. Anything else is `None`.
///
/// The absoluteness check is not pedantry: a relative root resolves against
/// the PROCESS's working directory, so a record carrying one would point the
/// #145 retention sweep at `<cwd>/.maestro/briefs/` — a directory belonging to
/// whatever the app happened to be started from. A record written before
/// `brief_root` existed has no evidence at all and is `None` for the same
/// reason: missing evidence never deletes.
pub fn staged_brief_path(run: &PrReviewRun) -> Option<PathBuf> {
    let (brief, root) = (run.brief.as_deref()?, run.brief_root.as_deref()?);
    let root = Path::new(root);
    if !root.is_absolute() {
        return None;
    }
    Some(root.join(brief))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// A record whose PROJECT PATH arrives in the Windows verbatim spelling —
    /// the shape the frontend can hand over when a path went through
    /// `fs::canonicalize` somewhere upstream.
    fn verbatim_launch() -> PrReviewLaunch {
        PrReviewLaunch {
            project_path: r"\\?\C:\git\maestro".to_string(),
            ..launch()
        }
    }

    /// The tab's project: an ABSOLUTE directory in the host's own spelling.
    /// [`staged_brief_path`] requires absoluteness, and a `C:\…` literal is
    /// not absolute on the Linux CI runner.
    fn workspace() -> PathBuf {
        std::env::temp_dir().join("maestro-tab-project")
    }

    /// A brief staged under the tab's project — a DIFFERENT tree from the
    /// `launch()` checkout on purpose (issue #145), so any test that resolves
    /// a brief proves which root it used.
    fn staged(relpath: &str) -> Option<StagedBrief> {
        Some(StagedBrief {
            root: workspace(),
            relpath: relpath.to_string(),
        })
    }

    fn launch() -> PrReviewLaunch {
        PrReviewLaunch {
            pr: 142,
            title: "fix journal splitting".to_string(),
            repo: "nachogl1/maestro".to_string(),
            project_path: r"C:\git\maestro".to_string(),
            steps: vec!["check".to_string(), "review".to_string()],
        }
    }

    #[test]
    fn test_record_roundtrips_with_the_agreed_wire_shape() {
        let dir = tempdir().unwrap();
        let store = PrRunStore::new(dir.path().to_path_buf());
        let run = PrReviewRun::now(
            launch(),
            7,
            staged(".maestro/briefs/pr-142-check-review.md"),
        );

        let path = store.record(&run).unwrap();
        assert_eq!(store.list_with_paths(), vec![(path.clone(), run.clone())]);

        // The exact JSON the issue specifies — dependent surfaces read these
        // keys, and `kind` is the SCREAMING discriminator.
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for key in [
            "kind",
            "pr",
            "title",
            "repo",
            "project_path",
            "steps",
            "brief",
            "brief_root",
            "session_id",
            "launch_id",
            "created_at",
        ] {
            assert!(raw.get(key).is_some(), "missing key {key} in {raw}");
        }
        assert_eq!(raw["kind"], "PR_REVIEW");
        assert_eq!(raw["pr"], 142);
        assert_eq!(raw["brief"], ".maestro/briefs/pr-142-check-review.md");
        assert!(chrono::DateTime::parse_from_rfc3339(&run.created_at).is_ok());
    }

    #[test]
    fn test_file_name_is_filesystem_safe_and_one_file_per_review_terminal() {
        // `owner/repo` carries a slash, which is not legal in a Windows file
        // name, so the repo segment is sanitized. And a second review of the
        // same PR in another terminal must not overwrite the first record.
        let dir = tempdir().unwrap();
        let store = PrRunStore::new(dir.path().to_path_buf());

        let mut first = PrReviewRun::now(launch(), 7, None);
        first.created_at = "2026-08-17T12:00:00+00:00".to_string();
        let mut second = PrReviewRun::now(launch(), 9, None);
        second.created_at = "2026-08-17T13:30:00+00:00".to_string();

        let a = store.record(&first).unwrap();
        let b = store.record(&second).unwrap();
        assert_ne!(a, b);
        let name = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("nachogl1-maestro-142-"), "{name}");
        assert!(
            !name.contains('/') && !name.contains(':'),
            "unsafe file name {name}"
        );
        assert_eq!(store.list_with_paths().len(), 2);
        // Absent brief: `None`, not a fabricated path.
        assert!(store
            .list_with_paths()
            .iter()
            .all(|(_, r)| r.brief.is_none()));
    }

    #[test]
    fn test_relaunching_one_session_replaces_its_record_instead_of_duplicating() {
        // The arm path is a REPLACE ("one session, one initial prompt"), so a
        // re-arm must leave one record, not a second row for the same review.
        // Two launches in the same tick must not collide either — the name is
        // keyed on the session, never on the timestamp.
        let dir = tempdir().unwrap();
        let store = PrRunStore::new(dir.path().to_path_buf());

        let mut first = PrReviewRun::now(launch(), 7, None);
        first.created_at = "2026-08-17T12:00:00+00:00".to_string();
        let mut rearmed = PrReviewRun::now(launch(), 7, staged("b.md"));
        rearmed.created_at = "2026-08-17T12:00:00+00:00".to_string();
        let mut other_session = PrReviewRun::now(launch(), 8, None);
        other_session.created_at = "2026-08-17T12:00:00+00:00".to_string();

        assert_eq!(
            store.record(&first).unwrap(),
            store.record(&rearmed).unwrap()
        );
        store.record(&other_session).unwrap();

        let recorded = store.list_with_paths();
        assert_eq!(recorded.len(), 2, "one record per session: {recorded:?}");
        assert!(
            recorded
                .iter()
                .any(|(_, r)| r.brief.as_deref() == Some("b.md")),
            "the re-arm's record won: {recorded:?}"
        );
    }

    #[test]
    fn test_a_record_is_stamped_and_named_with_the_app_launch() {
        let dir = tempdir().unwrap();
        let store = PrRunStore::new(dir.path().to_path_buf());

        let run = PrReviewRun::now(launch(), 3, None);
        assert_eq!(run.launch_id, launch_id());
        assert!(!run.launch_id.is_empty());

        // The launch is in the FILE NAME too: without it a session id reused
        // across app launches would overwrite the older launch's record of
        // the same PR — the record is the only proof that review happened.
        let path = store.record(&run).unwrap();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.contains(launch_id()), "{name}");
        assert!(name.starts_with("nachogl1-maestro-142-"), "{name}");

        let mut older = PrReviewRun::now(launch(), 3, None);
        older.launch_id = "20200101000000-1".to_string();
        assert_ne!(store.record(&older).unwrap(), path);
        assert_eq!(store.list_with_paths().len(), 2);
    }

    #[test]
    fn test_a_record_from_an_earlier_launch_is_never_live() {
        // PTY session ids restart at 1 every app launch (`process_manager`)
        // while records persist forever, so `session_id` alone cannot mean
        // "this terminal": after a restart, terminal 3 is an unrelated shell.
        let open: HashSet<u32> = HashSet::from([3]);
        let current = PrReviewRun::now(launch(), 3, None);
        assert!(is_live(&current, &open));
        assert!(!is_live(&current, &HashSet::from([4])));

        let mut older = current.clone();
        older.launch_id = "20200101000000-1".to_string();
        assert!(!is_live(&older, &open));

        // A record written before this field existed carries no launch at
        // all — unprovable, therefore not live.
        let mut legacy = current.clone();
        legacy.launch_id = String::new();
        assert!(!is_live(&legacy, &open));
    }

    #[test]
    fn test_legacy_records_without_a_launch_id_still_load() {
        let dir = tempdir().unwrap();
        let store = PrRunStore::new(dir.path().to_path_buf());
        std::fs::create_dir_all(dir.path().join(PR_RUNS_DIR)).unwrap();
        std::fs::write(
            dir.path().join(PR_RUNS_DIR).join("legacy.json"),
            r#"{"kind":"PR_REVIEW","pr":142,"title":"t","repo":"o/r",
                "project_path":"C:/git/maestro","steps":[],"session_id":3,
                "created_at":"2026-08-17T12:00:00+00:00"}"#,
        )
        .unwrap();

        let loaded = store.list_with_paths();
        assert_eq!(loaded.len(), 1, "a pre-launch-id record must still read");
        assert_eq!(loaded[0].1.launch_id, "");
    }

    #[test]
    fn test_group_id_is_stable_and_per_pr() {
        let run = PrReviewRun::now(launch(), 7, None);
        assert_eq!(run.group_id(), "pr:nachogl1/maestro#142");
        assert_eq!(run.group_id(), pr_group_id("nachogl1/maestro", 142));
        assert_ne!(run.group_id(), pr_group_id("nachogl1/maestro", 143));
        assert_ne!(run.group_id(), pr_group_id("other/maestro", 142));
    }

    #[test]
    fn test_unreadable_records_are_skipped_not_fatal() {
        let dir = tempdir().unwrap();
        let store = PrRunStore::new(dir.path().to_path_buf());
        store.record(&PrReviewRun::now(launch(), 7, None)).unwrap();
        std::fs::write(dir.path().join(PR_RUNS_DIR).join("torn.json"), "{ not json").unwrap();
        std::fs::write(dir.path().join(PR_RUNS_DIR).join("notes.txt"), "ignored").unwrap();

        assert_eq!(store.list_with_paths().len(), 1);
    }

    #[test]
    fn test_the_checkout_is_normalized_on_construction() {
        // Run configs normalize on save (`samurai_run_config`), and the audit
        // file name hashes the project string — so a `\\?\`-prefixed spelling
        // stored raw here hashed to a DIFFERENT audit file and the PR group
        // counted zero audit rows against a log full of its own.
        let run = PrReviewRun::now(verbatim_launch(), 7, None);
        assert_eq!(run.project_path, r"C:\git\maestro");
        assert_eq!(
            run.project_path,
            PrReviewRun::now(launch(), 7, None).project_path
        );
        // The staging root normalizes on the same rule — it is a checkout
        // spelling too, and a verbatim one keys a different tree.
        let run = PrReviewRun::now(
            verbatim_launch(),
            7,
            Some(StagedBrief {
                root: PathBuf::from(r"\\?\C:\git\maestro"),
                relpath: "a.md".to_string(),
            }),
        );
        assert_eq!(run.brief_root.as_deref(), Some(r"C:\git\maestro"));
    }

    #[test]
    fn test_normalization_keeps_a_unc_checkout_absolute() {
        // Issue #161: `\\?\UNC\server\share\…` must strip to
        // `\\server\share\…`, never to a relative-looking
        // `UNC\server\share\…` — [`staged_brief_path`] rejects a relative
        // root, so the #145 sweep silently never ran on a share-hosted
        // checkout.
        let run = PrReviewRun::now(
            PrReviewLaunch {
                project_path: r"\\?\UNC\server\share\maestro".to_string(),
                ..launch()
            },
            7,
            Some(StagedBrief {
                root: PathBuf::from(r"\\?\UNC\server\share\tab"),
                relpath: "a.md".to_string(),
            }),
        );
        assert_eq!(run.project_path, r"\\server\share\maestro");
        assert_eq!(run.brief_root.as_deref(), Some(r"\\server\share\tab"));
    }

    #[test]
    fn test_list_repairs_records_written_under_the_old_normalization() {
        // A record persisted before #161 carries the mangled relative
        // spelling. Reading repairs it in memory, so the retention sweep and
        // the Second Brain see the absolute tree the brief was really staged
        // under — without rewriting the file.
        let dir = tempdir().unwrap();
        let store = PrRunStore::new(dir.path().to_path_buf());
        let mut run = PrReviewRun::now(launch(), 7, staged("a.md"));
        run.project_path = r"UNC\server\share\maestro".to_string();
        run.brief_root = Some(r"UNC\server\share\tab".to_string());
        store.record(&run).unwrap();

        let listed = store.list_with_paths();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].1.project_path, r"\\server\share\maestro");
        assert_eq!(
            listed[0].1.brief_root.as_deref(),
            Some(r"\\server\share\tab")
        );
    }

    #[test]
    fn test_brief_path_resolves_against_the_tree_the_brief_was_staged_in() {
        // Issue #145: the brief lands in the TAB's project, which in a
        // multi-repo workspace is not the PR's own checkout.
        let relpath = ".maestro/briefs/pr-142-check-review.md";
        let run = PrReviewRun::now(launch(), 7, staged(relpath));
        assert_eq!(brief_path(&run).unwrap(), workspace().join(relpath));
        assert!(brief_path(&PrReviewRun::now(launch(), 7, None)).is_none());

        // A pre-#145 record knows only the relative half. LISTING falls back
        // to the checkout — a guess that is right in the single-repo case and
        // costs only a row that does not stat when it is wrong.
        let mut legacy = run.clone();
        legacy.brief_root = None;
        assert_eq!(
            brief_path(&legacy).unwrap(),
            Path::new(r"C:\git\maestro").join(relpath)
        );

        // A root that IS recorded but cannot be used is not an invitation to
        // fall back — the listing would then show a row the delete guard has
        // to refuse.
        let mut relative = run.clone();
        relative.brief_root = Some("..".to_string());
        assert!(brief_path(&relative).is_none());
    }

    #[test]
    fn test_staged_brief_path_refuses_to_guess() {
        // The DESTRUCTIVE resolution never falls back and never resolves
        // against the process cwd: without both halves, and without an
        // absolute root, there is no evidence and the answer is `None`.
        let relpath = ".maestro/briefs/pr-142-check-review.md";
        let run = PrReviewRun::now(launch(), 7, staged(relpath));
        let absolute = std::env::temp_dir();
        let mut here = run.clone();
        here.brief_root = Some(absolute.to_string_lossy().into_owned());
        assert_eq!(staged_brief_path(&here).unwrap(), absolute.join(relpath));

        let mut legacy = run.clone();
        legacy.brief_root = None;
        assert!(staged_brief_path(&legacy).is_none(), "no staging evidence");

        let mut relative = run.clone();
        relative.brief_root = Some("..".to_string());
        assert!(
            staged_brief_path(&relative).is_none(),
            "a relative root would resolve against the process cwd"
        );

        assert!(staged_brief_path(&PrReviewRun::now(launch(), 7, None)).is_none());
    }
}
