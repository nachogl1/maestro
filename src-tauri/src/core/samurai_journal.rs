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

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};

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
}

/// Result of a list: the active file's entries (newest last) plus the file
/// size, reported like `AuditReadResult` so the frontend can warn on growth.
#[derive(Debug, Clone, Serialize)]
pub struct JournalListResult {
    pub entries: Vec<JournalEntryWithStatus>,
    pub file_size_bytes: u64,
}

/// One parsed line of the active file, in file order. `Opaque` lines
/// (malformed or unknown shape) are never listed, archived or dropped —
/// they ride through rewrites verbatim.
enum RawLine {
    Entry(JournalEntry),
    Marker(HarvestMarker),
    Opaque(String),
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
                RawLine::Entry(entry) => Some(JournalEntryWithStatus {
                    entry: entry.clone(),
                    status: entry_status(i, last, prev),
                }),
                _ => None,
            })
            .collect();
        Ok(JournalListResult {
            entries,
            file_size_bytes,
        })
    }

    /// The entries no harvest has consumed yet (after the last marker) —
    /// what the harvest runner (next issue) feeds into a report.
    pub fn unconsumed(&self) -> Result<Vec<JournalEntry>, String> {
        Ok(self
            .list()?
            .entries
            .into_iter()
            .filter(|e| e.status == JournalEntryStatus::Unconsumed)
            .map(|e| e.entry)
            .collect())
    }

    /// Marks everything currently in the active file as consumed by the
    /// `report_date` (`YYYY-MM-DD`) harvest: entries older than the current
    /// last marker — `ARCHIVED` once the new marker lands — move to
    /// `archive.jsonl`, then the new marker is appended. The active-file
    /// rewrite is atomic (`.tmp` + rename); when nothing moves, a plain
    /// append is used instead, which — unlike a rewrite — cannot race an
    /// agent appending from a shell prompt. A crash between the archive
    /// append and the rename can duplicate entries into the archive on the
    /// next harvest; that is the accepted cost of two-file atomicity not
    /// existing (harvest reports are advisory).
    pub fn commit_harvest(&self, report_date: &str) -> Result<(), String> {
        chrono::NaiveDate::parse_from_str(report_date, "%Y-%m-%d")
            .map_err(|e| format!("invalid report date {report_date:?} (want YYYY-MM-DD): {e}"))?;
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let journal_path = self.journal_path();
        let (lines, _) = read_lines(&journal_path)?;
        // Entries before the CURRENT last marker are older than what will be
        // the previous marker once the new one is appended — those move out.
        let archive_before = lines
            .iter()
            .rposition(|l| matches!(l, RawLine::Marker(_)))
            .unwrap_or(0);

        let mut archived = String::new();
        let mut kept = String::new();
        for (i, line) in lines.iter().enumerate() {
            match line {
                RawLine::Entry(entry) => {
                    let raw = serde_json::to_string(entry)
                        .map_err(|e| format!("failed to serialize journal entry: {e}"))?;
                    let target = if i < archive_before {
                        &mut archived
                    } else {
                        &mut kept
                    };
                    target.push_str(&raw);
                    target.push('\n');
                }
                RawLine::Marker(marker) => {
                    let raw = serde_json::to_string(marker)
                        .map_err(|e| format!("failed to serialize harvest marker: {e}"))?;
                    kept.push_str(&raw);
                    kept.push('\n');
                }
                // Never archived, never dropped — carried through verbatim.
                RawLine::Opaque(raw) => {
                    kept.push_str(raw);
                    kept.push('\n');
                }
            }
        }

        let marker_line = serde_json::to_string(&HarvestMarker::now(report_date))
            .map_err(|e| format!("failed to serialize harvest marker: {e}"))?;
        if archived.is_empty() {
            return append_raw(&journal_path, &format!("{marker_line}\n"));
        }
        append_raw(&self.archive_path(), &archived)?;
        kept.push_str(&marker_line);
        kept.push('\n');
        atomic_write(&journal_path, &kept)
    }
}

/// Positions of the last and second-to-last markers, when present.
fn marker_positions(lines: &[RawLine]) -> (Option<usize>, Option<usize>) {
    let markers: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| matches!(l, RawLine::Marker(_)).then_some(i))
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
    let lines = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| parse_line(l, path))
        .collect();
    Ok((lines, metadata.len()))
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
        serde_json::from_value::<HarvestMarker>(value).map(RawLine::Marker)
    } else {
        serde_json::from_value::<JournalEntry>(value).map(RawLine::Entry)
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

/// Write to `<file>.tmp` then rename over the target (the
/// `samurai_run_config::atomic_write_json` pattern): a crash leaves either
/// the old file or the new one, never a torn journal. The fixed `.tmp` name
/// cannot race itself — [`JournalStore::lock`] serializes writers.
fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create journal dir {parent:?}: {e}"))?;
    }
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("failed to write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("failed to move {tmp:?} into place at {path:?}: {e}"))
}

/// Strips the Windows `\\?\` extended-length prefix `fs::canonicalize`
/// adds, per fork convention (see `commands/ai_runner.rs::
/// canonical_project_path` and `samurai_audit::normalize_project`).
fn normalize_project(project: &str) -> String {
    project.strip_prefix(r"\\?\").unwrap_or(project).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tempfile::tempdir;

    fn entry(category: JournalCategory, text: &str) -> JournalEntry {
        JournalEntry::now(category, text, None, None)
    }

    fn store(dir: &Path) -> JournalStore {
        JournalStore::new(dir.to_path_buf())
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
        s.commit_harvest("2026-08-07").unwrap();

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
        s.commit_harvest("2026-08-08").unwrap();

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

        s.commit_harvest("2026-08-07").unwrap();
        s.append_entry(&entry(JournalCategory::Error, "second"))
            .unwrap();
        s.commit_harvest("2026-08-08").unwrap();

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
        assert!(s.commit_harvest("08/07/2026").is_err());
        assert!(s.commit_harvest("not-a-date").is_err());
        // Nothing written by a rejected harvest.
        assert!(!dir.path().join(JOURNAL_FILE).exists());
    }
}
