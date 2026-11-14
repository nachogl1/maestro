//! Persistent PR-review run records (issue #139; epic #136).
//!
//! A **PR review** used to leave nothing on disk: the Git tab opened a
//! terminal, typed a prompt and forgot, so the brief it staged (issue #138)
//! could never be found again.
//!
//! So every PR-review launch writes one small JSON record here — PR number and
//! title, the repo it belongs to, the checkout it ran in, the ticked steps, the
//! brief it was delivered as, and the terminal session it opened. That record
//! IS the review's identity ([`pr_group_id`]), and it is what the startup
//! sweep ([`PrRunStore::sweep_expired_briefs`]) reads to find old briefs.
//!
//! **Layout:** one file per review terminal at
//! `<app data>/runs/<PR_RUNS_DIR>/<owner>-<repo>-<number>-<session>.json`.
//!
//! **Best effort, never blocking:** a launch that cannot write its record logs
//! and carries on. The review still runs; it simply groups under nothing until
//! the next launch — the same policy the brief write itself follows.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::brief_files::{StagedBrief, BRIEF_DIR};
use super::extended_paths::{canonical_stripped, normalize_project, strip_extended_length};

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
/// spelling is pinned by serde rather than by a string literal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PrRunKind {
    PrReview,
}

/// What a PR-review launch tells the store about itself. Everything the record
/// carries EXCEPT the two facts only the delivery path knows — the session the
/// terminal opened under and the brief it was actually staged as.
///
/// snake_case on the wire: this crosses the Tauri
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

/// One PR review, on disk. Fields are snake_case on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrReviewRun {
    pub kind: PrRunKind,
    pub pr: u32,
    pub title: String,
    pub repo: String,
    pub project_path: String,
    pub steps: Vec<String>,
    /// Path of the brief the prompt was staged as (`brief_files`),
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

/// The group id of a PR review: `pr:<owner/repo>#<number>`
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

    /// Every readable record with its on-disk path — the retention sweep's
    /// input. Corrupt files are skipped with a warning: one torn record must
    /// not stop the others being read.
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
                    // from `\\?\UNC\server\share\…` — so the sweep gets the
                    // absolute root back without the record file being
                    // rewritten.
                    run.project_path = normalize_project(&run.project_path);
                    run.brief_root = run.brief_root.as_deref().map(normalize_project);
                    runs.push((path, run));
                }
                Err(e) => log::warn!("PR runs: skipping unreadable record {path:?}: {e}"),
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

/// How many days a PR review's brief is kept before the startup sweep removes
/// it — the default of the retention setting this constant replaced
/// (issue #614).
pub const PR_REVIEW_BRIEF_RETENTION_DAYS: u32 = 14;

/// Seconds in one retention day. Named because the retention window is the
/// one place a bare `24 * 60 * 60` would read as arithmetic rather than as
/// the unit the window is expressed in.
const SECS_PER_RETENTION_DAY: u64 = 24 * 60 * 60;

/// The brief directory inside the checkout a brief was staged in, with any
/// Windows `\\?\` prefix stripped.
fn brief_dir(root: &str) -> PathBuf {
    PathBuf::from(strip_extended_length(root)).join(BRIEF_DIR)
}

impl PrRunStore {
    /// The startup sweep: removes every recorded review's brief older than
    /// [`PR_REVIEW_BRIEF_RETENTION_DAYS`]. Startup is before any terminal
    /// exists, so no session is open and the age gate alone protects a review
    /// that is still running. Returns the removed paths for the caller's log.
    pub fn sweep_expired_briefs(&self) -> Vec<PathBuf> {
        sweep_pr_review_briefs(
            &self.list_with_paths(),
            &HashSet::new(),
            PR_REVIEW_BRIEF_RETENTION_DAYS,
        )
    }
}

/// Issue #145: the brief a PR review is staged as (`commands::initial_prompt`,
/// issue #138) is written into the user's OWN checkout, and nothing else ever
/// removes it, so every review would leave one more `.maestro/briefs/pr-*.md`
/// behind, forever. Returns the removed paths for the caller's log.
///
/// A PR review has no completion signal to age from, so the policy is a
/// window of `retention_days` on the file's mtime (a brief is written once and
/// never touched again, so its mtime IS that review's start). A brief is swept
/// only once no terminal this launch opened still holds it ([`is_live`]) — and
/// that signal cannot survive a restart, because PTY session ids restart at
/// 1, so an unknown terminal after one counts as CLOSED. The AGE gate is what
/// protects a live review, not the terminal signal.
///
/// **This is the user's working tree, not a throwaway worktree** — a wrong
/// delete destroys real work, so nothing the record says is taken on trust:
///
/// * The brief resolves against [`PrReviewRun::brief_root`], the directory it
///   was actually staged under, NEVER against `project_path`. Those are
///   different trees in a multi-repo workspace (`PrActionsMenu`, review
///   finding C10), so `project_path` would both miss the real brief and name
///   a same-titled file in the PR's checkout that belongs to the user.
/// * A record with no `brief_root`, or a relative one, is skipped —
///   [`staged_brief_path`] refuses to guess, and a relative root would
///   resolve against the process cwd.
/// * The resolved file must canonicalize INSIDE the brief directory of that
///   staging root and end in `.md`, which refuses a `..` spelling and an
///   absolute path alike, and it must be a regular file — a directory named
///   `x.md` otherwise reached `remove_file` and was refused only by the OS.
///
/// Missing evidence never deletes: an unreadable mtime, an absent file or an
/// unresolvable brief directory is skipped.
pub fn sweep_pr_review_briefs(
    runs: &[(PathBuf, PrReviewRun)],
    open_session_ids: &HashSet<u32>,
    retention_days: u32,
) -> Vec<PathBuf> {
    let max_age = Duration::from_secs(u64::from(retention_days) * SECS_PER_RETENTION_DAY);
    // Two reviews of the same PR with the same steps stage the same file
    // name, so a DEAD record can point at the very brief a live relaunch is
    // reading. Skipping live records one by one would not catch that; the
    // paths the live ones hold are collected up front and never touched.
    // BOTH spellings go in — a live brief that is momentarily unresolvable
    // (transient IO, or `write_brief`'s temp-then-rename window) would drop
    // out of a canonicalized-only allow-list exactly when it matters most.
    let mut live_briefs: HashSet<PathBuf> = HashSet::new();
    for (_, run) in runs
        .iter()
        .filter(|(_, run)| is_live(run, open_session_ids))
    {
        let Some(brief) = staged_brief_path(run) else {
            continue;
        };
        live_briefs.extend(canonical_stripped(&brief));
        live_briefs.insert(brief);
    }
    let mut removed: Vec<PathBuf> = Vec::new();
    for (_, run) in runs {
        if is_live(run, open_session_ids) {
            continue;
        }
        // No staging evidence (no brief at all, a pre-#145 record, or a root
        // that is not absolute) — nothing this sweep may act on.
        let Some(staged) = staged_brief_path(run) else {
            continue;
        };
        // Already gone: a record outlives the file it points at, and a second
        // record sharing the name finds nothing left to resolve.
        let Some(target) = canonical_stripped(&staged) else {
            continue;
        };
        if target.extension().and_then(|e| e.to_str()) != Some("md")
            || live_briefs.contains(&target)
            || live_briefs.contains(&staged)
        {
            continue;
        }
        let Some(root) = run
            .brief_root
            .as_deref()
            .map(brief_dir)
            .as_deref()
            .and_then(canonical_stripped)
        else {
            continue;
        };
        if target == root || !target.starts_with(&root) {
            log::warn!(
                "PR review retention: brief {} resolves outside {} — refusing to sweep it",
                target.display(),
                root.display()
            );
            continue;
        }
        let expired = std::fs::metadata(&target)
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age >= max_age);
        if !expired {
            continue;
        }
        match std::fs::remove_file(&target) {
            Ok(()) => removed.push(target),
            Err(e) => log::warn!(
                "PR review retention: failed to delete expired brief {}: {e}",
                target.display()
            ),
        }
    }
    removed
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
        // A `\\?\`-prefixed spelling stored raw would never compare equal to
        // the same checkout spelled plainly.
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

    /// Sets a file's last-modified time `days` days into the past.
    fn age_by_days(path: &Path, days: u64) {
        let age = std::time::Duration::from_secs(days * SECS_PER_RETENTION_DAY);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - age)
            .unwrap();
    }

    #[test]
    fn test_the_startup_sweep_removes_briefs_older_than_the_fixed_number_of_days() {
        // Issue #614: the retention window is no longer a setting; briefs go
        // once they are older than the fixed number of days, and not before.
        let app_data = tempdir().unwrap();
        let checkout = tempdir().unwrap();
        let store = PrRunStore::new(app_data.path().to_path_buf());
        let days = u64::from(PR_REVIEW_BRIEF_RETENTION_DAYS);
        let mut briefs = Vec::new();
        for (session, name, age) in [(7, "pr-1-old.md", days + 1), (8, "pr-2-new.md", days - 1)] {
            let path = checkout.path().join(BRIEF_DIR).join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "# pr review brief\n").unwrap();
            age_by_days(&path, age);
            let staged = StagedBrief {
                root: checkout.path().to_path_buf(),
                relpath: format!("{BRIEF_DIR}/{name}"),
            };
            store
                .record(&PrReviewRun::now(launch(), session, Some(staged)))
                .unwrap();
            briefs.push(path);
        }

        let removed = store.sweep_expired_briefs();

        assert_eq!(removed.len(), 1, "removed: {removed:?}");
        assert!(!briefs[0].exists(), "a brief past the window is removed");
        assert!(briefs[1].exists(), "a brief inside the window is kept");
    }

    /// A PR-review record that groups under `about` (the PR's own checkout,
    /// the record's `project_path`) while its brief was staged under
    /// `staged_in` (the arm call's `brief_dir`, i.e. the TAB's project).
    /// `brief` is the relative spelling `brief_files::write_brief` returns.
    fn pr_review_staged_in(
        about: &Path,
        staged_in: &Path,
        session: u32,
        brief: Option<String>,
    ) -> PrReviewRun {
        PrReviewRun::now(
            PrReviewLaunch {
                pr: 145,
                title: "sweep pr briefs".to_string(),
                repo: "nachogl1/maestro".to_string(),
                project_path: about.to_string_lossy().to_string(),
                steps: vec!["review".to_string()],
            },
            session,
            brief.map(|relpath| StagedBrief {
                root: staged_in.to_path_buf(),
                relpath,
            }),
        )
    }

    /// The single-repo case: the tab's project and the PR's checkout are the
    /// same tree.
    fn pr_review(checkout: &Path, session: u32, brief: Option<String>) -> PrReviewRun {
        pr_review_staged_in(checkout, checkout, session, brief)
    }

    /// Writes `<checkout>/.maestro/briefs/<name>` and returns its path.
    fn staged_brief(checkout: &Path, name: &str) -> PathBuf {
        let dir = checkout.join(BRIEF_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, "# pr review brief\n").unwrap();
        path
    }

    /// The store hands the sweep `(path, record)` pairs; the record path is
    /// never the thing being swept, so any spelling does.
    fn records(runs: Vec<PrReviewRun>) -> Vec<(PathBuf, PrReviewRun)> {
        runs.into_iter()
            .enumerate()
            .map(|(i, run)| (PathBuf::from(format!("pr-{i}.json")), run))
            .collect()
    }

    #[test]
    fn test_pr_brief_sweep_removes_an_expired_closed_reviews_brief() {
        // Issue #145: a PR review's brief lands in the user's own checkout,
        // which no run config archives — nothing ever swept it.
        let checkout = tempdir().unwrap();
        let brief = staged_brief(checkout.path(), "pr-145-review.md");
        let stray = checkout.path().join(BRIEF_DIR).join("notes.txt");
        std::fs::write(&stray, "not a brief").unwrap();
        let runs = records(vec![pr_review(
            checkout.path(),
            7,
            Some(format!("{BRIEF_DIR}/pr-145-review.md")),
        )]);
        let none_open = HashSet::new();

        // Inside the fixed window: nothing goes.
        assert!(
            sweep_pr_review_briefs(&runs, &none_open, PR_REVIEW_BRIEF_RETENTION_DAYS).is_empty()
        );
        assert!(brief.exists());

        // Expired. `0` is the age boundary this test can reach without a fake
        // clock.
        let removed = sweep_pr_review_briefs(&runs, &none_open, 0);
        assert_eq!(removed.len(), 1, "removed: {removed:?}");
        assert!(!brief.exists());
        assert!(stray.exists(), "only .md briefs are swept");

        // Idempotent: the record outlives the brief it points at.
        assert!(sweep_pr_review_briefs(&runs, &none_open, 0).is_empty());
    }

    #[test]
    fn test_pr_brief_sweep_uses_the_tree_the_brief_was_staged_in() {
        // Review finding C10 / issue #145: `briefDir` is the TAB's project —
        // the terminal's working directory, where the pointer's relative path
        // resolves — while the record's `project_path` is the PR's OWN
        // checkout. In a multi-repo workspace those are different trees, and
        // both can hold a `pr-<n>-<steps>.md`. Resolving against
        // `project_path` therefore misses the real brief AND deletes the
        // user's same-named file in the other tree.
        let root = tempdir().unwrap();
        let tab_project = root.path().join("workspace");
        let pr_checkout = root.path().join("the-pr-repo");
        let staged = staged_brief(&tab_project, "pr-145-review.md");
        let decoy = staged_brief(&pr_checkout, "pr-145-review.md");

        let runs = records(vec![pr_review_staged_in(
            &pr_checkout,
            &tab_project,
            7,
            Some(format!("{BRIEF_DIR}/pr-145-review.md")),
        )]);
        let removed = sweep_pr_review_briefs(&runs, &HashSet::new(), 0);

        assert_eq!(removed.len(), 1, "removed: {removed:?}");
        assert!(!staged.exists(), "the brief actually staged is swept");
        assert!(
            decoy.exists(),
            "a same-named file in the PR's own checkout is NOT this review's brief"
        );
    }

    #[test]
    fn test_pr_brief_sweep_skips_a_record_with_no_staging_evidence() {
        // A record written before `brief_root` existed knows only a relative
        // path, and a relative root would resolve against the process cwd.
        // Neither is evidence, so neither deletes.
        let checkout = tempdir().unwrap();
        let brief = staged_brief(checkout.path(), "pr-145-review.md");
        let relpath = format!("{BRIEF_DIR}/pr-145-review.md");

        let mut legacy = pr_review(checkout.path(), 7, Some(relpath.clone()));
        legacy.brief_root = None;
        let mut relative = pr_review(checkout.path(), 8, Some(relpath));
        relative.brief_root = Some(".".to_string());

        assert!(
            sweep_pr_review_briefs(&records(vec![legacy, relative]), &HashSet::new(), 0).is_empty()
        );
        assert!(brief.exists());
    }

    #[test]
    fn test_pr_brief_sweep_keeps_a_live_reviews_brief() {
        let checkout = tempdir().unwrap();
        let brief = staged_brief(checkout.path(), "pr-145-review.md");
        let live = pr_review(
            checkout.path(),
            7,
            Some(format!("{BRIEF_DIR}/pr-145-review.md")),
        );
        let open: HashSet<u32> = HashSet::from([7]);
        let runs = records(vec![live.clone()]);

        assert!(sweep_pr_review_briefs(&runs, &open, 0).is_empty());
        assert!(brief.exists(), "the terminal reading it is still open");

        // Two reviews of the same PR with the same steps stage the SAME file
        // name, so a dead record can point at the brief a live relaunch is
        // reading — the dead one must not delete it either.
        let stale = PrReviewRun {
            launch_id: "20200101000000-1".to_string(),
            ..live.clone()
        };
        let shared = records(vec![live, stale]);
        assert!(sweep_pr_review_briefs(&shared, &open, 0).is_empty());
        assert!(brief.exists());

        // Closing the terminal (or a restart, which can never prove liveness)
        // releases it.
        assert_eq!(sweep_pr_review_briefs(&shared, &HashSet::new(), 0).len(), 1);
        assert!(!brief.exists());
    }

    #[test]
    fn test_pr_brief_sweep_ignores_a_review_with_no_brief() {
        // A short prompt is typed inline — the record carries `brief: None`
        // and there is nothing to sweep.
        let checkout = tempdir().unwrap();
        let kept = staged_brief(checkout.path(), "pr-145-review.md");
        let runs = records(vec![pr_review(checkout.path(), 7, None)]);

        assert!(sweep_pr_review_briefs(&runs, &HashSet::new(), 0).is_empty());
        assert!(
            kept.exists(),
            "a record with no brief must not sweep the directory"
        );
    }

    #[test]
    fn test_pr_brief_sweep_refuses_a_brief_that_escapes_the_checkout() {
        // The `brief` field is data read back off disk, and this is the
        // user's OWN working tree — a `..` spelling or an absolute path must
        // never resolve into a delete.
        let root = tempdir().unwrap();
        let checkout = root.path().join("checkout");
        std::fs::create_dir_all(checkout.join(BRIEF_DIR)).unwrap();
        let outside = root.path().join("real-work.md");
        std::fs::write(&outside, "# the user's own file\n").unwrap();

        let runs = records(vec![
            pr_review(
                &checkout,
                7,
                Some(format!("{BRIEF_DIR}/../../../real-work.md")),
            ),
            pr_review(
                &checkout,
                8,
                Some(outside.to_string_lossy().replace('\\', "/")),
            ),
        ]);

        assert!(sweep_pr_review_briefs(&runs, &HashSet::new(), 0).is_empty());
        assert!(
            outside.exists(),
            "a brief value must never escape .maestro/briefs"
        );
    }

    #[test]
    fn test_pr_brief_sweep_skips_missing_evidence() {
        // Missing evidence never deletes: a
        // brief that is not on disk, a checkout that is gone, and a non-`.md`
        // value are all skipped, never errors.
        let checkout = tempdir().unwrap();
        std::fs::create_dir_all(checkout.path().join(BRIEF_DIR)).unwrap();
        let not_markdown = staged_brief(checkout.path(), "pr-145-review.txt");
        // A DIRECTORY whose name ends in `.md` passes the extension gate and
        // reached `remove_file`, where only the OS refused it.
        let dir_named_md = checkout.path().join(BRIEF_DIR).join("pr-145-dir.md");
        std::fs::create_dir_all(&dir_named_md).unwrap();
        let runs = records(vec![
            pr_review(
                checkout.path(),
                7,
                Some(format!("{BRIEF_DIR}/never-written.md")),
            ),
            pr_review(
                checkout.path(),
                8,
                Some(format!("{BRIEF_DIR}/pr-145-review.txt")),
            ),
            pr_review(
                checkout.path(),
                9,
                Some(format!("{BRIEF_DIR}/pr-145-dir.md")),
            ),
        ]);
        assert!(sweep_pr_review_briefs(&runs, &HashSet::new(), 0).is_empty());
        assert!(not_markdown.exists());
        assert!(dir_named_md.is_dir());

        let gone = tempdir().unwrap();
        let vanished = gone.path().to_path_buf();
        drop(gone);
        let runs = records(vec![pr_review(
            &vanished,
            9,
            Some(format!("{BRIEF_DIR}/pr-145-review.md")),
        )]);
        assert!(sweep_pr_review_briefs(&runs, &HashSet::new(), 0).is_empty());
    }
}
