//! Samurai file inventory + guarded delete (issue #65; PRD §5.11, §8, §9).
//!
//! One listing of every Samurai-managed resource — briefs, handoff files, run
//! configs, PR-review records, pending timers, audit + journal slices — with
//! size, modified time, project/epic association and an `in_use` flag, plus
//! a delete that only ever touches paths inside the managed roots it
//! computed itself. The Second Brain Files panel (issue #66) is the consumer.
//!
//! **Grouped by WORK, not by kind (issue #139).** The listing is a set of
//! [`SamuraiFileGroup`]s — one per samurai run or PR review — and entries that
//! each carry the [`SamuraiFileEntry::group_id`] of the group they belong to.
//! `Handoff`/`RunConfig`/`Timer` are file kinds, not headings: they say what a
//! file IS, never what work it came from. There is deliberately no generic
//! group; see [`SamuraiGroupKind`] and [`list_files`] for what that costs and
//! why it is the point.
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
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::allowance_watcher::{ACCOUNT_PROJECT, ACCOUNT_RUN};
use super::samurai_audit::audit_file_name;
use super::samurai_brief::BRIEF_DIR;
use super::samurai_journal::JOURNAL_FILE;
use super::samurai_pr_runs::{self, PrReviewRun};
use super::samurai_prompts::epic_slug;
use super::samurai_run_config::{RefTitle, RunConfigStatus, SamuraiRunConfig};
use super::samurai_schedule::ScheduleEntry;
use super::status_server::StatusServer;
use super::supervisor::SessionSnapshot;

/// Fixed prefix of the "file is in use, pass `force`" refusal. The UI keys
/// its harder-confirm flow off this (PRD §5.11: "in-use files (active run)
/// get a harder confirm"). Mirrored as `SAMURAI_IN_USE_ERROR_PREFIX` in
/// `src/lib/samurai.ts` — keep the spellings identical.
pub const IN_USE_ERROR_PREFIX: &str = "IN_USE:";

/// What a listed file is (PRD §8 rows 1–5, plus the two kinds issue #139
/// adds). SCREAMING on the wire like every samurai sibling enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SamuraiFileKind {
    /// A brief FILE (issue #137/#138): `.maestro/briefs/*.md` in a run
    /// worktree, or a PR review's brief in its checkout.
    Brief,
    /// `.maestro/handoffs/*.md` in an epic worktree (PRD §8 row 1).
    Handoff,
    /// A per-epic run config JSON, ACTIVE or ARCHIVED (row 2).
    RunConfig,
    /// A PR-review run record (issue #139; `samurai_pr_runs`) — what gives a
    /// PR review an identity on disk.
    PrReviewRun,
    /// One pending resume timer inside `schedule.json` (row 3) — the `path`
    /// is the shared file, the row is the timer.
    Timer,
    /// One GROUP'S SLICE of the per-project audit JSONL (row 4 — user-deleted
    /// only by design). The `path` is the shared file; the row is the slice,
    /// counted on the group's `audit_rows`.
    AuditLog,
    /// One group's slice of the ops journal (row 5), same shape as
    /// [`Self::AuditLog`]: shared file, per-group row.
    Journal,
    /// Phase 5 harvest report (row 5). Kept for the readers that still serve
    /// these legacy files by path (`samurai_harvest_read`); the inventory no
    /// longer lists them, because a harvest report belongs to no run and no PR
    /// review and issue #139 admits no generic group to park it in. The
    /// Journal panel lists them instead, via `commands::harvest::
    /// samurai_harvest_list` (issue #142); `samurai_harvest_read` and
    /// `delete_file` still serve and remove them by path.
    HarvestReport,
}

impl SamuraiFileKind {
    /// Stable presentation order within a group — the order the epic's tree
    /// sketch renders (brief, handoff, config, record, timer, audit, journal).
    fn order(self) -> u8 {
        match self {
            Self::Brief => 0,
            Self::Handoff => 1,
            Self::RunConfig => 2,
            Self::PrReviewRun => 3,
            Self::Timer => 4,
            Self::AuditLog => 5,
            Self::Journal => 6,
            Self::HarvestReport => 7,
        }
    }
}

/// What a [`SamuraiFileGroup`] represents (issue #139). SCREAMING on the wire
/// like every samurai sibling enum.
///
/// These two variants are the WHOLE model on purpose: there is deliberately no
/// `System`, `Other` or `Unattributed` kind. An artifact that cannot be
/// attributed to a run or a PR review is a writer bug to fix, not a bucket to
/// add.
///
/// The account-wide scope is not an exception to that. It is a
/// [`Self::Run`] like any other — the `ACCOUNT_PROJECT`/`ACCOUNT_RUN`
/// pseudo-run `allowance_watcher` and `samurai_parker` have always written
/// their runless ALERTs under, labelled [`ACCOUNT_LABEL`] exactly as the audit
/// panel already labels them. Nothing lands there for want of a better home:
/// its rows name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SamuraiGroupKind {
    Run,
    PrReview,
}

/// One unit of WORK every artifact belongs to: a samurai run or a PR review
/// (issue #139). snake_case on the wire like every samurai sibling.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SamuraiFileGroup {
    /// `run:<project-hash>:<epic-slug>` or `pr:<owner/repo>#<number>`. Stable
    /// across calls, and distinct for same-named epics in different projects
    /// (the project hash is what separates them).
    pub id: String,
    pub kind: SamuraiGroupKind,
    /// `Epic #38 — Samurai supervision`, `Run #77, #78 — (2 issues)`,
    /// `PR #142 — fix journal splitting`. Degrades to the refs alone when no
    /// title was captured.
    pub label: String,
    /// The issue/epic/PR refs behind the group: `["#38"]`, `["#77", "#78"]`.
    pub refs: Vec<String>,
    pub project_path: Option<String>,
    /// RFC 3339 creation time — the run config's, or the newest launch record
    /// of a PR review. `None` for a group known only from a timer or a live
    /// session (no durable record carries a timestamp).
    pub created_at: Option<String>,
    /// A live supervised session (run) or an open review terminal (PR review).
    pub is_live: bool,
    /// The value an audit row's `epic` must resolve to ([`audit_key`]) for the
    /// row to belong here — the epic SLUG for a run (`38`, never `#38`), the
    /// `pr:` id for a PR review.
    ///
    /// On the wire because [`Self::audit_rows`] is counted on it and the audit
    /// view filters on it: the two spellings of one run made a card claim
    /// "37 rows" and then show none when the user clicked through.
    pub audit_key: String,
    /// This group's slice of the project audit JSONL — the rows whose `epic`
    /// is this group's run id.
    pub audit_rows: u32,
    /// This group's slice of the ops journal — entries matched on
    /// `project` + `agent`.
    pub journal_entries: u32,
}

/// One inventory row. snake_case on the wire like every samurai sibling.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SamuraiFileEntry {
    /// The [`SamuraiFileGroup::id`] this artifact belongs to (issue #139).
    /// Never empty and always resolvable: an entry is only ever emitted from
    /// the group it was found under.
    pub group_id: String,
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
    /// A live (non-terminal) supervised session exists for this entry's
    /// (project, epic) — the session slice of the [`Liveness`] pairs behind
    /// `in_use`, on its own. `false` for kinds without an epic association
    /// (audit logs, journal, harvest). The Second Brain gates its
    /// "clean this epic" affordance on this alone: `samurai_cleanup_epic`
    /// refuses only while a live session exists, so a completed epic whose
    /// config is still ACTIVE (and therefore `in_use`) must stay cleanable.
    pub has_live_session: bool,
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

/// The brief directory inside a run worktree or a PR review's checkout
/// (`samurai_brief::BRIEF_DIR`). Same `\\?\`-stripping contract as
/// [`handoff_dir`], and a managed delete root for the same reason: briefs are
/// Maestro-written artifacts the Second Brain lists.
pub fn brief_dir(dir: &str) -> PathBuf {
    PathBuf::from(strip_prefix_str(dir)).join(BRIEF_DIR)
}

/// PRD §8 row 1: a completed epic's `.maestro/` artifacts auto-clean
/// `retention_days` afterwards — "completes" meaning its run config reached
/// [`RunConfigStatus::Archived`] (an ACTIVE epic's history is kept while it
/// is live). Returns the removed paths for the caller's log.
///
/// Both write-once artifact dirs are swept: `.maestro/handoffs/` and
/// `.maestro/briefs/`. Briefs were left out when issue #137 introduced them,
/// so every staged ritual and every relaunch accumulated one more file in the
/// worktree with nothing to ever remove it. (A PR review's brief lands in the
/// user's own checkout, which belongs to no archivable run and so is not
/// swept here — that half needs its own policy, tracked in #145.)
///
/// The age signal is the file's mtime: a handoff or brief is written once and
/// never touched again, so its mtime IS that generation's end. Missing
/// evidence never deletes — an unreadable mtime, a non-`.md` entry or an
/// unreadable directory is skipped, matching the inventory's "no handoff dir
/// is the normal case" reading above.
pub fn sweep_handoff_retention(
    configs: &[(PathBuf, SamuraiRunConfig)],
    retention_days: u32,
) -> Vec<PathBuf> {
    let max_age = Duration::from_secs(u64::from(retention_days) * 24 * 60 * 60);
    let mut removed: Vec<PathBuf> = Vec::new();
    let mut seen_dirs: HashSet<PathBuf> = HashSet::new();
    for (_, config) in configs {
        if config.status != RunConfigStatus::Archived {
            continue;
        }
        for dir in [
            handoff_dir(&config.worktree_path),
            brief_dir(&config.worktree_path),
        ] {
            if !seen_dirs.insert(dir.clone()) {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&dir) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                let expired = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|m| m.elapsed().ok())
                    .is_some_and(|age| age >= max_age);
                if !expired {
                    continue;
                }
                match std::fs::remove_file(&path) {
                    Ok(()) => removed.push(path),
                    Err(e) => log::warn!(
                        "samurai retention: failed to delete expired artifact {}: {e}",
                        path.display()
                    ),
                }
            }
        }
    }
    removed
}

/// Every Samurai-managed artifact, GROUPED by the work it belongs to
/// (issue #139): one [`SamuraiFileGroup`] per samurai run or PR review, and
/// entries that each carry the id of the group they were found under. Inputs
/// are snapshots the command layer takes from the managed stores: ALL run
/// configs (active + archived) with their on-disk paths, the pending timers,
/// the supervised-session snapshots, the PR-review records, and the ids of the
/// terminal sessions currently open (a PR review is live while its terminal
/// is).
///
/// Two consequences of the "no generic groups" rule are visible here:
///
/// * The **shared files** — the project audit JSONL and the ops journal — are
///   never listed as themselves. Each surfaces once per group as that group's
///   SLICE, counted on [`SamuraiFileGroup::audit_rows`] /
///   [`SamuraiFileGroup::journal_entries`]. `schedule.json` was already only
///   ever listed as its timers.
/// * A **harvest report** belongs to no run and no PR review, so it is no
///   longer listed here — the Journal panel lists them instead, via
///   `commands::harvest::samurai_harvest_list` (issue #142).
///   `samurai_harvest_read` and [`delete_file`] still serve and remove the
///   legacy files by path.
///
/// Slicing must never make a file DISAPPEAR, though — before the grouping,
/// every audit JSONL and the journal were listed unconditionally, and a user
/// could open and delete them. So step 6 counts every audit file in the root
/// (not only the ones the run/PR pass named) and adopts any slice no group
/// claims onto the scope its own rows name: the account-wide pseudo-run for
/// `samurai-account.jsonl`, and the run itself for a project whose configs
/// were cleaned. See [`Groups::adopt_audit_slice`] — still no bucket, and no
/// silent drop-out either.
pub fn list_files(
    roots: &SamuraiFilesRoots,
    configs: &[(PathBuf, SamuraiRunConfig)],
    timers: &[ScheduleEntry],
    sessions: &[SessionSnapshot],
    pr_runs: &[(PathBuf, PrReviewRun)],
    open_session_ids: &[u32],
) -> (Vec<SamuraiFileGroup>, Vec<SamuraiFileEntry>) {
    let live = Liveness::compute(configs, timers, sessions);
    let mut groups = Groups::default();

    // 1. The groups themselves. Run configs first — they are the only source
    //    carrying a label's refs, titles and creation time; a timer or a live
    //    session for an epic with no config still gets its group, refs-only.
    for (_, config) in configs {
        groups.upsert_run(
            &config.project_path,
            &config.epic,
            Some(config),
            live.session_pair(&config.project_path, &config.epic),
        );
    }
    for timer in timers {
        groups.upsert_run(
            &timer.project_path,
            &timer.epic,
            None,
            live.session_pair(&timer.project_path, &timer.epic),
        );
    }
    for session in sessions.iter().filter(|s| !s.state.is_terminal()) {
        groups.upsert_run(&session.project, &session.epic, None, true);
    }
    let open: HashSet<u32> = open_session_ids.iter().copied().collect();
    for (_, run) in pr_runs {
        groups.upsert_pr(run, samurai_pr_runs::is_live(run, &open));
    }

    let mut entries: Vec<SamuraiFileEntry> = Vec::new();

    // 2. PR reviews: the record itself, plus the brief it was delivered as
    //    (issue #138) when one was written. Claimed FIRST so a review whose
    //    checkout doubles as a run worktree cannot have its brief swept up by
    //    the run's brief scan below.
    //
    //    One file, one row: relaunching the same PR with the same steps writes
    //    a second RECORD that reuses the same brief stem, so the two records
    //    name one file — which must still list once, or the card's
    //    "N files · X KB" counts it twice.
    let mut claimed_briefs: HashSet<String> = HashSet::new();
    let mut brief_rows: HashMap<String, usize> = HashMap::new();
    for (path, run) in pr_runs {
        let group_id = run.group_id();
        let live = samurai_pr_runs::is_live(run, &open);
        if let Some((size_bytes, modified_at)) = stat(path) {
            entries.push(SamuraiFileEntry {
                group_id: group_id.clone(),
                kind: SamuraiFileKind::PrReviewRun,
                path: stripped(path),
                size_bytes,
                modified_at,
                project_path: Some(run.project_path.clone()),
                epic: None,
                // A record of a review whose terminal is still open is in use:
                // deleting it orphans the group the terminal is writing under.
                in_use: live,
                // No supervised session — "clean this epic" does not apply.
                has_live_session: false,
                fire_at: None,
            });
        }
        let Some(brief) = samurai_pr_runs::brief_path(run) else {
            continue;
        };
        let key = path_key(&brief);
        claimed_briefs.insert(key.clone());
        if let Some(&index) = brief_rows.get(&key) {
            // Another record of the same review already listed this file. It
            // is in use if ANY of the terminals holding it still is.
            entries[index].in_use |= live;
            continue;
        }
        if let Some((size_bytes, modified_at)) = stat(&brief) {
            brief_rows.insert(key, entries.len());
            entries.push(SamuraiFileEntry {
                group_id,
                kind: SamuraiFileKind::Brief,
                path: stripped(&brief),
                size_bytes,
                modified_at,
                project_path: Some(run.project_path.clone()),
                epic: None,
                in_use: live,
                has_live_session: false,
                fire_at: None,
            });
        }
    }

    // 3. Handoffs and briefs: `.maestro/handoffs/*.md` and
    //    `.maestro/briefs/*.md` in each epic worktree a run config points at.
    //    Archived configs keep their files (PRD §8 row 2), so completed
    //    epics' history stays findable until cleanup.
    let mut seen_dirs: HashSet<PathBuf> = HashSet::new();
    for (_, config) in configs {
        let group_id = run_group_id(&config.project_path, &config.epic);
        for (dir, kind) in [
            (handoff_dir(&config.worktree_path), SamuraiFileKind::Handoff),
            (brief_dir(&config.worktree_path), SamuraiFileKind::Brief),
        ] {
            if !seen_dirs.insert(dir.clone()) {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&dir) else {
                // No such dir (worktree cleaned up, or nothing written yet) —
                // the normal case, not an error.
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                if claimed_briefs.contains(&path_key(&path)) {
                    continue;
                }
                let Some((size_bytes, modified_at)) = stat(&path) else {
                    continue;
                };
                entries.push(SamuraiFileEntry {
                    group_id: group_id.clone(),
                    kind,
                    path: stripped(&path),
                    size_bytes,
                    modified_at,
                    project_path: Some(config.project_path.clone()),
                    epic: Some(config.epic.clone()),
                    in_use: live.pair(&config.project_path, &config.epic),
                    has_live_session: live.session_pair(&config.project_path, &config.epic),
                    fire_at: None,
                });
            }
        }
    }

    // 4. Run configs, every status. An unarchived config — ACTIVE, or
    //    COMPLETED awaiting its cleanup (issue #96) — is in use by
    //    definition; an archived one only while a live session or pending
    //    timer still references its epic.
    for (path, config) in configs {
        let Some((size_bytes, modified_at)) = stat(path) else {
            continue;
        };
        entries.push(SamuraiFileEntry {
            group_id: run_group_id(&config.project_path, &config.epic),
            kind: SamuraiFileKind::RunConfig,
            path: stripped(path),
            size_bytes,
            modified_at,
            project_path: Some(config.project_path.clone()),
            epic: Some(config.epic.clone()),
            in_use: config.status != RunConfigStatus::Archived
                || live.pair(&config.project_path, &config.epic),
            has_live_session: live.session_pair(&config.project_path, &config.epic),
            fire_at: None,
        });
    }

    // 5. Pending timers: one row per timer, all sharing `schedule.json` as
    //    their path. Every listed timer is pending by definition → in use.
    let schedule_path = roots.samurai_dir.join("schedule.json");
    let schedule_stat = stat(&schedule_path);
    for timer in timers {
        let (size_bytes, modified_at) = schedule_stat.clone().unwrap_or((0, None));
        entries.push(SamuraiFileEntry {
            group_id: run_group_id(&timer.project_path, &timer.epic),
            kind: SamuraiFileKind::Timer,
            path: stripped(&schedule_path),
            size_bytes,
            modified_at,
            project_path: Some(timer.project_path.clone()),
            epic: Some(timer.epic.clone()),
            in_use: true,
            has_live_session: live.session_pair(&timer.project_path, &timer.epic),
            fire_at: Some(timer.fire_at.clone()),
        });
    }

    // 6. The two shared logs, sliced per group. Physically unchanged — one
    //    audit JSONL per project, one append-only journal — because the live
    //    watchers and the harvest depend on that shape; the split is virtual.
    //    A group with an empty slice gets no row at all: an "audit (0 rows)"
    //    line says nothing a missing line does not.
    let journal_path = roots.journal_dir.join(JOURNAL_FILE);
    let journal_owners = journal_owners(&journal_path);
    let journal_stat = stat(&journal_path);
    // The journal is APPEND TARGET for every live agent (the rider tells them
    // to `>>` their friction into it), so while any orchestrator is
    // supervised, deleting it destroys unconsumed entries — it must route
    // through the harder IN_USE confirm, not an ordinary one.
    let journal_in_use = !live.session_pairs.is_empty();

    // 6a. Count every audit JSONL in the root, not only the files the groups
    //     above happen to point at. A file no group names is exactly the case
    //     review B3 is about: the account-wide log, or a project whose run
    //     configs were cleaned. Both are still on disk, still growing, and
    //     were listed unconditionally before the panel was grouped.
    let mut audit_counts: HashMap<String, HashMap<String, u32>> = HashMap::new();
    let mut audit_projects: HashMap<String, String> = HashMap::new();
    for index in 0..groups.groups.len() {
        let file = groups.audit_files[index].clone();
        if let Some(project) = groups.groups[index].project_path.clone() {
            audit_projects.insert(file.clone(), project);
        }
        audit_counts
            .entry(file.clone())
            .or_insert_with(|| count_audit_rows(&roots.audit_dir.join(&file)));
    }
    if let Ok(files) = std::fs::read_dir(&roots.audit_dir) {
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            audit_counts
                .entry(name.to_string())
                .or_insert_with(|| count_audit_rows(&path));
        }
    }

    // 6b. Adopt every counted slice no group claims, and every journal entry
    //     no group claims, onto the real scope it names (see
    //     `Groups::adopt_audit_slice`). Sorted so the adoption order — and so
    //     the returned group order — does not ride on hash iteration.
    let mut unclaimed: Vec<(&String, &String)> = audit_counts
        .iter()
        .flat_map(|(file, counts)| counts.keys().map(move |key| (file, key)))
        .filter(|(file, key)| {
            !(0..groups.groups.len())
                .any(|i| &&groups.audit_files[i] == file && &&groups.groups[i].audit_key == key)
        })
        .collect();
    unclaimed.sort();
    for (file, key) in unclaimed {
        let (file, key) = (file.clone(), key.clone());
        groups.adopt_audit_slice(&file, &key, audit_projects.get(&file).map(String::as_str));
    }
    for owner in &journal_owners {
        match (owner.project.as_deref(), owner.agent.as_deref()) {
            (Some(project), Some(agent)) => {
                if !groups.claims_journal(project, agent) {
                    // The run the entry names, keyed on the LEADING segment of
                    // its agent id — the segment `agent_matches` reads as the
                    // run (the rest is the generation counter).
                    let slug = epic_slug(agent);
                    let key = slug.split('-').next().unwrap_or(&slug);
                    groups.upsert_run(project, key, None, false);
                }
            }
            // An entry naming no agent names no run: a user note, a harvest
            // marker. That is an account-level record, and the account-wide
            // scope is where the audit log already puts its own.
            _ => groups.upsert_run(ACCOUNT_PROJECT, ACCOUNT_RUN, None, false),
        }
    }

    // 6c. The slices themselves. A group with an empty slice gets no row at
    //     all: an "audit (0 rows)" line says nothing a missing line does not.
    for index in 0..groups.groups.len() {
        let file = groups.audit_files[index].clone();
        let key = groups.groups[index].audit_key.clone();
        let project = groups.groups[index].project_path.clone();

        let audit_path = roots.audit_dir.join(&file);
        let rows = audit_counts
            .get(&file)
            .and_then(|counts| counts.get(&key))
            .copied()
            .unwrap_or(0);
        groups.groups[index].audit_rows = rows;
        if rows > 0 {
            if let Some((size_bytes, modified_at)) = stat(&audit_path) {
                entries.push(SamuraiFileEntry {
                    group_id: groups.groups[index].id.clone(),
                    kind: SamuraiFileKind::AuditLog,
                    path: stripped(&audit_path),
                    size_bytes,
                    modified_at,
                    project_path: project.clone(),
                    epic: groups.epics[index].clone(),
                    in_use: project.as_deref().is_some_and(|p| live.project(p)),
                    has_live_session: project.as_deref().is_some_and(|p| {
                        groups.epics[index]
                            .as_deref()
                            .is_some_and(|epic| live.session_pair(p, epic))
                    }),
                    fire_at: None,
                });
            }
        }

        let journal_entries = journal_owners
            .iter()
            .filter(|owner| owner.belongs_to(project.as_deref(), &key))
            .count() as u32;
        groups.groups[index].journal_entries = journal_entries;
        if journal_entries > 0 {
            if let Some((size_bytes, modified_at)) = journal_stat.clone() {
                entries.push(SamuraiFileEntry {
                    group_id: groups.groups[index].id.clone(),
                    kind: SamuraiFileKind::Journal,
                    path: stripped(&journal_path),
                    size_bytes,
                    modified_at,
                    project_path: project,
                    epic: groups.epics[index].clone(),
                    in_use: journal_in_use,
                    has_live_session: false,
                    fire_at: None,
                });
            }
        }
    }

    // Entries arrive grouped, in the tree order the panel renders.
    entries.sort_by(|a, b| {
        (&a.group_id, a.kind.order(), &a.path, &a.epic, &a.fire_at).cmp(&(
            &b.group_id,
            b.kind.order(),
            &b.path,
            &b.epic,
            &b.fire_at,
        ))
    });
    // Live groups first, then newest launch first — the panel's card order.
    groups.groups.sort_by(|a, b| {
        (!a.is_live, &b.created_at, &a.id).cmp(&(!b.is_live, &a.created_at, &b.id))
    });
    (groups.groups, entries)
}

/// A samurai run's group id: `run:<project-hash>:<epic-slug>` (issue #139).
///
/// The project HASH, not the path: two projects with the same basename running
/// the same epic are different work, and the hash is the same one the audit
/// file and the run config directory already disambiguate with
/// (`StatusServer::generate_project_hash`). The epic goes through
/// [`epic_slug`] so `#38` and `38` — which every other samurai surface already
/// unifies — land on one group here too.
pub fn run_group_id(project: &str, epic: &str) -> String {
    format!(
        "run:{}:{}",
        StatusServer::generate_project_hash(project),
        epic_slug(epic)
    )
}

/// Header of the account-wide scope's card. The same words `AuditSection`
/// already puts on the cluster of rows this group slices — allowance
/// crossings and dropped scheduled launches, written under the
/// [`ACCOUNT_PROJECT`]/[`ACCOUNT_RUN`] pseudo-entities while nothing is
/// supervised. A real, named scope with real writers, NOT the generic bucket
/// issue #139 refuses: nothing lands here for want of a better home.
const ACCOUNT_LABEL: &str = "Account-wide";

/// The groups under construction, plus the two per-group facts the
/// [`SamuraiFileGroup`] wire shape does not carry: the audit FILE its slice is
/// counted in, and the epic identity string its entries quote.
#[derive(Default)]
struct Groups {
    groups: Vec<SamuraiFileGroup>,
    /// Per group: the name of the audit JSONL its slice lives in.
    audit_files: Vec<String>,
    /// Per group: the run's epic identity string, `None` for a PR review.
    epics: Vec<Option<String>>,
    index: HashMap<String, usize>,
}

impl Groups {
    /// Adds (or updates) the run group for `(project, epic)`. `config` is the
    /// run's durable record when one exists — the only source of refs, titles
    /// and a creation time. Liveness is OR'd in: a group known from several
    /// sources is live if ANY of them is.
    fn upsert_run(
        &mut self,
        project: &str,
        epic: &str,
        config: Option<&SamuraiRunConfig>,
        is_live: bool,
    ) {
        let id = run_group_id(project, epic);
        if let Some(&index) = self.index.get(&id) {
            self.groups[index].is_live |= is_live;
            return;
        }
        let account = project == ACCOUNT_PROJECT && epic == ACCOUNT_RUN;
        let refs: Vec<String> = match config {
            _ if account => Vec::new(),
            Some(config) if !config.epics.is_empty() || !config.issues.is_empty() => config
                .epics
                .iter()
                .chain(config.issues.iter())
                .map(|r| format!("#{r}"))
                .collect(),
            // A config written before the refs split (issue #83), or a group
            // known only from a timer/session: the epic string is the ref.
            _ => vec![ref_label(epic)],
        };
        let single_epic = config.is_none_or(|c| c.issues.is_empty());
        let titles: &[RefTitle] = config.map_or(&[], |c| c.ref_titles.as_slice());
        let label = if account {
            ACCOUNT_LABEL.to_string()
        } else {
            run_label(&refs, titles, single_epic)
        };
        self.push(
            SamuraiFileGroup {
                id,
                kind: SamuraiGroupKind::Run,
                label,
                refs,
                project_path: Some(project.to_string()),
                created_at: config.map(|c| c.created_at.clone()),
                is_live,
                audit_key: epic_slug(epic),
                audit_rows: 0,
                journal_entries: 0,
            },
            audit_file_name(project),
            Some(epic.to_string()),
        );
    }

    /// Adds (or updates) the group for a PR review. Several launches of the
    /// same PR share one group: the newest record's timestamp wins (that is
    /// the card's recency), its title fills a previously empty one, and the
    /// group is live while ANY of its terminals is open.
    fn upsert_pr(&mut self, run: &PrReviewRun, is_live: bool) {
        let id = run.group_id();
        if let Some(&index) = self.index.get(&id) {
            let group = &mut self.groups[index];
            group.is_live |= is_live;
            // A title fills an empty label whatever this record's recency:
            // `read_dir` hands records over in arbitrary order, so gating the
            // refresh on "newer" alone let an untitled record suppress a
            // titled one and the card degraded to `PR #142` for no reason.
            if !run.title.is_empty() && group.label == pr_label(run.pr, "") {
                group.label = pr_label(run.pr, &run.title);
            }
            if group
                .created_at
                .as_deref()
                .is_none_or(|c| c < run.created_at.as_str())
            {
                group.created_at = Some(run.created_at.clone());
                if !run.title.is_empty() {
                    group.label = pr_label(run.pr, &run.title);
                }
            }
            return;
        }
        self.push(
            SamuraiFileGroup {
                id: id.clone(),
                kind: SamuraiGroupKind::PrReview,
                label: pr_label(run.pr, &run.title),
                refs: vec![format!("#{}", run.pr)],
                project_path: Some(run.project_path.clone()),
                created_at: Some(run.created_at.clone()),
                is_live,
                audit_key: id,
                audit_rows: 0,
                journal_entries: 0,
            },
            audit_file_name(&run.project_path),
            None,
        );
    }

    /// Gives an audit slice no group claims the REAL scope it belongs to
    /// (issue #136 review B3). A slice reaching here means the group pass saw
    /// no config, timer, session or record for it — not that it belongs
    /// nowhere: the rows themselves name their scope, and this reconstructs it
    /// from them, so nothing a user could previously see and delete goes
    /// invisible. `project` is the checkout when some other group already
    /// knows this audit file's, `None` when the file is all that is left.
    ///
    /// Deliberately no fallback branch: a key that names nothing recognisable
    /// is left uncounted rather than parked in a generic bucket (#139).
    fn adopt_audit_slice(&mut self, file: &str, key: &str, project: Option<&str>) {
        // A PR review whose record was deleted: its rows carry the group id.
        if let Some(number) = key
            .strip_prefix("pr:")
            .and_then(|rest| rest.rsplit_once('#'))
            .and_then(|(_, n)| n.parse::<u32>().ok())
        {
            if self.index.contains_key(key) {
                return;
            }
            self.push(
                SamuraiFileGroup {
                    id: key.to_string(),
                    kind: SamuraiGroupKind::PrReview,
                    label: pr_label(number, ""),
                    refs: vec![format!("#{number}")],
                    project_path: project.map(str::to_string),
                    created_at: None,
                    is_live: false,
                    audit_key: key.to_string(),
                    audit_rows: 0,
                    journal_entries: 0,
                },
                file.to_string(),
                None,
            );
            return;
        }
        // The account-wide pseudo-run: allowance crossings and dropped
        // scheduled launches, written while nothing is supervised.
        if key == ACCOUNT_RUN && file == audit_file_name(ACCOUNT_PROJECT) {
            self.upsert_run(ACCOUNT_PROJECT, ACCOUNT_RUN, None, false);
            return;
        }
        // A run whose config was cleaned away. Its rows are what is left of
        // it, and they name it — with the same id the run had while its
        // config existed, because the audit file name embeds the same project
        // hash [`run_group_id`] keys on.
        let Some(hash) = audit_file_project_hash(file) else {
            return;
        };
        let id = format!("run:{hash}:{key}");
        if self.index.contains_key(&id) {
            return;
        }
        let refs = vec![ref_label(key)];
        self.push(
            SamuraiFileGroup {
                id,
                kind: SamuraiGroupKind::Run,
                label: run_label(&refs, &[], true),
                refs,
                project_path: project.map(str::to_string),
                created_at: None,
                is_live: false,
                audit_key: key.to_string(),
                audit_rows: 0,
                journal_entries: 0,
            },
            file.to_string(),
            None,
        );
    }

    /// Does any group already claim this journal entry? (See
    /// [`agent_matches`] — the entry belongs to the run its `agent` names,
    /// inside the project it names.)
    fn claims_journal(&self, project: &str, agent: &str) -> bool {
        self.groups.iter().any(|g| {
            g.project_path.as_deref() == Some(project) && agent_matches(agent, &g.audit_key)
        })
    }

    fn push(&mut self, group: SamuraiFileGroup, audit_file: String, epic: Option<String>) {
        self.index.insert(group.id.clone(), self.groups.len());
        self.audit_files.push(audit_file);
        self.epics.push(epic);
        self.groups.push(group);
    }
}

/// The project hash an audit file name embeds
/// (`<sanitized-basename>-<hash12>.jsonl`, `samurai_audit::audit_file_name`).
/// It is the SAME hash [`run_group_id`] keys on, which is what lets a run
/// whose config was cleaned rebuild its own group id out of its rows alone.
fn audit_file_project_hash(file: &str) -> Option<&str> {
    let (stem, hash) = file.strip_suffix(".jsonl")?.rsplit_once('-')?;
    (!stem.is_empty() && !hash.is_empty()).then_some(hash)
}

/// A bare ref spelled the way a label quotes it: `38` and `#38` both render
/// `#38`; anything that is not a plain number (a prose epic like `epic-hi`) is
/// quoted verbatim rather than given a misleading `#`.
fn ref_label(value: &str) -> String {
    let trimmed = value.trim();
    let bare = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if !bare.is_empty() && bare.chars().all(|c| c.is_ascii_digit()) {
        format!("#{bare}")
    } else {
        trimmed.to_string()
    }
}

/// The three label shapes of issue #139, in one function:
///
/// * one ref, a title captured → `Epic #38 — Samurai supervision`
/// * one ref, no title         → `Epic #38`
/// * several refs              → `Run #77, #78 — (2 issues)`
///
/// `single_epic` picks the noun for the one-ref case: `Epic` when the ref IS
/// the run's epic, `Run` when it is a standalone issue.
fn run_label(refs: &[String], titles: &[RefTitle], single_epic: bool) -> String {
    if refs.len() == 1 {
        let noun = if single_epic { "Epic" } else { "Run" };
        let bare = refs[0].strip_prefix('#').unwrap_or(&refs[0]);
        return match titles.iter().find(|t| t.r#ref == bare) {
            Some(found) if !found.title.is_empty() => {
                format!("{noun} {} — {}", refs[0], found.title)
            }
            _ => format!("{noun} {}", refs[0]),
        };
    }
    format!("Run {} — ({} issues)", refs.join(", "), refs.len())
}

/// `PR #142 — fix journal splitting`, degrading to `PR #142` when the launch
/// captured no title.
fn pr_label(number: u32, title: &str) -> String {
    if title.trim().is_empty() {
        format!("PR #{number}")
    } else {
        format!("PR #{number} — {title}")
    }
}

/// One audit row, reduced to the only field the slice count reads. Parsing the
/// whole [`super::samurai_audit::AuditEvent`] per line would deserialize a
/// `details` object the count never looks at.
#[derive(Deserialize)]
struct AuditRowEpic {
    #[serde(default)]
    epic: String,
}

/// Rows per run id in one project's audit JSONL. Streamed line by line: the
/// log is never auto-trimmed (PRD decision #15), so it must never be read into
/// memory whole just to be counted. A malformed line is skipped, like every
/// other audit reader.
fn count_audit_rows(path: &Path) -> HashMap<String, u32> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    let Ok(file) = std::fs::File::open(path) else {
        return counts;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<AuditRowEpic>(&line) else {
            continue;
        };
        if row.epic.is_empty() {
            continue;
        }
        *counts.entry(audit_key(&row.epic)).or_insert(0) += 1;
    }
    counts
}

/// The group key an audit row's `epic` resolves to. A PR review's id is
/// already the key (`pr:owner/repo#142`); anything else is a run identity
/// string, unified through [`epic_slug`] like every other samurai surface.
fn audit_key(epic: &str) -> String {
    if epic.starts_with("pr:") {
        epic.to_string()
    } else {
        epic_slug(epic)
    }
}

/// One journal line, reduced to the two fields grouping matches on.
#[derive(Deserialize)]
struct JournalOwner {
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    agent: Option<String>,
}

impl JournalOwner {
    /// Does this entry belong to the group scoped to (`project`, `key`)?
    ///
    /// An entry naming both a project and an agent belongs to the run its
    /// agent names, in that project. An entry naming no agent — a user note, a
    /// harvest marker — names no run at all, and is an account-level record:
    /// it belongs to the account-wide scope, the same place the audit log's
    /// own runless rows go. Keeping those countable is what stops the journal
    /// from vanishing out of the panel entirely (review B3).
    fn belongs_to(&self, project: Option<&str>, key: &str) -> bool {
        match (self.project.as_deref(), self.agent.as_deref()) {
            (Some(entry_project), Some(agent)) => {
                project == Some(entry_project) && agent_matches(agent, key)
            }
            _ => project == Some(ACCOUNT_PROJECT) && key == ACCOUNT_RUN,
        }
    }
}

/// The `(project, agent)` naming of every journal entry, both halves optional
/// — see [`JournalOwner::belongs_to`] for what each shape means.
fn journal_owners(path: &Path) -> Vec<JournalOwner> {
    let mut owners: Vec<JournalOwner> = Vec::new();
    let Ok(file) = std::fs::File::open(path) else {
        return owners;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(owner) = serde_json::from_str::<JournalOwner>(&line) {
            owners.push(owner);
        }
    }
    owners
}

/// Does a journal entry's `agent` name this group's work? The rider asks
/// agents for "your epic/generation id" (`samurai_prompts`), so the value is
/// free text like `#38 gen-2` — slugged, that is `38-gen-2`, whose LEADING
/// segment is the run id.
///
/// Leading only, deliberately. Matching any segment made the generation
/// counter readable as a run id: `#9 gen-1` slugs to `9-gen-1`, whose last
/// segment is `1`, so epic #1 counted every `gen-1` entry of every other run
/// — and #2, #3… the same. Whole-segment matching is still what stops epic
/// `3` from claiming epic `38`'s entries; anchoring it to the front is what
/// stops a counter from impersonating a run.
fn agent_matches(agent: &str, key: &str) -> bool {
    if key.starts_with("pr:") {
        return agent == key;
    }
    let slug = epic_slug(agent);
    slug == key || slug.starts_with(&format!("{key}-"))
}

/// Deletes one managed file, guarded twice (issue #65):
///
/// 1. **Roots:** the canonicalized, `\\?\`-stripped target must live inside
///    a managed root computed HERE from the stores — the five app-data dirs
///    plus each run config's `.maestro/handoffs/` and `.maestro/briefs/` dirs
///    and each PR review's `.maestro/briefs/` dir. Anything else is refused.
///    The caller's `path` never contributes a root.
/// 2. **In use:** a target matching an `in_use` inventory row is refused
///    without `force`, with an [`IN_USE_ERROR_PREFIX`]-prefixed error the UI
///    can distinguish for its harder confirm.
///
/// `schedule.json` is refused outright, `force` or not — it self-cleans and
/// its in-memory timers would re-persist it anyway; cancelling the timers is
/// the real operation (see the guard below).
///
/// Never silent: a missing/unresolvable target, a directory, or a failed
/// remove all return the error (PRD §5.11 — delete is explicit and visible).
pub fn delete_file(
    roots: &SamuraiFilesRoots,
    configs: &[(PathBuf, SamuraiRunConfig)],
    pr_runs: &[(PathBuf, PrReviewRun)],
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
    managed.extend(configs.iter().map(|(_, c)| brief_dir(&c.worktree_path)));
    managed.extend(pr_runs.iter().map(|(_, r)| brief_dir(&r.project_path)));

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

    // `schedule.json` is never raw-deleted, even with `force` (PRD §8 row 3:
    // it self-cleans — each cancelled/fired timer rewrites it and the last
    // one removes it). Deleting the file would neither stop the in-memory
    // timers (the next fire re-persists it, resurrecting the file) nor scope
    // to one epic. Cancelling the timers is the real operation.
    if canonical_stripped(&roots.samurai_dir.join("schedule.json")).is_some_and(|p| p == target) {
        return Err(format!(
            "refusing to delete {}: schedule.json self-cleans as its timers fire — cancel the \
             pending timers instead (each timer row's cancel action, or the epic cleanup)",
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
/// projects referenced by an unarchived (ACTIVE or COMPLETED) config, a
/// pending timer, or a live
/// (non-terminal) supervised session. Slug identity, not raw spelling —
/// `#38` and `38` are the same epic everywhere else (worktree, handoffs,
/// config lookups), so they must be here too.
struct Liveness {
    pairs: HashSet<(String, String)>,
    /// The session slice of `pairs` alone — (project, epic-slug) pairs with a
    /// live (non-terminal) supervised session, behind `has_live_session`.
    session_pairs: HashSet<(String, String)>,
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
            session_pairs: HashSet::new(),
            projects: HashSet::new(),
        };
        for (_, config) in configs {
            // COMPLETED counts like ACTIVE (issue #96): the run is finished
            // but its config still drives the runs list and the cleanup —
            // its files stay force-guarded until that cleanup archives it.
            if config.status != RunConfigStatus::Archived {
                live.insert(&config.project_path, &config.epic);
            }
        }
        for timer in timers {
            live.insert(&timer.project_path, &timer.epic);
        }
        for session in sessions {
            if !session.state.is_terminal() {
                live.insert(&session.project, &session.epic);
                live.session_pairs
                    .insert((session.project.clone(), epic_slug(&session.epic)));
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

    fn session_pair(&self, project: &str, epic: &str) -> bool {
        self.session_pairs
            .contains(&(project.to_string(), epic_slug(epic)))
    }

    fn project(&self, project: &str) -> bool {
        self.projects.contains(project)
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
///
/// `pub(crate)`: the Second Brain's guarded read
/// (`commands/samurai.rs::samurai_file_read`, issue #82) must canonicalize
/// both sides of its containment check exactly the way the delete above
/// does — one canonicalization shared, never a second copy that can drift.
pub(crate) fn canonical_stripped(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    Some(PathBuf::from(strip_extended_length(
        &canonical.to_string_lossy(),
    )))
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

/// Lossless `\\?\`-strip of a path for display/wire use (no canonicalize —
/// listing must not require every path to exist).
fn stripped(path: &Path) -> String {
    strip_prefix_str(&path.to_string_lossy()).to_string()
}

fn strip_prefix_str(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path)
}

/// De-duplication identity of a path that must never be stat'ed to be
/// compared — the PR-brief claim, which decides whether the run brief scan
/// listed the same file a second time under a second group.
///
/// `PathBuf` equality is exact, so `C:\Git\Maestro\…` and `C:\git\maestro\…`
/// — one spelling from the PR record, the other from the run config — read as
/// two files on Windows, and the same brief listed twice in two groups. The
/// key strips the verbatim prefix, unifies the separators and lowercases, the
/// same shape `audit_file_name` already keys projects on. Two genuinely
/// case-distinct briefs in one directory would collide on a case-sensitive
/// filesystem; briefs are Maestro-written from a slugged, already-lowercased
/// stem (`samurai_brief::write_brief`), so that pair cannot occur.
fn path_key(path: &Path) -> String {
    strip_prefix_str(&path.to_string_lossy())
        .replace('\\', "/")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::allowance_watcher::{ACCOUNT_PROJECT, ACCOUNT_RUN};
    use crate::core::samurai_pr_runs::PrReviewLaunch;
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

    /// A fake epic worktree with `.maestro/handoffs/` + `.maestro/briefs/` and
    /// the given files in each.
    fn worktree_with(base: &Path, name: &str, handoffs: &[&str], briefs: &[&str]) -> PathBuf {
        let wt = base.join(name);
        for (dir, files) in [
            (wt.join(".maestro").join("handoffs"), handoffs),
            (wt.join(BRIEF_DIR), briefs),
        ] {
            std::fs::create_dir_all(&dir).unwrap();
            for file in files {
                std::fs::write(dir.join(file), format!("# {file}\n")).unwrap();
            }
        }
        wt
    }

    fn timer(project: &str, epic: &str, fire_at: &str) -> ScheduleEntry {
        ScheduleEntry {
            project_path: project.to_string(),
            epic: epic.to_string(),
            fire_at: fire_at.to_string(),
            reason: "park".to_string(),
            launch: None,
            held: false,
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

    /// One audit JSONL line with the given run id in `epic`.
    fn audit_line(epic: &str) -> String {
        format!(
            "{{\"ts\":\"2026-08-17T12:00:00+00:00\",\"epic\":\"{epic}\",\"event\":\"SPAWN\",\
             \"generation\":1,\"session_id\":1,\"details\":{{}}}}\n"
        )
    }

    /// One journal JSONL line; an empty `agent` means a user entry, which
    /// names no run.
    fn journal_line(project: &str, agent: &str) -> String {
        let agent = if agent.is_empty() {
            String::new()
        } else {
            format!(",\"agent\":\"{agent}\"")
        };
        format!(
            "{{\"ts\":\"2026-08-17T12:00:00+00:00\",\"category\":\"BOTTLENECK\",\"text\":\"t\",\
             \"project\":\"{}\"{agent}}}\n",
            project.replace('\\', "\\\\")
        )
    }

    /// The full fixture: one ACTIVE single-epic run (`#9`, two handoffs, one
    /// brief, a pending timer, a captured title), one ARCHIVED pre-refs run
    /// (`#7`), one multi-issue run (`#77`/`#78`), and one PR review of #142
    /// with its record and brief — plus an audit log and a journal holding
    /// slices of several of them.
    struct Fixture {
        base: TempDir,
        roots: SamuraiFilesRoots,
        store: RunConfigStore,
        project: String,
        timers: Vec<ScheduleEntry>,
        pr_runs: Vec<(PathBuf, PrReviewRun)>,
        pr_brief: PathBuf,
    }

    const PR_GROUP: &str = "pr:nachogl1/maestro#142";
    /// A checkout whose run configs are gone but whose audit rows remain.
    const CLEANED_PROJECT: &str = "C:/git/cleaned";

    fn fixture() -> Fixture {
        let base = tempdir().unwrap();
        let roots = roots_in(base.path());
        let store = RunConfigStore::new(roots.runs_dir.clone());
        let project_dir = base.path().join("alpha");
        std::fs::create_dir_all(&project_dir).unwrap();
        let project = project_dir.to_string_lossy().into_owned();

        let wt9 = worktree_with(
            base.path(),
            "wt-9",
            &["9-gen1.md", "9-gen2.md"],
            &["gen-1-launch.md"],
        );
        // Non-md files in either dir must be ignored by the listing.
        std::fs::write(wt9.join(".maestro/handoffs/notes.txt"), "not a handoff").unwrap();
        let mut config9 =
            SamuraiRunConfig::new(project.clone(), "#9", wt9.to_string_lossy().into_owned());
        config9.epics = vec!["9".to_string()];
        config9.ref_titles = vec![RefTitle {
            r#ref: "9".to_string(),
            title: "Samurai supervision".to_string(),
        }];
        store.save(&config9).unwrap();

        // Pre-#83 shape: no refs lists at all, and no captured title.
        let wt7 = worktree_with(base.path(), "wt-7", &["7-gen1.md"], &[]);
        store
            .save(&SamuraiRunConfig::new(
                project.clone(),
                "#7",
                wt7.to_string_lossy().into_owned(),
            ))
            .unwrap();
        store.archive(&project, "#7").unwrap();

        // A single-digit epic that shares no rows with #9 — the fixture that
        // catches a `gen-N` suffix being read as a run id (`9-gen-1` ends in
        // `-1`), which every epic #1…#9 was silently claiming.
        let wt1 = worktree_with(base.path(), "wt-1", &[], &[]);
        let mut config1 =
            SamuraiRunConfig::new(project.clone(), "#1", wt1.to_string_lossy().into_owned());
        config1.epics = vec!["1".to_string()];
        store.save(&config1).unwrap();

        let wt77 = worktree_with(base.path(), "wt-77", &[], &[]);
        let mut config77 = SamuraiRunConfig::new(
            project.clone(),
            "issues #77, #78",
            wt77.to_string_lossy().into_owned(),
        );
        config77.issues = vec!["77".to_string(), "78".to_string()];
        store.save(&config77).unwrap();

        let timers = vec![timer(&project, "#9", "2030-01-01T14:32:00+00:00")];
        write_schedule(&roots, &timers);

        // The PR review: its record, and the brief it was delivered as.
        let pr_relpath = format!("{BRIEF_DIR}/pr-142-check-review.md");
        let pr_brief = project_dir.join(&pr_relpath);
        std::fs::create_dir_all(pr_brief.parent().unwrap()).unwrap();
        std::fs::write(&pr_brief, "# PR brief\n").unwrap();
        let pr_run = PrReviewRun::now(
            PrReviewLaunch {
                pr: 142,
                title: "fix journal splitting".to_string(),
                repo: "nachogl1/maestro".to_string(),
                project_path: project.clone(),
                steps: vec!["check".to_string(), "review".to_string()],
            },
            7,
            Some(pr_relpath),
        );
        let pr_record_path = roots.runs_dir.join("pr").join("record.json");
        std::fs::create_dir_all(pr_record_path.parent().unwrap()).unwrap();
        std::fs::write(
            &pr_record_path,
            serde_json::to_string_pretty(&pr_run).unwrap(),
        )
        .unwrap();

        // The audit log: three #9 rows, one #7 row (slug spelling), two PR
        // rows, and one row nothing can attribute.
        std::fs::create_dir_all(&roots.audit_dir).unwrap();
        let mut audit = String::new();
        for _ in 0..3 {
            audit.push_str(&audit_line("#9"));
        }
        audit.push_str(&audit_line("7"));
        audit.push_str(&audit_line(PR_GROUP));
        audit.push_str(&audit_line(PR_GROUP));
        audit.push_str(&audit_line(""));
        std::fs::write(roots.audit_dir.join(audit_file_name(&project)), audit).unwrap();
        // Another project's audit file, holding nothing attributable.
        std::fs::write(roots.audit_dir.join("orphan-000000000000.jsonl"), "{}\n").unwrap();
        // The account-wide log: allowance crossings and dropped scheduled
        // launches, written under the `samurai-account` pseudo-project while
        // nothing is supervised. No run config will ever point at it.
        std::fs::write(
            roots.audit_dir.join(audit_file_name(ACCOUNT_PROJECT)),
            format!("{}{}", audit_line(ACCOUNT_RUN), audit_line(ACCOUNT_RUN)),
        )
        .unwrap();
        // A project whose run configs were cleaned away: its rows still name
        // the run they came from, and the file is still on disk.
        std::fs::write(
            roots.audit_dir.join(audit_file_name(CLEANED_PROJECT)),
            format!("{}{}", audit_line("#5"), audit_line("5")),
        )
        .unwrap();

        // The journal: two entries by epic #9's agents, one by the user (no
        // agent → belongs to no run), one by an agent of another project.
        std::fs::create_dir_all(&roots.journal_dir).unwrap();
        let journal = format!(
            "{}{}{}{}",
            journal_line(&project, "#9 gen-1"),
            journal_line(&project, "#9 gen-2"),
            journal_line(&project, ""),
            journal_line("C:/git/elsewhere", "#9 gen-1"),
        );
        std::fs::write(roots.journal_dir.join(JOURNAL_FILE), journal).unwrap();

        // A legacy harvest report: no run, no PR review, so no group — and
        // therefore no listing (see `list_files`).
        std::fs::create_dir_all(&roots.harvest_dir).unwrap();
        std::fs::write(roots.harvest_dir.join("harvest-2026-08-07.md"), "# report").unwrap();

        Fixture {
            base,
            roots,
            store,
            project,
            timers,
            pr_runs: vec![(pr_record_path, pr_run)],
            pr_brief,
        }
    }

    fn list(
        f: &Fixture,
        sessions: &[SessionSnapshot],
        open: &[u32],
    ) -> (Vec<SamuraiFileGroup>, Vec<SamuraiFileEntry>) {
        list_files(
            &f.roots,
            &f.store.list_with_paths(),
            &f.timers,
            sessions,
            &f.pr_runs,
            open,
        )
    }

    fn of_kind(entries: &[SamuraiFileEntry], kind: SamuraiFileKind) -> Vec<&SamuraiFileEntry> {
        entries.iter().filter(|e| e.kind == kind).collect()
    }

    fn group<'a>(groups: &'a [SamuraiFileGroup], id: &str) -> &'a SamuraiFileGroup {
        groups
            .iter()
            .find(|g| g.id == id)
            .unwrap_or_else(|| panic!("no group {id} in {:?}", ids(groups)))
    }

    fn ids(groups: &[SamuraiFileGroup]) -> Vec<String> {
        let mut ids: Vec<String> = groups.iter().map(|g| g.id.clone()).collect();
        ids.sort();
        ids
    }

    fn sorted(mut values: Vec<String>) -> Vec<String> {
        values.sort();
        values
    }

    /// Criterion 1 + 9: every entry resolves to a returned group, and the
    /// group set is EXACTLY the runs and PR reviews present — no "System",
    /// no "Other", no unattributed bucket to hide a writer bug in.
    #[test]
    fn test_every_entry_resolves_to_a_group_and_no_group_is_generic() {
        let f = fixture();
        let (groups, entries) = list(&f, &[], &[]);

        let known: HashSet<&str> = groups.iter().map(|g| g.id.as_str()).collect();
        assert!(!entries.is_empty());
        for entry in &entries {
            assert!(!entry.group_id.is_empty(), "ungrouped entry: {entry:?}");
            assert!(
                known.contains(entry.group_id.as_str()),
                "entry {entry:?} points at no returned group"
            );
        }

        assert_eq!(
            ids(&groups),
            sorted(vec![
                run_group_id(&f.project, "#9"),
                run_group_id(&f.project, "#7"),
                run_group_id(&f.project, "#1"),
                run_group_id(&f.project, "issues #77, #78"),
                PR_GROUP.to_string(),
                // The scopes the shared logs are sliced under when no config
                // or record names them (review B3).
                run_group_id(ACCOUNT_PROJECT, ACCOUNT_RUN),
                run_group_id(CLEANED_PROJECT, "#5"),
                run_group_id("C:/git/elsewhere", "#9"),
            ])
        );
        for g in &groups {
            assert!(
                matches!(g.kind, SamuraiGroupKind::Run | SamuraiGroupKind::PrReview),
                "{g:?}"
            );
            for banned in ["System", "Other", "Unattributed", "Unknown"] {
                assert!(!g.label.contains(banned), "generic label: {}", g.label);
            }
        }

        // The shared files are never listed as themselves: the orphan audit
        // file (no group's project) and the legacy harvest report are gone,
        // and `schedule.json` only ever appears as its timer rows.
        assert!(entries
            .iter()
            .all(|e| !e.path.contains("orphan-000000000000")));
        assert!(of_kind(&entries, SamuraiFileKind::HarvestReport).is_empty());
        assert!(entries
            .iter()
            .filter(|e| e.path.ends_with("schedule.json"))
            .all(|e| e.kind == SamuraiFileKind::Timer));
    }

    /// Criterion 2: ids are stable call to call, and the same epic name in a
    /// different project is a different group.
    #[test]
    fn test_group_ids_are_stable_and_project_scoped() {
        let f = fixture();
        assert_eq!(ids(&list(&f, &[], &[]).0), ids(&list(&f, &[], &[]).0));

        assert_ne!(
            run_group_id("C:/git/alpha", "#9"),
            run_group_id("C:/other/alpha", "#9"),
            "same epic, different checkout — different work"
        );
        // `#9` and `9` are one epic everywhere else in samurai, so one group.
        assert_eq!(
            run_group_id("C:/git/alpha", "#9"),
            run_group_id("C:/git/alpha", "9")
        );
        assert!(run_group_id("C:/git/alpha", "#9").starts_with("run:"));
    }

    /// Criterion 3: the three label shapes, and the refs-only degradation
    /// when no title was captured (a failed `gh` lookup must never block or
    /// blank a run).
    #[test]
    fn test_labels_render_all_three_shapes_and_degrade_to_refs() {
        let f = fixture();
        let (groups, _) = list(&f, &[], &[]);

        let epic9 = group(&groups, &run_group_id(&f.project, "#9"));
        assert_eq!(epic9.label, "Epic #9 — Samurai supervision");
        assert_eq!(epic9.refs, vec!["#9".to_string()]);

        let multi = group(&groups, &run_group_id(&f.project, "issues #77, #78"));
        assert_eq!(multi.label, "Run #77, #78 — (2 issues)");
        assert_eq!(multi.refs, vec!["#77".to_string(), "#78".to_string()]);

        let pr = group(&groups, PR_GROUP);
        assert_eq!(pr.label, "PR #142 — fix journal splitting");
        assert_eq!(pr.refs, vec!["#142".to_string()]);

        // No title captured → the ref alone, never an empty or invented one.
        let legacy = group(&groups, &run_group_id(&f.project, "#7"));
        assert_eq!(legacy.label, "Epic #7");
        assert_eq!(legacy.refs, vec!["#7".to_string()]);
        assert_eq!(pr_label(142, ""), "PR #142");
        assert_eq!(pr_label(142, "   "), "PR #142");
    }

    /// Criterion 4: a run's handoffs, briefs, run config and timer all land
    /// in that run's group — the question "what did the #9 run leave behind?"
    /// answered by one group id.
    #[test]
    fn test_a_runs_artifacts_all_land_in_its_group() {
        let f = fixture();
        let (_, entries) = list(&f, &[], &[]);
        let id = run_group_id(&f.project, "#9");

        let mine: Vec<&SamuraiFileEntry> = entries.iter().filter(|e| e.group_id == id).collect();
        let kinds: HashSet<SamuraiFileKind> = mine.iter().map(|e| e.kind).collect();
        assert!(kinds.contains(&SamuraiFileKind::Handoff));
        assert!(kinds.contains(&SamuraiFileKind::Brief));
        assert!(kinds.contains(&SamuraiFileKind::RunConfig));
        assert!(kinds.contains(&SamuraiFileKind::Timer));
        assert_eq!(
            mine.iter()
                .filter(|e| e.kind == SamuraiFileKind::Handoff)
                .count(),
            2,
            "notes.txt is not a handoff"
        );
        let brief = mine
            .iter()
            .find(|e| e.kind == SamuraiFileKind::Brief)
            .unwrap();
        assert!(brief.path.ends_with("gen-1-launch.md"), "{}", brief.path);
        let timer = mine
            .iter()
            .find(|e| e.kind == SamuraiFileKind::Timer)
            .unwrap();
        assert_eq!(timer.fire_at.as_deref(), Some("2030-01-01T14:32:00+00:00"));

        // …and nothing of the OTHER runs leaked into it.
        assert!(mine.iter().all(|e| !e.path.contains("wt-7")));
    }

    /// Criterion 5: `audit_rows` and `journal_entries` count only the group's
    /// own slice of the shared files, and the shared files themselves are
    /// listed once per group rather than as themselves.
    #[test]
    fn test_audit_and_journal_counts_are_per_group_slices() {
        let f = fixture();
        let (groups, entries) = list(&f, &[], &[]);

        let epic9 = group(&groups, &run_group_id(&f.project, "#9"));
        assert_eq!(epic9.audit_rows, 3);
        assert_eq!(epic9.journal_entries, 2, "only this run's agents' entries");

        // Epic #1 wrote nothing: `#9 gen-1`'s trailing generation counter is
        // not a run id, so #1 claims none of #9's entries.
        let epic1 = group(&groups, &run_group_id(&f.project, "#1"));
        assert_eq!((epic1.audit_rows, epic1.journal_entries), (0, 0));

        // Slug identity: the `7` rows belong to the `#7` run.
        assert_eq!(
            group(&groups, &run_group_id(&f.project, "#7")).audit_rows,
            1
        );
        assert_eq!(group(&groups, PR_GROUP).audit_rows, 2);
        // A run with no rows of its own counts none — and gets no row.
        let quiet = group(&groups, &run_group_id(&f.project, "issues #77, #78"));
        assert_eq!((quiet.audit_rows, quiet.journal_entries), (0, 0));
        assert!(entries
            .iter()
            .filter(|e| e.group_id == quiet.id)
            .all(|e| e.kind != SamuraiFileKind::AuditLog && e.kind != SamuraiFileKind::Journal));

        // The row written with an EMPTY run id is counted nowhere: it names
        // no scope at all, and #139 admits no bucket to hide it in. (The
        // sweep in `samurai_audit` is what keeps writers from making more.)
        let this_project: u32 = groups
            .iter()
            .filter(|g| g.project_path.as_deref() == Some(f.project.as_str()))
            .map(|g| g.audit_rows)
            .sum();
        assert_eq!(this_project, 6);

        // The physical files are unchanged and shared: one audit row entry
        // per counting group, all pointing at their project's one JSONL.
        let audits: Vec<&SamuraiFileEntry> = of_kind(&entries, SamuraiFileKind::AuditLog)
            .into_iter()
            .filter(|e| e.project_path.as_deref() == Some(f.project.as_str()))
            .collect();
        assert_eq!(audits.len(), 3);
        assert!(audits.iter().all(|e| e.path.ends_with(".jsonl")));
        assert_eq!(
            audits.iter().map(|e| &e.path).collect::<HashSet<_>>().len(),
            1
        );
        let journals = of_kind(&entries, SamuraiFileKind::Journal);
        assert!(journals.iter().all(|e| e.path.ends_with(JOURNAL_FILE)));
        assert_eq!(
            journals
                .iter()
                .filter(|e| e.project_path.as_deref() == Some(f.project.as_str()))
                .count(),
            1
        );
    }

    /// Review B3: a managed file the user could see and delete before the
    /// panel was grouped must not silently become invisible now that the
    /// shared logs surface only as per-group SLICES.
    ///
    /// Every slice gets a REAL scope, never a generic bucket (#139 forbids
    /// one): the account-wide log lands on the `ACCOUNT_PROJECT`/`ACCOUNT_RUN`
    /// pseudo-run that already writes it, and a cleaned project's rows land on
    /// the run those rows themselves name.
    #[test]
    fn test_unclaimed_audit_slices_land_on_a_real_scope_not_a_bucket() {
        let f = fixture();
        let (groups, entries) = list(&f, &[], &[]);

        // The account-wide log — allowance ALERTs and dropped launches, still
        // actively written, and previously listed unconditionally.
        let account = group(&groups, &run_group_id(ACCOUNT_PROJECT, ACCOUNT_RUN));
        assert_eq!(account.label, "Account-wide");
        assert_eq!(account.audit_rows, 2);
        assert!(!account.is_live);
        let account_file = audit_file_name(ACCOUNT_PROJECT);
        assert!(
            entries.iter().any(|e| e.group_id == account.id
                && e.kind == SamuraiFileKind::AuditLog
                && e.path.ends_with(&account_file)),
            "the account-wide audit file must still be listed and deletable"
        );

        // A project whose run configs were cleaned: the rows name the run, so
        // the run is the group — reconstructed with the SAME id it would have
        // had while its config existed.
        let cleaned = group(&groups, &run_group_id(CLEANED_PROJECT, "#5"));
        assert_eq!(cleaned.label, "Epic #5");
        assert_eq!(cleaned.audit_rows, 2, "`#5` and `5` are one run");
        assert!(entries.iter().any(|e| e.group_id == cleaned.id
            && e.kind == SamuraiFileKind::AuditLog
            && e.path.ends_with(&audit_file_name(CLEANED_PROJECT))));

        // Still no generic group anywhere.
        for g in &groups {
            assert!(matches!(
                g.kind,
                SamuraiGroupKind::Run | SamuraiGroupKind::PrReview
            ));
            for banned in ["System", "Other", "Unattributed", "Unknown"] {
                assert!(!g.label.contains(banned), "generic label: {}", g.label);
            }
        }
    }

    /// Review B3, the journal half: an entry naming a run Maestro no longer
    /// has a config for lands on that run; an entry naming NO run at all is
    /// account-level, and lands on the account-wide scope. Either way the
    /// journal file stays listed.
    #[test]
    fn test_unclaimed_journal_entries_keep_the_journal_listed() {
        let f = fixture();
        let (groups, entries) = list(&f, &[], &[]);

        // The user entry (no agent → names no run) is account-level.
        let account = group(&groups, &run_group_id(ACCOUNT_PROJECT, ACCOUNT_RUN));
        assert_eq!(account.journal_entries, 1);

        // The other project's agent entry lands on ITS run, not on #9's.
        let elsewhere = group(&groups, &run_group_id("C:/git/elsewhere", "#9"));
        assert_eq!(elsewhere.journal_entries, 1);
        assert_eq!(elsewhere.project_path.as_deref(), Some("C:/git/elsewhere"));

        // Every journal entry is now accounted for, and the file is listed.
        assert_eq!(groups.iter().map(|g| g.journal_entries).sum::<u32>(), 4);
        let journals = of_kind(&entries, SamuraiFileKind::Journal);
        assert_eq!(journals.len(), 3, "one row per counting group");
        assert!(journals.iter().all(|e| e.path.ends_with(JOURNAL_FILE)));
    }

    /// Review B4: the group publishes the exact key its `audit_rows` were
    /// counted on, so the audit view can filter on the same spelling. Filtering
    /// on the raw `epic` showed zero rows for a card claiming N.
    #[test]
    fn test_groups_publish_the_key_their_audit_slice_was_counted_on() {
        let f = fixture();
        let (groups, _) = list(&f, &[], &[]);

        // A run's key is the epic SLUG — the audit log carries `#9` and `7`
        // for the same runs the configs spell `#9` and `#7`.
        assert_eq!(
            group(&groups, &run_group_id(&f.project, "#9")).audit_key,
            "9"
        );
        assert_eq!(
            group(&groups, &run_group_id(&f.project, "#7")).audit_key,
            "7"
        );
        // A PR review's key is its group id, which is what its rows carry.
        assert_eq!(group(&groups, PR_GROUP).audit_key, PR_GROUP);
        assert_eq!(
            group(&groups, &run_group_id(ACCOUNT_PROJECT, ACCOUNT_RUN)).audit_key,
            ACCOUNT_RUN
        );

        // The contract: a group claiming rows publishes a key those rows
        // actually resolve to.
        for g in groups.iter().filter(|g| g.audit_rows > 0) {
            assert!(!g.audit_key.is_empty(), "{g:?}");
            assert_eq!(g.audit_key, audit_key(&g.audit_key), "{g:?}");
        }
    }

    /// Criterion 6: a PR review launch leaves a record, and the record and
    /// its brief share one `pr:` group — the identity a review used to lack.
    #[test]
    fn test_a_pr_record_and_its_brief_share_one_pr_group() {
        let f = fixture();
        let (groups, entries) = list(&f, &[], &[]);

        let pr = group(&groups, PR_GROUP);
        assert_eq!(pr.kind, SamuraiGroupKind::PrReview);
        assert_eq!(pr.project_path.as_deref(), Some(f.project.as_str()));
        assert!(pr.created_at.is_some());
        assert!(!pr.is_live, "no open terminal for it");

        let mine: Vec<&SamuraiFileEntry> =
            entries.iter().filter(|e| e.group_id == PR_GROUP).collect();
        assert_eq!(
            mine.iter()
                .filter(|e| e.kind == SamuraiFileKind::PrReviewRun)
                .count(),
            1
        );
        let brief = mine
            .iter()
            .find(|e| e.kind == SamuraiFileKind::Brief)
            .expect("the review's brief groups with its record");
        assert_eq!(brief.path, stripped(&f.pr_brief));
        // Its own artifacts are free while the terminal is closed. (The
        // group's audit SLICE follows the shared file's project-level rule —
        // the checkout has other live runs in it.)
        assert!(
            mine.iter()
                .filter(|e| e.kind != SamuraiFileKind::AuditLog)
                .all(|e| !e.in_use),
            "terminal closed"
        );

        // The review's terminal still open → the group is live and its
        // artifacts are in use.
        let (groups, entries) = list(&f, &[], &[7]);
        assert!(group(&groups, PR_GROUP).is_live);
        assert!(entries
            .iter()
            .filter(|e| e.group_id == PR_GROUP)
            .all(|e| e.in_use && !e.has_live_session));
        assert!(entries
            .iter()
            .any(|e| e.group_id == PR_GROUP && e.kind == SamuraiFileKind::PrReviewRun));
    }

    /// A record from an EARLIER app launch must never report itself live.
    /// Maestro's PTY session ids restart at 1 every launch while records
    /// persist forever, so an old record with `session_id: 3` matched an
    /// unrelated terminal 3 — and the dead review's record and brief came
    /// back `in_use`, deletable only with `force`.
    #[test]
    fn test_a_pr_record_from_an_earlier_app_launch_is_never_live() {
        let mut f = fixture();
        let session = f.pr_runs[0].1.session_id;

        // This launch's record, its terminal open: live, as before.
        let (groups, entries) = list(&f, &[], &[session]);
        assert!(group(&groups, PR_GROUP).is_live);
        assert!(entries
            .iter()
            .any(|e| e.group_id == PR_GROUP && e.kind == SamuraiFileKind::PrReviewRun && e.in_use));

        // The same record, written by a previous launch: terminal 7 belongs
        // to somebody else now.
        f.pr_runs[0].1.launch_id = "20200101000000-1".to_string();
        let (groups, entries) = list(&f, &[], &[session]);
        assert!(!group(&groups, PR_GROUP).is_live);
        assert!(entries
            .iter()
            .filter(|e| e.group_id == PR_GROUP && e.kind != SamuraiFileKind::AuditLog)
            .all(|e| !e.in_use));
    }

    /// One brief file, one row — even when two records name it. Relaunching
    /// the same PR with the same steps writes a second record that reuses the
    /// brief stem, and two rows for one file double-count the card's header.
    #[test]
    fn test_one_brief_lists_once_across_relaunches_of_the_same_pr() {
        let mut f = fixture();
        let relaunch = PrReviewRun {
            session_id: 11,
            created_at: "2030-01-01T00:00:00+00:00".to_string(),
            ..f.pr_runs[0].1.clone()
        };
        f.pr_runs
            .push((f.roots.runs_dir.join("pr").join("relaunch.json"), relaunch));

        let (_, entries) = list(&f, &[], &[]);
        let briefs: Vec<&SamuraiFileEntry> = entries
            .iter()
            .filter(|e| e.kind == SamuraiFileKind::Brief && e.group_id == PR_GROUP)
            .collect();
        assert_eq!(briefs.len(), 1, "one file, one row: {briefs:?}");

        // …and the surviving row is in use while EITHER terminal is open.
        let (_, entries) = list(&f, &[], &[11]);
        assert!(entries
            .iter()
            .filter(|e| e.kind == SamuraiFileKind::Brief && e.group_id == PR_GROUP)
            .all(|e| e.in_use));
    }

    /// Review B5: `read_dir` hands the records of one PR over in arbitrary
    /// order, so a titled record can arrive AFTER a newer untitled one. The
    /// card must still say what the PR is — a title fills an empty label
    /// whatever the order, and only recency decides between two titles.
    #[test]
    fn test_a_pr_title_fills_an_empty_label_whatever_the_record_order() {
        let base = tempdir().unwrap();
        let roots = roots_in(base.path());
        let project = base.path().to_string_lossy().into_owned();
        let record = |title: &str, session, created_at: &str| {
            let mut run = PrReviewRun::now(
                PrReviewLaunch {
                    pr: 142,
                    title: title.to_string(),
                    repo: "nachogl1/maestro".to_string(),
                    project_path: project.clone(),
                    steps: vec![],
                },
                session,
                None,
            );
            run.created_at = created_at.to_string();
            (roots.runs_dir.join(format!("{session}.json")), run)
        };

        // The untitled relaunch is the NEWER of the two, and is seen first.
        let runs = vec![
            record("", 9, "2026-08-17T13:00:00+00:00"),
            record("fix journal splitting", 7, "2026-08-17T12:00:00+00:00"),
        ];
        let (groups, _) = list_files(&roots, &[], &[], &[], &runs, &[]);
        assert_eq!(
            group(&groups, PR_GROUP).label,
            "PR #142 — fix journal splitting"
        );

        // The newest title still wins when there are two.
        let runs = vec![
            record("stale title", 9, "2026-08-17T12:00:00+00:00"),
            record("fix journal splitting", 7, "2026-08-17T13:00:00+00:00"),
        ];
        let (groups, _) = list_files(&roots, &[], &[], &[], &runs, &[]);
        assert_eq!(
            group(&groups, PR_GROUP).label,
            "PR #142 — fix journal splitting"
        );
    }

    #[test]
    fn test_brief_claim_key_ignores_case_and_separator_spelling() {
        // Windows resolves `C:\Git\Maestro` and `C:\git\maestro` to one
        // checkout; `PathBuf` equality does not. The PR record and the run
        // config can carry either spelling, and an exact compare listed the
        // same brief twice, in two groups.
        let key = path_key(Path::new(r"C:\git\maestro\.maestro\briefs\pr-1.md"));
        assert_eq!(
            key,
            path_key(Path::new(r"C:\Git\Maestro\.maestro\briefs\PR-1.md"))
        );
        assert_eq!(
            key,
            path_key(Path::new(r"\\?\C:\git\maestro\.maestro\briefs\pr-1.md"))
        );
        assert_eq!(
            key,
            path_key(Path::new("C:/git/maestro/.maestro/briefs/pr-1.md"))
        );
        assert_ne!(
            key,
            path_key(Path::new(r"C:\git\other\.maestro\briefs\pr-1.md"))
        );
    }

    /// A PR review whose checkout doubles as a run worktree must not have its
    /// brief swept into the run's group: one file, one group, always.
    #[test]
    fn test_a_pr_brief_is_never_claimed_by_a_run_sharing_the_checkout() {
        let base = tempdir().unwrap();
        let roots = roots_in(base.path());
        let store = RunConfigStore::new(roots.runs_dir.clone());
        let project = base.path().join("solo");
        let project_str = project.to_string_lossy().into_owned();
        let dir = project.join(BRIEF_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("gen-1-launch.md"), "run brief").unwrap();
        std::fs::write(dir.join("pr-142-check.md"), "pr brief").unwrap();
        store
            .save(&SamuraiRunConfig::new(
                project_str.clone(),
                "#9",
                project_str.clone(),
            ))
            .unwrap();
        let pr_run = PrReviewRun::now(
            PrReviewLaunch {
                pr: 142,
                title: String::new(),
                repo: "nachogl1/maestro".to_string(),
                project_path: project_str.clone(),
                steps: vec!["check".to_string()],
            },
            3,
            Some(format!("{BRIEF_DIR}/pr-142-check.md")),
        );

        let (_, entries) = list_files(
            &roots,
            &store.list_with_paths(),
            &[],
            &[],
            &[(roots.runs_dir.join("pr").join("r.json"), pr_run)],
            &[],
        );

        let briefs = of_kind(&entries, SamuraiFileKind::Brief);
        assert_eq!(briefs.len(), 2);
        let pr_brief = briefs
            .iter()
            .find(|e| e.path.ends_with("pr-142-check.md"))
            .unwrap();
        assert_eq!(pr_brief.group_id, PR_GROUP);
        let run_brief = briefs
            .iter()
            .find(|e| e.path.ends_with("gen-1-launch.md"))
            .unwrap();
        assert_eq!(run_brief.group_id, run_group_id(&project_str, "#9"));
    }

    #[test]
    fn test_inventory_row_and_group_wire_shape() {
        let f = fixture();
        let (groups, entries) = list(&f, &[], &[]);

        // Every row carries size + RFC 3339 modified time and a stripped path.
        for e in &entries {
            assert!(!e.path.starts_with(r"\\?\"), "unstripped path: {}", e.path);
            let modified = e.modified_at.as_deref().expect("modified time reported");
            assert!(
                chrono::DateTime::parse_from_rfc3339(modified).is_ok(),
                "modified_at must be RFC 3339, got {modified:?}"
            );
        }

        // Wire shape: snake_case keys, SCREAMING kinds — issue #140 consumes
        // these exact spellings.
        let raw = serde_json::to_value(&entries[0]).unwrap();
        for key in [
            "group_id",
            "kind",
            "path",
            "size_bytes",
            "modified_at",
            "project_path",
            "epic",
            "in_use",
            "has_live_session",
            "fire_at",
        ] {
            assert!(raw.get(key).is_some(), "missing key {key} in {raw}");
        }
        let raw = serde_json::to_value(group(&groups, PR_GROUP)).unwrap();
        for key in [
            "id",
            "kind",
            "label",
            "refs",
            "project_path",
            "created_at",
            "is_live",
            "audit_key",
            "audit_rows",
            "journal_entries",
        ] {
            assert!(raw.get(key).is_some(), "missing key {key} in {raw}");
        }
        assert_eq!(raw["kind"], "PR_REVIEW");
        assert_eq!(
            serde_json::to_value(SamuraiGroupKind::Run).unwrap(),
            serde_json::json!("RUN")
        );
        assert_eq!(
            serde_json::to_value(SamuraiFileKind::PrReviewRun).unwrap(),
            serde_json::json!("PR_REVIEW_RUN")
        );
        assert_eq!(
            serde_json::to_value(SamuraiFileKind::Brief).unwrap(),
            serde_json::json!("BRIEF")
        );
    }

    #[test]
    fn test_journal_is_in_use_only_while_an_orchestrator_is_live() {
        // The rider tells every live agent to append its friction to the
        // journal, so deleting it mid-run destroys unconsumed entries — that
        // has to hit the harder IN_USE confirm, not an ordinary one.
        let f = fixture();

        let (_, idle) = list(&f, &[], &[]);
        assert!(
            of_kind(&idle, SamuraiFileKind::Journal)
                .iter()
                .all(|e| !e.in_use),
            "nothing supervised: an ordinary delete confirm is right"
        );

        let (_, live) = list(
            &f,
            &[session(&f.project, "#9", SupervisorState::Working)],
            &[],
        );
        let journal = of_kind(&live, SamuraiFileKind::Journal);
        assert!(!journal.is_empty());
        assert!(journal.iter().all(|e| e.in_use));
    }

    /// Criterion 8: `has_live_session` still means exactly "a live
    /// (non-terminal) supervised session exists for this entry's project +
    /// epic" — the signal the Second Brain gates "clean this epic" on, which
    /// must stay false for a completed-but-still-ACTIVE run.
    #[test]
    fn test_in_use_marking_and_live_session_gate() {
        let f = fixture();
        let (groups, entries) = list(&f, &[], &[]);

        // ACTIVE epic #9: its config, handoffs, brief, timer and audit slice
        // are all in use. With NO session, none of it has a live session —
        // the completed-but-still-ACTIVE shape the clean-this-epic gate needs.
        for e in &entries {
            // The journal row is the one exception: it is shared, so its
            // in_use follows "any orchestrator supervised", not the epic's.
            if e.epic.as_deref() == Some("#9") && e.kind != SamuraiFileKind::Journal {
                assert!(e.in_use, "expected in_use: {e:?}");
            }
        }
        assert!(entries.iter().all(|e| !e.has_live_session));
        assert!(groups.iter().all(|g| !g.is_live));

        // ARCHIVED epic #7 (no session, no timer): config + handoff free.
        for e in &entries {
            if e.epic.as_deref() == Some("#7") && e.kind != SamuraiFileKind::AuditLog {
                assert!(!e.in_use, "expected NOT in_use: {e:?}");
            }
        }

        // A live session on the archived epic flips it in-use — matched by
        // slug ("7" vs the config's "#7"), like every other samurai surface.
        let (groups, entries) = list(
            &f,
            &[session(&f.project, "7", SupervisorState::Working)],
            &[],
        );
        assert!(entries
            .iter()
            .filter(|e| e.epic.as_deref() == Some("#7"))
            .all(|e| e.in_use && e.has_live_session));
        assert!(entries
            .iter()
            .filter(|e| e.epic.as_deref() != Some("#7"))
            .all(|e| !e.has_live_session));
        assert!(group(&groups, &run_group_id(&f.project, "#7")).is_live);
        assert!(!group(&groups, &run_group_id(&f.project, "#9")).is_live);

        // A terminal session does NOT.
        let (groups, entries) = list(
            &f,
            &[session(&f.project, "7", SupervisorState::Parked)],
            &[],
        );
        assert!(entries
            .iter()
            .filter(|e| e.epic.as_deref() == Some("#7") && e.kind != SamuraiFileKind::AuditLog)
            .all(|e| !e.in_use && !e.has_live_session));
        assert!(groups.iter().all(|g| !g.is_live));
    }

    /// A run known ONLY from a live session or a pending timer still gets its
    /// group: an entry can never be emitted with nowhere to live.
    #[test]
    fn test_a_timer_or_session_without_a_config_still_makes_a_group() {
        let base = tempdir().unwrap();
        let roots = roots_in(base.path());
        let timers = vec![timer("C:/git/beta", "#4", "2030-01-01T00:00:00+00:00")];
        write_schedule(&roots, &timers);

        let (groups, entries) = list_files(
            &roots,
            &[],
            &timers,
            &[session("C:/git/beta", "#5", SupervisorState::Working)],
            &[],
            &[],
        );

        assert_eq!(
            ids(&groups),
            sorted(vec![
                run_group_id("C:/git/beta", "#4"),
                run_group_id("C:/git/beta", "#5"),
            ])
        );
        let parked = group(&groups, &run_group_id("C:/git/beta", "#4"));
        assert_eq!(parked.label, "Epic #4");
        assert!(parked.created_at.is_none(), "no durable record to date it");
        assert!(group(&groups, &run_group_id("C:/git/beta", "#5")).is_live);
        assert_eq!(entries.len(), 1, "the timer row");
        assert_eq!(entries[0].group_id, run_group_id("C:/git/beta", "#4"));
    }

    #[test]
    fn test_delete_rejects_paths_outside_managed_roots() {
        let f = fixture();
        let (_, entries) = list(&f, &[], &[]);
        let configs = f.store.list_with_paths();

        // A file that simply lives elsewhere.
        let outside_dir = f.base.path().join("elsewhere");
        std::fs::create_dir_all(&outside_dir).unwrap();
        let outside = outside_dir.join("evil.txt");
        std::fs::write(&outside, "keep me").unwrap();
        let err = delete_file(
            &f.roots,
            &configs,
            &f.pr_runs,
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
            &f.pr_runs,
            &entries,
            &traversal.to_string_lossy(),
            true,
        )
        .unwrap_err();
        assert!(err.contains("outside"), "{err}");
        assert!(outside.exists());

        // The epic WORKTREE is not a managed root — only its handoff and
        // brief dirs are.
        let in_worktree = PathBuf::from(&configs[0].1.worktree_path).join("src-file.rs");
        std::fs::write(&in_worktree, "code").unwrap();
        let err = delete_file(
            &f.roots,
            &configs,
            &f.pr_runs,
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
            &f.pr_runs,
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
            &f.pr_runs,
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
        let (_, entries) = list(&f, &[], &[]);
        let configs = f.store.list_with_paths();

        // An in-use handoff (ACTIVE epic #9): refused without force, with
        // the structured prefix the UI keys its harder confirm off.
        let handoff = entries
            .iter()
            .find(|e| e.kind == SamuraiFileKind::Handoff && e.in_use)
            .expect("fixture has in-use handoffs");
        let err = delete_file(
            &f.roots,
            &configs,
            &f.pr_runs,
            &entries,
            &handoff.path,
            false,
        )
        .unwrap_err();
        assert!(err.starts_with(IN_USE_ERROR_PREFIX), "{err}");
        assert!(Path::new(&handoff.path).exists(), "refusal must not delete");

        // force=true deletes it.
        delete_file(
            &f.roots,
            &configs,
            &f.pr_runs,
            &entries,
            &handoff.path,
            true,
        )
        .unwrap();
        assert!(!Path::new(&handoff.path).exists());
    }

    /// The two artifacts issue #139 adds are deletable through the same
    /// guard: a brief lives in a managed brief dir, a PR record in the runs
    /// root.
    #[test]
    fn test_briefs_and_pr_records_are_deletable_managed_files() {
        let f = fixture();
        let (_, entries) = list(&f, &[], &[]);
        let configs = f.store.list_with_paths();

        for kind in [SamuraiFileKind::Brief, SamuraiFileKind::PrReviewRun] {
            let entry = entries
                .iter()
                .find(|e| e.kind == kind && !e.in_use)
                .unwrap_or_else(|| panic!("fixture has a free {kind:?}"));
            delete_file(&f.roots, &configs, &f.pr_runs, &entries, &entry.path, false).unwrap();
            assert!(!Path::new(&entry.path).exists());
        }
    }

    #[test]
    fn test_delete_refuses_schedule_json_even_with_force() {
        // Review F1: raw-deleting schedule.json neither cancels the
        // in-memory timers (the next fire would re-persist it) nor scopes to
        // one epic — the refusal points at cancelling timers instead, and
        // `force` does not override it.
        let f = fixture();
        let (_, entries) = list(&f, &[], &[]);
        let configs = f.store.list_with_paths();
        let schedule = f.roots.samurai_dir.join("schedule.json");

        for force in [false, true] {
            let err = delete_file(
                &f.roots,
                &configs,
                &f.pr_runs,
                &entries,
                &schedule.to_string_lossy(),
                force,
            )
            .unwrap_err();
            assert!(err.contains("cancel the"), "{err}");
            assert!(!err.starts_with(IN_USE_ERROR_PREFIX), "{err}");
            assert!(schedule.exists());
        }
    }

    #[test]
    fn test_delete_not_in_use_needs_no_force() {
        let f = fixture();
        let (_, entries) = list(&f, &[], &[]);
        let configs = f.store.list_with_paths();

        // The ARCHIVED #7 run config is not in use — plain delete works.
        let archived = entries
            .iter()
            .find(|e| e.kind == SamuraiFileKind::RunConfig && !e.in_use)
            .expect("fixture has an archived config");
        assert_eq!(archived.epic.as_deref(), Some("#7"));
        delete_file(
            &f.roots,
            &configs,
            &f.pr_runs,
            &entries,
            &archived.path,
            false,
        )
        .unwrap();
        assert!(!Path::new(&archived.path).exists());
    }

    /// Pins Q3/R2 (issue #142): a legacy harvest report carries no group and
    /// is never emitted by [`list_files`], yet the Journal panel's delete
    /// action still reaches it through this same guard — because
    /// `roots.harvest_dir` stays a managed root. Dropping it from the
    /// `managed` vec above would silently break that surface without this
    /// test failing loudly.
    #[test]
    fn test_delete_removes_a_legacy_harvest_report_though_it_is_not_listed() {
        let f = fixture();
        let (_, entries) = list(&f, &[], &[]);
        let configs = f.store.list_with_paths();
        let report = f.roots.harvest_dir.join("harvest-2026-08-07.md");
        assert!(report.exists());
        assert!(
            entries
                .iter()
                .all(|e| e.kind != SamuraiFileKind::HarvestReport),
            "the legacy report must not appear in the inventory"
        );

        delete_file(
            &f.roots,
            &configs,
            &f.pr_runs,
            &entries,
            &report.to_string_lossy(),
            false,
        )
        .unwrap();

        assert!(!report.exists());
    }

    #[test]
    fn test_handoff_and_brief_dirs_strip_the_extended_prefix() {
        assert_eq!(
            handoff_dir(r"\\?\C:\wt\epic-9"),
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
        assert_eq!(
            brief_dir(r"\\?\C:\wt\epic-9"),
            PathBuf::from(r"C:\wt\epic-9").join(BRIEF_DIR)
        );
    }

    #[test]
    fn test_journal_agent_matching_is_segment_exact() {
        // The rider asks agents for "your epic/generation id", so the value
        // is free text. Epic `3` must never claim epic `38`'s entries.
        assert!(agent_matches("#38 gen-2", "38"));
        assert!(agent_matches("38", "38"));
        assert!(!agent_matches("#380 gen-2", "38"));
        assert!(!agent_matches("#3 gen-2", "38"));

        // Only the LEADING segment identifies the run. A trailing or interior
        // one is the generation counter, and matching it made every
        // single-digit epic claim every `gen-N` entry of every other run:
        // `#9 gen-1` slugs to `9-gen-1`, whose last segment is `1`.
        assert!(!agent_matches("#9 gen-1", "1"));
        assert!(!agent_matches("#9 gen-2", "2"));
        assert!(!agent_matches("#38 gen-7 of 12", "12"));
        // The cost of that rule: a run id buried mid-string no longer
        // matches. The rider asks for the id FIRST, so this is the shape
        // production writes, and a missed slice beats a stolen one.
        assert!(!agent_matches("gen-1 of 38", "38"));

        // A PR review's key is its group id, matched exactly.
        assert!(agent_matches(PR_GROUP, PR_GROUP));
        assert!(!agent_matches("pr:nachogl1/maestro#143", PR_GROUP));
    }

    #[test]
    fn test_retention_sweep_only_touches_archived_epics() {
        // PRD §8 row 1. The fixture has an ACTIVE epic (#9, two handoffs, one
        // brief) and an ARCHIVED one (#7, one handoff).
        let f = fixture();
        let wt7 = f.base.path().join("wt-7").join(".maestro").join("handoffs");
        let wt9 = f.base.path().join("wt-9").join(".maestro").join("handoffs");
        std::fs::write(wt7.join("notes.txt"), "not a handoff").unwrap();
        // Review B11: briefs accumulate in the same worktree and were never
        // swept — one per generation, per staged ritual, forever.
        let brief7 = f.base.path().join("wt-7").join(BRIEF_DIR);
        std::fs::create_dir_all(&brief7).unwrap();
        std::fs::write(brief7.join("gen-1-ritual.md"), "# brief").unwrap();
        std::fs::write(brief7.join("notes.txt"), "not a brief").unwrap();
        let brief9 = f.base.path().join("wt-9").join(BRIEF_DIR);
        let configs = f.store.list_with_paths();

        // Fresh files under the shipped 14-day window: nothing is swept.
        assert!(sweep_handoff_retention(&configs, 14).is_empty());
        assert!(wt7.join("7-gen1.md").exists());

        // Expired. `0` is the age boundary this test can reach without a
        // fake clock; `validate()` forbids 0 in a real config, so the sweep
        // only ever sees >= 1 in production.
        let removed = sweep_handoff_retention(&configs, 0);
        assert_eq!(removed.len(), 2, "handoff AND brief; removed: {removed:?}");
        assert!(!wt7.join("7-gen1.md").exists());
        assert!(!brief7.join("gen-1-ritual.md").exists());
        assert!(
            wt7.join("notes.txt").exists() && brief7.join("notes.txt").exists(),
            "only .md artifacts are swept"
        );
        assert!(
            wt9.join("9-gen1.md").exists() && wt9.join("9-gen2.md").exists(),
            "an ACTIVE epic keeps its history while it is live"
        );
        assert!(
            brief9.join("gen-1-launch.md").exists(),
            "an ACTIVE epic keeps its briefs too"
        );

        // Idempotent; an already-empty (or missing) handoff dir is not an
        // error.
        assert!(sweep_handoff_retention(&configs, 0).is_empty());
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
