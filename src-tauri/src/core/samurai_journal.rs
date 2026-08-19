//! Samurai ops journal (issue #69; PRD §5.12): an app-data JSONL where
//! agents and the user record bottlenecks, errors, improvements, skill gaps
//! and concerns, consumed by the periodic harvest (next issue).
//!
//! **Files (flat, so `samurai_files::push_dir_files` inventories them):**
//! `<journal dir>/journal.jsonl` holds the active entries plus the harvest
//! markers; `<journal dir>/archive.jsonl` holds entries a harvest has moved
//! out. One JSON object per line.
//!
//! **Append-only consumption:** agents append entry lines to the active file
//! straight from shell prompts, so a per-entry `consumed` flag would need
//! unsafe in-place mutation. Consumption is instead marked by appending a
//! `HARVEST` marker line; an entry's status is derived from its position
//! relative to the markers: after the last marker = `UNCONSUMED`, between
//! the last two markers = `CONSUMED`, before the previous marker =
//! `ARCHIVED` ([`JournalStore::commit_harvest`] moves those into
//! `archive.jsonl`, so an active-file `ARCHIVED` entry only exists after a
//! crash mid-harvest — the next harvest sweeps it up).
//!
//! **Concurrency:** a `Mutex` serializes in-process writers (the
//! `RunConfigStore` pattern — writers are rare, the audit log's
//! single-writer task would be overkill), and `commit_harvest`'s rewrite of
//! the active file is atomic (serialize to `.tmp`, then `fs::rename` — the
//! `samurai_run_config` pattern), so a crash can never leave a torn file.
//! Reads are lenient like `samurai_audit`: malformed or unknown-shape lines
//! are skipped with a warning, never a failed read — and `commit_harvest`
//! carries such lines through its rewrite verbatim rather than deleting
//! data it could not parse.
//!
//! **Per-entry delete (issue #100):** entries carry no id, so
//! [`JournalStore::delete_entry`] identifies one by its exact on-disk JSONL
//! text (the `raw` field `list()` hands back) and removes every line
//! byte-identical to it — see that method's docs for the identity and
//! duplicate-handling rationale. Unlike `commit_harvest`, a delete must not
//! lose a same-window out-of-process append (an agent's `>>`): it re-reads
//! the file immediately before its atomic rewrite and carries any newly
//! appended bytes through untouched — and the rewrite re-verifies again
//! before every rename attempt, because the Windows rename-retry sleeps
//! (up to ~500 ms) are the widest append window of all.
//!
//! **Oversized entries (issue #135):** the harvest renders WHOLE entries
//! only, so a single entry longer than its prompt cap used to be
//! char-truncated inline, counted as rendered, marked consumed and then
//! archived — everything past the cut was never delivered to any harvest.
//! Capping at write time would not help: agents append raw JSONL straight
//! from shell prompts, entirely outside [`JournalStore::append_entry`]. So
//! the fix lives at harvest time and on disk:
//! [`JournalStore::split_oversized_unconsumed`] rewrites an oversized
//! UNCONSUMED entry as N `[part k/N] ` part-entries, each a whole entry
//! that flows through the existing whole-entry cap over consecutive
//! harvests. Nothing is truncated, nothing is lost, and nothing stalls —
//! every harvest consumes at least the part it rendered.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};

use super::samurai_files::normalize_project;

/// Name of the active journal file inside the journal dir.
pub const JOURNAL_FILE: &str = "journal.jsonl";
/// Name of the archive file inside the journal dir.
pub const ARCHIVE_FILE: &str = "archive.jsonl";

/// What a journal entry records (PRD §5.12). SCREAMING on the wire like
/// `AuditEventKind`/`SamuraiFileKind` — agents hand-write these spellings
/// in shell prompts, so they are a contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JournalCategory {
    Bottleneck,
    Error,
    Improvement,
    Skill,
    Concern,
}

/// One journal row. Serialized as a single JSONL line:
/// `{"ts":..,"category":..,"text":..}` plus `project`/`agent` only when
/// set (absent, not null — the minimal shape is what agents append).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JournalEntry {
    /// RFC 3339 UTC timestamp. Same-format timestamps compare correctly as
    /// strings (the `samurai_audit` convention).
    pub ts: String,
    pub category: JournalCategory,
    pub text: String,
    /// Owning project path, when known. Normalized (`\\?\`-stripped) on
    /// construction and on append, per fork convention.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The agent that recorded the entry; `None` for user entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

impl JournalEntry {
    /// Builds an entry stamped with the current UTC time.
    pub fn now(
        category: JournalCategory,
        text: impl Into<String>,
        project: Option<String>,
        agent: Option<String>,
    ) -> Self {
        Self {
            ts: chrono::Utc::now().to_rfc3339(),
            category,
            text: text.into(),
            project: project.map(|p| normalize_project(&p)),
            agent,
        }
    }
}

/// The `kind` discriminator of a marker line. A one-variant enum so the
/// SCREAMING spelling is pinned by serde, not by a string literal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarkerKind {
    Harvest,
}

/// One harvest-marker row: `{"ts":..,"kind":"HARVEST","report":"YYYY-MM-DD"}`.
/// Appended by [`JournalStore::commit_harvest`]; everything before it in the
/// file has been consumed by the report named in `report`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HarvestMarker {
    /// RFC 3339 UTC timestamp of the harvest.
    pub ts: String,
    pub kind: MarkerKind,
    /// Date of the harvest report that consumed the entries (`YYYY-MM-DD`).
    pub report: String,
}

impl HarvestMarker {
    /// Builds a marker stamped with the current UTC time.
    pub fn now(report: impl Into<String>) -> Self {
        Self {
            ts: chrono::Utc::now().to_rfc3339(),
            kind: MarkerKind::Harvest,
            report: report.into(),
        }
    }
}

/// Consumption status derived from an entry's position relative to the
/// harvest markers (see the module docs). SCREAMING on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JournalEntryStatus {
    Unconsumed,
    Consumed,
    Archived,
}

/// One listed entry with its derived status.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JournalEntryWithStatus {
    pub entry: JournalEntry,
    pub status: JournalEntryStatus,
    /// The exact on-disk JSONL text this entry came from (no trailing
    /// newline), verbatim — never a re-serialization. Entries carry no id
    /// (issue #100: the wire shape is a hand-written agent contract), so
    /// this is the smallest identity that survives a list -> confirm ->
    /// delete round trip; the frontend hands it back unmodified to
    /// [`JournalStore::delete_entry`].
    pub raw: String,
}

/// Result of a list: the active file's entries (newest last) plus the file
/// size, reported like `AuditReadResult` so the frontend can warn on growth.
#[derive(Debug, Clone, Serialize)]
pub struct JournalListResult {
    pub entries: Vec<JournalEntryWithStatus>,
    pub file_size_bytes: u64,
    /// Lines the parser could not understand (a mis-spelled category, a
    /// shape that fails deserialization). They are never listed, harvested
    /// or dropped — carried through every rewrite verbatim — so without this
    /// count an agent's mis-written friction was recorded and then invisible
    /// to everyone, with no signal that anything had been skipped.
    pub opaque_line_count: usize,
}

/// One parsed line of the active file, in file order. `Opaque` lines
/// (malformed or unknown shape) are never listed, archived or dropped —
/// they ride through rewrites verbatim. `Entry`/`Marker` additionally carry
/// their own exact original text (not a re-serialization) — [`delete_entry`]
/// needs it to match a caller's raw identity and to carry every untouched
/// line through its rewrite byte-for-byte.
enum RawLine {
    Entry(JournalEntry, String),
    Marker(HarvestMarker, String),
    Opaque(String),
}

impl RawLine {
    /// The exact on-disk bytes (minus the trailing newline) this line came
    /// from, for every variant.
    fn raw(&self) -> &str {
        match self {
            RawLine::Entry(_, raw) | RawLine::Marker(_, raw) => raw,
            RawLine::Opaque(raw) => raw,
        }
    }
}

/// The on-disk store. Constructed once at app setup (rooted at
/// `artifact_base_dir("journal")`) and managed as `Arc<JournalStore>`;
/// tests root it at a tempdir.
pub struct JournalStore {
    journal_dir: PathBuf,
    /// Serializes in-process writers ([`RunConfigStore`]'s pattern —
    /// `core/samurai_run_config.rs`). Reads take it too: simplest
    /// reasoning, negligible cost at this write rate.
    lock: Mutex<()>,
}

impl JournalStore {
    pub fn new(journal_dir: PathBuf) -> Self {
        // The agent rider appends via `echo '<json>' >> ...journal.jsonl`,
        // and shell redirection creates files, not directories — so the dir
        // must exist from construction or every agent append fails on a
        // fresh install. Log-only: an in-process write surfaces the same
        // failure with context.
        if let Err(e) = std::fs::create_dir_all(&journal_dir) {
            log::warn!("failed to create journal dir {journal_dir:?}: {e}");
        }
        Self {
            journal_dir,
            lock: Mutex::new(()),
        }
    }

    fn journal_path(&self) -> PathBuf {
        self.journal_dir.join(JOURNAL_FILE)
    }

    fn archive_path(&self) -> PathBuf {
        self.journal_dir.join(ARCHIVE_FILE)
    }

    /// Appends one entry to the active file (whole-line append + flush, the
    /// `samurai_audit::append_line` convention). The entry's project is
    /// normalized so a verbatim and a plain spelling never diverge on disk.
    pub fn append_entry(&self, entry: &JournalEntry) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let mut entry = entry.clone();
        entry.project = entry.project.as_deref().map(normalize_project);
        let line = serde_json::to_string(&entry)
            .map_err(|e| format!("failed to serialize journal entry: {e}"))?;
        append_raw(&self.journal_path(), &format!("{line}\n"))
    }

    /// The active file's entries in file order (append order — newest last),
    /// each with its derived status, plus the current file size. A missing
    /// file reads as empty, size 0 (the normal first-launch state).
    pub fn list(&self) -> Result<JournalListResult, String> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let (lines, file_size_bytes) = read_lines(&self.journal_path())?;
        let (last, prev) = marker_positions(&lines);
        let entries = lines
            .iter()
            .enumerate()
            .filter_map(|(i, line)| match line {
                RawLine::Entry(entry, raw) => Some(JournalEntryWithStatus {
                    entry: entry.clone(),
                    status: entry_status(i, last, prev),
                    raw: raw.clone(),
                }),
                _ => None,
            })
            .collect();
        let opaque_line_count = lines
            .iter()
            .filter(|l| matches!(l, RawLine::Opaque(_)))
            .count();
        Ok(JournalListResult {
            entries,
            file_size_bytes,
            opaque_line_count,
        })
    }

    /// The entries no harvest has consumed yet (after the last marker) —
    /// what the harvest runner (next issue) feeds into a report.
    pub fn unconsumed(&self) -> Result<Vec<JournalEntry>, String> {
        Ok(self
            .unconsumed_with_raw()?
            .into_iter()
            .map(|e| e.entry)
            .collect())
    }

    /// [`JournalStore::unconsumed`] with each entry's exact on-disk raw line
    /// attached — the identity the harvest triage snapshots so its
    /// consumption commit can be content-anchored ([`commit_harvest`]).
    pub fn unconsumed_with_raw(&self) -> Result<Vec<JournalEntryWithStatus>, String> {
        Ok(self
            .list()?
            .entries
            .into_iter()
            .filter(|e| e.status == JournalEntryStatus::Unconsumed)
            .collect())
    }

    /// Marks the harvest's rendered entries as consumed by the `report_date`
    /// (`YYYY-MM-DD`) harvest by inserting the new marker immediately after
    /// them. `rendered` holds the exact raw JSONL lines (the `raw` field
    /// [`JournalStore::list`] hands back) the harvest actually rendered into
    /// its prompt; the marker lands before the first unconsumed line NOT
    /// among them. Content-anchored rather than count-based on purpose: a
    /// per-entry delete (issue #100) interleaving between the harvest's
    /// snapshot and this commit shrinks the unconsumed region, and a count
    /// would shift the boundary past a never-injected entry. Entries
    /// appended while the (up to minutes-long) claude run was in flight,
    /// and entries the prompt cap withheld, sit AFTER the boundary, stay
    /// `UNCONSUMED`, and roll into the next harvest instead of being
    /// archived undigested.
    ///
    /// The same rewrite archives history: entries older than the previous
    /// (pre-existing last) marker — `ARCHIVED` once the new marker lands —
    /// move to `archive.jsonl`, and markers older than that last
    /// pre-existing marker move with them, so the active file keeps at most
    /// two markers (the last pre-existing one plus the new one). The
    /// active-file rewrite is atomic (`.tmp` + rename); when nothing moves
    /// and the boundary is the end of the file, a plain append is used
    /// instead, which — unlike a rewrite — cannot race an agent appending
    /// from a shell prompt. A crash between the archive append and the
    /// rename can duplicate entries into the archive on the next harvest;
    /// that is the accepted cost of two-file atomicity not existing (harvest
    /// reports are advisory).
    pub fn commit_harvest(&self, report_date: &str, rendered: &[String]) -> Result<(), String> {
        chrono::NaiveDate::parse_from_str(report_date, "%Y-%m-%d")
            .map_err(|e| format!("invalid report date {report_date:?} (want YYYY-MM-DD): {e}"))?;
        // A COUNTED multiset, not a set: two agents recording the same
        // category/text/project/agent in the same second produce byte-
        // identical JSONL, and when the render cap withheld the duplicate a
        // set-membership test still matched it — so a never-injected entry
        // was marked consumed and archived undigested.
        let mut unmatched: std::collections::HashMap<&str, usize> =
            std::collections::HashMap::new();
        for line in rendered {
            *unmatched.entry(line.as_str()).or_insert(0) += 1;
        }
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let journal_path = self.journal_path();
        let (lines, original) = read_lines_with_bytes(&journal_path)?;
        // Lines before the CURRENT last marker are older than what will be
        // the previous marker once the new one lands — entries AND markers
        // there move out (the active file never holds more than two markers).
        let archive_before = lines
            .iter()
            .rposition(|l| matches!(l, RawLine::Marker(..)))
            .unwrap_or(0);
        let marker_line = serde_json::to_string(&HarvestMarker::now(report_date))
            .map_err(|e| format!("failed to serialize harvest marker: {e}"))?;

        let mut archived = String::new();
        let mut kept = String::new();
        // Entries seen past the last pre-existing marker: the new marker is
        // inserted before the first one the harvest did NOT render (the
        // content-anchored snapshot boundary). Everything matched up to that
        // point WAS injected; everything past it — a withheld, mid-run or
        // interleaved-delete survivor — stays unconsumed.
        let mut marker_inserted = false;
        for (i, line) in lines.iter().enumerate() {
            match line {
                // Carried through VERBATIM, like the opaque arm below:
                // re-serializing dropped any field an agent added that serde
                // ignores on read, and changed the exact bytes `list()` hands
                // back as a row's delete identity.
                RawLine::Entry(_, original_raw) => {
                    if i < archive_before {
                        archived.push_str(original_raw);
                        archived.push('\n');
                    } else {
                        if !marker_inserted {
                            match unmatched.get_mut(original_raw.as_str()) {
                                // One rendered copy accounted for.
                                Some(remaining) if *remaining > 0 => *remaining -= 1,
                                // The first line the harvest did NOT render:
                                // the consumption boundary goes here.
                                _ => {
                                    kept.push_str(&marker_line);
                                    kept.push('\n');
                                    marker_inserted = true;
                                }
                            }
                        }
                        kept.push_str(original_raw);
                        kept.push('\n');
                    }
                }
                RawLine::Marker(marker, _) => {
                    let raw = serde_json::to_string(marker)
                        .map_err(|e| format!("failed to serialize harvest marker: {e}"))?;
                    let target = if i < archive_before {
                        &mut archived
                    } else {
                        &mut kept
                    };
                    target.push_str(&raw);
                    target.push('\n');
                }
                // Never archived, never dropped — carried through verbatim.
                RawLine::Opaque(raw) => {
                    kept.push_str(raw);
                    kept.push('\n');
                }
            }
        }

        if !marker_inserted {
            // Boundary at (or past) the end of the file. With nothing
            // archived the whole rewrite degenerates to appending the
            // marker — the race-free path.
            if archived.is_empty() {
                return append_raw(&journal_path, &format!("{marker_line}\n"));
            }
            kept.push_str(&marker_line);
            kept.push('\n');
        }
        if !archived.is_empty() {
            append_raw(&self.archive_path(), &archived)?;
        }
        // Carrying, not plain: the rider tells every live agent to `>>` its
        // friction into this file, and a plain rewrite silently erased any
        // append that landed between the read above and the rename — including
        // inside the Windows rename-retry sleeps. Same guarantee the delete
        // path next door already had.
        atomic_write_carrying_appends(&journal_path, kept, original)
    }

    /// Deletes every active-file line whose entry's raw JSONL text is
    /// exactly `raw_line` (issue #100). `raw_line` is meant to be the `raw`
    /// field `list()` handed back for the row the user picked — a caller
    /// round trips it unmodified.
    ///
    /// **Identity & duplicate semantic.** Entries carry no id (the on-wire
    /// shape is a hand-written contract with agents, PRD §5.12) — the
    /// exact on-disk bytes of the line are the smallest identity available
    /// that survives a list -> confirm -> delete round trip. Two entries
    /// that happen to serialize identically are indistinguishable once
    /// round-tripped through `list()` — there is no sharper handle to say
    /// "just this one, not that other one that reads the same" — so the
    /// chosen semantic deletes EVERY line byte-identical to `raw_line`.
    /// Markers and opaque (malformed/unknown-shape) lines are never
    /// matched, so they never move or reorder. Returns the number of lines
    /// removed; 0 means `raw_line` no longer matches anything currently in
    /// the file (a stale list taken before a harvest reformatted/archived
    /// the line, or a second delete of the same row) — the caller treats
    /// that as "not found", not a crash.
    ///
    /// **Race safety.** The whole read-filter-write happens under
    /// [`JournalStore::lock`], so no IN-PROCESS writer (append/list/
    /// commit_harvest/another delete) can interleave. An OUT-OF-PROCESS
    /// append — an agent's shell `>>`, entirely outside this mutex — can
    /// still land between the read and the rename; unlike
    /// `commit_harvest`'s accepted loss window, a delete must not eat it.
    /// So immediately before writing, this re-reads the file and requires
    /// it to still literally start with the exact bytes just filtered:
    /// anything appended past that point was written after we looked and
    /// is carried into the rewrite untouched. The rewrite then re-verifies
    /// AGAIN before every rename attempt
    /// ([`atomic_write_carrying_appends`]) — its Windows rename-retry
    /// sleeps are the widest append window of all. A few retries absorb
    /// another append landing during the recheck itself; a change that is neither
    /// "unchanged" nor "our bytes plus an appended tail" should be
    /// impossible under the append-only contract and surfaces as an error
    /// rather than risking building on stale content.
    pub fn delete_entry(&self, raw_line: &str) -> Result<usize, String> {
        self.delete_entry_with_hook(raw_line, || {})
    }

    /// [`JournalStore::delete_entry`]'s body, with a test-only hook fired
    /// once — right after the delete-candidate content is computed and
    /// before the pre-write recheck — so a test can land a same-window
    /// external append exactly there and prove the recheck carries it
    /// through.
    fn delete_entry_with_hook(
        &self,
        raw_line: &str,
        on_after_filter: impl FnOnce(),
    ) -> Result<usize, String> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let path = self.journal_path();
        let mut hook = Some(on_after_filter);
        const MAX_ATTEMPTS: usize = 5;
        for attempt in 0..MAX_ATTEMPTS {
            let original = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
                Err(e) => return Err(format!("failed to read journal file {path:?}: {e}")),
            };
            let text = String::from_utf8(original.clone())
                .map_err(|e| format!("journal file {path:?} is not valid UTF-8: {e}"))?;
            let lines = parse_lines(&text, &path);

            let mut removed = 0usize;
            let mut kept = String::new();
            for line in &lines {
                if matches!(line, RawLine::Entry(_, raw) if raw == raw_line) {
                    removed += 1;
                    continue;
                }
                kept.push_str(line.raw());
                kept.push('\n');
            }
            if removed == 0 {
                return Ok(0);
            }
            if let Some(h) = hook.take() {
                h();
            }

            let current = std::fs::read(&path)
                .map_err(|e| format!("failed to read journal file {path:?}: {e}"))?;
            if current == original {
                atomic_write_carrying_appends(&path, kept, current)?;
                return Ok(removed);
            }
            if current.len() > original.len() && current.starts_with(&original) {
                // A same-window out-of-process append — carry its exact
                // bytes into the rewrite so it is never lost.
                kept.push_str(&String::from_utf8_lossy(&current[original.len()..]));
                atomic_write_carrying_appends(&path, kept, current)?;
                return Ok(removed);
            }
            // Neither unchanged nor our bytes plus an appended tail —
            // should be impossible under the contract; retry with a fresh
            // read rather than risk writing over content we never saw.
            if attempt + 1 == MAX_ATTEMPTS {
                return Err(format!(
                    "journal file {path:?} changed unexpectedly while deleting; try again"
                ));
            }
        }
        unreachable!("loop always returns or errors within MAX_ATTEMPTS")
    }

    /// Rewrites every UNCONSUMED entry whose text is longer than
    /// `max_text_chars` as N `[part k/N] ` part-entries, in place and in
    /// file order. Returns how many entries were split.
    ///
    /// **Why on disk, at harvest time (issue #135).** The harvest prompt
    /// renders WHOLE entries only and stops before its char cap, so a
    /// single entry bigger than the whole cap had nowhere to go: it was
    /// char-truncated inline, counted as rendered, marked consumed and then
    /// archived — every char past the cut was never delivered to any
    /// harvest, silently. Capping at write time cannot fix that: agents
    /// append raw JSONL lines straight from shell prompts, never through
    /// [`JournalStore::append_entry`]. Splitting the line on disk instead
    /// turns one undeliverable entry into N deliverable ones, each a whole
    /// entry that flows through the existing cap machinery — the first part
    /// goes into this harvest, the rest roll into the next ones. Nothing is
    /// truncated, nothing is lost, and nothing stalls, because every
    /// harvest consumes at least the part it rendered.
    ///
    /// **What is touched.** Only entries after the last harvest marker.
    /// Consumed and archived entries have already been digested — rewriting
    /// them would churn history and invalidate `raw` delete identities for
    /// no gain — and marker lines and [`RawLine::Opaque`] lines are carried
    /// through byte-verbatim, the same contract
    /// [`JournalStore::delete_entry`] honours. A part keeps the original's
    /// `ts`, `category`, `project` and `agent`, so provenance survives; a
    /// hand-written extra field serde ignores on read does NOT survive the
    /// split of that one line (the parts are freshly serialized) — the
    /// accepted cost of turning one line into many.
    ///
    /// **Idempotence.** The `[part k/N] ` marker is charged against
    /// `max_text_chars`, not added on top of it, so every part this writes
    /// is already under budget and the next harvest's pass leaves it alone
    /// — parts never nest.
    ///
    /// **Race safety.** Identical to the delete path: the whole
    /// read-rewrite runs under [`JournalStore::lock`], and an out-of-process
    /// append (an agent's shell `>>`) landing in the write window is carried
    /// through rather than overwritten — re-read before the write, and again
    /// before every rename attempt in
    /// [`atomic_write_carrying_appends`]. When nothing is oversized, the
    /// file is not rewritten at all.
    pub fn split_oversized_unconsumed(&self, max_text_chars: usize) -> Result<usize, String> {
        self.split_oversized_unconsumed_with_hook(max_text_chars, || {})
    }

    /// [`JournalStore::split_oversized_unconsumed`]'s body, with a test-only
    /// hook fired once — right after the split content is computed and
    /// before the pre-write recheck — so a test can land a same-window
    /// external append exactly there (the
    /// [`JournalStore::delete_entry_with_hook`] convention).
    fn split_oversized_unconsumed_with_hook(
        &self,
        max_text_chars: usize,
        on_after_split: impl FnOnce(),
    ) -> Result<usize, String> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let path = self.journal_path();
        let mut hook = Some(on_after_split);
        const MAX_ATTEMPTS: usize = 5;
        for attempt in 0..MAX_ATTEMPTS {
            let original = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
                Err(e) => return Err(format!("failed to read journal file {path:?}: {e}")),
            };
            let text = String::from_utf8(original.clone())
                .map_err(|e| format!("journal file {path:?} is not valid UTF-8: {e}"))?;
            let lines = parse_lines(&text, &path);
            let last_marker = lines.iter().rposition(|l| matches!(l, RawLine::Marker(..)));

            let mut split = 0usize;
            let mut kept = String::new();
            for (i, line) in lines.iter().enumerate() {
                let parts = match line {
                    RawLine::Entry(entry, _) if is_unconsumed(i, last_marker) => {
                        split_into_parts(entry, max_text_chars)
                    }
                    _ => None,
                };
                match parts {
                    Some(parts) => {
                        for part in &parts {
                            let raw = serde_json::to_string(part).map_err(|e| {
                                format!("failed to serialize split journal entry: {e}")
                            })?;
                            kept.push_str(&raw);
                            kept.push('\n');
                        }
                        split += 1;
                    }
                    None => {
                        kept.push_str(line.raw());
                        kept.push('\n');
                    }
                }
            }
            if split == 0 {
                return Ok(0);
            }
            if let Some(h) = hook.take() {
                h();
            }

            let current = std::fs::read(&path)
                .map_err(|e| format!("failed to read journal file {path:?}: {e}"))?;
            if current == original {
                atomic_write_carrying_appends(&path, kept, current)?;
                return Ok(split);
            }
            if current.len() > original.len() && current.starts_with(&original) {
                // A same-window out-of-process append — carry its exact
                // bytes into the rewrite so it is never lost.
                kept.push_str(&String::from_utf8_lossy(&current[original.len()..]));
                atomic_write_carrying_appends(&path, kept, current)?;
                return Ok(split);
            }
            // Neither unchanged nor our bytes plus an appended tail — should
            // be impossible under the append-only contract; retry with a
            // fresh read rather than risk writing over content we never saw.
            if attempt + 1 == MAX_ATTEMPTS {
                return Err(format!(
                    "journal file {path:?} changed unexpectedly while splitting oversized entries; try again"
                ));
            }
        }
        unreachable!("loop always returns or errors within MAX_ATTEMPTS")
    }
}

/// Whether the entry at position `idx` sits after the last harvest marker —
/// the `UNCONSUMED` half of [`entry_status`], the only region
/// [`JournalStore::split_oversized_unconsumed`] may rewrite.
fn is_unconsumed(idx: usize, last_marker: Option<usize>) -> bool {
    match last_marker {
        None => true,
        Some(last) => idx > last,
    }
}

/// The literal characters of a `[part k/N] ` marker, both numbers excluded.
const PART_MARKER_LITERAL_CHARS: usize = "[part /] ".len();

/// Chunk size and part count for splitting `total_chars` characters so that
/// every part's FINAL text — its `[part k/N] ` marker included — still fits
/// `max_text_chars`. Charging the marker to the budget rather than adding it
/// on top is what makes the split idempotent: the next harvest must not
/// re-split a part this one already wrote.
///
/// The two quantities feed back on each other — a wider marker shrinks the
/// chunk, a smaller chunk can need one more part, and one more part can
/// widen the marker again — so the plan is iterated to a fixed point. It
/// terminates because the marker grows with the LOGARITHM of the part count
/// while the part count grows only as the chunk shrinks. `None` when the
/// budget cannot even hold a marker, so no split is possible.
fn chunk_plan(total_chars: usize, max_text_chars: usize) -> Option<(usize, usize)> {
    // An entry only reaches here when it is over budget, so it needs at
    // least two parts — the smallest count worth planning for.
    let mut parts = 2usize;
    loop {
        let marker = PART_MARKER_LITERAL_CHARS + 2 * digit_count(parts);
        let chunk = max_text_chars.checked_sub(marker).filter(|c| *c > 0)?;
        let needed = total_chars.div_ceil(chunk);
        if needed <= parts {
            return Some((chunk, needed));
        }
        parts = needed;
    }
}

/// Decimal width of `n`, the marker's share of the budget per number.
fn digit_count(n: usize) -> usize {
    let mut digits = 1;
    let mut rest = n / 10;
    while rest > 0 {
        digits += 1;
        rest /= 10;
    }
    digits
}

/// `entry` re-expressed as N `[part k/N] ` part-entries when its text is
/// over `max_text_chars`, else `None` (the line is then carried through
/// verbatim). Chunking is by CHARS, so a multi-byte char is never cut in
/// half, and concatenating the parts' bodies in order reproduces the
/// original text exactly — the no-data-loss contract of issue #135.
fn split_into_parts(entry: &JournalEntry, max_text_chars: usize) -> Option<Vec<JournalEntry>> {
    let chars: Vec<char> = entry.text.chars().collect();
    if chars.len() <= max_text_chars {
        return None;
    }
    let (chunk_chars, parts) = chunk_plan(chars.len(), max_text_chars).or_else(|| {
        log::warn!(
            "journal: entry of {} chars is over the {max_text_chars}-char harvest budget but the budget cannot hold a part marker — left unsplit",
            chars.len()
        );
        None
    })?;
    Some(
        chars
            .chunks(chunk_chars)
            .enumerate()
            .map(|(i, chunk)| JournalEntry {
                ts: entry.ts.clone(),
                category: entry.category,
                text: format!(
                    "[part {}/{}] {}",
                    i + 1,
                    parts,
                    chunk.iter().collect::<String>()
                ),
                project: entry.project.clone(),
                agent: entry.agent.clone(),
            })
            .collect(),
    )
}

/// Positions of the last and second-to-last markers, when present.
fn marker_positions(lines: &[RawLine]) -> (Option<usize>, Option<usize>) {
    let markers: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| matches!(l, RawLine::Marker(..)).then_some(i))
        .collect();
    let last = markers.last().copied();
    let prev = markers.len().checked_sub(2).map(|i| markers[i]);
    (last, prev)
}

/// Derived status of the entry at position `idx` (see the module docs).
fn entry_status(idx: usize, last: Option<usize>, prev: Option<usize>) -> JournalEntryStatus {
    match (last, prev) {
        (None, _) => JournalEntryStatus::Unconsumed,
        (Some(last), _) if idx > last => JournalEntryStatus::Unconsumed,
        (Some(_), Some(prev)) if idx < prev => JournalEntryStatus::Archived,
        _ => JournalEntryStatus::Consumed,
    }
}

/// Lenient read of the active file: every line in file order, with
/// malformed/unknown lines kept as [`RawLine::Opaque`] (and warned about,
/// the `samurai_audit::read_events` convention). Missing file = empty.
fn read_lines(path: &Path) -> Result<(Vec<RawLine>, u64), String> {
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), 0)),
        Err(e) => return Err(format!("failed to stat journal file {path:?}: {e}")),
    };
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read journal file {path:?}: {e}"))?;
    let lines = parse_lines(&content, path);
    Ok((lines, metadata.len()))
}

/// [`read_lines`] returning the exact bytes it parsed, for a caller that
/// rewrites the file through [`atomic_write_carrying_appends`] — that guard
/// compares against the precise image the content was built from.
fn read_lines_with_bytes(path: &Path) -> Result<(Vec<RawLine>, Vec<u8>), String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("failed to read journal file {path:?}: {e}")),
    };
    let content = String::from_utf8_lossy(&bytes);
    let lines = parse_lines(&content, path);
    Ok((lines, bytes))
}

/// Parses every non-blank line of `content` in file order (the shared body
/// of [`read_lines`] and [`JournalStore::delete_entry_with_hook`], which
/// additionally needs the exact source bytes `content` came from).
fn parse_lines(content: &str, path: &Path) -> Vec<RawLine> {
    content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| parse_line(l, path))
        .collect()
}

fn parse_line(line: &str, path: &Path) -> RawLine {
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("skipping malformed journal line in {path:?}: {e}");
            return RawLine::Opaque(line.to_string());
        }
    };
    // Marker lines are the ones carrying a `kind` discriminator; anything
    // else must parse as an entry or it is opaque.
    let parsed = if value.get("kind").is_some() {
        serde_json::from_value::<HarvestMarker>(value).map(|m| RawLine::Marker(m, line.to_string()))
    } else {
        serde_json::from_value::<JournalEntry>(value).map(|mut e| {
            // An entry appended before #161 can carry the mangled relative
            // spelling of a UNC checkout. Repaired on the PARSED entry only —
            // the raw line stays byte-exact, because harvest consumption and
            // deletes anchor on it.
            e.project = e.project.as_deref().map(normalize_project);
            RawLine::Entry(e, line.to_string())
        })
    };
    parsed.unwrap_or_else(|e| {
        log::warn!("skipping unknown-shape journal line in {path:?}: {e}");
        RawLine::Opaque(line.to_string())
    })
}

/// Whole-buffer append + flush (`samurai_audit::append_line` conventions,
/// sync because the store is `Mutex`-serialized, not task-based).
fn append_raw(path: &Path, data: &str) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create journal dir {parent:?}: {e}"))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("failed to open journal file {path:?}: {e}"))?;
    file.write_all(data.as_bytes())
        .map_err(|e| format!("failed to append to journal file {path:?}: {e}"))?;
    file.flush()
        .map_err(|e| format!("failed to flush journal file {path:?}: {e}"))
}

/// The journal's only file rewriter (issue #100): a rewrite must never
/// eat a same-window out-of-process append (an agent's shell `>>`), and the
/// Windows rename-retry sleeps stretch that window to ~500 ms — an append
/// can land AFTER the caller's pre-write recheck but BEFORE a retried
/// rename wins, where plain [`atomic_write`] would silently overwrite it.
/// So before EVERY rename attempt the target is re-read: still `expected`
/// (the exact bytes the caller last saw when it built `content`) → rename;
/// grown with `expected` as prefix → the tail is folded into `content`
/// (tmp rewritten, `expected` advanced) and the rename proceeds; anything
/// else should be impossible under the append-only contract and surfaces
/// as an error rather than overwriting bytes never seen. Runs under
/// [`JournalStore::lock`] via its caller.
fn atomic_write_carrying_appends(
    path: &Path,
    content: String,
    expected: Vec<u8>,
) -> Result<(), String> {
    atomic_write_carrying_appends_with(path, content, expected, |tmp, target| {
        std::fs::rename(tmp, target)
    })
}

/// [`atomic_write_carrying_appends`]'s body with the rename injectable, so
/// a test can fail an attempt and land an append inside the retry window
/// (the [`JournalStore::delete_entry_with_hook`] convention).
fn atomic_write_carrying_appends_with(
    path: &Path,
    mut content: String,
    mut expected: Vec<u8>,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create journal dir {parent:?}: {e}"))?;
    }
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, &content).map_err(|e| format!("failed to write {tmp:?}: {e}"))?;
    let mut attempt = 0;
    loop {
        // Re-verify RIGHT before the rename: an out-of-process append that
        // landed since the last look is folded into the rewrite instead of
        // being overwritten by it.
        match std::fs::read(path) {
            Ok(current) if current == expected => {}
            Ok(current) if current.len() > expected.len() && current.starts_with(&expected) => {
                content.push_str(&String::from_utf8_lossy(&current[expected.len()..]));
                std::fs::write(&tmp, &content)
                    .map_err(|e| format!("failed to write {tmp:?}: {e}"))?;
                expected = current;
            }
            Ok(_) => {
                // "rewriting", not "deleting": delete is no longer the only
                // caller — the oversized-entry split (issue #135) shares
                // this rewriter.
                return Err(format!(
                    "journal file {path:?} changed unexpectedly while rewriting; try again"
                ));
            }
            // Vanished out from under us: nothing to carry — the rename
            // recreates the file with the rewrite.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("failed to re-read journal file {path:?}: {e}")),
        }
        match rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 4 => {
                attempt += 1;
                log::warn!(
                    "rename of {tmp:?} over {path:?} failed (attempt {attempt}/5): {e} — retrying"
                );
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => {
                return Err(format!(
                    "failed to move {tmp:?} into place at {path:?}: {e}"
                ));
            }
        }
    }
}

/// Absolute path of the ACTIVE journal file as orchestrator prompts embed it
/// (issue #72): `artifact_base_dir("journal")` + [`JOURNAL_FILE`],
/// `\\?\`-stripped per fork convention. Resolved HERE — lib.rs roots the
/// production [`JournalStore`] at the same `artifact_base_dir("journal")` —
/// so the briefs and the store can never point at different files.
pub fn default_journal_file() -> String {
    normalize_project(
        &crate::commands::ai_runner::artifact_base_dir("journal")
            .join(JOURNAL_FILE)
            .to_string_lossy(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn entry(category: JournalCategory, text: &str) -> JournalEntry {
        JournalEntry::now(category, text, None, None)
    }

    fn store(dir: &Path) -> JournalStore {
        JournalStore::new(dir.to_path_buf())
    }

    /// The raw lines of the first `n` unconsumed entries — exactly what a
    /// harvest snapshot renders, and what [`JournalStore::commit_harvest`]
    /// anchors the new marker on.
    fn rendered(s: &JournalStore, n: usize) -> Vec<String> {
        s.unconsumed_with_raw()
            .unwrap()
            .into_iter()
            .take(n)
            .map(|e| e.raw)
            .collect()
    }

    #[test]
    fn test_entry_and_marker_wire_shape() {
        // The on-disk lines must carry the agreed field names and SCREAMING
        // spellings — agents hand-write them, the harvest runner reads them.
        let full = JournalEntry::now(
            JournalCategory::Bottleneck,
            "CI queue is slow",
            Some(r"\\?\C:\git\maestro".to_string()),
            Some("orchestrator-gen1".to_string()),
        );
        let raw = serde_json::to_value(&full).unwrap();
        for key in ["ts", "category", "text", "project", "agent"] {
            assert!(raw.get(key).is_some(), "missing key {key} in {raw}");
        }
        assert_eq!(raw["category"], "BOTTLENECK");
        // `\\?\` stripped at construction (fork convention).
        assert_eq!(raw["project"], r"C:\git\maestro");

        // Optional fields are ABSENT when unset, not null — the minimal
        // shape is what agents append from shell prompts.
        let minimal = serde_json::to_value(entry(JournalCategory::Skill, "x")).unwrap();
        assert!(minimal.get("project").is_none());
        assert!(minimal.get("agent").is_none());

        let marker = serde_json::to_value(HarvestMarker::now("2026-08-07")).unwrap();
        for key in ["ts", "kind", "report"] {
            assert!(marker.get(key).is_some(), "missing key {key} in {marker}");
        }
        assert_eq!(marker["kind"], "HARVEST");
        assert_eq!(marker["report"], "2026-08-07");

        for (category, wire) in [
            (JournalCategory::Bottleneck, "BOTTLENECK"),
            (JournalCategory::Error, "ERROR"),
            (JournalCategory::Improvement, "IMPROVEMENT"),
            (JournalCategory::Skill, "SKILL"),
            (JournalCategory::Concern, "CONCERN"),
        ] {
            assert_eq!(serde_json::to_value(category).unwrap(), wire);
        }
    }

    #[test]
    fn test_read_repairs_the_pre_161_relative_unc_spelling() {
        // A line appended before #161 can carry the mangled relative
        // spelling of a UNC checkout. Parsing repairs the ENTRY (so grouping
        // and display see the absolute path) while the raw line stays
        // byte-exact — harvest consumption and deletes anchor on it.
        let dir = tempdir().unwrap();
        let line = r#"{"ts":"2026-08-19T10:00:00Z","category":"ERROR","text":"x","project":"UNC\\server\\share\\maestro"}"#;
        std::fs::write(dir.path().join(JOURNAL_FILE), format!("{line}\n")).unwrap();

        let listed = store(dir.path()).list().unwrap();
        assert_eq!(listed.entries.len(), 1);
        assert_eq!(
            listed.entries[0].entry.project.as_deref(),
            Some(r"\\server\share\maestro")
        );
        assert_eq!(listed.entries[0].raw, line);
    }

    #[test]
    fn test_zero_markers_all_unconsumed_and_list_shape() {
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        s.append_entry(&entry(JournalCategory::Error, "one"))
            .unwrap();
        s.append_entry(&entry(JournalCategory::Concern, "two"))
            .unwrap();

        let result = s.list().unwrap();
        assert_eq!(result.entries.len(), 2);
        assert!(result
            .entries
            .iter()
            .all(|e| e.status == JournalEntryStatus::Unconsumed));
        // Newest last (file/append order).
        assert_eq!(result.entries[1].entry.text, "two");
        assert!(result.file_size_bytes > 0, "file size must be reported");
        assert_eq!(s.unconsumed().unwrap().len(), 2);

        // Wire shape of the list result — the frontend consumes these keys.
        let raw = serde_json::to_value(&result).unwrap();
        assert!(raw.get("entries").is_some() && raw.get("file_size_bytes").is_some());
        assert!(raw["entries"][0].get("entry").is_some());
        assert_eq!(raw["entries"][0]["status"], "UNCONSUMED");
    }

    #[test]
    fn test_missing_file_lists_empty() {
        let dir = tempdir().unwrap();
        let s = store(&dir.path().join("never-written"));
        let result = s.list().unwrap();
        assert!(result.entries.is_empty());
        assert_eq!(result.file_size_bytes, 0);
        assert!(s.unconsumed().unwrap().is_empty());
    }

    #[test]
    fn test_lifecycle_two_harvests() {
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        s.append_entry(&entry(JournalCategory::Bottleneck, "first"))
            .unwrap();
        s.append_entry(&entry(JournalCategory::Error, "second"))
            .unwrap();
        s.commit_harvest("2026-08-07", &rendered(&s, 2)).unwrap();

        // First harvest: both consumed, nothing archived yet.
        let after_first = s.list().unwrap();
        assert_eq!(after_first.entries.len(), 2);
        assert!(after_first
            .entries
            .iter()
            .all(|e| e.status == JournalEntryStatus::Consumed));
        assert!(s.unconsumed().unwrap().is_empty());
        assert!(!dir.path().join(ARCHIVE_FILE).exists());

        s.append_entry(&entry(JournalCategory::Improvement, "third"))
            .unwrap();
        assert_eq!(s.unconsumed().unwrap().len(), 1);
        s.commit_harvest("2026-08-08", &rendered(&s, 1)).unwrap();

        // Second harvest: the first two land in archive.jsonl…
        let archive = std::fs::read_to_string(dir.path().join(ARCHIVE_FILE)).unwrap();
        let archived: Vec<JournalEntry> = archive
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(archived.len(), 2);
        assert_eq!(archived[0].text, "first");
        assert_eq!(archived[1].text, "second");

        // …the third is CONSUMED in the active file, marker count is 2.
        let after_second = s.list().unwrap();
        assert_eq!(after_second.entries.len(), 1);
        assert_eq!(after_second.entries[0].entry.text, "third");
        assert_eq!(after_second.entries[0].status, JournalEntryStatus::Consumed);
        let journal = std::fs::read_to_string(dir.path().join(JOURNAL_FILE)).unwrap();
        let markers = journal
            .lines()
            .filter(|l| {
                serde_json::from_str::<HarvestMarker>(l)
                    .is_ok_and(|m| m.kind == MarkerKind::Harvest)
            })
            .count();
        assert_eq!(markers, 2);
        // No torn-write leftovers.
        assert!(!dir.path().join("journal.jsonl.tmp").exists());
    }

    #[test]
    fn test_lenient_read_skips_bad_lines() {
        let dir = tempdir().unwrap();
        let good1 = serde_json::to_string(&entry(JournalCategory::Skill, "valid one")).unwrap();
        let good2 = serde_json::to_string(&entry(JournalCategory::Concern, "valid two")).unwrap();
        std::fs::write(
            dir.path().join(JOURNAL_FILE),
            format!("{good1}\n{{ not json\n{{\"foo\": 1}}\n{good2}\n"),
        )
        .unwrap();

        let result = store(dir.path()).list().unwrap();
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[0].entry.text, "valid one");
        assert_eq!(result.entries[1].entry.text, "valid two");
    }

    #[test]
    fn test_status_derivation_full_ladder() {
        // Hand-built file [e1, M1, e2, M2, e3]: before the previous marker
        // = ARCHIVED (only possible after a crashed harvest), between the
        // last two = CONSUMED, after the last = UNCONSUMED.
        let dir = tempdir().unwrap();
        let lines = [
            serde_json::to_string(&entry(JournalCategory::Error, "e1")).unwrap(),
            serde_json::to_string(&HarvestMarker::now("2026-08-06")).unwrap(),
            serde_json::to_string(&entry(JournalCategory::Error, "e2")).unwrap(),
            serde_json::to_string(&HarvestMarker::now("2026-08-07")).unwrap(),
            serde_json::to_string(&entry(JournalCategory::Error, "e3")).unwrap(),
        ];
        std::fs::write(dir.path().join(JOURNAL_FILE), lines.join("\n") + "\n").unwrap();

        let s = store(dir.path());
        let statuses: Vec<(String, JournalEntryStatus)> = s
            .list()
            .unwrap()
            .entries
            .into_iter()
            .map(|e| (e.entry.text, e.status))
            .collect();
        assert_eq!(
            statuses,
            vec![
                ("e1".to_string(), JournalEntryStatus::Archived),
                ("e2".to_string(), JournalEntryStatus::Consumed),
                ("e3".to_string(), JournalEntryStatus::Unconsumed),
            ]
        );
        assert_eq!(s.unconsumed().unwrap().len(), 1);
    }

    #[test]
    fn test_commit_harvest_preserves_unparseable_lines() {
        // A garbage line must ride through the harvest rewrite verbatim —
        // the rewrite must never delete data it could not parse.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        s.append_entry(&entry(JournalCategory::Bottleneck, "first"))
            .unwrap();
        let path = dir.path().join(JOURNAL_FILE);
        let mut content = std::fs::read_to_string(&path).unwrap();
        content.push_str("{ garbage not json\n");
        std::fs::write(&path, content).unwrap();

        s.commit_harvest("2026-08-07", &rendered(&s, 1)).unwrap();
        s.append_entry(&entry(JournalCategory::Error, "second"))
            .unwrap();
        s.commit_harvest("2026-08-08", &rendered(&s, 1)).unwrap();

        let journal = std::fs::read_to_string(&path).unwrap();
        assert!(journal.contains("{ garbage not json"));
        assert!(!journal.contains("first"), "entry must have been archived");
        let archive = std::fs::read_to_string(dir.path().join(ARCHIVE_FILE)).unwrap();
        assert!(archive.contains("first"));
        assert!(!archive.contains("garbage"));
    }

    #[test]
    fn test_commit_harvest_rejects_bad_report_date() {
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        assert!(s.commit_harvest("08/07/2026", &[]).is_err());
        assert!(s.commit_harvest("not-a-date", &[]).is_err());
        // Nothing written by a rejected harvest.
        assert!(!dir.path().join(JOURNAL_FILE).exists());
    }

    #[test]
    fn test_new_creates_the_journal_dir() {
        // Fix M3: the agent rider appends via shell `>>`, which creates
        // files but not directories — the dir must exist from construction
        // on a fresh install.
        let dir = tempdir().unwrap();
        let nested = dir.path().join("app-data").join("journal");
        let _store = JournalStore::new(nested.clone());
        assert!(nested.is_dir(), "journal dir must exist after new()");
    }

    #[test]
    fn test_commit_harvest_snapshot_boundary_keeps_midrun_entries_unconsumed() {
        // Fix M1/M2: only the snapshotted entries — the ones the harvest
        // actually rendered — land before the new marker. Entries appended
        // mid-run (or withheld by the prompt cap) stay UNCONSUMED for the
        // next harvest.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        s.append_entry(&entry(JournalCategory::Bottleneck, "snapshotted one"))
            .unwrap();
        s.append_entry(&entry(JournalCategory::Error, "snapshotted two"))
            .unwrap();
        // The snapshot is taken BEFORE the mid-run entry lands — the
        // harvest never rendered it.
        let snapshot = rendered(&s, 2);
        // Appended while the harvest's claude run was in flight.
        s.append_entry(&entry(JournalCategory::Concern, "mid-run"))
            .unwrap();

        s.commit_harvest("2026-08-07", &snapshot).unwrap();

        let statuses: Vec<(String, JournalEntryStatus)> = s
            .list()
            .unwrap()
            .entries
            .into_iter()
            .map(|e| (e.entry.text, e.status))
            .collect();
        assert_eq!(
            statuses,
            vec![
                ("snapshotted one".to_string(), JournalEntryStatus::Consumed),
                ("snapshotted two".to_string(), JournalEntryStatus::Consumed),
                ("mid-run".to_string(), JournalEntryStatus::Unconsumed),
            ]
        );
        assert_eq!(s.unconsumed().unwrap().len(), 1);
        // Nothing archived on a first harvest, and no torn-write leftovers.
        assert!(!dir.path().join(ARCHIVE_FILE).exists());
        assert!(!dir.path().join("journal.jsonl.tmp").exists());
    }

    #[test]
    fn test_commit_harvest_archives_markers_older_than_the_previous() {
        // Fix m5: the active file keeps at most two markers — the last
        // pre-existing one plus the new one; older markers move into
        // archive.jsonl with their entries, in file order.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        s.append_entry(&entry(JournalCategory::Error, "one"))
            .unwrap();
        s.commit_harvest("2026-08-06", &rendered(&s, 1)).unwrap();
        s.append_entry(&entry(JournalCategory::Error, "two"))
            .unwrap();
        s.commit_harvest("2026-08-07", &rendered(&s, 1)).unwrap();
        s.append_entry(&entry(JournalCategory::Error, "three"))
            .unwrap();
        s.commit_harvest("2026-08-08", &rendered(&s, 1)).unwrap();

        let journal = std::fs::read_to_string(dir.path().join(JOURNAL_FILE)).unwrap();
        let active_markers: Vec<HarvestMarker> = journal
            .lines()
            .filter_map(|l| serde_json::from_str::<HarvestMarker>(l).ok())
            .filter(|m| m.kind == MarkerKind::Harvest)
            .collect();
        assert_eq!(active_markers.len(), 2, "at most two markers: {journal}");
        assert_eq!(active_markers[0].report, "2026-08-07");
        assert_eq!(active_markers[1].report, "2026-08-08");
        assert!(journal.contains("three"), "consumed entry stays active");
        // The archive holds the older entries AND the displaced marker.
        let archive = std::fs::read_to_string(dir.path().join(ARCHIVE_FILE)).unwrap();
        assert!(archive.contains("one"));
        assert!(archive.contains("two"));
        assert!(archive.contains("\"report\":\"2026-08-06\""), "{archive}");
        assert!(!archive.contains("\"report\":\"2026-08-07\""));
    }

    #[test]
    fn test_default_journal_file_names_the_active_file_without_prefix() {
        // Issue #72: the path orchestrator prompts embed — the active file
        // inside the journal artifact dir, never a `\\?\`-prefixed spelling.
        let path = default_journal_file();
        assert!(path.ends_with(JOURNAL_FILE), "{path}");
        assert!(!path.starts_with(r"\\?\"), "{path}");
    }

    // --- issue #100: per-entry delete ---

    #[test]
    fn test_delete_entry_removes_only_the_matching_line() {
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        s.append_entry(&entry(JournalCategory::Error, "one"))
            .unwrap();
        s.append_entry(&entry(JournalCategory::Skill, "two"))
            .unwrap();
        s.append_entry(&entry(JournalCategory::Concern, "three"))
            .unwrap();

        let raw_two = s
            .list()
            .unwrap()
            .entries
            .into_iter()
            .find(|e| e.entry.text == "two")
            .unwrap()
            .raw;
        assert_eq!(s.delete_entry(&raw_two).unwrap(), 1);

        let remaining: Vec<String> = s
            .list()
            .unwrap()
            .entries
            .into_iter()
            .map(|e| e.entry.text)
            .collect();
        assert_eq!(remaining, vec!["one".to_string(), "three".to_string()]);
        // No torn-write leftovers.
        assert!(!dir.path().join("journal.jsonl.tmp").exists());
    }

    #[test]
    fn test_delete_entry_removes_all_byte_identical_duplicates() {
        // Pins the chosen duplicate semantic (issue #100): entries carry no
        // id, so two lines that serialize identically are indistinguishable
        // once round-tripped through `list()` — deleting "this entry" means
        // deleting every line that reads the same.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        let dup = JournalEntry {
            ts: "2026-08-13T10:00:00+00:00".to_string(),
            category: JournalCategory::Error,
            text: "same text".to_string(),
            project: None,
            agent: None,
        };
        s.append_entry(&dup).unwrap();
        s.append_entry(&dup).unwrap();
        s.append_entry(&entry(JournalCategory::Skill, "unique"))
            .unwrap();

        let listed = s.list().unwrap().entries;
        let raw = listed[0].raw.clone();
        assert_eq!(
            listed[1].raw, raw,
            "the two dup entries share identical raw bytes"
        );

        let removed = s.delete_entry(&raw).unwrap();
        assert_eq!(removed, 2, "byte-identical duplicates are deleted together");

        let remaining = s.list().unwrap().entries;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].entry.text, "unique");
    }

    #[test]
    fn test_delete_entry_preserves_malformed_lines_verbatim_and_in_order() {
        // The append-only contract: a delete must not destroy or reorder
        // lines the reader could not parse.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        s.append_entry(&entry(JournalCategory::Error, "keep me"))
            .unwrap();
        let path = dir.path().join(JOURNAL_FILE);
        let mut content = std::fs::read_to_string(&path).unwrap();
        content.push_str("{ garbage not json\n");
        std::fs::write(&path, &content).unwrap();
        s.append_entry(&entry(JournalCategory::Skill, "delete me"))
            .unwrap();

        let raw_to_delete = s
            .list()
            .unwrap()
            .entries
            .into_iter()
            .find(|e| e.entry.text == "delete me")
            .unwrap()
            .raw;
        assert_eq!(s.delete_entry(&raw_to_delete).unwrap(), 1);

        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("{ garbage not json"), "{after}");
        assert!(after.contains("keep me"), "{after}");
        assert!(!after.contains("delete me"), "{after}");
        // Order preserved: the garbage line still sits after "keep me".
        assert!(after.find("keep me").unwrap() < after.find("{ garbage not json").unwrap());
    }

    #[test]
    fn test_delete_entry_missing_identity_and_missing_file() {
        let dir = tempdir().unwrap();
        let never_written = store(&dir.path().join("never-written"));
        assert_eq!(never_written.delete_entry("anything").unwrap(), 0);

        let s = store(dir.path());
        s.append_entry(&entry(JournalCategory::Error, "x")).unwrap();
        assert_eq!(s.delete_entry("not a real raw line").unwrap(), 0);
        // The untouched entry is still there.
        assert_eq!(s.list().unwrap().entries.len(), 1);
    }

    #[test]
    fn test_delete_preserves_other_entries_consumed_and_unconsumed_status() {
        // The consumption marker interplay: deleting a CONSUMED entry must
        // not disturb another CONSUMED entry's status, and deleting an
        // UNCONSUMED entry must not disturb another UNCONSUMED one — the
        // markers themselves are never touched by a delete.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        s.append_entry(&entry(JournalCategory::Error, "keep-consumed"))
            .unwrap();
        s.append_entry(&entry(JournalCategory::Error, "delete-consumed"))
            .unwrap();
        s.commit_harvest("2026-08-07", &rendered(&s, 2)).unwrap();
        s.append_entry(&entry(JournalCategory::Error, "keep-unconsumed"))
            .unwrap();
        s.append_entry(&entry(JournalCategory::Error, "delete-unconsumed"))
            .unwrap();

        let listed = s.list().unwrap().entries;
        let raw_of = |text: &str| {
            listed
                .iter()
                .find(|e| e.entry.text == text)
                .unwrap()
                .raw
                .clone()
        };
        let del_consumed = raw_of("delete-consumed");
        let del_unconsumed = raw_of("delete-unconsumed");

        assert_eq!(s.delete_entry(&del_consumed).unwrap(), 1);
        assert_eq!(s.delete_entry(&del_unconsumed).unwrap(), 1);

        let after: Vec<(String, JournalEntryStatus)> = s
            .list()
            .unwrap()
            .entries
            .into_iter()
            .map(|e| (e.entry.text, e.status))
            .collect();
        assert_eq!(
            after,
            vec![
                ("keep-consumed".to_string(), JournalEntryStatus::Consumed),
                (
                    "keep-unconsumed".to_string(),
                    JournalEntryStatus::Unconsumed
                ),
            ]
        );
        // The marker itself survives the deletes untouched.
        let journal = std::fs::read_to_string(dir.path().join(JOURNAL_FILE)).unwrap();
        let markers = journal
            .lines()
            .filter(|l| {
                serde_json::from_str::<HarvestMarker>(l)
                    .is_ok_and(|m| m.kind == MarkerKind::Harvest)
            })
            .count();
        assert_eq!(markers, 1);
    }

    #[test]
    fn test_delete_entry_preserves_concurrent_append() {
        // A delete must not lose an out-of-process append that lands
        // between the read and the rename — unlike `commit_harvest`'s
        // accepted loss window. The hook simulates the agent's shell `>>`
        // landing exactly in that gap.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        s.append_entry(&entry(JournalCategory::Error, "to delete"))
            .unwrap();
        let raw = s.list().unwrap().entries[0].raw.clone();

        let path = dir.path().join(JOURNAL_FILE);
        let appended_line =
            serde_json::to_string(&entry(JournalCategory::Concern, "landed mid-delete")).unwrap();

        let removed = s
            .delete_entry_with_hook(&raw, || {
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&path)
                    .unwrap();
                writeln!(f, "{appended_line}").unwrap();
            })
            .unwrap();

        assert_eq!(removed, 1);
        let remaining = s.list().unwrap().entries;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].entry.text, "landed mid-delete");
        assert!(!dir.path().join("journal.jsonl.tmp").exists());
    }

    #[test]
    fn test_delete_rewrite_carries_append_landing_inside_rename_retry() {
        // Review F2: an out-of-process `>>` append landing AFTER delete's
        // pre-write recheck but DURING the Windows rename-retry sleeps must
        // survive the rewrite. The rename is injected (the
        // delete_entry_with_hook style): attempt 1 fails like a rename
        // against a target another process holds open — and that process's
        // append lands in exactly that window — attempt 2 is the real
        // rename.
        let dir = tempdir().unwrap();
        let path = dir.path().join(JOURNAL_FILE);
        std::fs::write(&path, "{\"a\":1}\n{\"b\":2}\n").unwrap();

        let mut failed_once = false;
        atomic_write_carrying_appends_with(
            &path,
            "{\"a\":1}\n".to_string(),     // the rewrite: "b" deleted
            std::fs::read(&path).unwrap(), // what the pre-write recheck saw
            |tmp, target| {
                if !failed_once {
                    failed_once = true;
                    use std::io::Write;
                    let mut f = std::fs::OpenOptions::new()
                        .append(true)
                        .open(target)
                        .unwrap();
                    f.write_all(b"{\"c\":3}\n").unwrap();
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "target held open by the appender",
                    ));
                }
                std::fs::rename(tmp, target)
            },
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"a\":1}\n{\"c\":3}\n",
            "the same-window append must ride through the retried rename"
        );
        assert!(!dir.path().join("journal.jsonl.tmp").exists());
    }

    #[test]
    fn test_commit_harvest_anchors_on_content_not_count() {
        // Review F4: a per-entry delete (issue #100) interleaving between
        // the harvest snapshot and the consumption commit must not shift
        // the marker past an entry the session never saw.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        s.append_entry(&entry(JournalCategory::Error, "injected one"))
            .unwrap();
        s.append_entry(&entry(JournalCategory::Skill, "injected two"))
            .unwrap();
        let snapshot = rendered(&s, 2);

        // Between snapshot and commit: one snapshotted entry is deleted and
        // a brand-new (never-injected) one is appended.
        assert_eq!(s.delete_entry(&snapshot[0]).unwrap(), 1);
        s.append_entry(&entry(JournalCategory::Concern, "never injected"))
            .unwrap();

        s.commit_harvest("2026-08-13", &snapshot).unwrap();

        let statuses: Vec<(String, JournalEntryStatus)> = s
            .list()
            .unwrap()
            .entries
            .into_iter()
            .map(|e| (e.entry.text, e.status))
            .collect();
        assert_eq!(
            statuses,
            vec![
                ("injected two".to_string(), JournalEntryStatus::Consumed),
                ("never injected".to_string(), JournalEntryStatus::Unconsumed),
            ]
        );
    }

    #[test]
    fn test_commit_harvest_counts_duplicate_lines_instead_of_matching_a_set() {
        // Two agents recording the same category/text in the same second
        // produce BYTE-IDENTICAL JSONL. When the render cap withheld the
        // second copy, a set-membership boundary still matched it — so an
        // entry that was never injected got archived undigested.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        let duplicate = entry(JournalCategory::Error, "same second, same text");
        s.append_entry(&duplicate).unwrap();
        s.append_entry(&duplicate).unwrap();
        let raws: Vec<String> = s
            .unconsumed_with_raw()
            .unwrap()
            .into_iter()
            .map(|e| e.raw)
            .collect();
        assert_eq!(raws.len(), 2);
        assert_eq!(raws[0], raws[1], "the two lines really are identical");

        // Only the FIRST copy was rendered — the cap withheld the second.
        s.commit_harvest("2026-08-13", &raws[..1]).unwrap();

        let statuses: Vec<JournalEntryStatus> = s
            .list()
            .unwrap()
            .entries
            .into_iter()
            .map(|e| e.status)
            .collect();
        assert_eq!(
            statuses,
            vec![JournalEntryStatus::Consumed, JournalEntryStatus::Unconsumed],
            "the withheld duplicate stays unconsumed"
        );
    }

    #[test]
    fn test_commit_harvest_preserves_unknown_entry_fields_verbatim() {
        // Agents hand-write this JSONL. An extra field serde ignores on read
        // used to be dropped by the harvest's re-serialize, which also
        // invalidated every untouched row's `raw` delete identity.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        s.append_entry(&entry(JournalCategory::Error, "harvested"))
            .unwrap();
        let snapshot = rendered(&s, 1);
        let extra =
            r#"{"ts":"2026-08-13T10:00:00Z","category":"CONCERN","text":"hand written","severity":"high"}"#
                .to_string();
        append_raw(&s.journal_path(), &format!("{extra}\n")).unwrap();

        s.commit_harvest("2026-08-13", &snapshot).unwrap();

        let listed = s.list().unwrap().entries;
        let survivor = listed
            .iter()
            .find(|e| e.entry.text == "hand written")
            .expect("the hand-written entry survives");
        assert_eq!(survivor.raw, extra, "carried through byte for byte");
        assert_eq!(survivor.status, JournalEntryStatus::Unconsumed);
        // …and the identity `list()` reports still deletes it.
        assert_eq!(s.delete_entry(&survivor.raw).unwrap(), 1);
    }

    // --- issue #135: oversized-entry split ---

    /// A position-sensitive filler of `len` chars: a lost, duplicated or
    /// reordered chunk changes the reassembled string, which `"x".repeat`
    /// could never show.
    fn filler(len: usize) -> String {
        (0..len)
            .map(|i| char::from(b'a' + (i % 26) as u8))
            .collect()
    }

    /// The text of `part` with its `[part k/N] ` marker stripped, asserting
    /// the marker is the expected one — the reassembly contract.
    fn part_body(part: &JournalEntry, k: usize, n: usize) -> String {
        let marker = format!("[part {k}/{n}] ");
        part.text
            .strip_prefix(&marker)
            .unwrap_or_else(|| panic!("part {k} must start with {marker:?}: {}", part.text))
            .to_string()
    }

    #[test]
    fn test_split_oversized_unconsumed_reproduces_the_original_text_exactly() {
        // The whole point of splitting instead of truncating: every char of
        // the original entry survives, in order, spread over whole parts
        // that each fit the harvest's per-entry budget.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        const BUDGET: usize = 100;
        let original = filler(BUDGET * 3);
        s.append_entry(&entry(JournalCategory::Error, &original))
            .unwrap();

        assert_eq!(s.split_oversized_unconsumed(BUDGET).unwrap(), 1);

        let parts: Vec<JournalEntry> = s.unconsumed().unwrap();
        assert!(parts.len() > 1, "an oversized entry must become N parts");
        let n = parts.len();
        let mut reassembled = String::new();
        for (i, part) in parts.iter().enumerate() {
            assert!(
                part.text.chars().count() <= BUDGET,
                "part {} is over the budget: {}",
                i + 1,
                part.text.chars().count()
            );
            reassembled.push_str(&part_body(part, i + 1, n));
        }
        assert_eq!(reassembled, original, "no char lost, none duplicated");

        // Idempotent: the parts it just wrote are already under budget, so a
        // second pass (the next harvest) must not re-split them.
        let before = std::fs::read(dir.path().join(JOURNAL_FILE)).unwrap();
        assert_eq!(s.split_oversized_unconsumed(BUDGET).unwrap(), 0);
        assert_eq!(
            std::fs::read(dir.path().join(JOURNAL_FILE)).unwrap(),
            before
        );
        assert!(!dir.path().join("journal.jsonl.tmp").exists());
    }

    #[test]
    fn test_split_preserves_ts_category_project_and_agent_on_every_part() {
        // A part is a WHOLE entry: it must carry the same provenance as the
        // line it replaced, or the harvest renders parts the user cannot
        // attribute back to a project or an agent.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        const BUDGET: usize = 80;
        let oversized = JournalEntry {
            ts: "2026-08-17T10:00:00+00:00".to_string(),
            category: JournalCategory::Bottleneck,
            text: filler(BUDGET * 3),
            project: Some(r"C:\git\maestro".to_string()),
            agent: Some("orchestrator-gen1".to_string()),
        };
        s.append_entry(&oversized).unwrap();

        assert_eq!(s.split_oversized_unconsumed(BUDGET).unwrap(), 1);

        let parts = s.unconsumed().unwrap();
        assert!(parts.len() > 1);
        for part in &parts {
            assert_eq!(part.ts, oversized.ts);
            assert_eq!(part.category, oversized.category);
            assert_eq!(part.project, oversized.project);
            assert_eq!(part.agent, oversized.agent);
        }
    }

    #[test]
    fn test_split_leaves_consumed_archived_marker_and_opaque_lines_byte_identical() {
        // Only the UNCONSUMED region is rewritten. Everything a harvest has
        // already digested — and every line the parser could not read — must
        // ride through byte-for-byte and in order, exactly like the delete
        // path's contract.
        let dir = tempdir().unwrap();
        const BUDGET: usize = 60;
        let archived =
            serde_json::to_string(&entry(JournalCategory::Error, &filler(BUDGET * 3))).unwrap();
        let old_marker = serde_json::to_string(&HarvestMarker::now("2026-08-06")).unwrap();
        let consumed =
            serde_json::to_string(&entry(JournalCategory::Skill, &filler(BUDGET * 3))).unwrap();
        let last_marker = serde_json::to_string(&HarvestMarker::now("2026-08-07")).unwrap();
        let opaque = "{ garbage not json".to_string();
        let unconsumed =
            serde_json::to_string(&entry(JournalCategory::Concern, &filler(BUDGET * 3))).unwrap();
        let untouched = [&archived, &old_marker, &consumed, &last_marker, &opaque];
        let path = dir.path().join(JOURNAL_FILE);
        std::fs::write(
            &path,
            format!(
                "{archived}\n{old_marker}\n{consumed}\n{last_marker}\n{opaque}\n{unconsumed}\n"
            ),
        )
        .unwrap();

        let s = store(dir.path());
        assert_eq!(
            s.split_oversized_unconsumed(BUDGET).unwrap(),
            1,
            "only the unconsumed oversized entry is split"
        );

        let after: Vec<String> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        for (i, expected) in untouched.iter().enumerate() {
            assert_eq!(&&after[i], expected, "line {i} must be byte-identical");
        }
        assert!(after.len() > untouched.len() + 1, "the last line was split");
        assert!(!after.contains(&unconsumed), "the oversized line is gone");
    }

    #[test]
    fn test_split_leaves_an_under_budget_entry_untouched() {
        // No oversized entry means no rewrite at all — not a rewrite that
        // happens to produce the same lines: the file bytes must be the very
        // same ones, so no `raw` delete identity is ever invalidated.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        const BUDGET: usize = 100;
        s.append_entry(&entry(JournalCategory::Error, &filler(BUDGET)))
            .unwrap();
        let before = std::fs::read(dir.path().join(JOURNAL_FILE)).unwrap();

        assert_eq!(s.split_oversized_unconsumed(BUDGET).unwrap(), 0);

        assert_eq!(
            std::fs::read(dir.path().join(JOURNAL_FILE)).unwrap(),
            before
        );
        assert!(!dir.path().join("journal.jsonl.tmp").exists());
        // A journal that was never written is a no-op too, not an error.
        let never_written = store(&dir.path().join("never-written"));
        assert_eq!(never_written.split_oversized_unconsumed(BUDGET).unwrap(), 0);
    }

    #[test]
    fn test_split_preserves_concurrent_append() {
        // Same guarantee the delete path has: an agent's shell `>>` landing
        // between the read and the rename must be carried into the rewrite,
        // never overwritten by it. The hook lands it exactly in that gap.
        let dir = tempdir().unwrap();
        let s = store(dir.path());
        const BUDGET: usize = 100;
        s.append_entry(&entry(JournalCategory::Error, &filler(BUDGET * 2)))
            .unwrap();

        let path = dir.path().join(JOURNAL_FILE);
        let appended_line =
            serde_json::to_string(&entry(JournalCategory::Concern, "landed mid-split")).unwrap();

        let split = s
            .split_oversized_unconsumed_with_hook(BUDGET, || {
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&path)
                    .unwrap();
                writeln!(f, "{appended_line}").unwrap();
            })
            .unwrap();

        assert_eq!(split, 1);
        let texts: Vec<String> = s
            .unconsumed()
            .unwrap()
            .into_iter()
            .map(|e| e.text)
            .collect();
        assert!(
            texts.len() > 2,
            "the parts plus the appended entry: {texts:?}"
        );
        assert_eq!(
            texts.last().map(String::as_str),
            Some("landed mid-split"),
            "the same-window append survives, last in file order"
        );
        assert!(!dir.path().join("journal.jsonl.tmp").exists());
    }
}
